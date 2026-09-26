// Domain events published by Data Governance & Data Quality. Event type
// registration is idempotent and safe on every boot; emission is best-effort
// through the shared Event & Messaging Framework so an event hiccup never fails
// a governed write.
import { emitDomainEvent } from "../events/emit.js";
import { createEventType, getEventTypeRow } from "../events/registry.js";
import { GOVERNANCE_EVENT_TYPES } from "./constants.js";

export function ensureGovernanceEventTypes(db) {
  let created = 0;
  for (const type of GOVERNANCE_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "quality",
        source_module: "data-governance",
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

export function publishGovernanceEvent(
  db,
  { eventType, code, payload = {}, objectType = null, objectId = null, tenantId = null, organizationId = null },
  actor = null
) {
  const eventTypeCode = eventType || code;
  if (!eventTypeCode) return null;
  return emitDomainEvent(
    db,
    {
      source_module: "data-governance",
      source_object_type: objectType || "data_governance",
      source_object_id: objectId,
      tenant_id: tenantId ?? null,
      organization_id: organizationId ?? null,
      event_type_code: eventTypeCode,
      payload,
    },
    actor
  );
}
