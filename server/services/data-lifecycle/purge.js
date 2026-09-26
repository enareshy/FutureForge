// Purge: permanent removal of business data.
//
// Purge is the most restricted lifecycle operation. It requires an explainable
// eligibility verdict (retention elapsed, no legal hold, no blocking dependency,
// policy permits it), removes the archive payloads, records the eligibility
// snapshot that authorized the deletion and only then moves the ledger to
// PURGED. A denied purge never deletes anything.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SOURCE_MODULE } from "./constants.js";
import { purgeRef } from "./refs.js";
import { publicPurgeRecord } from "./repository.js";
import { invalidPurge, purgeDenied, purgeFailed, purgeNotFound } from "./errors.js";
import { assertTenantId, normalizeText, paginate } from "./validation.js";
import { requireObjectLifecycle, changeState } from "./objects.js";
import { evaluatePurge } from "./eligibility.js";
import { getArchiveProvider } from "./providers.js";
import { listConfig } from "./configuration.js";
import { recordHistory } from "./history.js";
import { publishLifecycleEvent } from "./events.js";
import { notifyLifecycleEvent, notifyPurgeBlocked } from "./notifications.js";

export { publicPurgeRecord };

export function getPurgeRow(db, tenantId, ref) {
  return queryOne(db, "SELECT * FROM lc_purge_records WHERE tenant_id = ? AND (purge_ref = ? OR CAST(id AS TEXT) = ?)", [
    Number(tenantId),
    String(ref),
    String(ref),
  ]);
}

export function requirePurge(db, tenantId, ref) {
  const row = getPurgeRow(db, tenantId, ref);
  if (!row) throw purgeNotFound(ref);
  return row;
}

export function getPurgeRecord(db, tenantId, ref) {
  return publicPurgeRecord(requirePurge(db, tenantId, ref));
}

export function listPurgeRecords(db, { tenantId, objectType, objectId, status, page, pageSize } = {}) {
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
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM lc_purge_records ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM lc_purge_records ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicPurgeRecord), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function evaluatePurgeEligibility(db, { tenantId, objectType, objectId, force = false }) {
  return evaluatePurge(db, { tenantId, objectType, objectId, force });
}

