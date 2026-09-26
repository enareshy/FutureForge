// Background job handlers and maintenance for the Migration & Onboarding
// Framework.
//
// A large onboarding runs for hours or days, so every execution is a durable job
// on the shared Job Scheduling & Execution Engine. The migration job row is the
// operational ledger; a handler simply drives the engine core against it, which
// makes runs resumable, retryable and observable (spec §19, §24, §25).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { registerHandler } from "../job-execution/handlers.js";
import { submitJob } from "../jobs/jobs.js";
import { getJobTypeRow, createJobType } from "../jobs/types.js";
import { MIGRATION_HANDLER_CODES, MIGRATION_JOB_TYPES, CONFIG_DEFAULTS, SOURCE_MODULE } from "./constants.js";
import { runMigrationJob, retryMigrationJob, getJobRow, listMigrationJobs } from "./execution.js";
import { reconcileJob } from "./reconciliation.js";
import { generatePlan } from "./planning.js";
import { resolveDependencies, markDependentsSatisfied } from "./dependencies.js";
import { listConfig } from "./configuration.js";
import { paginate } from "./validation.js";

// ── Job-type registration ────────────────────────────────────────────────────

export function ensureMigrationJobTypes(db) {
  let created = 0;
  for (const def of MIGRATION_JOB_TYPES) {
    if (getJobTypeRow(db, def.code)) continue;
    createJobType(db, { ...def }, null, null);
    created += 1;
  }
  return { created };
}

// ── Submission helpers ───────────────────────────────────────────────────────

function submit(db, { tenantId, jobTypeCode, handlerParams, actor, ip, priority = "normal", queue = "migrations", idempotencyKey = null }) {
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

export function submitMigrationJob(db, { tenantId, migrationJobId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "DATA_MIGRATION", handlerParams: { migration_job_id: Number(migrationJobId) }, actor, ip, idempotencyKey });
}

export function submitValidateJob(db, { tenantId, migrationJobId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "DATA_MIGRATION_VALIDATE", handlerParams: { migration_job_id: Number(migrationJobId) }, actor, ip, idempotencyKey });
}

export function submitReconcileJob(db, { tenantId, migrationJobId, strategy = "COUNT", actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "DATA_MIGRATION_RECONCILE", handlerParams: { migration_job_id: Number(migrationJobId), strategy }, actor, ip, queue: "default", idempotencyKey });
}

export function submitRetryJob(db, { tenantId, migrationJobId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "DATA_MIGRATION_RETRY", handlerParams: { migration_job_id: Number(migrationJobId) }, actor, ip, priority: "high", idempotencyKey });
}

export function submitReplanJob(db, { tenantId, projectId, packageId = null, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "DATA_MIGRATION_REPLAN", handlerParams: { project_id: Number(projectId), package_id: packageId != null ? Number(packageId) : null }, actor, ip, queue: "default", idempotencyKey });
}

export function submitMaintenanceJob(db, { tenantId, actor = null, ip = null, idempotencyKey = null } = {}) {
  return submit(db, { tenantId, jobTypeCode: "DATA_MIGRATION_MAINTENANCE", handlerParams: {}, actor, ip, queue: "default", priority: "low", idempotencyKey });
}

// ── Job ledger query (re-exported convenience) ───────────────────────────────

export function listJobs(db, options = {}) {
  return listMigrationJobs(db, options);
}

// ── Maintenance ──────────────────────────────────────────────────────────────

// Housekeeping for long-running migrations: prune stale checkpoints, promote
// newly-completed packages' dependents, close out stale errors and keep the
// ledger bounded. Never touches business data.
export function runMigrationMaintenance(db, { tenantId = null, limit = 2000 } = {}) {
  const tenantRows = tenantId
    ? [{ tenant_id: Number(tenantId) }]
    : queryAll(db, "SELECT DISTINCT tenant_id FROM mig_jobs WHERE tenant_id IS NOT NULL");
  const summary = { tenants: tenantRows.length, checkpoints_pruned: 0, errors_archived: 0, dependencies_promoted: 0, ran_at: nowIso() };
  const cap = Number(limit) || 2000;
  for (const row of tenantRows) {
    const tenant = Number(row.tenant_id);
    const config = listConfig(db, tenant);
    const keep = Math.max(1, Number(config.max_checkpoints ?? 50));
    const jobs = queryAll(db, "SELECT id FROM mig_jobs WHERE tenant_id = ? ORDER BY id DESC LIMIT ?", [tenant, cap]);
    for (const job of jobs) {
      const checkpoints = queryAll(db, "SELECT id FROM mig_checkpoints WHERE job_id = ? ORDER BY checkpoint_number DESC", [job.id]);
      for (const stale of checkpoints.slice(keep)) {
        run(db, "DELETE FROM mig_checkpoints WHERE id = ?", [stale.id]);
        summary.checkpoints_pruned += 1;
      }
    }
    // Archive old, non-retryable errors so the queue reflects current work.
    const staleBefore = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    summary.errors_archived += run(
      db,
      "UPDATE mig_errors SET status = 'IGNORED', updated_at = ? WHERE tenant_id = ? AND status = 'OPEN' AND retryable = 0 AND created_at < ?",
      [nowIso(), tenant, staleBefore]
    ).changes || 0;
    // Promote dependents of packages that have since completed.
    const completed = queryAll(db, "SELECT id FROM mig_packages WHERE tenant_id = ? AND status = 'COMPLETED' LIMIT ?", [tenant, cap]);
    for (const pkg of completed) {
      summary.dependencies_promoted += Number(markDependentsSatisfied(db, tenant, pkg.id)) || 0;
    }
  }
  void CONFIG_DEFAULTS;
  return summary;
}

