// Durable distributed locks for the execution engine.
//
// Locks are stored in `job_locks` so leadership and dedupe survive process
// restarts. Acquisition is a single guarded upsert: a lock can be taken when it
// is free, expired, or already owned by the caller. All operations are safe
// under concurrent access because SQLite serialises writes and callers check
// the returned row count.

import { queryOne, run, nowIso, randomUuid } from "../../db.js";
import { parseSqlTime, sqlTimeAfterSeconds } from "./timezone.js";

export function acquireLock(db, name, owner, { ttlSeconds = 60, purpose = "" } = {}) {
  const ts = nowIso();
  const expiresAt = sqlTimeAfterSeconds(ts, ttlSeconds);
  const result = run(
    db,
    `INSERT INTO job_locks (name, owner, purpose, acquired_at, expires_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       owner = excluded.owner,
       purpose = excluded.purpose,
       acquired_at = excluded.acquired_at,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at
     WHERE job_locks.owner = excluded.owner OR job_locks.expires_at <= excluded.updated_at`,
    [name, owner, String(purpose || ""), ts, expiresAt, ts]
  );
  return result.changes === 1;
}

export function renewLock(db, name, owner, { ttlSeconds = 60 } = {}) {
  const ts = nowIso();
  const expiresAt = sqlTimeAfterSeconds(ts, ttlSeconds);
  const result = run(
    db,
    "UPDATE job_locks SET expires_at = ?, updated_at = ? WHERE name = ? AND owner = ?",
    [expiresAt, ts, name, owner]
  );
  return result.changes === 1;
}

export function releaseLock(db, name, owner) {
  const result = run(db, "DELETE FROM job_locks WHERE name = ? AND owner = ?", [name, owner]);
  return result.changes === 1;
}

export function getLock(db, name) {
  const row = queryOne(db, "SELECT * FROM job_locks WHERE name = ?", [name]);
  if (!row) return null;
  return {
    name: row.name,
    owner: row.owner,
    purpose: row.purpose || "",
    acquired_at: row.acquired_at,
    expires_at: row.expires_at,
    expired: (parseSqlTime(row.expires_at)?.getTime() || 0) <= Date.now(),
  };
}

export function purgeExpiredLocks(db) {
  return run(db, "DELETE FROM job_locks WHERE expires_at <= ?", [nowIso()]).changes;
}

// Runs `fn` only while the lock is held; releases in all cases.
export async function withLock(db, name, fn, { owner = `lock-${randomUuid().slice(0, 8)}`, ttlSeconds = 60, purpose = "" } = {}) {
  if (!acquireLock(db, name, owner, { ttlSeconds, purpose })) {
    return { locked: false, result: null };
  }
  try {
    const result = await fn({ owner, renew: (seconds) => renewLock(db, name, owner, { ttlSeconds: seconds || ttlSeconds }) });
    return { locked: true, result };
  } finally {
    releaseLock(db, name, owner);
  }
}

export function lockName(...parts) {
  return parts.map((part) => String(part)).join(":");
}
