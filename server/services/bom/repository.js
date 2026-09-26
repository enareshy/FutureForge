// Row -> public DTO mappers. Serialization lives in one place so the REST layer,
// the facade SDK and the tests all see the same shape and raw rows never leak.
import { parseArray, parseObject } from "./validation.js";

function bool(value) {
  return value === null || value === undefined ? false : Boolean(Number(value));
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

export function publicBom(row) {
  if (!row) return null;
  return {
    id: row.id,
    bom_ref: row.bom_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    site_id: row.site_id ?? null,
    bom_number: row.bom_number,
    number: row.bom_number,
    name: row.name || "",
    description: row.description || "",
    bom_type: row.bom_type,
    owner_user_id: row.owner_user_id ?? null,
    owner_object_id: row.owner_object_id ?? null,
    status: row.status,
    lifecycle_state: row.lifecycle_state || row.status,
    current_revision_id: row.current_revision_id ?? null,
    metadata: parseObject(row.metadata_json, {}),
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
    bom_id: row.bom_id,
    revision_number: row.revision_number,
    revision: row.revision_number,
    revision_sequence: row.revision_sequence,
    status: row.status,
    lifecycle_state: row.lifecycle_state || row.status,
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
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicLine(row) {
  if (!row) return null;
  return {
    id: row.id,
    line_ref: row.line_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    bom_revision_id: row.bom_revision_id,
    parent_object_id: row.parent_object_id ?? null,
    parent_object_type: row.parent_object_type || "part",
    child_object_id: row.child_object_id ?? null,
    child_object_type: row.child_object_type || "part",
    child_revision: row.child_revision || "",
    quantity: nullableNumber(row.quantity),
    uom: row.uom || "",
    normalized_quantity: nullableNumber(row.normalized_quantity),
    normalized_uom: row.normalized_uom || "",
    find_number: row.find_number || "",
    sequence: row.sequence,
    reference_designator: row.reference_designator || "",
    reference_designators: row.reference_designator ? String(row.reference_designator).split(",") : [],
    usage: row.usage,
    optional: bool(row.optional),
    substitute: bool(row.substitute),
    substitute_group_id: row.substitute_group_id || "",
    effectivity: parseObject(row.effectivity_json, {}),
    variant_id: row.variant_id ?? null,
    variant_code: row.variant_code || "",
    configuration_context: row.configuration_context || "",
    attributes: parseObject(row.attributes_json, {}),
    notes: row.notes || "",
    line_status: row.line_status,
    relationship_id: row.relationship_id ?? null,
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicLineAttribute(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    line_id: row.line_id,
    attribute_code: row.attribute_code,
    data_type: row.data_type || "STRING",
    attribute_value: row.attribute_value || "",
    sequence: row.sequence,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicSubstitute(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    bom_revision_id: row.bom_revision_id,
    line_id: row.line_id ?? null,
    primary_object_id: row.primary_object_id ?? null,
    substitute_object_id: row.substitute_object_id,
    substitute_object_type: row.substitute_object_type || "part",
    substitute_group: row.substitute_group || "",
    priority: row.priority,
    ratio: nullableNumber(row.ratio),
    status: row.status,
    notes: row.notes || "",
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicBaseline(row) {
  if (!row) return null;
  return {
    id: row.id,
    baseline_ref: row.baseline_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    bom_id: row.bom_id,
    revision_id: row.revision_id,
    baseline_number: row.baseline_number,
    name: row.name || "",
    description: row.description || "",
    status: row.status,
    source_revision_number: row.source_revision_number || "",
    immutable: bool(row.immutable),
    line_count: row.line_count,
    snapshot: parseObject(row.snapshot_json, {}),
    created_by: row.created_by ?? null,
    frozen_at: row.frozen_at ?? null,
    frozen_by: row.frozen_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicBaselineLine(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    baseline_id: row.baseline_id,
    line_ref: row.line_ref || "",
    find_number: row.find_number || "",
    sequence: row.sequence,
    parent_object_id: row.parent_object_id ?? null,
    parent_object_type: row.parent_object_type || "part",
    child_object_id: row.child_object_id ?? null,
    child_object_type: row.child_object_type || "part",
    child_revision: row.child_revision || "",
    quantity: nullableNumber(row.quantity),
    uom: row.uom || "",
    usage: row.usage,
    optional: bool(row.optional),
    substitute: bool(row.substitute),
    reference_designator: row.reference_designator || "",
    effectivity: parseObject(row.effectivity_json, {}),
    variant_code: row.variant_code || "",
    attributes: parseObject(row.attributes_json, {}),
    level: row.level,
    path: row.path || "",
    created_at: row.created_at,
  };
}

export function publicTransformationDefinition(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_ref: row.definition_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    source_bom_type: row.source_bom_type,
    target_bom_type: row.target_bom_type,
    status: row.status,
    mapping_count: row.mapping_count,
    config: parseObject(row.config_json, {}),
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicTransformationMapping(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    definition_id: row.definition_id,
    mapping_ref: row.mapping_ref || "",
    source_path: row.source_path || "",
    target_path: row.target_path || "",
    mapping_type: row.mapping_type,
    expression: row.expression || "",
    default_value: row.default_value || "",
    required: bool(row.required),
    sequence: row.sequence,
    config: parseObject(row.config_json, {}),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicTransformationRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    run_ref: row.run_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    definition_id: row.definition_id ?? null,
    source_revision_id: row.source_revision_id ?? null,
    target_bom_id: row.target_bom_id ?? null,
    target_revision_id: row.target_revision_id ?? null,
    mode: row.mode,
    status: row.status,
    summary: parseObject(row.summary_json, {}),
    mapped_count: row.mapped_count,
    unmapped_count: row.unmapped_count,
    warning_count: row.warning_count,
    error_count: row.error_count,
    created_by: row.created_by ?? null,
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
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
    bom_id: row.bom_id ?? null,
    revision_id: row.revision_id ?? null,
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
    revision_id: row.revision_id ?? null,
    line_id: row.line_id ?? null,
    line_ref: row.line_ref || "",
    rule_code: row.rule_code || "",
    severity: row.severity,
    message: row.message || "",
    field: row.field || "",
    details: parseObject(row.details_json, {}),
    created_at: row.created_at,
  };
}

export function publicComparison(row) {
  if (!row) return null;
  return {
    id: row.id,
    comparison_ref: row.comparison_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    left_kind: row.left_kind,
    left_id: row.left_id,
    right_kind: row.right_kind,
    right_id: row.right_id,
    scope: row.scope,
    status: row.status,
    summary: parseObject(row.summary_json, {}),
    added_count: row.added_count,
    removed_count: row.removed_count,
    modified_count: row.modified_count,
    unchanged_count: row.unchanged_count,
    match_count: row.match_count,
    duration_ms: row.duration_ms,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

export function publicComparisonResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    comparison_id: row.comparison_id,
    change_type: row.change_type,
    line_ref: row.line_ref || "",
    child_object_id: row.child_object_id ?? null,
    child_object_type: row.child_object_type || "part",
    find_number: row.find_number || "",
    path: row.path || "",
    before: parseObject(row.before_json, {}),
    after: parseObject(row.after_json, {}),
    changes: parseArray(row.changes_json, []),
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
