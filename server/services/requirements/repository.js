// Row -> public DTO mappers. Serialization lives in one place so the REST
// layer, the facade SDK and the tests all see the same shape (mirrors
// server/services/change/repository.js).
import { parseObject } from "./validation.js";

export function publicType(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id ?? null,
    type_ref: row.type_ref || "",
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    category: row.category || "OTHER",
    parent_code: row.parent_code ?? null,
    numbering_scheme: row.numbering_scheme ?? null,
    lifecycle_code: row.lifecycle_code ?? null,
    workflow_code: row.workflow_code ?? null,
    required_fields: parseObject(row.required_fields_json, []),
    allowed_relationships: parseObject(row.allowed_relationships_json, []),
    layout: parseObject(row.layout_json, {}),
    sequence: row.sequence,
    status: row.status,
    is_system: Number(row.is_system || 0) === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRequirement(row) {
  if (!row) return null;
  return {
    id: row.id,
    requirement_ref: row.requirement_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    business_unit_id: row.business_unit_id ?? null,
    site_id: row.site_id ?? null,
    requirement_number: row.requirement_number,
    number: row.requirement_number,
    external_reference: row.external_reference || "",
    name: row.name || "",
    title: row.title || "",
    description: row.description || "",
    requirement_type: row.requirement_type || "",
    category: row.category || "",
    source: row.source,
    domain: row.domain,
    discipline: row.discipline,
    priority: row.priority,
    criticality: row.criticality,
    classification: row.classification,
    tags: parseObject(row.tags_json, []),
    owner_user_id: row.owner_user_id ?? null,
    responsible_user_id: row.responsible_user_id ?? null,
    responsible_group_id: row.responsible_group_id ?? null,
    parent_id: row.parent_id ?? null,
    revision: row.revision,
    version: row.version,
    status: row.status,
    lifecycle_state: row.lifecycle_state,
    lifecycle_assignment_id: row.lifecycle_assignment_id ?? null,
    quality_status: row.quality_status,
    completeness_status: row.completeness_status,
    verification_status: row.verification_status,
    validation_status: row.validation_status,
    traceability_status: row.traceability_status,
    effective_from: row.effective_from ?? null,
    effective_to: row.effective_to ?? null,
    released_at: row.released_at ?? null,
    released_by: row.released_by ?? null,
    obsolete_at: row.obsolete_at ?? null,
    approved_by: row.approved_by ?? null,
    approved_at: row.approved_at ?? null,
    object_id: row.object_id ?? null,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRevision(row) {
  if (!row) return null;
  return {
    id: row.id,
    revision_ref: row.revision_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    requirement_id: row.requirement_id,
    requirement_number: row.requirement_number || "",
    revision: row.revision,
    revision_status: row.revision_status,
    description: row.description || "",
    change_reason: row.change_reason || "",
    change_ref: row.change_ref ?? null,
    title: row.title || "",
    snapshot: parseObject(row.snapshot_json, {}),
    effective_from: row.effective_from ?? null,
    effective_to: row.effective_to ?? null,
    released_at: row.released_at ?? null,
    released_by: row.released_by ?? null,
    superseded_by_revision: row.superseded_by_revision ?? null,
    version: row.version,
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
    status: row.status,
    effectivity_from: row.effectivity_from ?? null,
    effectivity_to: row.effectivity_to ?? null,
    attributes: parseObject(row.attributes_json, {}),
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

export function publicBaseline(row) {
  if (!row) return null;
  return {
    id: row.id,
    baseline_ref: row.baseline_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    baseline_number: row.baseline_number,
    number: row.baseline_number,
    name: row.name || "",
    description: row.description || "",
    baseline_version: row.baseline_version || "1.0",
    owner_user_id: row.owner_user_id ?? null,
    status: row.status,
    baseline_date: row.baseline_date ?? null,
    released_at: row.released_at ?? null,
    released_by: row.released_by ?? null,
    member_count: row.member_count != null ? Number(row.member_count) : undefined,
    metadata: parseObject(row.metadata_json, {}),
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicBaselineMember(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    baseline_id: row.baseline_id,
    member_type: row.member_type,
    requirement_id: row.requirement_id,
    requirement_number: row.requirement_number || "",
    revision_id: row.revision_id ?? null,
    revision: row.revision ?? null,
    requirement_ref: row.requirement_ref || "",
    title: row.title || "",
    metadata: parseObject(row.metadata_json, {}),
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

export function publicValidationRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    rule_type: row.rule_type,
    target_attribute: row.target_attribute ?? null,
    requirement_type: row.requirement_type ?? null,
    severity: row.severity,
    condition: parseObject(row.condition_json, {}),
    parameters: parseObject(row.parameters_json, {}),
    message: row.message || "",
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
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
