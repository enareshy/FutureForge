// Recovery framework.
//
// Recovery is deliberately separate from restore. Restore returns an archived
// object to active storage. Recovery is what you reach for after a failure,
// corruption or storage loss, using a provider recovery point. This module
// provides the framework and a basic workflow: when a provider exposes recovery
// points it uses them; otherwise it can rebuild an object from its archive
// package. Infrastructure-level disaster recovery remains out of scope.
import { createHash } from "node:crypto";
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SOURCE_MODULE } from "./constants.js";
import { recoveryRef } from "./refs.js";
import { publicRecoveryRecord } from "./repository.js";
import { invalidRecovery, recoveryFailed, recoveryNotFound } from "./errors.js";
import { assertTenantId, normalizeText, paginate } from "./validation.js";
import { getArchiveProvider, resolveProviderCode } from "./providers.js";
import { getLatestArchiveRow } from "./archive.js";
import { requireObjectLifecycle, changeState } from "./objects.js";
import { recordHistory } from "./history.js";
import { publishLifecycleEvent } from "./events.js";
import { notifyLifecycleEvent } from "./notifications.js";

export { publicRecoveryRecord };

export function getRecoveryRow(db, tenantId, ref) {
  return queryOne(db, "SELECT * FROM lc_recovery_records WHERE tenant_id = ? AND (recovery_ref = ? OR CAST(id AS TEXT) = ?)", [
    Number(tenantId),
    String(ref),
    String(ref),
  ]);
}

export function requireRecovery(db, tenantId, ref) {
  const row = getRecoveryRow(db, tenantId, ref);
  if (!row) throw recoveryNotFound(ref);
  return row;
}

export function getRecoveryRecord(db, tenantId, ref) {
  return publicRecoveryRecord(requireRecovery(db, tenantId, ref));
}

export function listRecoveryRecords(db, { tenantId, status, scope, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeText(status).toLowerCase());
  }
  if (scope) {
    clauses.push("scope = ?");
    params.push(normalizeText(scope, { max: 200 }));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM lc_recovery_records ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM lc_recovery_records ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicRecoveryRecord), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function requestRecovery(db, { tenantId, providerCode = null, recoveryPointRef = "", scope = "", objectType = "", objectId = null, details = {}, actor = null, ip = null } = {}) {
  const tid = assertTenantId(tenantId);
  if (!scope && !objectId) throw invalidRecovery("A recovery scope or object is required");
  const provider = normalizeText(providerCode) || resolveProviderCode(db, tid);
  getArchiveProvider(provider); // fail fast when the provider is unknown
  const ref = recoveryRef(scope || `${objectType}:${objectId}`);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO lc_recovery_records (recovery_ref, tenant_id, provider_code, recovery_point_ref, scope, object_type, object_id, status, details_json, requested_by, requested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?)`,
    [ref, tid, provider, normalizeText(recoveryPointRef, { max: 200 }), normalizeText(scope, { max: 200 }), normalizeText(objectType, { max: 120 }), objectId != null ? String(objectId) : null, JSON.stringify(details || {}), actor?.id ?? null, ts]
  );
  const row = queryOne(db, "SELECT * FROM lc_recovery_records WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, { actor, action: "data_lifecycle.recovery.request", resourceType: "lc_recovery_records", resourceId: ref, details: { provider, scope: row.scope }, ip });
  return publicRecoveryRecord(row);
}

export async function executeRecovery(db, { tenantId, recoveryRef: ref, actor = null, ip = null } = {}) {
  const tid = assertTenantId(tenantId);
  const row = requireRecovery(db, tid, ref);
  if (row.status === "completed") return publicRecoveryRecord(row);
  const provider = getArchiveProvider(row.provider_code);
  run(db, "UPDATE lc_recovery_records SET status = 'running' WHERE id = ?", [row.id]);

  const details = row.details_json ? JSON.parse(row.details_json) : {};
  try {
    if (typeof provider.recover === "function") {
      const outcome = await provider.recover(db, {
        tenantId: tid,
        recoveryPointRef: row.recovery_point_ref,
        scope: row.scope,
        objectType: row.object_type,
        objectId: row.object_id,
      });
      details.provider_outcome = outcome || {};
    } else if (row.object_type && row.object_id) {
      const archive = getLatestArchiveRow(db, { tenantId: tid, objectType: row.object_type, objectId: row.object_id });
      if (!archive) throw new Error("no archive package available to recover from");
      const content = await provider.retrieve(db, { storageUri: archive.storage_uri });
      if (content === null || content === undefined) throw new Error("archive payload not found");
      const actual = createHash("sha256").update(content).digest("hex");
      if (actual !== archive.checksum) throw new Error("archive package failed integrity validation");
      const ledger = requireObjectLifecycle(db, tid, row.object_type, row.object_id);
      changeState(db, tid, row.object_type, row.object_id, details.target_state || "INACTIVE", {
        reason: `recovered from ${archive.archive_ref}`,
        actor,
        ip,
        force: true,
      });
      details.recovered_from_archive = archive.archive_ref;
      details.previous_state = ledger.current_state;
    } else {
      details.framework_only = true;
      details.instruction = "The configured provider does not expose recovery points; recover handled at the infrastructure layer.";
    }
  } catch (error) {
    run(db, "UPDATE lc_recovery_records SET status = 'failed', error = ?, details_json = ?, completed_at = ? WHERE id = ?", [
      error.message,
      JSON.stringify(details),
      nowIso(),
      row.id,
    ]);
    publishLifecycleEvent(db, { eventType: "LifecycleOperationFailed", tenantId: tid, objectType: row.object_type || "recovery", objectId: row.object_id, payload: { operation: "RECOVERY", error: error.message } }, actor);
    throw recoveryFailed(`Recovery failed: ${error.message}`, { recovery_ref: row.recovery_ref });
  }

  const ts = nowIso();
  run(db, "UPDATE lc_recovery_records SET status = 'completed', details_json = ?, completed_at = ? WHERE id = ?", [JSON.stringify(details), ts, row.id]);
  writeAudit(db, { actor, action: "data_lifecycle.recovery.complete", resourceType: "lc_recovery_records", resourceId: row.recovery_ref, details, ip });
  if (row.object_type && row.object_id) {
    recordHistory(db, {
      tenantId: tid,
      objectType: row.object_type,
      objectId: row.object_id,
      action: "RECOVERY",
      reason: "recovered",
      details,
      actor,
    });
    notifyLifecycleEvent(db, { eventType: "ObjectLifecycleChanged", tenantId: tid, objectType: row.object_type, objectId: row.object_id, payload: { operation: "RECOVERY" }, actor });
  }
  return publicRecoveryRecord(queryOne(db, "SELECT * FROM lc_recovery_records WHERE id = ?", [row.id]));
}

export async function recoverObject(db, options = {}) {
  const record = requestRecovery(db, options);
  return executeRecovery(db, { tenantId: options.tenantId, recoveryRef: record.recovery_ref, actor: options.actor, ip: options.ip });
}
