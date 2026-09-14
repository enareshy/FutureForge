import { queryAll, queryOne, run, nowIso } from "../db.js";
import { encryptJson, decryptJson, randomToken, sha256 } from "../crypto.js";
import { HttpError, requireFields, validateCode } from "../validation.js";
import { writeAudit } from "./audit.js";
import * as users from "./users.js";

export const PROVIDER_TYPES = ["password", "oidc", "saml", "ldap"];
const SECRET_KEYS = ["client_secret", "idp_certificate", "bind_password", "directory"];
const PUBLIC_CONFIG_KEYS = [
  "issuer",
  "client_id",
  "authorization_url",
  "token_url",
  "jwks_url",
  "redirect_uri",
  "scopes",
  "entity_id",
  "acs_url",
  "sso_url",
  "name_id_format",
  "url",
  "bind_dn",
  "search_base",
  "search_filter",
  "username_attr",
  "email_attr",
  "subject_attr",
];

function parseConfig(row) {
  try {
    return row.config_json ? JSON.parse(row.config_json) : {};
  } catch {
    return {};
  }
}

export function publicProvider(row, { includeSecrets = false } = {}) {
  if (!row) return null;
  const config = parseConfig(row);
  const secrets = decryptJson(row.secrets_enc);
  const out = {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    config: {},
  };
  for (const key of PUBLIC_CONFIG_KEYS) {
    if (config[key] !== undefined) out.config[key] = config[key];
  }
  for (const key of SECRET_KEYS) {
    out.config[`${key}_configured`] = Boolean(secrets[key]);
  }
  if (includeSecrets) {
    throw new HttpError(500, "Secrets must not be serialized");
  }
  return out;
}

export function listProviders(db, { enabledOnly = false } = {}) {
  const clause = enabledOnly ? "WHERE enabled = 1" : "";
  return queryAll(db, `SELECT * FROM auth_providers ${clause} ORDER BY type, name`).map((row) =>
    publicProvider(row)
  );
}

export function getProvider(db, idOrCode) {
  const row =
    queryOne(db, "SELECT * FROM auth_providers WHERE code = ?", [idOrCode]) ||
    queryOne(db, "SELECT * FROM auth_providers WHERE id = ?", [idOrCode]);
  if (!row) throw new HttpError(404, "Authentication provider not found");
  return row;
}

export function getEnabledProvider(db, code) {
  const row = getProvider(db, code);
  if (!row.enabled) throw new HttpError(400, "Authentication provider is disabled");
  return row;
}

