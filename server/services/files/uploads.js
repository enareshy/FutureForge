import { queryAll, queryOne, run, nowIso, randomUuid, transaction } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { isPlatformAdmin, assertTenantScope } from "../tenants.js";
import {
  buildObjectKey,
  buildStagingKey,
  storageConfig,
  getStorageProvider,
} from "../file-storage.js";
import { findFolderRow, publicUpload, findFileRow, assertTenant, safeParse } from "./repository.js";
import { assertAccess } from "./permissions.js";
import { checkPermission } from "../authorization.js";
import { createVersion, versionDownload } from "./versions.js";
import { auditFile, recordFileEvent } from "./events.js";
import { generateFileRef } from "./files.js";
import {
  validateUploadInput,
  sanitizeFilename,
  categoryForMime,
  assertSecurityClassification,
  assertUploadMode,
} from "./validation.js";

// Upload sessions: single-shot, multipart/chunked and resumable. The storage
// service owns bytes and staging; this service owns the session lifecycle and
// the resulting file/version records. Storage keys never leave the backend.

const DEFAULT_UPLOAD_TTL_HOURS = 24;

function uploadTtl() {
  const hours = Number(process.env.FILE_UPLOAD_TTL_HOURS || DEFAULT_UPLOAD_TTL_HOURS);
  return new Date(Date.now() + Math.max(1, hours) * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function findUploadRow(db, uploadId, tenantId = null) {
  const row = queryOne(db, "SELECT * FROM file_uploads WHERE upload_id = ?", [String(uploadId || "")]);
  if (!row) throw new HttpError(404, "Upload session not found");
  if (tenantId !== null && tenantId !== undefined && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Upload session not found");
  }
  return row;
}

function assertUploadOpen(row) {
  if (["completed", "aborted", "expired"].includes(row.status)) {
    throw new HttpError(409, `Upload session is ${row.status}`);
  }
  if (row.expires_at && row.expires_at <= nowIso()) {
    throw new HttpError(410, "Upload session has expired");
  }
}

export function initiateUpload(db, body = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const config = storageConfig();

  // Uploading against an existing file creates a new immutable revision
  // (see completeUpload) rather than a brand new file.
  let fileId = null;
  let revisionFile = null;
  const fileRef = body.file_id ?? body.fileId;
  if (fileRef !== undefined && fileRef !== null && fileRef !== "") {
    revisionFile = findFileRow(db, fileRef, scope);
    if (revisionFile.deleted_at) throw new HttpError(409, "File is deleted");
    assertAccess(db, revisionFile, actor, "create_version", { tenantId: scope });
    fileId = revisionFile.id;
  }

  const validated = validateUploadInput({
    name: body.name || revisionFile?.name,
    mimeType: body.mime_type || body.mimeType || revisionFile?.mime_type,
    size: body.size ?? body.declared_size ?? body.declaredSize,
    maxSize: config.maxFileSize,
  });
  const classification =
    body.security_classification || body.securityClassification || revisionFile?.security_classification || "internal";
  assertSecurityClassification(classification);
  const requestedMode = body.upload_mode || body.uploadMode || (validated.size > config.chunkSize ? "multipart" : "single");
  assertUploadMode(requestedMode);

  const idempotencyKey = body.idempotency_key || body.idempotencyKey || null;
  if (idempotencyKey) {
    const existing = queryOne(db, "SELECT * FROM file_uploads WHERE idempotency_key = ? AND tenant_id = ?", [idempotencyKey, scope]);
    if (existing) return { upload: publicUpload(existing), chunk_size: existing.chunk_size, existing: true };
  }

  let folderId = revisionFile ? revisionFile.folder_id : null;
  const folderRef = body.folder_id ?? body.folderId;
  if (!revisionFile && folderRef !== undefined && folderRef !== null && folderRef !== "" && folderRef !== "root") {
    const folder = findFolderRow(db, folderRef, scope);
    if (folder.deleted_at) throw new HttpError(409, "Target folder is deleted");
    folderId = folder.id;
  }
  if (folderId) assertAccess(db, findFolderRow(db, folderId, scope), actor, "upload", { tenantId: scope });
  if (!isPlatformAdmin(db, actor?.id)) {
    const uploadGrant = checkPermission(db, actor, "iam.files.uploads", "create", {
      organizationId: body.organization_id ?? body.organizationId ?? actor?.organization_id ?? null,
    });
    if (!uploadGrant.allowed) throw new HttpError(403, "Not authorized to upload files");
  }

  const uploadId = randomUuid();
  const storageKey = buildObjectKey({ tenantId: scope });
  const stagingKey = requestedMode === "single" ? "" : buildStagingKey(uploadId);
  const mode = requestedMode;
  const chunkSize = mode === "multipart" ? config.chunkSize : 0;
  const totalChunks = mode === "multipart" ? Math.ceil(validated.size / config.chunkSize) : 1;
  const ts = nowIso();
  const insert = run(
    db,
    `INSERT INTO file_uploads
      (upload_id, file_id, tenant_id, organization_id, plant_id, site_id, department_id, folder_id,
       name, original_name, extension, mime_type, file_category, description, security_classification,
       custom_metadata_json, declared_size, declared_checksum, upload_mode, chunk_size, total_chunks,
       received_chunks, received_bytes, staging_key, storage_provider, storage_key, storage_bucket,
       status, idempotency_key, created_by, updated_by, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 'initiated', ?, ?, ?, ?, ?, ?)`,
    [
      uploadId, fileId, scope, body.organization_id ?? body.organizationId ?? revisionFile?.organization_id ?? actor?.organization_id ?? null,
      body.plant_id ?? revisionFile?.plant_id ?? null, body.site_id ?? revisionFile?.site_id ?? null,
      body.department_id ?? revisionFile?.department_id ?? null, folderId,
      validated.name, sanitizeFilename(body.original_name || body.originalName || validated.name), validated.extension,
      validated.mimeType, body.file_category || body.fileCategory || revisionFile?.file_category || categoryForMime(validated.mimeType, validated.extension),
      String(body.description ?? revisionFile?.description ?? "").slice(0, 4000), classification,
      JSON.stringify(body.custom_metadata ?? body.customMetadata ?? body.metadata ?? safeParse(revisionFile?.custom_metadata_json, {})),
      validated.size, body.checksum || body.declared_checksum || "", mode, chunkSize, totalChunks,
      stagingKey, getStorageProvider().kind, storageKey, getStorageProvider().bucket,
      idempotencyKey, actor?.id ?? null, actor?.id ?? null, uploadTtl(), ts, ts,
    ]
  );
  const row = findUploadRow(db, uploadId, scope);
  auditFile(db, {
    actor, tenantId: scope, organizationId: row.organization_id, action: "files.upload.initiate",
    objectType: "upload", objectId: row.id, objectName: row.name,
    details: { upload_id: uploadId, mode, declared_size: validated.size, chunks: totalChunks }, ip,
  });
  return {
    upload: publicUpload(row),
    chunk_size: chunkSize,
    total_chunks: totalChunks,
    mode,
    upload_url: `/api/files/uploads/${uploadId}/chunks`,
    idempotent: Boolean(idempotencyKey),
  };
}

// Appends one chunk to the staging object and updates resumable progress.
export async function uploadChunk(db, uploadId, index, buffer, actor, tenantId) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const row = findUploadRow(db, uploadId, scope);
  assertUploadOpen(row);
  if (row.upload_mode === "single") throw new HttpError(409, "Upload session does not accept chunks");
  if (!buffer || !buffer.length) throw new HttpError(400, "Chunk payload is required");
  if (row.chunk_size && buffer.length > row.chunk_size) throw new HttpError(413, "Chunk exceeds the declared chunk size");
  const chunkIndex = Number(index);
  if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= row.total_chunks) {
    throw new HttpError(400, `Chunk index must be between 0 and ${row.total_chunks - 1}`);
  }
  const provider = getStorageProvider();
  const stored = await provider.appendBuffer(row.staging_key || buildStagingKey(row.upload_id), buffer);
  const receivedChunks = Math.min(row.total_chunks, (row.received_chunks || 0) + 1);
  run(
    db,
    `UPDATE file_uploads SET status = 'in_progress', received_chunks = ?, received_bytes = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
    [receivedChunks, stored.size, actor?.id ?? null, nowIso(), row.id]
  );
  const updated = findUploadRow(db, row.upload_id, scope);
  return { upload: publicUpload(updated), received_chunks: updated.received_chunks, total_chunks: updated.total_chunks, received_bytes: updated.received_bytes };
}

// Completes an upload session. `body.buffer` carries the bytes for single mode;
// multipart sessions finalize from the staged object. The resulting file and
// first version are created through createVersion so scanning/auditing/events
// behave identically to every other version.
export async function completeUpload(db, uploadId, body = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const row = findUploadRow(db, uploadId, scope);
  if (row.status === "completed") {
    const file = row.file_id ? findFileRow(db, row.file_id, scope) : null;
    return { upload: publicUpload(row), file: file ? { ...file, storage_key: undefined } : null, already_completed: true };
  }
  assertUploadOpen(row);
  const provider = getStorageProvider();
  let storageKey = row.storage_key;
  let size = row.declared_size;
  let checksum = row.declared_checksum || "";

  if (row.upload_mode === "single") {
    let buffer = body?.buffer;
    if (!buffer && body?.path) {
      throw new HttpError(400, "Single uploads require the file payload");
    }
    if (!buffer && body?.data) buffer = Buffer.from(body.data, "base64");
    if (!buffer || !buffer.length) throw new HttpError(400, "File payload is required");
    if (row.declared_size && buffer.length !== row.declared_size) {
      throw new HttpError(422, "Uploaded size does not match the declared size");
    }
    const stored = await provider.putBuffer(storageKey, buffer);
    size = stored.size;
    checksum = checksum || stored.checksum;
  } else if (row.upload_mode === "multipart") {
    const staged = row.staging_key || buildStagingKey(row.upload_id);
    const info = await provider.stat(staged);
    if (!info) throw new HttpError(409, "No uploaded chunks were found for this session");
    if (row.total_chunks && row.received_chunks < row.total_chunks) {
      throw new HttpError(409, `Upload is incomplete (${row.received_chunks}/${row.total_chunks} chunks received)`);
    }
    await provider.move(staged, storageKey);
    size = info.size;
    checksum = checksum || (info.checksum || "");
  } else {
    // External/multipart-uploaded-by-client mode: bytes are already in storage.
    const info = await provider.stat(storageKey);
    if (!info) throw new HttpError(409, "Stored object not found for external upload");
    size = info.size;
    checksum = checksum || (info.checksum || "");
  }

  if (row.declared_checksum && checksum && row.declared_checksum !== checksum) {
    run(
      db,
      "UPDATE file_uploads SET status = 'failed', error_message = ?, updated_at = ? WHERE id = ?",
      ["Checksum verification failed", nowIso(), row.id]
    );
    throw new HttpError(422, "Uploaded file checksum does not match the declared checksum");
  }

  const ts = nowIso();
  run(db, "UPDATE file_uploads SET status = 'completing', storage_provider = ?, updated_at = ? WHERE id = ?", [provider.kind, ts, row.id]);

  let file = row.file_id ? findFileRow(db, row.file_id, scope) : null;
  if (!file) {
    file = transaction(db, () => {
      const insert = run(
        db,
        `INSERT INTO files
          (file_ref, uuid, tenant_id, organization_id, plant_id, site_id, department_id, folder_id,
           name, original_name, extension, mime_type, file_category, description, size_bytes, checksum,
           checksum_algorithm, version_count, owner_id, status, security_classification,
           virus_scan_status, preview_status, rendition_status, custom_metadata_json,
           storage_provider, storage_key, storage_bucket, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sha256', 0, ?, 'uploading', ?,
           'pending', 'pending', 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          generateFileRef(db), randomUuid(), scope, row.organization_id, row.plant_id, row.site_id, row.department_id, row.folder_id,
          row.name, row.original_name || row.name, row.extension, row.mime_type, row.file_category, row.description,
          size, checksum, actor?.id ?? null, row.security_classification, row.custom_metadata_json,
          provider.kind, storageKey, provider.bucket, actor?.id ?? null, actor?.id ?? null, ts, ts,
        ]
      );
      return findFileRow(db, insert.lastInsertRowid, scope);
    });
  }

  const result = await createVersion(
    db,
    file.id,
    {
      storage_key: storageKey,
      storage_provider: provider.kind,
      storage_bucket: provider.bucket,
      name: row.name,
      original_name: row.original_name || row.name,
      mime_type: row.mime_type,
      size,
      checksum,
      checkin_comment: body?.comment || body?.checkin_comment || "",
    },
    { actor, tenantId: scope, ip, provider, source: row.file_id ? "revision" : "upload" }
  );

  run(
    db,
    "UPDATE file_uploads SET status = 'completed', file_id = ?, storage_key = ?, staging_key = '', received_bytes = ?, completed_at = ?, updated_by = ?, updated_at = ? WHERE id = ?",
    [file.id, storageKey, size, ts, actor?.id ?? null, ts, row.id]
  );
  const completed = findUploadRow(db, row.upload_id, scope);
  recordFileEvent(db, {
    eventType: row.file_id ? "FileVersionCreated" : "FileUploaded",
    file: { ...result.file, storage_key: undefined },
    versionId: result.version?.id ?? null,
    actor,
    tenantId: scope,
    payload: { upload_id: row.upload_id, size_bytes: size, checksum },
  });
  auditFile(db, {
    actor, tenantId: scope, organizationId: file.organization_id, action: "files.upload.complete",
    file, details: { upload_id: row.upload_id, mode: row.upload_mode, size_bytes: size }, ip,
  });
  return { upload: publicUpload(completed), file: result.file, version: result.version, scan_status: result.scan_status };
}

