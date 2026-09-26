// Row -> public DTO mappers. Serialization lives in one place so the REST layer,
// the facade SDK and the tests all see the same shape and raw rows never leak.
import { parseArray, parseObject } from "./validation.js";

function bool(value) {
  return Boolean(Number(value));
}

export function publicProject(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_ref: row.project_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    source_system: row.source_system || "",
    source_version: row.source_version || "",
    target_platform_version: row.target_platform_version || "",
    scope: parseObject(row.scope_json, {}),
    status: row.status,
    owner_user_id: row.owner_user_id ?? null,
    start_date: row.start_date ?? null,
    end_date: row.end_date ?? null,
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicProjectVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    project_id: row.project_id,
    tenant_id: row.tenant_id,
    version: row.version,
    status: row.status,
    snapshot: parseObject(row.snapshot_json, {}),
    change_summary: row.change_summary || "",
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

export function publicPackage(row) {
  if (!row) return null;
  return {
    id: row.id,
    package_ref: row.package_ref || "",
    project_id: row.project_id,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    object_type: row.object_type || "",
    source_object_type: row.source_object_type || "",
    target_object_type: row.target_object_type || "",
    source: parseObject(row.source_json, {}),
    scope: parseObject(row.scope_json, {}),
    mapping: parseObject(row.mapping_json, {}),
    transformation: parseArray(row.transformation_json, []),
    validation: parseArray(row.validation_json, []),
    dependency: parseArray(row.dependency_json, []),
    duplicate_strategy: row.duplicate_strategy,
    execution_order: row.execution_order,
    status: row.status,
    statistics: parseObject(row.statistics_json, {}),
    version: row.version,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicPackageVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    package_id: row.package_id,
    tenant_id: row.tenant_id,
    version: row.version,
    status: row.status,
    snapshot: parseObject(row.snapshot_json, {}),
    change_summary: row.change_summary || "",
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

export function publicDefinition(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_ref: row.definition_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    source_object_type: row.source_object_type || "",
    target_object_type: row.target_object_type || "",
    source: parseObject(row.source_json, {}),
    target_schema: parseObject(row.target_schema_json, {}),
    duplicate_strategy: row.duplicate_strategy,
    duplicate_key: parseObject(row.duplicate_key_json, {}),
    dependency_strategy: row.dependency_strategy,
    batch_size: row.batch_size,
    retry: parseObject(row.retry_json, {}),
    error_policy: row.error_policy,
    reconciliation_policy: row.reconciliation_policy,
    status: row.status,
    version: row.version,
    owner_user_id: row.owner_user_id ?? null,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
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

export function publicMapping(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_id: row.definition_id,
    tenant_id: row.tenant_id,
    sequence: row.sequence,
    source_field: row.source_field || "",
    target_field: row.target_field,
    mapping_type: row.mapping_type,
    config: parseObject(row.config_json, {}),
    required: bool(row.required),
    status: row.status,
    created_at: row.created_at,
  };
}

export function publicTransformation(row) {
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
  };
}

export function publicValidationRule(row) {
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
  };
}

export function publicDependency(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    package_id: row.package_id,
    depends_on_package_id: row.depends_on_package_id ?? null,
    dependency_type: row.dependency_type,
    source_ref: row.source_ref || "",
    target_ref: row.target_ref || "",
    required: bool(row.required),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicPlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    plan_ref: row.plan_ref || "",
    tenant_id: row.tenant_id,
    project_id: row.project_id,
    package_id: row.package_id ?? null,
    status: row.status,
    summary: parseObject(row.summary_json, {}),
    generated_by: row.generated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicPlanStep(row) {
  if (!row) return null;
  return {
    id: row.id,
    plan_id: row.plan_id,
    tenant_id: row.tenant_id,
    sequence: row.sequence,
    package_id: row.package_id ?? null,
    package_code: row.package_code || "",
    dependencies: parseArray(row.dependency_json, []),
    estimated_records: row.estimated_records,
    estimated_duration_ms: row.estimated_duration_ms,
    validation_status: row.validation_status,
    readiness: row.readiness,
    status: row.status,
    created_at: row.created_at,
  };
}

export function publicJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_ref: row.job_ref || "",
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    project_id: row.project_id ?? null,
    package_id: row.package_id ?? null,
    definition_id: row.definition_id ?? null,
    definition_version: row.definition_version,
    source_adapter: row.source_adapter || "",
    mode: row.mode,
    status: row.status,
    batch_size: row.batch_size,
    worker_count: row.worker_count,
    total_records: row.total_records,
    processed_records: row.processed_records,
    success_count: row.success_count,
    failed_count: row.failed_count,
    duplicate_count: row.duplicate_count,
    rejected_count: row.rejected_count,
    skipped_count: row.skipped_count,
    updated_count: row.updated_count,
    retry_count: row.retry_count,
    checkpoint: parseObject(row.checkpoint_json, {}),
    statistics: parseObject(row.statistics_json, {}),
    params: parseObject(row.params_json, {}),
    source: parseObject(row.source_json, {}),
    error_message: row.error_message || "",
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicBatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    tenant_id: row.tenant_id,
    batch_number: row.batch_number,
    status: row.status,
    records: row.records,
    success: row.success,
    failed: row.failed,
    duplicates: row.duplicates,
    rejected: row.rejected,
    skipped: row.skipped,
    checkpoint: parseObject(row.checkpoint_json, {}),
    started_at: row.started_at ?? null,
    completed_at: row.completed_at ?? null,
    created_at: row.created_at,
  };
}

