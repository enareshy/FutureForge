import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { resolveContentStorage, buildContentStagingKey } from "./storage.js";
import { resolveContentMime, sanitizeFilename, extensionOf, assertChecksumAlgorithm, checksumOf, isDangerousExtension } from "./validation.js";
import { DEFAULT_UPLOAD_TTL_SECONDS, DEFAULT_CHUNK_SIZE, DEFAULT_MAX_CONTENT_BYTES } from "./constants.js";
import { Errors } from "./errors.js";
import { publicUpload, findUploadRow, assertTenant } from "./repository.js";
import { uploadId as newUploadId } from "./refs.js";
import { createContentFromStaging } from "./content.js";

// UploadSession service (spec §7/§8). Supports single-shot, chunked/resumable
// and streaming uploads. Bytes land in an opaque staging object first; content
// is only created and made available after checksum + MIME + security checks.
// Expired sessions are cleaned up by the shared job worker.

function ttlSeconds(input) {
  return Math.max(60, Number(input || process.env.CONTENT_UPLOAD_TTL_SECONDS || DEFAULT_UPLOAD_TTL_SECONDS));
}

function expiresAt(seconds) {
  return new Date(Date.now() + seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}

export function initiateUploadSession(db, input = {}, { actor = null, tenantId = null, ip = null } = {}) {
  const scope = assertTenant(tenantId ?? input.tenantId);
  if (input.idempotencyKey) {
    const existing = queryOne(
      db,
      "SELECT * FROM content_upload_sessions WHERE tenant_id = ? AND idempotency_key = ?",
      [scope, String(input.idempotencyKey)]
    );
    if (existing) return publicUpload(existing);
  }
  const fileName = sanitizeFilename(input.fileName || input.name || "file");
  const extension = extensionOf(fileName);
  if (isDangerousExtension(extension)) throw Errors.invalidFileType(`Files of type .${extension} are not permitted`);
  const maxSize = Number(input.maxSize || input.max_size || DEFAULT_MAX_CONTENT_BYTES);
  const expectedSize = Number(input.expectedSize ?? input.size) || 0;
  if (expectedSize > maxSize) throw Errors.fileTooLarge(`File exceeds the maximum allowed size of ${maxSize} bytes`);
  const staged = input.uploadMode === "external" || input.uploadMode === "stream";
  const mode = staged ? input.uploadMode : input.uploadMode === "multipart" ? "multipart" : "single";
  const id = newUploadId();
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO content_upload_sessions
      (upload_id, tenant_id, organization_id, object_type, object_id, versioning_revision_id, version_id, content_role,
       file_name, original_file_name, file_extension, mime_type, expected_size, declared_checksum, checksum_algorithm,
       security_classification, status, chunk_size, staging_key, metadata_json, idempotency_key, created_by, updated_by,
       expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'initiated', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      scope,
      input.organizationId ?? null,
      input.objectType || "",
      input.objectId || "",
      input.versioningRevisionId ?? null,
      input.versionId ?? null,
      input.contentRole || "NATIVE",
      fileName,
      fileName,
      extensionOf(fileName),
      input.mimeType || "application/octet-stream",
      Number(input.expectedSize ?? input.size) || 0,
      input.checksum || "",
      assertChecksumAlgorithm(input.checksumAlgorithm || "sha256"),
      input.securityClassification || "internal",
      Number(input.chunkSize) || DEFAULT_CHUNK_SIZE,
      buildContentStagingKey(id),
      JSON.stringify(input.metadata || {}),
      input.idempotencyKey || null,
      actor?.id ?? null,
      actor?.id ?? null,
      expiresAt(ttlSeconds(input.ttlSeconds)),
      ts,
      ts,
    ]
  );
  return publicUpload(queryOne(db, "SELECT * FROM content_upload_sessions WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function getUploadSession(db, reference, tenantId = null) {
  return publicUpload(findUploadRow(db, reference, tenantId));
}

export function listUploadSessions(db, { tenantId = null, status = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (tenantId !== null && tenantId !== undefined) {
    where.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (status) {
    where.push("status = ?");
    params.push(String(status));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = queryAll(
    db,
    `SELECT * FROM content_upload_sessions ${clause} ORDER BY created_at DESC LIMIT ?`,
    [...params, Math.min(500, Math.max(1, Number(limit) || 100))]
  );
  return { items: rows.map(publicUpload), total: rows.length };
}

export function uploadSessionParts(db, sessionId) {
  const rows = queryAll(db, "SELECT * FROM content_upload_parts WHERE session_id = ? ORDER BY part_number", [Number(sessionId)]);
  return rows.map((row) => ({
    part_number: row.part_number,
    size_bytes: row.size_bytes,
    checksum: row.checksum,
    created_at: row.created_at,
  }));
}

// Appends a chunk to the session's staging object. Idempotent per part number so
// a retried chunk never corrupts the upload.
export async function appendUploadPart(db, reference, { partNumber = null, buffer = null, store = null, tenantId = null, actor = null } = {}) {
  const session = findUploadRow(db, reference, tenantId);
  if (["cancelled", "expired", "completed"].includes(session.status)) {
    throw Errors.sessionExpired("Upload session is not open");
  }
  if (session.expires_at && session.expires_at <= nowIso()) throw Errors.sessionExpired();
  if (!buffer || !buffer.length) throw Errors.uploadFailed("Upload part is empty");
  const number = Number(partNumber) || Number(session.received_chunks) + 1;
  const existing = queryOne(db, "SELECT * FROM content_upload_parts WHERE session_id = ? AND part_number = ?", [
    Number(session.id),
    number,
  ]);
  if (existing) {
    return { session: publicUpload(session), part: { part_number: existing.part_number, size_bytes: existing.size_bytes }, duplicate: true };
  }
  const storage = store || resolveContentStorage();
  const written = await storage.append({ key: session.staging_key, buffer });
  const checksum = checksumOf(buffer, session.checksum_algorithm);
  transaction(db, () => {
    run(
      db,
      "INSERT INTO content_upload_parts (session_id, part_number, size_bytes, checksum, staging_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [Number(session.id), number, buffer.length, checksum, session.staging_key, nowIso()]
    );
    run(
      db,
      `UPDATE content_upload_sessions SET status = 'uploading', received_size = ?, received_chunks = received_chunks + 1,
         checksum = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
      [Number(written?.size ?? session.received_size + buffer.length), written?.checksum || "", actor?.id ?? null, nowIso(), Number(session.id)]
    );
  });
  const updated = queryOne(db, "SELECT * FROM content_upload_sessions WHERE id = ?", [Number(session.id)]);
  return { session: publicUpload(updated), part: { part_number: number, size_bytes: buffer.length } };
}

export async function completeUploadSession(db, reference, { actor = null, tenantId = null, store = null, declaredChecksum = null, ip = null } = {}) {
  const session = findUploadRow(db, reference, tenantId);
  if (session.status === "completed" && session.content_id) {
    return { session: publicUpload(session), content: null, duplicate: true };
  }
  if (["cancelled", "expired"].includes(session.status)) throw Errors.sessionExpired();
  if (session.expires_at && session.expires_at <= nowIso()) throw Errors.sessionExpired();
  const storage = store || resolveContentStorage();
  const meta = await storage.getMetadata(session.staging_key);
  if (!meta) throw Errors.uploadFailed("No staged bytes were found for this upload session");
  if (Number(meta.size) > DEFAULT_MAX_CONTENT_BYTES) throw Errors.fileTooLarge();
  if (session.expected_size && Number(meta.size) !== Number(session.expected_size)) {
    throw Errors.uploadFailed(`Uploaded size ${meta.size} does not match the expected size ${session.expected_size}`);
  }
  const expectedChecksum = String(declaredChecksum || session.declared_checksum || "").toLowerCase();
  const actualChecksum = meta.checksum || (await storage.checksum(session.staging_key)).checksum;
  if (expectedChecksum && expectedChecksum !== actualChecksum) throw Errors.checksumMismatch();

  const head = await storage.read(session.staging_key, { maxBytes: 8192 });
  const resolved = resolveContentMime({ declaredMime: session.mime_type, fileName: session.file_name, buffer: head });
  const mimeType = resolved.mimeType;

  const content = await createContentFromStaging(
    db,
    { ...session, mime_type: mimeType, checksum: actualChecksum, received_size: meta.size },
    { actor, store: storage, ip }
  );
  run(
    db,
    "UPDATE content_upload_sessions SET status = 'completed', content_id = ?, received_size = ?, checksum = ?, storage_provider = ?, storage_key = ?, completed_at = ?, updated_at = ? WHERE id = ?",
    [Number(content.id), Number(meta.size), actualChecksum, storage.kind, content.storage_key || "", nowIso(), nowIso(), Number(session.id)]
  );
  const updated = queryOne(db, "SELECT * FROM content_upload_sessions WHERE id = ?", [Number(session.id)]);
  return { session: publicUpload(updated), content };
}

export async function abortUploadSession(db, reference, { actor = null, tenantId = null, store = null, reason = "" } = {}) {
  const session = findUploadRow(db, reference, tenantId);
  if (session.status === "completed") return publicUpload(session);
  const storage = store || resolveContentStorage();
  if (session.staging_key) await storage.delete(session.staging_key).catch(() => {});
  run(db, "UPDATE content_upload_sessions SET status = 'cancelled', error_message = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    reason || "Aborted",
    actor?.id ?? null,
    nowIso(),
    Number(session.id),
  ]);
  return publicUpload(queryOne(db, "SELECT * FROM content_upload_sessions WHERE id = ?", [Number(session.id)]));
}

// Expired-upload cleanup (spec §50). Deletes staged bytes for sessions past TTL.
export async function expireUploads(db, { store = null, now = nowIso() } = {}) {
  const storage = store || resolveContentStorage();
  const stale = queryAll(
    db,
    "SELECT * FROM content_upload_sessions WHERE status IN ('initiated', 'uploading') AND expires_at IS NOT NULL AND expires_at <= ?",
    [now]
  );
  for (const session of stale) {
    if (session.staging_key) await storage.delete(session.staging_key).catch(() => {});
    run(db, "UPDATE content_upload_sessions SET status = 'expired', updated_at = ? WHERE id = ?", [nowIso(), Number(session.id)]);
  }
  return { expired: stale.length };
}
