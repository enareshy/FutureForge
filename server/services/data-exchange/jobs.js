// Background job handlers and maintenance for the Import & Export Framework.
//
// Import/export execution, validation, reconciliation, retry and maintenance run
// on the shared Job Scheduling & Execution Engine. The import/export job rows
// themselves act as the operational ledger, so a handler simply drives the
// engine core against an existing job.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { submitJob } from "../jobs/jobs.js";
import { EXCHANGE_HANDLER_CODES, SOURCE_MODULE } from "./constants.js";
import { publicImportJob, publicExportJob } from "./repository.js";
import { runImportJob, createImportJob, reconcileImport } from "./importer.js";
import { runExportJob, createExportJob, getExportJobRow } from "./exporter.js";
import { getImportJobRow } from "./importer.js";
import { getExportDefinitionRow } from "./export-definitions.js";
import { getImportDefinitionRow, withImportChildren } from "./import-definitions.js";
import { listConfig } from "./configuration.js";
import { paginate } from "./validation.js";

// ── Submission helpers ───────────────────────────────────────────────────────

function submit(db, { tenantId, jobTypeCode, handlerParams, actor, ip, priority = "normal", queue = "default", idempotencyKey = null }) {
  return submitJob(
    db,
    {
      job_type_code: jobTypeCode,
      payload: { tenant_id: Number(tenantId), ...handlerParams },
      tenant_id: Number(tenantId),
      priority,
      queue,
      idempotency_key: idempotencyKey || undefined,
    },
    { actor, ip }
  );
}

export function submitImportJob(db, { tenantId, importJobId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "DATA_IMPORT", handlerParams: { import_job_id: Number(importJobId) }, actor, ip, queue: "imports", idempotencyKey });
}

export function submitValidateJob(db, { tenantId, importJobId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "DATA_IMPORT_VALIDATE", handlerParams: { import_job_id: Number(importJobId) }, actor, ip, queue: "imports", idempotencyKey });
}

export function submitExportJob(db, { tenantId, exportJobId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "DATA_EXPORT", handlerParams: { export_job_id: Number(exportJobId) }, actor, ip, queue: "exports", idempotencyKey });
}

export function submitReconcileJob(db, { tenantId, importJobId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "DATA_RECONCILIATION", handlerParams: { import_job_id: Number(importJobId) }, actor, ip, idempotencyKey });
}

export function submitRetryJob(db, { tenantId, importJobId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "DATA_EXCHANGE_RETRY", handlerParams: { import_job_id: Number(importJobId) }, actor, ip, queue: "imports", priority: "high", idempotencyKey });
}

export function submitMaintenanceJob(db, { tenantId, actor = null, ip = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "DATA_EXCHANGE_MAINTENANCE", handlerParams: {}, actor, ip, priority: "low" });
}

// ── Ledger query helpers ─────────────────────────────────────────────────────

