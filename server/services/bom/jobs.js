// Background jobs for the BOM Engine.
//
// Rollup, where-used, transformation, validation, comparison and maintenance all
// run on the shared Job Scheduling & Execution Engine so they are durable,
// resumable, observable and retryable. Handlers only drive the BOM core.
import { queryAll, run, nowIso } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { submitJob } from "../jobs/jobs.js";
import { getJobTypeRow, createJobType } from "../jobs/types.js";
import { BOM_HANDLER_CODES, BOM_JOB_TYPES } from "./constants.js";
import { getConfig } from "./configuration.js";
import { rollup } from "./rollup.js";
import { whereUsed, multiLevelWhereUsed } from "./where-used.js";
import { transform } from "./transformation.js";
import { validateRevision } from "./validator.js";
import { compare } from "./compare.js";
import { invalidate, bumpEpoch, cacheStats } from "./cache.js";
import { publishBomEvent, bomEventCode } from "./events.js";

export function ensureBomJobTypes(db) {
  let created = 0;
  for (const def of BOM_JOB_TYPES) {
    if (getJobTypeRow(db, def.code)) continue;
    createJobType(db, { ...def }, null, null);
    created += 1;
  }
  return { created };
}

function submit(db, { tenantId, jobTypeCode, handlerParams, actor, ip, priority = "normal", queue = "bom", idempotencyKey = null }) {
  return submitJob(
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
}

export function submitRollupJob(db, { tenantId, revisionId, options = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "BOM_ROLLUP", handlerParams: { revision_id: Number(revisionId), options }, actor, ip, idempotencyKey });
}

export function submitWhereUsedJob(db, { tenantId, objectId, options = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "BOM_WHERE_USED", handlerParams: { object_id: String(objectId), options }, actor, ip, idempotencyKey });
}

export function submitTransformJob(db, { tenantId, body = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "BOM_TRANSFORM", handlerParams: { body }, actor, ip, idempotencyKey });
}

export function submitValidateJob(db, { tenantId, revisionId, options = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "BOM_VALIDATE", handlerParams: { revision_id: Number(revisionId), options }, actor, ip, idempotencyKey });
}

export function submitCompareJob(db, { tenantId, body = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "BOM_COMPARE", handlerParams: { body }, actor, ip, idempotencyKey });
}

export function submitMaintenanceJob(db, { tenantId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "BOM_MAINTENANCE", handlerParams: {}, actor, ip, priority: "low", queue: "default", idempotencyKey });
}

// ── Synchronous cores (also used by the handlers) ────────────────────────────

export function runBomMaintenance(db, { tenantId = null, limit = 5000 } = {}) {
  const tenantRows = tenantId
    ? [{ tenant_id: Number(tenantId) }]
    : queryAll(db, "SELECT DISTINCT tenant_id FROM bom_headers WHERE tenant_id IS NOT NULL");
  const summary = { tenants: tenantRows.length, history_pruned: 0, orphan_attributes_pruned: 0, orphan_substitutes_pruned: 0, ran_at: nowIso() };
  for (const row of tenantRows) {
    const tenant = Number(row.tenant_id);
    const retentionDays = Number(getConfig(db, tenant, "history_retention_days") || 365);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    summary.history_pruned += run(db, "DELETE FROM bom_change_history WHERE tenant_id = ? AND created_at < ?", [tenant, cutoff]).changes || 0;
    summary.orphan_attributes_pruned += run(
      db,
      "DELETE FROM bom_line_attributes WHERE tenant_id = ? AND line_id NOT IN (SELECT id FROM bom_lines)",
      [tenant]
    ).changes || 0;
    summary.orphan_substitutes_pruned += run(
      db,
      "DELETE FROM bom_substitutes WHERE tenant_id = ? AND bom_revision_id NOT IN (SELECT id FROM bom_revisions)",
      [tenant]
    ).changes || 0;
    invalidate(tenant);
    bumpEpoch(tenant);
  }
  summary.cache = cacheStats();
  void limit;
  return summary;
}

