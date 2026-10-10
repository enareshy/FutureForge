// Background jobs for the Requirement -> Manufacturing integration.
//
// Analysis, gap sweeps and node-change propagation run on the shared Job
// Scheduling & Execution Engine so they are durable, resumable, observable and
// retryable. Handlers only drive the impact/matrix services (mirrors
// requirement-pdm/jobs.js).
import { registerHandler } from "../job-execution/handlers.js";
import { submitJob, submitJobAsync } from "../jobs/jobs.js";
import { getJobTypeRow, createJobType, getJobTypeRowAsync, createJobTypeAsync } from "../jobs/types.js";
import {
  REQUIREMENT_MANUFACTURING_JOB_TYPES,
  REQUIREMENT_MANUFACTURING_HANDLER_CODES,
  REQUIREMENT_MANUFACTURING_QUEUE,
  REQUIREMENT_MANUFACTURING_EVENT_MAP,
} from "./constants.js";
import { analyzeRequirementImpactAsync, analyzeNodeImpactAsync } from "./impact.js";
import { manufacturingGapsAsync } from "./matrix.js";
import { publishRequirementManufacturingEventAsync } from "./events.js";

export function ensureRequirementManufacturingJobTypes(db) {
  let created = 0;
  for (const def of REQUIREMENT_MANUFACTURING_JOB_TYPES) {
    if (getJobTypeRow(db, def.code)) continue;
    createJobType(db, { ...def }, null, null);
    created += 1;
  }
  return { created };
}

export async function ensureRequirementManufacturingJobTypesAsync(db) {
  let created = 0;
  for (const def of REQUIREMENT_MANUFACTURING_JOB_TYPES) {
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
      queue: REQUIREMENT_MANUFACTURING_QUEUE,
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
      queue: REQUIREMENT_MANUFACTURING_QUEUE,
      idempotency_key: idempotencyKey || undefined,
    },
    { actor, ip }
  );
}

function tenantFrom(context) {
  return Number(context.input.tenant_id ?? context.tenant_id);
}

export function submitImpactAnalysis(db, tenantId, params = {}, actor = null, ip = null) {
  return submit(db, { tenantId, jobTypeCode: "MANUFACTURING_IMPACT_ANALYSIS", handlerParams: params, actor, ip, idempotencyKey: params.idempotency_key || null });
}

export async function submitImpactAnalysisAsync(db, tenantId, params = {}, actor = null, ip = null) {
  return submitAsync(db, { tenantId, jobTypeCode: "MANUFACTURING_IMPACT_ANALYSIS", handlerParams: params, actor, ip, idempotencyKey: params.idempotency_key || null });
}

export function submitGapSweep(db, tenantId, params = {}, actor = null, ip = null) {
  return submit(db, { tenantId, jobTypeCode: "MANUFACTURING_GAP_SWEEP", handlerParams: params, actor, ip, priority: "low", idempotencyKey: params.idempotency_key || null });
}

export async function submitGapSweepAsync(db, tenantId, params = {}, actor = null, ip = null) {
  return submitAsync(db, { tenantId, jobTypeCode: "MANUFACTURING_GAP_SWEEP", handlerParams: params, actor, ip, priority: "low", idempotencyKey: params.idempotency_key || null });
}

export function submitNodeImpact(db, tenantId, params = {}, actor = null, ip = null) {
  return submit(db, { tenantId, jobTypeCode: "MANUFACTURING_NODE_IMPACT", handlerParams: params, actor, ip, idempotencyKey: params.idempotency_key || null });
}

export async function submitNodeImpactAsync(db, tenantId, params = {}, actor = null, ip = null) {
  return submitAsync(db, { tenantId, jobTypeCode: "MANUFACTURING_NODE_IMPACT", handlerParams: params, actor, ip, idempotencyKey: params.idempotency_key || null });
}

