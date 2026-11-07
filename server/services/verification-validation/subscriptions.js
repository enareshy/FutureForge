// Event-driven triggers for the Verification & Validation (V&V) Engine.
//
// Two subscriptions flow through the shared Event & Messaging Framework; no
// polling loop and no second event system is introduced (mirrors
// requirement-manufacturing/subscriptions.js):
//
//  1. `vv-event-*` — our own execution/result/waiver/approval events. A completed
//     execution, a recorded/evaluated result, an approved test case or an
//     approved/revoked waiver all change requirement coverage, so the handler
//     recalculates the affected requirement(s).
//  2. `vv-req-*` — requirement lifecycle events (revised/updated/released). A new
//     requirement revision can leave evidence stale, so the handler flags the
//     requirement's potentially stale evidence (history is never deleted) and
//     recalculates its coverage.
import { registerHandler } from "../events/handlers.js";
import { createSubscription, createSubscriptionAsync, getSubscriptionRow, getSubscriptionRowAsync } from "../events/subscriptions.js";
import { getEventTypeRow, getEventTypeRowAsync } from "../events/registry.js";
import { queryOneAsync } from "../../db-async.js";
import { Requirements as RequirementService } from "../requirements/index.js";
import { recalculateRequirementAsync, recalculateForTestCasesAsync } from "./coverage.js";
import { scanStaleEvidenceAsync } from "./revision-impact.js";
import { SOURCE_MODULE, VV_INTEGRATION, VV_EVENT_SUBSCRIPTIONS, VV_REQUIREMENT_SUBSCRIPTIONS } from "./constants.js";

const COVERAGE_EVENTS = new Set(VV_EVENT_SUBSCRIPTIONS.map((entry) => entry.event_type_code));
const REQUIREMENT_EVENTS = new Set(VV_REQUIREMENT_SUBSCRIPTIONS.map((entry) => entry.event_type_code));

// ── Own V&V event -> affected requirement coverage recalculation ──────────────

function positiveInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// Resolves the test cases whose coverage must be re-evaluated from an event. The
// payload carries the id directly for some events (a test execution); for a
// result event we resolve it through the result -> execution row. This is the
// only lookup performed, and it is a PK/index read.
async function testCaseIdsForEvent(db, tenant, event, payload) {
  const ids = new Set();
  const direct = positiveInt(payload?.test_case_id ?? payload?.testCaseId);
  if (direct) ids.add(direct);

  const sourceType = String(event?.source_object_type || "").toLowerCase();
  const sourceId = positiveInt(event?.source_object_id);
  if (!ids.size && sourceId) {
    if (sourceType === "test_case") {
      ids.add(sourceId);
    } else if (sourceType === "test_execution") {
      const row = await queryOneAsync(db, "SELECT test_case_id FROM vv_executions WHERE id = ? AND tenant_id = ?", [sourceId, tenant]);
      const testCaseId = positiveInt(row?.test_case_id);
      if (testCaseId) ids.add(testCaseId);
    } else if (sourceType === "test_result") {
      const row = await queryOneAsync(
        db,
        `SELECT e.test_case_id AS test_case_id
           FROM vv_results r JOIN vv_executions e ON e.id = r.execution_id
          WHERE r.id = ? AND r.tenant_id = ?`,
        [sourceId, tenant]
      );
      const testCaseId = positiveInt(row?.test_case_id);
      if (testCaseId) ids.add(testCaseId);
    }
  }
  return [...ids];
}

export function registerVvCoverageEventHandler() {
  registerHandler(
    VV_INTEGRATION.coverageHandler,
    async ({ db, event, payload }) => {
      const eventTypeCode = event?.event_type_code || "";
      if (!COVERAGE_EVENTS.has(eventTypeCode)) {
        return { skipped: true, reason: "unsubscribed_event", event_type_code: eventTypeCode };
      }
      const tenantId = Number(event?.tenant_id ?? payload?.tenant_id ?? 0);
      if (!tenantId) return { skipped: true, reason: "insufficient_event_context", event_type_code: eventTypeCode };

      const requirementRef = payload?.requirement_ref ?? payload?.requirementRef ?? null;
      if (requirementRef !== null && requirementRef !== undefined && String(requirementRef).trim() !== "") {
        const result = await recalculateRequirementAsync(db, tenantId, requirementRef, null, null);
        return { event_type_code: eventTypeCode, scope: "requirement", requirement_ref: requirementRef, vnv_status: result.vnv_status, changed: result.changed };
      }

      const testCaseIds = await testCaseIdsForEvent(db, tenantId, event, payload);
      if (testCaseIds.length) {
        const summary = await recalculateForTestCasesAsync(db, tenantId, testCaseIds, null, null);
        return { event_type_code: eventTypeCode, scope: "test_cases", test_case_count: testCaseIds.length, requirement_count: summary.count };
      }
      return { skipped: true, reason: "insufficient_event_context", event_type_code: eventTypeCode };
    },
    { description: "Recalculate requirement V&V coverage when a test case is approved, an execution completes, a result is recorded/evaluated or a waiver is approved/revoked", module: SOURCE_MODULE }
  );
  return VV_INTEGRATION.coverageHandler;
}

