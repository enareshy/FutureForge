// Domain events published by the Data Catalog & Business Glossary service.
// Event type registration is idempotent and safe on every boot; emission is
// best-effort through the shared Event & Messaging Framework so an event hiccup
// never fails a catalog write.
import { emitDomainEvent, emitDomainEventAsync } from "../events/emit.js";
import { createEventType, createEventTypeAsync, getEventTypeRow, getEventTypeRowAsync } from "../events/registry.js";
import { CATALOG_EVENT_TYPES, SOURCE_MODULE } from "./constants.js";

export function ensureCatalogEventTypes(db) {
  let created = 0;
  for (const type of CATALOG_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "governance",
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

export async function ensureCatalogEventTypesAsync(db) {
  let created = 0;
  for (const type of CATALOG_EVENT_TYPES) {
    if (await getEventTypeRowAsync(db, type.code)) continue;
    await createEventTypeAsync(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "governance",
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

export function publishCatalogEvent(
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
      source_object_type: objectType || "data_catalog",
      source_object_id: objectId,
      tenant_id: tenantId ?? null,
      organization_id: organizationId ?? null,
      event_type_code: eventTypeCode,
      payload,
    },
    actor
  );
}

export async function publishCatalogEventAsync(
  db,
  { eventType, code, payload = {}, objectType = null, objectId = null, tenantId = null, organizationId = null },
  actor = null
) {
  const eventTypeCode = eventType || code;
  if (!eventTypeCode) return null;
  return await emitDomainEventAsync(
    db,
    {
      source_module: SOURCE_MODULE,
      source_object_type: objectType || "data_catalog",
      source_object_id: objectId,
      tenant_id: tenantId ?? null,
      organization_id: organizationId ?? null,
      event_type_code: eventTypeCode,
      payload,
    },
    actor
  );
}
