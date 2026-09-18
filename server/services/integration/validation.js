// Shared vocabulary, normalisation and validation for the Integration & API
// Framework. Keeping the enums in one place lets every service, route, test and
// the frontend agree on the same stable codes and error semantics.
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError } from "../../validation.js";

export const INTEGRATION_TYPES = ["api", "file", "event", "database", "messaging", "webhook", "batch", "custom"];
export const INTEGRATION_DIRECTIONS = ["inbound", "outbound", "bidirectional"];
export const DEFINITION_STATUSES = ["draft", "active", "inactive", "suspended", "retired"];
export const ACTIVE_DEFINITION_STATUSES = ["active"];
export const ADAPTER_TYPES = [
  "rest",
  "soap",
  "message_queue",
  "event_bus",
  "file",
  "database",
  "webhook",
  "internal",
  "custom",
];
export const PROTOCOLS = ["https", "http", "soap", "amqp", "mqtt", "kafka", "jdbc", "odbc", "sftp", "file", "memory", "custom"];
export const SYSTEM_TYPES = ["sap", "mes", "cad", "erp", "crm", "plm", "scm", "supplier", "customer", "warehouse", "custom"];
export const ENVIRONMENTS = ["development", "test", "staging", "production"];
export const AUTH_METHODS = [
  "none",
  "api_key",
  "basic",
  "bearer",
  "oauth2",
  "oidc",
  "jwt",
  "mtls",
  "service_account",
  "internal",
  "signature",
];
export const CREDENTIAL_KINDS = ["api_key", "basic", "oauth2", "jwt", "mtls", "service_account", "signature", "custom"];
export const CONNECTION_STATUSES = ["unknown", "healthy", "degraded", "down"];
export const TRIGGER_TYPES = ["manual", "schedule", "webhook", "api", "event", "retry", "import", "export", "test"];
export const EXECUTION_STATUSES = ["pending", "running", "succeeded", "failed", "partial", "cancelled", "timed_out"];
export const EXECUTION_TERMINAL = ["succeeded", "failed", "partial", "cancelled", "timed_out"];
export const EXECUTION_RETRYABLE = ["failed", "timed_out", "partial"];
export const MESSAGE_STATUSES = ["pending", "processing", "delivered", "retry", "dead_letter", "duplicate", "ignored", "cancelled"];
export const MESSAGE_TERMINAL = ["delivered", "dead_letter", "duplicate", "ignored", "cancelled"];
export const PRIORITIES = ["low", "normal", "high", "critical"];
export const MAPPING_STATUSES = ["active", "conflict", "orphan", "ignored"];
export const TRANSFER_DIRECTIONS = ["import", "export"];
export const TRANSFER_FORMATS = ["csv", "json", "xml", "xlsx", "txt"];
export const TRANSFER_MODES = ["create", "create_only", "upsert", "replace"];
export const TRANSFER_STATUSES = ["pending", "preview", "validating", "running", "completed", "partial", "failed", "cancelled"];
export const EVENT_STATUSES = ["active", "inactive", "deprecated"];
export const SUBSCRIBER_TYPES = ["webhook", "integration", "queue", "internal", "subscription"];
export const DELIVERY_STATUSES = ["pending", "delivered", "failed", "retry", "dead_letter", "skipped"];
export const WEBHOOK_AUTH_TYPES = ["none", "api_key", "signature", "basic"];
export const API_STATUSES = ["beta", "active", "deprecated", "retired"];
export const ERROR_HANDLING = ["fail", "skip", "null", "default"];
export const SCHEDULE_TYPES = ["once", "interval", "cron", "daily", "weekly", "monthly"];
export const OVERLAP_POLICIES = ["skip", "allow", "queue"];
export const RETRY_STRATEGIES = ["fixed", "exponential", "linear"];

// Standard error taxonomy. Every adapter and service maps provider-specific
// failures onto one of these categories and codes so retry, dead-letter and
// monitoring logic stays provider-independent.
export const ERROR_CATEGORIES = [
  "technical",
  "business_validation",
  "mapping",
  "authentication",
  "authorization",
  "network",
  "timeout",
  "external_system",
  "duplicate",
  "configuration",
  "rate_limit",
  "not_found",
];

export const ERROR_CODES = {
  technical: ["internal_error", "unexpected_error", "handler_error"],
  business_validation: ["validation_failed", "required_field_missing", "invalid_value", "schema_mismatch"],
  mapping: ["mapping_failed", "missing_mapping", "type_conversion_failed", "unknown_field"],
  authentication: ["authentication_failed", "invalid_credentials", "token_expired", "signature_invalid"],
  authorization: ["forbidden", "insufficient_scope", "ip_not_allowed"],
  network: ["connection_refused", "dns_failure", "tls_error", "network_unreachable"],
  timeout: ["request_timeout", "connect_timeout", "execution_timeout"],
  external_system: ["remote_error", "remote_unavailable", "remote_rejected", "schema_drift"],
  duplicate: ["duplicate_message", "duplicate_object", "idempotent_replay"],
  configuration: ["missing_configuration", "invalid_configuration", "adapter_not_registered", "credential_missing"],
  rate_limit: ["rate_limited", "quota_exceeded", "backpressure"],
  not_found: ["object_not_found", "system_not_found", "definition_not_found"],
};

