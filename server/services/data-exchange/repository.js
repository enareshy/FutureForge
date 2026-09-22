// Row -> public DTO mappers. Serialization lives in one place so the REST layer,
// the facade SDK and the tests all see the same shape, and raw rows (including
// secret references) never leak. Secret values are never stored in these tables;
// connector credential references expose only the opaque `secret_ref`.
import { parseArray, parseObject } from "./validation.js";

function bool(value) {
  return Boolean(Number(value));
}

export function publicConnectorConfiguration(row) {
  if (!row) return null;
  return {
    id: row.id,
    config_ref: row.config_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    connector_type: row.connector_type,
    direction: row.direction,
    settings: parseObject(row.settings_json, {}),
    credential_ref_id: row.credential_ref_id ?? null,
    capabilities: parseArray(row.capabilities_json, []),
    status: row.status,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicCredentialReference(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name || "",
    credential_type: row.credential_type,
    secret_ref: row.secret_ref,
    metadata: parseObject(row.metadata_json, {}),
    status: row.status,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicImportDefinition(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_ref: row.definition_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    target_object_type: row.target_object_type,
    target_subtype: row.target_subtype || "",
    source_type: row.source_type,
    connector_config_id: row.connector_config_id ?? null,
    source_config: parseObject(row.source_config_json, {}),
    mapping: parseObject(row.mapping_json, {}),
    transformation: parseObject(row.transformation_json, {}),
    validation: parseObject(row.validation_json, {}),
    duplicate_strategy: row.duplicate_strategy,
    duplicate_key: parseObject(row.duplicate_key_json, {}),
    batch_size: row.batch_size,
    error_strategy: row.error_strategy,
    reconciliation_strategy: row.reconciliation_strategy,
    transaction_strategy: row.transaction_strategy,
    mode: row.mode,
    template_id: row.template_id ?? null,
    status: row.status,
    version: row.version,
    owner_user_id: row.owner_user_id ?? null,
    catalog_refs: parseObject(row.catalog_refs_json, {}),
    schedule: parseObject(row.schedule_json, {}),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicImportMapping(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_id: row.definition_id,
    tenant_id: row.tenant_id,
    sequence: row.sequence,
    source_field: row.source_field,
    target_field: row.target_field,
    mapping_type: row.mapping_type,
    data_type: row.data_type,
    required: bool(row.required),
    default_value: row.default_value,
    constant_value: row.constant_value,
    expression: row.expression || "",
    lookup: parseObject(row.lookup_json, {}),
    condition: parseObject(row.condition_json, {}),
    concat: parseArray(row.concat_json, []),
    split: parseObject(row.split_json, {}),
    nested: parseObject(row.nested_json, {}),
    transform: parseArray(row.transform_json, []),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicImportTransformation(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_id: row.definition_id,
    tenant_id: row.tenant_id,
    sequence: row.sequence,
    stage: row.stage,
    target_field: row.target_field || "",
    transformation_type: row.transformation_type,
    config: parseObject(row.config_json, {}),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicImportValidationRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_id: row.definition_id,
    tenant_id: row.tenant_id,
    sequence: row.sequence,
    level: row.level,
    target_field: row.target_field || "",
    rule_type: row.rule_type,
    config: parseObject(row.config_json, {}),
    severity: row.severity,
    message: row.message || "",
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicDefinitionVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_id: row.definition_id,
    tenant_id: row.tenant_id,
    version: row.version,
    status: row.status,
    snapshot: parseObject(row.snapshot_json, {}),
    change_summary: row.change_summary || "",
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

export function publicImportJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_ref: row.job_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    definition_id: row.definition_id ?? null,
    definition_version: row.definition_version,
    source_type: row.source_type || "",
    target_object_type: row.target_object_type || "",
    mode: row.mode,
    duplicate_strategy: row.duplicate_strategy,
    status: row.status,
    total_records: row.total_records,
    processed_records: row.processed_records,
    success_count: row.success_count,
    created_count: row.created_count,
    updated_count: row.updated_count,
    skipped_count: row.skipped_count,
    rejected_count: row.rejected_count,
    failed_count: row.failed_count,
    warning_count: row.warning_count,
    batch_size: row.batch_size,
    source: parseObject(row.source_json, {}),
    mapping: parseObject(row.mapping_json, {}),
    transformation: parseObject(row.transformation_json, {}),
    validation: parseObject(row.validation_json, {}),
    options: parseObject(row.options_json, {}),
    summary: parseObject(row.summary_json, {}),
    error_message: row.error_message || "",
    idempotency_key: row.idempotency_key || "",
    platform_job_id: row.platform_job_id ?? null,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicImportBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    tenant_id: row.tenant_id,
    batch_number: row.batch_number,
    start_record: row.start_record,
    end_record: row.end_record,
    total: row.total,
    success: row.success,
    created: row.created,
    updated: row.updated,
    skipped: row.skipped,
    rejected: row.rejected,
    failed: row.failed,
    duration_ms: row.duration_ms,
    status: row.status,
    error_message: row.error_message || "",
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    created_at: row.created_at,
  };
}

export function publicImportRecordResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    tenant_id: row.tenant_id,
    batch_number: row.batch_number,
    record_number: row.record_number,
    business_key: row.business_key || "",
    action: row.action,
    status: row.status,
    target_object_type: row.target_object_type || "",
    target_object_id: row.target_object_id || "",
    message: row.message || "",
    source: parseObject(row.source_json, {}),
    mapped: parseObject(row.mapped_json, {}),
    transformed: parseObject(row.transformed_json, {}),
    validation: parseObject(row.validation_json, {}),
    duration_ms: row.duration_ms,
    created_at: row.created_at,
  };
}

export function publicImportError(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    tenant_id: row.tenant_id,
    batch_number: row.batch_number,
    record_number: row.record_number,
    error_code: row.error_code,
    error_type: row.error_type,
    message: row.message || "",
    field: row.field || "",
    object_ref: row.object_ref || "",
    retryable: bool(row.retryable),
    suggested_resolution: row.suggested_resolution || "",
    details: parseObject(row.details_json, {}),
    resolved: bool(row.resolved),
    created_at: row.created_at,
  };
}

export function publicImportCheckpoint(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    tenant_id: row.tenant_id,
    checkpoint_number: row.checkpoint_number,
    last_record: row.last_record,
    processed: row.processed,
    success: row.success,
    failed: row.failed,
    state: parseObject(row.state_json, {}),
    created_at: row.created_at,
  };
}

