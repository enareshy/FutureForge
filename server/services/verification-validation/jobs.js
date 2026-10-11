// Background jobs for the Verification & Validation (V&V) Engine.
//
// Coverage recalculation and stale-evidence scans run on the shared Job
// Scheduling & Execution Engine so they are durable, resumable, observable and
// retryable. Handlers only drive the coverage/revision-impact services; no second
// scheduler is introduced (mirrors requirement-manufacturing/jobs.js).
import { registerHandler } from "../job-execution/handlers.js";
import { submitJob, submitJobAsync } from "../jobs/jobs.js";
import { getJobTypeRow, createJobType, getJobTypeRowAsync, createJobTypeAsync } from "../jobs/types.js";
import { VV_JOB_TYPES, VV_HANDLER_CODES, VV_QUEUE, SOURCE_MODULE } from "./constants.js";
import { recalculateRequirement, recalculateRequirementAsync, recalculateForTestCases, recalculateForTestCasesAsync, recalculateTenantCoverage, recalculateTenantCoverageAsync } from "./coverage.js";
import { scanStaleEvidence, scanStaleEvidenceAsync } from "./revision-impact.js";

export function ensureVvJobTypes(db) {
  let created = 0;
  for (const def of VV_JOB_TYPES) {
    if (getJobTypeRow(db, def.code)) continue;
    createJobType(db, { ...def }, null, null);
    created += 1;
  }
  return { created, total: VV_JOB_TYPES.length };
}

export async function ensureVvJobTypesAsync(db) {
  let created = 0;
  for (const def of VV_JOB_TYPES) {
    if (await getJobTypeRowAsync(db, def.code)) continue;
    await createJobTypeAsync(db, { ...def }, null, null);
    created += 1;
  }
  return { created, total: VV_JOB_TYPES.length };
}

// ── Runnable operations (shared by jobs and the event-driven path) ────────────

// Resolve the work scope from the job input: one requirement, a set of test
// cases, or the whole tenant. Kept here so the periodic/batch job and the API
// always run exactly one implementation.
function coverageParams(params = {}) {
  const requirementRef = params.requirement_id ?? params.requirementId ?? params.requirement_ref ?? params.requirementRef ?? null;
  const testCaseIds = params.test_case_ids ?? params.testCaseIds ?? null;
  return {
    requirementRef: requirementRef === undefined || requirementRef === null || String(requirementRef).trim() === "" ? null : requirementRef,
    testCaseIds: Array.isArray(testCaseIds) ? testCaseIds : null,
  };
}

export function runCoverageRecalc(db, tenantId, params = {}, actor = null, ip = null) {
  const { requirementRef, testCaseIds } = coverageParams(params);
  if (requirementRef !== null) return recalculateRequirement(db, tenantId, requirementRef, actor, ip);
  if (testCaseIds && testCaseIds.length) return recalculateForTestCases(db, tenantId, testCaseIds, actor, ip);
  return recalculateTenantCoverage(db, tenantId, { batchSize: params.batch_size ?? params.batchSize }, actor, ip);
}

export async function runCoverageRecalcAsync(db, tenantId, params = {}, actor = null, ip = null) {
  const { requirementRef, testCaseIds } = coverageParams(params);
  if (requirementRef !== null) return recalculateRequirementAsync(db, tenantId, requirementRef, actor, ip);
  if (testCaseIds && testCaseIds.length) return recalculateForTestCasesAsync(db, tenantId, testCaseIds, actor, ip);
  return recalculateTenantCoverageAsync(db, tenantId, { batchSize: params.batch_size ?? params.batchSize }, actor, ip);
}

export function runStaleEvidenceScan(db, tenantId, params = {}, actor = null, ip = null) {
  return scanStaleEvidence(db, tenantId, { limit: params.limit, requirementId: params.requirement_id ?? params.requirementId }, actor, ip);
}

export async function runStaleEvidenceScanAsync(db, tenantId, params = {}, actor = null, ip = null) {
  return scanStaleEvidenceAsync(db, tenantId, { limit: params.limit, requirementId: params.requirement_id ?? params.requirementId }, actor, ip);
}

