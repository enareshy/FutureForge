// Background job handlers for Data Governance & Data Quality. Evaluation of
// large object sets, duplicate sweeps and overdue-exception escalation run on
// the platform Job Scheduling & Execution Engine so a request never blocks.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { submitJob } from "../jobs/jobs.js";
import { evaluateType, evaluateObject } from "./engine.js";
import { detectDuplicates } from "./duplicates.js";
import { escalateOverdueExceptions } from "./exceptions.js";
import { getConfig } from "./configuration.js";
import { GOVERNANCE_HANDLER_CODES } from "./constants.js";
import { findCatalogByType } from "./catalog.js";
import { publicQualityJob } from "./repository.js";

function trackJob(db, { tenantId, mode, scope, submittedBy, jobRef }) {
  const result = run(
    db,
    `INSERT INTO dg_quality_jobs (tenant_id, mode, scope_json, status, job_ref, submitted_by, started_at, created_at, updated_at)
     VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
    [Number(tenantId), String(mode).toUpperCase(), JSON.stringify(scope || {}), jobRef || "", submittedBy ?? null, nowIso(), nowIso(), nowIso()]
  );
  return Number(result.lastInsertRowid);
}

function completeJob(db, id, { status, stats }) {
  run(db, "UPDATE dg_quality_jobs SET status = ?, stats_json = ?, completed_at = ?, updated_at = ? WHERE id = ?", [
    status,
    JSON.stringify(stats || {}),
    nowIso(),
    nowIso(),
    id,
  ]);
  return publicQualityJob(queryOne(db, "SELECT * FROM dg_quality_jobs WHERE id = ?", [id]));
}

export function listQualityJobs(db, { tenantId, status, limit = 50 } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  return queryAll(
    db,
    `SELECT * FROM dg_quality_jobs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`,
    [...params, Number(limit) || 50]
  ).map(publicQualityJob);
}

// Submits an asynchronous evaluation. This is how a large dataset is evaluated:
// the request returns immediately with a job reference.
export function submitBatchEvaluation(db, { tenantId, objectTypes = [], objectIds = null, actor = null, ip = null } = {}) {
  const scope = { object_types: objectTypes, object_ids: objectIds };
  const job = submitJob(
    db,
    {
      job_type_code: "DATA_QUALITY_BATCH",
      payload: scope,
      tenant_id: Number(tenantId),
      priority: "normal",
      queue: "default",
    },
    { actor, ip }
  );
  const tracking = trackJob(db, { tenantId, mode: "BATCH", scope, submittedBy: actor?.id ?? null, jobRef: job?.job_ref });
  return { job, tracking_id: tracking, quality_job: publicQualityJob(queryOne(db, "SELECT * FROM dg_quality_jobs WHERE id = ?", [tracking])) };
}

export function submitDuplicateScan(db, { tenantId, objectType, actor = null, ip = null } = {}) {
  const scope = { object_type: objectType };
  const job = submitJob(
    db,
    { job_type_code: "DATA_QUALITY_DUPLICATES", payload: scope, tenant_id: Number(tenantId), priority: "normal", queue: "default" },
    { actor, ip }
  );
  const tracking = trackJob(db, { tenantId, mode: "DUPLICATES", scope, submittedBy: actor?.id ?? null, jobRef: job?.job_ref });
  return { job, tracking_id: tracking };
}

export function runBatchEvaluation(db, { tenantId, objectTypes = [], objectIds = null, trigger = "batch" } = {}) {
  const types = objectTypes.length ? objectTypes : queryAll(db, "SELECT DISTINCT object_type FROM dg_rules WHERE tenant_id = ? AND status = 'active'", [Number(tenantId)]).map((row) => row.object_type);
  const summary = {};
  for (const objectType of types) {
    if (!objectType) continue;
    summary[objectType] = evaluateType(db, {
      tenantId,
      objectType,
      objectIds: objectType && objectIds ? objectIds : null,
      trigger,
      persist: true,
    });
    delete summary[objectType].results;
  }
  return summary;
}

// Sweeps evaluation of every catalogue object type that opts into scheduled
// evaluation. Bounded per run so a single job cannot run unbounded.
export function runScheduledEvaluation(db, { tenantId, limit = 500 } = {}) {
  const catalogs = queryAll(
    db,
    "SELECT object_type FROM dg_catalog_objects WHERE tenant_id = ? AND status = 'active' AND schedule <> '' ORDER BY object_type",
    [Number(tenantId)]
  );
  const summary = {};
  for (const entry of catalogs) {
    summary[entry.object_type] = evaluateType(db, { tenantId, objectType: entry.object_type, trigger: "scheduled", persist: true, limit });
    delete summary[entry.object_type].results;
  }
  return { scheduled_types: catalogs.length, summary };
}

// Event-driven evaluation: an object changed, so re-evaluate it. Called from an
// event hook; best-effort and bounded.
export function evaluateOnEvent(db, { tenantId, objectType, objectId, actor = null } = {}) {
  if (getConfig(db, tenantId, "event_evaluation_enabled") === false) return { skipped: true, reason: "disabled" };
  const catalog = findCatalogByType(db, tenantId, objectType);
  if (!catalog || !catalog.event_trigger) return { skipped: true, reason: "not_event_triggered" };
  return evaluateObject(db, { tenantId, objectType, objectId, trigger: "event", actor, persist: true });
}

export function runGovernanceMaintenance(db, { tenantId = null } = {}) {
  const escalations = escalateOverdueExceptions(db, { tenantId });
  const retentionDays = Number(getConfig(db, tenantId || 0, "history_retention_days")) || 730;
  const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const clauses = ["is_current = 0", "evaluated_at < ?"];
  const params = [cutoff];
  if (tenantId) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  const stale = queryAll(db, `SELECT id FROM dg_quality_results WHERE ${clauses.join(" AND ")}`, params);
  let pruned = 0;
  for (const row of stale) {
    run(db, "UPDATE dg_quality_violations SET is_current = 0 WHERE result_id = ?", [row.id]);
    run(db, "DELETE FROM dg_quality_results WHERE id = ?", [row.id]);
    pruned += 1;
  }
  return { escalated: escalations.escalated, history_pruned: pruned, ran_at: nowIso() };
}

// Handler registration is idempotent: registering the same code twice simply
// replaces the entry, so a repeated boot is safe.
export function registerDataGovernanceHandlers() {
  registerHandler(
    GOVERNANCE_HANDLER_CODES.BATCH,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("evaluating", { progress: 10 });
      const tracking = trackJob(context.db, {
        tenantId,
        mode: "BATCH",
        scope: context.input,
        submittedBy: null,
        jobRef: context.job_ref,
      });
      const summary = runBatchEvaluation(context.db, {
        tenantId,
        objectTypes: context.input.object_types || [],
        objectIds: context.input.object_ids || null,
        trigger: "batch",
      });
      context.step("persisting", { progress: 90 });
      completeJob(context.db, tracking, { status: "completed", stats: summary });
      context.reportProgress({ progress: 100, message: "Batch evaluation complete" }, { force: true });
      return { message: "Batch evaluation complete", result: summary };
    },
    { description: "Evaluate governed objects for data quality" }
  );

  registerHandler(
    GOVERNANCE_HANDLER_CODES.SCHEDULED,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("scheduled", { progress: 10 });
      const tracking = trackJob(context.db, { tenantId, mode: "SCHEDULED", scope: context.input, jobRef: context.job_ref });
      const summary = runScheduledEvaluation(context.db, { tenantId, limit: Number(context.input.limit) || 500 });
      completeJob(context.db, tracking, { status: "completed", stats: summary });
      return { message: "Scheduled evaluation complete", result: summary };
    },
    { description: "Run scheduled data quality evaluation" }
  );

  registerHandler(
    GOVERNANCE_HANDLER_CODES.DUPLICATES,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("detecting", { progress: 10 });
      const tracking = trackJob(context.db, { tenantId, mode: "DUPLICATES", scope: context.input, jobRef: context.job_ref });
      const result = detectDuplicates(context.db, {
        tenantId,
        objectType: context.input.object_type,
        matchRuleId: context.input.match_rule_id || null,
        limit: Number(context.input.limit) || 2000,
      });
      completeJob(context.db, tracking, { status: "completed", stats: { detected: result.detected } });
      return { message: "Duplicate detection complete", result };
    },
    { description: "Detect duplicate governed objects" }
  );

  registerHandler(
    GOVERNANCE_HANDLER_CODES.MAINTENANCE,
    async (context) => {
      context.step("maintenance", { progress: 5 });
      const summary = runGovernanceMaintenance(context.db, { tenantId: context.input.tenant_id ?? context.tenant_id ?? null });
      context.reportProgress({ progress: 100, message: "Maintenance complete" }, { force: true });
      return { message: "Data governance maintenance complete", result: summary };
    },
    { description: "Escalate overdue exceptions and prune quality history" }
  );

  return Object.values(GOVERNANCE_HANDLER_CODES);
}
