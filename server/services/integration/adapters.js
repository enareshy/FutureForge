// Pluggable adapter framework.
//
// Adapters translate the platform's provider-independent integration contract
// into a concrete technology (REST, SOAP, message queue, event bus, file,
// database, webhook, internal API, ...). They contain transport concerns only:
// no business-specific mapping logic lives here. Third parties register new
// adapters with `registerAdapter` without modifying the framework.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertSafeUrl, normalizeRetryPolicy, maskPayload } from "./validation.js";
import { classifyError, log } from "./hooks.js";

export class AdapterError extends Error {
  constructor(message, { category = "external_system", code = "remote_error", cause = null, detail = null } = {}) {
    super(message);
    this.name = "AdapterError";
    this.category = category;
    this.code = code;
    this.cause = cause;
    this.detail = detail;
  }
}

function fileBaseDir() {
  return resolve(process.env.INTEGRATION_FILE_DIR || join(process.cwd(), "data", "integration-files"));
}

// The contract every adapter implements. Methods not relevant to a transport
// resolve to a safe default so callers can rely on the full surface.
export class BaseAdapter {
  constructor(config = {}) {
    this.config = config || {};
    this.connected = false;
  }
  get type() {
    return "base";
  }
  async connect() {
    this.connected = true;
    return { connected: true, adapter: this.type };
  }
  async disconnect() {
    this.connected = false;
    return { connected: false, adapter: this.type };
  }
  async testConnection() {
    return { ok: true, adapter: this.type, message: "Adapter is available" };
  }
  async authenticate() {
    return { authenticated: true, method: this.config.auth_method || "none" };
  }
  async sendRequest(request = {}) {
    throw new AdapterError(`${this.type} adapter does not support synchronous requests`, {
      category: "configuration",
      code: "invalid_configuration",
    });
  }
  async publishMessage(message = {}) {
    return { published: true, message };
  }
  async consumeMessage() {
    return null;
  }
  async uploadFile() {
    throw new AdapterError(`${this.type} adapter does not support file upload`, {
      category: "configuration",
      code: "invalid_configuration",
    });
  }
  async downloadFile() {
    throw new AdapterError(`${this.type} adapter does not support file download`, {
      category: "configuration",
      code: "invalid_configuration",
    });
  }
  async healthCheck() {
    return { status: "healthy", latency_ms: 0, message: "Adapter is available" };
  }
  validateConfig() {
    return { valid: true, errors: [] };
  }
  normalizeError(error) {
    const { category, code, message } = classifyError(error);
    return { category, code, message };
  }
}

// REST/HTTP adapter. Uses the platform fetch when available; never follows a
// user-supplied URL to an internal host (SSRF guard).
export class RestAdapter extends BaseAdapter {
  get type() {
    return "rest";
  }
  endpoint() {
    const url = this.config.url || this.config.base_url || "";
    return url ? assertSafeUrl(url, { allowPrivate: Boolean(this.config.allow_private) }) : null;
  }
  buildHeaders() {
    const headers = { "Content-Type": this.config.content_type || "application/json", ...(this.config.headers || {}) };
    if (this.config.token) headers.Authorization = `Bearer ${this.config.token}`;
    return headers;
  }
  async sendRequest(request = {}) {
    const url = request.url ? assertSafeUrl(request.url, { allowPrivate: Boolean(this.config.allow_private) }) : this.endpoint();
    if (!url) throw new AdapterError("No endpoint URL configured", { category: "configuration", code: "missing_configuration" });
    const method = (request.method || this.config.method || "GET").toUpperCase();
    const body = request.body === undefined ? undefined : typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    const headerObj = this.buildHeaders();
    if (!globalThis.fetch) {
      throw new AdapterError("fetch is not available in this runtime", { category: "configuration", code: "missing_configuration" });
    }
    const started = Date.now();
    try {
      const response = await fetch(url.toString(), {
        method,
        headers: headerObj,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        signal: AbortSignal.timeout(Number(this.config.timeout_ms) || 30000),
      });
      const text = await response.text();
      let parsed = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep raw text */
      }
      const result = {
        status: response.status,
        ok: response.ok,
        headers: Object.fromEntries(response.headers.entries()),
        body: parsed,
        duration_ms: Date.now() - started,
      };
      if (!response.ok) {
        throw new AdapterError(`Remote endpoint responded with ${response.status}`, {
          category: response.status === 429 ? "rate_limit" : response.status >= 500 ? "external_system" : "business_validation",
          code: response.status === 429 ? "rate_limited" : "remote_error",
          detail: result,
        });
      }
      return result;
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      const normalized = this.normalizeError(error);
      throw new AdapterError(error.message, { ...normalized, cause: error });
    }
  }
  async testConnection() {
    if (!this.endpoint()) return { ok: false, adapter: this.type, message: "No URL configured" };
    return { ok: true, adapter: this.type, message: "URL is valid", url: this.endpoint().toString() };
  }
}