export function publicImportReconciliation(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    tenant_id: row.tenant_id,
    strategy: row.strategy,
    source_count: row.source_count,
    valid_count: row.valid_count,
    target_count: row.target_count,
    created_count: row.created_count,
    updated_count: row.updated_count,
    skipped_count: row.skipped_count,
    failed_count: row.failed_count,
    rejected_count: row.rejected_count,
    variance: row.variance,
    reconciliation_percent: row.reconciliation_percent,
    report: parseObject(row.report_json, {}),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicExportDefinition(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_ref: row.definition_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    object_type: row.object_type,
    fields: parseArray(row.fields_json, []),
    filters: parseArray(row.filters_json, []),
    sort: parseArray(row.sort_json, []),
    transformation: parseObject(row.transformation_json, {}),
    format: row.format,
    destination: row.destination,
    destination_config: parseObject(row.destination_json, {}),
    schedule: parseObject(row.schedule_json, {}),
    security: parseObject(row.security_json, {}),
    catalog_refs: parseObject(row.catalog_refs_json, {}),
    max_records: row.max_records,
    status: row.status,
    version: row.version,
    owner_user_id: row.owner_user_id ?? null,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicExportFieldSelection(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_id: row.definition_id,
    tenant_id: row.tenant_id,
    sequence: row.sequence,
    field_path: row.field_path,
    display_name: row.display_name || "",
    data_type: row.data_type,
    transformation: parseArray(row.transformation_json, []),
    nested: bool(row.nested),
    status: row.status,
    created_at: row.created_at,
  };
}

export function publicExportFilter(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_id: row.definition_id,
    tenant_id: row.tenant_id,
    sequence: row.sequence,
    filter_type: row.filter_type,
    field: row.field || "",
    operator: row.operator,
    value: parseJsonValue(row.value_json),
    conjunction: row.conjunction,
    status: row.status,
    created_at: row.created_at,
  };
}

export function publicExportTransformation(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_id: row.definition_id,
    tenant_id: row.tenant_id,
    sequence: row.sequence,
    field_path: row.field_path,
    transformation_type: row.transformation_type,
    config: parseObject(row.config_json, {}),
    status: row.status,
    created_at: row.created_at,
  };
}

export function publicExportJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_ref: row.job_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    definition_id: row.definition_id ?? null,
    definition_version: row.definition_version,
    object_type: row.object_type || "",
    format: row.format,
    destination: row.destination,
    status: row.status,
    record_count: row.record_count,
    exported_count: row.exported_count,
    error_count: row.error_count,
    output_size: row.output_size,
    output_uri: row.output_uri || "",
    output_filename: row.output_filename || "",
    expires_at: row.expires_at || null,
    filters: parseArray(row.filters_json, []),
    fields: parseArray(row.fields_json, []),
    transformation: parseObject(row.transformation_json, {}),
    destination_config: parseObject(row.destination_json, {}),
    summary: parseObject(row.summary_json, {}),
    error_message: row.error_message || "",
    idempotency_key: row.idempotency_key || "",
    platform_job_id: row.platform_job_id ?? null,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicExportResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    tenant_id: row.tenant_id,
    result_ref: row.result_ref || "",
    format: row.format,
    storage_uri: row.storage_uri || "",
    filename: row.filename || "",
    content_type: row.content_type || "",
    size_bytes: row.size_bytes,
    checksum: row.checksum || "",
    record_count: row.record_count,
    expires_at: row.expires_at || null,
    status: row.status,
    created_at: row.created_at,
  };
}

export function publicTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    template_ref: row.template_ref || "",
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    direction: row.direction,
    object_type: row.object_type || "",
    version: row.version,
    definition: parseObject(row.definition_json, {}),
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
    job_id: row.job_id ?? null,
    definition_id: row.definition_id ?? null,
    definition_version: row.definition_version,
    action: row.action,
    status: row.status || "",
    source_type: row.source_type || row.object_type || "",
    target_object_type: row.target_object_type || "",
    format: row.format || "",
    total_records: row.total_records ?? row.record_count ?? 0,
    success_count: row.success_count ?? 0,
    failed_count: row.failed_count ?? 0,
    details: parseObject(row.details_json, {}),
    actor_id: row.actor_id ?? null,
    organization_id: row.organization_id ?? null,
    created_at: row.created_at,
  };
}

export function publicConfiguration(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    key: row.key,
    value: parseJsonValue(row.value_json),
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parseJsonValue(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(String(value));
  } catch {
    return value;
  }
}
