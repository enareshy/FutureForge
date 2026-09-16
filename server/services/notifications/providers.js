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
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO notification_providers (code, name, channel, type, enabled, config_json, secrets_enc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Provider code already exists");
    throw err;
  }
  writeAudit(db, { actor, action: "notification.provider.create", resourceType: "notification_provider", resourceId: result.lastInsertRowid, details: { code: body.code, channel: body.channel || "email", type }, ip });
  return publicProvider(getProviderRow(db, result.lastInsertRowid));
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
  const enabled = body.enabled === undefined ? current.enabled : body.enabled === false || body.enabled === 0 ? 0 : 1;
  run(
    db,
    `UPDATE notification_providers SET name = ?, channel = ?, type = ?, enabled = ?, config_json = ?, secrets_enc = ?, updated_at = ?
     WHERE id = ?`,
    [
      (body.name ?? current.name).trim(),
      body.channel ?? current.channel,
      type,
      enabled,
      JSON.stringify(mergedConfig),
      encryptJson(mergedSecrets),
      nowIso(),
      current.id,
    ]
  );
  writeAudit(db, { actor, action: "notification.provider.update", resourceType: "notification_provider", resourceId: current.id, details: { code: current.code, enabled }, ip });
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
  if (row.type === "graph") {
    if (!config.tenant_id) problems.push("tenant_id is required");
    if (!secrets.client_secret) problems.push("client_secret is required");
  }
  if (row.type === "webhook" && !config.webhook_url) problems.push("webhook_url is required");
  if (recipient && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(recipient))) problems.push("recipient is not a valid email");
  return {
    provider: publicProvider(row),
    ok: problems.length === 0,
    problems,
    message: problems.length === 0 ? "Configuration looks valid" : "Configuration is incomplete",
    tested_at: nowIso(),
  };
}

// Resolves the enabled provider for a channel, defaulting to the stored
// provider. Returns { row, code, type } or a synthetic store provider.
export function providerForChannel(db, channel) {
  const row = queryOne(
    db,
    "SELECT * FROM notification_providers WHERE channel = ? AND enabled = 1 ORDER BY (type = 'store') DESC, id LIMIT 1",
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
      `INSERT INTO notification_providers (code, name, channel, type, enabled, config_json, secrets_enc, created_at, updated_at)
       VALUES ('in-app-store', 'In-app store', 'in_app', 'store', 1, '{}', '', ?, ?)`,
      [nowIso(), nowIso()]
    );
  }
  const email = queryOne(db, "SELECT id FROM notification_providers WHERE code = 'email-smtp'");
  if (!email) {
    run(
      db,
      `INSERT INTO notification_providers (code, name, channel, type, enabled, config_json, secrets_enc, created_at, updated_at)
       VALUES ('email-smtp', 'Email (SMTP)', 'email', 'store', 1, '{"from_name":"Helix Notifications","from_email":"no-reply@helix.example.com"}', '', ?, ?)`,
      [nowIso(), nowIso()]
    );
  }
}
