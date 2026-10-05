// Domain events published by Data Observability.
//
// Registration is idempotent and emission is best-effort through the shared
// Event & Messaging Framework, so an event hiccup never fails an observability
// write. Observability does not create another event infrastructure.
import { emitDomainEvent, emitDomainEventAsync } from "../events/emit.js";
import { createEventType, getEventTypeRow, createEventTypeAsync, getEventTypeRowAsync } from "../events/registry.js";
import { SOURCE_MODULE, OBSERVABILITY_EVENT_TYPES, OBSERVABILITY_EVENT_MAP } from "./constants.js";

export function ensureObservabilityEventTypes(db) {
  let created = 0;
  for (const type of OBSERVABILITY_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "observability",
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

// Async twin of `ensureObservabilityEventTypes` for migrated request paths.
export async function ensureObservabilityEventTypesAsync(db) {
  let created = 0;
  for (const type of OBSERVABILITY_EVENT_TYPES) {
    if (await getEventTypeRowAsync(db, type.code)) continue;
    await createEventTypeAsync(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "observability",
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

export function publishObservabilityEvent(
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
      source_object_type: objectType || "observability_metric",
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

// Async twin of `publishObservabilityEvent` for migrated request paths.
// Emission stays best-effort through the shared Event & Messaging Framework, so
// an event hiccup never fails the caller's observability write.
export async function publishObservabilityEventAsync(
  db,
  { eventType, code, payload = {}, objectType = null, objectId = null, tenantId = null, organizationId = null, correlationId = null },
  actor = null
) {
  const eventTypeCode = eventType || code;
  if (!eventTypeCode) return null;
  return emitDomainEventAsync(
    db,
    {
      source_module: SOURCE_MODULE,
      source_object_type: objectType || "observability_metric",
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

export function observabilityEventCode(key) {
  return OBSERVABILITY_EVENT_MAP[key] || null;
}

export { OBSERVABILITY_EVENT_MAP };
