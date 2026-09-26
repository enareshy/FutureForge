import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { isPlatformAdmin } from "../tenants.js";
import { resolveContentStorage, buildContentStorageKey, buildContentStagingKey } from "./storage.js";
import { assertChecksumAlgorithm, resolveContentMime, sanitizeFilename, extensionOf, categoryForMime, isDangerousExtension } from "./validation.js";
import { DOWNLOADABLE_STATUSES, BLOCKED_STATUSES, DEFAULT_MAX_CONTENT_BYTES } from "./constants.js";
import { Errors } from "./errors.js";
import { ContentError } from "./errors.js";
import {
  publicContent,
  findContentRow,
  findContentById,
  currentVersionRow,
  assertSameTenant,
} from "./repository.js";
import { contentId as newContentId, contentKey as newContentKey } from "./refs.js";
import { persistNewVersion, registerStorageReference, resolveVersionForDownload, listVersions } from "./versions.js";
import { processContentVersion, getProcessingStatus } from "./processing.js";
import { recordContentEvent, auditContent, listContentEvents } from "./events.js";
import { activeLegalHoldRow } from "./repository.js";

// ContentService — the application service that owns the generic content entity.
// It orchestrates storage, security, processing, versioning and events; it does
// not implement storage or scanning itself (dependency inversion).

export function contentSortColumns() {
  return {
    created_at: "created_at",
    updated_at: "updated_at",
    file_name: "file_name",
    file_size: "file_size",
    status: "status",
    security_status: "security_status",
    content_role: "content_role",
    mime_type: "mime_type",
  };
}

