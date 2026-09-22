// Background job handlers for the Data Lifecycle & Archival service.
//
// Evaluation, archive, cold storage, restore, purge, recovery and maintenance
// run on the shared Job Scheduling & Execution Engine so a request never blocks.
// Each run also writes a lifecycle job ledger row (lc_lifecycle_jobs) for
// operational monitoring.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { submitJob } from "../jobs/jobs.js";
import { LIFECYCLE_HANDLER_CODES, SOURCE_MODULE } from "./constants.js";
import { jobRef as makeJobRef } from "./refs.js";
import { publicLifecycleJob } from "./repository.js";
import { evaluateEligibility, listDueObjects } from "./eligibility.js";
import { archiveObject, moveToColdStorage, verifyArchiveIntegrity } from "./archive.js";
import { requestRestore, executeRestore } from "./restore.js";
import { requestRecovery, executeRecovery } from "./recovery.js";
import { executePurge } from "./purge.js";
import { expireLegalHolds } from "./legal-holds.js";
import { applyRetention } from "./objects.js";
import { listConfig } from "./configuration.js";
import { paginate } from "./validation.js";

// ── Ledger ───────────────────────────────────────────────────────────────────

export function ensureJobLedger(db, { jobRef: ref, tenantId, jobType, params = {}, createdBy = null }) {
  const existing = queryOne(db, "SELECT * FROM lc_lifecycle_jobs WHERE tenant_id = ? AND job_ref = ?", [Number(tenantId), String(ref)]);
  if (existing) return existing;
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO lc_lifecycle_jobs (job_ref, tenant_id, job_type, status, object_count, params_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, ?, ?)`,
    [String(ref), Number(tenantId), jobType, Number(params.object_count || 0), JSON.stringify(params), createdBy, ts, ts]
  );
  return queryOne(db, "SELECT * FROM lc_lifecycle_jobs WHERE id = ?", [Number(result.lastInsertRowid)]);
}

export function finalizeJobLedger(db, { jobRef: ref, tenantId, status, result = {}, counts = {} }) {
  const row = queryOne(db, "SELECT * FROM lc_lifecycle_jobs WHERE tenant_id = ? AND job_ref = ?", [Number(tenantId), String(ref)]);
  if (!row) return null;
  const ts = nowIso();
  run(
    db,
    `UPDATE lc_lifecycle_jobs SET status = ?, success_count = ?, failure_count = ?, error_count = ?, result_json = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
    [
      status,
      Number(counts.success || 0),
      Number(counts.failure || 0),
      Number(counts.error || 0),
      JSON.stringify(result),
      status === "RUNNING" ? null : ts,
      ts,
      row.id,
    ]
  );
  return publicLifecycleJob(queryOne(db, "SELECT * FROM lc_lifecycle_jobs WHERE id = ?", [row.id]));
}

export function listLifecycleJobs(db, { tenantId, status, jobType, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(String(status).toUpperCase());
  }
  if (jobType) {
    clauses.push("job_type = ?");
    params.push(String(jobType).toUpperCase());
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM lc_lifecycle_jobs ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM lc_lifecycle_jobs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicLifecycleJob), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function getLifecycleJob(db, tenantId, ref) {
  const row = queryOne(db, "SELECT * FROM lc_lifecycle_jobs WHERE tenant_id = ? AND (job_ref = ? OR CAST(id AS TEXT) = ?)", [
    Number(tenantId),
    String(ref),
    String(ref),
  ]);
  return row ? publicLifecycleJob(row) : null;
}

// ── Submission helpers ───────────────────────────────────────────────────────

function submit(db, { tenantId, jobTypeCode, handlerParams, actor, ip, priority = "normal", idempotencyKey = null }) {
  return submitJob(
    db,
    {
      job_type_code: jobTypeCode,
      payload: { tenant_id: Number(tenantId), ...handlerParams },
      tenant_id: Number(tenantId),
      priority,
      queue: "default",
      idempotency_key: idempotencyKey || undefined,
    },
    { actor, ip }
  );
}

export function submitEvaluationJob(db, { tenantId, actions = ["ARCHIVE", "PURGE"], limit = null, apply = false, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, {
    tenantId,
    jobTypeCode: "LIFECYCLE_EVALUATION",
    handlerParams: { actions, limit, apply },
    actor,
    ip,
    idempotencyKey,
  });
}

export function submitArchiveJob(db, { tenantId, objects = null, limit = null, force = false, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "LIFECYCLE_ARCHIVE", handlerParams: { objects, limit, force }, actor, ip, idempotencyKey });
}

export function submitColdStorageJob(db, { tenantId, objects = null, limit = null, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "LIFECYCLE_COLD_STORAGE", handlerParams: { objects, limit }, actor, ip, idempotencyKey });
}

