// Domain events published by the Requirements Manager domain. Registration is
// idempotent and safe on every boot; emission is best-effort through the
// shared Event & Messaging Framework so an event hiccup never fails a write
// (mirrors server/services/change/events.js).
import { emitDomainEvent, emitDomainEventAsync } from "../events/emit.js";
import { createEventType, getEventTypeRow, createEventTypeAsync, getEventTypeRowAsync } from "../events/registry.js";
import { REQUIREMENT_EVENT_TYPES, SOURCE_MODULE } from "./constants.js";

export function ensureRequirementEventTypes(db) {
  let created = 0;
  for (const type of REQUIREMENT_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "requirements",
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

export async function ensureRequirementEventTypesAsync(db) {
  let created = 0;
  for (const type of REQUIREMENT_EVENT_TYPES) {
    if (await getEventTypeRowAsync(db, type.code)) continue;
    await createEventTypeAsync(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "requirements",
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

export function publishRequirementEvent(
  db,
  { eventType, payload = {}, objectType = null, objectId = null, tenantId = null, organizationId = null },
  actor = null
) {
  if (!eventType) return null;
  return emitDomainEvent(
    db,
    {
      source_module: SOURCE_MODULE,
      source_object_type: objectType || "requirement",
      source_object_id: objectId != null ? String(objectId) : null,
      tenant_id: tenantId ?? null,
      organization_id: organizationId ?? null,
      event_type_code: eventType,
      payload,
    },
    actor
  );
}

export async function publishRequirementEventAsync(
  db,
  { eventType, payload = {}, objectType = null, objectId = null, tenantId = null, organizationId = null },
  actor = null
) {
  if (!eventType) return null;
  return emitDomainEventAsync(
    db,
    {
      source_module: SOURCE_MODULE,
      source_object_type: objectType || "requirement",
      source_object_id: objectId != null ? String(objectId) : null,
      tenant_id: tenantId ?? null,
      organization_id: organizationId ?? null,
      event_type_code: eventType,
      payload,
    },
    actor
  );
}
