import { queryAll, queryOne, run, nowIso } from "../db.js";
import {
  encryptSecret,
  decryptSecret,
  generateTotpSecret,
  verifyTotp,
  otpauthUri,
  hashPassword,
  verifyPassword,
  randomToken,
  sha256,
} from "../crypto.js";
import { HttpError } from "../validation.js";
import { writeAudit } from "./audit.js";
import { getSetting } from "./hierarchy.js";

function recoveryCodes(count = 10) {
  const raw = [];
  const stored = [];
  for (let i = 0; i < count; i++) {
    const code = randomToken(5).slice(0, 10).toUpperCase();
    const { hash, salt } = hashPassword(code);
    raw.push(code);
    stored.push({ hash, salt });
  }
  return { raw, stored };
}

export function mfaRequiredSetting(db) {
  return Boolean(getSetting(db, "auth.mfa_required", false));
}

export function listFactors(db, userId) {
  return queryAll(
    db,
    "SELECT id, kind, label, verified, created_at, verified_at FROM mfa_factors WHERE user_id = ?",
    [userId]
  );
}

export function hasVerifiedMfa(db, userId) {
  const row = queryOne(
    db,
    "SELECT id FROM mfa_factors WHERE user_id = ? AND verified = 1 LIMIT 1",
    [userId]
  );
  return Boolean(row);
}

export function mfaStatus(db, userId) {
  const factors = listFactors(db, userId);
  const remaining = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL",
    [userId]
  ).c;
  return {
    required: mfaRequiredSetting(db),
    enrolled: factors.some((f) => f.verified),
    factors,
    recoveryCodesRemaining: remaining,
  };
}

export function enrollTotp(db, user, ip) {
  const existing = queryOne(
    db,
    "SELECT * FROM mfa_factors WHERE user_id = ? AND kind = 'totp'",
    [user.id]
  );
  const secret = generateTotpSecret();
  if (existing) {
    run(
      db,
      "UPDATE mfa_factors SET secret_enc = ?, verified = 0, verified_at = NULL, created_at = ? WHERE id = ?",
      [encryptSecret(secret), nowIso(), existing.id]
    );
  } else {
    run(
      db,
      "INSERT INTO mfa_factors (user_id, kind, label, secret_enc, verified, created_at) VALUES (?, 'totp', 'Authenticator', ?, 0, ?)",
      [user.id, encryptSecret(secret), nowIso()]
    );
  }
  writeAudit(db, {
    actor: user,
    action: "mfa.enroll",
    resourceType: "user",
    resourceId: user.id,
    ip,
  });
  return {
    secret,
    otpauth: otpauthUri(secret, user.username || user.email),
    verified: false,
  };
}

export function verifyTotpEnrollment(db, user, code, ip) {
  const factor = queryOne(db, "SELECT * FROM mfa_factors WHERE user_id = ? AND kind = 'totp'", [user.id]);
  if (!factor) throw new HttpError(400, "No TOTP enrollment in progress");
  const secret = decryptSecret(factor.secret_enc);
  if (!verifyTotp(secret, code)) throw new HttpError(401, "Invalid authenticator code");
  run(
    db,
    "UPDATE mfa_factors SET verified = 1, verified_at = ? WHERE id = ?",
    [nowIso(), factor.id]
  );
  run(db, "DELETE FROM mfa_recovery_codes WHERE user_id = ?", [user.id]);
  const codes = recoveryCodes();
  for (const row of codes.stored) {
    run(
      db,
      "INSERT INTO mfa_recovery_codes (user_id, code_hash, code_salt, created_at) VALUES (?, ?, ?, ?)",
      [user.id, row.hash, row.salt, nowIso()]
    );
  }
  writeAudit(db, {
    actor: user,
    action: "mfa.verify",
    resourceType: "user",
    resourceId: user.id,
    ip,
  });
  return { verified: true, recoveryCodes: codes.raw };
}

