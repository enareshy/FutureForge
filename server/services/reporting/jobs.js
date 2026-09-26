// Background jobs for Reporting & Analytics (§20).
//
// Long-running executions, exports, scheduled runs, KPI recalculation, read
// model refresh and maintenance all run on the shared Job Scheduling &
// Execution Engine so they are durable, resumable, observable and retryable.
// Handlers reconstruct the initiating subject so authorization is never
// silently dropped for an asynchronous run.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { submitJob } from "../jobs/jobs.js";
import { getJobTypeRow, createJobType } from "../jobs/types.js";
import { REPORTING_HANDLER_CODES, REPORTING_JOB_TYPES } from "./constants.js";
import { jobRef as makeJobRef } from "./identifiers.js";
import { parseJson, stringifyJson } from "./repository.js";
import { executeReport } from "./reports.js";
import { executeExport, pruneExports } from "./exports.js";
import { runSchedule, dueSchedules } from "./scheduling.js";
import { getKpiValue } from "./kpis.js";
import { refreshReadModel } from "./readmodel.js";
import { pruneHistory } from "./history.js";
import { invalidReport } from "./errors.js";

const REPORTING_QUEUE = "reporting";

export function publicReportingJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_ref: row.job_ref,
    tenant_id: row.tenant_id,
    handler_code: row.handler_code,
    job_type_code: row.job_type_code,
    entity_type: row.entity_type,
    entity_ref: row.entity_ref,
    platform_job_id: row.platform_job_id,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    progress: parseJson(row.progress_json, {}),
    result: parseJson(row.result_json, {}),
    error_message: row.error_message,
    queued_at: row.queued_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function ensureReportingJobTypes(db) {
  let created = 0;
  for (const def of REPORTING_JOB_TYPES) {
    if (getJobTypeRow(db, def.code)) continue;
    createJobType(db, { ...def }, null, null);
    created += 1;
  }
  return { created };
}

function recordJob(db, { tenantId, handlerCode, jobTypeCode, entityType = null, entityRef = null, platformJob, actor = null }) {
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reporting_jobs (job_ref, tenant_id, handler_code, job_type_code, entity_type, entity_ref, platform_job_id, status, attempts, max_attempts, progress_json, created_by, queued_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', 0, 1, '{}', ?, ?, ?, ?)`,
    [makeJobRef(), Number(tenantId), handlerCode, jobTypeCode, entityType, entityRef, platformJob?.id ?? null, actor?.id ?? null, ts, ts, ts]
  );
  return Number(result.lastInsertRowid);
}

function submit(db, { tenantId, jobTypeCode, handlerCode, handlerInput, entityType = null, entityRef = null, actor = null, ip = null, priority = "normal", queue = REPORTING_QUEUE, idempotencyKey = null }) {
  const platformJob = submitJob(
    db,
    {
      job_type_code: jobTypeCode,
      input: { tenant_id: Number(tenantId), actor_id: actor?.id ?? null, ...handlerInput },
      tenant_id: Number(tenantId),
      priority,
      queue,
      idempotency_key: idempotencyKey || undefined,
    },
    { actor, ip }
  );
  const jobId = recordJob(db, { tenantId, handlerCode, jobTypeCode, entityType, entityRef, platformJob, actor });
  return { ...platformJob, reporting_job: publicReportingJob(queryOne(db, "SELECT * FROM reporting_jobs WHERE id = ?", [jobId])) };
}

export function submitExecuteJob(db, { tenantId, reportRef, parameters = {}, actor = null, ip = null, idempotencyKey = null, entityRef = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "REPORTING_EXECUTE", handlerCode: REPORTING_HANDLER_CODES.EXECUTE, handlerInput: { report_ref: reportRef, parameters }, entityType: "report", entityRef: entityRef || reportRef, actor, ip, idempotencyKey });
}

export function submitExportJob(db, { tenantId, exportRef, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "REPORTING_EXPORT", handlerCode: REPORTING_HANDLER_CODES.EXPORT, handlerInput: { export_ref: exportRef }, entityType: "export", entityRef: exportRef, actor, ip, idempotencyKey });
}

export function submitScheduleRunJob(db, { tenantId, scheduleRef, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "REPORTING_SCHEDULE_RUN", handlerCode: REPORTING_HANDLER_CODES.SCHEDULE, handlerInput: { schedule_ref: scheduleRef }, entityType: "schedule", entityRef: scheduleRef, actor, ip, idempotencyKey });
}