function coverageSubscriptionCode(eventTypeCode) {
  return `${VV_INTEGRATION.subscriptionPrefix}-event-${String(eventTypeCode).toLowerCase()}`;
}

function coverageSubscriptionBody(definition) {
  return {
    name: `V&V coverage: ${definition.event_type_code}`,
    description: "Recalculate requirement V&V coverage and status for the requirement(s) affected by this event.",
    subscriber: SOURCE_MODULE,
    event_type_code: definition.event_type_code,
    handler: VV_INTEGRATION.coverageHandler,
    queue_code: "event-consumers",
    consumer_group: SOURCE_MODULE,
    status: "active",
  };
}

export function ensureVvEventSubscriptions(db) {
  let created = 0;
  let skipped = 0;
  for (const definition of VV_EVENT_SUBSCRIPTIONS) {
    if (!getEventTypeRow(db, definition.event_type_code)) {
      skipped += 1;
      continue;
    }
    const code = coverageSubscriptionCode(definition.event_type_code);
    if (getSubscriptionRow(db, code)) continue;
    createSubscription(db, { code, ...coverageSubscriptionBody(definition) }, null, null);
    created += 1;
  }
  return { created, skipped, total: VV_EVENT_SUBSCRIPTIONS.length };
}

export async function ensureVvEventSubscriptionsAsync(db) {
  let created = 0;
  let skipped = 0;
  for (const definition of VV_EVENT_SUBSCRIPTIONS) {
    if (!(await getEventTypeRowAsync(db, definition.event_type_code))) {
      skipped += 1;
      continue;
    }
    const code = coverageSubscriptionCode(definition.event_type_code);
    if (await getSubscriptionRowAsync(db, code)) continue;
    await createSubscriptionAsync(db, { code, ...coverageSubscriptionBody(definition) }, null, null);
    created += 1;
  }
  return { created, skipped, total: VV_EVENT_SUBSCRIPTIONS.length };
}

// ── Requirement lifecycle event -> stale evidence + coverage ──────────────────

function requirementRefFrom(event, payload) {
  if (payload && typeof payload === "object") {
    const ref = payload.requirement_id ?? payload.requirementId ?? payload.requirement_ref ?? payload.requirementRef ?? payload.id;
    if (ref !== undefined && ref !== null && String(ref).trim() !== "") return ref;
  }
  return event?.source_object_id ?? null;
}

export function registerVvRequirementEventHandler() {
  registerHandler(
    VV_INTEGRATION.requirementEventHandler,
    async ({ db, event, payload }) => {
      const eventTypeCode = event?.event_type_code || "";
      if (!REQUIREMENT_EVENTS.has(eventTypeCode)) {
        return { skipped: true, reason: "unsubscribed_event", event_type_code: eventTypeCode };
      }
      const tenantId = Number(event?.tenant_id ?? payload?.tenant_id ?? 0);
      const requirementRef = requirementRefFrom(event, payload);
      if (!tenantId || requirementRef === null || requirementRef === undefined || String(requirementRef).trim() === "") {
        return { skipped: true, reason: "insufficient_event_context", event_type_code: eventTypeCode };
      }

      const requirement = await RequirementService.getRequirementRowAsync(db, tenantId, requirementRef);
      if (!requirement) return { skipped: true, reason: "requirement_not_found", requirement_ref: requirementRef };

      const scan = await scanStaleEvidenceAsync(db, tenantId, { requirementId: requirement.id }, null, null);
      const recalc = await recalculateRequirementAsync(db, tenantId, requirement.id, null, null);
      return { event_type_code: eventTypeCode, requirement_ref: requirement.requirement_ref, stale: scan.stale, flagged: scan.flagged, vnv_status: recalc.vnv_status, changed: recalc.changed };
    },
    { description: "Flag potentially stale verification evidence and recalculate coverage when a requirement revision changes", module: SOURCE_MODULE }
  );
  return VV_INTEGRATION.requirementEventHandler;
}

