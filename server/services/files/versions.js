import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { getStorageProvider } from "../file-storage.js";
import { assertTenantScope } from "../tenants.js";
import {
  findFileRow,
  findVersionRow,
  currentVersionRow,
  publicFile,
  publicVersion,
  assertTenant,
} from "./repository.js";
import { auditFile, recordFileEvent } from "./events.js";
import { assertAccess } from "./permissions.js";
import { runProcessingPipeline, persistProcessingResult } from "./processing.js";
import { sanitizeFilename, mimeFor, extensionOf } from "./validation.js";

// Immutable file version chain. Every mutation creates a new version row; the
// only fields ever updated on an existing version are its processing status.
// Restoring an old version copies its storage reference into a brand-new
// version, so history is never rewritten and bytes are never duplicated.

export function listVersions(db, fileReference, query = {}, tenantId) {
  const scope = assertTenant(tenantId);
  const file = findFileRow(db, fileReference, scope);
  const { page, pageSize, offset } = pagination(query);
  const items = queryAll(
    db,
    `SELECT v.*, u.username AS created_username, u.display_name AS created_display_name
     FROM file_versions v LEFT JOIN users u ON u.id = v.created_by
     WHERE v.file_id = ? AND v.deleted_at IS NULL
     ORDER BY v.version_number DESC LIMIT ? OFFSET ?`,
    [file.id, pageSize, offset]
  ).map((row) => ({ ...publicVersion(row), created_username: row.created_username || "", created_display_name: row.created_display_name || "" }));
  const total = queryOne(db, "SELECT COUNT(*) AS c FROM file_versions WHERE file_id = ? AND deleted_at IS NULL", [file.id]).c;
  return { items, total, page, pageSize, file: publicFile(file) };
}

export function getVersion(db, fileReference, versionReference, tenantId) {
  const scope = assertTenant(tenantId);
  const file = findFileRow(db, fileReference, scope);
  const row = findVersionRow(db, file.id, versionReference);
  return publicVersion(row);
}

function nextVersionNumbers(db, fileId, { majorBump = false } = {}) {
  const last = queryOne(
    db,
    "SELECT version_number, major, minor FROM file_versions WHERE file_id = ? ORDER BY version_number DESC LIMIT 1",
    [fileId]
  );
  const versionNumber = (last?.version_number || 0) + 1;
  let major = last?.major ?? 1;
  let minor = last?.minor ?? 0;
  if (!last) {
    minor = 0;
  } else if (majorBump) {
    major += 1;
    minor = 0;
  } else {
    minor += 1;
  }
  return { versionNumber, major, minor, label: `${major}.${minor}` };
}

// Creates a new version from an already-stored object (upload completion,
// direct version creation or check-in). The caller supplies an opaque storage
// reference produced by the storage service. Processing (checksum, malware scan,
// preview) runs before the transaction so all database writes stay atomic.
export async function createVersion(db, fileReference, input = {}, { actor, tenantId, ip, provider, source = "upload" } = {}) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const file = findFileRow(db, fileReference, scope);
  if (file.deleted_at) throw new HttpError(409, "Cannot version a deleted file");
  if (file.status === "quarantined" || file.status === "scan_failed") {
    throw new HttpError(409, "File is not available for new versions");
  }
  if (!input.storage_key) throw new HttpError(400, "storage_key is required to create a version");

  const name = sanitizeFilename(input.name || file.name, { fallback: file.name });
  const extension = extensionOf(name);
  const mimeType = input.mime_type || mimeFor(name);
  const size = Number(input.size ?? input.size_bytes ?? 0) || 0;
  const checksum = input.checksum || "";
  const comment = String(input.checkin_comment ?? input.comment ?? "").slice(0, 2000);
  const majorBump = input.major === true || input.major_bump === true;

  const store = provider || getStorageProvider();
  const outcome = await runProcessingPipeline(store, {
    key: input.storage_key, size, mimeType, extension, name, checksum,
  });

  return transaction(db, () => {
    const previous = currentVersionRow(db, file.id);
    const { versionNumber, major, minor, label } = nextVersionNumbers(db, file.id, { majorBump });
    const ts = nowIso();
    const insert = run(
      db,
      `INSERT INTO file_versions
        (file_id, version_number, version_label, major, minor, is_current, previous_version_id,
         name, original_name, extension, mime_type, size_bytes, checksum, checksum_algorithm,
         storage_provider, storage_key, storage_bucket, status, virus_scan_status,
         checkin_comment, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', 'pending', ?, ?, ?, ?)`,
      [
        file.id, versionNumber, label, major, minor, previous?.id ?? null,
        name, input.original_name || name, extension, mimeType, size, checksum,
        input.checksum_algorithm || "sha256",
        input.storage_provider || store?.kind || "local",
        input.storage_key, input.storage_bucket || store?.bucket || "",
        comment, actor?.id ?? null, ts, ts,
      ]
    );
    const versionId = Number(insert.lastInsertRowid);
    if (previous) {
      run(db, "UPDATE file_versions SET is_current = 0, updated_at = ? WHERE id = ?", [ts, previous.id]);
    }
    run(
      db,
      `UPDATE files SET current_version_id = ?, version_count = version_count + 1,
         size_bytes = ?, checksum = ?, storage_provider = ?, storage_key = ?, storage_bucket = ?,
         status = 'pending_scan', updated_by = ?, updated_at = ? WHERE id = ?`,
      [
        versionId, size, checksum, input.storage_provider || store?.kind || "local",
        input.storage_key, input.storage_bucket || store?.bucket || "",
        actor?.id ?? null, ts, file.id,
      ]
    );
    const fileRow = findFileRow(db, file.id, scope);
    const processing = persistProcessingResult(db, fileRow, versionId, outcome, { actor, tenantId: scope });
    const refreshed = findFileRow(db, file.id, scope);
    const refreshedVersion = queryOne(db, "SELECT * FROM file_versions WHERE id = ?", [versionId]);

    recordFileEvent(db, {
      eventType: "FileVersionCreated",
      file: refreshed,
      versionId,
      actor,
      tenantId: scope,
      payload: { version_number: versionNumber, version_label: label, source, size_bytes: size, checksum: refreshed.checksum },
    });
    if (versionNumber === 1) {
      recordFileEvent(db, {
        eventType: "FileUploaded",
        file: refreshed,
        versionId,
        actor,
        tenantId: scope,
        payload: { name: refreshed.name, mime_type: refreshed.mime_type, size_bytes: size },
      });
    }
    auditFile(db, {
      actor, tenantId: scope, organizationId: refreshed.organization_id, action: "files.version.create",
      file: refreshed, details: { version: label, source, scan: processing.scan_status }, ip,
    });
    return {
      file: publicFile(refreshed),
      version: publicVersion(refreshedVersion),
      previous_version_id: previous?.id ?? null,
      scan_status: processing.scan_status,
    };
  });
}

