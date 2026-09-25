// Row -> DTO mapping for the Standards & Exchange domain.
//
// All SQL parsing stays in the domain services; this file only shapes database
// rows into stable public objects, so the API never leaks internal columns.
import { SOURCE_MODULE } from "./constants.js";

export function parseJson(raw, fallback) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function bool(value) {
  return value === 1 || value === true;
}

export function toJson(value, fallback = {}) {
  if (value === null || value === undefined) return JSON.stringify(fallback);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function actorId(actor) {
  return actor && actor.id != null ? Number(actor.id) : null;
}

function actorName(actor) {
  return actor && actor.username ? String(actor.username) : "";
}

export function publicAdapter(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    provider: row.provider || "",
    provider_version: row.provider_version || "",
    category: row.category,
    status: row.status,
    capabilities: parseJson(row.capabilities_json, {}),
    formats: parseJson(row.formats_json, []),
    library: row.library || "",
    is_builtin: bool(row.is_builtin),
    metadata: parseJson(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicFormat(row) {
  if (!row) return null;
  return {
    id: row.id,
    format_ref: row.format_ref,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    standard_name: row.standard_name || "",
    standard_version: row.standard_version || "",
    description: row.description || "",
    category: row.category,
    mime_types: parseJson(row.mime_types_json, []),
    extensions: parseJson(row.extensions_json, []),
    direction: row.direction,
    adapter_code: row.adapter_code || "",
    import_supported: bool(row.import_supported),
    export_supported: bool(row.export_supported),
    validate_supported: bool(row.validate_supported),
    capabilities: parseJson(row.capabilities_json, {}),
    schema: parseJson(row.schema_json, {}),
    status: row.status,
    effective_from: row.effective_from || null,
    effective_to: row.effective_to || null,
    is_system: bool(row.is_system),
    display_order: row.display_order,
    metadata: parseJson(row.metadata_json, {}),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicFormatVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    format_id: row.format_id,
    tenant_id: row.tenant_id,
    version: row.version,
    standard_version: row.standard_version || "",
    status: row.status,
    schema: parseJson(row.schema_json, {}),
    capabilities: parseJson(row.capabilities_json, {}),
    change_summary: row.change_summary || "",
    effective_from: row.effective_from || null,
    effective_to: row.effective_to || null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicDefinition(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_ref: row.definition_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    site: row.site || "",
    code: row.code,
    name: row.name,
    description: row.description || "",
    format_code: row.format_code,
    format_version: row.format_version || "",
    direction: row.direction,
    source_object_type: row.source_object_type || "",
    target_object_type: row.target_object_type || "",
    source_schema: parseJson(row.source_schema_json, {}),
    mapping_code: row.mapping_code || "",
    transformation_code: row.transformation_code || "",
    validation_profile_code: row.validation_profile_code || "",
    security_policy: parseJson(row.security_policy_json, {}),
    scope: parseJson(row.scope_json, {}),
    lifecycle_constraints: parseJson(row.lifecycle_constraints_json, {}),
    version: row.version,
    status: row.status,
    approval_status: row.approval_status,
    owner_user_id: row.owner_user_id ?? null,
    effective_from: row.effective_from || null,
    effective_to: row.effective_to || null,
    published_at: row.published_at || null,
    published_by: row.published_by ?? null,
    metadata: parseJson(row.metadata_json, {}),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_module: SOURCE_MODULE,
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
    approval_status: row.approval_status,
    snapshot: parseJson(row.snapshot_json, {}),
    change_summary: row.change_summary || "",
    published_at: row.published_at || null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicMapping(row) {
  if (!row) return null;
  return {
    id: row.id,
    mapping_ref: row.mapping_ref,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    format_code: row.format_code || "",
    direction: row.direction,
    source_kind: row.source_kind,
    source_object_type: row.source_object_type || "",
    target_object_type: row.target_object_type || "",
    rules: parseJson(row.rules_json, []),
    version: row.version,
    status: row.status,
    immutable: bool(row.immutable),
    metadata: parseJson(row.metadata_json, {}),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicMappingVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    mapping_id: row.mapping_id,
    tenant_id: row.tenant_id,
    version: row.version,
    status: row.status,
    rules: parseJson(row.rules_json, []),
    change_summary: row.change_summary || "",
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicTransformation(row) {
  if (!row) return null;
  return {
    id: row.id,
    transformation_ref: row.transformation_ref,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    direction: row.direction,
    stage: row.stage,
    steps: parseJson(row.steps_json, []),
    version: row.version,
    status: row.status,
    immutable: bool(row.immutable),
    metadata: parseJson(row.metadata_json, {}),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicTransformationVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    transformation_id: row.transformation_id,
    tenant_id: row.tenant_id,
    version: row.version,
    status: row.status,
    steps: parseJson(row.steps_json, []),
    change_summary: row.change_summary || "",
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicValidationProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    profile_ref: row.profile_ref,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    format_code: row.format_code || "",
    direction: row.direction,
    target_object_type: row.target_object_type || "",
    levels: parseJson(row.levels_json, []),
    version: row.version,
    status: row.status,
    immutable: bool(row.immutable),
    metadata: parseJson(row.metadata_json, {}),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicValidationRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    profile_id: row.profile_id,
    tenant_id: row.tenant_id,
    sequence: row.sequence,
    level: row.level,
    target_field: row.target_field || "",
    rule_type: row.rule_type,
    config: parseJson(row.config_json, {}),
    severity: row.severity,
    message: row.message || "",
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicTransaction(row) {
  if (!row) return null;
  return {
    id: row.id,
    transaction_ref: row.transaction_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    site: row.site || "",
    definition_code: row.definition_code || "",
    definition_version: row.definition_version,
    format_code: row.format_code || "",
    format_version: row.format_version || "",
    direction: row.direction,
    operation: row.operation,
    status: row.status,
    source_kind: row.source_kind,
    source_name: row.source_name || "",
    input: parseJson(row.input_json, {}),
    output_ref: row.output_ref || "",
    output: parseJson(row.output_json, {}),
    counts: parseJson(row.counts_json, {}),
    validation_summary: parseJson(row.validation_summary_json, {}),
    reconciliation: parseJson(row.reconciliation_json, {}),
    security: parseJson(row.security_json, {}),
    file_ids: parseJson(row.file_ids_json, []),
    idempotency_key: row.idempotency_key || "",
    correlation_id: row.correlation_id || "",
    error: parseJson(row.error_json, {}),
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_ref: row.job_ref,
    tenant_id: row.tenant_id,
    transaction_ref: row.transaction_ref || "",
    handler_code: row.handler_code || "",
    platform_job_id: row.platform_job_id ?? null,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    progress: parseJson(row.progress_json, {}),
    error: row.error || "",
    queued_at: row.queued_at || null,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicJobResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    tenant_id: row.tenant_id,
    transaction_ref: row.transaction_ref || "",
    status: row.status,
    result: parseJson(row.result_json, {}),
    created_at: row.created_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicReconciliation(row) {
  if (!row) return null;
  const output = {
    id: row.id,
    reconciliation_ref: row.reconciliation_ref,
    tenant_id: row.tenant_id,
    transaction_ref: row.transaction_ref || "",
    details: parseJson(row.details_json, {}),
    created_at: row.created_at,
    source_module: SOURCE_MODULE,
  };
  for (const key of [
    "records_read",
    "records_validated",
    "records_created",
    "records_updated",
    "records_skipped",
    "records_failed",
    "relationships_created",
    "relationships_failed",
    "files_processed",
    "warnings",
    "errors",
  ]) {
    output[key] = Number(row[key] || 0);
  }
  return output;
}

export function publicError(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    transaction_ref: row.transaction_ref || "",
    definition_code: row.definition_code || "",
    severity: row.severity,
    code: row.code || "",
    message: row.message || "",
    source_path: row.source_path || "",
    target_object: row.target_object || "",
    attribute: row.attribute || "",
    rule: row.rule || "",
    status: row.status,
    details: parseJson(row.details_json, {}),
    created_at: row.created_at,
    source_module: SOURCE_MODULE,
  };
}

export function publicHistory(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    transaction_ref: row.transaction_ref || "",
    definition_code: row.definition_code || "",
    definition_version: row.definition_version,
    format_code: row.format_code || "",
    format_version: row.format_version || "",
    direction: row.direction,
    action: row.action,
    status: row.status,
    actor_user_id: row.actor_user_id ?? null,
    actor_username: row.actor_username || "",
    counts: parseJson(row.counts_json, {}),
    summary: row.summary || "",
    correlation_id: row.correlation_id || "",
    details: parseJson(row.details_json, {}),
    created_at: row.created_at,
    source_module: SOURCE_MODULE,
  };
}

export { actorId, actorName };
