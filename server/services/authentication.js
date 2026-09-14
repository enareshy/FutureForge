import { queryOne, run, nowIso } from "../db.js";
import { randomToken, sha256 } from "../crypto.js";
import { HttpError } from "../validation.js";
import { writeAudit } from "./audit.js";
import { getSetting } from "./hierarchy.js";
import * as users from "./users.js";
import * as sessions from "./sessions.js";
import * as providers from "./providers.js";
import * as mfa from "./mfa.js";
import { assertRateLimit } from "./ratelimit.js";

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    employee_id: user.employee_id,
    display_name: user.display_name,
    status: user.status,
    organization_id: user.organization_id,
    tenant_id: user.tenant_id || null,
  };
}

function finishLogin(db, user, meta) {
  if (user.status && user.status !== "active") throw new HttpError(403, "Account is not active");
  const enrolled = mfa.hasVerifiedMfa(db, user.id);
  const required = mfa.mfaRequiredSetting(db);
  if (required || enrolled) {
    if (!enrolled && required) {
      throw new HttpError(403, "MFA enrollment is required before sign-in");
    }
    return mfa.createChallenge(db, user, meta);
  }
  const session = sessions.createSession(db, user.id, {
    ...meta,
    username: user.username,
    mfaVerified: false,
  });
  return {
    token: session.token,
    user: publicUser(user),
    session: { public_id: session.public_id, expires_at: session.expires_at, mfa_verified: 0 },
  };
}

export function login(db, body, meta = {}) {
  const username = body.username;
  const password = body.password;
  const providerCode = body.provider || "password";
  assertRateLimit(db, { ip: meta.ip, action: "login", principal: username }, { username });
  providers.ensureDefaultProviders(db);
  const provider = providers.getEnabledProvider(db, providerCode);
  let user;
  if (provider.type === "password") {
    if (!username || !password) throw new HttpError(400, "username and password are required");
    user = providers.authenticatePasswordProvider(db, username, password, meta.ip);
  } else if (provider.type === "ldap") {
    if (!username || !password) throw new HttpError(400, "username and password are required");
    const identity = providers.authenticateLdapProvider(provider, username, password);
    user = resolveFederatedUser(db, provider, identity, meta.ip);
  } else {
    throw new HttpError(400, "Use /api/sso for this provider");
  }
  return finishLogin(db, user, { ...meta, providerCode: provider.code });
}

export function completeMfa(db, body, meta = {}) {
  assertRateLimit(db, { ip: meta.ip, action: "mfa", principal: "challenge" });
  const challenge = mfa.consumeChallenge(db, body.mfaToken);
  const user = users.getUser(db, challenge.user_id);
  mfa.verifyUserMfa(db, user.id, { code: body.code, recoveryCode: body.recoveryCode });
  const session = sessions.createSession(db, user.id, {
    ip: meta.ip,
    userAgent: meta.userAgent,
    providerCode: challenge.provider_code || "password",
    username: user.username,
    mfaVerified: true,
  });
  return {
    token: session.token,
    user: publicUser(user),
    session: { public_id: session.public_id, expires_at: session.expires_at, mfa_verified: 1 },
  };
}

function resolveFederatedUser(db, provider, identity, ip) {
  const linked = providers.findIdentity(db, provider.id, identity.subject);
  if (linked) return users.getUser(db, linked.user_id);
  if (identity.email) {
    const byEmail = queryOne(db, "SELECT * FROM users WHERE email = ? COLLATE NOCASE", [identity.email]);
    if (byEmail) {
      providers.linkIdentity(db, byEmail.id, provider.id, identity.subject, identity.email);
      return users.publicUser(byEmail);
    }
  }
  if (identity.username) {
    const byName = queryOne(db, "SELECT * FROM users WHERE username = ? COLLATE NOCASE", [identity.username]);
    if (byName) {
      providers.linkIdentity(db, byName.id, provider.id, identity.subject, identity.email);
      return users.publicUser(byName);
    }
  }
  if (getSetting(db, "auth.jit_provision", false)) {
    const username = identity.username || `sso.${String(identity.subject).replace(/[^a-zA-Z0-9]/g, "").slice(0, 12)}`;
    const created = users.createUser(db, {
      username,
      email: identity.email || `${username}@sso.local`,
      employee_id: `SSO-${randomToken(4).slice(0, 8)}`,
      display_name: identity.username || identity.email || identity.subject,
      password: `Tmp!${randomToken(8)}Aa1`,
    });
    providers.linkIdentity(db, created.id, provider.id, identity.subject, identity.email);
    writeAudit(db, {
      actor: created,
      action: "auth.jit_provision",
      resourceType: "user",
      resourceId: created.id,
      details: { provider: provider.code },
      ip,
    });
    return created;
  }
  throw new HttpError(403, "No local identity linked to this SSO subject");
}

