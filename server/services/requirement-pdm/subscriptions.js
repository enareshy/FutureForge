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
import {
  REQUIREMENT_PDM_INTEGRATION,
  REQUIREMENT_PDM_EVENT_SUBSCRIPTIONS,
} from "./constants.js";

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
