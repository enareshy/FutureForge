import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { isPlatformAdmin } from "../tenants.js";
import { resolveContentStorage, buildContentStorageKey } from "./storage.js";
import { DEFAULT_LOCK_TTL_SECONDS } from "./constants.js";
import { Errors } from "./errors.js";
import {
  publicLock,
  findContentRow,
  activeLockRow,
  assertTenant,
  currentVersionRow,
} from "./repository.js";
import { lockToken as newLockToken } from "./refs.js";
import { assertContentAccess } from "./content.js";
import { persistNewVersion, registerStorageReference } from "./versions.js";
import { processContentVersion } from "./processing.js";
import { markRenditionsOutdated } from "./renditions.js";
import { recordContentEvent, auditContent } from "./events.js";

// Check-in/check-out service (spec §12). The partial unique index on
// content_locks guarantees at most one active lock per content, so concurrent
// check-outs cannot both succeed even under load.

function lockExpiry(ttlSeconds) {
  const ttl = Math.max(60, Number(ttlSeconds || process.env.CONTENT_LOCK_TTL_SECONDS || DEFAULT_LOCK_TTL_SECONDS));
  return new Date(Date.now() + ttl * 1000).toISOString().replace("T", " ").slice(0, 19);
}

const CHECKOUT_ALLOWED = new Set(["available", "archived", "retained"]);

export function getActiveLock(db, contentRow) {
  return publicLock(activeLockRow(db, contentRow.id));
}

export function listLocks(db, { tenantId = null, activeOnly = true, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (tenantId !== null && tenantId !== undefined) {
    where.push("l.tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (activeOnly) where.push("l.released_at IS NULL");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = queryAll(
    db,
    `SELECT l.* FROM content_locks l ${clause} ORDER BY l.locked_at DESC LIMIT ?`,
    [...params, Math.min(500, Math.max(1, Number(limit) || 100))]
  );
  return { items: rows.map(publicLock), total: rows.length };
}

export function checkOutContent(db, reference, { actor = null, tenantId = null, reason = "", ttlSeconds = null, ip = null } = {}) {
  return transaction(db, () => {
    const row = findContentRow(db, reference, tenantId);
    assertContentAccess(db, row, actor, "checkout", { tenantId });
    if (row.deleted_at) throw Errors.notFound();
    if (row.status === "quarantined") throw Errors.quarantined();
    if (row.security_status !== "clean") throw Errors.accessDenied("Content has not passed security validation");
    const existing = activeLockRow(db, row.id);
    if (existing) throw Errors.locked(`Content is already checked out by user ${existing.locked_by}`);
    if (!CHECKOUT_ALLOWED.has(row.status)) throw Errors.checkoutNotAllowed(`Cannot check out content in status ${row.status}`);
    const ts = nowIso();
    let insert;
    try {
      insert = run(
        db,
        `INSERT INTO content_locks (content_id, tenant_id, lock_token, lock_type, locked_by, locked_at, last_activity_at, expires_at, reason, created_at)
         VALUES (?, ?, ?, 'exclusive', ?, ?, ?, ?, ?, ?)`,
        [Number(row.id), row.tenant_id, newLockToken(), actor?.id ?? null, ts, ts, lockExpiry(ttlSeconds), reason || "", ts]
      );
    } catch (err) {
      if (String(err.message || "").includes("UNIQUE")) throw Errors.locked();
      throw err;
    }
    run(db, "UPDATE content SET status = 'locked', updated_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", [
      actor?.id ?? null,
      ts,
      Number(row.id),
    ]);
    const lock = queryOne(db, "SELECT * FROM content_locks WHERE id = ?", [Number(insert.lastInsertRowid)]);
    const updated = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(row.id)]);
    recordContentEvent(db, { eventType: "ContentCheckedOut", content: updated, actor, tenantId: row.tenant_id, payload: { lock_token: lock.lock_token, expires_at: lock.expires_at } });
    auditContent(db, { actor, tenantId: row.tenant_id, action: "content.checked_out", content: updated, details: { lock_token: lock.lock_token }, ip });
    return publicLock(lock);
  });
}

function requireOwnedLock(db, row, actor) {
  const lock = activeLockRow(db, row.id);
  if (!lock) throw Errors.lockNotFound();
  if (Number(lock.locked_by) !== Number(actor?.id) && !isPlatformAdmin(db, actor?.id)) {
    throw Errors.locked("Content is checked out by another user");
  }
  return lock;
}

