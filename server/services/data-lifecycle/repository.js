// Row -> public DTO mappers. Keeping serialization in one place means the REST
// layer, SDK and tests all see the same shape, and raw rows never leak.
import { parseArray, parseObject } from "./validation.js";

function bool(value) {
  return Boolean(Number(value));
}

export function publicState(row) {
  if (!row) return null;
  return {
    id: row.id,
    state_ref: row.state_ref,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    sequence: row.sequence,
    active: bool(row.active),
    read_allowed: bool(row.read_allowed),
    update_allowed: bool(row.update_allowed),
    delete_allowed: bool(row.delete_allowed),
    restore_allowed: bool(row.restore_allowed),
    export_allowed: bool(row.export_allowed),
    archive_eligible: bool(row.archive_eligible),
    purge_eligible: bool(row.purge_eligible),
    system: bool(row.system),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicTransition(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    from_state: row.from_state,
    to_state: row.to_state,
    action: row.action,
    description: row.description || "",
    requires_legal_hold_clear: bool(row.requires_legal_hold_clear),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicPolicy(row) {
  if (!row) return null;
  return {
    id: row.id,
    policy_ref: row.policy_ref,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    scope_type: row.scope_type,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    object_type: row.object_type || "",
    subtype: row.subtype || "",
    classification: row.classification || "",
    lifecycle_state: row.lifecycle_state || "",
    retention_period_days: row.retention_period_days,
    retention_basis: row.retention_basis,
    archive_action: row.archive_action,
    cold_storage_action: row.cold_storage_action,
    purge_action: row.purge_action,
    archive_after_days: row.archive_after_days,
    cold_storage_after_days: row.cold_storage_after_days,
    purge_after_days: row.purge_after_days,
    data_tier: row.data_tier,
    status: row.status,
    effective_from: row.effective_from || null,
    effective_to: row.effective_to || null,
    priority: row.priority,
    owner_user_id: row.owner_user_id ?? null,
    version: row.version,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicPolicyVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    policy_id: row.policy_id,
    tenant_id: row.tenant_id,
    version: row.version,
    snapshot: parseObject(row.snapshot_json, {}),
    change_summary: row.change_summary || "",
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

export function publicObjectLifecycle(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    object_type: row.object_type,
    object_id: String(row.object_id),
    object_ref: row.object_ref || "",
    current_state: row.current_state,
    previous_state: row.previous_state || null,
    data_tier: row.data_tier,
    retention_policy_id: row.retention_policy_id ?? null,
    retention_anchor: row.retention_anchor || null,
    retention_basis: row.retention_basis || null,
    retention_start: row.retention_start || null,
    archive_eligible_at: row.archive_eligible_at || null,
    cold_storage_at: row.cold_storage_at || null,
    purge_eligible_at: row.purge_eligible_at || null,
    legal_hold_status: row.legal_hold_status || "NONE",
    classification: row.classification || "internal",
    version: row.version,
    archived_at: row.archived_at || null,
    purged_at: row.purged_at || null,
    last_evaluated_at: row.last_evaluated_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicLegalHold(row, { objectIds = null, scopes = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    hold_ref: row.hold_ref,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    reason: row.reason || "",
    description: row.description || "",
    scope_type: row.scope_type,
    object_type: row.object_type || "",
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    classification: row.classification || "",
    business_domain: row.business_domain || "",
    status: row.status,
    start_date: row.start_date || null,
    end_date: row.end_date || null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    released_by: row.released_by ?? null,
    released_at: row.released_at || null,
    updated_at: row.updated_at,
    ...(objectIds ? { object_ids: objectIds } : {}),
    ...(scopes ? { scopes } : {}),
  };
}

export function publicArchiveRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    archive_ref: row.archive_ref,
    tenant_id: row.tenant_id,
    object_type: row.object_type,
    object_id: String(row.object_id),
    object_ref: row.object_ref || "",
    object_version: row.object_version ?? null,
    policy_id: row.policy_id ?? null,
    state_at_archive: row.state_at_archive,
    data_tier: row.data_tier,
    provider_code: row.provider_code,
    provider_type: row.provider_type || "DATABASE",
    storage_uri: row.storage_uri || "",
    checksum: row.checksum || "",
    size_bytes: row.size_bytes ?? 0,
    schema_version: row.schema_version ?? 1,
    manifest: parseObject(row.manifest_json, {}),
    status: row.status,
    idempotency_key: row.idempotency_key || "",
    archived_at: row.archived_at || null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRestoreRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    restore_ref: row.restore_ref,
    tenant_id: row.tenant_id,
    archive_id: row.archive_id ?? null,
    object_type: row.object_type,
    object_id: String(row.object_id),
    object_ref: row.object_ref || "",
    target_state: row.target_state,
    conflict_strategy: row.conflict_strategy,
    conflict_detected: Boolean(Number(row.conflict_detected)),
    conflict_details: parseObject(row.conflict_json, {}),
    dependencies: parseArray(row.dependencies_json, []),
    status: row.status,
    idempotency_key: row.idempotency_key || "",
    requested_by: row.requested_by ?? null,
    requested_at: row.requested_at || null,
    completed_at: row.completed_at || null,
    error: row.error || "",
  };
}

export function publicRecoveryRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    recovery_ref: row.recovery_ref,
    tenant_id: row.tenant_id,
    provider_code: row.provider_code,
    recovery_point_ref: row.recovery_point_ref || "",
    scope: row.scope || "",
    object_type: row.object_type || "",
    object_id: row.object_id != null ? String(row.object_id) : null,
    status: row.status,
    details: parseObject(row.details_json, {}),
    requested_by: row.requested_by ?? null,
    requested_at: row.requested_at || null,
    completed_at: row.completed_at || null,
    error: row.error || "",
  };
}

export function publicPurgeRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    purge_ref: row.purge_ref,
    tenant_id: row.tenant_id,
    object_type: row.object_type,
    object_id: String(row.object_id),
    object_ref: row.object_ref || "",
    policy_id: row.policy_id ?? null,
    archive_id: row.archive_id ?? null,
    reason: row.reason || "",
    eligibility: parseObject(row.eligibility_json, {}),
    status: row.status,
    idempotency_key: row.idempotency_key || "",
    executed_by: row.executed_by ?? null,
    executed_at: row.executed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicLifecycleJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_ref: row.job_ref,
    tenant_id: row.tenant_id,
    job_type: row.job_type,
    status: row.status,
    priority: row.priority,
    object_count: row.object_count,
    success_count: row.success_count,
    failure_count: row.failure_count,
    error_count: row.error_count,
    retry_count: row.retry_count,
    params: parseObject(row.params_json, {}),
    result: parseObject(row.result_json, {}),
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    platform_job_id: row.platform_job_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicHistory(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    object_type: row.object_type,
    object_id: String(row.object_id),
    object_ref: row.object_ref || "",
    action: row.action,
    from_state: row.from_state || null,
    to_state: row.to_state || null,
    data_tier: row.data_tier || null,
    policy_id: row.policy_id ?? null,
    reason: row.reason || "",
    details: parseObject(row.details_json, {}),
    actor_id: row.actor_id ?? null,
    created_at: row.created_at,
  };
}

export function publicDependency(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    object_type: row.object_type,
    object_id: String(row.object_id),
    depends_on_type: row.depends_on_type,
    depends_on_id: String(row.depends_on_id),
    relationship_type: row.relationship_type || "",
    blocking: Boolean(Number(row.blocking)),
    status: row.status,
    details: parseObject(row.details_json, {}),
    resolved_at: row.resolved_at || null,
    created_at: row.created_at,
  };
}
