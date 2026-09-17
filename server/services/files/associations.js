import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { assertTenantScope } from "../tenants.js";
import { findFileRow, publicAssociation, publicFile, assertTenant } from "./repository.js";
import { assertAccess } from "./permissions.js";
import { recordFileEvent, auditFile } from "./events.js";
import { ASSOCIATION_RELATIONSHIP_TYPES } from "./validation.js";

// Generic file ↔ business-object associations. The Document module does not know
// what a business object is; it records an opaque type + id supplied by the
// Object & Relationship Framework, plus the attachment semantics.

const RELATIONSHIP_SET = new Set(ASSOCIATION_RELATIONSHIP_TYPES);

function assertRelationshipType(value) {
  if (!RELATIONSHIP_SET.has(value)) {
    throw new HttpError(400, `relationship_type must be one of: ${ASSOCIATION_RELATIONSHIP_TYPES.join(", ")}`);
  }
}

export function listFileAssociations(db, fileReference, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const file = findFileRow(db, fileReference, scope);
  assertAccess(db, file, actor, "view_metadata", { tenantId: scope });
  const items = queryAll(
    db,
    `SELECT * FROM file_associations WHERE file_id = ? AND deleted_at IS NULL
     ORDER BY is_primary DESC, display_order, id`,
    [file.id]
  ).map(publicAssociation);
  return { items, total: items.length, file: publicFile(file) };
}

export function listObjectAssociations(db, { businessObjectType, businessObjectId, relationshipType = null } = {}, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const type = String(businessObjectType || "").trim();
  const id = String(businessObjectId || "").trim();
  if (!type || !id) throw new HttpError(400, "business_object_type and business_object_id are required");
  const where = ["a.tenant_id = ?", "a.business_object_type = ?", "a.business_object_id = ?", "a.deleted_at IS NULL", "f.deleted_at IS NULL"];
  const params = [scope, type, id];
  if (relationshipType) { where.push("a.relationship_type = ?"); params.push(relationshipType); }
  const rows = queryAll(
    db,
    `SELECT a.*, f.name AS file_name, f.file_ref, f.mime_type, f.extension, f.size_bytes, f.status AS file_status
     FROM file_associations a JOIN files f ON f.id = a.file_id
     WHERE ${where.join(" AND ")} ORDER BY a.display_order, a.id`,
    params
  );
  const items = rows.map((row) => ({
    ...publicAssociation(row), file_name: row.file_name, file_ref: row.file_ref,
    mime_type: row.mime_type, extension: row.extension, size_bytes: row.size_bytes, file_status: row.file_status,
  }));
  return { items, total: items.length, business_object: { type, id } };
}