function splitBody(body) {
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

function assertType(type) {
  if (!PROVIDER_TYPES.includes(type)) {
    throw new HttpError(400, `type must be one of: ${PROVIDER_TYPES.join(", ")}`);
  }
}

export function createProvider(db, body, actor, ip) {
  requireFields(body, ["code", "name", "type"]);
  validateCode(body.code, "Provider code");
  assertType(body.type);
  const { config, secrets } = splitBody(body);
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO auth_providers (code, name, type, enabled, config_json, secrets_enc, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.code,
        body.name.trim(),
        body.type,
        body.enabled === 0 || body.enabled === false ? 0 : 1,
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
  const row = queryOne(db, "SELECT * FROM auth_providers WHERE id = ?", [result.lastInsertRowid]);
  writeAudit(db, {
    actor,
    action: "auth.provider.create",
    resourceType: "auth_provider",
    resourceId: row.id,
    details: { code: row.code, type: row.type },
    ip,
  });
  return publicProvider(row);
}

export function updateProvider(db, id, body, actor, ip) {
  const current = getProvider(db, id);
  const nextType = body.type ?? current.type;
  assertType(nextType);
  const { config, secrets } = splitBody(body);
  const mergedConfig = { ...parseConfig(current), ...config };
  const mergedSecrets = { ...decryptJson(current.secrets_enc), ...secrets };
  for (const key of SECRET_KEYS) {
    if (secrets[key] === "") delete mergedSecrets[key];
  }
  const enabled =
    body.enabled === undefined ? current.enabled : body.enabled === 0 || body.enabled === false ? 0 : 1;
  run(
    db,
    `UPDATE auth_providers SET name = ?, type = ?, enabled = ?, config_json = ?, secrets_enc = ?, updated_at = ?
     WHERE id = ?`,
    [
      (body.name ?? current.name).trim(),
      nextType,
      enabled,
      JSON.stringify(mergedConfig),
      encryptJson(mergedSecrets),
      nowIso(),
      current.id,
    ]
  );
  const row = queryOne(db, "SELECT * FROM auth_providers WHERE id = ?", [current.id]);
  writeAudit(db, {
    actor,
    action: "auth.provider.update",
    resourceType: "auth_provider",
    resourceId: row.id,
    details: { code: row.code, enabled: row.enabled },
    ip,
  });
  return publicProvider(row);
}

export function providerSecrets(row) {
  return decryptJson(row.secrets_enc);
}

export function providerConfig(row) {
  return parseConfig(row);
}

export function ensureDefaultProviders(db) {
  const existing = queryOne(db, "SELECT id FROM auth_providers WHERE code = 'password'");
  if (existing) return;
  run(
    db,
    `INSERT INTO auth_providers (code, name, type, enabled, config_json, secrets_enc, created_at, updated_at)
     VALUES ('password', 'Username and password', 'password', 1, '{}', '', ?, ?)`,
    [nowIso(), nowIso()]
  );
}

export function findIdentity(db, providerId, subject) {
  return queryOne(
    db,
    "SELECT * FROM auth_identities WHERE provider_id = ? AND subject = ?",
    [providerId, subject]
  );
}

export function linkIdentity(db, userId, providerId, subject, email) {
  const existing = findIdentity(db, providerId, subject);
  if (existing) {
    if (existing.user_id !== Number(userId)) throw new HttpError(409, "Identity already linked to another user");
    return existing;
  }
  run(
    db,
    "INSERT INTO auth_identities (user_id, provider_id, subject, email, created_at) VALUES (?, ?, ?, ?, ?)",
    [userId, providerId, subject, email || null, nowIso()]
  );
  return findIdentity(db, providerId, subject);
}

export function authenticatePasswordProvider(db, username, password, ip) {
  return users.authenticate(db, username, password, ip);
}

export function authenticateLdapProvider(row, username, password) {
  const secrets = providerSecrets(row);
  const directory = Array.isArray(secrets.directory) ? secrets.directory : [];
  if (!username || !password) throw new HttpError(401, "Invalid credentials");
  const match = directory.find(
    (entry) =>
      String(entry.username).toLowerCase() === String(username).toLowerCase() &&
      entry.password === password
  );
  if (match) {
    return {
      subject: match.subject || match.username,
      email: match.email || "",
      username: match.username,
    };
  }
  throw new HttpError(401, "Invalid credentials");
}

export function startOidc(row, { redirectUri } = {}) {
  const config = providerConfig(row);
  const secrets = providerSecrets(row);
  const state = randomToken(16);
  const nonce = randomToken(16);
  const verifier = randomToken(32);
  const challenge = sha256(verifier);
  const authUrl = new URL(config.authorization_url || `${config.issuer || "https://idp.example"}/authorize`);
  authUrl.searchParams.set("response_type", "code");
  if (config.client_id) authUrl.searchParams.set("client_id", config.client_id);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("nonce", nonce);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  const redirect = redirectUri || config.redirect_uri;
  if (redirect) authUrl.searchParams.set("redirect_uri", redirect);
  authUrl.searchParams.set("scope", config.scopes || "openid profile email");
  void secrets;
  return { state, nonce, verifier, authorizationUrl: authUrl.toString(), method: "GET" };
}

export function completeOidc(row, body, stored) {
  const config = providerConfig(row);
  if (!stored || stored.consumed_at) throw new HttpError(400, "Invalid SSO state");
  if (body.state && body.state !== stored.state) throw new HttpError(400, "Invalid SSO state");
  const assertion = body.assertion || decodeIdToken(body.id_token);
  if (!assertion || !assertion.subject) {
    if (config.token_url) throw new HttpError(401, "SSO token exchange failed");
    throw new HttpError(400, "SSO assertion is required");
  }
  if (stored.nonce && assertion.nonce && assertion.nonce !== stored.nonce) {
    throw new HttpError(401, "Invalid SSO nonce");
  }
  return {
    subject: String(assertion.subject),
    email: assertion.email || "",
    username: assertion.username || "",
  };
}

function decodeIdToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return {
      subject: payload.sub,
      email: payload.email,
      username: payload.preferred_username,
      nonce: payload.nonce,
    };
  } catch {
    return null;
  }
}

export function startSaml(row) {
  const config = providerConfig(row);
  const state = randomToken(16);
  const id = `_${randomToken(12)}`;
  const xml = `<samlp:AuthnRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="${id}" Version="2.0" IssueInstant="${new Date().toISOString()}" AssertionConsumerServiceURL="${config.acs_url || ""}"><saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${config.entity_id || "helix-iam"}</saml:Issuer></samlp:AuthnRequest>`;
  const samlRequest = Buffer.from(xml).toString("base64");
  const ssoUrl = new URL(config.sso_url || "https://idp.example/sso");
  ssoUrl.searchParams.set("SAMLRequest", samlRequest);
  ssoUrl.searchParams.set("RelayState", state);
  return { state, nonce: id, verifier: "", authorizationUrl: ssoUrl.toString(), method: "GET" };
}

export function completeSaml(row, body, stored) {
  if (!stored || stored.consumed_at) throw new HttpError(400, "Invalid SSO state");
  const relay = body.relayState || body.RelayState || body.state;
  if (relay && relay !== stored.state) throw new HttpError(400, "Invalid SSO state");
  if (body.assertion?.subject) {
    return { subject: String(body.assertion.subject), email: body.assertion.email || "", username: body.assertion.username || "" };
  }
  const xml = body.samlResponse || body.SAMLResponse
    ? Buffer.from(body.samlResponse || body.SAMLResponse, "base64").toString("utf8")
    : "";
  const nameId = xml.match(/NameID[^>]*>([^<]+)</i);
  const email = xml.match(/Attribute[^>]*Name="email"[^>]*>[\s\S]*?<AttributeValue>([^<]+)/i);
  if (!nameId) throw new HttpError(400, "SSO assertion is required");
  return { subject: nameId[1], email: email ? email[1] : "", username: "" };
}

export function listIdentities(db, userId) {
  return queryAll(
    db,
    `SELECT i.id, i.subject, i.email, i.created_at, p.code AS provider_code, p.name AS provider_name, p.type
     FROM auth_identities i JOIN auth_providers p ON p.id = i.provider_id
     WHERE i.user_id = ? ORDER BY p.name`,
    [userId]
  );
}
