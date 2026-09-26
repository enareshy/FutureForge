// Restore: return archived or cold-storage objects to active storage.
//
// Restore is distinct from recovery. Restoring brings an archived object back
// into the online estate using its archive package; recovery is for data lost to
// failure, corruption or storage loss and uses provider recovery points.
import { createHash } from "node:crypto";
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SOURCE_MODULE } from "./constants.js";
import { restoreRef } from "./refs.js";
import { publicRestoreRecord } from "./repository.js";
import { invalidRestore, restoreConflict, restoreFailed, restoreNotFound } from "./errors.js";
import { assertRestoreStrategy, assertTenantId, normalizeText, normalizeUpper, paginate } from "./validation.js";
import { requireObjectLifecycle, changeState } from "./objects.js";
import { getLatestArchiveRow, getArchiveRow } from "./archive.js";
import { getArchiveProvider } from "./providers.js";
import { recordHistory } from "./history.js";
import { publishLifecycleEvent } from "./events.js";
import { notifyLifecycleEvent } from "./notifications.js";

export { publicRestoreRecord };

const DEFAULT_TARGET = Object.freeze({ ARCHIVED: "INACTIVE", COLD_STORAGE: "ARCHIVED" });

export function getRestoreRow(db, tenantId, ref) {
  return queryOne(db, "SELECT * FROM lc_restore_records WHERE tenant_id = ? AND (restore_ref = ? OR CAST(id AS TEXT) = ?)", [
    Number(tenantId),
    String(ref),
    String(ref),
  ]);
}

export function requireRestore(db, tenantId, ref) {
  const row = getRestoreRow(db, tenantId, ref);
  if (!row) throw restoreNotFound(ref);
  return row;
}

export function getRestoreRecord(db, tenantId, ref) {
  return publicRestoreRecord(requireRestore(db, tenantId, ref));
}

