// Domain events published by the Migration & Onboarding Framework.
//
// Registration is idempotent and safe on every boot; emission is best-effort
// through the shared Event & Messaging Framework so an event hiccup never fails
// a migration write.
import { emitDomainEvent } from "../events/emit.js";
import { createEventType, getEventTypeRow } from "../events/registry.js";
import { MIGRATION_EVENT_TYPES, SOURCE_MODULE } from "./constants.js";

export function ensureMigrationEventTypes(db) {
  let created = 0;
  for (const type of MIGRATION_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "migration",
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

export function publishMigrationEvent(
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
      source_object_type: objectType || "migration",
      source_object_id: objectId != null ? String(objectId) : null,
      tenant_id: tenantId ?? null,
      organization_id: organizationId ?? null,
      event_type_code: eventTypeCode,
      payload,
    },
    actor
  );
}

export const MIGRATION_EVENT_MAP = Object.freeze({
  STARTED: "MigrationStarted",
  COMPLETED: "MigrationCompleted",
  PARTIAL: "MigrationPartiallyCompleted",
  FAILED: "MigrationFailed",
  CANCELLED: "MigrationCancelled",
  PAUSED: "MigrationPaused",
  RESUMED: "MigrationResumed",
  CHECKPOINT: "MigrationCheckpointReached",
  RECONCILED: "MigrationReconciled",
  DEPENDENCY_RESOLVED: "MigrationDependencyResolved",
  IDENTIFIER_MAPPED: "MigrationIdentifierMapped",
  PACKAGE_COMPLETED: "MigrationPackageCompleted",
  OPERATION_FAILED: "MigrationOperationFailed",
});

export function migrationEventCode(key) {
  return MIGRATION_EVENT_MAP[key] || null;
}