export async function executePurge(db, { tenantId, objectType, objectId, reason = "", actor = null, ip = null, idempotencyKey = "", force = false } = {}) {
  const tid = assertTenantId(tenantId);
  if (idempotencyKey) {
    const existing = queryOne(db, "SELECT * FROM lc_purge_records WHERE tenant_id = ? AND idempotency_key = ?", [tid, String(idempotencyKey)]);
    if (existing) return publicPurgeRecord(existing);
  }
  const row = requireObjectLifecycle(db, tid, objectType, objectId);
  const config = listConfig(db, tid);
  const eligibility = evaluatePurge(db, { tenantId: tid, objectType, objectId, force });
  const archives = queryAll(db, "SELECT * FROM lc_archive_records WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND status IN ('stored', 'restored')", [
    tid,
    normalizeText(objectType, { max: 120 }),
    String(objectId),
  ]);

  const denials = [];
  if (eligibility.blocked && !force) denials.push(...eligibility.reasons.filter((r) => r.severity === "BLOCKED"));
  if (config.purge_requires_archive && !archives.length && !force) {
    denials.push({ code: "ARCHIVE_REQUIRED", severity: "BLOCKED", message: "Purge requires an archive record; none exists" });
  }

  const ts = nowIso();
  if (denials.length) {
    run(
      db,
      `INSERT INTO lc_purge_records (purge_ref, tenant_id, object_type, object_id, object_ref, reason, eligibility_json, status, idempotency_key, executed_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'denied', ?, ?, ?, ?)`,
      [
        purgeRef(objectType, objectId),
        tid,
        row.object_type,
        String(row.object_id),
        row.object_ref || "",
        normalizeText(reason),
        JSON.stringify({ ...eligibility, denials }),
        String(idempotencyKey || ""),
        actor?.id ?? null,
        ts,
        ts,
      ]
    );
    writeAudit(db, {
      actor,
      action: "data_lifecycle.purge.denied",
      resourceType: "lc_purge_records",
      resourceId: `${objectType}:${objectId}`,
      details: { denials: denials.map((d) => d.code) },
      ip,
    });
    notifyPurgeBlocked(db, { tenantId: tid, objectType, objectId, objectName: row.object_ref, reasons: denials.map((d) => d.code), actor });
    throw purgeDenied({ reasons: denials, eligibility });
  }

  publishLifecycleEvent(db, { eventType: "ObjectPurgeStarted", tenantId: tid, objectType, objectId, payload: { archives: archives.length } }, actor);

  let removed = 0;
  try {
    for (const archive of archives) {
      const provider = getArchiveProvider(archive.provider_code);
      await provider.remove(db, { storageUri: archive.storage_uri });
      run(db, "UPDATE lc_archive_records SET status = 'purged', updated_at = ? WHERE id = ?", [nowIso(), archive.id]);
      removed += 1;
    }
  } catch (error) {
    writeAudit(db, { actor, action: "data_lifecycle.purge.failed", resourceType: "lc_purge_records", resourceId: `${objectType}:${objectId}`, details: { error: error.message }, ip });
    publishLifecycleEvent(db, { eventType: "LifecycleOperationFailed", tenantId: tid, objectType, objectId, payload: { operation: "PURGE", error: error.message } }, actor);
    throw purgeFailed(`Purge failed: ${error.message}`, { object_type: objectType, object_id: String(objectId) });
  }

  changeState(db, tid, objectType, objectId, "PURGED", { reason: reason || "purged", actor, ip, force: true, allowPurged: true });
  run(db, "UPDATE lc_object_lifecycle SET purged_at = ?, data_tier = 'COLD', updated_at = ? WHERE id = ?", [ts, ts, row.id]);

  const result = run(
    db,
    `INSERT INTO lc_purge_records (purge_ref, tenant_id, object_type, object_id, object_ref, policy_id, archive_id, reason, eligibility_json, status, idempotency_key, executed_by, executed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'executed', ?, ?, ?, ?, ?)`,
    [
      purgeRef(objectType, objectId),
      tid,
      row.object_type,
      String(row.object_id),
      row.object_ref || "",
      row.retention_policy_id,
      archives[0]?.id ?? null,
      normalizeText(reason),
      JSON.stringify(eligibility),
      String(idempotencyKey || ""),
      actor?.id ?? null,
      ts,
      ts,
      ts,
    ]
  );
  const purgeRow = queryOne(db, "SELECT * FROM lc_purge_records WHERE id = ?", [Number(result.lastInsertRowid)]);

  writeAudit(db, {
    actor,
    action: "data_lifecycle.purge.execute",
    resourceType: "lc_purge_records",
    resourceId: purgeRow.purge_ref,
    details: { object_type: row.object_type, object_id: String(row.object_id), archives_removed: removed },
    ip,
  });
  recordHistory(db, {
    tenantId: tid,
    objectType,
    objectId,
    objectRef: row.object_ref,
    action: "PURGE",
    fromState: row.current_state,
    toState: "PURGED",
    dataTier: "COLD",
    policyId: row.retention_policy_id,
    reason,
    details: { purge_ref: purgeRow.purge_ref, archives_removed: removed },
    actor,
  });
  publishLifecycleEvent(
    db,
    { eventType: "ObjectPurged", tenantId: tid, objectType, objectId, payload: { purge_ref: purgeRow.purge_ref, archives_removed: removed } },
    actor
  );
  notifyLifecycleEvent(db, { eventType: "ObjectPurged", tenantId: tid, objectType, objectId, objectName: row.object_ref, payload: { purge_ref: purgeRow.purge_ref }, actor });
  return publicPurgeRecord(purgeRow);
}

export function purgeSummary(db, { tenantId } = {}) {
  const count = (where) => Number(queryOne(db, `SELECT COUNT(*) AS c FROM lc_purge_records WHERE tenant_id = ? ${where}`, [Number(tenantId)])?.c || 0);
  return { total: count(""), executed: count("AND status = 'executed'"), denied: count("AND status = 'denied'"), failed: count("AND status = 'failed'") };
}
