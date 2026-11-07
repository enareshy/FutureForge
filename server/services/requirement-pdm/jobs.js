// Background jobs for the Requirement -> PDM integration.
//
// Synchronization runs on the shared Job Scheduling & Execution Engine so PDM
// change sweeps are durable, resumable, observable and retryable. Handlers only
// drive the synchronization service (mirrors pdm/jobs.js).
import { registerHandler } from "../job-execution/handlers.js";
import { submitJob, submitJobAsync } from "../jobs/jobs.js";
import { getJobTypeRow, createJobType, getJobTypeRowAsync, createJobTypeAsync } from "../jobs/types.js";
import { REQUIREMENT_PDM_JOB_TYPES, REQUIREMENT_PDM_HANDLER_CODES } from "./constants.js";
import { synchronize, synchronizeAsync } from "./synchronization.js";
import { analyzeRequirementImpactAsync } from "./impact.js";
import { initiateChangeRequestAsync } from "./change-initiation.js";
import { synchronizeFromPlmAsync } from "./plm-sync.js";

const REQUIREMENT_PDM_QUEUE = "requirement-pdm";

export function ensureRequirementPdmJobTypes(db) {
  let created = 0;
  for (const def of REQUIREMENT_PDM_JOB_TYPES) {
    if (getJobTypeRow(db, def.code)) continue;
    createJobType(db, { ...def }, null, null);
    created += 1;
  }
  return { created };
}

export async function ensureRequirementPdmJobTypesAsync(db) {
  let created = 0;
  for (const def of REQUIREMENT_PDM_JOB_TYPES) {
    if (await getJobTypeRowAsync(db, def.code)) continue;
    await createJobTypeAsync(db, { ...def }, null, null);
    created += 1;
  }
  return { created };
}

function submit(db, { tenantId, jobTypeCode, handlerParams, actor, ip, priority = "normal", idempotencyKey = null }) {
  return submitJob(
    db,
    {
      job_type_code: jobTypeCode,
      input: { tenant_id: Number(tenantId), ...handlerParams },
      tenant_id: Number(tenantId),
      priority,
      queue: REQUIREMENT_PDM_QUEUE,
      idempotency_key: idempotencyKey || undefined,
    },
    { actor, ip }
  );
}

async function submitAsync(db, { tenantId, jobTypeCode, handlerParams, actor, ip, priority = "normal", idempotencyKey = null }) {
  return submitJobAsync(
    db,
    {
      job_type_code: jobTypeCode,
      input: { tenant_id: Number(tenantId), ...handlerParams },
      tenant_id: Number(tenantId),
      priority,
      queue: REQUIREMENT_PDM_QUEUE,
      idempotency_key: idempotencyKey || undefined,
    },
    { actor, ip }
  );
}

function tenantFrom(context) {
  return Number(context.input.tenant_id ?? context.tenant_id);
}

function syncParams(context) {
  return {
    targetType: context.input.target_type || null,
    targetId: context.input.target_id ?? null,
    requirementId: context.input.requirement_id ?? null,
    limit: context.input.limit ?? null,
    asOf: context.input.as_of || null,
  };
}

export function submitSynchronization(db, tenantId, params = {}, actor = null, ip = null) {
  return submit(db, { tenantId, jobTypeCode: "REQUIREMENT_PDM_SYNCHRONIZE", handlerParams: params, actor, ip });
}

export async function submitSynchronizationAsync(db, tenantId, params = {}, actor = null, ip = null) {
  return submitAsync(db, { tenantId, jobTypeCode: "REQUIREMENT_PDM_SYNCHRONIZE", handlerParams: params, actor, ip });
}

export function submitImpactSweep(db, tenantId, params = {}, actor = null, ip = null) {
  return submit(db, { tenantId, jobTypeCode: "REQUIREMENT_PDM_IMPACT_SWEEP", handlerParams: params, actor, ip, priority: "low" });
}

export async function submitImpactSweepAsync(db, tenantId, params = {}, actor = null, ip = null) {
  return submitAsync(db, { tenantId, jobTypeCode: "REQUIREMENT_PDM_IMPACT_SWEEP", handlerParams: params, actor, ip, priority: "low" });
}

export function submitImpactAnalysis(db, tenantId, params = {}, actor = null, ip = null) {
  return submit(db, { tenantId, jobTypeCode: "REQUIREMENT_PLM_IMPACT_ANALYSIS", handlerParams: params, actor, ip, idempotencyKey: params.idempotency_key || null });
}

export async function submitImpactAnalysisAsync(db, tenantId, params = {}, actor = null, ip = null) {
  return submitAsync(db, { tenantId, jobTypeCode: "REQUIREMENT_PLM_IMPACT_ANALYSIS", handlerParams: params, actor, ip, idempotencyKey: params.idempotency_key || null });
}

export function submitChangeInitiation(db, tenantId, params = {}, actor = null, ip = null) {
  return submit(db, { tenantId, jobTypeCode: "REQUIREMENT_PLM_CHANGE_INITIATE", handlerParams: params, actor, ip, idempotencyKey: params.idempotency_key || null });
}

export async function submitChangeInitiationAsync(db, tenantId, params = {}, actor = null, ip = null) {
  return submitAsync(db, { tenantId, jobTypeCode: "REQUIREMENT_PLM_CHANGE_INITIATE", handlerParams: params, actor, ip, idempotencyKey: params.idempotency_key || null });
}