// Restoring an old version creates a new version that reuses the old object's
// storage reference; historical rows are untouched.
export async function restoreVersion(db, fileReference, versionReference, input = {}, { actor, tenantId, ip, provider } = {}) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const file = findFileRow(db, fileReference, scope);
  const source = findVersionRow(db, file.id, versionReference);
  if (source.deleted_at) throw new HttpError(409, "Selected version is deleted");
  if (!source.storage_key) throw new HttpError(409, "Selected version has no stored content");
  const result = await createVersion(
    db,
    file.id,
    {
      storage_key: source.storage_key,
      storage_provider: source.storage_provider,
      storage_bucket: source.storage_bucket,
      name: source.name,
      original_name: source.original_name,
      mime_type: source.mime_type,
      size: source.size_bytes,
      checksum: source.checksum,
      checksum_algorithm: source.checksum_algorithm,
      checkin_comment: input.checkin_comment || input.comment || `Restored from version ${source.version_label}`,
      major: input.major === true,
    },
    { actor, tenantId: scope, ip, provider, source: "restore" }
  );
  run(db, "UPDATE file_versions SET restored_from_version_id = ? WHERE id = ?", [source.id, result.version.id]);
  recordFileEvent(db, {
    eventType: "FileVersionCreated",
    file: result.file,
    versionId: result.version.id,
    actor,
    tenantId: scope,
    payload: { restored_from: source.version_label, source_version_id: source.id },
  });
  return { ...result, restored_from: publicVersion(source) };
}

// Resolves a download descriptor without reading bytes into memory. Access is
// enforced here (backend authorization, never frontend-only).
export function versionDownload(db, fileReference, versionReference, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const file = findFileRow(db, fileReference, scope);
  if (file.deleted_at) throw new HttpError(409, "File is deleted");
  assertAccess(db, file, actor, "download", { tenantId: scope });
  const version = versionReference ? findVersionRow(db, file.id, versionReference) : currentVersionRow(db, file.id);
  if (!version) throw new HttpError(404, "File has no stored version");
  if (!version.storage_key) throw new HttpError(409, "Version has no stored content");
  if (["quarantined", "failed"].includes(version.status)) {
    throw new HttpError(423, "Version is not available for download");
  }
  const provider = getStorageProvider();
  return {
    file: publicFile(file),
    version: publicVersion(version),
    descriptor: {
      key: version.storage_key,
      bucket: version.storage_bucket,
      filename: version.name || file.name,
      mimeType: version.mime_type,
      size: version.size_bytes,
      disposition: "attachment",
      tenantId: scope,
      versionId: version.id,
      provider: version.storage_provider || provider.kind,
    },
  };
}
