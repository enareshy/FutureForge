// Background jobs for Data Observability.
//
// Collection, freshness, health, SLO evaluation and retention all run on the
// shared Job Scheduling & Execution Engine so they are durable, resumable,
// observable and retryable. Handlers reconstruct the initiating subject so
// authorization is never silently dropped for an asynchronous run.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { submitJob } from "../jobs/jobs.js";
import { getJobTypeRow, createJobType } from "../jobs/types.js";
import { OBSERVABILITY_HANDLER_CODES, OBSERVABILITY_JOB_TYPES, OBSERVABILITY_QUEUE } from "./constants.js";
import { jobRef as makeJobRef } from "./identifiers.js";
import { parseJson, stringifyJson } from "./repository.js";
import { collectTenant, collectAllTenants, pruneRuns } from "./collection.js";
import { evaluateFreshness } from "./freshness.js";
import { evaluateHealth, persistHealthSnapshots, pruneHealthSnapshots } from "./health.js";
import { evaluateAllSlos } from "./slo.js";
import { pruneObservations } from "./metrics.js";
import { pruneAlerts } from "./alerts.js";
import { pruneIncidents } from "./incidents.js";
import { pruneHistory } from "./history.js";
import { listRetentionPolicies } from "./configuration.js";
import { invalidParameters } from "./errors.js";

export function publicObservabilityJob(row) {
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

export function ensureObservabilityJobTypes(db) {
  let created = 0;
  for (const def of OBSERVABILITY_JOB_TYPES) {
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
    `INSERT INTO observability_jobs (job_ref, tenant_id, handler_code, job_type_code, entity_type, entity_ref, platform_job_id, status, attempts, max_attempts, progress_json, created_by, queued_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'QUEUED', 0, 1, '{}', ?, ?, ?, ?)`,
    [makeJobRef(), Number(tenantId), handlerCode, jobTypeCode, entityType, entityRef, platformJob?.id ?? null, actor?.id ?? null, ts, ts, ts]
  );
  return Number(result.lastInsertRowid);
}

function submit(db, { tenantId, jobTypeCode, handlerCode, handlerInput = {}, entityType = null, entityRef = null, actor = null, ip = null, priority = "normal", queue = OBSERVABILITY_QUEUE, idempotencyKey = null }) {
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
  return { ...platformJob, observability_job: publicObservabilityJob(queryOne(db, "SELECT * FROM observability_jobs WHERE id = ?", [jobId])) };
}

export function submitCollectJob(db, { tenantId, actor = null, ip = null, idempotencyKey = null, trigger = "MANUAL" } = {}) {
  return submit(db, { tenantId, jobTypeCode: "OBSERVABILITY_COLLECT", handlerCode: OBSERVABILITY_HANDLER_CODES.COLLECT, handlerInput: { trigger }, entityType: "collection", entityRef: "collection", actor, ip, idempotencyKey });
}

export function submitFreshnessJob(db, { tenantId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "OBSERVABILITY_FRESHNESS_CHECK", handlerCode: OBSERVABILITY_HANDLER_CODES.FRESHNESS, entityType: "freshness", entityRef: "freshness", actor, ip, idempotencyKey });
}

export function submitHealthJob(db, { tenantId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "OBSERVABILITY_HEALTH_CHECK", handlerCode: OBSERVABILITY_HANDLER_CODES.HEALTH, entityType: "health", entityRef: "health", actor, ip, idempotencyKey });
}

export function submitSloJob(db, { tenantId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "OBSERVABILITY_SLO_EVALUATE", handlerCode: OBSERVABILITY_HANDLER_CODES.SLO, entityType: "slo", entityRef: "slo", actor, ip, priority: "low", idempotencyKey });
}

export function submitMaintenanceJob(db, { tenantId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "OBSERVABILITY_MAINTENANCE", handlerCode: OBSERVABILITY_HANDLER_CODES.MAINTENANCE, entityType: "maintenance", entityRef: "maintenance", actor, ip, priority: "low", queue: "default", idempotencyKey });
}

export function listObservabilityJobs(db, tenantId, query = {}) {
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
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM observability_jobs WHERE ${clause}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM observability_jobs WHERE ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
  return { items: rows.map(publicObservabilityJob), total, page, pageSize };
}

export function getObservabilityJob(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM observability_jobs WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM observability_jobs WHERE tenant_id = ? AND job_ref = ?", [Number(tenantId), raw]);
  return publicObservabilityJob(row);
}

function markJob(db, platformJobId, patch = {}) {
  const ledger = queryOne(db, "SELECT id FROM observability_jobs WHERE platform_job_id = ?", [Number(platformJobId ?? -1)]);
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
  run(db, `UPDATE observability_jobs SET ${columns.join(", ")} WHERE id = ?`, values);
}

function retentionFor(db, tenantId, tier, fallback) {
  const policy = queryOne(db, "SELECT retain_days FROM observability_retention_policies WHERE tenant_id = ? AND tier = ?", [Number(tenantId), String(tier)]);
  return policy ? Number(policy.retain_days) : fallback;
}

