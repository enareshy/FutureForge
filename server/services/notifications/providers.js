import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { encryptJson, decryptJson } from "../../crypto.js";
import { HttpError, requireFields, validateCode } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { assertProviderType, safeParse } from "./validation.js";

// Channel provider configuration (email/SMTP, SendGrid, Microsoft Graph,
// webhook, in-app store). Credentials are encrypted at rest and never returned
// to clients. Connection tests are non-destructive and never perform network
// calls with stored secrets.

export const SECRET_KEYS = ["password", "api_key", "token", "client_secret"];
const PUBLIC_CONFIG_KEYS = [
  "host",
  "port",
  "secure",
  "from_name",
  "from_email",
  "username",
  "reply_to",
  "tenant_id",
  "region",
  "endpoint",
  "webhook_url",
  "timeout_ms",
];

function parseConfig(row) {
  return safeParse(row.config_json, {});
}

export function publicProvider(row) {
  if (!row) return null;
  const config = parseConfig(row);
  const secrets = decryptJson(row.secrets_enc);
  const out = {
    id: row.id,
    code: row.code,
    name: row.name,
    channel: row.channel,
    type: row.type,
    enabled: row.enabled === 1,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    is_default: row.is_default === 1 || row.is_default === true,
    priority: row.priority ?? 100,
    rate_limit_per_minute: row.rate_limit_per_minute ?? 0,
    max_attempts: row.max_attempts ?? 5,
    backoff_seconds: row.backoff_seconds ?? 30,
    timeout_ms: row.timeout_ms ?? 10000,
    credential_ref: row.credential_ref || "",
    status: row.status || (row.enabled === 1 ? "active" : "inactive"),
    last_tested_at: row.last_tested_at || null,
    last_test_status: row.last_test_status || "",
    last_test_message: row.last_test_message || "",
    config: {},
    secrets_configured: {},
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  for (const key of PUBLIC_CONFIG_KEYS) {
    if (config[key] !== undefined) out.config[key] = config[key];
  }
  for (const key of SECRET_KEYS) out.secrets_configured[key] = Boolean(secrets[key]);
  return out;
}

// Delivery settings accepted alongside the core provider fields. Kept separate
// from config_json because they are operational tuning, not transport settings.
const DELIVERY_OPTION_KEYS = [
  "tenant_id",
  "organization_id",
  "is_default",
  "priority",
  "rate_limit_per_minute",
  "max_attempts",
  "backoff_seconds",
  "timeout_ms",
  "credential_ref",
  "status",
];

function boolFlag(value, fallback = 0) {
  if (value === undefined) return fallback;
  return value === true || value === 1 || value === "1" || value === "true" ? 1 : 0;
}

function intValue(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function deliveryOptions(body = {}) {
  const out = {};
  for (const key of DELIVERY_OPTION_KEYS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

export function getProviderRow(db, idOrCode) {
  return (
    queryOne(db, "SELECT * FROM notification_providers WHERE code = ?", [String(idOrCode)]) ||
    queryOne(db, "SELECT * FROM notification_providers WHERE id = ?", [Number(idOrCode)])
  );
}

export function getProvider(db, idOrCode) {
  const row = getProviderRow(db, idOrCode);
  if (!row) throw new HttpError(404, "Notification provider not found");
  return row;
}

export function listProviders(db, { channel } = {}) {
  const where = channel ? "WHERE channel = ?" : "";
  const params = channel ? [channel] : [];
  return queryAll(db, `SELECT * FROM notification_providers ${where} ORDER BY channel, name`, params).map(publicProvider);
}

export function providerSecrets(row) {
  return decryptJson(row.secrets_enc);
}

export function providerConfig(row) {
  return parseConfig(row);
}

function splitBody(body = {}) {
  const config = { ...(body.config || {}) };
  const secrets = {};
  for (const key of SECRET_KEYS) {
    if (body[key] !== undefined) secrets[key] = body[key];
    if (config[key] !== undefined) {
      secrets[key] = config[key];
      delete config[key];
    }
  }
  for (const key of Object.keys(config)) {
    if (!PUBLIC_CONFIG_KEYS.includes(key)) delete config[key];
  }
  return { config, secrets };
}

export function createProvider(db, body = {}, actor = null, ip = null) {
  requireFields(body, ["code", "name"]);
  validateCode(body.code, "Provider code");
  const type = body.type || "store";
  assertProviderType(type);
  const { config, secrets } = splitBody(body);
  const opts = deliveryOptions(body);
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO notification_providers
        (code, name, channel, type, enabled, config_json, secrets_enc, created_at, updated_at,
         tenant_id, organization_id, is_default, priority, rate_limit_per_minute, max_attempts,
         backoff_seconds, timeout_ms, credential_ref, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.channel || "email",
        type,
        body.enabled === false || body.enabled === 0 ? 0 : 1,
        JSON.stringify(config),
        encryptJson(secrets),
        ts,
        ts,
        opts.tenant_id ?? null,
        opts.organization_id ?? null,
        boolFlag(opts.is_default, 0),
        intValue(opts.priority, 100),
        intValue(opts.rate_limit_per_minute, 0),
        intValue(opts.max_attempts, 5),
        intValue(opts.backoff_seconds, 30),
        intValue(opts.timeout_ms, 10000),
        opts.credential_ref ?? "",
        opts.status ?? (body.enabled === false || body.enabled === 0 ? "inactive" : "active"),
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Provider code already exists");
    throw err;
  }
  if (boolFlag(opts.is_default, 0) === 1) clearOtherDefaults(db, result.lastInsertRowid, body.channel || "email", opts.tenant_id ?? null);
  writeAudit(db, { actor, action: "notification.provider.create", resourceType: "notification_provider", resourceId: result.lastInsertRowid, details: { code: body.code, channel: body.channel || "email", type }, ip });
  return publicProvider(getProviderRow(db, result.lastInsertRowid));
}

function clearOtherDefaults(db, keepId, channel, tenantId) {
  run(
    db,
    `UPDATE notification_providers SET is_default = 0
      WHERE id <> ? AND channel = ?
        AND COALESCE(tenant_id, 0) = COALESCE(?, 0)`,
    [keepId, channel, tenantId ?? null]
  );
}

export function updateProvider(db, id, body = {}, actor = null, ip = null) {
  const current = getProvider(db, id);
  const type = body.type ?? current.type;
  assertProviderType(type);
  const { config, secrets } = splitBody(body);
  const mergedConfig = { ...parseConfig(current), ...config };
  const mergedSecrets = { ...decryptJson(current.secrets_enc), ...secrets };
  for (const key of SECRET_KEYS) {
    if (secrets[key] === "") delete mergedSecrets[key];
  }
  const enabled = body.enabled === undefined
    ? current.enabled
    : body.enabled === false || body.enabled === 0
      ? 0
      : 1;
  const opts = deliveryOptions(body);
  const isDefault = opts.is_default === undefined ? current.is_default : boolFlag(opts.is_default, current.is_default);
  const status = opts.status ?? (body.enabled === undefined ? current.status : enabled ? "active" : "inactive");
  run(
    db,
    `UPDATE notification_providers
        SET name = ?, channel = ?, type = ?, enabled = ?, config_json = ?, secrets_enc = ?, updated_at = ?,
            tenant_id = ?, organization_id = ?, is_default = ?, priority = ?, rate_limit_per_minute = ?,
            max_attempts = ?, backoff_seconds = ?, timeout_ms = ?, credential_ref = ?, status = ?
      WHERE id = ?`,
    [
      (body.name ?? current.name).trim(),
      body.channel ?? current.channel,
      type,
      enabled,
      JSON.stringify(mergedConfig),
      encryptJson(mergedSecrets),
      nowIso(),
      opts.tenant_id !== undefined ? opts.tenant_id : current.tenant_id,
      opts.organization_id !== undefined ? opts.organization_id : current.organization_id,
      isDefault,
      opts.priority !== undefined ? intValue(opts.priority, current.priority) : current.priority,
      opts.rate_limit_per_minute !== undefined ? intValue(opts.rate_limit_per_minute, current.rate_limit_per_minute) : current.rate_limit_per_minute,
      opts.max_attempts !== undefined ? intValue(opts.max_attempts, current.max_attempts) : current.max_attempts,
      opts.backoff_seconds !== undefined ? intValue(opts.backoff_seconds, current.backoff_seconds) : current.backoff_seconds,
      opts.timeout_ms !== undefined ? intValue(opts.timeout_ms, current.timeout_ms) : current.timeout_ms,
      opts.credential_ref !== undefined ? opts.credential_ref : current.credential_ref,
      status,
      current.id,
    ]
  );
  if (isDefault === 1) clearOtherDefaults(db, current.id, body.channel ?? current.channel, opts.tenant_id !== undefined ? opts.tenant_id : current.tenant_id);
  writeAudit(db, { actor, action: "notification.provider.update", resourceType: "notification_provider", resourceId: current.id, details: { code: current.code, enabled, status }, ip });
  return publicProvider(getProviderRow(db, current.id));
}

export function deleteProvider(db, id, actor = null, ip = null) {
  const current = getProvider(db, id);
  run(db, "DELETE FROM notification_providers WHERE id = ?", [current.id]);
  writeAudit(db, { actor, action: "notification.provider.delete", resourceType: "notification_provider", resourceId: current.id, details: { code: current.code }, ip });
  return { deleted: true, id: current.id };
}

// Non-destructive connection test. Validates configuration completeness and
// returns a canned provider response; real transports are pluggable later.
export function testProvider(db, idOrCode, { recipient } = {}) {
  const row = getProvider(db, idOrCode);
  const config = parseConfig(row);
  const secrets = decryptJson(row.secrets_enc);
  const problems = [];
  if (row.type === "smtp") {
    if (!config.host) problems.push("host is required");
    if (!config.from_email) problems.push("from_email is required");
    if (!secrets.password && !config.username) problems.push("username or password is required");
  }
  if (row.type === "sendgrid" && !secrets.api_key) problems.push("api_key is required");
  if (row.type === "mailgun" && !secrets.api_key) problems.push("api_key is required");
  if (row.type === "postmark" && !secrets.api_key) problems.push("api_key is required");
  if (row.type === "ses") {
    if (!config.region) problems.push("region is required");
    if (!secrets.api_key && !secrets.token) problems.push("api_key or token is required");
  }
  if (row.type === "graph") {
    if (!config.tenant_id) problems.push("tenant_id is required");
    if (!secrets.client_secret) problems.push("client_secret is required");
  }
  if (["webhook", "teams", "slack"].includes(row.type) && !config.webhook_url) problems.push("webhook_url is required");
  if (row.type === "twilio") {
    if (!config.from_email) problems.push("from number is required");
    if (!secrets.api_key && !secrets.token) problems.push("api_key or token is required");
  }
  if (row.type === "fcm" && !secrets.api_key && !secrets.token) problems.push("api_key or token is required");
  if (recipient && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(recipient))) problems.push("recipient is not a valid email");
  const ok = problems.length === 0;
  const ts = nowIso();
  run(db, "UPDATE notification_providers SET last_tested_at = ?, last_test_status = ?, last_test_message = ? WHERE id = ?", [
    ts,
    ok ? "ok" : "failed",
    ok ? "Configuration looks valid" : problems.join("; "),
    row.id,
  ]);
  return {
    provider: publicProvider(getProviderRow(db, row.id)),
    ok,
    problems,
    message: ok ? "Configuration looks valid" : "Configuration is incomplete",
    tested_at: ts,
  };
}

// Resolves the enabled provider for a channel, defaulting to the stored
// provider. Returns { row, code, type } or a synthetic store provider.
export function providerForChannel(db, channel) {
  const row = queryOne(
    db,
    `SELECT * FROM notification_providers
      WHERE channel = ? AND enabled = 1 AND COALESCE(status, 'active') = 'active'
      ORDER BY is_default DESC, priority ASC, (type = 'store') DESC, id
      LIMIT 1`,
    [channel]
  );
  if (row) return { row, code: row.code, type: row.type };
  return { row: null, code: "store", type: "store" };
}

export function ensureDefaultProviders(db) {
  const existing = queryOne(db, "SELECT id FROM notification_providers WHERE code = 'in-app-store'");
  if (!existing) {
    run(
      db,
      `INSERT INTO notification_providers (code, name, channel, type, enabled, config_json, secrets_enc, created_at, updated_at, is_default, priority, status)
       VALUES ('in-app-store', 'In-app store', 'in_app', 'store', 1, '{}', '', ?, ?, 1, 1, 'active')`,
      [nowIso(), nowIso()]
    );
  }
  const email = queryOne(db, "SELECT id FROM notification_providers WHERE code = 'email-smtp'");
  if (!email) {
    run(
      db,
      `INSERT INTO notification_providers (code, name, channel, type, enabled, config_json, secrets_enc, created_at, updated_at, is_default, priority, status)
       VALUES ('email-smtp', 'Email (SMTP)', 'email', 'store', 1, '{"from_name":"Helix Notifications","from_email":"no-reply@helix.example.com"}', '', ?, ?, 1, 10, 'active')`,
      [nowIso(), nowIso()]
    );
  }
}
