// Domain events published by the Enterprise Classification Framework.
//
// Registration is idempotent and safe on every boot; emission is best-effort
// through the shared Event & Messaging Framework so an event hiccup never fails
// a classification write.
import { emitDomainEvent } from "../events/emit.js";
import { createEventType, getEventTypeRow } from "../events/registry.js";
import { CLASSIFICATION_EVENT_TYPES, SOURCE_MODULE } from "./constants.js";

export function ensureClassificationEventTypes(db) {
  let created = 0;
  for (const type of CLASSIFICATION_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "classification",
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

export function publishClassificationEvent(
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
      source_object_type: objectType || "classification",
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

export const CLASSIFICATION_EVENT_MAP = Object.freeze({
  CLASSIFICATION_CREATED: "ClassificationCreated",
  CLASSIFICATION_UPDATED: "ClassificationUpdated",
  CLASSIFICATION_ACTIVATED: "ClassificationActivated",
  CLASSIFICATION_DEPRECATED: "ClassificationDeprecated",
  CLASS_CREATED: "ClassCreated",
  CLASS_UPDATED: "ClassUpdated",
  CLASS_MOVED: "ClassMoved",
  CHARACTERISTIC_CREATED: "CharacteristicCreated",
  CHARACTERISTIC_UPDATED: "CharacteristicUpdated",
  ASSIGNED: "ClassificationAssigned",
  UNASSIGNED: "ClassificationUnassigned",
  VALUES_UPDATED: "ClassificationValuesUpdated",
  VALIDATED: "ClassificationValidated",
  DUPLICATE_DETECTED: "ClassificationDuplicateDetected",
  BULK_COMPLETED: "ClassificationBulkCompleted",
});

export function classificationEventCode(key) {
  return CLASSIFICATION_EVENT_MAP[key] || null;
}