function requirementSubscriptionCode(eventTypeCode) {
  return `${VV_INTEGRATION.subscriptionPrefix}-req-${String(eventTypeCode).toLowerCase()}`;
}

function requirementSubscriptionBody(definition) {
  return {
    name: `V&V requirement change: ${definition.event_type_code}`,
    description: "Flag potentially stale verification evidence and recalculate coverage for the affected requirement.",
    subscriber: SOURCE_MODULE,
    event_type_code: definition.event_type_code,
    handler: VV_INTEGRATION.requirementEventHandler,
    queue_code: "event-consumers",
    consumer_group: SOURCE_MODULE,
    status: "active",
  };
}

export function ensureVvRequirementSubscriptions(db) {
  let created = 0;
  let skipped = 0;
  for (const definition of VV_REQUIREMENT_SUBSCRIPTIONS) {
    if (!getEventTypeRow(db, definition.event_type_code)) {
      skipped += 1;
      continue;
    }
    const code = requirementSubscriptionCode(definition.event_type_code);
    if (getSubscriptionRow(db, code)) continue;
    createSubscription(db, { code, ...requirementSubscriptionBody(definition) }, null, null);
    created += 1;
  }
  return { created, skipped, total: VV_REQUIREMENT_SUBSCRIPTIONS.length };
}

export async function ensureVvRequirementSubscriptionsAsync(db) {
  let created = 0;
  let skipped = 0;
  for (const definition of VV_REQUIREMENT_SUBSCRIPTIONS) {
    if (!(await getEventTypeRowAsync(db, definition.event_type_code))) {
      skipped += 1;
      continue;
    }
    const code = requirementSubscriptionCode(definition.event_type_code);
    if (await getSubscriptionRowAsync(db, code)) continue;
    await createSubscriptionAsync(db, { code, ...requirementSubscriptionBody(definition) }, null, null);
    created += 1;
  }
  return { created, skipped, total: VV_REQUIREMENT_SUBSCRIPTIONS.length };
}

// ── Observability ─────────────────────────────────────────────────────────────

function subscriptionStatus(rows) {
  return rows.map((entry) => ({
    event_type_code: entry.event_type_code,
    handler: entry.handler,
    code: entry.code,
    registered: Boolean(entry.row),
    status: entry.row?.status || null,
  }));
}

export function vvSubscriptionSummary(db) {
  const coverage = VV_EVENT_SUBSCRIPTIONS.map((definition) => ({
    event_type_code: definition.event_type_code,
    handler: VV_INTEGRATION.coverageHandler,
    code: coverageSubscriptionCode(definition.event_type_code),
    row: getSubscriptionRow(db, coverageSubscriptionCode(definition.event_type_code)),
  }));
  const requirements = VV_REQUIREMENT_SUBSCRIPTIONS.map((definition) => ({
    event_type_code: definition.event_type_code,
    handler: VV_INTEGRATION.requirementEventHandler,
    code: requirementSubscriptionCode(definition.event_type_code),
    row: getSubscriptionRow(db, requirementSubscriptionCode(definition.event_type_code)),
  }));
  return { source_module: SOURCE_MODULE, subscriptions: subscriptionStatus([...coverage, ...requirements]) };
}

export async function vvSubscriptionSummaryAsync(db) {
  const coverage = [];
  for (const definition of VV_EVENT_SUBSCRIPTIONS) {
    const code = coverageSubscriptionCode(definition.event_type_code);
    coverage.push({ event_type_code: definition.event_type_code, handler: VV_INTEGRATION.coverageHandler, code, row: await getSubscriptionRowAsync(db, code) });
  }
  const requirements = [];
  for (const definition of VV_REQUIREMENT_SUBSCRIPTIONS) {
    const code = requirementSubscriptionCode(definition.event_type_code);
    requirements.push({ event_type_code: definition.event_type_code, handler: VV_INTEGRATION.requirementEventHandler, code, row: await getSubscriptionRowAsync(db, code) });
  }
  return { source_module: SOURCE_MODULE, subscriptions: subscriptionStatus([...coverage, ...requirements]) };
}