export function submitRestoreJob(db, { tenantId, objects = null, restoreRef = null, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "LIFECYCLE_RESTORE", handlerParams: { objects, restore_ref: restoreRef }, actor, ip, idempotencyKey, priority: "high" });
}

export function submitPurgeJob(db, { tenantId, objects = null, limit = null, force = false, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "LIFECYCLE_PURGE", handlerParams: { objects, limit, force }, actor, ip, idempotencyKey, priority: "high" });
}

export function submitRecoveryJob(db, { tenantId, objectType = "", objectId = null, recoveryPointRef = "", scope = "", actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, {
    tenantId,
    jobTypeCode: "LIFECYCLE_RECOVERY",
    handlerParams: { object_type: objectType, object_id: objectId, recovery_point_ref: recoveryPointRef, scope },
    actor,
    ip,
    idempotencyKey,
    priority: "high",
  });
}

export function submitMaintenanceJob(db, { tenantId, actor = null, ip = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "LIFECYCLE_MAINTENANCE", handlerParams: {}, actor, ip, priority: "low" });
}

// ── Bounded work runners ─────────────────────────────────────────────────────

function objectListFromParams(db, tenantId, params, action) {
  if (Array.isArray(params.objects) && params.objects.length) {
    return params.objects.map((entry) => ({ object_type: entry.object_type ?? entry.objectType, object_id: entry.object_id ?? entry.objectId }));
  }
  const due = listDueObjects(db, { tenantId, action, limit: params.limit || 500 });
  return due.items.map((row) => ({ object_type: row.object_type, object_id: row.object_id }));
}

export async function runEvaluation(db, { tenantId, actions = ["ARCHIVE", "PURGE"], limit = 500, apply = false } = {}) {
  const summary = { evaluated: 0, eligible: 0, blocked: 0, archived: 0, cold_storage: 0, purged: 0, errors: 0 };
  for (const action of actions) {
    const due = listDueObjects(db, { tenantId, action, limit });
    for (const row of due.items) {
      summary.evaluated += 1;
      const evaluation = evaluateEligibility(db, { tenantId, objectType: row.object_type, objectId: row.object_id, action });
      if (!evaluation.eligible) {
        summary.blocked += 1;
        continue;
      }
      summary.eligible += 1;
      if (!apply) continue;
      const policyAction = action === "ARCHIVE" ? evaluation.policy_ref : null;
      try {
        if (action === "ARCHIVE") {
          await archiveObject(db, { tenantId, objectType: row.object_type, objectId: row.object_id, reason: "automatic evaluation" });
          summary.archived += 1;
        } else if (action === "COLD_STORAGE") {
          moveToColdStorage(db, { tenantId, objectType: row.object_type, objectId: row.object_id, reason: "automatic evaluation" });
          summary.cold_storage += 1;
        } else if (action === "PURGE") {
          await executePurge(db, { tenantId, objectType: row.object_type, objectId: row.object_id, reason: "automatic evaluation" });
          summary.purged += 1;
        }
      } catch {
        summary.errors += 1;
      }
      void policyAction;
    }
  }
  return summary;
}

export async function runArchiveBatch(db, { tenantId, params = {} } = {}) {
  const targets = objectListFromParams(db, tenantId, params, "ARCHIVE");
  const counts = { success: 0, failure: 0, error: 0 };
  for (const target of targets) {
    try {
      await archiveObject(db, { tenantId, objectType: target.object_type, objectId: target.object_id, reason: params.reason || "batch archive", force: Boolean(params.force) });
      counts.success += 1;
    } catch (error) {
      if (error.code === "INVALID_DATA_LIFECYCLE_ARCHIVE" || error.code === "DATA_LIFECYCLE_ARCHIVE_FAILED") counts.failure += 1;
      else counts.error += 1;
    }
  }
  return { processed: targets.length, ...counts };
}

export function runColdStorageBatch(db, { tenantId, params = {} } = {}) {
  const targets = objectListFromParams(db, tenantId, params, "COLD_STORAGE");
  const counts = { success: 0, failure: 0, error: 0 };
  for (const target of targets) {
    try {
      moveToColdStorage(db, { tenantId, objectType: target.object_type, objectId: target.object_id, reason: "batch cold storage", force: Boolean(params.force) });
      counts.success += 1;
    } catch {
      counts.failure += 1;
    }
  }
  return { processed: targets.length, ...counts };
}

export async function runRestoreBatch(db, { tenantId, params = {} } = {}) {
  const counts = { success: 0, failure: 0, error: 0 };
  const refs = [];
  if (params.restore_ref) refs.push(params.restore_ref);
  if (Array.isArray(params.objects)) {
    for (const entry of params.objects) {
      const { row } = requestRestore(db, {
        tenantId,
        objectType: entry.object_type ?? entry.objectType,
        objectId: entry.object_id ?? entry.objectId,
        conflictStrategy: entry.conflict_strategy || entry.conflictStrategy || "FAIL",
      });
      refs.push(row.restore_ref);
    }
  }
  for (const ref of refs) {
    try {
      await executeRestore(db, { tenantId, restoreRef: ref, force: Boolean(params.force) });
      counts.success += 1;
    } catch {
      counts.failure += 1;
    }
  }
  return { processed: refs.length, ...counts };
}