export function submitKpiJob(db, { tenantId, kpiRef, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "REPORTING_KPI_CALCULATE", handlerCode: REPORTING_HANDLER_CODES.KPI, handlerInput: { kpi_ref: kpiRef }, entityType: "kpi", entityRef: kpiRef, actor, ip, priority: "low", idempotencyKey });
}

export function submitRefreshJob(db, { tenantId, entities = null, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "REPORTING_READMODEL_REFRESH", handlerCode: REPORTING_HANDLER_CODES.REFRESH, handlerInput: { entities }, entityType: "read_model", entityRef: "read_model", actor, ip, priority: "low", queue: "default", idempotencyKey });
}

export function submitMaintenanceJob(db, { tenantId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "REPORTING_MAINTENANCE", handlerCode: REPORTING_HANDLER_CODES.MAINTENANCE, handlerInput: {}, entityType: "maintenance", entityRef: "maintenance", actor, ip, priority: "low", queue: "default", idempotencyKey });
}

export function listReportingJobs(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.handler_code || query.handlerCode) {
    where.push("handler_code = ?");
    params.push(String(query.handler_code || query.handlerCode));
  }
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.page_size || query.pageSize) || 50));
  const clause = where.join(" AND ");
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM reporting_jobs WHERE ${clause}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM reporting_jobs WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { items: rows.map(publicReportingJob), total, page, pageSize };
}

export function getReportingJob(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM reporting_jobs WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM reporting_jobs WHERE tenant_id = ? AND job_ref = ?", [Number(tenantId), raw]);
  return publicReportingJob(row);
}

function markJob(db, platformJobId, patch = {}) {
  const ledger = queryOne(db, "SELECT id FROM reporting_jobs WHERE platform_job_id = ?", [Number(platformJobId ?? -1)]);
  if (!ledger) return;
  const columns = [];
  const values = [];
  for (const [key, value] of Object.entries(patch)) {
    columns.push(`${key} = ?`);
    values.push(value);
  }
  columns.push("updated_at = ?");
  values.push(nowIso());
  values.push(ledger.id);
  run(db, `UPDATE reporting_jobs SET ${columns.join(", ")} WHERE id = ?`, values);
}

export function runReportingMaintenance(db, { tenantId = null } = {}) {
  const tenants = tenantId
    ? [{ id: Number(tenantId) }]
    : queryAll(db, "SELECT id FROM organizations WHERE id IN (SELECT DISTINCT tenant_id FROM reporting_reports)");
  const summary = { tenants: tenants.length, history_pruned: 0, executions_pruned: 0, exports_pruned: 0, ran_at: nowIso() };
  for (const row of tenants) {
    const tenant = Number(row.id);
    const retention = 180;
    const pruned = pruneHistory(db, tenant, retention);
    summary.history_pruned += pruned.history;
    summary.executions_pruned += pruned.executions;
    summary.exports_pruned += pruneExports(db, tenant, 30).deleted;
  }
  return summary;
}

// ── Handlers ─────────────────────────────────────────────────────────────────

function resolveJobActor(db, context) {
  if (context.actor?.id) return context.actor;
  const actorId = context.input.actor_id;
  if (!actorId) return null;
  return queryOne(db, "SELECT id, username, email, display_name, organization_id, tenant_id FROM users WHERE id = ?", [Number(actorId)]);
}

async function runExecuteHandler(context) {
  const db = context.db;
  const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
  const actor = resolveJobActor(db, context);
  if (!actor) throw invalidReport("Asynchronous report execution requires an initiating actor");
  context.step("executing", { progress: 10 });
  const result = executeReport(db, tenantId, context.input.report_ref, { parameters: context.input.parameters || {}, mode: "EXECUTE" }, actor, context.ip);
  markJob(db, context.job?.id, { status: "COMPLETED", result_json: stringifyJson({ execution_ref: result.execution_ref, total: result.total }), finished_at: nowIso() });
  context.reportProgress({ progress: 100, message: "Report executed" }, { force: true });
  return { message: "Report execution complete", result: { execution_ref: result.execution_ref, total: result.total } };
}

