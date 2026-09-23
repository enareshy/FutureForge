// Background jobs for the Enterprise Classification Framework.
//
// Bulk assignment/reclassification, bulk validation, duplicate scans and
// maintenance all run on the shared Job Scheduling & Execution Engine so they are
// durable, resumable, observable and retryable. Handlers only drive the engine
// core against classification data.
import { queryAll, run, nowIso } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { submitJob } from "../jobs/jobs.js";
import { getJobTypeRow, createJobType } from "../jobs/types.js";
import { CLASSIFICATION_HANDLER_CODES, CLASSIFICATION_JOB_TYPES, MAX_BULK_OBJECTS } from "./constants.js";
import { getConfig } from "./configuration.js";
import { assignClass, unassign } from "./assignments.js";
import { validateBatch } from "./validation-service.js";
import { detectClassificationDuplicates } from "./duplicates.js";
import { invalidate, bumpEpoch } from "./cache.js";
import { publishClassificationEvent, classificationEventCode } from "./events.js";
import { normalizeText, normalizeUpper } from "./validation.js";

export function ensureClassificationJobTypes(db) {
  let created = 0;
  for (const def of CLASSIFICATION_JOB_TYPES) {
    if (getJobTypeRow(db, def.code)) continue;
    createJobType(db, { ...def }, null, null);
    created += 1;
  }
  return { created };
}