export function submitPlmSynchronization(db, tenantId, params = {}, actor = null, ip = null) {
  return submit(db, { tenantId, jobTypeCode: "REQUIREMENT_PLM_SYNCHRONIZE", handlerParams: params, actor, ip, idempotencyKey: params.idempotency_key || null });
}

export async function submitPlmSynchronizationAsync(db, tenantId, params = {}, actor = null, ip = null) {
  return submitAsync(db, { tenantId, jobTypeCode: "REQUIREMENT_PLM_SYNCHRONIZE", handlerParams: params, actor, ip, idempotencyKey: params.idempotency_key || null });
}

export function registerRequirementPdmHandlers() {
  registerHandler(
    REQUIREMENT_PDM_HANDLER_CODES.SYNCHRONIZE,
    async (context) => {
      const tenantId = tenantFrom(context);
      context.step("synchronizing allocations", { progress: 10 });
      const summary = await synchronizeAsync(context.db, tenantId, syncParams(context), context.actor, context.ip);
      context.reportProgress({ progress: 100, message: `Synchronization ${summary.status}` }, { force: true });
      return { message: `Requirement/PDM synchronization ${summary.status}`, result: summary, last_step: "synchronize" };
    },
    { description: "Re-evaluate requirement allocations against live PDM revision/configuration/effectivity" }
  );

  registerHandler(
    REQUIREMENT_PDM_HANDLER_CODES.IMPACT_SWEEP,
    async (context) => {
      const tenantId = tenantFrom(context);
      context.step("sweeping allocations", { progress: 10 });
      const summary = await synchronizeAsync(context.db, tenantId, { limit: context.input.limit ?? null }, context.actor, context.ip);
      context.reportProgress({ progress: 100, message: `Impact sweep ${summary.status}` }, { force: true });
      return { message: `Requirement/PDM impact sweep ${summary.status}`, result: summary, last_step: "sweep" };
    },
    { description: "Sweep every active requirement allocation in a tenant and report PDM impacts" }
  );

  registerHandler(
    REQUIREMENT_PDM_HANDLER_CODES.IMPACT_ANALYSIS,
    async (context) => {
      const tenantId = tenantFrom(context);
      context.step("analyzing requirement impact", { progress: 10 });
      const requirementRef = context.input.requirement_id ?? context.input.requirementId ?? context.input.requirement_ref;
      const summary = await analyzeRequirementImpactAsync(
        context.db,
        tenantId,
        requirementRef,
        { maxDepth: context.input.max_depth ?? context.input.maxDepth, asOf: context.input.as_of ?? context.input.asOf },
        context.actor,
        context.ip
      );
      context.reportProgress({ progress: 100, message: `Impact analysis: ${summary.impacted_count} objects` }, { force: true });
      return { message: `Requirement/PLM impact analysis found ${summary.impacted_count} impacted objects`, result: summary, last_step: "impact" };
    },
    { description: "Classify downstream PLM impact of a requirement across product, EBOM, MBOM, BOP, documents and changes" }
  );

  registerHandler(
    REQUIREMENT_PDM_HANDLER_CODES.CHANGE_INITIATE,
    async (context) => {
      const tenantId = tenantFrom(context);
      context.step("evaluating change-initiation rules", { progress: 10 });
      const requirementRef = context.input.requirement_id ?? context.input.requirementId ?? context.input.requirement_ref;
      const result = await initiateChangeRequestAsync(
        context.db,
        tenantId,
        requirementRef,
        {
          force: context.input.force,
          severity: context.input.severity,
          require_released: context.input.require_released ?? context.input.requireReleased,
          idempotency_key: context.input.idempotency_key ?? context.input.idempotencyKey,
          max_depth: context.input.max_depth ?? context.input.maxDepth,
        },
        context.actor,
        context.ip
      );
      context.reportProgress({ progress: 100, message: `Change initiation ${result.status}` }, { force: true });
      return { message: `Requirement/PLM change initiation ${result.status}`, result, last_step: "change-initiation" };
    },
    { description: "Evaluate requirement change-initiation rules and raise an existing Change Management request when warranted" }
  );

  registerHandler(
    REQUIREMENT_PDM_HANDLER_CODES.PLM_SYNC,
    async (context) => {
      const tenantId = tenantFrom(context);
      context.step("propagating PLM change to requirements", { progress: 10 });
      const result = await synchronizeFromPlmAsync(
        context.db,
        tenantId,
        {
          nodeType: context.input.node_type ?? context.input.nodeType,
          nodeId: context.input.node_id ?? context.input.nodeId,
          eventType: context.input.event_type ?? context.input.eventType,
          correlationId: context.input.correlation_id ?? context.input.correlationId,
          analyze: context.input.analyze,
          notify: context.input.notify,
          maxDepth: context.input.max_depth ?? context.input.maxDepth,
        },
        context.actor,
        context.ip
      );
      context.reportProgress({ progress: 100, message: `PLM synchronization ${result.status}` }, { force: true });
      return { message: `Requirement/PLM synchronization ${result.status}: ${result.requirement_count} requirement(s)`, result, last_step: "plm-sync" };
    },
    { description: "Propagate a PLM change to the linked requirements and notify their owners" }
  );

  return Object.values(REQUIREMENT_PDM_HANDLER_CODES);
}