export function runObservabilityMaintenance(db, { tenantId = null } = {}) {
  const tenants = tenantId
    ? [{ id: Number(tenantId) }]
    : queryAll(db, "SELECT DISTINCT tenant_id AS id FROM observability_metric_definitions UNION SELECT DISTINCT tenant_id FROM observability_dashboards");
  const summary = { tenants: tenants.length, observations_pruned: 0, snapshots_pruned: 0, alerts_pruned: 0, incidents_pruned: 0, history_pruned: 0, runs_pruned: 0, ran_at: nowIso() };
  for (const row of tenants) {
    const tenant = Number(row.id);
    summary.observations_pruned += pruneObservations(db, tenant, retentionFor(db, tenant, "OBSERVATIONS", 30));
    summary.snapshots_pruned += pruneHealthSnapshots(db, tenant, retentionFor(db, tenant, "HEALTH_SNAPSHOTS", 90));
    summary.alerts_pruned += pruneAlerts(db, tenant, retentionFor(db, tenant, "ALERTS", 365));
    summary.incidents_pruned += pruneIncidents(db, tenant, retentionFor(db, tenant, "INCIDENTS", 730));
    summary.history_pruned += pruneHistory(db, tenant, retentionFor(db, tenant, "HISTORY", 180));
    summary.runs_pruned += pruneRuns(db, tenant, retentionFor(db, tenant, "OBSERVATIONS", 30));
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

async function runCollectHandler(context) {
  const db = context.db;
  const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
  const actor = resolveJobActor(db, context);
  context.step("collecting", { progress: 10 });
  const result = context.input.all_tenants ? collectAllTenants(db, { trigger: context.input.trigger || "MANUAL", actor }) : collectTenant(db, tenantId, { trigger: context.input.trigger || "MANUAL", actor });
  markJob(db, context.job?.id, { status: "COMPLETED", result_json: stringifyJson(result.counts || { runs: result.runs?.length }), finished_at: nowIso() });
  context.reportProgress({ progress: 100, message: "Collection complete" }, { force: true });
  return { message: "Observability collection complete", result: result.counts || { runs: result.runs?.length } };
}

async function runFreshnessHandler(context) {
  const db = context.db;
  const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
  context.step("evaluating freshness", { progress: 10 });
  const items = evaluateFreshness(db, tenantId);
  const stale = items.filter((item) => ["WARNING", "CRITICAL", "STALE"].includes(item.status)).length;
  const result = { total: items.length, stale };
  markJob(db, context.job?.id, { status: "COMPLETED", result_json: stringifyJson(result), finished_at: nowIso() });
  context.reportProgress({ progress: 100, message: "Freshness evaluated" }, { force: true });
  return { message: "Freshness check complete", result };
}

async function runHealthHandler(context) {
  const db = context.db;
  const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
  const actor = resolveJobActor(db, context);
  context.step("computing health", { progress: 10 });
  const evaluation = evaluateHealth(db, tenantId);
  persistHealthSnapshots(db, tenantId, evaluation, { actor });
  const result = { overall: evaluation.overall, services: evaluation.services.length, checks: evaluation.checks.length };
  markJob(db, context.job?.id, { status: "COMPLETED", result_json: stringifyJson(result), finished_at: nowIso() });
  context.reportProgress({ progress: 100, message: "Health snapshot captured" }, { force: true });
  return { message: "Health check complete", result };
}

async function runSloHandler(context) {
  const db = context.db;
  const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
  const actor = resolveJobActor(db, context);
  context.step("evaluating SLOs", { progress: 10 });
  const result = evaluateAllSlos(db, tenantId, { actor });
  const summary = { total: result.total, compliant: result.compliant, at_risk: result.at_risk, breached: result.breached, no_data: result.no_data };
  markJob(db, context.job?.id, { status: "COMPLETED", result_json: stringifyJson(summary), finished_at: nowIso() });
  context.reportProgress({ progress: 100, message: "SLOs evaluated" }, { force: true });
  return { message: "SLO evaluation complete", result: summary };
}

async function runMaintenanceHandler(context) {
  const tenantId = context.input.tenant_id ? Number(context.input.tenant_id) : null;
  context.step("maintenance", { progress: 10 });
  const result = runObservabilityMaintenance(context.db, { tenantId });
  markJob(context.db, context.job?.id, { status: "COMPLETED", result_json: stringifyJson(result), finished_at: nowIso() });
  context.reportProgress({ progress: 100, message: "Maintenance complete" }, { force: true });
  return { message: "Observability maintenance complete", result };
}

export function registerObservabilityHandlers() {
  registerHandler(OBSERVABILITY_HANDLER_CODES.COLLECT, runCollectHandler, { description: "Collect observability metrics and evaluate thresholds" });
  registerHandler(OBSERVABILITY_HANDLER_CODES.FRESHNESS, runFreshnessHandler, { description: "Evaluate data-asset freshness" });
  registerHandler(OBSERVABILITY_HANDLER_CODES.HEALTH, runHealthHandler, { description: "Compute and persist service health snapshots" });
  registerHandler(OBSERVABILITY_HANDLER_CODES.SLO, runSloHandler, { description: "Evaluate SLO/SLA compliance" });
  registerHandler(OBSERVABILITY_HANDLER_CODES.MAINTENANCE, runMaintenanceHandler, { description: "Prune observability observations, snapshots and history" });
  return Object.values(OBSERVABILITY_HANDLER_CODES);
}

export { invalidParameters, listRetentionPolicies };
