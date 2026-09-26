// Domain events published by the Change Management domain. Registration is
// idempotent and safe on every boot; emission is best-effort through the
// shared Event & Messaging Framework so an event hiccup never fails a write.
import { emitDomainEvent } from "../events/emit.js";
import { createEventType, getEventTypeRow } from "../events/registry.js";
import { CHANGE_EVENT_TYPES, SOURCE_MODULE } from "./constants.js";

export function ensureChangeEventTypes(db) {
  let created = 0;
  for (const type of CHANGE_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "change",
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

export function publishChangeEvent(
  db,
  { eventType, payload = {}, objectType = null, objectId = null, tenantId = null, organizationId = null },
  actor = null
) {
  if (!eventType) return null;
  return emitDomainEvent(
    db,
    {
      source_module: SOURCE_MODULE,
      source_object_type: objectType || "change_order",
      source_object_id: objectId != null ? String(objectId) : null,
      tenant_id: tenantId ?? null,
      organization_id: organizationId ?? null,
      event_type_code: eventType,
      payload,
    },
    actor
  );
}