// ── Handler registration ─────────────────────────────────────────────────────

function loadJobContext(context) {
  const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
  const jobId = Number(context.input.migration_job_id);
  const job = queryOne(context.db, "SELECT * FROM mig_jobs WHERE id = ?", [jobId]);
  // Background workers do not carry a request actor; authorize as the operator
  // who created the migration run so Data Security policy is still enforced.
  const actor = context.actor || (job?.created_by ? { id: job.created_by } : null);
  return { tenantId, jobId, job, actor };
}

export function registerMigrationHandlers() {
  registerHandler(
    MIGRATION_HANDLER_CODES.EXECUTE,
    async (context) => {
      const { jobId, actor } = loadJobContext(context);
      context.step("migrating", { progress: 10 });
      const job = await runMigrationJob(context.db, { jobId, params: context.input.params || {}, actor, ip: context.ip });
      context.reportProgress({ progress: 100, message: "Migration complete" }, { force: true });
      return { message: "Data migration complete", job };
    },
    { description: "Execute a migration package or definition" }
  );

  registerHandler(
    MIGRATION_HANDLER_CODES.VALIDATE,
    async (context) => {
      const { jobId, actor } = loadJobContext(context);
      context.step("validating", { progress: 10 });
      const job = await runMigrationJob(context.db, { jobId, params: { ...(context.input.params || {}), dry_run: true }, actor, ip: context.ip });
      context.reportProgress({ progress: 100, message: "Validation complete" }, { force: true });
      return { message: "Migration validation complete", job };
    },
    { description: "Validate a migration source without writing" }
  );

  registerHandler(
    MIGRATION_HANDLER_CODES.RECONCILE,
    async (context) => {
      const { tenantId, jobId } = loadJobContext(context);
      context.step("reconciling", { progress: 10 });
      const result = reconcileJob(context.db, { tenantId, jobId, strategy: context.input.strategy || "COUNT" });
      context.reportProgress({ progress: 100, message: "Reconciliation complete" }, { force: true });
      return { message: "Reconciliation complete", result };
    },
    { description: "Reconcile a migration job against its source" }
  );

  registerHandler(
    MIGRATION_HANDLER_CODES.RETRY_FAILED,
    async (context) => {
      const { tenantId, jobId, actor } = loadJobContext(context);
      context.step("retrying", { progress: 10 });
      const result = await retryMigrationJob(context.db, { tenantId, jobId, actor, ip: context.ip });
      context.reportProgress({ progress: 100, message: "Retry complete" }, { force: true });
      return { message: "Retry of failed records complete", result };
    },
    { description: "Retry retryable failed migration records" }
  );

  registerHandler(
    MIGRATION_HANDLER_CODES.REPLAN,
    async (context) => {
      const tenantId = Number(context.input.tenant_id ?? context.tenant_id);
      const projectId = Number(context.input.project_id);
      const project = queryOne(context.db, "SELECT * FROM mig_projects WHERE id = ?", [projectId]);
      context.step("planning", { progress: 10 });
      const plan = generatePlan(context.db, tenantId, project?.project_ref || projectId, {
        actor: context.actor,
        packageId: context.input.package_id != null ? Number(context.input.package_id) : null,
        ip: context.ip,
      });
      context.reportProgress({ progress: 100, message: "Plan generated" }, { force: true });
      return { message: "Migration plan generated", plan };
    },
    { description: "Recompute a dependency-aware migration plan" }
  );

  registerHandler(
    MIGRATION_HANDLER_CODES.MAINTENANCE,
    async (context) => {
      const tenantId = context.input.tenant_id ? Number(context.input.tenant_id) : null;
      context.step("maintenance", { progress: 10 });
      const result = runMigrationMaintenance(context.db, { tenantId });
      context.reportProgress({ progress: 100, message: "Maintenance complete" }, { force: true });
      return { message: "Migration maintenance complete", result };
    },
    { description: "Prune checkpoints, promote dependencies and archive stale errors" }
  );

  return Object.values(MIGRATION_HANDLER_CODES);
}

export { getJobRow, resolveDependencies, generatePlan, paginate };
