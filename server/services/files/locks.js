import { queryAll, queryOne, run, nowIso, randomUuid } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { isPlatformAdmin, assertTenantScope } from "../tenants.js";
import { getStorageProvider, buildObjectKey } from "../file-storage.js";
import { findFileRow, publicFile, publicLock, currentVersionRow, assertTenant } from "./repository.js";
import { assertAccess, canAccess } from "./permissions.js";
import { createVersion } from "./versions.js";
import { recordFileEvent, auditFile } from "./events.js";

// Check-out / check-in locking. An active lock is a durable guarantee (partial
// unique index) that only one editor holds a file at a time. Locks expire and
// can be forcibly released by users holding the release_lock permission, but a
// user's in-flight work is never destroyed: check-in optionally records a new
// immutable version.

const DEFAULT_LOCK_MINUTES = 30;
const MAX_LOCK_MINUTES = 24 * 60;

function lockTtlMinutes(input) {
  const minutes = Number(input ?? process.env.FILE_LOCK_TTL_MINUTES ?? DEFAULT_LOCK_MINUTES);
  if (!Number.isFinite(minutes) || minutes <= 0) return DEFAULT_LOCK_MINUTES;
  return Math.min(MAX_LOCK_MINUTES, Math.round(minutes));
}

function expiryFrom(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function findLockRow(db, reference) {
  const row = queryOne(
    db,
    `SELECT l.*, u.username AS locked_by_username, u.display_name AS locked_by_display_name
     FROM file_locks l LEFT JOIN users u ON u.id = l.locked_by
     WHERE l.id = ? OR l.lock_token = ?`,
    [Number(reference) || -1, String(reference || "")]
  );
  if (!row) throw new HttpError(404, "Lock not found");
  return row;
}

function activeLockFor(db, fileId) {
  return queryOne(
    db,
    `SELECT l.*, u.username AS locked_by_username, u.display_name AS locked_by_display_name
     FROM file_locks l LEFT JOIN users u ON u.id = l.locked_by
     WHERE l.file_id = ? AND l.released_at IS NULL ORDER BY l.id DESC LIMIT 1`,
    [Number(fileId)]
  );
}

function isExpired(row) {
  return Boolean(row?.expires_at && row.expires_at <= nowIso());
}

function refreshFileStatus(db, file, actorId, ts) {
  const version = currentVersionRow(db, file.id);
  const status = file.deleted_at ? "deleted" : (version && version.virus_scan_status === "clean" ? "available" : "pending_scan");
  run(db, "UPDATE files SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [status, actorId ?? null, ts, file.id]);
  return status;
}

export function checkOutFile(db, reference, body = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const file = findFileRow(db, reference, scope);
  if (file.deleted_at) throw new HttpError(409, "File is deleted");
  if (["quarantined", "scan_failed", "pending_scan", "scan_in_progress"].includes(file.status)) {
    throw new HttpError(423, "File is not available for check-out");
  }
  assertAccess(db, file, actor, "check_out", { tenantId: scope });

  const existing = activeLockFor(db, file.id);
  const ts = nowIso();
  if (existing) {
    if (isExpired(existing)) {
      run(
        db,
        "UPDATE file_locks SET released_at = ?, released_by = ?, release_reason = ?, force_released = 1 WHERE id = ?",
        [ts, actor?.id ?? null, "expired", existing.id]
      );
    } else if (Number(existing.locked_by) === Number(actor?.id) || isPlatformAdmin(db, actor?.id)) {
      const minutes = lockTtlMinutes(body.expires_in_minutes ?? body.expiresInMinutes);
      run(
        db,
        "UPDATE file_locks SET expires_at = ?, last_activity_at = ?, reason = COALESCE(?, reason) WHERE id = ?",
        [expiryFrom(minutes), ts, body.reason ?? null, existing.id]
      );
      const refreshed = activeLockFor(db, file.id);
      return { lock: publicLock(refreshed), file: publicFile(findFileRow(db, file.id, scope)), refreshed: true };
    } else {
      throw new HttpError(423, "File is checked out by another user", {
        locked_by: existing.locked_by_username || existing.locked_by,
        expires_at: existing.expires_at,
      });
    }
  }

  const minutes = lockTtlMinutes(body.expires_in_minutes ?? body.expiresInMinutes);
  const lockToken = randomUuid();
  const insert = run(
    db,
    `INSERT INTO file_locks
      (file_id, lock_type, lock_token, locked_by, tenant_id, reason, expires_at, last_activity_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [file.id, body.lock_type === "shared" ? "shared" : "exclusive", lockToken, actor?.id ?? null, scope,
      String(body.reason || "").slice(0, 500), expiryFrom(minutes), ts, ts]
  );
  run(db, "UPDATE files SET status = 'checked_out', updated_by = ?, updated_at = ? WHERE id = ?", [actor?.id ?? null, ts, file.id]);
  const lock = findLockRow(db, insert.lastInsertRowid);
  recordFileEvent(db, {
    eventType: "FileCheckedOut", file: findFileRow(db, file.id, scope), actor, tenantId: scope,
    payload: { lock_id: lock.id, expires_at: lock.expires_at },
  });
  auditFile(db, {
    actor, tenantId: scope, organizationId: file.organization_id, action: "files.lock.checkout",
    file, details: { lock_id: lock.id, expires_at: lock.expires_at, reason: lock.reason }, ip,
  });
  return { lock: publicLock(lock), file: publicFile(findFileRow(db, file.id, scope)), lock_token: lockToken };
}

// Locks in an "open" state for the caller: expired locks are auto-released so
// operators never have to fight a stale lock for a file nobody is editing.
export function getLock(db, reference, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const file = findFileRow(db, reference, scope);
  assertAccess(db, file, actor, "view_metadata", { tenantId: scope });
  const lock = activeLockFor(db, file.id);
  if (lock && isExpired(lock)) {
    run(
      db,
      "UPDATE file_locks SET released_at = ?, release_reason = ?, force_released = 1 WHERE id = ?",
      [nowIso(), "expired", lock.id]
    );
    refreshFileStatus(db, file, null, nowIso());
    return { file: publicFile(findFileRow(db, file.id, scope)), lock: null, expired_lock_id: lock.id };
  }
  return { file: publicFile(findFileRow(db, file.id, scope)), lock: lock ? publicLock(lock) : null };
}

export function listLocks(db, query = {}, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const { page, pageSize, offset } = pagination(query);
  const where = ["l.tenant_id = ?"];
  const params = [scope];
  if (query.active === "true" || query.active_only === "true" || !query.includeReleased) {
    where.push("l.released_at IS NULL");
  }
  if (query.userId || query.user_id) { where.push("l.locked_by = ?"); params.push(Number(query.userId ?? query.user_id)); }
  if (query.fileId || query.file_id) { where.push("l.file_id = ?"); params.push(Number(query.fileId ?? query.file_id)); }
  const clause = `WHERE ${where.join(" AND ")}`;
  const items = queryAll(
    db,
    `SELECT l.*, u.username AS locked_by_username, u.display_name AS locked_by_display_name, f.name AS file_name
     FROM file_locks l LEFT JOIN users u ON u.id = l.locked_by LEFT JOIN files f ON f.id = l.file_id
     ${clause} ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map((row) => ({ ...publicLock(row), file_name: row.file_name || "" }));
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM file_locks l ${clause}`, params).c;
  return { items, total, page, pageSize };
}

function assertLockAuthority(db, file, lock, actor, scope, action) {
  const isOwner = Number(lock.locked_by) === Number(actor?.id);
  const canManage = canAccess(db, file, actor, "release_lock", { tenantId: scope });
  if (!isOwner && !canManage) throw new HttpError(403, `Not authorized to ${action}`);
  return { isOwner, canManage };
}

export function releaseLock(db, reference, body = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const file = findFileRow(db, reference, scope);
  const lock = activeLockFor(db, file.id);
  if (!lock) throw new HttpError(404, "File is not locked");
  const { isOwner, canManage } = assertLockAuthority(db, file, lock, actor, scope, "release this lock");
  const ts = nowIso();
  run(
    db,
    "UPDATE file_locks SET released_at = ?, released_by = ?, release_reason = ?, force_released = ? WHERE id = ?",
    [ts, actor?.id ?? null, String(body.reason || "").slice(0, 500), canManage && !isOwner ? 1 : 0, lock.id]
  );
  refreshFileStatus(db, file, actor?.id, ts);
  recordFileEvent(db, {
    eventType: "FileLockReleased", file: findFileRow(db, file.id, scope), actor, tenantId: scope,
    payload: { lock_id: lock.id, forced: canManage && !isOwner },
  });
  auditFile(db, {
    actor, tenantId: scope, organizationId: file.organization_id,
    action: canManage && !isOwner ? "files.lock.force_release" : "files.lock.release",
    file, details: { lock_id: lock.id, reason: body.reason || "" }, ip,
  });
  return { released: true, lock_id: lock.id, file: publicFile(findFileRow(db, file.id, scope)) };
}

export function forceReleaseLock(db, reference, body = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const file = findFileRow(db, reference, scope);
  const lock = activeLockFor(db, file.id);
  if (!lock) throw new HttpError(404, "File is not locked");
  assertAccess(db, file, actor, "release_lock", { tenantId: scope });
  const ts = nowIso();
  run(
    db,
    "UPDATE file_locks SET released_at = ?, released_by = ?, force_released = 1, release_reason = ? WHERE id = ?",
    [ts, actor?.id ?? null, String(body.reason || "force released").slice(0, 500), lock.id]
  );
  refreshFileStatus(db, file, actor?.id, ts);
  recordFileEvent(db, {
    eventType: "FileLockReleased", file: findFileRow(db, file.id, scope), actor, tenantId: scope,
    payload: { lock_id: lock.id, forced: true },
  });
  auditFile(db, {
    actor, tenantId: scope, organizationId: file.organization_id, action: "files.lock.force_release",
    file, details: { lock_id: lock.id, locked_by: lock.locked_by, reason: body.reason || "" }, ip,
  });
  return { released: true, lock_id: lock.id, forced: true, file: publicFile(findFileRow(db, file.id, scope)) };
}

// Check-in: optionally stores a new version, then releases the caller's lock.
// Recording the version and releasing the lock happen in one logical step so a
// failed store never leaves the file unlocked mid-save.
export async function checkInFile(db, reference, body = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const file = findFileRow(db, reference, scope);
  const lock = activeLockFor(db, file.id);
  if (!lock) throw new HttpError(404, "File is not locked");
  assertLockAuthority(db, file, lock, actor, scope, "check in this file");

  let versionResult = null;
  const hasContent = Boolean(body.storage_key) || Boolean(body.buffer) || Boolean(body.data);
  if (hasContent) {
    assertAccess(db, file, actor, "check_in", { tenantId: scope });
    const provider = getStorageProvider();
    let storageKey = body.storage_key || "";
    let size = Number(body.size ?? body.size_bytes ?? 0) || 0;
    let checksum = body.checksum || "";
    if (!storageKey) {
      const buffer = body.buffer || (body.data ? Buffer.from(body.data, "base64") : null);
      if (!buffer || !buffer.length) throw new HttpError(400, "Check-in payload is required");
      storageKey = buildObjectKey({ tenantId: scope });
      const stored = await provider.putBuffer(storageKey, buffer);
      size = stored.size;
      checksum = checksum || stored.checksum;
    }
    versionResult = await createVersion(
      db,
      file.id,
      {
        storage_key: storageKey,
        storage_provider: provider.kind,
        storage_bucket: provider.bucket,
        name: body.name || file.name,
        original_name: file.original_name || file.name,
        mime_type: body.mime_type || file.mime_type,
        size,
        checksum,
        checkin_comment: body.checkin_comment || body.comment || "",
        major: body.major === true,
      },
      { actor, tenantId: scope, ip, provider, source: "checkin" }
    );
  }

  const ts = nowIso();
  run(
    db,
    "UPDATE file_locks SET released_at = ?, released_by = ?, release_reason = ? WHERE id = ?",
    [ts, actor?.id ?? null, body.release_reason || "checked in", lock.id]
  );
  const refreshed = findFileRow(db, file.id, scope);
  refreshFileStatus(db, refreshed, actor?.id, ts);
  const next = findFileRow(db, file.id, scope);
  recordFileEvent(db, {
    eventType: "FileCheckedIn", file: next, actor, tenantId: scope,
    payload: { lock_id: lock.id, new_version_id: versionResult?.version?.id ?? null },
  });
  auditFile(db, {
    actor, tenantId: scope, organizationId: next.organization_id, action: "files.lock.checkin",
    file: next, details: { lock_id: lock.id, new_version: versionResult?.version?.version_label || null }, ip,
  });
  return {
    checked_in: true,
    file: publicFile(next),
    version: versionResult?.version || null,
    scan_status: versionResult?.scan_status || null,
  };
}

export function releaseExpiredLocks(db, { now = nowIso(), limit = 200 } = {}) {
  const rows = queryAll(
    db,
    `SELECT l.*, f.name AS file_name FROM file_locks l LEFT JOIN files f ON f.id = l.file_id
     WHERE l.released_at IS NULL AND l.expires_at IS NOT NULL AND l.expires_at <= ?
     ORDER BY l.expires_at LIMIT ?`,
    [now, limit]
  );
  let released = 0;
  for (const row of rows) {
    run(
      db,
      "UPDATE file_locks SET released_at = ?, release_reason = ?, force_released = 1 WHERE id = ?",
      [now, "expired", row.id]
    );
    const file = queryOne(db, "SELECT * FROM files WHERE id = ?", [row.file_id]);
    if (file) refreshFileStatus(db, file, null, now);
    released += 1;
  }
  return { released_count: released };
}
