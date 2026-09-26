// Row -> public DTO mappers. Serialization lives in one place so the REST
// layer, the facade SDK and the tests all see the same shape.
import { parseObject } from "./validation.js";

export function publicRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    request_ref: row.request_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    request_number: row.request_number,
    number: row.request_number,
    title: row.title || "",
    description: row.description || "",
    category: row.category,
    priority: row.priority,
    status: row.status,
    requested_by: row.requested_by ?? null,
    reason: row.reason || "",
    object_id: row.object_id ?? null,
    metadata: parseObject(row.metadata_json, {}),
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    order_ref: row.order_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    order_number: row.order_number,
    number: row.order_number,
    title: row.title || "",
    description: row.description || "",
    change_request_id: row.change_request_id ?? null,
    status: row.status,
    effective_strategy: row.effective_strategy,
    effective_context: parseObject(row.effective_context_json, {}),
    requested_by: row.requested_by ?? null,
    object_id: row.object_id ?? null,
    released_at: row.released_at ?? null,
    released_by: row.released_by ?? null,
    baseline_id: row.baseline_id ?? null,
    metadata: parseObject(row.metadata_json, {}),
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicNotice(row) {
  if (!row) return null;
  return {
    id: row.id,
    notice_ref: row.notice_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    notice_number: row.notice_number,
    number: row.notice_number,
    title: row.title || "",
    description: row.description || "",
    change_order_id: row.change_order_id,
    status: row.status,
    distribution: parseObject(row.distribution_json, []),
    issued_at: row.issued_at ?? null,
    issued_by: row.issued_by ?? null,
    acknowledged_at: row.acknowledged_at ?? null,
    metadata: parseObject(row.metadata_json, {}),
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicAffectedItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    change_order_id: row.change_order_id,
    object_type: row.object_type,
    object_id: row.object_id,
    object_label: row.object_label || "",
    disposition: row.disposition,
    notes: row.notes || "",
    resulting_object_type: row.resulting_object_type ?? null,
    resulting_object_id: row.resulting_object_id ?? null,
    effectivity_definition_id: row.effectivity_definition_id ?? null,
    effectivity_assignment_id: row.effectivity_assignment_id ?? null,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRelationship(row) {
  if (!row) return null;
  return {
    id: row.id,
    relationship_ref: row.relationship_ref || "",
    tenant_id: row.tenant_id,
    relationship_type: row.relationship_type,
    source_type: row.source_type,
    source_id: row.source_id,
    target_type: row.target_type,
    target_id: row.target_id,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

export function publicHistory(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    entity_type: row.entity_type,
    entity_id: row.entity_id ?? null,
    entity_ref: row.entity_ref || "",
    action: row.action,
    version: row.version,
    status: row.status || "",
    before: parseObject(row.before_json, {}),
    after: parseObject(row.after_json, {}),
    actor_user_id: row.actor_user_id ?? null,
    actor_username: row.actor_username || "",
    correlation_id: row.correlation_id || "",
    details: parseObject(row.details_json, {}),
    created_at: row.created_at,
  };
}

export function publicConfiguration(row) {
  if (!row) return null;
  let value = null;
  try {
    value = JSON.parse(row.value_json);
  } catch {
    value = null;
  }
  return { key: row.key, value, updated_at: row.updated_at };
}
