// Domain events published by the Predictive Intelligence & Recommendations
// layer. Registration is idempotent and safe on every boot; emission is
// best-effort through the shared Event & Messaging Framework so an event hiccup
// never fails a prediction write (mirrors manufacturing-quality/events.js).
import { emitDomainEvent, emitDomainEventAsync } from "../events/emit.js";
import { createEventType, getEventTypeRow, createEventTypeAsync, getEventTypeRowAsync } from "../events/registry.js";
import { PREDICTIVE_EVENT_TYPES, SOURCE_MODULE } from "./constants.js";

export function ensurePredictiveEventTypes(db) {
  let created = 0;
  for (const type of PREDICTIVE_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "predictive-intelligence",
        source_module: SOURCE_MODULE,
        system: true,
        status: "active",
        enabled: true,
      },
      null,
      null
    );
    created += 1;
  }
  return created;
}

export async function ensurePredictiveEventTypesAsync(db) {
  let created = 0;
  for (const type of PREDICTIVE_EVENT_TYPES) {
    if (await getEventTypeRowAsync(db, type.code)) continue;
    await createEventTypeAsync(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "predictive-intelligence",
        source_module: SOURCE_MODULE,
        system: true,
        status: "active",
        enabled: true,
      },
      null,
      null
    );
    created += 1;
  }
  return created;
}

export function publishPredictiveEvent(
  db,
  { eventType, payload = {}, objectType = null, objectId = null, tenantId = null, organizationId = null },
  actor = null
) {
  if (!eventType) return null;
  return emitDomainEvent(
    db,
    {
      source_module: SOURCE_MODULE,
      source_object_type: objectType || "prediction",
      source_object_id: objectId != null ? String(objectId) : null,
      tenant_id: tenantId ?? null,
      organization_id: organizationId ?? null,
      event_type_code: eventType,
      payload,
    },
    actor
  );
}

export async function publishPredictiveEventAsync(
  db,
  { eventType, payload = {}, objectType = null, objectId = null, tenantId = null, organizationId = null },
  actor = null
) {
  if (!eventType) return null;
  return emitDomainEventAsync(
    db,
    {
      source_module: SOURCE_MODULE,
      source_object_type: objectType || "prediction",
      source_object_id: objectId != null ? String(objectId) : null,
      tenant_id: tenantId ?? null,
      organization_id: organizationId ?? null,
      event_type_code: eventType,
      payload,
    },
    actor
  );
}
