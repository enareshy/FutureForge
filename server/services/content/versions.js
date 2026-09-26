import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { assertChecksumAlgorithm } from "./validation.js";
import { publicVersion, findVersionRow, currentVersionRow, findContentRow, safeParse } from "./repository.js";
import { Errors } from "./errors.js";
import { versionLabel } from "./refs.js";
import { resolveContentStorage, buildContentStorageKey } from "./storage.js";
import { recordContentEvent, auditContent } from "./events.js";

// Content version service (spec §13/§14). Content versions are independent of
// business revisions: a Document/Part revision can own many content versions.
// Historical versions are immutable — nothing is ever overwritten in place.

export function listVersions(db, contentRow, { includeDeleted = false, limit = 200 } = {}) {
  const clause = includeDeleted ? "WHERE content_id = ?" : "WHERE content_id = ? AND deleted_at IS NULL";
  const rows = queryAll(
    db,
    `SELECT * FROM content_versions ${clause} ORDER BY version_number DESC LIMIT ?`,
    [Number(contentRow.id), Math.min(1000, Math.max(1, Number(limit) || 200))]
  );
  return { items: rows.map((row) => publicVersion(row)), total: rows.length };
}

export function getVersion(db, contentRow, reference) {
  return publicVersion(findVersionRow(db, contentRow.id, reference));
}

export function currentVersion(db, contentRow) {
  return publicVersion(currentVersionRow(db, contentRow.id));
}

