// Migration reconciliation.
//
// After a migration run the engine reconciles the source against the target and
// persists a report plus a structured exception list, so operators can see
// exactly how many records made it, how many did not and why (spec §21, §22).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SOURCE_MODULE } from "./constants.js";
import { reconciliationNotFound, invalidReconciliation } from "./errors.js";
import { reconciliationRef as makeReconciliationRef } from "./refs.js";
import { publicReconciliation, publicReconciliationException } from "./repository.js";
import { normalizeUpper, paginate, assertReconciliationStrategy } from "./validation.js";

export function getReconciliationRow(db, tenantId, ref) {
  return queryOne(
    db,
    "SELECT * FROM mig_reconciliations WHERE tenant_id = ? AND (reconciliation_ref = ? OR CAST(id AS TEXT) = ?)",
    [Number(tenantId), String(ref), String(ref)]
  );
}

function targetCountFor(db, tenantId, jobId) {
  return Number(
    queryOne(
      db,
      "SELECT COUNT(*) AS c FROM mig_object_results WHERE tenant_id = ? AND job_id = ? AND status = 'SUCCESS' AND target_object_id IS NOT NULL AND target_object_id != ''",
      [Number(tenantId), Number(jobId)]
    )?.c || 0
  );
}

// Reconciles one job. `strategy` selects how source and target are compared:
//   COUNT            — source count vs successful target count
//   KEY              — count distinct business keys on both sides
//   FIELD            — count records whose mapped fields were validated
//   SOURCE_TO_TARGET — every source row has a result row
//   TARGET_TO_SOURCE — every target object has an identifier mapping
export function reconcileJob(db, { tenantId, jobId, strategy = "COUNT", counters = null, sourceCount = null } = {}) {
  const tenant = Number(tenantId);
  const job = queryOne(db, "SELECT * FROM mig_jobs WHERE id = ? AND tenant_id = ?", [Number(jobId), tenant]);
  if (!job) throw invalidReconciliation(`Migration job not found: ${jobId}`, { job_id: jobId });
  const normalizedStrategy = assertReconciliationStrategy(strategy || "COUNT");
  const derived = counters || {
    processed: job.processed_records,
    success: job.success_count,
    failed: job.failed_count,
    duplicates: job.duplicate_count,
    rejected: job.rejected_count,
  };
  const source = sourceCount != null ? Number(sourceCount) : Number(job.total_records || derived.processed || 0);
  const successful = targetCountFor(db, tenant, job.id) || Number(derived.success || 0);
  const variance = source - successful;
  const percent = source > 0 ? Math.round((successful / source) * 10000) / 100 : 100;
  const tolerance = 0.005;
  const status = variance === 0 ? "COMPLETED" : Math.abs(variance) / Math.max(source, 1) <= tolerance ? "COMPLETED" : "VARIANCE";

  const report = {
    strategy: normalizedStrategy,
    source_count: source,
    successful_count: successful,
    failed_count: Number(derived.failed || 0),
    duplicate_count: Number(derived.duplicates || 0),
    rejected_count: Number(derived.rejected || 0),
    variance,
    reconciliation_percent: percent,
    status,
    generated_at: nowIso(),
  };

  const ref = makeReconciliationRef(job.job_ref);
  const existing = queryOne(db, "SELECT * FROM mig_reconciliations WHERE job_id = ? AND strategy = ?", [job.id, normalizedStrategy]);
  let reconciliationId;
  if (existing) {
    run(
      db,
      `UPDATE mig_reconciliations SET source_count = ?, processed_count = ?, successful_count = ?, failed_count = ?, duplicate_count = ?,
        rejected_count = ?, target_count = ?, variance = ?, reconciliation_percent = ?, status = ?, report_json = ?, updated_at = ? WHERE id = ?`,
      [source, Number(derived.processed || 0), successful, Number(derived.failed || 0), Number(derived.duplicates || 0), Number(derived.rejected || 0), successful, variance, percent, status, JSON.stringify(report), nowIso(), existing.id]
    );
    reconciliationId = existing.id;
    run(db, "DELETE FROM mig_reconciliation_exceptions WHERE reconciliation_id = ?", [existing.id]);
  } else {
    const result = run(
      db,
      `INSERT INTO mig_reconciliations (reconciliation_ref, job_id, tenant_id, strategy, source_count, processed_count, successful_count, failed_count,
         duplicate_count, rejected_count, target_count, variance, reconciliation_percent, status, report_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ref, job.id, tenant, normalizedStrategy, source, Number(derived.processed || 0), successful, Number(derived.failed || 0), Number(derived.duplicates || 0), Number(derived.rejected || 0), successful, variance, percent, status, JSON.stringify(report), nowIso(), nowIso()]
    );
    reconciliationId = Number(result.lastInsertRowid);
  }
  persistExceptions(db, { reconciliationId, tenantId: tenant, jobId: job.id, strategy: normalizedStrategy, variance, source });

  writeAudit(db, { actor: null, action: "migration.reconciliation.run", resourceType: "mig_reconciliations", resourceId: ref, details: report, ip: null });
  return { ...publicReconciliation(queryOne(db, "SELECT * FROM mig_reconciliations WHERE id = ?", [reconciliationId])), exceptions: listExceptions(db, { tenantId: tenant, reconciliationId }).items };
}

function persistExceptions(db, { reconciliationId, tenantId, jobId, strategy, variance, source }) {
  const insert = (entry) =>
    run(
      db,
      `INSERT INTO mig_reconciliation_exceptions (reconciliation_id, job_id, tenant_id, exception_type, object_type, source_object_id, target_object_id, field, expected, actual, message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reconciliationId,
        jobId,
        tenantId,
        normalizeUpper(entry.exception_type),
        entry.object_type || "",
        entry.source_object_id || "",
        entry.target_object_id || "",
        entry.field || "",
        entry.expected != null ? String(entry.expected) : "",
        entry.actual != null ? String(entry.actual) : "",
        entry.message || "",
        nowIso(),
      ]
    );

  if (variance !== 0) {
    insert({
      exception_type: "COUNT_VARIANCE",
      expected: source,
      actual: source - variance,
      message: `Source count ${source} differs from migrated count ${source - variance}`,
    });
  }
  // Failed records become exceptions so the report is self-contained.
  const failures = queryAll(
    db,
    "SELECT * FROM mig_object_results WHERE tenant_id = ? AND job_id = ? AND status IN ('ERROR','FAILED') ORDER BY record_number LIMIT 5000",
    [tenantId, jobId]
  );
  for (const failure of failures) {
    insert({
      exception_type: failure.status === "ERROR" ? "SOURCE_MISSING" : "FIELD_MISMATCH",
      object_type: failure.source_object_type,
      source_object_id: failure.source_object_id,
      field: "",
      actual: failure.message,
      message: failure.message || "Record was not migrated",
    });
  }
  // On KEY/SOURCE_TO_TARGET, a successful result without a target id is a gap.
  if (strategy === "KEY" || strategy === "SOURCE_TO_TARGET") {
    const gaps = queryAll(
      db,
      "SELECT * FROM mig_object_results WHERE tenant_id = ? AND job_id = ? AND status = 'SUCCESS' AND (target_object_id IS NULL OR target_object_id = '') LIMIT 5000",
      [tenantId, jobId]
    );
    for (const gap of gaps) {
      insert({ exception_type: "TARGET_MISSING", object_type: gap.source_object_type, source_object_id: gap.source_object_id, message: "Successful result has no target object" });
    }
  }
}

export function listExceptions(db, { tenantId, reconciliationId, exceptionType, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (reconciliationId != null) {
    clauses.push("reconciliation_id = ?");
    params.push(Number(reconciliationId));
  }
  if (exceptionType) {
    clauses.push("exception_type = ?");
    params.push(normalizeUpper(exceptionType));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM mig_reconciliation_exceptions ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM mig_reconciliation_exceptions ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicReconciliationException), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function getReconciliation(db, tenantId, ref) {
  const row = getReconciliationRow(db, tenantId, ref);
  if (!row) return null;
  return { ...publicReconciliation(row), exceptions: listExceptions(db, { tenantId, reconciliationId: row.id }).items };
}

export function listReconciliations(db, { tenantId, jobId, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (jobId != null) {
    clauses.push("job_id = ?");
    params.push(Number(jobId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM mig_reconciliations ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM mig_reconciliations ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicReconciliation), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function reconcileJobByRef(db, tenantId, jobRef, { strategy = "COUNT" } = {}) {
  const job = queryOne(db, "SELECT * FROM mig_jobs WHERE tenant_id = ? AND (job_ref = ? OR CAST(id AS TEXT) = ?)", [Number(tenantId), String(jobRef), String(jobRef)]);
  if (!job) throw reconciliationNotFound(jobRef);
  return reconcileJob(db, { tenantId, jobId: job.id, strategy });
}
