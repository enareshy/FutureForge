// Background jobs for the Standards & Exchange domain.
//
// Import, export, validation, reconciliation and maintenance all run on the
// shared Job Scheduling & Execution Engine so they are durable, resumable,
// observable and retryable. Handlers only drive the exchange processor; the
// exchange_jobs table is a domain ledger linking a platform job to the
// exchange transaction it produced.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { submitJob } from "../jobs/jobs.js";
import { getJobTypeRow, createJobType } from "../jobs/types.js";
import { EXCHANGE_HANDLER_CODES, EXCHANGE_JOB_TYPES } from "./constants.js";
import { jobRef as makeJobRef } from "./identifiers.js";
import { publicJob, publicJobResult } from "./repository.js";
import { execute } from "./processor.js";
import { reconcileTransaction } from "./reconciliation.js";
import { getConfig } from "./configuration.js";

const EXCHANGE_QUEUE = "exchange";

export function ensureExchangeJobTypes(db) {
  let created = 0;
  for (const def of EXCHANGE_JOB_TYPES) {
    if (getJobTypeRow(db, def.code)) continue;
    createJobType(db, { ...def }, null, null);
    created += 1;
  }
  return { created };
}

function recordJob(db, { tenantId, handlerCode, platformJob, transactionRef = "" }) {
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO exchange_jobs (job_ref, tenant_id, transaction_ref, handler_code, platform_job_id, status, attempts, max_attempts, progress_json, queued_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'QUEUED', 0, 1, '{}', ?, ?, ?)`,
    [makeJobRef(), Number(tenantId), String(transactionRef || ""), handlerCode, platformJob?.id ?? null, ts, ts, ts]
  );
  return Number(result.lastInsertRowid);
}

function updateJob(db, exchangeJobId, patch = {}) {
  const columns = [];
  const values = [];
  for (const [key, value] of Object.entries(patch)) {
    columns.push(`${key} = ?`);
    values.push(value);
  }
  if (!columns.length) return;
  columns.push("updated_at = ?");
  values.push(nowIso());
  values.push(exchangeJobId);
  run(db, `UPDATE exchange_jobs SET ${columns.join(", ")} WHERE id = ?`, values);
}

function submit(db, { tenantId, jobTypeCode, handlerCode, handlerParams, actor, ip, priority = "normal", queue = EXCHANGE_QUEUE, idempotencyKey = null }) {
  const platformJob = submitJob(
    db,
    {
      job_type_code: jobTypeCode,
      input: { tenant_id: Number(tenantId), ...handlerParams },
      tenant_id: Number(tenantId),
      priority,
      queue,
      idempotency_key: idempotencyKey || undefined,
    },
    { actor, ip }
  );
  const exchangeJobId = recordJob(db, { tenantId, handlerCode, platformJob });
  return { ...platformJob, exchange_job: publicJob(queryOne(db, "SELECT * FROM exchange_jobs WHERE id = ?", [exchangeJobId])) };
}

export function submitImportJob(db, { tenantId, body = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "EXCHANGE_IMPORT", handlerCode: EXCHANGE_HANDLER_CODES.IMPORT, handlerParams: { body }, actor, ip, idempotencyKey });
}

export function submitExportJob(db, { tenantId, body = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "EXCHANGE_EXPORT", handlerCode: EXCHANGE_HANDLER_CODES.EXPORT, handlerParams: { body }, actor, ip, idempotencyKey });
}

export function submitValidateJob(db, { tenantId, body = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "EXCHANGE_VALIDATE", handlerCode: EXCHANGE_HANDLER_CODES.VALIDATE, handlerParams: { body }, actor, ip, idempotencyKey });
}

export function submitReconcileJob(db, { tenantId, transactionRef, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "EXCHANGE_RECONCILE", handlerCode: EXCHANGE_HANDLER_CODES.RECONCILE, handlerParams: { transaction_ref: transactionRef }, actor, ip, priority: "low", idempotencyKey });
}

export function submitMaintenanceJob(db, { tenantId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "EXCHANGE_MAINTENANCE", handlerCode: EXCHANGE_HANDLER_CODES.MAINTENANCE, handlerParams: {}, actor, ip, priority: "low", queue: "default", idempotencyKey });
}

export function listExchangeJobs(db, tenantId, query = {}) {
  const page = Math.max(1, Number(query.page || 1));
  const pageSize = Math.min(200, Math.max(1, Number(query.page_size || query.pageSize || 50)));
  const offset = (page - 1) * pageSize;
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    clauses.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.transaction_ref || query.transactionRef) {
    clauses.push("transaction_ref = ?");
    params.push(String(query.transaction_ref || query.transactionRef));
  }
  const where = clauses.join(" AND ");
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM exchange_jobs WHERE ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM exchange_jobs WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  return { items: rows.map(publicJob), total, page, pageSize };
}

export function getExchangeJob(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM exchange_jobs WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM exchange_jobs WHERE tenant_id = ? AND job_ref = ?", [Number(tenantId), raw]);
  if (!row) return null;
  const output = publicJob(row);
  output.results = queryAll(db, "SELECT * FROM exchange_job_results WHERE job_id = ? ORDER BY id DESC", [row.id]).map(publicJobResult);
  return output;
}

// ── Synchronous cores (also used by handlers) ────────────────────────────────
export function runExchangeMaintenance(db, { tenantId = null } = {}) {
  const tenants = tenantId
    ? [{ tenant_id: Number(tenantId) }]
    : queryAll(db, "SELECT DISTINCT tenant_id FROM exchange_history WHERE tenant_id IS NOT NULL");
  const summary = { tenants: tenants.length, history_pruned: 0, errors_pruned: 0, reconciliations_pruned: 0, ran_at: nowIso() };
  for (const row of tenants) {
    const tenant = Number(row.tenant_id);
    const retentionDays = Number(getConfig(db, tenant, "history_retention_days") || 180);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    summary.history_pruned += run(db, "DELETE FROM exchange_history WHERE tenant_id = ? AND created_at < ?", [tenant, cutoff]).changes || 0;
    summary.errors_pruned += run(db, "DELETE FROM exchange_errors WHERE tenant_id = ? AND status IN ('RESOLVED','IGNORED') AND created_at < ?", [tenant, cutoff]).changes || 0;
    summary.reconciliations_pruned += run(db, "DELETE FROM exchange_reconciliations WHERE tenant_id = ? AND created_at < ?", [tenant, cutoff]).changes || 0;
  }
  return summary;
}

// ── Handler registration ─────────────────────────────────────────────────────
function runHandlerBody(context, direction, operation) {
  const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
  const body = context.input.body || {};
  return execute(context.db, tenantId, { ...body, direction, operation, options: body.options || {} }, context.actor, { ip: context.ip });
}

export function registerExchangeHandlers() {
  registerHandler(
    EXCHANGE_HANDLER_CODES.IMPORT,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("importing", { progress: 10 });
      const transaction = runHandlerBody(context, "IMPORT", context.input.body?.operation || "EXECUTE");
      const ledger = queryOne(context.db, "SELECT id FROM exchange_jobs WHERE platform_job_id = ?", [context.job?.id ?? -1]);
      if (ledger) {
        run(context.db, "UPDATE exchange_jobs SET transaction_ref = ?, status = ?, finished_at = ?, updated_at = ? WHERE id = ?", [
          transaction.transaction_ref,
          transaction.status,
          nowIso(),
          nowIso(),
          ledger.id,
        ]);
      }
      context.reportProgress({ progress: 100, message: "Import complete" }, { force: true });
      return { message: "Standards exchange import complete", result: { transaction_ref: transaction.transaction_ref, status: transaction.status, counts: transaction.counts } };
    },
    { description: "Execute or dry-run a standards exchange import" }
  );

  registerHandler(
    EXCHANGE_HANDLER_CODES.EXPORT,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("exporting", { progress: 10 });
      const transaction = runHandlerBody(context, "EXPORT", context.input.body?.operation || "EXPORT");
      const ledger = queryOne(context.db, "SELECT id FROM exchange_jobs WHERE platform_job_id = ?", [context.job?.id ?? -1]);
      if (ledger) {
        run(context.db, "UPDATE exchange_jobs SET transaction_ref = ?, status = ?, finished_at = ?, updated_at = ? WHERE id = ?", [
          transaction.transaction_ref,
          transaction.status,
          nowIso(),
          nowIso(),
          ledger.id,
        ]);
      }
      context.reportProgress({ progress: 100, message: "Export complete" }, { force: true });
      return { message: "Standards exchange export complete", result: { transaction_ref: transaction.transaction_ref, status: transaction.status, size: transaction.output?.size ?? 0 } };
    },
    { description: "Execute a standards exchange export" }
  );

  registerHandler(
    EXCHANGE_HANDLER_CODES.VALIDATE,
    async (context) => {
      context.step("validating", { progress: 10 });
      const transaction = runHandlerBody(context, context.input.body?.direction || "IMPORT", "VALIDATE_ONLY");
      context.reportProgress({ progress: 100, message: "Validation complete" }, { force: true });
      return { message: "Standards exchange validation complete", result: { transaction_ref: transaction.transaction_ref, status: transaction.status, validation: transaction.validation_summary } };
    },
    { description: "Validate a standards exchange payload" }
  );

  registerHandler(
    EXCHANGE_HANDLER_CODES.RECONCILE,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("reconciling", { progress: 10 });
      const result = reconcileTransaction(context.db, tenantId, context.input.transaction_ref, { actor: context.actor, ip: context.ip });
      context.reportProgress({ progress: 100, message: "Reconciliation complete" }, { force: true });
      return { message: "Standards exchange reconciliation complete", result: { transaction_ref: result.transaction_ref, counts: result.counts } };
    },
    { description: "Reconcile an exchange transaction against the enterprise model" }
  );

  registerHandler(
    EXCHANGE_HANDLER_CODES.MAINTENANCE,
    async (context) => {
      const tenantId = context.input.tenant_id ? Number(context.input.tenant_id) : null;
      context.step("maintenance", { progress: 10 });
      const result = runExchangeMaintenance(context.db, { tenantId });
      context.reportProgress({ progress: 100, message: "Maintenance complete" }, { force: true });
      return { message: "Standards exchange maintenance complete", result };
    },
    { description: "Prune exchange history, resolved errors and old reconciliations" }
  );

  return Object.values(EXCHANGE_HANDLER_CODES);
}