export function listRestoreRecords(db, { tenantId, objectType, objectId, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(normalizeText(objectType, { max: 120 }));
  }
  if (objectId !== undefined && objectId !== null && objectId !== "") {
    clauses.push("object_id = ?");
    params.push(String(objectId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeText(status).toLowerCase());
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM lc_restore_records ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM lc_restore_records ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicRestoreRecord), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function detectRestoreConflict(db, { tenantId, objectType, objectId }) {
  const ledger = queryOne(db, "SELECT * FROM lc_object_lifecycle WHERE tenant_id = ? AND object_type = ? AND object_id = ?", [
    Number(tenantId),
    normalizeText(objectType, { max: 120 }),
    String(objectId),
  ]);
  if (!ledger) return { conflict: false, reason: "no_ledger_row" };
  if (String(ledger.current_state).toUpperCase() === "ACTIVE") {
    return { conflict: true, reason: "object_already_active", current_state: ledger.current_state };
  }
  return { conflict: false, reason: "archived_state", current_state: ledger.current_state };
}

// Create the restore request record. Conflict detection happens here so the
// chosen strategy is recorded before any mutation.
export function requestRestore(db, { tenantId, archiveRef = null, objectType, objectId, targetState = null, conflictStrategy = "FAIL", actor = null, ip = null, idempotencyKey = "" } = {}) {
  const tid = assertTenantId(tenantId);
  if (idempotencyKey) {
    const existing = queryOne(db, "SELECT * FROM lc_restore_records WHERE tenant_id = ? AND idempotency_key = ?", [tid, String(idempotencyKey)]);
    if (existing) return { row: existing, duplicate: true };
  }
  let archive;
  if (archiveRef) {
    archive = getArchiveRow(db, tid, archiveRef);
    if (!archive) throw restoreNotFound(archiveRef);
  } else {
    archive = getLatestArchiveRow(db, { tenantId: tid, objectType, objectId });
    if (!archive) throw restoreNotFound(`${objectType}:${objectId}`);
  }
  const ledger = requireObjectLifecycle(db, tid, archive.object_type, archive.object_id);
  const strategy = assertRestoreStrategy(conflictStrategy);
  const fromState = String(ledger.current_state).toUpperCase();
  const target = normalizeUpper(targetState || DEFAULT_TARGET[fromState] || "INACTIVE");
  const conflict = detectRestoreConflict(db, { tenantId: tid, objectType: archive.object_type, objectId: archive.object_id });

  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO lc_restore_records (restore_ref, tenant_id, archive_id, object_type, object_id, object_ref, target_state, conflict_strategy, conflict_detected, conflict_json, dependencies_json, status, idempotency_key, requested_by, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?)`,
    [
      restoreRef(archive.object_type, archive.object_id),
      tid,
      archive.id,
      archive.object_type,
      String(archive.object_id),
      archive.object_ref || "",
      target,
      strategy,
      conflict.conflict ? 1 : 0,
      JSON.stringify(conflict),
      conflict.conflict && strategy === "SKIP" ? "skipped" : "requested",
      String(idempotencyKey || ""),
      actor?.id ?? null,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM lc_restore_records WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, {
    actor,
    action: "data_lifecycle.restore.request",
    resourceType: "lc_restore_records",
    resourceId: row.restore_ref,
    details: { object_type: archive.object_type, object_id: String(archive.object_id), conflict: conflict.conflict, strategy },
    ip,
  });
  return { row, duplicate: false };
}

// Execute a requested restore. Returns the completed restore record, or a
// skipped record when the strategy says so.
export async function executeRestore(db, { tenantId, restoreRef: ref, actor = null, ip = null, force = false } = {}) {
  const tid = assertTenantId(tenantId);
  const row = requireRestore(db, tid, ref);
  if (row.status === "completed" || row.status === "skipped") return publicRestoreRecord(row);

  const strategy = row.conflict_strategy;
  const conflict = row.conflict_detected
    ? { conflict: true, ...(row.conflict_json ? JSON.parse(row.conflict_json) : {}) }
    : detectRestoreConflict(db, { tenantId: tid, objectType: row.object_type, objectId: row.object_id });

  if (conflict.conflict && !force) {
    if (strategy === "FAIL") {
      run(db, "UPDATE lc_restore_records SET status = 'failed', error = ?, completed_at = ? WHERE id = ?", ["restore conflict", nowIso(), row.id]);
      throw restoreConflict(row.restore_ref, conflict);
    }
    if (strategy === "SKIP") {
      const ts = nowIso();
      run(db, "UPDATE lc_restore_records SET status = 'skipped', completed_at = ? WHERE id = ?", [ts, row.id]);
      writeAudit(db, { actor, action: "data_lifecycle.restore.skip", resourceType: "lc_restore_records", resourceId: row.restore_ref, details: conflict, ip });
      return publicRestoreRecord(queryOne(db, "SELECT * FROM lc_restore_records WHERE id = ?", [row.id]));
    }
  }

  const archive = queryOne(db, "SELECT * FROM lc_archive_records WHERE id = ?", [row.archive_id]);
  if (!archive) {
    run(db, "UPDATE lc_restore_records SET status = 'failed', error = 'archive record missing', completed_at = ? WHERE id = ?", [nowIso(), row.id]);
    throw restoreFailed("Archive record is missing", { restore_ref: row.restore_ref });
  }

  publishLifecycleEvent(db, { eventType: "ObjectRestoreStarted", tenantId: tid, objectType: row.object_type, objectId: row.object_id, payload: { restore_ref: row.restore_ref } }, actor);

  // Integrity verification before touching the ledger.
  const provider = getArchiveProvider(archive.provider_code);
  let verifiedChecksum = null;
  try {
    const content = await provider.retrieve(db, { storageUri: archive.storage_uri });
    if (content !== null && content !== undefined) {
      verifiedChecksum = createHash("sha256").update(content).digest("hex");
      if (verifiedChecksum !== archive.checksum && !force) {
        run(db, "UPDATE lc_restore_records SET status = 'failed', error = 'integrity check failed', completed_at = ? WHERE id = ?", [nowIso(), row.id]);
        throw restoreFailed("Archive integrity check failed", { restore_ref: row.restore_ref, expected: archive.checksum, actual: verifiedChecksum });
      }
    }
  } catch (error) {
    if (error.code === "DATA_LIFECYCLE_RESTORE_FAILED") throw error;
    run(db, "UPDATE lc_restore_records SET status = 'failed', error = ?, completed_at = ? WHERE id = ?", [error.message, nowIso(), row.id]);
    throw restoreFailed(`Restore failed: ${error.message}`, { restore_ref: row.restore_ref });
  }

  run(db, "UPDATE lc_restore_records SET status = 'running' WHERE id = ?", [row.id]);
  try {
    changeState(db, tid, row.object_type, row.object_id, row.target_state, { reason: `restored from ${archive.archive_ref}`, actor, ip, force: true });
    run(db, "UPDATE lc_archive_records SET status = 'restored', updated_at = ? WHERE id = ?", [nowIso(), archive.id]);
  } catch (error) {
    run(db, "UPDATE lc_restore_records SET status = 'failed', error = ?, completed_at = ? WHERE id = ?", [error.message, nowIso(), row.id]);
    throw restoreFailed(`Restore failed: ${error.message}`, { restore_ref: row.restore_ref });
  }

  const ts = nowIso();
  run(db, "UPDATE lc_restore_records SET status = 'completed', completed_at = ? WHERE id = ?", [ts, row.id]);
  writeAudit(db, {
    actor,
    action: "data_lifecycle.restore.complete",
    resourceType: "lc_restore_records",
    resourceId: row.restore_ref,
    details: { target_state: row.target_state, archive_ref: archive.archive_ref },
    ip,
  });
  recordHistory(db, {
    tenantId: tid,
    objectType: row.object_type,
    objectId: row.object_id,
    objectRef: row.object_ref,
    action: "RESTORE",
    toState: row.target_state,
    reason: `restored from ${archive.archive_ref}`,
    details: { restore_ref: row.restore_ref, archive_ref: archive.archive_ref },
    actor,
  });
  publishLifecycleEvent(
    db,
    { eventType: "ObjectRestored", tenantId: tid, objectType: row.object_type, objectId: row.object_id, payload: { restore_ref: row.restore_ref, target_state: row.target_state } },
    actor
  );
  notifyLifecycleEvent(db, { eventType: "ObjectRestored", tenantId: tid, objectType: row.object_type, objectId: row.object_id, objectName: row.object_ref, payload: { target_state: row.target_state }, actor });
  return publicRestoreRecord(queryOne(db, "SELECT * FROM lc_restore_records WHERE id = ?", [row.id]));
}

// Convenience: request + execute in one call for synchronous API use.
export async function restoreObject(db, options = {}) {
  const { row } = requestRestore(db, options);
  return executeRestore(db, { tenantId: options.tenantId, restoreRef: row.restore_ref, actor: options.actor, ip: options.ip, force: options.force });
}
