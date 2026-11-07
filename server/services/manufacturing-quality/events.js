// Domain events published by the Manufacturing & Quality Intelligence layer.
//
// Registration is idempotent and safe on every boot; emission is best-effort
// through the shared Event & Messaging Framework so an event hiccup never fails a
// quality write (mirrors verification-validation/events.js).
import { emitDomainEvent, emitDomainEventAsync } from "../events/emit.js";
import { createEventType, getEventTypeRow, createEventTypeAsync, getEventTypeRowAsync } from "../events/registry.js";
import { MANUFACTURING_QUALITY_EVENT_TYPES, SOURCE_MODULE } from "./constants.js";

export function ensureManufacturingQualityEventTypes(db) {
  let created = 0;
  for (const type of MANUFACTURING_QUALITY_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "manufacturing-quality",
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

export async function ensureManufacturingQualityEventTypesAsync(db) {
  let created = 0;
  for (const type of MANUFACTURING_QUALITY_EVENT_TYPES) {
    if (await getEventTypeRowAsync(db, type.code)) continue;
    await createEventTypeAsync(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "manufacturing-quality",
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

export function publishManufacturingQualityEvent(
  db,
  { eventType, payload = {}, objectType = null, objectId = null, tenantId = null, organizationId = null },
  actor = null
) {
  if (!eventType) return null;
  return emitDomainEvent(
    db,
    {
      source_module: SOURCE_MODULE,
      source_object_type: objectType || "quality_issue",
      source_object_id: objectId != null ? String(objectId) : null,
      tenant_id: tenantId ?? null,
      organization_id: organizationId ?? null,
      event_type_code: eventType,
      payload,
    },
    actor
  );
}

export async function publishManufacturingQualityEventAsync(
  db,
  { eventType, payload = {}, objectType = null, objectId = null, tenantId = null, organizationId = null },
  actor = null
) {
  if (!eventType) return null;
  return emitDomainEventAsync(
    db,
    {
      source_module: SOURCE_MODULE,
      source_object_type: objectType || "quality_issue",
      source_object_id: objectId != null ? String(objectId) : null,
      tenant_id: tenantId ?? null,
      organization_id: organizationId ?? null,
      event_type_code: eventType,
      payload,
    },
    actor
  );
}