// Check-in accepts edited bytes (buffer) or a staging upload id. It validates,
// creates a new immutable content version, scans it and releases the lock.
export async function checkInContent(db, reference, options = {}) {
  const { actor = null, tenantId = null, buffer = null, uploadSession = null, fileName = null, mimeType = null, comment = "", renditionTypes = null, store = null, ip = null } = options;
  const storage = store || resolveContentStorage();
  const row0 = findContentRow(db, reference, tenantId);
  assertContentAccess(db, row0, actor, "checkin", { tenantId });
  const lock = requireOwnedLock(db, row0, actor);

  // A check-in with no edited bytes is a "no-change check-in": the lock is
  // released and the current version stays untouched.
  if (!uploadSession && (!buffer || !buffer.length)) {
    return transaction(db, () => {
      const released = releaseLockRow(db, lock, { actor, force: false, reason: comment || "Checked in without changes" });
      run(db, "UPDATE content SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", ["available", nowIso(), Number(row0.id)]);
      const refreshed = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(row0.id)]);
      recordContentEvent(db, { eventType: "ContentCheckedIn", content: refreshed, actor, tenantId: row0.tenant_id, payload: { comment, changed: false } });
      auditContent(db, { actor, tenantId: row0.tenant_id, action: "content.checked_in", content: refreshed, details: { comment, changed: false }, ip });
      return { content: refreshed, scan: null, renditions: [], lock_token: released.lock_token, changed: false };
    });
  }

  let stored = null;
  if (uploadSession) {
    const meta = await storage.getMetadata(uploadSession.staging_key);
    if (!meta) throw Errors.uploadFailed("No staged bytes were found for this check-in");
    const key = buildContentStorageKey({ tenantId: row0.tenant_id, objectType: row0.object_type || "object", objectId: row0.object_id || "none", contentId: row0.content_id });
    const moved = await storage.move(uploadSession.staging_key, key);
    stored = { key, size: moved?.size ?? meta.size, checksum: meta.checksum, provider: moved?.provider || storage.kind, bucket: moved?.bucket || storage.bucket };
  } else if (buffer && buffer.length) {
    const key = buildContentStorageKey({ tenantId: row0.tenant_id, objectType: row0.object_type || "object", objectId: row0.object_id || "none", contentId: row0.content_id });
    const written = await storage.upload({ key, buffer });
    stored = { ...written };
  }

  const created = transaction(db, () => {
    const versionRow = persistNewVersion(
      db,
      row0,
      {
        fileName: fileName || row0.file_name,
        originalFileName: row0.original_file_name || row0.file_name,
        extension: row0.file_extension,
        mimeType: mimeType || row0.mime_type,
        size: stored.size,
        checksum: stored.checksum,
        status: "pending_security",
        securityStatus: "pending",
        checkinComment: comment || "",
        createdBy: actor?.id ?? null,
      },
      stored
    );
    registerStorageReference(db, { contentRow: row0, versionId: versionRow.id, stored });
    markRenditionsOutdated(db, row0);
    recordContentEvent(db, { eventType: "ContentVersionCreated", content: row0, versionId: versionRow.id, actor, tenantId: row0.tenant_id, payload: { version: versionRow.version_number, comment } });
    return queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(row0.id)]);
  });

  const processed = await processContentVersion(db, created, { store: storage, actor, renditionTypes });
  releaseLockRow(db, lock, { actor, force: false, reason: "Check-in completed" });
  const refreshed = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(row0.id)]);
  recordContentEvent(db, { eventType: "ContentCheckedIn", content: refreshed, versionId: processed?.renditions?.length ? created.current_version_id : created.current_version_id, actor, tenantId: row0.tenant_id, payload: { comment, security_status: refreshed.security_status } });
  auditContent(db, { actor, tenantId: row0.tenant_id, action: "content.checked_in", content: refreshed, details: { comment, version_count: refreshed.version_count }, ip });
  return { content: refreshed, scan: processed.scan, renditions: processed.renditions, lock_token: lock.lock_token };
}

function releaseLockRow(db, lock, { actor = null, force = false, reason = "" } = {}) {
  run(
    db,
    "UPDATE content_locks SET released_at = ?, released_by = ?, force_released = ?, release_reason = ? WHERE id = ?",
    [nowIso(), actor?.id ?? null, force ? 1 : 0, reason || "", Number(lock.id)]
  );
  return queryOne(db, "SELECT * FROM content_locks WHERE id = ?", [Number(lock.id)]);
}

export function releaseLock(db, reference, { actor = null, tenantId = null, reason = "", force = false, ip = null } = {}) {
  return transaction(db, () => {
    const row = findContentRow(db, reference, tenantId);
    if (!force) assertContentAccess(db, row, actor, "checkin", { tenantId });
    const lock = activeLockRow(db, row.id);
    if (!lock) throw Errors.lockNotFound();
    if (!force && Number(lock.locked_by) !== Number(actor?.id) && !isPlatformAdmin(db, actor?.id)) {
      throw Errors.locked("Content is checked out by another user");
    }
    const released = releaseLockRow(db, lock, { actor, force, reason });
    const nextStatus = row.deleted_at ? "deleted" : row.status === "quarantined" ? "quarantined" : "available";
    run(db, "UPDATE content SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", [nextStatus, nowIso(), Number(row.id)]);
    const updated = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(row.id)]);
    recordContentEvent(db, { eventType: "ContentLockReleased", content: updated, actor, tenantId: row.tenant_id, payload: { force, reason } });
    auditContent(db, { actor, tenantId: row.tenant_id, action: "content.lock.released", content: updated, details: { force, reason }, ip });
    return publicLock(released);
  });
}

export function cancelCheckOut(db, reference, { actor = null, tenantId = null, reason = "", ip = null } = {}) {
  return releaseLock(db, reference, { actor, tenantId, reason: reason || "Check-out cancelled", force: false, ip });
}

export function forceReleaseLock(db, reference, { actor = null, tenantId = null, reason = "", ip = null } = {}) {
  return releaseLock(db, reference, { actor, tenantId, reason: reason || "Force released", force: true, ip });
}

export function releaseExpiredLocks(db, { now = nowIso() } = {}) {
  const expired = queryAll(db, "SELECT * FROM content_locks WHERE released_at IS NULL AND expires_at IS NOT NULL AND expires_at <= ?", [now]);
  let released = 0;
  for (const lock of expired) {
    releaseLockRow(db, lock, { actor: null, force: true, reason: "Lock expired" });
    const row = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(lock.content_id)]);
    if (row && row.status === "locked") {
      run(db, "UPDATE content SET status = 'available', updated_at = ? WHERE id = ?", [now, Number(row.id)]);
    }
    released += 1;
  }
  return { released };
}
