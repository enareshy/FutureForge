// Event-driven trigger for Requirement -> PDM synchronization.
//
// The integration subscribes to the PDM lifecycle events that can invalidate an
// allocation and re-evaluates the affected requirements through the shared Event
// & Messaging Framework. No polling loop is invented; the platform consumer
// invokes the handler registered here (mirrors events/subscriptions.js).
import { registerHandler } from "../events/handlers.js";
import { createSubscription, createSubscriptionAsync, getSubscriptionRow, getSubscriptionRowAsync } from "../events/subscriptions.js";
import { getEventTypeRow, getEventTypeRowAsync } from "../events/registry.js";
import { synchronizeAsync } from "./synchronization.js";
import { initiateChangeRequestAsync } from "./change-initiation.js";
import { synchronizeFromPlmAsync } from "./plm-sync.js";
import {
  REQUIREMENT_PDM_INTEGRATION,
  REQUIREMENT_PDM_EVENT_SUBSCRIPTIONS,
  REQUIREMENT_PLM_EVENT_SUBSCRIPTIONS,
  REQUIREMENT_PLM_CHANGE_SUBSCRIPTIONS,
  TARGET_NODE_TYPES,
} from "./constants.js";

const TARGET_TYPE_SET = new Set(TARGET_NODE_TYPES);

function targetIdFor(event, payload, targetType) {
  if (payload && typeof payload === "object") {
    if (targetType === "pdm_revision" && payload.revision_id != null) return payload.revision_id;
    if (targetType === "pdm_dataset" && payload.dataset_id != null) return payload.dataset_id;
    if (targetType === "pdm_item" && payload.item_id != null) return payload.item_id;
    if (payload.id != null) return payload.id;
  }
  return event?.source_object_id ?? null;
}

// Registers the event handler. Idempotent; returns the handler code.
export function registerRequirementPdmEventHandler() {
  registerHandler(
    REQUIREMENT_PDM_INTEGRATION.eventHandler,
    async ({ db, event, payload }) => {
      const eventTypeCode = event?.event_type_code || "";
      const definition = REQUIREMENT_PDM_EVENT_SUBSCRIPTIONS.find((entry) => entry.event_type_code === eventTypeCode);
      const targetType = definition?.target_type || null;
      const tenantId = Number(event?.tenant_id ?? payload?.tenant_id ?? 0);
      const targetId = targetIdFor(event, payload, targetType);
      if (!tenantId || !targetType || targetId == null || targetId === "") {
        return { skipped: true, reason: "insufficient_event_context", event_type_code: eventTypeCode };
      }
      if (!TARGET_TYPE_SET.has(targetType)) {
        return { skipped: true, reason: "unsupported_target_type", event_type_code: eventTypeCode, target_type: targetType };
      }
      const summary = await synchronizeAsync(db, tenantId, { targetType, targetId }, null, null);
      return { evaluated: summary.evaluated, changed: summary.changed, status: summary.status };
    },
    { description: "Re-evaluate requirement allocations when PDM artifacts change", module: "requirement-pdm" }
  );
  return REQUIREMENT_PDM_INTEGRATION.eventHandler;
}

function subscriptionCode(eventTypeCode) {
  return `${REQUIREMENT_PDM_INTEGRATION.subscriptionPrefix}-${String(eventTypeCode).toLowerCase()}`;
}

export function ensureRequirementPdmSubscriptions(db) {
  let created = 0;
  let skipped = 0;
  for (const definition of REQUIREMENT_PDM_EVENT_SUBSCRIPTIONS) {
    if (!getEventTypeRow(db, definition.event_type_code)) {
      skipped += 1;
      continue;
    }
    const code = subscriptionCode(definition.event_type_code);
    if (getSubscriptionRow(db, code)) continue;
    createSubscription(
      db,
      {
        code,
        name: `Requirement/PDM: ${definition.event_type_code}`,
        description: "Re-evaluate requirement allocations when this PDM artifact changes.",
        subscriber: "requirement-pdm",
        event_type_code: definition.event_type_code,
        handler: REQUIREMENT_PDM_INTEGRATION.eventHandler,
        queue_code: "event-consumers",
        consumer_group: "requirement-pdm",
        status: "active",
      },
      null,
      null
    );
    created += 1;
  }
  return { created, skipped, total: REQUIREMENT_PDM_EVENT_SUBSCRIPTIONS.length };
}

