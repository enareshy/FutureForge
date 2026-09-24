// Domain events published by the P1 BOM Engine.
//
// Registration is idempotent and safe on every boot; emission is best-effort
// through the shared Event & Messaging Framework so an event hiccup never fails
// a BOM write.
import { emitDomainEvent } from "../events/emit.js";
import { createEventType, getEventTypeRow } from "../events/registry.js";
import { BOM_EVENT_TYPES, SOURCE_MODULE } from "./constants.js";

export function ensureBomEventTypes(db) {
  let created = 0;
  for (const type of BOM_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "bom",
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

export function publishBomEvent(
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
      source_object_type: objectType || "bom",
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

export const BOM_EVENT_MAP = Object.freeze({
  BOM_CREATED: "BomCreated",
  BOM_UPDATED: "BomUpdated",
  REVISION_CREATED: "BomRevisionCreated",
  REVISION_REVISED: "BomRevisionRevised",
  REVISION_RELEASED: "BomRevisionReleased",
  REVISION_STATUS_CHANGED: "BomRevisionStatusChanged",
  LINE_ADDED: "BomLineAdded",
  LINE_UPDATED: "BomLineUpdated",
  LINE_REMOVED: "BomLineRemoved",
  SUBSTITUTE_ADDED: "BomSubstituteAdded",
  SUBSTITUTE_REMOVED: "BomSubstituteRemoved",
  BASELINE_CREATED: "BomBaselineCreated",
  BASELINE_FROZEN: "BomBaselineFrozen",
  TRANSFORMED: "BomTransformed",
  VALIDATION_COMPLETED: "BomValidationCompleted",
  COMPARED: "BomCompared",
  ROLLUP_COMPLETED: "BomRollupCompleted",
  BULK_COMPLETED: "BomBulkCompleted",
});

export function bomEventCode(key) {
  return BOM_EVENT_MAP[key] || null;
}
