// Row -> public DTO mappers. Serialization lives in one place so the REST layer,
// the facade SDK and the tests all see the same shape and raw rows never leak.
import { parseArray, parseObject } from "./validation.js";

function bool(value) {
  return value === null || value === undefined ? false : Boolean(Number(value));
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

export function publicClassification(row) {
  if (!row) return null;
  return {
    id: row.id,
    classification_ref: row.classification_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    status: row.status,
    version: row.version,
    owner_user_id: row.owner_user_id ?? null,
    steward_user_id: row.steward_user_id ?? null,
    approval_status: row.approval_status || "PENDING",
    effective_date: row.effective_date ?? null,
    obsolete_date: row.obsolete_date ?? null,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicClassificationVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    classification_id: row.classification_id,
    tenant_id: row.tenant_id,
    version: row.version,
    status: row.status,
    snapshot: parseObject(row.snapshot_json, {}),
    change_reason: row.change_reason || "",
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

export function publicClass(row) {
  if (!row) return null;
  return {
    id: row.id,
    class_ref: row.class_ref || "",
    tenant_id: row.tenant_id,
    classification_id: row.classification_id,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    parent_class_id: row.parent_class_id ?? null,
    path: row.path || "",
    level: row.level,
    sort_order: row.sort_order,
    status: row.status,
    version: row.version,
    owner_user_id: row.owner_user_id ?? null,
    effective_date: row.effective_date ?? null,
    obsolete_date: row.obsolete_date ?? null,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicClassVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    class_id: row.class_id,
    tenant_id: row.tenant_id,
    version: row.version,
    status: row.status,
    snapshot: parseObject(row.snapshot_json, {}),
    change_reason: row.change_reason || "",
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

export function publicCharacteristic(row) {
  if (!row) return null;
  return {
    id: row.id,
    characteristic_ref: row.characteristic_ref || "",
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    data_type: row.data_type,
    unit: row.unit || "",
    base_unit: row.base_unit || "",
    precision: nullableNumber(row.precision),
    scale: nullableNumber(row.scale),
    min_value: nullableNumber(row.min_value),
    max_value: nullableNumber(row.max_value),
    min_inclusive: bool(row.min_inclusive),
    max_inclusive: bool(row.max_inclusive),
    default_value: row.default_value || "",
    multi_valued: bool(row.multi_valued),
    searchable: bool(row.searchable),
    required: bool(row.required),
    reference_type: row.reference_type || "",
    status: row.status,
    version: row.version,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicCharacteristicVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    characteristic_id: row.characteristic_id,
    tenant_id: row.tenant_id,
    version: row.version,
    status: row.status,
    snapshot: parseObject(row.snapshot_json, {}),
    change_reason: row.change_reason || "",
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

export function publicGroup(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    sort_order: row.sort_order,
    status: row.status,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicGroupMember(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    group_id: row.group_id,
    characteristic_id: row.characteristic_id,
    sequence: row.sequence,
    created_at: row.created_at,
  };
}

export function publicClassCharacteristic(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    class_id: row.class_id,
    characteristic_id: row.characteristic_id,
    sequence: row.sequence,
    required: bool(row.required),
    multi_valued: bool(row.multi_valued),
    origin: row.origin,
    override_required: bool(row.override_required),
    override_default: bool(row.override_default),
    unit_override: row.unit_override || "",
    min_value: nullableNumber(row.min_value),
    max_value: nullableNumber(row.max_value),
    allowed_value_mode: row.allowed_value_mode,
    allowed_value_ids: parseArray(row.allowed_value_ids_json, []),
    default_value: row.default_value || "",
    status: row.status,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicAllowedValue(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    characteristic_id: row.characteristic_id,
    code: row.code,
    display_name: row.display_name || "",
    description: row.description || "",
    sort_order: row.sort_order,
    status: row.status,
    effective_date: row.effective_date ?? null,
    obsolete_date: row.obsolete_date ?? null,
    metadata: parseObject(row.metadata_json, {}),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicAssignment(row) {
  if (!row) return null;
  return {
    id: row.id,
    assignment_ref: row.assignment_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    classification_id: row.classification_id,
    class_id: row.class_id,
    classification_version: row.classification_version,
    object_type: row.object_type,
    object_id: row.object_id,
    assigned_by: row.assigned_by ?? null,
    assigned_at: row.assigned_at,
    status: row.status,
    version: row.version,
    metadata: parseObject(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicAssignmentValue(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    assignment_id: row.assignment_id,
    characteristic_id: row.characteristic_id,
    sequence: row.sequence,
    value_text: row.value_text || "",
    value_number: nullableNumber(row.value_number),
    value_boolean: row.value_boolean === null || row.value_boolean === undefined ? null : bool(row.value_boolean),
    value_date: row.value_date ?? null,
    value_reference: row.value_reference || "",
    unit: row.unit || "",
    normalized_value: nullableNumber(row.normalized_value),
    normalized_unit: row.normalized_unit || "",
    status: row.status,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    rule_ref: row.rule_ref || "",
    tenant_id: row.tenant_id,
    class_id: row.class_id ?? null,
    characteristic_id: row.characteristic_id ?? null,
    rule_type: row.rule_type,
    config: parseObject(row.config_json, {}),
    severity: row.severity,
    message: row.message || "",
    status: row.status,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
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