export async function ensureRequirementPdmSubscriptionsAsync(db) {
  let created = 0;
  let skipped = 0;
  for (const definition of REQUIREMENT_PDM_EVENT_SUBSCRIPTIONS) {
    if (!(await getEventTypeRowAsync(db, definition.event_type_code))) {
      skipped += 1;
      continue;
    }
    const code = subscriptionCode(definition.event_type_code);
    if (await getSubscriptionRowAsync(db, code)) continue;
    await createSubscriptionAsync(
      db,
      {
        code,
        name: `Requirement/PDM: ${definition.event_type_code}`,
        description: "Re-evaluate requirement allocations when this PDM artifact changes.",
        subscriber: "requirement-pdm",
        event_type_code: definition.event_type_code,
        handler: REQUIREMENT_PDM_INTEGRATION.eventHandler,
        queue_code: "event-consumers",
        consumer_group: "requirement-pdm",
        status: "active",
      },
      null,
      null
    );
    created += 1;
  }
  return { created, skipped, total: REQUIREMENT_PDM_EVENT_SUBSCRIPTIONS.length };
}

// ── Requirement change -> change initiation (event-driven) ───────────────────
//
// Subscribes to requirement lifecycle events and attempts a rule-evaluated
// automatic change request. With auto-change disabled (the default) the handler
// is a cheap no-op, so the subscription is safe to register on every boot.

function requirementRefFrom(event, payload) {
  if (payload && typeof payload === "object") {
    const ref = payload.requirement_id ?? payload.requirementId ?? payload.id ?? payload.requirement_ref ?? payload.requirementRef;
    if (ref !== undefined && ref !== null && String(ref).trim() !== "") return ref;
  }
  return event?.source_object_id ?? null;
}

export function registerRequirementPdmChangeEventHandler() {
  registerHandler(
    REQUIREMENT_PDM_INTEGRATION.changeEventHandler,
    async ({ db, event, payload }) => {
      const eventTypeCode = event?.event_type_code || "";
      const definition = REQUIREMENT_PLM_CHANGE_SUBSCRIPTIONS.find((entry) => entry.event_type_code === eventTypeCode);
      if (!definition) return { skipped: true, reason: "unsubscribed_event", event_type_code: eventTypeCode };
      const tenantId = Number(event?.tenant_id ?? payload?.tenant_id ?? 0);
      const requirementRef = requirementRefFrom(event, payload);
      if (!tenantId || requirementRef === null || requirementRef === undefined || String(requirementRef).trim() === "") {
        return { skipped: true, reason: "insufficient_event_context", event_type_code: eventTypeCode };
      }
      const result = await initiateChangeRequestAsync(db, tenantId, requirementRef, payload || {}, null, null);
      return { event_type_code: eventTypeCode, status: result.status, change_request_id: result.change?.id ?? null };
    },
    { description: "Initiate an existing Change Management request when a requirement change satisfies the configured rules", module: "requirement-pdm" }
  );
  return REQUIREMENT_PDM_INTEGRATION.changeEventHandler;
}

function changeSubscriptionCode(eventTypeCode) {
  return `${REQUIREMENT_PDM_INTEGRATION.subscriptionPrefix}-change-${String(eventTypeCode).toLowerCase()}`;
}

export function ensureRequirementPdmChangeSubscriptions(db) {
  let created = 0;
  let skipped = 0;
  for (const definition of REQUIREMENT_PLM_CHANGE_SUBSCRIPTIONS) {
    if (!getEventTypeRow(db, definition.event_type_code)) {
      skipped += 1;
      continue;
    }
    const code = changeSubscriptionCode(definition.event_type_code);
    if (getSubscriptionRow(db, code)) continue;
    createSubscription(
      db,
      {
        code,
        name: `Requirement change initiation: ${definition.event_type_code}`,
        description: "Evaluate requirement change-initiation rules and raise a change request when warranted.",
        subscriber: "requirement-pdm",
        event_type_code: definition.event_type_code,
        handler: REQUIREMENT_PDM_INTEGRATION.changeEventHandler,
        queue_code: "event-consumers",
        consumer_group: "requirement-pdm",
        status: "active",
      },
      null,
      null
    );
    created += 1;
  }
  return { created, skipped, total: REQUIREMENT_PLM_CHANGE_SUBSCRIPTIONS.length };
}

export async function ensureRequirementPdmChangeSubscriptionsAsync(db) {
  let created = 0;
  let skipped = 0;
  for (const definition of REQUIREMENT_PLM_CHANGE_SUBSCRIPTIONS) {
    if (!(await getEventTypeRowAsync(db, definition.event_type_code))) {
      skipped += 1;
      continue;
    }
    const code = changeSubscriptionCode(definition.event_type_code);
    if (await getSubscriptionRowAsync(db, code)) continue;
    await createSubscriptionAsync(
      db,
      {
        code,
        name: `Requirement change initiation: ${definition.event_type_code}`,
        description: "Evaluate requirement change-initiation rules and raise a change request when warranted.",
        subscriber: "requirement-pdm",
        event_type_code: definition.event_type_code,
        handler: REQUIREMENT_PDM_INTEGRATION.changeEventHandler,
        queue_code: "event-consumers",
        consumer_group: "requirement-pdm",
        status: "active",
      },
      null,
      null
    );
    created += 1;
  }
  return { created, skipped, total: REQUIREMENT_PLM_CHANGE_SUBSCRIPTIONS.length };
}