export async function runPurgeBatch(db, { tenantId, params = {} } = {}) {
  const targets = objectListFromParams(db, tenantId, params, "PURGE");
  const counts = { success: 0, failure: 0, error: 0 };
  for (const target of targets) {
    try {
      await executePurge(db, { tenantId, objectType: target.object_type, objectId: target.object_id, reason: params.reason || "batch purge", force: Boolean(params.force) });
      counts.success += 1;
    } catch (error) {
      if (error.code === "DATA_LIFECYCLE_PURGE_DENIED") counts.failure += 1;
      else counts.error += 1;
    }
  }
  return { processed: targets.length, ...counts };
}

export async function runRecoveryBatch(db, { tenantId, params = {} } = {}) {
  const record = requestRecovery(db, {
    tenantId,
    providerCode: params.provider_code || null,
    recoveryPointRef: params.recovery_point_ref || "",
    scope: params.scope || "",
    objectType: params.object_type || "",
    objectId: params.object_id ?? null,
    details: params.details || {},
  });
  const result = await executeRecovery(db, { tenantId, recoveryRef: record.recovery_ref });
  return { processed: 1, success: result.status === "completed" ? 1 : 0, failure: result.status === "completed" ? 0 : 1, error: 0, recovery_ref: record.recovery_ref };
}

// Maintenance across tenants: expire legal holds, recompute retention for
// objects lacking a schedule, and verify a bounded sample of archive integrity.
export async function runLifecycleMaintenance(db, { tenantId = null, limit = 2000 } = {}) {
  const tenantRows = tenantId
    ? [{ tenant_id: Number(tenantId) }]
    : queryAll(db, "SELECT DISTINCT tenant_id FROM lc_object_lifecycle WHERE tenant_id IS NOT NULL");
  const summary = { tenants: tenantRows.length, expired_holds: 0, retention_recomputed: 0, archives_verified: 0, archive_failures: 0 };
  for (const row of tenantRows) {
    const tenant = row.tenant_id;
    const config = listConfig(db, tenant);
    if (config.legal_hold_auto_expire !== false) {
      summary.expired_holds += expireLegalHolds(db, { tenantId: tenant, limit }).expired;
    }
    const stale = queryAll(
      db,
      `SELECT * FROM lc_object_lifecycle WHERE tenant_id = ? AND (retention_anchor IS NULL OR archive_eligible_at IS NULL) AND current_state NOT IN ('PURGED') LIMIT ?`,
      [Number(tenant), Number(limit) || 2000]
    );
    for (const object of stale) {
      try {
        applyRetention(db, tenant, object.object_type, object.object_id, {});
        summary.retention_recomputed += 1;
      } catch {
        /* leave for the next sweep */
      }
    }
    const sample = queryAll(db, "SELECT * FROM lc_archive_records WHERE tenant_id = ? AND status = 'stored' ORDER BY id DESC LIMIT ?", [
      Number(tenant),
      Math.min(Number(limit) || 2000, 50),
    ]);
    for (const archive of sample) {
      const result = await verifyArchiveIntegrity(db, tenant, archive.archive_ref);
      summary.archives_verified += 1;
      if (!result.ok) summary.archive_failures += 1;
    }
  }
  return { ...summary, ran_at: nowIso() };
}

// ── Handler registration ─────────────────────────────────────────────────────

