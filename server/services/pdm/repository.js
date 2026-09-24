// Row -> public DTO mappers. Serialization lives in one place so the REST layer,
// the facade SDK and the tests all see the same shape and raw rows never leak.
import { parseArray, parseObject } from "./validation.js";

function bool(value) {
  return value === null || value === undefined ? false : Boolean(Number(value));
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

export function publicItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    item_ref: row.item_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    site_id: row.site_id ?? null,
    item_number: row.item_number,
    number: row.item_number,
    name: row.name || "",
    description: row.description || "",
    item_type: row.item_type,
    owner_user_id: row.owner_user_id ?? null,
    owner_object_id: row.owner_object_id ?? null,
    object_id: row.object_id ?? null,
    classification_code: row.classification_code || "",
    current_revision_id: row.current_revision_id ?? null,
    status: row.status,
    lifecycle_state: row.lifecycle_state || row.status,
    lifecycle_assignment_id: row.lifecycle_assignment_id ?? null,
    metadata: parseObject(row.metadata_json, {}),
    attributes: parseObject(row.attributes_json, {}),
    version: row.version,
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
    item_id: row.item_id,
    revision_number: row.revision_number,
    revision: row.revision_number,
    revision_sequence: row.revision_sequence,
    description: row.description || "",
    status: row.status,
    lifecycle_state: row.lifecycle_state || row.status,
    lifecycle_assignment_id: row.lifecycle_assignment_id ?? null,
    valid_from: row.valid_from ?? null,
    valid_to: row.valid_to ?? null,
    effectivity: parseObject(row.effectivity_json, {}),
    configuration_context: row.configuration_context || "",
    variant_id: row.variant_id ?? null,
    variant_code: row.variant_code || "",
    baseline_id: row.baseline_id ?? null,
    versioning_revision_id: row.versioning_revision_id ?? null,
    versioning_version_id: row.versioning_version_id ?? null,
    object_id: row.object_id ?? null,
    owner_user_id: row.owner_user_id ?? null,
    metadata: parseObject(row.metadata_json, {}),
    attributes: parseObject(row.attributes_json, {}),
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicDataset(row) {
  if (!row) return null;
  return {
    id: row.id,
    dataset_ref: row.dataset_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    item_id: row.item_id ?? null,
    revision_id: row.revision_id ?? null,
    object_id: row.object_id ?? null,
    dataset_number: row.dataset_number,
    number: row.dataset_number,
    name: row.name || "",
    description: row.description || "",
    dataset_type: row.dataset_type,
    status: row.status,
    lifecycle_state: row.lifecycle_state || row.status,
    owner_user_id: row.owner_user_id ?? null,
    content_id: row.content_id || "",
    content_type: row.content_type || "",
    content_reference: row.content_reference || "",
    checksum: row.checksum || "",
    size_bytes: row.size_bytes ?? null,
    metadata: parseObject(row.metadata_json, {}),
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRepresentation(row) {
  if (!row) return null;
  return {
    id: row.id,
    representation_ref: row.representation_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    item_id: row.item_id ?? null,
    revision_id: row.revision_id ?? null,
    source_object_id: row.source_object_id ?? null,
    dataset_id: row.dataset_id ?? null,
    name: row.name || "",
    description: row.description || "",
    representation_type: row.representation_type,
    status: row.status,
    generated: bool(row.generated),
    derived_from_id: row.derived_from_id ?? null,
    content_id: row.content_id || "",
    metadata: parseObject(row.metadata_json, {}),
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicDesignData(row) {
  if (!row) return null;
  return {
    id: row.id,
    design_data_ref: row.design_data_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    item_id: row.item_id ?? null,
    revision_id: row.revision_id ?? null,
    dataset_id: row.dataset_id ?? null,
    representation_id: row.representation_id ?? null,
    object_id: row.object_id ?? null,
    code: row.code || "",
    name: row.name || "",
    description: row.description || "",
    data_type: row.data_type,
    status: row.status,
    category: row.category || "",
    external_reference: row.external_reference || "",
    metadata: parseObject(row.metadata_json, {}),
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicCadAssociation(row) {
  if (!row) return null;
  return {
    id: row.id,
    association_ref: row.association_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    item_id: row.item_id ?? null,
    source_revision_id: row.source_revision_id ?? null,
    source_object_id: row.source_object_id ?? null,
    dataset_id: row.dataset_id,
    cad_type: row.cad_type,
    association_type: row.association_type,
    is_primary: bool(row.is_primary),
    primary: bool(row.is_primary),
    status: row.status,
    application: row.application || "",
    metadata: parseObject(row.metadata_json, {}),
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRevisionRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    rule_ref: row.rule_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    rule_type: row.rule_type,
    status: row.status,
    priority: row.priority,
    sequence: row.sequence,
    is_default: bool(row.is_default),
    current_version_id: row.current_version_id ?? null,
    version_number: row.version_number,
    config: parseObject(row.config_json, {}),
    metadata: parseObject(row.metadata_json, {}),
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicConfigurationRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    rule_ref: row.rule_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    rule_type: row.rule_type,
    status: row.status,
    priority: row.priority,
    sequence: row.sequence,
    is_default: bool(row.is_default),
    current_version_id: row.current_version_id ?? null,
    version_number: row.version_number,
    config: parseObject(row.config_json, {}),
    metadata: parseObject(row.metadata_json, {}),
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRuleVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    rule_id: row.rule_id,
    version_number: row.version_number,
    rule_type: row.rule_type,
    config: parseObject(row.config_json, {}),
    status: row.status,
    change_note: row.change_note || "",
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
    status: row.status,
    source_object_id: row.source_object_id ?? null,
    source_revision_id: row.source_revision_id ?? null,
    item_id: row.item_id ?? null,
    revision_rule_id: row.revision_rule_id ?? null,
    configuration_rule_id: row.configuration_rule_id ?? null,
    baseline_date: row.baseline_date ?? null,
    immutable: bool(row.immutable),
    member_count: row.member_count,
    snapshot: parseObject(row.snapshot_json, {}),
    created_by: row.created_by ?? null,
    released_at: row.released_at ?? null,
    released_by: row.released_by ?? null,
    frozen_at: row.frozen_at ?? null,
    frozen_by: row.frozen_by ?? null,
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
    member_id: row.member_id ?? null,
    member_ref: row.member_ref || "",
    item_id: row.item_id ?? null,
    revision_id: row.revision_id ?? null,
    dataset_id: row.dataset_id ?? null,
    representation_id: row.representation_id ?? null,
    relationship_id: row.relationship_id ?? null,
    level: row.level,
    path: row.path || "",
    metadata: parseObject(row.metadata_json, {}),
    created_at: row.created_at,
  };
}

export function publicRelationship(row) {
  if (!row) return null;
  return {
    id: row.id,
    relationship_ref: row.relationship_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    relationship_type: row.relationship_type,
    source_type: row.source_type,
    source_id: row.source_id,
    target_type: row.target_type,
    target_id: row.target_id,
    direction: row.direction,
    cardinality: row.cardinality,
    status: row.status,
    valid_from: row.valid_from ?? null,
    valid_to: row.valid_to ?? null,
    object_relationship_id: row.object_relationship_id ?? null,
    attributes: parseObject(row.attributes_json, {}),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicReference(row) {
  if (!row) return null;
  return {
    id: row.id,
    reference_ref: row.reference_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    source_type: row.source_type,
    source_id: row.source_id,
    source_ref: row.source_ref || "",
    target_type: row.target_type,
    target_id: row.target_id,
    target_ref: row.target_ref || "",
    category: row.category,
    relationship_type: row.relationship_type || "",
    metadata: parseObject(row.metadata_json, {}),
    created_at: row.created_at,
  };
}

export function publicValidationRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    rule_ref: row.rule_ref || "",
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    rule_type: row.rule_type,
    severity: row.severity,
    config: parseObject(row.config_json, {}),
    status: row.status,
    sequence: row.sequence,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicValidationResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    result_ref: row.result_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    item_id: row.item_id ?? null,
    revision_id: row.revision_id ?? null,
    dataset_id: row.dataset_id ?? null,
    scope: row.scope,
    status: row.status,
    rule_count: row.rule_count,
    issue_count: row.issue_count,
    error_count: row.error_count,
    warning_count: row.warning_count,
    duration_ms: row.duration_ms,
    actor_user_id: row.actor_user_id ?? null,
    created_at: row.created_at,
  };
}

export function publicValidationIssue(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    result_id: row.result_id ?? null,
    item_id: row.item_id ?? null,
    revision_id: row.revision_id ?? null,
    dataset_id: row.dataset_id ?? null,
    object_ref: row.object_ref || "",
    rule_code: row.rule_code || "",
    severity: row.severity,
    message: row.message || "",
    field: row.field || "",
    details: parseObject(row.details_json, {}),
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

export { nullableNumber, parseArray };