async function runExportHandler(context) {
  const db = context.db;
  const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
  const actor = resolveJobActor(db, context);
  if (!actor) throw invalidReport("Asynchronous export requires an initiating actor");
  context.step("exporting", { progress: 10 });
  const result = executeExport(db, tenantId, context.input.export_ref, {}, actor, context.ip);
  markJob(db, context.job?.id, { status: result.status === "COMPLETED" ? "COMPLETED" : "FAILED", result_json: stringifyJson({ export_ref: result.export_ref, rows: result.row_count }), finished_at: nowIso() });
  context.reportProgress({ progress: 100, message: "Export complete" }, { force: true });
  return { message: "Report export complete", result: { export_ref: result.export_ref, rows: result.row_count } };
}

async function runScheduleHandler(context) {
  const db = context.db;
  const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
  const actor = resolveJobActor(db, context);
  context.step("running schedule", { progress: 10 });
  const schedule = queryOne(db, "SELECT * FROM reporting_schedules WHERE tenant_id = ? AND schedule_ref = ?", [tenantId, String(context.input.schedule_ref)]);
  const runActor = actor || (schedule?.created_by ? queryOne(db, "SELECT id, username, email, display_name, organization_id, tenant_id FROM users WHERE id = ?", [Number(schedule.created_by)]) : null);
  if (!runActor) throw invalidReport("Scheduled run requires an owner");
  const result = runSchedule(db, tenantId, context.input.schedule_ref, runActor, context.ip);
  markJob(db, context.job?.id, { status: "COMPLETED", result_json: stringifyJson(result), finished_at: nowIso() });
  context.reportProgress({ progress: 100, message: "Schedule executed" }, { force: true });
  return { message: "Scheduled report run complete", result };
}

async function runKpiHandler(context) {
  const db = context.db;
  const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
  const actor = resolveJobActor(db, context);
  context.step("calculating KPI", { progress: 10 });
  const result = getKpiValue(db, tenantId, context.input.kpi_ref, { actor, enableCache: false });
  markJob(db, context.job?.id, { status: "COMPLETED", result_json: stringifyJson({ kpi: result.kpi, value: result.value, status: result.status }), finished_at: nowIso() });
  context.reportProgress({ progress: 100, message: "KPI calculated" }, { force: true });
  return { message: "KPI calculation complete", result: { kpi: result.kpi, value: result.value, status: result.status } };
}

async function runRefreshHandler(context) {
  const db = context.db;
  const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
  context.step("refreshing read model", { progress: 10 });
  const result = refreshReadModel(db, { tenantId, entities: context.input.entities || null });
  markJob(db, context.job?.id, { status: "COMPLETED", result_json: stringifyJson({ entities: result.entities, rows: result.rows }), finished_at: nowIso() });
  context.reportProgress({ progress: 100, message: "Read model refreshed" }, { force: true });
  return { message: "Reporting read model refreshed", result: { entities: result.entities, rows: result.rows } };
}

async function runMaintenanceHandler(context) {
  const tenantId = context.input.tenant_id ? Number(context.input.tenant_id) : null;
  context.step("maintenance", { progress: 10 });
  const result = runReportingMaintenance(context.db, { tenantId });
  markJob(context.db, context.job?.id, { status: "COMPLETED", result_json: stringifyJson(result), finished_at: nowIso() });
  context.reportProgress({ progress: 100, message: "Maintenance complete" }, { force: true });
  return { message: "Reporting maintenance complete", result };
}

export function registerReportingHandlers() {
  registerHandler(REPORTING_HANDLER_CODES.EXECUTE, runExecuteHandler, { description: "Execute a saved report asynchronously" });
  registerHandler(REPORTING_HANDLER_CODES.EXPORT, runExportHandler, { description: "Export a saved report" });
  registerHandler(REPORTING_HANDLER_CODES.SCHEDULE, runScheduleHandler, { description: "Run a scheduled report, dashboard or KPI" });
  registerHandler(REPORTING_HANDLER_CODES.KPI, runKpiHandler, { description: "Calculate a KPI value" });
  registerHandler(REPORTING_HANDLER_CODES.REFRESH, runRefreshHandler, { description: "Refresh the reporting read model" });
  registerHandler(REPORTING_HANDLER_CODES.MAINTENANCE, runMaintenanceHandler, { description: "Prune reporting history, executions and exports" });
  return Object.values(REPORTING_HANDLER_CODES);
}

export function listDueSchedules(db, tenantId) {
  return dueSchedules(db, tenantId);
}
