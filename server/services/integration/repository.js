// DTO mappers and shared query helpers for the Integration & API Framework.
// Nothing in this file returns encrypted secrets, credential material or
// unmasked sensitive payloads to an API caller.
import { randomBytes } from "node:crypto";
import {
  normalizeRetryPolicy,
  safeParse,
  maskPayload,
} from "./validation.js";

export function ref(prefix) {
  return `${prefix}-${randomBytes(8).toString("hex").toUpperCase()}`;
}

// Builds a tenant / organization / plant / site filter fragment. Callers pass a
// scope object; an undefined tenant means "all tenants" (platform admins only).
export function applyScope(clauses, params, scope = {}, alias = "") {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  if (scope.tenantId !== undefined && scope.tenantId !== null) {
    clauses.push(`${col("tenant_id")} = ?`);
    params.push(Number(scope.tenantId));
  }
  if (scope.organizationId) {
    clauses.push(`${col("organization_id")} = ?`);
    params.push(Number(scope.organizationId));
  }
  if (scope.plantId) {
    clauses.push(`${col("plant_id")} = ?`);
    params.push(Number(scope.plantId));
  }
  if (scope.siteId) {
    clauses.push(`${col("site_id")} = ?`);
    params.push(Number(scope.siteId));
  }
  return { clauses, params };
}

export function textSearch(clauses, params, columns, q) {
  const term = String(q || "").trim();
  if (!term) return;
  const like = `%${term.toLowerCase()}%`;
  clauses.push(`(${columns.map((c) => `LOWER(${c}) LIKE ?`).join(" OR ")})`);
  for (let i = 0; i < columns.length; i += 1) params.push(like);
}

export function sortClause(sort, allowed, fallback) {
  const map = allowed instanceof Set ? allowed : new Set(allowed);
  const [rawColumn, rawDir] = String(sort || "").split(":");
  const column = map.has(rawColumn) ? rawColumn : fallback.replace(/^.*\./, "");
  const dir = String(rawDir || "").toLowerCase() === "asc" ? "ASC" : "DESC";
  return { column: fallback.startsWith("LOWER") ? fallback : `${column} ${dir}`, columnName: column };
}

export function publicCredential(row, { includeSecret = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || "",
    kind: row.kind,
    description: row.description || "",
    tenant_id: row.tenant_id ?? null,
    config: safeParse(row.config_json, {}),
    status: row.status,
    has_secret: Boolean(row.secret_enc),
    rotated_at: row.rotated_at || null,
    expires_at: row.expires_at || null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(includeSecret ? { secret_enc: row.secret_enc } : {}),
  };
}