export function listContent(db, {
  tenantId = null,
  objectType = null,
  objectId = null,
  status = null,
  securityStatus = null,
  contentRole = null,
  mimeType = null,
  category = null,
  createdBy = null,
  q = null,
  includeDeleted = false,
  page = 1,
  pageSize = 25,
  sort = "created_at",
  direction = "desc",
} = {}) {
  const where = [];
  const params = [];
  if (tenantId !== null && tenantId !== undefined) {
    where.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (objectType) {
    where.push("object_type = ?");
    params.push(String(objectType));
  }
  if (objectId) {
    where.push("object_id = ?");
    params.push(String(objectId));
  }
  if (status) {
    where.push("status = ?");
    params.push(String(status));
  }
  if (securityStatus) {
    where.push("security_status = ?");
    params.push(String(securityStatus));
  }
  if (contentRole) {
    where.push("content_role = ?");
    params.push(String(contentRole));
  }
  if (mimeType) {
    where.push("mime_type = ?");
    params.push(String(mimeType));
  }
  if (createdBy) {
    where.push("created_by = ?");
    params.push(Number(createdBy));
  }
  if (!includeDeleted) where.push("deleted_at IS NULL");
  if (q) {
    where.push("(file_name LIKE ? OR original_file_name LIKE ? OR content_key LIKE ? OR content_id LIKE ?)");
    const like = `%${String(q)}%`;
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const columns = contentSortColumns();
  const orderColumn = columns[sort] || "created_at";
  const orderDir = String(direction).toLowerCase() === "asc" ? "ASC" : "DESC";
  const limit = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const total = queryOne(db, `SELECT COUNT(*) AS count FROM content ${clause}`, params)?.count ?? 0;
  let rows = queryAll(
    db,
    `SELECT * FROM content ${clause} ORDER BY ${orderColumn} ${orderDir}, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  if (category) {
    rows = rows.filter((row) => categoryForMime(row.mime_type, row.file_extension) === category);
  }
  return { items: rows.map(publicContent), total, page: Number(page) || 1, page_size: limit };
}

export function getContent(db, reference, tenantId = null) {
  return publicContent(findContentRow(db, reference, tenantId));
}

export function findDuplicate(db, { tenantId, checksum, size }) {
  if (!checksum) return null;
  const row = queryOne(
    db,
    `SELECT * FROM content
     WHERE tenant_id = ? AND checksum = ? AND file_size = ? AND status NOT IN ('deleted','failed') AND deleted_at IS NULL
     ORDER BY id LIMIT 1`,
    [Number(tenantId), String(checksum), Number(size) || 0]
  );
  return row ? publicContent(row) : null;
}

function insertContentRow(db, input) {
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO content
      (content_id, content_key, tenant_id, organization_id, plant_id, site_id, department_id,
       object_type, object_id, versioning_revision_id, version_id, content_type, content_role, is_primary,
       file_name, original_file_name, file_extension, mime_type, file_size, checksum, checksum_algorithm,
       status, security_status, processing_status, dedupe_of_content_id, security_classification, description,
       metadata_json, created_by, updated_by, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      input.contentId,
      input.contentKey,
      input.tenantId,
      input.organizationId ?? null,
      input.plantId ?? null,
      input.siteId ?? null,
      input.departmentId ?? null,
      input.objectType || "",
      input.objectId || "",
      input.versioningRevisionId ?? null,
      input.versionId ?? null,
      input.contentType || "file",
      input.contentRole || "NATIVE",
      input.isPrimary ? 1 : 0,
      input.fileName,
      input.originalFileName || input.fileName,
      input.extension || "",
      input.mimeType || "application/octet-stream",
      Number(input.size) || 0,
      input.checksum || "",
      assertChecksumAlgorithm(input.checksumAlgorithm || "sha256"),
      input.status || "pending_security",
      input.securityStatus || "pending",
      "pending",
      input.dedupeOfContentId ?? null,
      input.securityClassification || "internal",
      input.description || "",
      JSON.stringify(input.metadata || {}),
      input.createdBy ?? null,
      input.createdBy ?? null,
      ts,
      ts,
    ]
  );
  return queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(result.lastInsertRowid)]);
}

// Creates the content entity + first immutable version from an already-stored
// object. Runs the security/rendition pipeline unless `process: false`.
export async function createContent(db, input = {}, { actor = null, tenantId = null, store = null, process = true, maxSize = DEFAULT_MAX_CONTENT_BYTES, ip = null } = {}) {
  const scope = tenantId ?? input.tenantId ?? null;
  if (scope === null || scope === undefined) throw Errors.tenantDenied();
  const storage = store || resolveContentStorage();
  const fileName = sanitizeFilename(input.fileName || input.name || "file");
  const extension = input.extension || extensionOf(fileName);
  if (isDangerousExtension(extension)) throw Errors.invalidFileType(`Files of type .${extension} are not permitted`);
  const declared = String(input.mimeType || "").toLowerCase();

  let stored = input.stored || null;
  if (!stored && input.buffer) {
    if (!input.buffer.length) throw Errors.uploadFailed("File is empty");
    const resolved = resolveContentMime({ declaredMime: declared, fileName, buffer: input.buffer });
    const key = buildContentStorageKey({ tenantId: scope, objectType: input.objectType || "object", objectId: input.objectId || "none", contentId: input.contentId || newContentId() });
    const written = await storage.upload({ key, buffer: input.buffer, contentType: resolved.mimeType });
    stored = { ...written, mimeType: resolved.mimeType };
  }
  if (!stored) throw Errors.uploadFailed("Content creation requires stored bytes or a staging reference");
  if (maxSize && Number(stored.size) > Number(maxSize)) {
    if (stored.key) await storage.delete(stored.key).catch(() => {});
    throw Errors.fileTooLarge();
  }

  const resolvedMime = input.mimeType && !String(input.mimeType).startsWith("application/octet-stream")
    ? String(input.mimeType)
    : stored.mimeType || "application/octet-stream";

  const created = transaction(db, () => {
    const duplicate = findDuplicate(db, { tenantId: scope, checksum: stored.checksum, size: stored.size });
    const row = insertContentRow(db, {
      contentId: input.contentId || newContentId(),
      contentKey: newContentKey(),
      tenantId: scope,
      organizationId: input.organizationId ?? null,
      plantId: input.plantId ?? null,
      siteId: input.siteId ?? null,
      departmentId: input.departmentId ?? null,
      objectType: input.objectType,
      objectId: input.objectId,
      versioningRevisionId: input.versioningRevisionId ?? null,
      versionId: input.versionId ?? null,
      contentType: input.contentType || "file",
      contentRole: input.contentRole || "NATIVE",
      isPrimary: Boolean(input.isPrimary),
      fileName,
      originalFileName: input.originalFileName || fileName,
      extension,
      mimeType: resolvedMime,
      size: stored.size,
      checksum: stored.checksum,
      checksumAlgorithm: stored.algorithm || "sha256",
      status: "pending_security",
      securityStatus: "pending",
      dedupeOfContentId: duplicate?.id ?? null,
      securityClassification: input.securityClassification || "internal",
      description: input.description || "",
      metadata: input.metadata || {},
      createdBy: actor?.id ?? null,
    });
    const versionRow = persistNewVersion(db, row, {
      fileName,
      originalFileName: input.originalFileName || fileName,
      extension,
      mimeType: resolvedMime,
      size: stored.size,
      checksum: stored.checksum,
      checksumAlgorithm: "sha256",
      status: "pending_security",
      securityStatus: "pending",
      checkinComment: input.checkinComment || "",
      createdBy: actor?.id ?? null,
      metadata: input.metadata || {},
      restoredFromVersionId: input.restoredFromVersionId ?? null,
    }, stored);
    registerStorageReference(db, { contentRow: row, versionId: versionRow.id, stored });
    recordContentEvent(db, { eventType: "ContentUploaded", content: row, versionId: versionRow.id, actor, tenantId: scope, payload: { file_name: fileName, size: stored.size, role: input.contentRole || "NATIVE" } });
    auditContent(db, { actor, tenantId: scope, action: "content.uploaded", content: row, details: { file_name: fileName, size: stored.size, mime_type: resolvedMime, checksum: stored.checksum }, ip });
    return queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(row.id)]);
  });

  if (!process) return publicContent(created);

  const result = await processContentVersion(db, created, { store: storage, actor, renditionTypes: input.renditionTypes ?? null });
  return publicContent(result.content);
}

export async function createContentFromStaging(db, sessionRow, { actor = null, store = null, ip = null } = {}) {
  const storage = store || resolveContentStorage();
  const finalKey = buildContentStorageKey({
    tenantId: sessionRow.tenant_id,
    objectType: sessionRow.object_type || "object",
    objectId: sessionRow.object_id || "none",
    contentId: newContentId(),
  });
  const moved = await storage.move(buildContentStagingKey(sessionRow.upload_id), finalKey);
  const stored = { key: finalKey, size: moved?.size ?? sessionRow.received_size, checksum: sessionRow.checksum, provider: moved?.provider || storage.kind, bucket: moved?.bucket || storage.bucket };
  return createContent(
    db,
    {
      tenantId: sessionRow.tenant_id,
      organizationId: sessionRow.organization_id,
      objectType: sessionRow.object_type,
      objectId: sessionRow.object_id,
      versioningRevisionId: sessionRow.versioning_revision_id,
      versionId: sessionRow.version_id,
      contentRole: sessionRow.content_role,
      fileName: sessionRow.file_name,
      originalFileName: sessionRow.original_file_name || sessionRow.file_name,
      extension: sessionRow.file_extension,
      mimeType: sessionRow.mime_type,
      securityClassification: sessionRow.security_classification,
      metadata: JSON.parse(sessionRow.metadata_json || "{}"),
      stored,
      checksum: sessionRow.checksum,
    },
    { actor, tenantId: sessionRow.tenant_id, store, ip }
  );
}

export function updateContentMetadata(db, reference, patch = {}, { actor = null, tenantId = null, ip = null } = {}) {
  return transaction(db, () => {
    const row = findContentRow(db, reference, tenantId);
    if (row.deleted_at) throw Errors.notFound();
    const next = {
      content_role: patch.content_role ?? patch.contentRole ?? row.content_role,
      is_primary: patch.is_primary ?? patch.isPrimary ?? row.is_primary,
      security_classification: patch.security_classification ?? patch.securityClassification ?? row.security_classification,
      description: patch.description ?? row.description,
      metadata_json: patch.metadata ? JSON.stringify(patch.metadata) : row.metadata_json,
      content_type: patch.content_type ?? patch.contentType ?? row.content_type,
    };
    run(
      db,
      `UPDATE content SET content_role = ?, is_primary = ?, security_classification = ?, description = ?,
         metadata_json = ?, content_type = ?, updated_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ?`,
      [
        next.content_role,
        next.is_primary ? 1 : 0,
        next.security_classification,
        next.description,
        next.metadata_json,
        next.content_type,
        actor?.id ?? null,
        nowIso(),
        Number(row.id),
      ]
    );
    const updated = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(row.id)]);
    recordContentEvent(db, { eventType: "ContentMetadataUpdated", content: updated, actor, tenantId: updated.tenant_id, payload: { fields: Object.keys(patch) } });
    auditContent(db, { actor, tenantId: updated.tenant_id, action: "content.metadata.updated", content: updated, before: publicContent(row), after: publicContent(updated), ip });
    return publicContent(updated);
  });
}

export function assertContentAccess(db, contentRow, actor, action = "read", { tenantId = null } = {}) {
  if (tenantId !== null && tenantId !== undefined && Number(contentRow.tenant_id) !== Number(tenantId)) {
    throw Errors.tenantDenied();
  }
  if (!actor?.id) throw Errors.unauthorized();
  if (isPlatformAdmin(db, actor.id)) return true;
  const admin = queryOne(
    db,
    `SELECT 1 AS ok FROM user_roles ur
     JOIN roles r ON r.id = ur.role_id
     WHERE ur.user_id = ? AND r.code IN ('iam.admin') LIMIT 1`,
    [actor.id]
  );
  if (admin) return true;
  // Ownership grants non-destructive actions; destructive actions additionally
  // require the relevant permission resource (enforced by the router).
  if (action === "read") return true;
  if (Number(contentRow.created_by) === Number(actor.id)) return true;
  throw Errors.accessDenied("Only the content owner or an administrator may perform this operation");
}

export function softDeleteContent(db, reference, { actor = null, tenantId = null, reason = "", ip = null } = {}) {
  return transaction(db, () => {
    const row = findContentRow(db, reference, tenantId);
    if (row.deleted_at) throw Errors.notFound();
    assertContentAccess(db, row, actor, "delete", { tenantId });
    const hold = activeLegalHoldRow(db, row.id);
    if (hold) throw Errors.legalHold("Content is under legal hold and cannot be deleted");
    const ts = nowIso();
    run(db, "UPDATE content SET status = 'deleted', deleted_at = ?, deleted_by = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", [
      ts,
      actor?.id ?? null,
      ts,
      Number(row.id),
    ]);
    const updated = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(row.id)]);
    auditContent(db, { actor, tenantId: updated.tenant_id, action: "content.deleted", content: updated, reason, ip });
    recordContentEvent(db, { eventType: "ContentDeleted", content: updated, actor, payload: { reason } });
    return publicContent(updated);
  });
}

export function restoreContent(db, reference, { actor = null, tenantId = null, ip = null } = {}) {
  return transaction(db, () => {
    const row = findContentRow(db, reference, tenantId);
    if (!row.deleted_at) return publicContent(row);
    const ts = nowIso();
    run(db, "UPDATE content SET status = 'available', deleted_at = NULL, deleted_by = NULL, updated_at = ?, revision = revision + 1 WHERE id = ?", [
      ts,
      Number(row.id),
    ]);
    const updated = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(row.id)]);
    auditContent(db, { actor, tenantId: updated.tenant_id, action: "content.restored", content: updated, ip });
    recordContentEvent(db, { eventType: "ContentRestored", content: updated, actor, payload: {} });
    return publicContent(updated);
  });
}

export function contentDetail(db, reference, { actor = null, tenantId = null } = {}) {
  const row = findContentRow(db, reference, tenantId);
  const content = publicContent(row);
  return {
    content,
    versions: listVersions(db, row).items,
    processing: getProcessingStatus(db, row),
    events: listContentEvents(db, { contentId: row.id, tenantId: row.tenant_id, limit: 50 }).items,
  };
}

export function resolveDownload(db, reference, { actor = null, tenantId = null, versionRef = null, allowQuarantined = false } = {}) {
  const row = findContentRow(db, reference, tenantId);
  assertContentAccess(db, row, actor, "read", { tenantId });
  if (row.deleted_at) throw Errors.notFound("Content not found");
  if (row.status === "quarantined" && !allowQuarantined) throw Errors.quarantined();
  if (BLOCKED_STATUSES.includes(row.status) && !allowQuarantined) {
    throw Errors.accessDenied("Content is not available for download");
  }
  if (!DOWNLOADABLE_STATUSES.includes(row.status) && !allowQuarantined) {
    throw Errors.accessDenied("Content is not available for download");
  }
  const version = resolveVersionForDownload(db, row, versionRef);
  if (!version?.storage_key) throw Errors.notFound("Content bytes are not available");
  return { content: row, version, storageKey: version.storage_key, fileName: version.file_name, mimeType: version.mime_type, size: version.file_size };
}

export function recordDownload(db, row, { actor = null, ip = null } = {}) {
  auditContent(db, { actor, tenantId: row.tenant_id, action: "content.downloaded", content: row, details: { content_id: row.content_id, file_name: row.file_name }, ip });
}

export function downloadInfo(db, reference, { actor = null, tenantId = null, versionRef = null, expiresIn = null, disposition = "attachment" } = {}) {
  const resolved = resolveDownload(db, reference, { actor, tenantId, versionRef });
  const provider = resolveContentStorage();
  const link = provider.generateAccessUrl({
    key: resolved.storageKey,
    filename: resolved.fileName,
    mimeType: resolved.mimeType,
    disposition,
    tenantId: resolved.content.tenant_id,
    versionId: resolved.version.id,
    expiresIn,
  });
  return { content_id: resolved.content.content_id, file_name: resolved.fileName, mime_type: resolved.mimeType, size: resolved.size, ...link };
}

export function contentFacets(db, { tenantId = null } = {}) {
  const scope = tenantId === null || tenantId === undefined ? "" : "WHERE tenant_id = ?";
  const params = tenantId === null || tenantId === undefined ? [] : [Number(tenantId)];
  const group = (column) => queryAll(db, `SELECT ${column} AS value, COUNT(*) AS count FROM content ${scope} GROUP BY ${column} ORDER BY count DESC`, params);
  return {
    statuses: group("status"),
    security_statuses: group("security_status"),
    content_roles: group("content_role"),
    mime_types: group("mime_type"),
    processing_statuses: group("processing_status"),
  };
}

export function contentEvents(db, { contentId = null, tenantId = null, eventType = null, limit = 100 } = {}) {
  return listContentEvents(db, { contentId, tenantId, eventType, limit });
}

export { ContentError };
