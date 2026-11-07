import { queryOne, run, nowIso } from "../db.js";
import { queryOneAsync, runAsync } from "../db-async.js";
import { HttpError } from "../validation.js";
import { writeAudit, writeAuditAsync } from "./audit.js";
import { getSetting, getSettingAsync } from "./hierarchy.js";

export function assertRateLimit(db, { ip, action, principal }, actorHint) {
  const max = Number(getSetting(db, "auth.rate_limit_max", 10)) || 10;
  const windowSec = Number(getSetting(db, "auth.rate_limit_window_seconds", 60)) || 60;
  const bucket = `${action}|${ip || "unknown"}|${principal || "-"}`;
  const since = new Date(Date.now() - windowSec * 1000).toISOString().replace("T", " ").slice(0, 19);
  run(db, "DELETE FROM auth_attempts WHERE created_at < ?", [since]);
  const count = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM auth_attempts WHERE bucket = ? AND created_at >= ?",
    [bucket, since]
  ).c;
  if (count >= max) {
    writeAudit(db, {
      actor: actorHint || { username: principal || "anonymous" },
      action: "auth.rate_limited",
      resourceType: "authentication",
      resourceId: action,
      details: { ip, windowSec, max },
      ip,
    });
    throw new HttpError(429, "Too many attempts. Try again later.");
  }
  run(db, "INSERT INTO auth_attempts (bucket, created_at) VALUES (?, ?)", [bucket, nowIso()]);
}

// Async twin of `assertRateLimit`.
export async function assertRateLimitAsync(db, { ip, action, principal }, actorHint) {
  const max = Number(await getSettingAsync(db, "auth.rate_limit_max", 10)) || 10;
  const windowSec = Number(await getSettingAsync(db, "auth.rate_limit_window_seconds", 60)) || 60;
  const bucket = `${action}|${ip || "unknown"}|${principal || "-"}`;
  const since = new Date(Date.now() - windowSec * 1000).toISOString().replace("T", " ").slice(0, 19);
  await runAsync(db, "DELETE FROM auth_attempts WHERE created_at < ?", [since]);
  const count = (
    await queryOneAsync(
      db,
      "SELECT COUNT(*) AS c FROM auth_attempts WHERE bucket = ? AND created_at >= ?",
      [bucket, since]
    )
  ).c;
  if (count >= max) {
    await writeAuditAsync(db, {
      actor: actorHint || { username: principal || "anonymous" },
      action: "auth.rate_limited",
      resourceType: "authentication",
      resourceId: action,
      details: { ip, windowSec, max },
      ip,
    });
    throw new HttpError(429, "Too many attempts. Try again later.");
  }
  await runAsync(db, "INSERT INTO auth_attempts (bucket, created_at) VALUES (?, ?)", [bucket, nowIso()]);
}