export function abortUpload(db, uploadId, body = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const row = findUploadRow(db, uploadId, scope);
  if (row.status === "completed") throw new HttpError(409, "Upload already completed");
  if (row.status === "aborted") return { upload: publicUpload(row), aborted: true };
  const reason = String(body.reason || "").slice(0, 500);
  run(
    db,
    "UPDATE file_uploads SET status = 'aborted', error_message = ?, updated_by = ?, updated_at = ? WHERE id = ?",
    [reason, actor?.id ?? null, nowIso(), row.id]
  );
  if (row.staging_key) {
    getStorageProvider().deletePrefix(row.staging_key).catch(() => {});
  }
  auditFile(db, {
    actor, tenantId: scope, organizationId: row.organization_id, action: "files.upload.abort",
    objectType: "upload", objectId: row.id, objectName: row.name, details: { reason }, ip,
  });
  return { upload: publicUpload(findUploadRow(db, row.upload_id, scope)), aborted: true };
}

export function getUpload(db, uploadId, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const row = findUploadRow(db, uploadId, scope);
  return { upload: publicUpload(row) };
}

export function listUploads(db, query = {}, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const { page, pageSize, offset } = pagination(query);
  const where = ["tenant_id = ?"];
  const params = [scope];
  if (query.status) { where.push("status = ?"); params.push(query.status); }
  if (query.fileId || query.file_id) { where.push("file_id = ?"); params.push(Number(query.fileId ?? query.file_id)); }
  if (query.active === "true" || query.active_only === "true") {
    where.push("status IN ('initiated', 'in_progress', 'completing')");
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const items = queryAll(
    db,
    `SELECT * FROM file_uploads ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicUpload);
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM file_uploads ${clause}`, params).c;
  return { items, total, page, pageSize };
}

// Called by the worker to expire abandoned sessions and drop their staging data.
export async function expireUploads(db, { now = nowIso(), limit = 200 } = {}) {
  const rows = queryAll(
    db,
    `SELECT * FROM file_uploads
     WHERE status IN ('initiated', 'in_progress', 'completing') AND expires_at IS NOT NULL AND expires_at <= ?
     ORDER BY expires_at LIMIT ?`,
    [now, limit]
  );
  const provider = getStorageProvider();
  const expired = [];
  for (const row of rows) {
    run(db, "UPDATE file_uploads SET status = 'expired', updated_at = ? WHERE id = ?", [now, row.id]);
    if (row.staging_key) {
      try {
        await provider.deletePrefix(row.staging_key);
      } catch {
        /* staging cleanup is best effort */
      }
    }
    expired.push(row.upload_id);
  }
  return { expired_count: expired.length, upload_ids: expired };
}

export function uploadDownloadSession(db, uploadId, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const row = findUploadRow(db, uploadId, scope);
  if (!row.file_id) throw new HttpError(409, "Upload has no associated file yet");
  return versionDownload(db, row.file_id, null, actor, scope);
}