// Categories that a retry policy may safely attempt again.
const NON_RETRYABLE_CATEGORIES = new Set(["business_validation", "mapping", "authorization", "configuration", "duplicate", "not_found"]);

export function isRetryableCategory(category) {
  return !NON_RETRYABLE_CATEGORIES.has(String(category || ""));
}

function oneOf(value, allowed) {
  return value !== undefined && value !== null && value !== "" && allowed.includes(value);
}

export function assertEnum(value, allowed, label) {
  if (!oneOf(value, allowed)) {
    throw new HttpError(400, `${label} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

export function normalizeEnum(value, allowed, fallback) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return allowed.includes(normalized) ? normalized : fallback;
}

export const normalizeIntegrationType = (v) => normalizeEnum(v, INTEGRATION_TYPES, "api");
export const normalizeDirection = (v) => normalizeEnum(v, INTEGRATION_DIRECTIONS, "inbound");
export const normalizeDefinitionStatus = (v) => normalizeEnum(v, DEFINITION_STATUSES, "draft");
export const normalizeAdapterType = (v) => normalizeEnum(v, ADAPTER_TYPES, "rest");
export const normalizeSystemType = (v) => normalizeEnum(v, SYSTEM_TYPES, "custom");
export const normalizeEnvironment = (v) => normalizeEnum(v, ENVIRONMENTS, "production");
export const normalizeAuthMethod = (v) => normalizeEnum(v, AUTH_METHODS, "none");
export const normalizeTriggerType = (v) => normalizeEnum(v, TRIGGER_TYPES, "manual");
export const normalizeExecutionStatus = (v) => normalizeEnum(v, EXECUTION_STATUSES, "pending");
export const normalizeMessageStatus = (v) => normalizeEnum(v, MESSAGE_STATUSES, "pending");
export const normalizePriority = (v) => normalizeEnum(v, PRIORITIES, "normal");
export const normalizeTransferMode = (v) => normalizeEnum(v, TRANSFER_MODES, "upsert");
export const normalizeTransferFormat = (v) => normalizeEnum(v, TRANSFER_FORMATS, "csv");
export const normalizeErrorCategory = (v) => normalizeEnum(v, ERROR_CATEGORIES, "technical");

export function normalizeRetryPolicy(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const strategy = normalizeEnum(source.strategy || source.retry_strategy, RETRY_STRATEGIES, "exponential");
  return {
    strategy,
    max_attempts: clampInt(source.max_attempts ?? source.maxAttempts, 1, 50, 5),
    delay_seconds: clampInt(source.delay_seconds ?? source.delaySeconds ?? source.delay_ms, 0, 86400, 30),
    max_delay_seconds: clampInt(source.max_delay_seconds ?? source.maxDelaySeconds, 0, 86400, 3600),
    multiplier: clampNumber(source.multiplier, 1, 10, 2),
    jitter: Boolean(source.jitter ?? false),
    retryable_categories: Array.isArray(source.retryable_categories)
      ? source.retryable_categories.filter((c) => ERROR_CATEGORIES.includes(c))
      : [],
    non_retryable_categories: Array.isArray(source.non_retryable_categories)
      ? source.non_retryable_categories.filter((c) => ERROR_CATEGORIES.includes(c))
      : [],
    timeout_seconds: clampInt(source.timeout_seconds ?? source.timeoutSeconds, 0, 86400, 0),
  };
}

// Exponential/linear/fixed backoff with optional jitter. Deterministic when
// jitter is disabled, which keeps tests stable.
export function computeBackoffSeconds(policy, attempt, { random = Math.random } = {}) {
  const p = normalizeRetryPolicy(policy);
  const n = Math.max(1, Number(attempt) || 1);
  let delay = p.delay_seconds;
  if (p.strategy === "exponential") delay = p.delay_seconds * Math.pow(p.multiplier, n - 1);
  else if (p.strategy === "linear") delay = p.delay_seconds * n;
  if (p.max_delay_seconds > 0) delay = Math.min(delay, p.max_delay_seconds);
  if (p.jitter) delay = delay * (0.5 + random() * 0.5);
  return Math.max(0, Math.round(delay));
}

export function shouldRetry(policy, attempt, category) {
  const p = normalizeRetryPolicy(policy);
  if (Number(attempt) >= p.max_attempts) return false;
  if (p.non_retryable_categories.includes(category)) return false;
  if (p.retryable_categories.length) return p.retryable_categories.includes(category);
  return isRetryableCategory(category);
}

export function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function safeParse(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function toJson(value, fallback = {}) {
  if (value === undefined || value === null) return JSON.stringify(fallback);
  if (typeof value === "string") {
    safeParse(value, undefined);
    return value;
  }
  return JSON.stringify(value);
}

const SECRET_KEY_RE = /(secret|password|token|api[_-]?key|private[_-]?key|client[_-]?secret|authorization|credential|signature)/i;

export function isSensitiveKey(key) {
  return SECRET_KEY_RE.test(String(key || ""));
}

// Masks secrets and sensitive payload attributes before anything is returned to
// a caller, written to a log, or stored in delivery history.
export function maskPayload(value, { depth = 0 } = {}) {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => maskPayload(item, { depth: depth + 1 }));
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? "***" : maskPayload(val, { depth: depth + 1 });
    }
    return out;
  }
  return value;
}

export function maskSecret(value) {
  const text = String(value ?? "");
  if (!text) return "";
  if (text.length <= 8) return "***";
  return `${text.slice(0, 4)}…${text.slice(-2)}`;
}

export function hashApiKey(raw) {
  return createHash("sha256").update(String(raw)).digest("hex");
}

export function generateApiKey(prefix = "intg") {
  const secret = randomBytes(24).toString("base64url");
  const raw = `${prefix}_${secret}`;
  return { raw, prefix: raw.slice(0, prefix.length + 9), hash: hashApiKey(raw) };
}

export function signPayload(payload, secret) {
  return createHmac("sha256", String(secret)).update(typeof payload === "string" ? payload : JSON.stringify(payload)).digest("hex");
}

export function verifySignature(payload, secret, signature) {
  const expected = signPayload(payload, secret);
  const provided = String(signature || "").replace(/^sha256=/, "");
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// SSRF guard for configurable outbound URLs. Internal hosts are rejected unless
// the caller explicitly opts in (useful for trusted on-premise connectors in
// non-production environments).
const PRIVATE_HOST_RE = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|::1|\[::1\])/i;
const PRIVATE_RANGE_RE = /^172\.(1[6-9]|2\d|3[01])\./;

export function assertSafeUrl(url, { allowPrivate = false, allowedHosts = [] } = {}) {
  const text = String(url || "").trim();
  if (!text) throw new HttpError(400, "URL is required");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new HttpError(400, "Invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new HttpError(400, "Only http and https URLs are allowed");
  }
  const host = parsed.hostname.toLowerCase();
  if (allowedHosts.length && !allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    throw new HttpError(400, `Host ${host} is not in the allowed host list`);
  }
  if (!allowPrivate && (PRIVATE_HOST_RE.test(host) || PRIVATE_RANGE_RE.test(host))) {
    throw new HttpError(400, "Internal/private network URLs are not allowed");
  }
  return parsed;
}

export function paginate(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(query.pageSize, 10) || parseInt(query.page_size, 10) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

export function nowSql(date = new Date()) {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export function addSecondsIso(seconds, from = new Date()) {
  return nowSql(new Date(from.getTime() + Number(seconds || 0) * 1000));
}

export function applyTemplate(template, source) {
  return String(template ?? "").replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_m, path) => {
    const value = getPath(source, path);
    return value === undefined || value === null ? "" : String(value);
  });
}

export function getPath(obj, path) {
  const parts = String(path || "").replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

export function setPath(obj, path, value) {
  const parts = String(path || "").split(".").filter(Boolean);
  let current = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (typeof current[key] !== "object" || current[key] === null) current[key] = {};
    current = current[key];
  }
  if (parts.length) current[parts[parts.length - 1]] = value;
  return obj;
}

export function humanizeCode(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// Machine-readable vocabulary exposed through /api/integration/meta so the
// frontend and external clients never hard-code enum values.
export function vocabulary() {
  return {
    integration_types: INTEGRATION_TYPES,
    directions: INTEGRATION_DIRECTIONS,
    definition_statuses: DEFINITION_STATUSES,
    adapter_types: ADAPTER_TYPES,
    protocols: PROTOCOLS,
    system_types: SYSTEM_TYPES,
    environments: ENVIRONMENTS,
    auth_methods: AUTH_METHODS,
    credential_kinds: CREDENTIAL_KINDS,
    connection_statuses: CONNECTION_STATUSES,
    trigger_types: TRIGGER_TYPES,
    execution_statuses: EXECUTION_STATUSES,
    message_statuses: MESSAGE_STATUSES,
    priorities: PRIORITIES,
    mapping_statuses: MAPPING_STATUSES,
    transfer_directions: TRANSFER_DIRECTIONS,
    transfer_formats: TRANSFER_FORMATS,
    transfer_modes: TRANSFER_MODES,
    transfer_statuses: TRANSFER_STATUSES,
    event_statuses: EVENT_STATUSES,
    subscriber_types: SUBSCRIBER_TYPES,
    delivery_statuses: DELIVERY_STATUSES,
    webhook_auth_types: WEBHOOK_AUTH_TYPES,
    api_statuses: API_STATUSES,
    error_handling: ERROR_HANDLING,
    schedule_types: SCHEDULE_TYPES,
    overlap_policies: OVERLAP_POLICIES,
    retry_strategies: RETRY_STRATEGIES,
    error_categories: ERROR_CATEGORIES,
    error_codes: ERROR_CODES,
  };
}
