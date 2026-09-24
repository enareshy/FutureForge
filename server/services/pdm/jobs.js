// Background jobs for the PDM domain.
//
// Structure resolution, where-used, where-referenced, baseline creation,
// validation, search reindexing and maintenance all run on the shared Job
// Scheduling & Execution Engine so they are durable, resumable, observable and
// retryable. Handlers only drive the PDM core.
import { queryAll, run, nowIso } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { submitJob } from "../jobs/jobs.js";
import { getJobTypeRow, createJobType } from "../jobs/types.js";
import { reindexType } from "../search/indexing.js";
import { PDM_HANDLER_CODES, PDM_JOB_TYPES, SEARCH_OBJECT_TYPES } from "./constants.js";
import { getConfig } from "./configuration.js";
import { resolveStructure } from "./structure.js";
import { whereUsed } from "./where-used.js";
import { whereReferenced, rebuildReferences } from "./where-referenced.js";
import { createBaseline } from "./baselines.js";
import { validateItem, validateRevision, validateDataset, validateTenant } from "./validator.js";
import { invalidate, bumpEpoch, cacheStats } from "./cache.js";
import { publishPdmEvent, pdmEventCode } from "./events.js";

const PDM_QUEUE = "pdm";

export function ensurePdmJobTypes(db) {
  let created = 0;
  for (const def of PDM_JOB_TYPES) {
    if (getJobTypeRow(db, def.code)) continue;
    createJobType(db, { ...def }, null, null);
    created += 1;
  }
  return { created };
}

function submit(db, { tenantId, jobTypeCode, handlerParams, actor, ip, priority = "normal", queue = PDM_QUEUE, idempotencyKey = null }) {
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

export function submitStructureResolveJob(db, { tenantId, itemId, options = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "PDM_STRUCTURE_RESOLVE", handlerParams: { item_id: Number(itemId), options }, actor, ip, idempotencyKey });
}

export function submitWhereUsedJob(db, { tenantId, itemId, options = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "PDM_WHERE_USED", handlerParams: { item_id: Number(itemId), options }, actor, ip, idempotencyKey });
}

export function submitWhereReferencedJob(db, { tenantId, targetType, targetId, options = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "PDM_WHERE_REFERENCED", handlerParams: { target_type: targetType, target_id: String(targetId), options }, actor, ip, idempotencyKey });
}

export function submitBaselineJob(db, { tenantId, body = {}, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "PDM_BASELINE_CREATE", handlerParams: { body }, actor, ip, idempotencyKey });
}

export function submitValidateJob(db, { tenantId, scope = "TENANT", itemId = null, revisionId = null, datasetId = null, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "PDM_VALIDATE", handlerParams: { scope, item_id: itemId, revision_id: revisionId, dataset_id: datasetId }, actor, ip, idempotencyKey });
}

export function submitReindexJob(db, { tenantId, objectTypes = null, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "PDM_REINDEX", handlerParams: { object_types: objectTypes }, actor, ip, idempotencyKey });
}

export function submitMaintenanceJob(db, { tenantId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "PDM_MAINTENANCE", handlerParams: {}, actor, ip, priority: "low", queue: "default", idempotencyKey });
}

// ── Synchronous cores (also used by the handlers) ────────────────────────────

export function runPdmMaintenance(db, { tenantId = null } = {}) {
  const tenantRows = tenantId
    ? [{ tenant_id: Number(tenantId) }]
    : queryAll(db, "SELECT DISTINCT tenant_id FROM pdm_items WHERE tenant_id IS NOT NULL");
  const summary = { tenants: tenantRows.length, history_pruned: 0, orphan_members_pruned: 0, orphan_references_pruned: 0, references_rebuilt: 0, ran_at: nowIso() };
  for (const row of tenantRows) {
    const tenant = Number(row.tenant_id);
    const retentionDays = Number(getConfig(db, tenant, "history_retention_days") || 365);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    summary.history_pruned += run(db, "DELETE FROM pdm_change_history WHERE tenant_id = ? AND created_at < ?", [tenant, cutoff]).changes || 0;
    summary.orphan_members_pruned += run(
      db,
      "DELETE FROM pdm_baseline_members WHERE tenant_id = ? AND baseline_id NOT IN (SELECT id FROM pdm_baselines)",
      [tenant]
    ).changes || 0;
    summary.orphan_references_pruned += run(
      db,
      "DELETE FROM pdm_references WHERE tenant_id = ? AND source_type = 'RELATIONSHIP' AND source_id NOT IN (SELECT CAST(id AS TEXT) FROM pdm_relationships)",
      [tenant]
    ).changes || 0;
    summary.references_rebuilt += rebuildReferences(db, tenant).added;
    invalidate(tenant);
    bumpEpoch(tenant);
  }
  summary.cache = cacheStats();
  return summary;
}