export function publicExternalSystem(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || "",
    system_type: row.system_type,
    description: row.description || "",
    environment: row.environment,
    base_url: row.base_url || "",
    connection_ref: row.connection_ref || "",
    auth_method: row.auth_method,
    credential_id: row.credential_id ?? null,
    protocols: safeParse(row.protocols_json, []),
    health_check: safeParse(row.health_check_json, {}),
    config: safeParse(row.config_json, {}),
    status: row.status,
    connection_status: row.connection_status,
    last_health_at: row.last_health_at || null,
    last_health_message: row.last_health_message || "",
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    site_id: row.site_id ?? null,
    owner_id: row.owner_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    integration_id: row.integration_id ?? null,
    schedule_type: row.schedule_type,
    cron_expression: row.cron_expression || "",
    interval_seconds: row.interval_seconds,
    daily_time: row.daily_time || "",
    weekdays: safeParse(row.weekdays_json, []),
    day_of_month: row.day_of_month,
    timezone: row.timezone,
    start_at: row.start_at || null,
    end_at: row.end_at || null,
    overlap_policy: row.overlap_policy,
    catchup_policy: row.catchup_policy,
    max_duration_seconds: row.max_duration_seconds,
    status: row.status,
    job_schedule_code: row.job_schedule_code || "",
    last_run_at: row.last_run_at || null,
    next_run_at: row.next_run_at || null,
    last_status: row.last_status || "",
    failure_count: row.failure_count,
    config: safeParse(row.config_json, {}),
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicTransformation(row, { includeSamples = true } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    version: row.version,
    status: row.status,
    source_format: row.source_format,
    target_format: row.target_format,
    source_schema: safeParse(row.source_schema_json, {}),
    target_schema: safeParse(row.target_schema_json, {}),
    mappings: safeParse(row.mappings_json, []),
    constants: safeParse(row.constants_json, {}),
    conditionals: safeParse(row.conditionals_json, []),
    conversions: safeParse(row.conversions_json, []),
    lookups: safeParse(row.lookups_json, []),
    validation: safeParse(row.validation_json, []),
    error_handling: row.error_handling,
    ...(includeSamples ? { sample_input: safeParse(row.sample_input_json, {}) } : {}),
    tenant_id: row.tenant_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicDefinition(row, { systems = {}, transformation = null, schedule = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    integration_type: row.integration_type,
    direction: row.direction,
    adapter_type: row.adapter_type,
    protocol: row.protocol,
    version: row.version,
    status: row.status,
    source_system_id: row.source_system_id ?? null,
    target_system_id: row.target_system_id ?? null,
    source_system: row.source_system_id ? systems.source || publicExternalSystem(systems.sourceRow) : null,
    target_system: row.target_system_id ? systems.target || publicExternalSystem(systems.targetRow) : null,
    credential_id: row.credential_id ?? null,
    transformation_id: row.transformation_id ?? null,
    transformation: transformation || null,
    schedule_id: row.schedule_id ?? null,
    schedule: schedule || null,
    endpoint_id: row.endpoint_id ?? null,
    retry_policy: normalizeRetryPolicy(safeParse(row.retry_policy_json, {})),
    config: safeParse(row.config_json, {}),
    auth: safeParse(row.auth_json, {}),
    timeout_seconds: row.timeout_seconds,
    owner_id: row.owner_id ?? null,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    site_id: row.site_id ?? null,
    last_run_at: row.last_run_at || null,
    last_status: row.last_status || "",
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicDefinitionVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    definition_id: row.definition_id,
    version: row.version,
    status: row.status,
    notes: row.notes || "",
    snapshot: safeParse(row.snapshot_json, {}),
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

export function publicEndpoint(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    integration_id: row.integration_id ?? null,
    external_system_id: row.external_system_id ?? null,
    direction: row.direction,
    method: row.method,
    path: row.path,
    api_version: row.api_version,
    request_format: row.request_format,
    response_format: row.response_format,
    request_schema: safeParse(row.request_schema_json, {}),
    response_schema: safeParse(row.response_schema_json, {}),
    auth_required: Boolean(row.auth_required),
    auth_method: row.auth_method,
    authorization_policy: row.authorization_policy || "",
    ip_allowlist: safeParse(row.ip_allowlist_json, []),
    timeout_seconds: row.timeout_seconds,
    rate_limit_per_minute: row.rate_limit_per_minute,
    retry_policy: normalizeRetryPolicy(safeParse(row.retry_policy_json, {})),
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicExecution(row, { steps = null, definition = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    execution_ref: row.execution_ref,
    definition_id: row.definition_id ?? null,
    integration_code: row.integration_code || "",
    integration_name: definition?.name || "",
    correlation_id: row.correlation_id || "",
    parent_execution_id: row.parent_execution_id ?? null,
    trigger_type: row.trigger_type,
    source_system_id: row.source_system_id ?? null,
    target_system_id: row.target_system_id ?? null,
    status: row.status,
    current_step: row.current_step || "",
    request_ref: row.request_ref || "",
    response_ref: row.response_ref || "",
    record_count: row.record_count,
    success_count: row.success_count,
    failure_count: row.failure_count,
    retry_count: row.retry_count,
    max_retries: row.max_retries,
    error_code: row.error_code || "",
    error_message: row.error_message || "",
    error_category: row.error_category || "",
    initiated_by: row.initiated_by ?? null,
    initiated_as: row.initiated_as,
    job_id: row.job_id ?? null,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    site_id: row.site_id ?? null,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    duration_ms: row.duration_ms ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(steps ? { steps } : {}),
  };
}

export function publicStep(row) {
  if (!row) return null;
  return {
    id: row.id,
    sequence: row.seq,
    name: row.name,
    status: row.status,
    message: row.message || "",
    detail: safeParse(row.detail_json, {}),
    started_at: row.started_at,
    finished_at: row.finished_at || null,
    duration_ms: row.duration_ms ?? null,
  };
}

export function publicMessage(row, { includePayload = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    message_ref: row.message_ref,
    message_type: row.message_type || "",
    direction: row.direction,
    integration_id: row.integration_id ?? null,
    queue: row.queue,
    source_system_id: row.source_system_id ?? null,
    target_system_id: row.target_system_id ?? null,
    correlation_id: row.correlation_id || "",
    idempotency_key: row.idempotency_key || "",
    payload_ref: row.payload_ref || "",
    payload_format: row.payload_format,
    payload_size: row.payload_size,
    priority: row.priority,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    next_retry_at: row.next_retry_at || null,
    last_error: row.last_error || "",
    error_category: row.error_category || "",
    tenant_id: row.tenant_id ?? null,
    created_at: row.created_at,
    processed_at: row.processed_at || null,
    failed_at: row.failed_at || null,
    updated_at: row.updated_at,
    ...(includePayload ? { payload: safeParse(row.payload_json, null) } : {}),
  };
}

export function publicDeadLetter(row, { includePayload = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    message_id: row.message_id ?? null,
    execution_id: row.execution_id ?? null,
    integration_id: row.integration_id ?? null,
    correlation_id: row.correlation_id || "",
    reason: row.reason || "",
    error_category: row.error_category || "",
    error_code: row.error_code || "",
    attempt_history: safeParse(row.attempt_history_json, []),
    stack_ref: row.stack_ref || "",
    payload_ref: row.payload_ref || "",
    status: row.status,
    resolution: row.resolution || "",
    resolved_by: row.resolved_by ?? null,
    resolved_at: row.resolved_at || null,
    tenant_id: row.tenant_id ?? null,
    dead_lettered_at: row.dead_lettered_at,
    created_at: row.created_at,
    ...(includePayload ? { payload: safeParse(row.payload_json, null) } : {}),
  };
}

export function publicMapping(row) {
  if (!row) return null;
  return {
    id: row.id,
    external_system_id: row.external_system_id,
    external_object_type: row.external_object_type,
    external_object_id: row.external_object_id,
    internal_object_type: row.internal_object_type,
    internal_object_id: row.internal_object_id,
    internal_revision: row.internal_revision || "",
    status: row.status,
    source_of_truth: row.source_of_truth,
    conflict_status: row.conflict_status || "",
    attributes: safeParse(row.attributes_json, {}),
    last_synced_at: row.last_synced_at || null,
    last_execution_id: row.last_execution_id ?? null,
    tenant_id: row.tenant_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicEventType(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || "",
    version: row.version,
    description: row.description || "",
    category: row.category,
    direction: row.direction,
    schema: safeParse(row.schema_json, {}),
    example: safeParse(row.example_json, {}),
    status: row.status,
    system: Boolean(row.system),
    tenant_id: row.tenant_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicSubscription(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || "",
    event_type_code: row.event_type_code,
    subscriber_type: row.subscriber_type,
    target_ref: row.target_ref || "",
    filter: safeParse(row.filter_json, {}),
    delivery_mode: row.delivery_mode,
    retry_policy: normalizeRetryPolicy(safeParse(row.retry_policy_json, {})),
    status: row.status,
    connection_status: row.connection_status,
    last_delivery_at: row.last_delivery_at || null,
    last_status: row.last_status || "",
    failure_count: row.failure_count,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicEvent(row, { includePayload = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    event_ref: row.event_ref,
    event_type_code: row.event_type_code,
    version: row.version,
    source_module: row.source_module,
    metadata: safeParse(row.metadata_json, {}),
    correlation_id: row.correlation_id || "",
    idempotency_key: row.idempotency_key || "",
    status: row.status,
    subscriber_count: row.subscriber_count,
    delivered_count: row.delivered_count,
    failed_count: row.failed_count,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(includePayload ? { payload: maskPayload(safeParse(row.payload_json, {})) } : {}),
  };
}

export function publicDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    event_id: row.event_id,
    subscription_id: row.subscription_id ?? null,
    event_type_code: row.event_type_code || "",
    subscriber_type: row.subscriber_type || "",
    target_ref: row.target_ref || "",
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    next_retry_at: row.next_retry_at || null,
    response_code: row.response_code ?? null,
    last_error: row.last_error || "",
    correlation_id: row.correlation_id || "",
    tenant_id: row.tenant_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    delivered_at: row.delivered_at || null,
  };
}

export function publicInboundWebhook(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    integration_id: row.integration_id ?? null,
    path: row.path,
    method: row.method,
    auth_type: row.auth_type,
    credential_id: row.credential_id ?? null,
    has_secret: Boolean(row.credential_id),
    event_type_code: row.event_type_code || "",
    payload_schema: safeParse(row.payload_schema_json, {}),
    ip_allowlist: safeParse(row.ip_allowlist_json, []),
    replay_window_seconds: row.replay_window_seconds,
    rate_limit_per_minute: row.rate_limit_per_minute,
    status: row.status,
    last_received_at: row.last_received_at || null,
    receive_count: row.receive_count,
    failure_count: row.failure_count,
    tenant_id: row.tenant_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicOutboundWebhook(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || "",
    description: row.description || "",
    url: row.url,
    event_filter: safeParse(row.event_filter_json, {}),
    credential_id: row.credential_id ?? null,
    has_secret: Boolean(row.credential_id),
    header: maskPayload(safeParse(row.header_json, {})),
    retry_policy: normalizeRetryPolicy(safeParse(row.retry_policy_json, {})),
    timeout_seconds: row.timeout_seconds,
    status: row.status,
    consecutive_failures: row.consecutive_failures,
    failure_threshold: row.failure_threshold,
    disabled_reason: row.disabled_reason || "",
    last_delivery_at: row.last_delivery_at || null,
    last_status_code: row.last_status_code ?? null,
    tenant_id: row.tenant_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicTransfer(row) {
  if (!row) return null;
  return {
    id: row.id,
    transfer_ref: row.transfer_ref,
    direction: row.direction,
    name: row.name || "",
    format: row.format,
    resource_type: row.resource_type,
    integration_id: row.integration_id ?? null,
    mapping_id: row.mapping_id ?? null,
    mode: row.mode,
    dry_run: Boolean(row.dry_run),
    filename: row.filename || "",
    content_type: row.content_type || "",
    template_code: row.template_code || "",
    size_bytes: row.size_bytes,
    status: row.status,
    total_rows: row.total_rows,
    success_count: row.success_count,
    failure_count: row.failure_count,
    skipped_count: row.skipped_count,
    duplicate_count: row.duplicate_count,
    progress: row.progress,
    errors: safeParse(row.errors_json, []),
    summary: safeParse(row.summary_json, {}),
    job_id: row.job_id ?? null,
    tenant_id: row.tenant_id ?? null,
    initiated_by: row.initiated_by ?? null,
    created_at: row.created_at,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    updated_at: row.updated_at,
  };
}

export function publicApiCatalog(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || "",
    api_group: row.api_group,
    version: row.version,
    description: row.description || "",
    auth_required: Boolean(row.auth_required),
    auth_methods: safeParse(row.auth_methods_json, []),
    rate_limit_per_minute: row.rate_limit_per_minute,
    request_schema: safeParse(row.request_schema_json, {}),
    response_schema: safeParse(row.response_schema_json, {}),
    docs_url: row.docs_url || "",
    status: row.status,
    deprecated_at: row.deprecated_at || null,
    sunset_at: row.sunset_at || null,
    tenant_id: row.tenant_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicApiClient(row, { apiKey = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || "",
    client_type: row.client_type,
    api_key_prefix: row.api_key_prefix || "",
    credential_id: row.credential_id ?? null,
    scopes: safeParse(row.scopes_json, []),
    allowed_systems: safeParse(row.allowed_systems_json, []),
    ip_allowlist: safeParse(row.ip_allowlist_json, []),
    status: row.status,
    last_used_at: row.last_used_at || null,
    expires_at: row.expires_at || null,
    tenant_id: row.tenant_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(apiKey ? { api_key: apiKey } : {}),
  };
}

export function publicHealthCheck(row) {
  if (!row) return null;
  return {
    id: row.id,
    system_id: row.system_id,
    status: row.status,
    latency_ms: row.latency_ms,
    message: row.message || "",
    detail: safeParse(row.detail_json, {}),
    checked_at: row.checked_at,
  };
}
