// Domain events published by the Verification & Validation Engine.
//
// Registration is idempotent and safe on every boot; emission is best-effort
// through the shared Event & Messaging Framework so an event hiccup never fails a
// V&V write (mirrors requirement-manufacturing/events.js). Consumers are
// expected to be idempotent; there is no second event bus.
import { emitDomainEvent, emitDomainEventAsync } from "../events/emit.js";
import { createEventType, getEventTypeRow, createEventTypeAsync, getEventTypeRowAsync } from "../events/registry.js";
import { VV_EVENT_TYPES, SOURCE_MODULE } from "./constants.js";

export function ensureVvEventTypes(db) {
  let created = 0;
  for (const type of VV_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "verification-validation",
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

export async function ensureVvEventTypesAsync(db) {
  let created = 0;
  for (const type of VV_EVENT_TYPES) {
    if (await getEventTypeRowAsync(db, type.code)) continue;
    await createEventTypeAsync(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "verification-validation",
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

export function publishVvEvent(
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

export async function publishVvEventAsync(
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