function submit(db, { tenantId, jobTypeCode, handlerParams, actor, ip, priority = "normal", queue = "classification", idempotencyKey = null }) {
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

export function submitBulkAssignJob(db, { tenantId, classId, objectType, objectIds = [], values = null, action = "ASSIGN", actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, {
    tenantId,
    jobTypeCode: "CLASSIFICATION_BULK_ASSIGN",
    handlerParams: { class_id: Number(classId), object_type: objectType, object_ids: objectIds, values, action },
    actor,
    ip,
    idempotencyKey,
  });
}

export function submitBulkValidateJob(db, { tenantId, objectType, objectIds = [], actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, {
    tenantId,
    jobTypeCode: "CLASSIFICATION_BULK_VALIDATE",
    handlerParams: { object_type: objectType, object_ids: objectIds },
    actor,
    ip,
    idempotencyKey,
  });
}

export function submitDuplicateScanJob(db, { tenantId, classRef = null, objectType = null, threshold = null, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, {
    tenantId,
    jobTypeCode: "CLASSIFICATION_DUPLICATE_SCAN",
    handlerParams: { class_ref: classRef, object_type: objectType, threshold },
    actor,
    ip,
    priority: "low",
    idempotencyKey,
  });
}

export function submitMaintenanceJob(db, { tenantId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, {
    tenantId,
    jobTypeCode: "CLASSIFICATION_MAINTENANCE",
    handlerParams: {},
    actor,
    ip,
    priority: "low",
    queue: "default",
    idempotencyKey,
  });
}

// ── Synchronous cores (also used by the handlers) ────────────────────────────

export function bulkAssign(db, tenantId, { classId, objectType, objectIds = [], values = null, action = "ASSIGN", actor = null, ip = null, onProgress = null } = {}) {
  const ids = [...new Set((objectIds || []).map((id) => normalizeText(id, { max: 300 })).filter(Boolean))];
  const max = Number(getConfig(db, tenantId, "max_bulk_objects") ?? MAX_BULK_OBJECTS);
  if (ids.length > max) ids.length = max;
  const batchSize = Number(getConfig(db, tenantId, "bulk_batch_size") ?? 500);
  const summary = { action: normalizeUpper(action), class_id: classId, object_type: objectType, requested: ids.length, succeeded: 0, failed: 0, errors: [] };
  for (let index = 0; index < ids.length; index += batchSize) {
    const batch = ids.slice(index, index + batchSize);
    for (const objectId of batch) {
      try {
        if (summary.action === "UNASSIGN") {
          const existing = queryAll(db, "SELECT id FROM cla_assignments WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND class_id = ? AND status = 'ACTIVE'", [Number(tenantId), normalizeText(objectType, { max: 120 }), objectId, Number(classId)]);
          for (const row of existing) unassign(db, tenantId, row.id, actor, ip);
        } else {
          assignClass(db, tenantId, { object_type: objectType, object_id: objectId, class_id: classId, values: values || null, validate: false }, actor, ip);
        }
        summary.succeeded += 1;
      } catch (error) {
        summary.failed += 1;
        if (summary.errors.length < 100) summary.errors.push({ object_id: objectId, message: error.message });
      }
    }
    if (typeof onProgress === "function") onProgress(Math.round(((index + batch.length) / Math.max(1, ids.length)) * 90) + 5);
  }
  publishClassificationEvent(db, { eventType: classificationEventCode("BULK_COMPLETED"), payload: { ...summary, errors: summary.errors.length }, objectType: normalizeText(objectType, { max: 120 }), objectId: null, tenantId }, actor);
  return summary;
}

export function bulkValidate(db, tenantId, { objectType, objectIds = [] } = {}) {
  return validateBatch(db, tenantId, { objectType, objectIds });
}

export function runMaintenance(db, { tenantId = null, limit = 2000 } = {}) {
  const tenantRows = tenantId
    ? [{ tenant_id: Number(tenantId) }]
    : queryAll(db, "SELECT DISTINCT tenant_id FROM cla_assignments WHERE tenant_id IS NOT NULL");
  const summary = { tenants: tenantRows.length, history_pruned: 0, orphans_pruned: 0, ran_at: nowIso() };
  for (const row of tenantRows) {
    const tenant = Number(row.tenant_id);
    const retentionDays = Number(getConfig(db, tenant, "history_retention_days") ?? 365);
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    summary.history_pruned += run(db, "DELETE FROM cla_change_history WHERE tenant_id = ? AND created_at < ?", [tenant, cutoff]).changes || 0;
    summary.orphans_pruned += run(
      db,
      "DELETE FROM cla_assignment_values WHERE tenant_id = ? AND assignment_id NOT IN (SELECT id FROM cla_assignments)",
      [tenant]
    ).changes || 0;
    invalidate(tenant);
    bumpEpoch(tenant);
    void limit;
  }
  return summary;
}

// ── Handler registration ─────────────────────────────────────────────────────

export function registerClassificationHandlers() {
  registerHandler(
    CLASSIFICATION_HANDLER_CODES.BULK_ASSIGN,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("assigning", { progress: 5 });
      const result = bulkAssign(context.db, tenantId, {
        classId: Number(context.input.class_id),
        objectType: context.input.object_type,
        objectIds: context.input.object_ids || [],
        values: context.input.values || null,
        action: context.input.action || "ASSIGN",
        actor: context.actor,
        ip: context.ip,
        onProgress: (progress) => {
          try {
            context.reportProgress({ progress });
          } catch {
            // progress reporting is best-effort
          }
        },
      });
      context.reportProgress({ progress: 100, message: "Bulk classification complete" }, { force: true });
      return { message: "Bulk classification complete", result };
    },
    { description: "Assign or unassign a class to many objects" }
  );

  registerHandler(
    CLASSIFICATION_HANDLER_CODES.BULK_VALIDATE,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("validating", { progress: 10 });
      const result = bulkValidate(context.db, tenantId, { objectType: context.input.object_type, objectIds: context.input.object_ids || [] });
      context.reportProgress({ progress: 100, message: "Bulk validation complete" }, { force: true });
      return { message: "Bulk classification validation complete", result };
    },
    { description: "Validate many classified objects" }
  );

  registerHandler(
    CLASSIFICATION_HANDLER_CODES.DUPLICATE_SCAN,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      context.step("scanning", { progress: 10 });
      const result = detectClassificationDuplicates(context.db, {
        tenantId,
        classRef: context.input.class_ref != null ? Number(context.input.class_ref) : null,
        objectType: context.input.object_type || null,
        threshold: context.input.threshold != null ? Number(context.input.threshold) : null,
        actor: context.actor,
      });
      context.reportProgress({ progress: 100, message: "Duplicate scan complete" }, { force: true });
      return { message: "Classification duplicate scan complete", detected: result.detected, scanned: result.scanned };
    },
    { description: "Detect duplicate classified objects" }
  );

  registerHandler(
    CLASSIFICATION_HANDLER_CODES.MAINTENANCE,
    async (context) => {
      const tenantId = context.input.tenant_id ? Number(context.input.tenant_id) : null;
      context.step("maintenance", { progress: 10 });
      const result = runMaintenance(context.db, { tenantId });
      context.reportProgress({ progress: 100, message: "Maintenance complete" }, { force: true });
      return { message: "Classification maintenance complete", result };
    },
    { description: "Prune history, repair orphans and refresh caches" }
  );

  return Object.values(CLASSIFICATION_HANDLER_CODES);
}