export function listExchangeJobs(db, { tenantId, direction, status, page, pageSize } = {}) {
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const dir = direction ? String(direction).toUpperCase() : null;
  const items = [];
  if (!dir || dir === "IMPORT") {
    const clauses = ["tenant_id = ?"];
    const params = [Number(tenantId)];
    if (status) {
      clauses.push("status = ?");
      params.push(String(status).toUpperCase());
    }
    const where = `WHERE ${clauses.join(" AND ")}`;
    const rows = queryAll(db, `SELECT * FROM ie_import_jobs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    items.push(...rows.map((row) => ({ ...publicImportJob(row), direction: "IMPORT" })));
  }
  if (!dir || dir === "EXPORT") {
    const clauses = ["tenant_id = ?"];
    const params = [Number(tenantId)];
    if (status) {
      clauses.push("status = ?");
      params.push(String(status).toUpperCase());
    }
    const where = `WHERE ${clauses.join(" AND ")}`;
    const rows = queryAll(db, `SELECT * FROM ie_export_jobs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    items.push(...rows.map((row) => ({ ...publicExportJob(row), direction: "EXPORT" })));
  }
  items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { items: items.slice(0, limit), total: items.length, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function getExchangeJob(db, tenantId, direction, ref) {
  if (String(direction).toUpperCase() === "IMPORT") {
    const row = getImportJobRow(db, tenantId, ref);
    return row ? { ...publicImportJob(row), direction: "IMPORT" } : null;
  }
  const row = getExportJobRow(db, tenantId, ref);
  return row ? { ...publicExportJob(row), direction: "EXPORT" } : null;
}

// ── Retry & reconcile runners ────────────────────────────────────────────────

export function failedRecordNumbers(db, tenantId, importJobId) {
  const rows = queryAll(
    db,
    "SELECT DISTINCT record_number FROM ie_import_record_results WHERE tenant_id = ? AND job_id = ? AND status IN ('ERROR', 'FAILED') ORDER BY record_number",
    [Number(tenantId), Number(importJobId)]
  );
  return rows.map((row) => Number(row.record_number)).filter((n) => n > 0);
}

export async function retryImportJob(db, { tenantId, importJobId, actor = null, ip = null } = {}) {
  const original = queryOne(db, "SELECT * FROM ie_import_jobs WHERE id = ? AND tenant_id = ?", [Number(importJobId), Number(tenantId)]);
  if (!original) return { retried: 0, message: "Import job not found" };
  const numbers = failedRecordNumbers(db, tenantId, importJobId);
  if (!numbers.length) return { retried: 0, message: "No failed records to retry" };
  const definitionRow = original.definition_id ? queryOne(db, "SELECT * FROM ie_import_definitions WHERE id = ?", [original.definition_id]) : null;
  const definition = definitionRow ? withImportChildren(db, definitionRow) : null;
  if (!definition) return { retried: 0, message: "The definition for this import job no longer exists" };
  const { job } = createImportJob(db, {
    tenantId,
    definition,
    mode: "IMPORT",
    params: { options: { retry_of: original.job_ref } },
    actor,
    ip,
  });
  const result = await runImportJob(db, { jobId: job.id, params: { record_numbers: numbers }, actor, ip });
  return { retried: numbers.length, job: result };
}

export function reconcileImportJob(db, { tenantId, importJobId } = {}) {
  const job = queryOne(db, "SELECT * FROM ie_import_jobs WHERE id = ? AND tenant_id = ?", [Number(importJobId), Number(tenantId)]);
  if (!job) return { status: "PENDING", message: "Import job not found" };
  const counters = {
    processed: job.processed_records || 0,
    success: job.success_count || 0,
    created: job.created_count || 0,
    updated: job.updated_count || 0,
    skipped: job.skipped_count || 0,
    rejected: job.rejected_count || 0,
    failed: job.failed_count || 0,
  };
  return reconcileImport(db, { tenantId, jobId: job.id, strategy: "COUNT", counters, sourceCount: job.total_records || counters.processed });
}

// ── Maintenance ──────────────────────────────────────────────────────────────

export function runExchangeMaintenance(db, { tenantId = null, limit = 2000 } = {}) {
  const tenantRows = tenantId
    ? [{ tenant_id: Number(tenantId) }]
    : queryAll(db, "SELECT DISTINCT tenant_id FROM ie_export_jobs WHERE tenant_id IS NOT NULL");
  const summary = { tenants: tenantRows.length, exports_expired: 0, blobs_pruned: 0, checkpoints_pruned: 0, ran_at: nowIso() };
  const cap = Number(limit) || 2000;
  for (const row of tenantRows) {
    const tenant = Number(row.tenant_id);
    const config = listConfig(db, tenant);
    const retentionDays = Number(config.export_expiry_days) || 30;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const expired = queryAll(
      db,
      "SELECT * FROM ie_export_results WHERE tenant_id = ? AND status = 'AVAILABLE' AND expires_at IS NOT NULL AND expires_at < ? LIMIT ?",
      [tenant, nowIso(), cap]
    );
    for (const result of expired) {
      run(db, "UPDATE ie_export_results SET status = 'EXPIRED' WHERE id = ?", [result.id]);
      summary.exports_expired += 1;
      summary.blobs_pruned += run(db, "DELETE FROM ie_blobs WHERE tenant_id = ? AND storage_uri = ?", [tenant, result.storage_uri]).changes || 0;
    }
    // Keep only the most recent checkpoints per import job.
    const jobs = queryAll(db, "SELECT id FROM ie_import_jobs WHERE tenant_id = ? ORDER BY id DESC LIMIT ?", [tenant, 500]);
    for (const job of jobs) {
      const rows = queryAll(db, "SELECT id FROM ie_import_checkpoints WHERE job_id = ? ORDER BY checkpoint_number DESC", [job.id]);
      for (const stale of rows.slice(50)) {
        run(db, "DELETE FROM ie_import_checkpoints WHERE id = ?", [stale.id]);
        summary.checkpoints_pruned += 1;
      }
    }
    void cutoff;
  }
  return summary;
}

// ── Handler registration ─────────────────────────────────────────────────────

export function registerExchangeHandlers() {
  registerHandler(
    EXCHANGE_HANDLER_CODES.IMPORT,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      const jobId = Number(context.input.import_job_id);
      context.step("importing", { progress: 10 });
      const job = await runImportJob(context.db, { jobId, params: context.input.params || {}, actor: context.actor, ip: context.ip });
      context.reportProgress({ progress: 100, message: "Import complete" }, { force: true });
      return { message: "Data import complete", job };
    },
    { description: "Execute an import definition" }
  );

  registerHandler(
    EXCHANGE_HANDLER_CODES.VALIDATE,
    async (context) => {
      const jobId = Number(context.input.import_job_id);
      context.step("validating", { progress: 10 });
      const job = await runImportJob(context.db, { jobId, params: { ...(context.input.params || {}), dry_run: true }, actor: context.actor, ip: context.ip });
      context.reportProgress({ progress: 100, message: "Validation complete" }, { force: true });
      return { message: "Import validation complete", job };
    },
    { description: "Validate an import source without writing" }
  );

  registerHandler(
    EXCHANGE_HANDLER_CODES.EXPORT,
    async (context) => {
      const jobId = Number(context.input.export_job_id);
      context.step("exporting", { progress: 10 });
      const job = await runExportJob(context.db, { jobId, params: context.input.params || {}, actor: context.actor, ip: context.ip });
      context.reportProgress({ progress: 100, message: "Export complete" }, { force: true });
      return { message: "Data export complete", job };
    },
    { description: "Execute an export definition" }
  );

  registerHandler(
    EXCHANGE_HANDLER_CODES.RECONCILE,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      const importJobId = Number(context.input.import_job_id);
      context.step("reconciling", { progress: 10 });
      const result = reconcileImportJob(context.db, { tenantId, importJobId });
      context.reportProgress({ progress: 100, message: "Reconciliation complete" }, { force: true });
      return { message: "Reconciliation complete", result };
    },
    { description: "Reconcile an import job result set" }
  );

  registerHandler(
    EXCHANGE_HANDLER_CODES.RETRY_FAILED,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      const importJobId = Number(context.input.import_job_id);
      context.step("retrying", { progress: 10 });
      const result = await retryImportJob(context.db, { tenantId, importJobId, actor: context.actor, ip: context.ip });
      context.reportProgress({ progress: 100, message: "Retry complete" }, { force: true });
      return { message: "Retry of failed records complete", result };
    },
    { description: "Retry retryable failed import records" }
  );

  registerHandler(
    EXCHANGE_HANDLER_CODES.MAINTENANCE,
    async (context) => {
      const tenantId = context.input.tenant_id ? Number(context.input.tenant_id) : null;
      context.step("maintenance", { progress: 10 });
      const result = runExchangeMaintenance(context.db, { tenantId });
      context.reportProgress({ progress: 100, message: "Maintenance complete" }, { force: true });
      return { message: "Data exchange maintenance complete", result };
    },
    { description: "Expire export artifacts and prune stale checkpoints" }
  );

  return Object.values(EXCHANGE_HANDLER_CODES);
}

export { getExportDefinitionRow, getImportDefinitionRow, createExportJob };
