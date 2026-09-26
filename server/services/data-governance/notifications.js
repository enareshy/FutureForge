// Notification integration. Governance does not implement its own messaging:
// it publishes through the Notification & Communication Framework, which
// applies templates, rules and user preferences. Publishing is best-effort so a
// notification failure never fails a governed write.
import { publish } from "../notifications.js";

export function notifyGovernanceEvent(db, { eventType, tenantId, organizationId = null, objectType, objectId, objectName = null, payload = {}, actor = null } = {}) {
  if (!eventType) return { published: 0, notifications: [] };
  try {
    return publish(
      db,
      {
        event_type: eventType,
        source_module: "data-governance",
        tenant_id: tenantId ?? null,
        organization_id: organizationId ?? null,
        object_type: objectType ?? null,
        object_id: objectId != null ? String(objectId) : null,
        object_name: objectName,
        payload,
        correlation_id: payload?.correlation_id,
        idempotency_key: payload?.idempotency_key || `data-governance:${eventType}:${objectType}:${objectId}`,
      },
      { actor }
    );
  } catch {
    return { published: 0, notifications: [], suppressed: true };
  }
}

export function notifyException(db, exception, { eventType = "DataQualityExceptionAssigned", actor = null, extra = {} } = {}) {
  return notifyGovernanceEvent(db, {
    eventType,
    tenantId: exception.tenant_id,
    organizationId: exception.organization_id,
    objectType: exception.object_type,
    objectId: exception.object_id,
    objectName: exception.exception_ref,
    payload: {
      exception_ref: exception.exception_ref,
      rule_code: exception.rule_code,
      severity: exception.severity,
      priority: exception.priority,
      status: exception.status,
      assignee_user_id: exception.assignee_user_id ?? null,
      assignee_group_id: exception.assignee_group_id ?? null,
      due_date: exception.due_date ?? null,
      ...extra,
    },
    actor,
  });
}

export function notifyCriticalQuality(db, result, { actor = null } = {}) {
  if (String(result.quality_status) !== "CRITICAL") return { published: 0, notifications: [] };
  return notifyGovernanceEvent(db, {
    eventType: "DataQualityScoreChanged",
    tenantId: result.tenant_id,
    organizationId: result.organization_id,
    objectType: result.object_type,
    objectId: result.object_id,
    objectName: result.object_name,
    payload: { overall_score: result.overall_score, quality_status: result.quality_status, evaluation_state: result.evaluation_state },
    actor,
  });
}
