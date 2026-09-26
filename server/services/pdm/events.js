// Domain events published by the P1 PDM domain.
//
// Registration is idempotent and safe on every boot; emission is best-effort
// through the shared Event & Messaging Framework so an event hiccup never fails
// a PDM write.
import { emitDomainEvent } from "../events/emit.js";
import { createEventType, getEventTypeRow } from "../events/registry.js";
import { PDM_EVENT_TYPES, SOURCE_MODULE } from "./constants.js";

export function ensurePdmEventTypes(db) {
  let created = 0;
  for (const type of PDM_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(
      db,
      {
        code: type.code,
        name: type.code,
        description: type.description,
        category: "pdm",
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

export function publishPdmEvent(
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
      source_object_type: objectType || "pdm_item",
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

export const PDM_EVENT_MAP = Object.freeze({
  ITEM_CREATED: "PdmItemCreated",
  ITEM_UPDATED: "PdmItemUpdated",
  ITEM_DELETED: "PdmItemDeleted",
  ITEM_STATUS_CHANGED: "PdmItemStatusChanged",
  REVISION_CREATED: "PdmRevisionCreated",
  REVISION_REVISED: "PdmRevisionRevised",
  REVISION_RELEASED: "PdmRevisionReleased",
  REVISION_STATUS_CHANGED: "PdmRevisionStatusChanged",
  DATASET_CREATED: "PdmDatasetCreated",
  DATASET_UPDATED: "PdmDatasetUpdated",
  DATASET_DELETED: "PdmDatasetDeleted",
  DATASET_CONTENT_LINKED: "PdmDatasetContentLinked",
  REPRESENTATION_CREATED: "PdmRepresentationCreated",
  REPRESENTATION_DELETED: "PdmRepresentationDeleted",
  DESIGN_DATA_LINKED: "PdmDesignDataLinked",
  DESIGN_DATA_UNLINKED: "PdmDesignDataUnlinked",
  CAD_CREATED: "PdmCadAssociationCreated",
  CAD_REMOVED: "PdmCadAssociationRemoved",
  REVISION_RULE_CREATED: "PdmRevisionRuleCreated",
  REVISION_RULE_ACTIVATED: "PdmRevisionRuleActivated",
  REVISION_RULE_VERSION_PUBLISHED: "PdmRevisionRuleVersionPublished",
  CONFIGURATION_RULE_CREATED: "PdmConfigurationRuleCreated",
  CONFIGURATION_RULE_ACTIVATED: "PdmConfigurationRuleActivated",
  CONFIGURATION_RULE_VERSION_PUBLISHED: "PdmConfigurationRuleVersionPublished",
  BASELINE_CREATED: "PdmBaselineCreated",
  BASELINE_RELEASED: "PdmBaselineReleased",
  BASELINE_FROZEN: "PdmBaselineFrozen",
  STRUCTURE_RESOLVED: "PdmStructureResolved",
  WHERE_USED_RUN: "PdmWhereUsedRun",
  WHERE_REFERENCED_RUN: "PdmWhereReferencedRun",
  VALIDATION_COMPLETED: "PdmValidationCompleted",
  BULK_COMPLETED: "PdmBulkCompleted",
});

export function pdmEventCode(key) {
  return PDM_EVENT_MAP[key] || null;
}
