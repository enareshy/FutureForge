// Domain events published by the Digital Thread domain.
//
// Registration is idempotent and emission is best-effort through the shared
// Event & Messaging Framework, so an event hiccup never fails a thread write.
import { emitDomainEvent } from "../events/emit.js";
import { createEventType, getEventTypeRow } from "../events/registry.js";
import { SOURCE_MODULE, THREAD_EVENT_TYPES, THREAD_EVENT_MAP } from "./constants.js";

export function ensureThreadEventTypes(db) {
  let created = 0;
  for (const type of THREAD_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "thread",
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

export function publishThreadEvent(
  db,
  { eventType, code, payload = {}, objectType = null, objectId = null, tenantId = null, organizationId = null, correlationId = null },
  actor = null
) {
  const eventTypeCode = eventType || code;
  if (!eventTypeCode) return null;
  return emitDomainEvent(
    db,
    {
      source_module: SOURCE_MODULE,
      source_object_type: objectType || "thread_definition",
      source_object_id: objectId != null ? String(objectId) : null,
      tenant_id: tenantId ?? null,
      organization_id: organizationId ?? null,
      event_type_code: eventTypeCode,
      correlation_id: correlationId || undefined,
      payload,
    },
    actor
  );
}

export function threadEventCode(key) {
  return THREAD_EVENT_MAP[key] || null;
}

export { THREAD_EVENT_MAP };