export function registerLifecycleHandlers() {
  registerHandler(
    LIFECYCLE_HANDLER_CODES.EVALUATION,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      const ref = context.job_ref || makeJobRef("EVALUATION");
      ensureJobLedger(context.db, { jobRef: ref, tenantId, jobType: "LIFECYCLE_EVALUATION", params: context.input });
      context.step("evaluating", { progress: 10 });
      const result = await runEvaluation(context.db, {
        tenantId,
        actions: Array.isArray(context.input.actions) ? context.input.actions : ["ARCHIVE", "PURGE"],
        limit: context.input.limit || 500,
        apply: Boolean(context.input.apply),
      });
      finalizeJobLedger(context.db, { jobRef: ref, tenantId, status: "COMPLETED", result, counts: { success: result.eligible, failure: result.blocked, error: result.errors } });
      context.reportProgress({ progress: 100, message: "Evaluation complete" }, { force: true });
      return { message: "Lifecycle evaluation complete", result };
    },
    { description: "Evaluate lifecycle eligibility in batch" }
  );

  registerHandler(
    LIFECYCLE_HANDLER_CODES.ARCHIVE,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      const ref = context.job_ref || makeJobRef("ARCHIVE");
      ensureJobLedger(context.db, { jobRef: ref, tenantId, jobType: "LIFECYCLE_ARCHIVE", params: context.input });
      context.step("archiving", { progress: 10 });
      const result = await runArchiveBatch(context.db, { tenantId, params: context.input });
      finalizeJobLedger(context.db, { jobRef: ref, tenantId, status: result.error ? "PARTIAL" : "COMPLETED", result, counts: result });
      context.reportProgress({ progress: 100, message: "Archive batch complete" }, { force: true });
      return { message: "Lifecycle archive batch complete", result };
    },
    { description: "Archive eligible business objects" }
  );

  registerHandler(
    LIFECYCLE_HANDLER_CODES.COLD_STORAGE,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      const ref = context.job_ref || makeJobRef("COLD_STORAGE");
      ensureJobLedger(context.db, { jobRef: ref, tenantId, jobType: "LIFECYCLE_COLD_STORAGE", params: context.input });
      context.step("cold_storage", { progress: 10 });
      const result = runColdStorageBatch(context.db, { tenantId, params: context.input });
      finalizeJobLedger(context.db, { jobRef: ref, tenantId, status: "COMPLETED", result, counts: result });
      context.reportProgress({ progress: 100, message: "Cold storage complete" }, { force: true });
      return { message: "Lifecycle cold storage complete", result };
    },
    { description: "Move archived objects to cold storage" }
  );

  registerHandler(
    LIFECYCLE_HANDLER_CODES.RESTORE,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      const ref = context.job_ref || makeJobRef("RESTORE");
      ensureJobLedger(context.db, { jobRef: ref, tenantId, jobType: "LIFECYCLE_RESTORE", params: context.input });
      context.step("restoring", { progress: 10 });
      const result = await runRestoreBatch(context.db, { tenantId, params: context.input });
      finalizeJobLedger(context.db, { jobRef: ref, tenantId, status: result.error ? "PARTIAL" : "COMPLETED", result, counts: result });
      context.reportProgress({ progress: 100, message: "Restore complete" }, { force: true });
      return { message: "Lifecycle restore complete", result };
    },
    { description: "Restore archived objects" }
  );

  registerHandler(
    LIFECYCLE_HANDLER_CODES.PURGE,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      const ref = context.job_ref || makeJobRef("PURGE");
      ensureJobLedger(context.db, { jobRef: ref, tenantId, jobType: "LIFECYCLE_PURGE", params: context.input });
      context.step("purging", { progress: 10 });
      const result = await runPurgeBatch(context.db, { tenantId, params: context.input });
      finalizeJobLedger(context.db, { jobRef: ref, tenantId, status: result.failure || result.error ? "PARTIAL" : "COMPLETED", result, counts: result });
      context.reportProgress({ progress: 100, message: "Purge complete" }, { force: true });
      return { message: "Lifecycle purge complete", result };
    },
    { description: "Purge eligible business objects" }
  );

  registerHandler(
    LIFECYCLE_HANDLER_CODES.RECOVERY,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      const ref = context.job_ref || makeJobRef("RECOVERY");
      ensureJobLedger(context.db, { jobRef: ref, tenantId, jobType: "LIFECYCLE_RECOVERY", params: context.input });
      context.step("recovering", { progress: 10 });
      const result = await runRecoveryBatch(context.db, { tenantId, params: context.input });
      finalizeJobLedger(context.db, { jobRef: ref, tenantId, status: result.success ? "COMPLETED" : "FAILED", result, counts: result });
      context.reportProgress({ progress: 100, message: "Recovery complete" }, { force: true });
      return { message: "Lifecycle recovery complete", result };
    },
    { description: "Recover business data" }
  );

  registerHandler(
    LIFECYCLE_HANDLER_CODES.MAINTENANCE,
    async (context) => {
      const tenantId = context.input.tenant_id ? Number(context.input.tenant_id) : null;
      const ref = context.job_ref || makeJobRef("MAINTENANCE");
      if (tenantId) ensureJobLedger(context.db, { jobRef: ref, tenantId, jobType: "LIFECYCLE_MAINTENANCE", params: context.input });
      context.step("maintenance", { progress: 10 });
      const result = await runLifecycleMaintenance(context.db, { tenantId });
      if (tenantId) finalizeJobLedger(context.db, { jobRef: ref, tenantId, status: "COMPLETED", result, counts: { success: result.retention_recomputed } });
      context.reportProgress({ progress: 100, message: "Maintenance complete" }, { force: true });
      return { message: "Lifecycle maintenance complete", result };
    },
    { description: "Converge lifecycle dates and expire legal holds" }
  );

  return Object.values(LIFECYCLE_HANDLER_CODES);
}
