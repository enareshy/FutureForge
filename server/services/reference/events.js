// Domain events published by Enterprise Reference Data Management. Registration
// is idempotent and safe on every boot; emission is best-effort through the
// shared Event & Messaging Framework (transactional outbox), so an event hiccup
// never fails a governed write.
import { emitDomainEvent } from "../events/emit.js";
import { createEventType, getEventTypeRow } from "../events/registry.js";

export const REFERENCE_EVENT_TYPES = [
  { code: "ReferenceDomainCreated", category: "system", source_module: "reference", description: "A reference data domain was created." },
  { code: "ReferenceDomainChanged", category: "system", source_module: "reference", description: "A reference data domain was updated." },
  { code: "ReferenceGovernanceChanged", category: "system", source_module: "reference", description: "A reference data governance policy version was published." },
  { code: "ReferenceItemCreated", category: "system", source_module: "reference", description: "A reference data item was created." },
  { code: "ReferenceItemChanged", category: "system", source_module: "reference", description: "A reference data item was modified." },
  { code: "ReferenceItemSubmitted", category: "system", source_module: "reference", description: "A reference data item was submitted for approval." },
  { code: "ReferenceItemApproved", category: "system", source_module: "reference", description: "A reference data item was approved." },
  { code: "ReferenceItemActivated", category: "system", source_module: "reference", description: "A reference data item was activated." },
  { code: "ReferenceItemInactivated", category: "system", source_module: "reference", description: "A reference data item was inactivated." },
  { code: "ReferenceItemRetired", category: "system", source_module: "reference", description: "A reference data item was retired." },
  { code: "ReferenceItemRejected", category: "system", source_module: "reference", description: "A reference data item was rejected or returned." },
  { code: "ReferenceItemVersionCreated", category: "system", source_module: "reference", description: "An immutable reference data version snapshot was recorded." },
  { code: "ReferenceCodeChanged", category: "system", source_module: "reference", description: "A reference code mapping was added or changed." },
  { code: "ReferenceAliasChanged", category: "system", source_module: "reference", description: "A reference alias was added or changed." },
  { code: "ReferenceTranslationChanged", category: "system", source_module: "reference", description: "A reference translation was added or changed." },
  { code: "ReferenceHierarchyChanged", category: "system", source_module: "reference", description: "Reference data hierarchy changed." },
  { code: "ReferenceRelationshipChanged", category: "system", source_module: "reference", description: "A cross-domain reference relationship changed." },
  { code: "ReferenceImportCommitted", category: "system", source_module: "reference", description: "A reference data import was committed." },
  { code: "ReferenceExportCreated", category: "system", source_module: "reference", description: "A reference data export was produced." },
];

export function ensureReferenceEventTypes(db) {
  let created = 0;
  for (const type of REFERENCE_EVENT_TYPES) {
    if (getEventTypeRow(db, type.code)) continue;
    createEventType(db, { ...type, system: true, status: "active", enabled: true }, null, null);
    created += 1;
  }
  return created;
}

export function emitReferenceEvent(db, { code, eventType, payload = {}, domainId = null, itemId = null, tenantId = null, organizationId = null }, actor = null) {
  const eventTypeCode = eventType || code;
  if (!eventTypeCode) return null;
  return emitDomainEvent(
    db,
    {
      source_module: "reference",
      source_object_type: itemId ? "reference_item" : "reference_domain",
      source_object_id: itemId || domainId || null,
      tenant_id: tenantId ?? null,
      organization_id: organizationId ?? null,
      event_type_code: eventTypeCode,
      payload: {
        domain_id: domainId,
        item_id: itemId,
        ...payload,
      },
    },
    actor
  );
}

export function emitItemEvent(db, eventTypeCode, item, payload = {}, actor = null) {
  if (!item) return null;
  return emitReferenceEvent(
    db,
    {
      eventType: eventTypeCode,
      domainId: item.domain_id ?? null,
      itemId: item.id ?? null,
      tenantId: item.tenant_id ?? null,
      organizationId: item.organization_id ?? null,
      payload: {
        item_ref: item.item_ref,
        code: item.code,
        name: item.name,
        status: item.status,
        scope_key: item.scope_key,
        version: item.current_version_number ?? item.version,
        ...payload,
      },
    },
    actor
  );
}
