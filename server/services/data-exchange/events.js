// Domain events published by the Import & Export Framework.
//
// Event registration is idempotent and safe on every boot; emission is
// best-effort through the shared Event & Messaging Framework so an event hiccup
// never fails a data-exchange write.
import { emitDomainEvent } from "../events/emit.js";
import { createEventType, getEventTypeRow } from "../events/registry.js";
import { EXCHANGE_EVENT_TYPES, SOURCE_MODULE } from "./constants.js";

export function ensureExchangeEventTypes(db) {
  let created = 0;
  for (const type of EXCHANGE_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "data_exchange",
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

export function publishExchangeEvent(
  db,
  { eventType, code, payload = {}, objectType = null, objectId = null, tenantId = null, organizationId = null },
  actor = null
) {
  const eventTypeCode = eventType || code;
  if (!eventTypeCode) return null;
  return emitDomainEvent(
    db,
    {
      source_module: SOURCE_MODULE,
      source_object_type: objectType || "data_exchange",
      source_object_id: objectId != null ? String(objectId) : null,
      tenant_id: tenantId ?? null,
      organization_id: organizationId ?? null,
      event_type_code: eventTypeCode,
      payload,
    },
    actor
  );
}

// Concrete events the service emits, so callers never invent ad-hoc codes.
export const EXCHANGE_EVENT_MAP = Object.freeze({
  IMPORT_STARTED: "ImportStarted",
  IMPORT_COMPLETED: "ImportCompleted",
  IMPORT_PARTIAL: "ImportPartiallyCompleted",
  IMPORT_FAILED: "ImportFailed",
  IMPORT_CANCELLED: "ImportCancelled",
  EXPORT_STARTED: "ExportStarted",
  EXPORT_COMPLETED: "ExportCompleted",
  EXPORT_FAILED: "ExportFailed",
  EXPORT_CANCELLED: "ExportCancelled",
  IMPORT_DEFINITION_CREATED: "ImportDefinitionCreated",
  IMPORT_DEFINITION_UPDATED: "ImportDefinitionUpdated",
  EXPORT_DEFINITION_CREATED: "ExportDefinitionCreated",
  EXPORT_DEFINITION_UPDATED: "ExportDefinitionUpdated",
  OPERATION_FAILED: "DataExchangeOperationFailed",
});

export function exchangeEventCode(key) {
  return EXCHANGE_EVENT_MAP[key] || null;
}