// ── Submission helpers ────────────────────────────────────────────────────────

function submit(db, { tenantId, jobTypeCode, handlerParams, actor, ip, priority, idempotencyKey }) {
  return submitJob(
    db,
    {
      job_type_code: jobTypeCode,
      input: { tenant_id: Number(tenantId), ...handlerParams },
      tenant_id: Number(tenantId),
      priority,
      queue: VV_QUEUE,
      idempotency_key: idempotencyKey || undefined,
    },
    { actor, ip }
  );
}

async function submitAsync(db, { tenantId, jobTypeCode, handlerParams, actor, ip, priority, idempotencyKey }) {
  return submitJobAsync(
    db,
    {
      job_type_code: jobTypeCode,
      input: { tenant_id: Number(tenantId), ...handlerParams },
      tenant_id: Number(tenantId),
      priority,
      queue: VV_QUEUE,
      idempotency_key: idempotencyKey || undefined,
    },
    { actor, ip }
  );
}

export function submitCoverageRecalc(db, tenantId, params = {}, actor = null, ip = null) {
  return submit(db, { tenantId, jobTypeCode: "VV_COVERAGE_RECALC", handlerParams: params, actor, ip, priority: "low", idempotencyKey: params.idempotency_key });
}

export async function submitCoverageRecalcAsync(db, tenantId, params = {}, actor = null, ip = null) {
  return submitAsync(db, { tenantId, jobTypeCode: "VV_COVERAGE_RECALC", handlerParams: params, actor, ip, priority: "low", idempotencyKey: params.idempotency_key });
}

export function submitStaleEvidenceScan(db, tenantId, params = {}, actor = null, ip = null) {
  return submit(db, { tenantId, jobTypeCode: "VV_STALE_EVIDENCE_SCAN", handlerParams: params, actor, ip, priority: "low", idempotencyKey: params.idempotency_key });
}

export async function submitStaleEvidenceScanAsync(db, tenantId, params = {}, actor = null, ip = null) {
  return submitAsync(db, { tenantId, jobTypeCode: "VV_STALE_EVIDENCE_SCAN", handlerParams: params, actor, ip, priority: "low", idempotencyKey: params.idempotency_key });
}

// ── Handler registration ──────────────────────────────────────────────────────

function tenantFrom(context) {
  return Number(context.input?.tenant_id ?? context.input?.tenantId ?? context.tenant_id);
}

export function registerVvHandlers() {
  registerHandler(
    VV_HANDLER_CODES.COVERAGE_RECALC,
    async (context) => {
      const tenantId = tenantFrom(context);
      context.step("recalculating V&V requirement coverage", { progress: 10 });
      const summary = await runCoverageRecalcAsync(context.db, tenantId, context.input, context.actor, context.ip);
      const count = summary.processed ?? summary.count ?? (summary.requirements?.length || 0);
      context.reportProgress({ progress: 100, message: `Coverage recalculated for ${count} requirement(s)` }, { force: true });
      return { message: `V&V coverage recalculated for ${count} requirement(s)`, result: summary, last_step: "coverage" };
    },
    { description: "Recalculate planning/execution coverage and requirement V&V status from executions, results, evidence and valid waivers", module: SOURCE_MODULE }
  );

  registerHandler(
    VV_HANDLER_CODES.STALE_EVIDENCE_SCAN,
    async (context) => {
      const tenantId = tenantFrom(context);
      context.step("scanning for stale verification evidence", { progress: 10 });
      const summary = await runStaleEvidenceScanAsync(context.db, tenantId, context.input, context.actor, context.ip);
      context.reportProgress({ progress: 100, message: `Stale evidence scan: ${summary.stale}` }, { force: true });
      return { message: `V&V stale evidence scan found ${summary.stale} stale execution(s)`, result: summary, last_step: "stale-scan" };
    },
    { description: "Detect verification evidence that may be stale after a requirement, test case or product revision change and publish invalidation events", module: SOURCE_MODULE }
  );

  return Object.values(VV_HANDLER_CODES);
}
