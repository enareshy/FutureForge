// Background jobs for the Digital Thread domain.
//
// Traversal, impact, path, snapshot, baseline, completeness, projection rebuild,
// reindex and maintenance all run on the shared Job Scheduling & Execution
// Engine so they are durable, resumable, observable and retryable. Handlers only
// drive the thread core.
import { queryAll, run, nowIso } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { submitJob } from "../jobs/jobs.js";
import { getJobTypeRow, createJobType } from "../jobs/types.js";
import { reindexType } from "../search/indexing.js";
import { THREAD_HANDLER_CODES, THREAD_JOB_TYPES, SEARCH_OBJECT_TYPES } from "./constants.js";
import { executeTraversal } from "./engine.js";
import { impactAnalysis } from "./impact.js";
import { findPaths } from "./paths.js";
import { createSnapshot } from "./snapshots.js";
import { createBaseline } from "./baselines.js";
import { evaluateCompleteness } from "./completeness.js";
import { rebuildProjection, handleSourceEvent } from "./projection.js";
import { invalidate, bumpEpoch, cacheStats } from "./cache.js";
import { getConfig } from "./configuration.js";

const THREAD_QUEUE = "thread";
const PROJECT_HANDLER = "thread.project";

export function ensureThreadJobTypes(db) {
  let created = 0;
  for (const def of THREAD_JOB_TYPES) {
    if (getJobTypeRow(db, def.code)) continue;
    createJobType(db, { ...def }, null, null);
    created += 1;
  }
  return { created };
}

function submit(db, { tenantId, jobTypeCode, handlerParams, actor, ip, priority = "normal", queue = THREAD_QUEUE, idempotencyKey = null }) {
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

export function submitTraversalJob(db, { tenantId, root, options = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "THREAD_TRAVERSAL", handlerParams: { root, options }, actor, ip, idempotencyKey });
}

export function submitImpactJob(db, { tenantId, root, options = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "THREAD_IMPACT", handlerParams: { root, options }, actor, ip, idempotencyKey });
}

export function submitPathJob(db, { tenantId, source, target, options = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "THREAD_PATH", handlerParams: { source, target, options }, actor, ip, idempotencyKey });
}

export function submitSnapshotJob(db, { tenantId, body = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "THREAD_SNAPSHOT_CREATE", handlerParams: { body }, actor, ip, idempotencyKey });
}

export function submitBaselineJob(db, { tenantId, body = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "THREAD_BASELINE_CREATE", handlerParams: { body }, actor, ip, idempotencyKey });
}

export function submitCompletenessJob(db, { tenantId, root, options = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "THREAD_COMPLETENESS", handlerParams: { root, options }, actor, ip, idempotencyKey });
}

export function submitReindexJob(db, { tenantId, objectTypes = null, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "THREAD_REINDEX", handlerParams: { object_types: objectTypes }, actor, ip, priority: "low", idempotencyKey });
}

export function submitProjectionRebuildJob(db, { tenantId, objectTypes = null, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "THREAD_PROJECTION_REBUILD", handlerParams: { object_types: objectTypes }, actor, ip, priority: "low", idempotencyKey });
}

export function submitMaintenanceJob(db, { tenantId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "THREAD_MAINTENANCE", handlerParams: {}, actor, ip, priority: "low", queue: "default", idempotencyKey });
}

// ── Synchronous cores (also used by the handlers) ────────────────────────────

export function runThreadMaintenance(db, { tenantId = null } = {}) {
  const tenantRows = tenantId
    ? [{ tenant_id: Number(tenantId) }]
    : queryAll(db, "SELECT DISTINCT tenant_id FROM thread_query_history WHERE tenant_id IS NOT NULL");
  const summary = { tenants: tenantRows.length, query_history_pruned: 0, events_processed_pruned: 0, stale_projections_pruned: 0, ran_at: nowIso() };
  for (const row of tenantRows) {
    const tenant = Number(row.tenant_id);
    const retentionDays = Number(getConfig(db, tenant, "history_retention_days") || 90);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    summary.query_history_pruned += run(db, "DELETE FROM thread_query_history WHERE tenant_id = ? AND created_at < ?", [tenant, cutoff]).changes || 0;
    summary.events_processed_pruned += run(db, "DELETE FROM thread_events_processed WHERE tenant_id = ? AND processed_at < ?", [tenant, cutoff]).changes || 0;
    summary.stale_projections_pruned += run(db, "DELETE FROM thread_projections WHERE tenant_id = ? AND status = 'STALE' AND updated_at < ?", [tenant, cutoff]).changes || 0;
    invalidate(tenant);
    bumpEpoch(tenant);
  }
  summary.cache = cacheStats();
  return summary;
}

// ── Handler registration ─────────────────────────────────────────────────────

