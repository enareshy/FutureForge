import { queryAll, queryOne, run, nowIso } from "../db.js";
import { randomToken } from "../crypto.js";
import { HttpError, pagination } from "../validation.js";
import { writeAudit } from "./audit.js";
import { getSetting } from "./hierarchy.js";

export function sessionHours(db) {
  return Number(getSetting(db, "identity.session_hours", 12)) || 12;
}

export function publicSession(row) {
  if (!row) return null;
  const { token, ...rest } = row;
  return rest;
}

export function createSession(db, userId, meta = {}) {
  const token = randomToken();
  const publicId = randomToken(16);
  const ts = nowIso();
  const expires = new Date(Date.now() + sessionHours(db) * 3600 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
  const tenantId = meta.tenantId || queryOne(db, "SELECT tenant_id FROM users WHERE id = ?", [userId])?.tenant_id || null;
  run(
    db,
    `INSERT INTO sessions (
      token, user_id, expires_at, created_at, public_id, ip, user_agent,
      provider_code, mfa_verified, last_seen_at, tenant_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      token,
      userId,
      expires,
      ts,
      publicId,
      meta.ip || null,
      meta.userAgent || null,
      meta.providerCode || "password",
      meta.mfaVerified ? 1 : 0,
      ts,
      tenantId,
    ]
  );
  writeAudit(db, {
    actor: { id: userId, username: meta.username },
    action: "auth.session.create",
    resourceType: "session",
    resourceId: publicId,
    details: { provider: meta.providerCode || "password", mfa: !!meta.mfaVerified },
    ip: meta.ip,
  });
  return { token, public_id: publicId, user_id: userId, expires_at: expires, mfa_verified: meta.mfaVerified ? 1 : 0 };
}

export function getSessionByToken(db, token) {
  if (!token) return null;
  const session = queryOne(db, "SELECT * FROM sessions WHERE token = ?", [token]);
  if (!session) return null;
  if (session.revoked_at) return null;
  if (new Date(session.expires_at.replace(" ", "T") + "Z") < new Date()) {
    run(db, "UPDATE sessions SET revoked_at = ? WHERE token = ?", [nowIso(), token]);
    return null;
  }
  if (!session.public_id) {
    const publicId = randomToken(16);
    run(db, "UPDATE sessions SET public_id = ? WHERE token = ?", [publicId, token]);
    session.public_id = publicId;
  }
  run(db, "UPDATE sessions SET last_seen_at = ? WHERE token = ?", [nowIso(), token]);
  return session;
}

export function listMySessions(db, userId) {
  return queryAll(
    db,
    `SELECT public_id, user_id, expires_at, created_at, ip, user_agent, provider_code,
            mfa_verified, last_seen_at, revoked_at
     FROM sessions WHERE user_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC`,
    [userId]
  );
}

export function listSessions(db, query = {}) {
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  if (query.userId) {
    where.push("user_id = ?");
    params.push(Number(query.userId));
  }
  if (query.active === "1" || query.active === "true") where.push("revoked_at IS NULL");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM sessions ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT public_id, user_id, expires_at, created_at, ip, user_agent, provider_code,
            mfa_verified, last_seen_at, revoked_at
     FROM sessions ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return { items, total, page, pageSize };
}

function findOwned(db, publicId, userId) {
  const session = queryOne(db, "SELECT * FROM sessions WHERE public_id = ?", [publicId]);
  if (!session) throw new HttpError(404, "Session not found");
  if (userId && session.user_id !== Number(userId)) throw new HttpError(404, "Session not found");
  return session;
}

export function revokeSession(db, publicId, actor, ip, { ownerId } = {}) {
  const session = findOwned(db, publicId, ownerId);
  run(db, "UPDATE sessions SET revoked_at = ? WHERE public_id = ?", [nowIso(), publicId]);
  writeAudit(db, {
    actor,
    action: "auth.session.revoke",
    resourceType: "session",
    resourceId: publicId,
    details: { user_id: session.user_id },
    ip,
  });
  return { ok: true, public_id: publicId };
}

export function revokeAllSessions(db, userId, actor, ip, { exceptToken } = {}) {
  if (exceptToken) {
    run(
      db,
      "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND token != ? AND revoked_at IS NULL",
      [nowIso(), userId, exceptToken]
    );
  } else {
    run(db, "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [nowIso(), userId]);
  }
  writeAudit(db, {
    actor,
    action: "auth.session.revoke_all",
    resourceType: "user",
    resourceId: userId,
    ip,
  });
  return { ok: true };
}

export function logoutToken(db, token, actor, ip) {
  const session = queryOne(db, "SELECT * FROM sessions WHERE token = ?", [token]);
  if (session && !session.revoked_at) {
    run(db, "UPDATE sessions SET revoked_at = ? WHERE token = ?", [nowIso(), token]);
    writeAudit(db, {
      actor,
      action: "auth.logout",
      resourceType: "session",
      resourceId: session.public_id,
      ip,
    });
  }
  return { ok: true };
}
