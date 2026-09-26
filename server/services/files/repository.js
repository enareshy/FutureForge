import { HttpError } from "../../validation.js";
import { queryOne } from "../../db.js";
import {
  FILE_STATUS_LABELS,
  DOWNLOADABLE_STATUSES,
  sanitizeFilename,
} from "./validation.js";

// Row → DTO mapping and shared lookups for the Document & File Management
// module. Storage keys are internal, so they are never included in public
// payloads; only a boolean "has_content" / provider hint is exposed.

export function safeParse(json, fallback = {}) {
  if (json === null || json === undefined || json === "") return fallback;
  if (typeof json === "object") return json;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

export function publicFolder(row) {
  if (!row) return null;
  return {
    id: row.id,
    uuid: row.uuid,
    code: row.code,
    name: row.name,
    description: row.description || "",
    parent_id: row.parent_id ?? null,
    path: row.path || "/",
    owner_id: row.owner_id ?? null,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    site_id: row.site_id ?? null,
    department_id: row.department_id ?? null,
    security_classification: row.security_classification,
    is_system: row.is_system === 1,
    status: row.status,
    is_deleted: Boolean(row.deleted_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicFile(row) {
  if (!row) return null;
  const hasContent = Boolean(row.storage_key);
  return {
    id: row.id,
    file_ref: row.file_ref,
    uuid: row.uuid,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    site_id: row.site_id ?? null,
    department_id: row.department_id ?? null,
    folder_id: row.folder_id ?? null,
    name: row.name,
    original_name: row.original_name || "",
    extension: row.extension || "",
    mime_type: row.mime_type,
    file_category: row.file_category,
    description: row.description || "",
    size_bytes: row.size_bytes,
    checksum: row.checksum || "",
    checksum_algorithm: row.checksum_algorithm,
    current_version_id: row.current_version_id ?? null,
    version_count: row.version_count,
    owner_id: row.owner_id ?? null,
    status: row.status,
    status_label: FILE_STATUS_LABELS[row.status] || String(row.status || "").toUpperCase(),
    security_classification: row.security_classification,
    virus_scan_status: row.virus_scan_status,
    preview_status: row.preview_status,
    rendition_status: row.rendition_status,
    custom_metadata: safeParse(row.custom_metadata_json, {}),
    storage_provider: row.storage_provider || "",
    has_content: hasContent,
    is_downloadable: hasContent && DOWNLOADABLE_STATUSES.includes(row.status),
    is_deleted: Boolean(row.deleted_at),
    deleted_at: row.deleted_at || null,
    deleted_by: row.deleted_by ?? null,
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
    file_id: row.file_id,
    version_number: row.version_number,
    version_label: row.version_label || `v${row.version_number}`,
    major: row.major,
    minor: row.minor,
    is_current: row.is_current === 1,
    previous_version_id: row.previous_version_id ?? null,
    name: row.name,
    original_name: row.original_name || "",
    extension: row.extension || "",
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    checksum: row.checksum || "",
    checksum_algorithm: row.checksum_algorithm,
    status: row.status,
    virus_scan_status: row.virus_scan_status,
    checkin_comment: row.checkin_comment || "",
    restored_from_version_id: row.restored_from_version_id ?? null,
    created_by: row.created_by ?? null,
    deleted_at: row.deleted_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(includeStorage
      ? { storage_provider: row.storage_provider, storage_bucket: row.storage_bucket }
      : { has_content: Boolean(row.storage_key) }),
  };
}

export function publicLock(row) {
  if (!row) return null;
  return {
    id: row.id,
    file_id: row.file_id,
    lock_type: row.lock_type,
    locked_by: row.locked_by ?? null,
    locked_by_username: row.locked_by_username || "",
    locked_by_display_name: row.locked_by_display_name || "",
    reason: row.reason || "",
    expires_at: row.expires_at || null,
    last_activity_at: row.last_activity_at || null,
    released_at: row.released_at || null,
    released_by: row.released_by ?? null,
    force_released: row.force_released === 1,
    release_reason: row.release_reason || "",
    is_expired: Boolean(row.expires_at && row.expires_at <= new Date().toISOString().replace("T", " ").slice(0, 19)),
    created_at: row.created_at,
  };
}

export function publicUpload(row) {
  if (!row) return null;
  return {
    id: row.id,
    upload_id: row.upload_id,
    file_id: row.file_id ?? null,
    name: row.name,
    original_name: row.original_name || "",
    extension: row.extension || "",
    mime_type: row.mime_type,
    file_category: row.file_category,
    description: row.description || "",
    security_classification: row.security_classification,
    custom_metadata: safeParse(row.custom_metadata_json, {}),
    declared_size: row.declared_size,
    declared_checksum: row.declared_checksum || "",
    upload_mode: row.upload_mode,
    chunk_size: row.chunk_size,
    total_chunks: row.total_chunks,
    received_chunks: row.received_chunks,
    received_bytes: row.received_bytes,
    folder_id: row.folder_id ?? null,
    status: row.status,
    duplicate_of_file_id: row.duplicate_of_file_id ?? null,
    error_message: row.error_message || "",
    expires_at: row.expires_at || null,
    completed_at: row.completed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicAssociation(row) {
  if (!row) return null;
  return {
    id: row.id,
    file_id: row.file_id,
    business_object_type: row.business_object_type,
    business_object_id: row.business_object_id,
    business_object_name: row.business_object_name || "",
    relationship_type: row.relationship_type,
    association_role: row.association_role || "",
    is_primary: row.is_primary === 1,
    display_order: row.display_order,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

export function publicCollection(row, { memberCount = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    owner_id: row.owner_id ?? null,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    is_system: row.is_system === 1,
    ...(memberCount === null ? {} : { member_count: memberCount }),
    is_deleted: Boolean(row.deleted_at),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicPermission(row) {
  if (!row) return null;
  return {
    id: row.id,
    resource_type: row.resource_type,
    resource_id: row.resource_id,
    principal_type: row.principal_type,
    principal_id: row.principal_id ?? null,
    permission: row.permission,
    effect: row.effect,
    tenant_id: row.tenant_id ?? null,
    granted_by: row.granted_by ?? null,
    expires_at: row.expires_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicProcessing(row) {
  if (!row) return null;
  return {
    id: row.id,
    file_id: row.file_id,
    version_id: row.version_id ?? null,
    processing_type: row.processing_type,
    status: row.status,
    provider: row.provider || "",
    attempts: row.attempts,
    result: safeParse(row.result_json, {}),
    error_message: row.error_message || "",
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    event_type: row.event_type,
    file_id: row.file_id ?? null,
    version_id: row.version_id ?? null,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    actor_id: row.actor_id ?? null,
    correlation_id: row.correlation_id || "",
    payload: safeParse(row.payload_json, {}),
    status: row.status,
    created_at: row.created_at,
  };
}

export function normalizeName(name) {
  return sanitizeFilename(name);
}

export function assertTenant(tenantId) {
  if (!tenantId) throw new HttpError(403, "Tenant context required");
  return Number(tenantId);
}

export function findFileRow(db, reference, tenantId = null) {
  const row = queryOne(
    db,
    "SELECT * FROM files WHERE id = ? OR file_ref = ? OR uuid = ?",
    [Number(reference) || -1, String(reference || ""), String(reference || "")]
  );
  if (!row) throw new HttpError(404, "File not found");
  if (tenantId !== null && tenantId !== undefined && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "File not found");
  }
  return row;
}

export function findFolderRow(db, reference, tenantId = null) {
  const row = queryOne(
    db,
    "SELECT * FROM folders WHERE id = ? OR uuid = ?",
    [Number(reference) || -1, String(reference || "")]
  );
  if (!row) throw new HttpError(404, "Folder not found");
  if (tenantId !== null && tenantId !== undefined && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Folder not found");
  }
  return row;
}

export function findVersionRow(db, fileId, versionReference) {
  const row = queryOne(
    db,
    `SELECT * FROM file_versions
     WHERE file_id = ? AND (id = ? OR version_number = ? OR version_label = ?)`,
    [fileId, Number(versionReference) || -1, Number(versionReference) || -1, String(versionReference || "")]
  );
  if (!row) throw new HttpError(404, "File version not found");
  return row;
}

export function fileRowById(db, id) {
  return queryOne(db, "SELECT * FROM files WHERE id = ?", [Number(id) || -1]);
}

export function currentVersionRow(db, fileId) {
  return queryOne(db, "SELECT * FROM file_versions WHERE file_id = ? AND is_current = 1", [Number(fileId)]);
}
