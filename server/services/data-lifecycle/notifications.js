// Notification integration for the lifecycle service.
//
// The service does not implement messaging: it publishes through the shared
// Notification & Communication Framework, which applies templates, rules and
// user preferences. Publishing is best-effort so a notification failure never
// fails a lifecycle write.
import { publish, publishAsync } from "../notifications.js";

export function notifyLifecycleEvent(
  db,
  { eventType, tenantId, organizationId = null, objectType = "lifecycle_object", objectId, objectName = null, payload = {}, actor = null } = {}
) {
  if (!eventType) return { published: 0, notifications: [] };
  try {
    return publish(
      db,
      {
        event_type: eventType,
        source_module: "data-lifecycle",
        tenant_id: tenantId ?? null,
        organization_id: organizationId ?? null,
        object_type: objectType,
        object_id: objectId != null ? String(objectId) : null,
        object_name: objectName,
        payload,
        correlation_id: payload?.correlation_id,
        idempotency_key: payload?.idempotency_key || `data-lifecycle:${eventType}:${objectType}:${objectId}`,
      },
      { actor }
    );
  } catch {
    return { published: 0, notifications: [], suppressed: true };
  }
}

export async function notifyLifecycleEventAsync(
  db,
  { eventType, tenantId, organizationId = null, objectType = "lifecycle_object", objectId, objectName = null, payload = {}, actor = null } = {}
) {
  if (!eventType) return { published: 0, notifications: [] };
  try {
    return await publishAsync(
      db,
      {
        event_type: eventType,
        source_module: "data-lifecycle",
        tenant_id: tenantId ?? null,
        organization_id: organizationId ?? null,
        object_type: objectType,
        object_id: objectId != null ? String(objectId) : null,
        object_name: objectName,
        payload,
        correlation_id: payload?.correlation_id,
        idempotency_key: payload?.idempotency_key || `data-lifecycle:${eventType}:${objectType}:${objectId}`,
      },
      { actor }
    );
  } catch {
    return { published: 0, notifications: [], suppressed: true };
  }
}

export function notifyPurgeBlocked(db, { tenantId, objectType, objectId, objectName = null, reasons = [], actor = null } = {}) {
  return notifyLifecycleEvent(db, {
    eventType: "LifecycleOperationFailed",
    tenantId,
    objectType,
    objectId,
    objectName,
    payload: { operation: "PURGE", blocked: true, reasons },
    actor,
  });
}

export async function notifyPurgeBlockedAsync(db, { tenantId, objectType, objectId, objectName = null, reasons = [], actor = null } = {}) {
  return await notifyLifecycleEventAsync(db, {
    eventType: "LifecycleOperationFailed",
    tenantId,
    objectType,
    objectId,
    objectName,
    payload: { operation: "PURGE", blocked: true, reasons },
    actor,
  });
}

export function notifyLegalHold(db, hold, { released = false, actor = null } = {}) {
  return notifyLifecycleEvent(db, {
    eventType: released ? "LegalHoldReleased" : "LegalHoldCreated",
    tenantId: hold.tenant_id,
    organizationId: hold.organization_id ?? null,
    objectType: "legal_hold",
    objectId: hold.id,
    objectName: hold.hold_ref,
    payload: { hold_ref: hold.hold_ref, code: hold.code, scope_type: hold.scope_type, status: hold.status },
    actor,
  });
}

export async function notifyLegalHoldAsync(db, hold, { released = false, actor = null } = {}) {
  return await notifyLifecycleEventAsync(db, {
    eventType: released ? "LegalHoldReleased" : "LegalHoldCreated",
    tenantId: hold.tenant_id,
    organizationId: hold.organization_id ?? null,
    objectType: "legal_hold",
    objectId: hold.id,
    objectName: hold.hold_ref,
    payload: { hold_ref: hold.hold_ref, code: hold.code, scope_type: hold.scope_type, status: hold.status },
    actor,
  });
}
