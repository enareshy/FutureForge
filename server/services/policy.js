import { queryOne, run, nowIso } from "../db.js";
import { HttpError } from "../validation.js";

export function getPolicy(db) {
  return queryOne(db, "SELECT * FROM password_policy WHERE id = 1");
}

export function updatePolicy(db, body) {
  const current = getPolicy(db);
  const next = {
    min_length: body.min_length ?? current.min_length,
    require_uppercase: toFlag(body.require_uppercase, current.require_uppercase),
    require_lowercase: toFlag(body.require_lowercase, current.require_lowercase),
    require_digit: toFlag(body.require_digit, current.require_digit),
    require_special: toFlag(body.require_special, current.require_special),
    max_age_days: body.max_age_days ?? current.max_age_days,
    history_count: body.history_count ?? current.history_count,
    lockout_threshold: body.lockout_threshold ?? current.lockout_threshold,
    lockout_minutes: body.lockout_minutes ?? current.lockout_minutes,
  };
  if (next.min_length < 8 || next.min_length > 64) {
    throw new HttpError(400, "min_length must be between 8 and 64");
  }
  if (next.lockout_threshold < 3 || next.lockout_threshold > 20) {
    throw new HttpError(400, "lockout_threshold must be between 3 and 20");
  }
  run(
    db,
    `UPDATE password_policy SET
      min_length = ?, require_uppercase = ?, require_lowercase = ?, require_digit = ?,
      require_special = ?, max_age_days = ?, history_count = ?, lockout_threshold = ?,
      lockout_minutes = ?, updated_at = ?
     WHERE id = 1`,
    [
      next.min_length,
      next.require_uppercase,
      next.require_lowercase,
      next.require_digit,
      next.require_special,
      next.max_age_days,
      next.history_count,
      next.lockout_threshold,
      next.lockout_minutes,
      nowIso(),
    ]
  );
  return getPolicy(db);
}

function toFlag(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return value ? 1 : 0;
}