// Inserts a new immutable version and rolls the content's current snapshot onto
// it. Must be called inside a transaction. `stored` is the output of a storage
// write: { key, size, checksum, provider, bucket }.
export function persistNewVersion(db, contentRow, versionInput = {}, stored = {}) {
  const ts = nowIso();
  const max = queryOne(db, "SELECT MAX(version_number) AS max_version FROM content_versions WHERE content_id = ?", [
    Number(contentRow.id),
  ]);
  const versionNumber = Number(max?.max_version ?? 0) + 1;
  const previous = currentVersionRow(db, contentRow.id);
  run(db, "UPDATE content_versions SET is_current = 0, updated_at = ? WHERE content_id = ? AND is_current = 1", [
    ts,
    Number(contentRow.id),
  ]);
  const result = run(
    db,
    `INSERT INTO content_versions
      (content_id, tenant_id, version_number, version_label, is_current, previous_version_id,
       file_name, original_file_name, file_extension, mime_type, file_size, checksum, checksum_algorithm,
       storage_provider, storage_key, storage_bucket, status, security_status, checkin_comment,
       restored_from_version_id, metadata_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(contentRow.id),
      contentRow.tenant_id,
      versionNumber,
      versionLabel(versionNumber),
      previous?.id ?? null,
      versionInput.fileName || contentRow.file_name,
      versionInput.originalFileName || contentRow.original_file_name || "",
      versionInput.extension || "",
      versionInput.mimeType || contentRow.mime_type,
      Number(stored.size ?? versionInput.size ?? 0),
      stored.checksum || versionInput.checksum || "",
      assertChecksumAlgorithm(versionInput.checksumAlgorithm || contentRow.checksum_algorithm),
      stored.provider || contentRow.storage_provider || "",
      stored.key || contentRow.storage_key || "",
      stored.bucket || contentRow.storage_bucket || "",
      versionInput.status || "pending_security",
      versionInput.securityStatus || "pending",
      versionInput.checkinComment || "",
      versionInput.restoredFromVersionId ?? null,
      JSON.stringify(versionInput.metadata || {}),
      versionInput.createdBy ?? contentRow.created_by ?? null,
      ts,
      ts,
    ]
  );
  const versionRow = queryOne(db, "SELECT * FROM content_versions WHERE id = ?", [Number(result.lastInsertRowid)]);
  updateCurrentSnapshot(db, contentRow, versionRow, ts);
  return versionRow;
}

export function updateCurrentSnapshot(db, contentRow, versionRow, ts = nowIso()) {
  run(
    db,
    `UPDATE content SET
       file_name = ?, original_file_name = ?, file_extension = ?, mime_type = ?, file_size = ?,
       checksum = ?, checksum_algorithm = ?, storage_provider = ?, storage_key = ?, storage_bucket = ?,
       current_version_id = ?, version_count = ?, security_status = ?, updated_at = ?, revision = revision + 1
     WHERE id = ?`,
    [
      versionRow.file_name,
      versionRow.original_file_name,
      versionRow.file_extension,
      versionRow.mime_type,
      versionRow.file_size,
      versionRow.checksum,
      versionRow.checksum_algorithm,
      versionRow.storage_provider,
      versionRow.storage_key,
      versionRow.storage_bucket,
      versionRow.id,
      Number(contentRow.version_count || 0) + 1,
      versionRow.security_status,
      ts,
      Number(contentRow.id),
    ]
  );
  return queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(contentRow.id)]);
}

// Registers an immutable storage reference for integrity verification. Reusing
// an existing identical reference is how deduplication surfaces in the model.
export function registerStorageReference(db, { contentRow, versionId = null, stored = {} }) {
  if (!stored?.key) return null;
  const existing = queryOne(db, "SELECT * FROM content_storage_references WHERE storage_provider = ? AND storage_key = ?", [
    stored.provider || "",
    stored.key,
  ]);
  if (existing) {
    run(
      db,
      "UPDATE content_storage_references SET status = 'active', updated_at = ? WHERE id = ?",
      [nowIso(), existing.id]
    );
    return existing;
  }
  const result = run(
    db,
    `INSERT INTO content_storage_references
      (tenant_id, content_id, version_id, storage_provider, storage_key, storage_bucket, size_bytes, checksum,
       checksum_algorithm, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    [
      contentRow.tenant_id,
      contentRow.id,
      versionId,
      stored.provider || "",
      stored.key,
      stored.bucket || "",
      Number(stored.size || 0),
      stored.checksum || "",
      "sha256",
      nowIso(),
      nowIso(),
    ]
  );
  return queryOne(db, "SELECT * FROM content_storage_references WHERE id = ?", [Number(result.lastInsertRowid)]);
}

export function resolveVersionForDownload(db, contentRow, reference = null) {
  if (reference) return findVersionRow(db, contentRow.id, reference);
  return currentVersionRow(db, contentRow.id);
}

export function requireVersion(db, contentRow, reference) {
  const row = findVersionRow(db, contentRow.id, reference);
  if (row.deleted_at) throw Errors.notFound("Content version not found");
  return row;
}

export function contentByReference(db, reference, tenantId) {
  return findContentRow(db, reference, tenantId);
}

// Restore an earlier version by creating a new immutable version that points at
// a copy of the old bytes. History is never rewritten and the restored version
// goes through the normal security pipeline again (spec §14).
export async function restoreVersion(db, contentRow, reference, { actor = null, store = null, tenantId = null, ip = null } = {}) {
  const source = requireVersion(db, contentRow, reference);
  if (tenantId !== null && tenantId !== undefined && Number(contentRow.tenant_id) !== Number(tenantId)) {
    throw Errors.tenantDenied("Tenant access denied");
  }
  const storage = store || resolveContentStorage();
  const key = buildContentStorageKey({
    tenantId: contentRow.tenant_id,
    objectType: contentRow.object_type,
    objectId: contentRow.object_id,
    contentId: contentRow.content_id,
  });
  await storage.copy(source.storage_key, key);
  const versionRow = transaction(db, () =>
    persistNewVersion(
      db,
      contentRow,
      {
        fileName: source.file_name,
        originalFileName: source.original_file_name,
        extension: source.file_extension,
        mimeType: source.mime_type,
        checksum: source.checksum,
        checksumAlgorithm: source.checksum_algorithm,
        size: source.file_size,
        status: "pending_security",
        securityStatus: "pending",
        checkinComment: `Restored from ${source.version_label}`,
        restoredFromVersionId: source.id,
        metadata: safeParse(source.metadata_json, {}),
        createdBy: actor?.id ?? contentRow.created_by ?? null,
      },
      { key, size: source.file_size, checksum: source.checksum, provider: storage.kind, bucket: storage.bucket }
    )
  );
  const refreshed = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(contentRow.id)]);
  registerStorageReference(db, { contentRow: refreshed, versionId: versionRow.id, stored: { key, size: source.file_size, checksum: source.checksum, provider: storage.kind, bucket: storage.bucket } });
  recordContentEvent(db, {
    eventType: "ContentVersionCreated",
    content: refreshed,
    versionId: versionRow.id,
    actor,
    tenantId: refreshed.tenant_id,
    payload: { restored_from_version_id: source.id, restored_from_version: source.version_label, version_label: versionRow.version_label },
  });
  auditContent(db, { actor, tenantId: refreshed.tenant_id, action: "content.version.restored", content: refreshed, details: { version_id: versionRow.id, restored_from_version_id: source.id }, ip });
  return { content: refreshed, version: publicVersion(versionRow) };
}