// Runs the tenant gap sweep and publishes the gap/synchronized events. Kept here
// (rather than in the event handler) so the periodic job and the event-driven
// path share exactly one implementation.
export async function sweepManufacturingGaps(db, tenantId, params = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const summary = await manufacturingGapsAsync(db, tenant, {
    rules: params.rules ?? null,
    requirementId: params.requirementId ?? params.requirement_id ?? null,
    mbomScanLimit: params.mbomScanLimit ?? params.mbom_scan_limit,
    page: params.page,
    pageSize: params.pageSize ?? params.page_size,
  });
  const hasGaps = Number(summary.total || 0) > 0;
  if (hasGaps) {
    await publishRequirementManufacturingEventAsync(
      db,
      {
        eventType: REQUIREMENT_MANUFACTURING_EVENT_MAP.GAP_DETECTED,
        objectType: "requirement_manufacturing",
        objectId: String(tenant),
        tenantId: tenant,
        payload: { total: summary.total, by_rule: summary.summary?.by_rule || {}, by_severity: summary.summary?.by_severity || {} },
      },
      actor
    );
  }
  await publishRequirementManufacturingEventAsync(
    db,
    {
      eventType: REQUIREMENT_MANUFACTURING_EVENT_MAP.SYNCHRONIZED,
      objectType: "requirement_manufacturing",
      objectId: String(tenant),
      tenantId: tenant,
      payload: { status: hasGaps ? "GAPS_FOUND" : "COMPLETED", total: summary.total },
    },
    actor
  );
  return { status: hasGaps ? "GAPS_FOUND" : "COMPLETED", total: summary.total, summary: summary.summary || { total: 0, by_rule: {}, by_severity: {} } };
}

export function registerRequirementManufacturingHandlers() {
  registerHandler(
    REQUIREMENT_MANUFACTURING_HANDLER_CODES.IMPACT_ANALYSIS,
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
      return { message: `Requirement/Manufacturing impact analysis found ${summary.impacted_count} impacted objects`, result: summary, last_step: "impact" };
    },
    { description: "Classify downstream manufacturing impact of a requirement across product, EBOM, MBOM, BOP, operations, work centers, characteristics, CTQ, documents and changes" }
  );

  registerHandler(
    REQUIREMENT_MANUFACTURING_HANDLER_CODES.GAP_SWEEP,
    async (context) => {
      const tenantId = tenantFrom(context);
      context.step("sweeping traceability gaps", { progress: 10 });
      const summary = await sweepManufacturingGaps(context.db, tenantId, context.input, context.actor, context.ip);
      context.reportProgress({ progress: 100, message: `Gap sweep ${summary.status}` }, { force: true });
      return { message: `Requirement/Manufacturing gap sweep ${summary.status}: ${summary.total} gap(s)`, result: summary, last_step: "gap-sweep" };
    },
    { description: "Evaluate the configured coverage rules across a tenant and publish gap events for missing or invalid links" }
  );

  registerHandler(
    REQUIREMENT_MANUFACTURING_HANDLER_CODES.NODE_IMPACT,
    async (context) => {
      const tenantId = tenantFrom(context);
      context.step("propagating node change to requirements", { progress: 10 });
      const summary = await analyzeNodeImpactAsync(
        context.db,
        tenantId,
        {
          nodeType: context.input.node_type ?? context.input.nodeType,
          nodeId: context.input.node_id ?? context.input.nodeId,
        },
        { maxDepth: context.input.max_depth ?? context.input.maxDepth, analyze: context.input.analyze },
        context.actor,
        context.ip
      );
      context.reportProgress({ progress: 100, message: `Node impact: ${summary.requirement_count} requirement(s)` }, { force: true });
      return { message: `Requirement/Manufacturing node impact reached ${summary.requirement_count} requirement(s)`, result: summary, last_step: "node-impact" };
    },
    { description: "Propagate a manufacturing/PLM node change to the requirements linked to it and classify the impact" }
  );

  return Object.values(REQUIREMENT_MANUFACTURING_HANDLER_CODES);
}
