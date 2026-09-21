// Notification integration for the catalog. The catalog does not implement its
// own messaging: it publishes through the shared Notification & Communication
// Framework, which applies templates, rules and user preferences. Publishing is
// best-effort so a notification failure never fails a catalog write.
import { publish } from "../notifications.js";

export function notifyCatalogEvent(
  db,
  { eventType, tenantId, organizationId = null, objectType = "data_catalog_entry", objectId, objectName = null, payload = {}, actor = null } = {}
) {
  if (!eventType) return { published: 0, notifications: [] };
  try {
    return publish(
      db,
      {
        event_type: eventType,
        source_module: "data-catalog",
        tenant_id: tenantId ?? null,
        organization_id: organizationId ?? null,
        object_type: objectType,
        object_id: objectId != null ? String(objectId) : null,
        object_name: objectName,
        payload,
        correlation_id: payload?.correlation_id,
        idempotency_key: payload?.idempotency_key || `data-catalog:${eventType}:${objectType}:${objectId}`,
      },
      { actor }
    );
  } catch {
    return { published: 0, notifications: [], suppressed: true };
  }
}

export function notifyTermReview(db, term, { actor = null } = {}) {
  return notifyCatalogEvent(db, {
    eventType: "BusinessTermSubmitted",
    tenantId: term.tenant_id,
    objectType: "business_term",
    objectId: term.id,
    objectName: term.term_ref,
    payload: {
      term_id: term.id,
      term_ref: term.term_ref,
      code: term.code,
      name: term.name,
      owner_user_id: term.owner_user_id ?? null,
      steward_user_id: term.steward_user_id ?? null,
      workflow_instance_id: term.workflow_instance_id ?? null,
    },
    actor,
  });
}

export function notifyTermApproved(db, term, { actor = null } = {}) {
  return notifyCatalogEvent(db, {
    eventType: "BusinessTermApproved",
    tenantId: term.tenant_id,
    objectType: "business_term",
    objectId: term.id,
    objectName: term.term_ref,
    payload: { term_id: term.id, term_ref: term.term_ref, code: term.code, approved_by: term.approved_by ?? null },
    actor,
  });
}

export function notifyOwnershipChanged(db, entry, { relationship = "owner", actor = null } = {}) {
  return notifyCatalogEvent(db, {
    eventType: relationship === "steward" ? "CatalogStewardChanged" : "CatalogOwnerChanged",
    tenantId: entry.tenant_id,
    objectType: "data_catalog_entry",
    objectId: entry.id,
    objectName: entry.entry_ref,
    payload: { entry_id: entry.id, entry_ref: entry.entry_ref, relationship },
    actor,
  });
}

export function notifyDuplicateTermDefinition(db, terms, { actor = null } = {}) {
  const first = terms[0];
  if (!first) return { published: 0, notifications: [] };
  return notifyCatalogEvent(db, {
    eventType: "BusinessTermUpdated",
    tenantId: first.tenant_id,
    objectType: "business_term",
    objectId: first.id,
    payload: { reason: "duplicate_definitions", term_ids: terms.map((term) => term.id) },
    actor,
  });
}
