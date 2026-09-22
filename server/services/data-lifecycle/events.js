// Domain events published by the Data Lifecycle & Archival service.
//
// Event registration is idempotent and safe on every boot; emission is
// best-effort through the shared Event & Messaging Framework so an event hiccup
// never fails a lifecycle write.
import { emitDomainEvent } from "../events/emit.js";
import { createEventType, getEventTypeRow } from "../events/registry.js";
import { LIFECYCLE_EVENT_TYPES, SOURCE_MODULE } from "./constants.js";

export function ensureLifecycleEventTypes(db) {
  let created = 0;
  for (const type of LIFECYCLE_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "lifecycle",
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

export function publishLifecycleEvent(
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
      source_object_type: objectType || "data_lifecycle",
      source_object_id: objectId != null ? String(objectId) : null,
      tenant_id: tenantId ?? null,
      organization_id: organizationId ?? null,
      event_type_code: eventTypeCode,
      payload,
    },
    actor
  );
}

// The concrete events the service emits for the most common operations. Keeping
// the mapping here means the services never invent ad-hoc event codes.
export const LIFECYCLE_EVENT_MAP = Object.freeze({
  INACTIVE: "ObjectBecameInactive",
  STATE_CHANGED: "ObjectLifecycleChanged",
  ARCHIVE_STARTED: "ObjectArchiveStarted",
  ARCHIVED: "ObjectArchived",
  COLD_STORAGE: "ObjectMovedToColdStorage",
  RESTORE_STARTED: "ObjectRestoreStarted",
  RESTORED: "ObjectRestored",
  PURGE_STARTED: "ObjectPurgeStarted",
  PURGED: "ObjectPurged",
  LEGAL_HOLD_CREATED: "LegalHoldCreated",
  LEGAL_HOLD_RELEASED: "LegalHoldReleased",
  POLICY_CHANGED: "RetentionPolicyChanged",
  EVALUATION_COMPLETED: "LifecycleEvaluationCompleted",
  OPERATION_FAILED: "LifecycleOperationFailed",
});

export function lifecycleEventCode(key) {
  return LIFECYCLE_EVENT_MAP[key] || null;
}