export class WebhookAdapter extends RestAdapter {
  get type() {
    return "webhook";
  }
  async sendRequest(request = {}) {
    return super.sendRequest({ ...request, method: request.method || "POST" });
  }
}

export class SoapAdapter extends RestAdapter {
  get type() {
    return "soap";
  }
  buildHeaders() {
    return { "Content-Type": "text/xml; charset=utf-8", SOAPAction: this.config.soap_action || "", ...(this.config.headers || {}) };
  }
  buildEnvelope(body) {
    if (typeof body === "string") return body;
    const inner = body?.envelope || body?.payload || body || {};
    const serialized = typeof inner === "string" ? inner : JSON.stringify(inner);
    return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>${serialized}</soap:Body></soap:Envelope>`;
  }
  async sendRequest(request = {}) {
    return super.sendRequest({ ...request, method: request.method || "POST", body: this.buildEnvelope(request.body) });
  }
}

// In-process adapter used for internal platform modules and tests. The handler
// is looked up by name from the registry passed at construction time.
export class InternalAdapter extends BaseAdapter {
  get type() {
    return "internal";
  }
  async sendRequest(request = {}) {
    const handler = this.config.handler;
    if (typeof handler !== "function") {
      throw new AdapterError("Internal adapter requires a handler function", {
        category: "configuration",
        code: "missing_configuration",
      });
    }
    const started = Date.now();
    const result = await handler(request, this.config);
    return { status: 200, ok: true, body: result, duration_ms: Date.now() - started };
  }
  async testConnection() {
    return { ok: typeof this.config.handler === "function", adapter: this.type, message: "Internal handler resolved" };
  }
}

export class MessageQueueAdapter extends BaseAdapter {
  get type() {
    return "message_queue";
  }
  async publishMessage(message = {}) {
    if (!this.config.publisher) {
      throw new AdapterError("No queue publisher configured", { category: "configuration", code: "missing_configuration" });
    }
    return this.config.publisher(message, this.config);
  }
  async consumeMessage() {
    if (!this.config.consumer) return null;
    return this.config.consumer(this.config);
  }
}

export class EventBusAdapter extends BaseAdapter {
  get type() {
    return "event_bus";
  }
  async publishMessage(message = {}) {
    if (!this.config.publisher) {
      throw new AdapterError("No event bus publisher configured", { category: "configuration", code: "missing_configuration" });
    }
    return this.config.publisher(message, this.config);
  }
}

export class FileAdapter extends BaseAdapter {
  get type() {
    return "file";
  }
  resolvePath(path) {
    const base = fileBaseDir();
    const target = resolve(base, String(path || ""));
    if (!target.startsWith(base)) {
      throw new AdapterError("File path escapes the integration file root", {
        category: "configuration",
        code: "invalid_configuration",
      });
    }
    return target;
  }
  async uploadFile({ path, content }) {
    const target = this.resolvePath(path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content ?? "");
    return { ok: true, path, size_bytes: Buffer.byteLength(content ?? "") };
  }
  async downloadFile({ path }) {
    const target = this.resolvePath(path);
    if (!existsSync(target)) {
      throw new AdapterError(`File not found: ${path}`, { category: "not_found", code: "object_not_found" });
    }
    const content = readFileSync(target, "utf8");
    return { ok: true, path, content, size_bytes: Buffer.byteLength(content) };
  }
  async testConnection() {
    try {
      mkdirSync(fileBaseDir(), { recursive: true });
      return { ok: true, adapter: this.type, message: `File root ready at ${fileBaseDir()}` };
    } catch (error) {
      return { ok: false, adapter: this.type, message: error.message };
    }
  }
}

export class DatabaseAdapter extends BaseAdapter {
  get type() {
    return "database";
  }
  async sendRequest(request = {}) {
    if (typeof this.config.query === "function") {
      const started = Date.now();
      const body = await this.config.query(request, this.config);
      return { status: 200, ok: true, body, duration_ms: Date.now() - started };
    }
    throw new AdapterError("Database adapter requires a query handler", {
      category: "configuration",
      code: "missing_configuration",
    });
  }
  async testConnection() {
    return { ok: true, adapter: this.type, message: this.config.connection_ref ? "Connection reference present" : "No connection reference" };
  }
}

export class CustomAdapter extends BaseAdapter {
  get type() {
    return "custom";
  }
  async sendRequest(request = {}) {
    if (typeof this.config.send === "function") return this.config.send(request, this.config);
    throw new AdapterError("Custom adapter requires a send handler", { category: "configuration", code: "missing_configuration" });
  }
}

const REGISTRY = new Map();
const METADATA = new Map();

export function registerAdapter(type, factory, metadata = {}) {
  const key = String(type || "").toLowerCase();
  if (!key) throw new AdapterError("Adapter type is required", { category: "configuration", code: "invalid_configuration" });
  if (typeof factory !== "function") throw new AdapterError(`Adapter factory for ${key} must be a function`);
  REGISTRY.set(key, factory);
  METADATA.set(key, { type: key, ...metadata });
  return key;
}

export function unregisterAdapter(type) {
  return REGISTRY.delete(String(type || "").toLowerCase());
}

export function getAdapterFactory(type) {
  return REGISTRY.get(String(type || "").toLowerCase()) || null;
}

export function createAdapter(type, config = {}) {
  const key = String(type || "").toLowerCase();
  const factory = REGISTRY.get(key);
  if (!factory) {
    throw new AdapterError(`No adapter registered for type ${key}`, {
      category: "configuration",
      code: "adapter_not_registered",
    });
  }
  return factory(config);
}

export function listAdapters() {
  return [...METADATA.values()].map((meta) => ({ ...meta }));
}

export function adapterMetadata(type) {
  return METADATA.get(String(type || "").toLowerCase()) || null;
}

function registerBuiltins() {
  registerAdapter("rest", (config) => new RestAdapter(config), {
    label: "REST / HTTP",
    directions: ["inbound", "outbound", "bidirectional"],
    protocols: ["https", "http"],
  });
  registerAdapter("soap", (config) => new SoapAdapter(config), {
    label: "SOAP",
    directions: ["inbound", "outbound", "bidirectional"],
    protocols: ["soap", "https", "http"],
  });
  registerAdapter("message_queue", (config) => new MessageQueueAdapter(config), {
    label: "Message queue",
    directions: ["inbound", "outbound", "bidirectional"],
    protocols: ["amqp", "mqtt", "jms"],
  });
  registerAdapter("event_bus", (config) => new EventBusAdapter(config), {
    label: "Event bus",
    directions: ["outbound"],
    protocols: ["kafka", "amqp", "memory"],
  });
  registerAdapter("file", (config) => new FileAdapter(config), {
    label: "File-based",
    directions: ["inbound", "outbound"],
    protocols: ["sftp", "file"],
  });
  registerAdapter("database", (config) => new DatabaseAdapter(config), {
    label: "Database",
    directions: ["inbound", "outbound"],
    protocols: ["jdbc", "odbc"],
  });
  registerAdapter("webhook", (config) => new WebhookAdapter(config), {
    label: "Webhook",
    directions: ["inbound", "outbound"],
    protocols: ["https", "http"],
  });
  registerAdapter("internal", (config) => new InternalAdapter(config), {
    label: "Internal platform API",
    directions: ["inbound", "outbound", "bidirectional"],
    protocols: ["memory"],
  });
  registerAdapter("custom", (config) => new CustomAdapter(config), {
    label: "Custom",
    directions: ["inbound", "outbound", "bidirectional"],
    protocols: ["custom"],
  });
}

registerBuiltins();

// Builds adapter config from an integration definition + optional system
// connection details. Secrets are resolved by the caller and never persisted
// here.
export function adapterConfigFromDefinition(definition = {}, { handler = null, token = null, headers = null } = {}) {
  const config = { ...(definition.config || {}), ...(definition.adapter_config || {}) };
  if (definition.protocol) config.protocol = definition.protocol;
  if (token) config.token = token;
  if (headers) config.headers = { ...(config.headers || {}), ...headers };
  if (handler) config.handler = handler;
  if (definition.timeout_seconds) config.timeout_ms = Number(definition.timeout_seconds) * 1000;
  return config;
}

// Executes a single adapter request with retry-aware error normalisation. Used
// by the REST execution flow and the E2E mock integration.
export async function invokeAdapterRequest(adapter, request, { retryPolicy = null } = {}) {
  const policy = normalizeRetryPolicy(retryPolicy || {});
  let attempt = 0;
  let lastError = null;
  while (attempt < Math.max(1, policy.max_attempts)) {
    attempt += 1;
    try {
      return { ...(await adapter.sendRequest(request)), _attempt: attempt };
    } catch (error) {
      lastError = error;
      const normalized = adapter.normalizeError(error);
      log("warn", "adapter.request.failed", { adapter: adapter.type, attempt, ...normalized, payload: maskPayload(request?.body) });
      if (attempt >= Math.max(1, policy.max_attempts)) break;
    }
  }
  throw lastError instanceof AdapterError ? lastError : new AdapterError(lastError?.message || "Adapter request failed", adapter.normalizeError(lastError));
}

export { maskPayload };
