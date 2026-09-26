import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { Errors } from "./errors.js";
import { assertContentRole, assertAssociationStatus, normalizeText } from "./validation.js";
import { publicAssociation, findContentRow, assertTenant } from "./repository.js";
import { associationRef as newAssociationRef } from "./refs.js";
import { recordContentEvent, auditContent } from "./events.js";

// Generic Object ↔ Content association (spec §6/§28). The framework is not
// document-specific: any object type can own content roles, and the same
// content can be associated with several objects/revisions.

function insertAssociation(db, input) {
  const result = run(
    db,
    `INSERT INTO content_associations
      (association_ref, tenant_id, organization_id, object_type, object_id, object_name,
       versioning_revision_id, version_id, content_id, content_role, is_primary, sequence, status,
       effective_from, effective_to, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newAssociationRef(),
      input.tenantId,
      input.organizationId ?? null,
      normalizeText(input.objectType),
      normalizeText(input.objectId),
      normalizeText(input.objectName),
      input.versioningRevisionId ?? null,
      input.versionId ?? null,
      Number(input.contentId),
      input.contentRole,
      input.isPrimary ? 1 : 0,
      Number(input.sequence) || 0,
      input.status || "active",
      input.effectiveFrom || null,
      input.effectiveTo || null,
      JSON.stringify(input.metadata || {}),
      input.actorId ?? null,
      input.actorId ?? null,
      nowIso(),
      nowIso(),
    ]
  );
  return queryOne(db, "SELECT * FROM content_associations WHERE id = ?", [Number(result.lastInsertRowid)]);
}

export function createAssociation(db, input = {}, { actor = null, tenantId = null, ip = null } = {}) {
  return transaction(db, () => {
    const scope = assertTenant(tenantId ?? input.tenantId);
    const objectType = normalizeText(input.objectType || input.object_type);
    const objectId = normalizeText(input.objectId || input.object_id);
    if (!objectType || !objectId) throw Errors.associationInvalid("object_type and object_id are required");
    const contentRef = input.contentId ?? input.content_id;
    if (contentRef === undefined || contentRef === null || contentRef === "") throw Errors.associationInvalid("content_id is required");
    const content = findContentRow(db, contentRef, scope);
    if (content.deleted_at) throw Errors.associationInvalid("Cannot associate deleted content");
    const role = assertContentRole(input.contentRole || input.content_role || "ATTACHMENT");
    const status = input.status ? assertAssociationStatus(input.status) : "active";
    if (status === "active" && content.status === "quarantined") {
      throw Errors.quarantined("Quarantined content cannot be actively associated");
    }
    const existing = queryOne(
      db,
      `SELECT * FROM content_associations
       WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND content_id = ? AND content_role = ? AND deleted_at IS NULL`,
      [scope, objectType, objectId, Number(content.id), role]
    );
    if (existing) return publicAssociation(existing);

    const isPrimary = Boolean(input.isPrimary ?? input.is_primary);
    if (isPrimary) {
      run(
        db,
        `UPDATE content_associations SET is_primary = 0, updated_at = ? WHERE tenant_id = ? AND object_type = ? AND object_id = ?
         AND deleted_at IS NULL AND is_primary = 1`,
        [nowIso(), scope, objectType, objectId]
      );
    }
    const row = insertAssociation(db, {
      tenantId: scope,
      organizationId: input.organizationId ?? null,
      objectType,
      objectId,
      objectName: input.objectName ?? input.object_name,
      versioningRevisionId: input.versioningRevisionId ?? input.versioning_revision_id ?? null,
      versionId: input.versionId ?? input.version_id ?? null,
      contentId: Number(content.id),
      contentRole: role,
      isPrimary,
      sequence: input.sequence,
      status,
      effectiveFrom: input.effectiveFrom ?? input.effective_from ?? null,
      effectiveTo: input.effectiveTo ?? input.effective_to ?? null,
      metadata: input.metadata || {},
      actorId: actor?.id ?? null,
    });
    recordContentEvent(db, { eventType: "ContentAssociated", content, actor, tenantId: scope, payload: { object_type: objectType, object_id: objectId, content_role: role, is_primary: isPrimary } });
    auditContent(db, { actor, tenantId: scope, action: "content.associated", content, details: { association_ref: row.association_ref, object_type: objectType, object_id: objectId, content_role: role }, ip });
    return publicAssociation(row);
  });
}

export function listAssociations(db, { tenantId = null, objectType = null, objectId = null, contentId = null, status = null, contentRole = null, page = 1, pageSize = 50 } = {}) {
  const where = ["deleted_at IS NULL"];
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
  if (contentId) {
    where.push("content_id = ?");
    params.push(Number(contentId));
  }
  if (status) {
    where.push("status = ?");
    params.push(String(status));
  }
  if (contentRole) {
    where.push("content_role = ?");
    params.push(String(contentRole));
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  const total = queryOne(db, `SELECT COUNT(*) AS count FROM content_associations ${clause}`, params)?.count ?? 0;
  const rows = queryAll(
    db,
    `SELECT * FROM content_associations ${clause} ORDER BY is_primary DESC, sequence ASC, id ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { items: rows.map(publicAssociation), total, page: Number(page) || 1, page_size: limit };
}

// Object → content, with the content metadata joined so consumers do not have to
// round-trip per association.
export function listObjectContent(db, objectType, objectId, { tenantId = null, includeInactive = false } = {}) {
  const where = ["a.object_type = ?", "a.object_id = ?", "a.deleted_at IS NULL"];
  const params = [String(objectType), String(objectId)];
  if (tenantId !== null && tenantId !== undefined) {
    where.push("a.tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (!includeInactive) where.push("a.status = 'active'");
  const rows = queryAll(
    db,
    `SELECT a.*, c.content_key, c.file_name AS content_file_name, c.mime_type AS content_mime_type,
            c.file_size AS content_file_size, c.status AS content_status, c.security_status AS content_security_status,
            c.content_role AS content_native_role, c.version_count AS content_version_count, c.is_primary AS content_is_primary
     FROM content_associations a JOIN content c ON c.id = a.content_id
     ${`WHERE ${where.join(" AND ")}`}
     ORDER BY a.is_primary DESC, a.sequence ASC, a.id ASC`,
    params
  );
  return {
    object_type: objectType,
    object_id: objectId,
    items: rows.map((row) => ({
      ...publicAssociation(row),
      content: {
        content_key: row.content_key,
        file_name: row.content_file_name,
        mime_type: row.content_mime_type,
        file_size: row.content_file_size,
        status: row.content_status,
        security_status: row.content_security_status,
        version_count: row.content_version_count,
      },
    })),
    total: rows.length,
  };
}

export function getAssociation(db, reference, tenantId = null) {
  const row = queryOne(
    db,
    "SELECT * FROM content_associations WHERE (association_ref = ? OR id = ?) AND deleted_at IS NULL",
    [String(reference || ""), Number(reference) || -1]
  );
  if (!row) throw Errors.notFound("Association not found");
  if (tenantId !== null && tenantId !== undefined && Number(row.tenant_id) !== Number(tenantId)) throw Errors.notFound("Association not found");
  return publicAssociation(row);
}

export function updateAssociation(db, reference, patch = {}, { actor = null, tenantId = null, ip = null } = {}) {
  return transaction(db, () => {
    const current = getAssociation(db, reference, tenantId);
    const row = queryOne(db, "SELECT * FROM content_associations WHERE id = ?", [Number(current.id)]);
    const contentRole = patch.contentRole ?? patch.content_role ?? row.content_role;
    const status = patch.status ?? row.status;
    const isPrimary = patch.isPrimary ?? patch.is_primary;
    if (isPrimary === true) {
      run(
        db,
        "UPDATE content_associations SET is_primary = 0, updated_at = ? WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND id != ?",
        [nowIso(), row.tenant_id, row.object_type, row.object_id, row.id]
      );
    }
    run(
      db,
      `UPDATE content_associations SET content_role = ?, status = ?, is_primary = ?, sequence = ?,
         effective_from = ?, effective_to = ?, metadata_json = ?, updated_by = ?, updated_at = ?
       WHERE id = ?`,
      [
        assertContentRole(contentRole),
        assertAssociationStatus(status),
        (isPrimary === undefined ? row.is_primary : isPrimary ? 1 : 0),
        patch.sequence ?? row.sequence,
        patch.effectiveFrom ?? patch.effective_from ?? row.effective_from,
        patch.effectiveTo ?? patch.effective_to ?? row.effective_to,
        patch.metadata ? JSON.stringify(patch.metadata) : row.metadata_json,
        actor?.id ?? null,
        nowIso(),
        row.id,
      ]
    );
    const updated = queryOne(db, "SELECT * FROM content_associations WHERE id = ?", [row.id]);
    auditContent(db, { actor, tenantId: row.tenant_id, action: "content.association.updated", objectType: "content_association", objectId: row.id, objectName: row.association_ref, details: { changes: Object.keys(patch) }, ip });
    return publicAssociation(updated);
  });
}

export function removeAssociation(db, reference, { actor = null, tenantId = null, ip = null } = {}) {
  return transaction(db, () => {
    const current = getAssociation(db, reference, tenantId);
    const row = queryOne(db, "SELECT * FROM content_associations WHERE id = ?", [Number(current.id)]);
    run(db, "UPDATE content_associations SET status = 'deleted', deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
      nowIso(),
      actor?.id ?? null,
      nowIso(),
      row.id,
    ]);
    const content = queryOne(db, "SELECT * FROM content WHERE id = ?", [row.content_id]);
    recordContentEvent(db, { eventType: "ContentAssociationRemoved", content, actor, tenantId: row.tenant_id, payload: { association_ref: row.association_ref, object_type: row.object_type, object_id: row.object_id } });
    auditContent(db, { actor, tenantId: row.tenant_id, action: "content.association.removed", content, details: { association_ref: row.association_ref }, ip });
    return publicAssociation(queryOne(db, "SELECT * FROM content_associations WHERE id = ?", [row.id]));
  });
}

export function setPrimaryAssociation(db, reference, { actor = null, tenantId = null, ip = null } = {}) {
  return updateAssociation(db, reference, { is_primary: true }, { actor, tenantId, ip });
}