// ── PLM change -> Requirement synchronization (event-driven) ─────────────────
//
// Subscribes to the Product/EBOM/MBOM/BOP/Document/Change events that can reach
// a requirement. When one arrives the handler resolves the changed node, finds
// the linked requirements, classifies impact and notifies the owners through the
// shared Notification framework. This is the platform's own event consumer; no
// polling or second event system is introduced.

function plmNodeId(definition, event, payload) {
  if (payload && typeof payload === "object") {
    for (const key of definition.id_keys || []) {
      const value = payload[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") return value;
    }
  }
  return event?.source_object_id ?? null;
}

export function registerRequirementPdmPlmSyncHandler() {
  registerHandler(
    REQUIREMENT_PDM_INTEGRATION.plmEventHandler,
    async ({ db, event, payload }) => {
      const eventTypeCode = event?.event_type_code || "";
      const definition = REQUIREMENT_PLM_EVENT_SUBSCRIPTIONS.find((entry) => entry.event_type_code === eventTypeCode);
      if (!definition) return { skipped: true, reason: "unsubscribed_event", event_type_code: eventTypeCode };
      const tenantId = Number(event?.tenant_id ?? payload?.tenant_id ?? 0);
      const nodeId = plmNodeId(definition, event, payload);
      if (!tenantId || nodeId === null || nodeId === undefined || String(nodeId).trim() === "") {
        return { skipped: true, reason: "insufficient_event_context", event_type_code: eventTypeCode };
      }
      const result = await synchronizeFromPlmAsync(db, tenantId, { nodeType: definition.node_type, nodeId, eventType: eventTypeCode, correlationId: event?.correlation_id || "" }, null, null);
      return { event_type_code: eventTypeCode, status: result.status, requirement_count: result.requirement_count, impacted_count: result.impacted_count };
    },
    { description: "Propagate Product/EBOM/MBOM/BOP/Document/Change changes to linked requirements", module: "requirement-pdm" }
  );
  return REQUIREMENT_PDM_INTEGRATION.plmEventHandler;
}

function plmSubscriptionCode(eventTypeCode) {
  return `${REQUIREMENT_PDM_INTEGRATION.subscriptionPrefix}-plm-${String(eventTypeCode).toLowerCase()}`;
}

export function ensureRequirementPdmPlmSubscriptions(db) {
  let created = 0;
  let skipped = 0;
  for (const definition of REQUIREMENT_PLM_EVENT_SUBSCRIPTIONS) {
    if (!getEventTypeRow(db, definition.event_type_code)) {
      skipped += 1;
      continue;
    }
    const code = plmSubscriptionCode(definition.event_type_code);
    if (getSubscriptionRow(db, code)) continue;
    createSubscription(
      db,
      {
        code,
        name: `Requirement/PLM: ${definition.event_type_code}`,
        description: "Propagate this PLM change to the linked requirements and notify their owners.",
        subscriber: "requirement-pdm",
        event_type_code: definition.event_type_code,
        handler: REQUIREMENT_PDM_INTEGRATION.plmEventHandler,
        queue_code: "event-consumers",
        consumer_group: "requirement-pdm",
        status: "active",
      },
      null,
      null
    );
    created += 1;
  }
  return { created, skipped, total: REQUIREMENT_PLM_EVENT_SUBSCRIPTIONS.length };
}

export async function ensureRequirementPdmPlmSubscriptionsAsync(db) {
  let created = 0;
  let skipped = 0;
  for (const definition of REQUIREMENT_PLM_EVENT_SUBSCRIPTIONS) {
    if (!(await getEventTypeRowAsync(db, definition.event_type_code))) {
      skipped += 1;
      continue;
    }
    const code = plmSubscriptionCode(definition.event_type_code);
    if (await getSubscriptionRowAsync(db, code)) continue;
    await createSubscriptionAsync(
      db,
      {
        code,
        name: `Requirement/PLM: ${definition.event_type_code}`,
        description: "Propagate this PLM change to the linked requirements and notify their owners.",
        subscriber: "requirement-pdm",
        event_type_code: definition.event_type_code,
        handler: REQUIREMENT_PDM_INTEGRATION.plmEventHandler,
        queue_code: "event-consumers",
        consumer_group: "requirement-pdm",
        status: "active",
      },
      null,
      null
    );
    created += 1;
  }
  return { created, skipped, total: REQUIREMENT_PLM_EVENT_SUBSCRIPTIONS.length };
}