export function bulkValidate(db, tenantId, { revisionIds = [], options = {}, actor = null } = {}) {
  const summary = { requested: revisionIds.length, passed: 0, warned: 0, failed: 0, results: [] };
  for (const revisionId of revisionIds) {
    try {
      const result = validateRevision(db, tenantId, revisionId, { ...options, actor });
      if (result.status === "ERROR") summary.failed += 1;
      else if (result.status === "WARNING") summary.warned += 1;
      else summary.passed += 1;
      summary.results.push({ revision_id: revisionId, status: result.status, error_count: result.error_count, warning_count: result.warning_count });
    } catch (error) {
      summary.failed += 1;
      summary.results.push({ revision_id: revisionId, status: "ERROR", message: error.message });
    }
  }
  publishBomEvent(db, { eventType: bomEventCode("BULK_COMPLETED"), objectType: "bom_validation", objectId: null, tenantId }, actor);
  return summary;
}

// ── Handler registration ─────────────────────────────────────────────────────

export function registerBomHandlers() {
  registerHandler(
    BOM_HANDLER_CODES.ROLLUP,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("rolling up", { progress: 10 });
      const result = rollup(context.db, tenantId, Number(context.input.revision_id), context.input.options || {});
      context.reportProgress({ progress: 100, message: "Rollup complete" }, { force: true });
      publishBomEvent(context.db, { eventType: bomEventCode("ROLLUP_COMPLETED"), objectType: "bom_revision", objectId: Number(context.input.revision_id), tenantId, payload: { line_count: result.line_count } }, context.actor);
      return { message: "BOM rollup complete", result };
    },
    { description: "Compute a recursive BOM quantity rollup" }
  );

  registerHandler(
    BOM_HANDLER_CODES.WHERE_USED,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("resolving where-used", { progress: 10 });
      const options = context.input.options || {};
      const result = options.multiLevel === false
        ? whereUsed(context.db, { tenantId, objectId: context.input.object_id, ...options })
        : multiLevelWhereUsed(context.db, tenantId, context.input.object_id, options);
      context.reportProgress({ progress: 100, message: "Where-used complete" }, { force: true });
      return { message: "BOM where-used complete", result };
    },
    { description: "Resolve where-used parents for a component" }
  );

  registerHandler(
    BOM_HANDLER_CODES.TRANSFORM,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("transforming", { progress: 10 });
      const body = context.input.body || {};
      const result = transform(context.db, tenantId, { ...body, mode: body.mode || "EXECUTE" }, context.actor, context.ip);
      context.reportProgress({ progress: 100, message: "Transformation complete" }, { force: true });
      return { message: "BOM transformation complete", result: { run_ref: result.run.run_ref, summary: result.summary } };
    },
    { description: "Execute a controlled BOM transformation" }
  );

  registerHandler(
    BOM_HANDLER_CODES.VALIDATE,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("validating", { progress: 10 });
      const result = validateRevision(context.db, tenantId, Number(context.input.revision_id), { ...(context.input.options || {}), actor: context.actor });
      context.reportProgress({ progress: 100, message: "Validation complete" }, { force: true });
      return { message: "BOM validation complete", result: { status: result.status, issue_count: result.issue_count } };
    },
    { description: "Run configurable BOM validation rules over a revision" }
  );

  registerHandler(
    BOM_HANDLER_CODES.COMPARE,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("comparing", { progress: 10 });
      const result = compare(context.db, tenantId, context.input.body || {}, context.actor, context.ip);
      context.reportProgress({ progress: 100, message: "Comparison complete" }, { force: true });
      return { message: "BOM comparison complete", result: { comparison_ref: result.comparison.comparison_ref, summary: result.comparison.summary } };
    },
    { description: "Compare two BOM revisions or baselines" }
  );

  registerHandler(
    BOM_HANDLER_CODES.MAINTENANCE,
    async (context) => {
      const tenantId = context.input.tenant_id ? Number(context.input.tenant_id) : null;
      context.step("maintenance", { progress: 10 });
      const result = runBomMaintenance(context.db, { tenantId });
      context.reportProgress({ progress: 100, message: "Maintenance complete" }, { force: true });
      return { message: "BOM maintenance complete", result };
    },
    { description: "Prune history, repair orphans and refresh caches" }
  );

  return Object.values(BOM_HANDLER_CODES);
}