export function publicCheckpoint(row) {
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

export function publicObjectResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    batch_id: row.batch_id ?? null,
    tenant_id: row.tenant_id,
    record_number: row.record_number,
    source_object_type: row.source_object_type || "",
    source_object_id: row.source_object_id || "",
    target_object_type: row.target_object_type || "",
    target_object_id: row.target_object_id || "",
    business_key: row.business_key || "",
    action: row.action,
    status: row.status,
    mapped: parseObject(row.mapped_json, {}),
    transformed: parseObject(row.transformed_json, {}),
    validation: parseObject(row.validation_json, {}),
    message: row.message || "",
    duration_ms: row.duration_ms,
    created_at: row.created_at,
  };
}

export function publicErrorEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    batch_id: row.batch_id ?? null,
    tenant_id: row.tenant_id,
    package_id: row.package_id ?? null,
    record_number: row.record_number,
    source_object_type: row.source_object_type || "",
    source_object_id: row.source_object_id || "",
    target_object_id: row.target_object_id || "",
    field: row.field || "",
    error_code: row.error_code || "",
    error_type: row.error_type,
    category: row.category,
    message: row.message || "",
    retryable: bool(row.retryable),
    attempt_count: row.attempt_count,
    status: row.status,
    details: parseObject(row.details_json, {}),
    resolved_by: row.resolved_by ?? null,
    resolved_at: row.resolved_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRetry(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    error_id: row.error_id ?? null,
    tenant_id: row.tenant_id,
    attempt: row.attempt,
    strategy: row.strategy,
    status: row.status,
    error_message: row.error_message || "",
    created_at: row.created_at,
  };
}

export function publicIdentifierMapping(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id ?? null,
    package_id: row.package_id ?? null,
    source_system: row.source_system || "",
    source_object_type: row.source_object_type || "",
    source_object_id: row.source_object_id,
    target_object_type: row.target_object_type || "",
    target_object_id: row.target_object_id || "",
    target_object_ref: row.target_object_ref || "",
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRelationshipMapping(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id ?? null,
    package_id: row.package_id ?? null,
    job_id: row.job_id ?? null,
    relationship_type: row.relationship_type || "",
    source_relationship_id: row.source_relationship_id || "",
    source_parent_id: row.source_parent_id || "",
    source_child_id: row.source_child_id || "",
    target_parent_id: row.target_parent_id || "",
    target_child_id: row.target_child_id || "",
    target_relationship_id: row.target_relationship_id || "",
    status: row.status,
    details: parseObject(row.details_json, {}),
    created_at: row.created_at,
  };
}

export function publicReconciliation(row) {
  if (!row) return null;
  return {
    id: row.id,
    reconciliation_ref: row.reconciliation_ref || "",
    job_id: row.job_id,
    tenant_id: row.tenant_id,
    strategy: row.strategy,
    source_count: row.source_count,
    processed_count: row.processed_count,
    successful_count: row.successful_count,
    failed_count: row.failed_count,
    duplicate_count: row.duplicate_count,
    rejected_count: row.rejected_count,
    target_count: row.target_count,
    variance: row.variance,
    reconciliation_percent: row.reconciliation_percent,
    status: row.status,
    report: parseObject(row.report_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicReconciliationException(row) {
  if (!row) return null;
  return {
    id: row.id,
    reconciliation_id: row.reconciliation_id,
    job_id: row.job_id ?? null,
    tenant_id: row.tenant_id,
    exception_type: row.exception_type,
    object_type: row.object_type || "",
    source_object_id: row.source_object_id || "",
    target_object_id: row.target_object_id || "",
    field: row.field || "",
    expected: row.expected || "",
    actual: row.actual || "",
    message: row.message || "",
    created_at: row.created_at,
  };
}

export function publicStatistic(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    job_id: row.job_id ?? null,
    package_id: row.package_id ?? null,
    project_id: row.project_id ?? null,
    snapshot: parseObject(row.snapshot_json, {}),
    created_at: row.created_at,
  };
}

export function publicAudit(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    project_id: row.project_id ?? null,
    package_id: row.package_id ?? null,
    definition_version: row.definition_version,
    job_id: row.job_id ?? null,
    batch_id: row.batch_id ?? null,
    source_object_type: row.source_object_type || "",
    source_object_id: row.source_object_id || "",
    target_object_type: row.target_object_type || "",
    target_object_id: row.target_object_id || "",
    action: row.action,
    status: row.status,
    error_message: row.error_message || "",
    transformation_version: row.transformation_version,
    correlation_id: row.correlation_id || "",
    actor_user_id: row.actor_user_id ?? null,
    actor_username: row.actor_username || "",
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

export function publicSourceConfiguration(row) {
  if (!row) return null;
  return {
    id: row.id,
    source_ref: row.source_ref || "",
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    adapter_type: row.adapter_type,
    settings: parseObject(row.settings_json, {}),
    credential_ref: row.credential_ref || "",
    status: row.status,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicFileMigration(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    project_id: row.project_id ?? null,
    package_id: row.package_id ?? null,
    job_id: row.job_id ?? null,
    source_object_type: row.source_object_type || "",
    source_object_id: row.source_object_id || "",
    target_object_id: row.target_object_id || "",
    original_filename: row.original_filename || "",
    mime_type: row.mime_type,
    file_size: row.file_size,
    checksum: row.checksum || "",
    storage_ref: row.storage_ref || "",
    file_version: row.file_version || "",
    upload_status: row.upload_status,
    virus_scan_status: row.virus_scan_status,
    status: row.status,
    error_message: row.error_message || "",
    details: parseObject(row.details_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