export function disableTotp(db, user, { code, recoveryCode } = {}, ip) {
  const factor = queryOne(
    db,
    "SELECT * FROM mfa_factors WHERE user_id = ? AND kind = 'totp' AND verified = 1",
    [user.id]
  );
  if (!factor) throw new HttpError(400, "MFA is not enabled");
  const ok = code
    ? verifyTotp(decryptSecret(factor.secret_enc), code)
    : consumeRecoveryCode(db, user.id, recoveryCode);
  if (!ok) throw new HttpError(401, "Invalid authenticator code");
  run(db, "DELETE FROM mfa_factors WHERE user_id = ?", [user.id]);
  run(db, "DELETE FROM mfa_recovery_codes WHERE user_id = ?", [user.id]);
  writeAudit(db, {
    actor: user,
    action: "mfa.disable",
    resourceType: "user",
    resourceId: user.id,
    ip,
  });
  return { ok: true };
}

export function regenerateRecovery(db, user, code, ip) {
  const factor = queryOne(
    db,
    "SELECT * FROM mfa_factors WHERE user_id = ? AND kind = 'totp' AND verified = 1",
    [user.id]
  );
  if (!factor) throw new HttpError(400, "MFA is not enabled");
  if (!verifyTotp(decryptSecret(factor.secret_enc), code)) throw new HttpError(401, "Invalid authenticator code");
  run(db, "DELETE FROM mfa_recovery_codes WHERE user_id = ?", [user.id]);
  const codes = recoveryCodes();
  for (const row of codes.stored) {
    run(
      db,
      "INSERT INTO mfa_recovery_codes (user_id, code_hash, code_salt, created_at) VALUES (?, ?, ?, ?)",
      [user.id, row.hash, row.salt, nowIso()]
    );
  }
  writeAudit(db, {
    actor: user,
    action: "mfa.recovery.regenerate",
    resourceType: "user",
    resourceId: user.id,
    ip,
  });
  return { recoveryCodes: codes.raw };
}

export function consumeRecoveryCode(db, userId, code) {
  if (!code) return false;
  const rows = queryAll(
    db,
    "SELECT * FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL",
    [userId]
  );
  for (const row of rows) {
    if (verifyPassword(String(code).toUpperCase(), row.code_hash, row.code_salt)) {
      run(db, "UPDATE mfa_recovery_codes SET used_at = ? WHERE id = ?", [nowIso(), row.id]);
      return true;
    }
  }
  return false;
}

export function verifyUserMfa(db, userId, { code, recoveryCode } = {}) {
  const factor = queryOne(
    db,
    "SELECT * FROM mfa_factors WHERE user_id = ? AND kind = 'totp' AND verified = 1",
    [userId]
  );
  if (!factor) throw new HttpError(400, "MFA is not enabled");
  if (code && verifyTotp(decryptSecret(factor.secret_enc), code)) return true;
  if (recoveryCode && consumeRecoveryCode(db, userId, recoveryCode)) return true;
  throw new HttpError(401, "Invalid authenticator code");
}

export function createChallenge(db, user, meta = {}) {
  const token = randomToken();
  const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  run(
    db,
    `INSERT INTO mfa_challenges (token_hash, user_id, provider_code, expires_at, ip, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [sha256(token), user.id, meta.providerCode || "password", expires, meta.ip || null, meta.userAgent || null, nowIso()]
  );
  return { mfaRequired: true, mfaToken: token, user: { id: user.id, username: user.username, display_name: user.display_name } };
}

export function consumeChallenge(db, mfaToken) {
  if (!mfaToken) throw new HttpError(400, "mfaToken is required");
  const row = queryOne(db, "SELECT * FROM mfa_challenges WHERE token_hash = ?", [sha256(mfaToken)]);
  if (!row) throw new HttpError(401, "Invalid MFA challenge");
  if (row.consumed_at) throw new HttpError(401, "MFA challenge already used");
  if (new Date(row.expires_at.replace(" ", "T") + "Z") < new Date()) {
    throw new HttpError(401, "MFA challenge expired");
  }
  run(db, "UPDATE mfa_challenges SET consumed_at = ? WHERE id = ?", [nowIso(), row.id]);
  return row;
}

export function adminResetMfa(db, userId, actor, ip) {
  run(db, "DELETE FROM mfa_factors WHERE user_id = ?", [userId]);
  run(db, "DELETE FROM mfa_recovery_codes WHERE user_id = ?", [userId]);
  run(db, "DELETE FROM mfa_challenges WHERE user_id = ?", [userId]);
  writeAudit(db, {
    actor,
    action: "mfa.admin_reset",
    resourceType: "user",
    resourceId: userId,
    ip,
  });
  return { ok: true };
}