export function bulkValidate(db, tenantId, { itemIds = [], revisionIds = [], datasetIds = [], actor = null } = {}) {
  const summary = { requested: itemIds.length + revisionIds.length + datasetIds.length, passed: 0, warned: 0, failed: 0, results: [] };
  const record = (kind, id, result) => {
    if (result.status === "ERROR") summary.failed += 1;
    else if (result.status === "WARNING") summary.warned += 1;
    else summary.passed += 1;
    summary.results.push({ kind, id, status: result.status, error_count: result.error_count, warning_count: result.warning_count });
  };
  for (const id of itemIds) {
    try {
      record("ITEM", id, validateItem(db, tenantId, id, { actor }));
    } catch (error) {
      summary.failed += 1;
      summary.results.push({ kind: "ITEM", id, status: "ERROR", message: error.message });
    }
  }
  for (const id of revisionIds) {
    try {
      record("REVISION", id, validateRevision(db, tenantId, id, { actor }));
    } catch (error) {
      summary.failed += 1;
      summary.results.push({ kind: "REVISION", id, status: "ERROR", message: error.message });
    }
  }
  for (const id of datasetIds) {
    try {
      record("DATASET", id, validateDataset(db, tenantId, id, { actor }));
    } catch (error) {
      summary.failed += 1;
      summary.results.push({ kind: "DATASET", id, status: "ERROR", message: error.message });
    }
  }
  publishPdmEvent(db, { eventType: pdmEventCode("BULK_COMPLETED"), objectType: "pdm_validation", objectId: null, tenantId: Number(tenantId) }, actor);
  return summary;
}

// ── Handler registration ─────────────────────────────────────────────────────

export function registerPdmHandlers() {
  registerHandler(
    PDM_HANDLER_CODES.STRUCTURE,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("resolving structure", { progress: 10 });
      const result = resolveStructure(context.db, tenantId, { itemId: Number(context.input.item_id), ...(context.input.options || {}) });
      context.reportProgress({ progress: 100, message: "Structure resolved" }, { force: true });
      publishPdmEvent(context.db, { eventType: pdmEventCode("STRUCTURE_RESOLVED"), objectType: "pdm_item", objectId: Number(context.input.item_id), tenantId, payload: { node_count: result.node_count } }, context.actor);
      return { message: "PDM structure resolved", result: { node_count: result.node_count, edge_count: result.edge_count, truncated: result.truncated } };
    },
    { description: "Resolve a PDM structure with revision and configuration context" }
  );

  registerHandler(
    PDM_HANDLER_CODES.WHERE_USED,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("resolving where-used", { progress: 10 });
      const result = whereUsed(context.db, tenantId, Number(context.input.item_id), context.input.options || {});
      context.reportProgress({ progress: 100, message: "Where-used complete" }, { force: true });
      return { message: "PDM where-used complete", result: { node_count: result.node_count, top_level: result.top_level.length } };
    },
    { description: "Resolve PDM where-used parents for an item" }
  );

  registerHandler(
    PDM_HANDLER_CODES.WHERE_REFERENCED,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("resolving where-referenced", { progress: 10 });
      const result = whereReferenced(context.db, tenantId, { targetType: context.input.target_type, targetId: context.input.target_id, ...(context.input.options || {}), actor: context.actor });
      context.reportProgress({ progress: 100, message: "Where-referenced complete" }, { force: true });
      return { message: "PDM where-referenced complete", result: { total: result.total, category_count: result.category_count } };
    },
    { description: "Resolve PDM where-referenced consumers for an object" }
  );

  registerHandler(
    PDM_HANDLER_CODES.BASELINE,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("creating baseline", { progress: 10 });
      const result = createBaseline(context.db, tenantId, context.input.body || {}, context.actor, context.ip);
      context.reportProgress({ progress: 100, message: "Baseline created" }, { force: true });
      return { message: "PDM baseline created", result: { baseline_ref: result.baseline_ref, member_count: result.member_count } };
    },
    { description: "Create a controlled PDM baseline snapshot" }
  );

  registerHandler(
    PDM_HANDLER_CODES.VALIDATE,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("validating", { progress: 10 });
      const scope = String(context.input.scope || "TENANT").toUpperCase();
      let result;
      if (scope === "ITEM") result = validateItem(context.db, tenantId, context.input.item_id, { actor: context.actor });
      else if (scope === "REVISION") result = validateRevision(context.db, tenantId, context.input.revision_id, { actor: context.actor });
      else if (scope === "DATASET") result = validateDataset(context.db, tenantId, context.input.dataset_id, { actor: context.actor });
      else result = validateTenant(context.db, tenantId, { actor: context.actor });
      context.reportProgress({ progress: 100, message: "Validation complete" }, { force: true });
      return { message: "PDM validation complete", result: { status: result.status, issue_count: result.issue_count } };
    },
    { description: "Run configurable PDM validation rules" }
  );

  registerHandler(
    PDM_HANDLER_CODES.REINDEX,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("reindexing", { progress: 10 });
      const types = context.input.object_types || SEARCH_OBJECT_TYPES.map((entry) => entry.code);
      const summary = {};
      for (const objectType of types) {
        summary[objectType] = reindexType(context.db, { tenantId, objectType }, context.actor, context.ip);
      }
      const references = rebuildReferences(context.db, tenantId);
      context.reportProgress({ progress: 100, message: "Reindex complete" }, { force: true });
      return { message: "PDM reindex complete", result: { types: summary, references_rebuilt: references.added } };
    },
    { description: "Reindex PDM search object types and rebuild the reference index" }
  );

  registerHandler(
    PDM_HANDLER_CODES.MAINTENANCE,
    async (context) => {
      const tenantId = context.input.tenant_id ? Number(context.input.tenant_id) : null;
      context.step("maintenance", { progress: 10 });
      const result = runPdmMaintenance(context.db, { tenantId });
      context.reportProgress({ progress: 100, message: "Maintenance complete" }, { force: true });
      return { message: "PDM maintenance complete", result };
    },
    { description: "Prune history, repair orphaned references and refresh caches" }
  );

  return Object.values(PDM_HANDLER_CODES);
}