export function createAssociation(db, fileReference, body = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const file = findFileRow(db, fileReference, scope);
  if (file.deleted_at) throw new HttpError(409, "File is deleted");
  assertAccess(db, file, actor, "associate", { tenantId: scope });
  const type = String(body.business_object_type ?? body.businessObjectType ?? "").trim();
  const id = String(body.business_object_id ?? body.businessObjectId ?? "").trim();
  if (!type || !id) throw new HttpError(400, "business_object_type and business_object_id are required");
  const relationship = body.relationship_type || body.relationshipType || "attachment";
  assertRelationshipType(relationship);
  const link = body.link_id || body.linkId || null;

  const existing = queryOne(
    db,
    `SELECT * FROM file_associations WHERE file_id = ? AND business_object_type = ? AND business_object_id = ?
       AND relationship_type = ? AND deleted_at IS NULL`,
    [file.id, type, id, relationship]
  );
  if (existing) {
    return { association: publicAssociation(existing), already_exists: true };
  }
  const ts = nowIso();
  const insert = run(
    db,
    `INSERT INTO file_associations
      (file_id, business_object_type, business_object_id, business_object_name, relationship_type,
       association_role, is_primary, display_order, tenant_id, organization_id, created_by,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      file.id, type, id, String(body.business_object_name ?? body.businessObjectName ?? "").slice(0, 300),
      relationship, String(body.association_role ?? body.associationRole ?? "").slice(0, 100),
      body.is_primary || body.isPrimary ? 1 : 0, Number(body.display_order ?? body.displayOrder ?? 0) || 0,
      scope, file.organization_id, actor?.id ?? null, ts, ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM file_associations WHERE id = ?", [insert.lastInsertRowid]);
  recordFileEvent(db, {
    eventType: "FileAssociated", file, actor, tenantId: scope,
    payload: { association_id: row.id, business_object_type: type, business_object_id: id, relationship_type: relationship },
  });
  auditFile(db, {
    actor, tenantId: scope, organizationId: file.organization_id, action: "files.association.create",
    file, details: { association_id: row.id, business_object_type: type, business_object_id: id, relationship_type: relationship, link_id: link }, ip,
  });
  return { association: publicAssociation(row) };
}

export function removeAssociation(db, id, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const row = queryOne(db, "SELECT * FROM file_associations WHERE id = ? AND tenant_id = ?", [Number(id) || -1, scope]);
  if (!row || row.deleted_at) throw new HttpError(404, "Association not found");
  const file = findFileRow(db, row.file_id, scope);
  assertAccess(db, file, actor, "remove_association", { tenantId: scope });
  const ts = nowIso();
  run(db, "UPDATE file_associations SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?", [ts, actor?.id ?? null, ts, row.id]);
  recordFileEvent(db, {
    eventType: "FileDisassociated", file, actor, tenantId: scope,
    payload: { association_id: row.id, business_object_type: row.business_object_type, business_object_id: row.business_object_id },
  });
  auditFile(db, {
    actor, tenantId: scope, organizationId: file.organization_id, action: "files.association.remove",
    file, details: { association_id: row.id, business_object_type: row.business_object_type, business_object_id: row.business_object_id }, ip,
  });
  return { removed: true, id: row.id };
}

export function listAssociations(db, query = {}, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const { page, pageSize, offset } = pagination(query);
  const where = ["a.tenant_id = ?", "a.deleted_at IS NULL"];
  const params = [scope];
  if (query.fileId || query.file_id) { where.push("a.file_id = ?"); params.push(Number(query.fileId ?? query.file_id)); }
  if (query.businessObjectType || query.business_object_type) {
    where.push("a.business_object_type = ?");
    params.push(query.businessObjectType || query.business_object_type);
  }
  if (query.businessObjectId || query.business_object_id) {
    where.push("a.business_object_id = ?");
    params.push(query.businessObjectId || query.business_object_id);
  }
  if (query.relationshipType || query.relationship_type) {
    where.push("a.relationship_type = ?");
    params.push(query.relationshipType || query.relationship_type);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const items = queryAll(
    db,
    `SELECT a.*, f.name AS file_name, f.file_ref FROM file_associations a
     LEFT JOIN files f ON f.id = a.file_id ${clause}
     ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map((row) => ({ ...publicAssociation(row), file_name: row.file_name || "", file_ref: row.file_ref || "" }));
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM file_associations a ${clause}`, params).c;
  return { items, total, page, pageSize };
}

export function updateAssociation(db, id, body = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const row = queryOne(db, "SELECT * FROM file_associations WHERE id = ? AND tenant_id = ?", [Number(id) || -1, scope]);
  if (!row || row.deleted_at) throw new HttpError(404, "Association not found");
  const file = findFileRow(db, row.file_id, scope);
  assertAccess(db, file, actor, "associate", { tenantId: scope });
  const patch = {};
  if (body.relationship_type !== undefined || body.relationshipType !== undefined) {
    const value = body.relationship_type ?? body.relationshipType;
    assertRelationshipType(value);
    patch.relationship_type = value;
  }
  if (body.association_role !== undefined || body.associationRole !== undefined) {
    patch.association_role = String(body.association_role ?? body.associationRole ?? "").slice(0, 100);
  }
  if (body.is_primary !== undefined || body.isPrimary !== undefined) patch.is_primary = (body.is_primary ?? body.isPrimary) ? 1 : 0;
  if (body.display_order !== undefined || body.displayOrder !== undefined) patch.display_order = Number(body.display_order ?? body.displayOrder) || 0;
  if (!Object.keys(patch).length) return { association: publicAssociation(row), changed: [] };
  patch.updated_at = nowIso();
  run(
    db,
    `UPDATE file_associations SET ${Object.keys(patch).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    [...Object.values(patch), row.id]
  );
  const next = queryOne(db, "SELECT * FROM file_associations WHERE id = ?", [row.id]);
  auditFile(db, {
    actor, tenantId: scope, organizationId: file.organization_id, action: "files.association.update",
    file, details: { association_id: row.id, changed_fields: Object.keys(patch) }, ip,
  });
  return { association: publicAssociation(next), changed: Object.keys(patch) };
}