function storeSsoState(db, provider, start, redirectUri) {
  const expires = new Date(Date.now() + 10 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  run(
    db,
    `INSERT INTO sso_states (state, nonce, code_verifier_enc, provider_id, redirect_uri, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [start.state, start.nonce || "", start.verifier || "", provider.id, redirectUri || "", expires, nowIso()]
  );
}

export function startSso(db, code, body = {}, meta = {}) {
  assertRateLimit(db, { ip: meta.ip, action: "sso-start", principal: code });
  providers.ensureDefaultProviders(db);
  const provider = providers.getEnabledProvider(db, code);
  let start;
  if (provider.type === "oidc") start = providers.startOidc(provider, { redirectUri: body.redirectUri });
  else if (provider.type === "saml") start = providers.startSaml(provider);
  else throw new HttpError(400, "Provider does not support SSO start");
  storeSsoState(db, provider, start, body.redirectUri);
  writeAudit(db, {
    actor: { username: "anonymous" },
    action: "auth.sso.start",
    resourceType: "auth_provider",
    resourceId: provider.code,
    ip: meta.ip,
  });
  return {
    provider: provider.code,
    type: provider.type,
    state: start.state,
    authorizationUrl: start.authorizationUrl,
    method: start.method,
  };
}

export function completeSso(db, code, body = {}, meta = {}) {
  assertRateLimit(db, { ip: meta.ip, action: "sso-callback", principal: code });
  const provider = providers.getEnabledProvider(db, code);
  const stateKey = body.state || body.relayState || body.RelayState;
  const stored = queryOne(db, "SELECT * FROM sso_states WHERE state = ?", [stateKey]);
  if (!stored) throw new HttpError(400, "Invalid SSO state");
  if (stored.consumed_at) throw new HttpError(400, "SSO state already used");
  if (new Date(stored.expires_at.replace(" ", "T") + "Z") < new Date()) throw new HttpError(400, "SSO state expired");
  if (Number(stored.provider_id) !== Number(provider.id)) throw new HttpError(400, "SSO state does not match provider");
  run(db, "UPDATE sso_states SET consumed_at = ? WHERE id = ?", [nowIso(), stored.id]);
  let identity;
  if (provider.type === "oidc") identity = providers.completeOidc(provider, body, stored);
  else if (provider.type === "saml") identity = providers.completeSaml(provider, body, stored);
  else throw new HttpError(400, "Provider does not support SSO callback");
  const user = resolveFederatedUser(db, provider, identity, meta.ip);
  if (user.status && user.status !== "active") throw new HttpError(403, "Account is not active");
  writeAudit(db, {
    actor: user,
    action: "auth.sso.complete",
    resourceType: "auth_provider",
    resourceId: provider.code,
    ip: meta.ip,
  });
  return finishLogin(db, user, { ...meta, providerCode: provider.code });
}

export function ssoMetadata(db, code) {
  const provider = providers.getProvider(db, code);
  const config = providers.providerConfig(provider);
  if (provider.type === "saml") {
    return {
      type: "saml",
      entityId: config.entity_id || "helix-iam",
      acsUrl: config.acs_url || `/api/sso/${provider.code}/callback`,
    };
  }
  if (provider.type === "oidc") {
    return {
      type: "oidc",
      issuer: config.issuer || "",
      clientId: config.client_id || "",
      redirectUri: config.redirect_uri || `/api/sso/${provider.code}/callback`,
    };
  }
  throw new HttpError(400, "Metadata is only available for SAML and OIDC providers");
}

export function requestPasswordReset(db, body, meta = {}) {
  const identifier = body.username || body.email;
  assertRateLimit(db, { ip: meta.ip, action: "reset", principal: identifier || "anon" });
  if (!identifier) throw new HttpError(400, "username or email is required");
  const user = queryOne(
    db,
    "SELECT * FROM users WHERE username = ? COLLATE NOCASE OR email = ? COLLATE NOCASE",
    [identifier, identifier]
  );
  if (user && user.status !== "inactive") {
    const token = randomToken();
    const minutes = Number(getSetting(db, "auth.reset_token_minutes", 30)) || 30;
    const expires = new Date(Date.now() + minutes * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
    run(
      db,
      "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?)",
      [user.id, sha256(token), expires, meta.ip || null, nowIso()]
    );
    writeAudit(db, {
      actor: { id: user.id, username: user.username },
      action: "auth.password_reset.request",
      resourceType: "user",
      resourceId: user.id,
      ip: meta.ip,
    });
    if (meta.includeToken) return { ok: true, token };
  }
  return { ok: true };
}

export function completePasswordReset(db, body, meta = {}) {
  if (!body.token || !body.password) throw new HttpError(400, "token and password are required");
  const row = queryOne(db, "SELECT * FROM password_reset_tokens WHERE token_hash = ?", [sha256(body.token)]);
  if (!row || row.consumed_at) throw new HttpError(400, "Invalid or expired reset token");
  if (new Date(row.expires_at.replace(" ", "T") + "Z") < new Date()) {
    throw new HttpError(400, "Invalid or expired reset token");
  }
  const user = users.getUser(db, row.user_id);
  users.resetPassword(db, user.id, body.password, { id: user.id, username: user.username }, meta.ip);
  run(db, "UPDATE password_reset_tokens SET consumed_at = ? WHERE id = ?", [nowIso(), row.id]);
  if (getSetting(db, "auth.revoke_sessions_on_reset", true)) {
    sessions.revokeAllSessions(db, user.id, { id: user.id, username: user.username }, meta.ip);
  }
  return { ok: true };
}

export function authSettings(db) {
  return {
    mfaRequired: Boolean(getSetting(db, "auth.mfa_required", false)),
    jitProvision: Boolean(getSetting(db, "auth.jit_provision", false)),
    rateLimitMax: Number(getSetting(db, "auth.rate_limit_max", 10)),
    rateLimitWindowSeconds: Number(getSetting(db, "auth.rate_limit_window_seconds", 60)),
    resetTokenMinutes: Number(getSetting(db, "auth.reset_token_minutes", 30)),
    revokeSessionsOnReset: Boolean(getSetting(db, "auth.revoke_sessions_on_reset", true)),
    sessionHours: Number(getSetting(db, "identity.session_hours", 12)),
  };
}
