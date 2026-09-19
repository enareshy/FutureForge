import { queryOne } from "../../db.js";
import { CONTENT_STATUS_LABELS, DOWNLOADABLE_STATUSES } from "./constants.js";
import { Errors } from "./errors.js";

// Row → DTO mapping and shared lookups for the content module. Storage keys are
// internal and are never surfaced to clients; only provider hints, booleans and
// signed access URLs are exposed.

export function safeParse(json, fallback = {}) {
  if (json === null || json === undefined || json === "") return fallback;
  if (typeof json === "object") return json;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

export function assertTenant(tenantId) {
  if (tenantId === null || tenantId === undefined || tenantId === "") {
    throw Errors.tenantDenied("Tenant context is required for content operations");
  }
  return Number(tenantId);
}

export function assertSameTenant(row, tenantId, label = "Content") {
  if (tenantId === null || tenantId === undefined) return row;
  if (Number(row?.tenant_id) !== Number(tenantId)) throw Errors.notFound(`${label} not found`);
  return row;
}

function isoNow() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

export function publicContent(row) {
  if (!row) return null;
  const hasContent = Boolean(row.storage_key);
  return {
    id: row.id,
    content_id: row.content_id,
    content_key: row.content_key,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    site_id: row.site_id ?? null,
    department_id: row.department_id ?? null,
    object_type: row.object_type || "",
    object_id: row.object_id || "",
    versioning_revision_id: row.versioning_revision_id ?? null,
    version_id: row.version_id || null,
    content_type: row.content_type,
    content_role: row.content_role,
    is_primary: row.is_primary === 1,
    file_name: row.file_name,
    original_file_name: row.original_file_name || "",
    file_extension: row.file_extension || "",
    mime_type: row.mime_type,
    file_size: row.file_size,
    checksum: row.checksum || "",
    checksum_algorithm: row.checksum_algorithm,
    storage_provider: row.storage_provider || "",
    status: row.status,
    status_label: CONTENT_STATUS_LABELS[row.status] || String(row.status || "").toUpperCase(),
    security_status: row.security_status,
    processing_status: row.processing_status,
    current_version_id: row.current_version_id ?? null,
    version_count: row.version_count,
    quarantine_reason: row.quarantine_reason || "",
    dedupe_of_content_id: row.dedupe_of_content_id ?? null,
    security_classification: row.security_classification,
    description: row.description || "",
    metadata: safeParse(row.metadata_json, {}),
    has_content: hasContent,
    is_downloadable: hasContent && DOWNLOADABLE_STATUSES.includes(row.status) && row.security_status === "clean",
    is_deleted: Boolean(row.deleted_at),
    deleted_at: row.deleted_at || null,
    revision: row.revision,
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicVersion(row, { includeStorage = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    content_id: row.content_id,
    version_number: row.version_number,
    version_label: row.version_label || `v${row.version_number}`,
    is_current: row.is_current === 1,
    previous_version_id: row.previous_version_id ?? null,
    file_name: row.file_name,
    original_file_name: row.original_file_name || "",
    file_extension: row.file_extension || "",
    mime_type: row.mime_type,
    file_size: row.file_size,
    checksum: row.checksum || "",
    checksum_algorithm: row.checksum_algorithm,
    status: row.status,
    security_status: row.security_status,
    checkin_comment: row.checkin_comment || "",
    restored_from_version_id: row.restored_from_version_id ?? null,
    metadata: safeParse(row.metadata_json, {}),
    ...(includeStorage
      ? { storage_provider: row.storage_provider, storage_bucket: row.storage_bucket }
      : { has_content: Boolean(row.storage_key) }),
    created_by: row.created_by ?? null,
    deleted_at: row.deleted_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicAssociation(row) {
  if (!row) return null;
  return {
    id: row.id,
    association_ref: row.association_ref,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    object_type: row.object_type,
    object_id: row.object_id,
    object_name: row.object_name || "",
    versioning_revision_id: row.versioning_revision_id ?? null,
    version_id: row.version_id || null,
    content_id: row.content_id,
    content_role: row.content_role,
    is_primary: row.is_primary === 1,
    sequence: row.sequence,
    status: row.status,
    effective_from: row.effective_from || null,
    effective_to: row.effective_to || null,
    metadata: safeParse(row.metadata_json, {}),
    created_by: row.created_by ?? null,
    is_deleted: Boolean(row.deleted_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicUpload(row) {
  if (!row) return null;
  return {
    id: row.id,
    upload_id: row.upload_id,
    tenant_id: row.tenant_id ?? null,
    object_type: row.object_type || "",
    object_id: row.object_id || "",
    versioning_revision_id: row.versioning_revision_id ?? null,
    version_id: row.version_id || null,
    content_role: row.content_role,
    file_name: row.file_name,
    original_file_name: row.original_file_name || "",
    file_extension: row.file_extension || "",
    mime_type: row.mime_type,
    expected_size: row.expected_size,
    received_size: row.received_size,
    checksum: row.checksum || "",
    checksum_algorithm: row.checksum_algorithm,
    declared_checksum: row.declared_checksum || "",
    security_classification: row.security_classification,
    status: row.status,
    chunk_size: row.chunk_size,
    total_chunks: row.total_chunks,
    received_chunks: row.received_chunks,
    content_id: row.content_id ?? null,
    metadata: safeParse(row.metadata_json, {}),
    error_message: row.error_message || "",
    expires_at: row.expires_at || null,
    completed_at: row.completed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicLock(row) {
  if (!row) return null;
  return {
    id: row.id,
    content_id: row.content_id,
    lock_token: row.lock_token,
    lock_type: row.lock_type,
    locked_by: row.locked_by ?? null,
    locked_at: row.locked_at || null,
    last_activity_at: row.last_activity_at || null,
    expires_at: row.expires_at || null,
    released_at: row.released_at || null,
    released_by: row.released_by ?? null,
    force_released: row.force_released === 1,
    release_reason: row.release_reason || "",
    reason: row.reason || "",
    is_expired: Boolean(row.expires_at && row.expires_at <= isoNow()),
    created_at: row.created_at,
  };
}

export function publicRendition(row) {
  if (!row) return null;
  return {
    id: row.id,
    rendition_ref: row.rendition_ref,
    tenant_id: row.tenant_id ?? null,
    content_id: row.content_id,
    source_content_id: row.source_content_id ?? null,
    source_version_id: row.source_version_id ?? null,
    rendition_type: row.rendition_type,
    file_name: row.file_name || "",
    mime_type: row.mime_type,
    file_size: row.file_size,
    checksum: row.checksum || "",
    checksum_algorithm: row.checksum_algorithm,
    status: row.status,
    generator: row.generator || "",
    generator_version: row.generator_version || "",
    error_message: row.error_message || "",
    metadata: safeParse(row.metadata_json, {}),
    storage_provider: row.storage_provider || "",
    has_content: Boolean(row.storage_key),
    requested_by: row.requested_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at || null,
  };
}

export function publicScan(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id ?? null,
    content_id: row.content_id ?? null,
    version_id: row.version_id ?? null,
    scan_type: row.scan_type,
    scanner: row.scanner || "",
    engine_version: row.engine_version || "",
    status: row.status,
    result: row.result || "",
    signature: row.signature || "",
    details: safeParse(row.details_json, {}),
    scanned_bytes: row.scanned_bytes,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    created_at: row.created_at,
  };
}

export function publicProcessingJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id ?? null,
    content_id: row.content_id ?? null,
    version_id: row.version_id ?? null,
    rendition_id: row.rendition_id ?? null,
    job_type: row.job_type,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    payload: safeParse(row.payload_json, {}),
    result: safeParse(row.result_json, {}),
    error_message: row.error_message || "",
    scheduled_at: row.scheduled_at || null,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRetentionPolicy(row) {
  if (!row) return null;
  return {
    id: row.id,
    policy_ref: row.policy_ref,
    tenant_id: row.tenant_id ?? null,
    policy_code: row.policy_code,
    name: row.name,
    description: row.description || "",
    retention_days: row.retention_days,
    retention_start_basis: row.retention_start_basis,
    disposition: row.disposition,
    applies_to_role: row.applies_to_role || "",
    applies_to_object_type: row.applies_to_object_type || "",
    applies_to_classification: row.applies_to_classification || "",
    active: row.active === 1,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRetentionRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id ?? null,
    content_id: row.content_id,
    policy_id: row.policy_id ?? null,
    retention_start: row.retention_start || null,
    retention_end: row.retention_end || null,
    disposition: row.disposition,
    status: row.status,
    legal_hold: row.legal_hold === 1,
    evaluated_at: row.evaluated_at || null,
    notes: row.notes || "",
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicLegalHold(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id ?? null,
    content_id: row.content_id,
    reason: row.reason || "",
    case_ref: row.case_ref || "",
    status: row.status,
    applied_by: row.applied_by ?? null,
    applied_at: row.applied_at || null,
    released_by: row.released_by ?? null,
    released_at: row.released_at || null,
    created_at: row.created_at,
  };
}

export function publicStorageReference(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id ?? null,
    content_id: row.content_id,
    version_id: row.version_id ?? null,
    storage_provider: row.storage_provider || "",
    size_bytes: row.size_bytes,
    checksum: row.checksum || "",
    checksum_algorithm: row.checksum_algorithm,
    status: row.status,
    last_verified_at: row.last_verified_at || null,
    verified_checksum: row.verified_checksum || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    event_type: row.event_type,
    content_id: row.content_id ?? null,
    version_id: row.version_id ?? null,
    rendition_id: row.rendition_id ?? null,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    actor_id: row.actor_id ?? null,
    correlation_id: row.correlation_id || "",
    payload: safeParse(row.payload_json, {}),
    status: row.status,
    created_at: row.created_at,
  };
}

export function findContentRow(db, reference, tenantId = null) {
  const numeric = Number(reference);
  const row = queryOne(
    db,
    `SELECT * FROM content
     WHERE content_id = ? OR content_key = ? OR id = ?`,
    [String(reference || ""), String(reference || ""), Number.isInteger(numeric) ? numeric : -1]
  );
  if (!row) throw Errors.notFound();
  if (tenantId !== null && tenantId !== undefined && Number(row.tenant_id) !== Number(tenantId)) {
    throw Errors.notFound();
  }
  return row;
}

export function findContentById(db, id, tenantId = null) {
  const row = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(id) || -1]);
  if (!row) throw Errors.notFound();
  if (tenantId !== null && tenantId !== undefined && Number(row.tenant_id) !== Number(tenantId)) {
    throw Errors.notFound();
  }
  return row;
}

export function findVersionRow(db, contentId, reference) {
  const row = queryOne(
    db,
    `SELECT * FROM content_versions
     WHERE content_id = ? AND (id = ? OR version_number = ? OR version_label = ?)`,
    [Number(contentId), Number(reference) || -1, Number(reference) || -1, String(reference || "")]
  );
  if (!row) throw Errors.notFound("Content version not found");
  return row;
}

export function currentVersionRow(db, contentId) {
  return queryOne(db, "SELECT * FROM content_versions WHERE content_id = ? AND is_current = 1", [Number(contentId)]);
}

export function findRenditionRow(db, contentId, reference) {
  const row = queryOne(
    db,
    `SELECT * FROM content_renditions
     WHERE content_id = ? AND (id = ? OR rendition_ref = ? OR rendition_type = ?)`,
    [Number(contentId), Number(reference) || -1, String(reference || ""), String(reference || "").toUpperCase()]
  );
  if (!row) throw Errors.notFound("Rendition not found");
  return row;
}

export function findUploadRow(db, upload, tenantId = null) {
  const row = queryOne(db, "SELECT * FROM content_upload_sessions WHERE upload_id = ? OR CAST(id AS TEXT) = ?", [
    String(upload || ""),
    String(upload || ""),
  ]);
  if (!row) throw Errors.sessionNotFound();
  if (tenantId !== null && tenantId !== undefined && Number(row.tenant_id) !== Number(tenantId)) {
    throw Errors.sessionNotFound();
  }
  return row;
}

export function activeLockRow(db, contentId) {
  return queryOne(db, "SELECT * FROM content_locks WHERE content_id = ? AND released_at IS NULL", [Number(contentId)]);
}

export function activeLegalHoldRow(db, contentId) {
  return queryOne(db, "SELECT * FROM content_legal_holds WHERE content_id = ? AND status = 'active'", [Number(contentId)]);
}