export function registerThreadHandlers() {
  registerHandler(
    THREAD_HANDLER_CODES.TRAVERSAL,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("traversing", { progress: 10 });
      const { result } = executeTraversal(context.db, tenantId, { ...(context.input.options || {}), root: context.input.root }, context.actor);
      context.reportProgress({ progress: 100, message: "Traversal complete" }, { force: true });
      return { message: "Digital thread traversal complete", result: { node_count: result.node_count, edge_count: result.edge_count, truncated: result.truncated } };
    },
    { description: "Traverse the digital thread with revision, effectivity and configuration context" }
  );

  registerHandler(
    THREAD_HANDLER_CODES.IMPACT,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("analysing impact", { progress: 10 });
      const result = impactAnalysis(context.db, tenantId, { ...(context.input.options || {}), root: context.input.root }, context.actor);
      context.reportProgress({ progress: 100, message: "Impact analysis complete" }, { force: true });
      return { message: "Digital thread impact complete", result: { impacted_count: result.impact_summary.impacted_count } };
    },
    { description: "Resolve direct and indirect change impact for a thread root" }
  );

  registerHandler(
    THREAD_HANDLER_CODES.PATH,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("finding paths", { progress: 10 });
      const result = findPaths(context.db, tenantId, { ...(context.input.options || {}), source: context.input.source, target: context.input.target }, context.actor);
      context.reportProgress({ progress: 100, message: "Path analysis complete" }, { force: true });
      return { message: "Digital thread path complete", result: { found: result.found, path_count: result.path_count } };
    },
    { description: "Find traceability paths between two objects" }
  );

  registerHandler(
    THREAD_HANDLER_CODES.SNAPSHOT,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("creating snapshot", { progress: 10 });
      const result = createSnapshot(context.db, tenantId, context.input.body || {}, context.actor, context.ip);
      context.reportProgress({ progress: 100, message: "Snapshot frozen" }, { force: true });
      return { message: "Digital thread snapshot created", result: { snapshot_ref: result.snapshot_ref, node_count: result.node_count, edge_count: result.edge_count } };
    },
    { description: "Materialise and freeze an immutable digital thread snapshot" }
  );

  registerHandler(
    THREAD_HANDLER_CODES.BASELINE,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("creating baseline", { progress: 10 });
      const result = createBaseline(context.db, tenantId, context.input.body || {}, context.actor, context.ip);
      context.reportProgress({ progress: 100, message: "Baseline created" }, { force: true });
      return { message: "Digital thread baseline created", result: { baseline_ref: result.baseline_ref, member_count: result.member_count } };
    },
    { description: "Create a controlled digital thread baseline from a snapshot" }
  );

  registerHandler(
    THREAD_HANDLER_CODES.COMPLETENESS,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("evaluating completeness", { progress: 10 });
      const result = evaluateCompleteness(context.db, tenantId, { ...(context.input.options || {}), root: context.input.root }, context.actor);
      context.reportProgress({ progress: 100, message: "Completeness evaluated" }, { force: true });
      return { message: "Digital thread completeness complete", result: { completeness_score: result.completeness_score, violated_rules: result.violated_rules } };
    },
    { description: "Evaluate traceability completeness against configured rules" }
  );

  registerHandler(
    THREAD_HANDLER_CODES.REINDEX,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("reindexing", { progress: 10 });
      const types = context.input.object_types || SEARCH_OBJECT_TYPES.map((entry) => entry.code);
      const summary = {};
      for (const objectType of types) {
        summary[objectType] = reindexType(context.db, { tenantId, objectType }, context.actor, context.ip);
      }
      context.reportProgress({ progress: 100, message: "Reindex complete" }, { force: true });
      return { message: "Digital thread reindex complete", result: { types: summary } };
    },
    { description: "Reindex digital thread search object types" }
  );

  registerHandler(
    THREAD_HANDLER_CODES.PROJECTION_REBUILD,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("rebuilding projection", { progress: 10 });
      const result = rebuildProjection(context.db, tenantId, { objectTypes: context.input.object_types, actor: context.actor });
      context.reportProgress({ progress: 100, message: "Projection rebuilt" }, { force: true });
      return { message: "Digital thread projection rebuilt", result };
    },
    { description: "Rebuild the derived digital thread projection from source objects" }
  );

  registerHandler(
    PROJECT_HANDLER,
    async (context) => {
      context.step("projecting source event", { progress: 50 });
      const result = handleSourceEvent(context.db, { ...context.input, tenant_id: context.input.tenant_id ?? context.tenant_id });
      context.reportProgress({ progress: 100, message: "Projection updated" }, { force: true });
      return { message: "Digital thread projection updated", result };
    },
    { description: "Update the derived digital thread projection from a source domain event" }
  );

  registerHandler(
    THREAD_HANDLER_CODES.MAINTENANCE,
    async (context) => {
      const tenantId = context.input.tenant_id ? Number(context.input.tenant_id) : null;
      context.step("maintenance", { progress: 10 });
      const result = runThreadMaintenance(context.db, { tenantId });
      context.reportProgress({ progress: 100, message: "Maintenance complete" }, { force: true });
      return { message: "Digital thread maintenance complete", result };
    },
    { description: "Prune query history, processed events and stale projections" }
  );

  return [...Object.values(THREAD_HANDLER_CODES), PROJECT_HANDLER];
}

export { PROJECT_HANDLER };
