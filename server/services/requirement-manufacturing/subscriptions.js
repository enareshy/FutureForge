// Event-driven triggers for the Requirement -> Manufacturing integration.
//
// The integration subscribes to the manufacturing/PLM lifecycle events that can
// invalidate a requirement's manufacturing trace, and to its own trace events
// so a fresh gap evaluation runs when a link is added or removed. Everything
// flows through the shared Event & Messaging Framework; no polling loop and no
// second event system is introduced (mirrors requirement-pdm/subscriptions.js).
import { registerHandler } from "../events/handlers.js";
import { createSubscription, createSubscriptionAsync, getSubscriptionRow, getSubscriptionRowAsync } from "../events/subscriptions.js";
import { getEventTypeRow, getEventTypeRowAsync } from "../events/registry.js";
import { analyzeNodeImpactAsync } from "./impact.js";
import { sweepManufacturingGaps } from "./jobs.js";
import {
  REQUIREMENT_MANUFACTURING_INTEGRATION,
  REQUIREMENT_MANUFACTURING_NODE_SUBSCRIPTIONS,
  REQUIREMENT_MANUFACTURING_TRACE_SUBSCRIPTIONS,
} from "./constants.js";

// ── Manufacturing/PLM node change -> affected requirements ────────────────────

function nodeIdFor(definition, event, payload) {
  if (payload && typeof payload === "object") {
    for (const key of definition.id_keys || []) {
      const value = payload[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") return value;
    }
  }
  return event?.source_object_id ?? null;
}

export function registerRequirementManufacturingNodeEventHandler() {
  registerHandler(
    REQUIREMENT_MANUFACTURING_INTEGRATION.nodeEventHandler,
    async ({ db, event, payload }) => {
      const eventTypeCode = event?.event_type_code || "";
      const definition = REQUIREMENT_MANUFACTURING_NODE_SUBSCRIPTIONS.find((entry) => entry.event_type_code === eventTypeCode);
      if (!definition) return { skipped: true, reason: "unsubscribed_event", event_type_code: eventTypeCode };
      const tenantId = Number(event?.tenant_id ?? payload?.tenant_id ?? 0);
      const nodeId = nodeIdFor(definition, event, payload);
      if (!tenantId || nodeId === null || nodeId === undefined || String(nodeId).trim() === "") {
        return { skipped: true, reason: "insufficient_event_context", event_type_code: eventTypeCode };
      }
      const summary = await analyzeNodeImpactAsync(db, tenantId, { nodeType: definition.node_type, nodeId }, {}, null, null);
      return { event_type_code: eventTypeCode, node_type: summary.node_type, requirement_count: summary.requirement_count, impacted_count: summary.impacted_count };
    },
    { description: "Propagate a manufacturing/PLM node change to the requirements linked to it and classify the impact", module: "requirement-manufacturing" }
  );
  return REQUIREMENT_MANUFACTURING_INTEGRATION.nodeEventHandler;
}

function nodeSubscriptionCode(eventTypeCode) {
  return `${REQUIREMENT_MANUFACTURING_INTEGRATION.subscriptionPrefix}-node-${String(eventTypeCode).toLowerCase()}`;
}

function nodeSubscriptionBody(definition) {
  return {
    name: `Requirement/Manufacturing node: ${definition.event_type_code}`,
    description: "Propagate this manufacturing/PLM node change to the linked requirements and classify the impact.",
    subscriber: "requirement-manufacturing",
    event_type_code: definition.event_type_code,
    handler: REQUIREMENT_MANUFACTURING_INTEGRATION.nodeEventHandler,
    queue_code: "event-consumers",
    consumer_group: "requirement-manufacturing",
    status: "active",
  };
}

export function ensureRequirementManufacturingNodeSubscriptions(db) {
  let created = 0;
  let skipped = 0;
  for (const definition of REQUIREMENT_MANUFACTURING_NODE_SUBSCRIPTIONS) {
    if (!getEventTypeRow(db, definition.event_type_code)) {
      skipped += 1;
      continue;
    }
    const code = nodeSubscriptionCode(definition.event_type_code);
    if (getSubscriptionRow(db, code)) continue;
    createSubscription(db, { code, ...nodeSubscriptionBody(definition) }, null, null);
    created += 1;
  }
  return { created, skipped, total: REQUIREMENT_MANUFACTURING_NODE_SUBSCRIPTIONS.length };
}

export async function ensureRequirementManufacturingNodeSubscriptionsAsync(db) {
  let created = 0;
  let skipped = 0;
  for (const definition of REQUIREMENT_MANUFACTURING_NODE_SUBSCRIPTIONS) {
    if (!(await getEventTypeRowAsync(db, definition.event_type_code))) {
      skipped += 1;
      continue;
    }
    const code = nodeSubscriptionCode(definition.event_type_code);
    if (await getSubscriptionRowAsync(db, code)) continue;
    await createSubscriptionAsync(db, { code, ...nodeSubscriptionBody(definition) }, null, null);
    created += 1;
  }
  return { created, skipped, total: REQUIREMENT_MANUFACTURING_NODE_SUBSCRIPTIONS.length };
}

// ── Trace change -> requirement-scoped gap re-evaluation ──────────────────────

function requirementIdFrom(event, payload) {
  if (payload && typeof payload === "object") {
    const ref = payload.requirement_id ?? payload.requirementId ?? payload.requirement_ref ?? payload.requirementRef ?? payload.id;
    if (ref !== undefined && ref !== null && String(ref).trim() !== "") return ref;
  }
  return event?.source_object_id ?? null;
}

export function registerRequirementManufacturingTraceEventHandler() {
  registerHandler(
    REQUIREMENT_MANUFACTURING_INTEGRATION.traceEventHandler,
    async ({ db, event, payload }) => {
      const eventTypeCode = event?.event_type_code || "";
      const definition = REQUIREMENT_MANUFACTURING_TRACE_SUBSCRIPTIONS.find((entry) => entry.event_type_code === eventTypeCode);
      if (!definition) return { skipped: true, reason: "unsubscribed_event", event_type_code: eventTypeCode };
      const tenantId = Number(event?.tenant_id ?? payload?.tenant_id ?? 0);
      const requirementId = requirementIdFrom(event, payload);
      if (!tenantId || requirementId === null || requirementId === undefined || String(requirementId).trim() === "") {
        return { skipped: true, reason: "insufficient_event_context", event_type_code: eventTypeCode };
      }
      const summary = await sweepManufacturingGaps(db, tenantId, { requirementId }, null, null);
      return { event_type_code: eventTypeCode, status: summary.status, total: summary.total };
    },
    { description: "Re-evaluate manufacturing traceability gaps when a requirement trace link changes", module: "requirement-manufacturing" }
  );
  return REQUIREMENT_MANUFACTURING_INTEGRATION.traceEventHandler;
}

function traceSubscriptionCode(eventTypeCode) {
  return `${REQUIREMENT_MANUFACTURING_INTEGRATION.subscriptionPrefix}-trace-${String(eventTypeCode).toLowerCase()}`;
}

function traceSubscriptionBody(definition) {
  return {
    name: `Requirement/Manufacturing trace: ${definition.event_type_code}`,
    description: "Re-evaluate the affected requirement's manufacturing traceability gaps when this trace link changes.",
    subscriber: "requirement-manufacturing",
    event_type_code: definition.event_type_code,
    handler: REQUIREMENT_MANUFACTURING_INTEGRATION.traceEventHandler,
    queue_code: "event-consumers",
    consumer_group: "requirement-manufacturing",
    status: "active",
  };
}

export function ensureRequirementManufacturingTraceSubscriptions(db) {
  let created = 0;
  let skipped = 0;
  for (const definition of REQUIREMENT_MANUFACTURING_TRACE_SUBSCRIPTIONS) {
    if (!getEventTypeRow(db, definition.event_type_code)) {
      skipped += 1;
      continue;
    }
    const code = traceSubscriptionCode(definition.event_type_code);
    if (getSubscriptionRow(db, code)) continue;
    createSubscription(db, { code, ...traceSubscriptionBody(definition) }, null, null);
    created += 1;
  }
  return { created, skipped, total: REQUIREMENT_MANUFACTURING_TRACE_SUBSCRIPTIONS.length };
}

export async function ensureRequirementManufacturingTraceSubscriptionsAsync(db) {
  let created = 0;
  let skipped = 0;
  for (const definition of REQUIREMENT_MANUFACTURING_TRACE_SUBSCRIPTIONS) {
    if (!(await getEventTypeRowAsync(db, definition.event_type_code))) {
      skipped += 1;
      continue;
    }
    const code = traceSubscriptionCode(definition.event_type_code);
    if (await getSubscriptionRowAsync(db, code)) continue;
    await createSubscriptionAsync(db, { code, ...traceSubscriptionBody(definition) }, null, null);
    created += 1;
  }
  return { created, skipped, total: REQUIREMENT_MANUFACTURING_TRACE_SUBSCRIPTIONS.length };
}
