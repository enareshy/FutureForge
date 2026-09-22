// Reusable import/export templates.
//
// A template packages a definition shape (mappings, fields, filters,
// transformations) so administrators can start from a governed blueprint
// instead of an empty canvas. Templates are tenant-scoped and versioned.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { templateRef as makeTemplateRef } from "./refs.js";
import { publicTemplate } from "./repository.js";
import { definitionConflict, definitionNotFound, invalidDefinition } from "./errors.js";
import { normalizeText, normalizeUpper, paginate, parseObject, requireCode, requireName, assertDefinitionStatus, assertDirection } from "./validation.js";

export function getTemplateRow(db, tenantId, ref) {
  return queryOne(
    db,
    "SELECT * FROM ie_templates WHERE tenant_id = ? AND (template_ref = ? OR code = ? OR CAST(id AS TEXT) = ?)",
    [Number(tenantId), String(ref), normalizeUpper(ref), String(ref)]
  );
}

export function requireTemplateRow(db, tenantId, ref) {
  const row = getTemplateRow(db, tenantId, ref);
  if (!row) throw definitionNotFound(ref);
  return row;
}

export function createTemplate(db, tenantId, input = {}, actor = null, ip = null) {
  const code = requireCode(input.code, "Template code");
  const direction = assertDirection(input.direction || "IMPORT");
  const exists = queryOne(db, "SELECT id FROM ie_templates WHERE tenant_id = ? AND code = ? AND version = 1", [Number(tenantId), code]);
  if (exists) throw definitionConflict(code);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO ie_templates (template_ref, tenant_id, code, name, description, direction, object_type, version, definition_json, status, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    [
      makeTemplateRef(code),
      Number(tenantId),
      code,
      requireName(input.name, "Template name"),
      normalizeText(input.description),
      direction,
      normalizeText(input.object_type ?? input.objectType, { max: 120 }),
      JSON.stringify(parseObject(input.definition ?? input.payload, {})),
      assertDefinitionStatus(input.status || "DRAFT"),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM ie_templates WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, { actor, action: "data_exchange.template.create", resourceType: "ie_templates", resourceId: code, details: { direction }, ip });
  return publicTemplate(row);
}

export function updateTemplate(db, tenantId, ref, patch = {}, actor = null, ip = null) {
  const row = requireTemplateRow(db, tenantId, ref);
  run(
    db,
    `UPDATE ie_templates SET name = ?, description = ?, object_type = ?, definition_json = ?, status = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
    [
      normalizeText(patch.name ?? row.name, { max: 200 }) || row.code,
      normalizeText(patch.description !== undefined ? patch.description : row.description),
      normalizeText(patch.object_type ?? patch.objectType ?? row.object_type, { max: 120 }),
      JSON.stringify(patch.definition !== undefined || patch.payload !== undefined ? parseObject(patch.definition ?? patch.payload, {}) : parseObject(row.definition_json, {})),
      patch.status ? assertDefinitionStatus(patch.status) : row.status,
      actor?.id ?? null,
      nowIso(),
      row.id,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM ie_templates WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "data_exchange.template.update", resourceType: "ie_templates", resourceId: row.code, details: {}, ip });
  return publicTemplate(updated);
}

export function createTemplateVersion(db, tenantId, ref, input = {}, actor = null, ip = null) {
  const row = requireTemplateRow(db, tenantId, ref);
  const nextVersion = Number(row.version) + 1;
  const ts = nowIso();
  run(
    db,
    `INSERT INTO ie_templates (template_ref, tenant_id, code, name, description, direction, object_type, version, definition_json, status, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)`,
    [
      makeTemplateRef(row.code),
      Number(tenantId),
      row.code,
      normalizeText(input.name ?? row.name, { max: 200 }) || row.code,
      normalizeText(input.description !== undefined ? input.description : row.description),
      row.direction,
      normalizeText(input.object_type ?? row.object_type, { max: 120 }),
      nextVersion,
      JSON.stringify(input.definition !== undefined || input.payload !== undefined ? parseObject(input.definition ?? input.payload, {}) : parseObject(row.definition_json, {})),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM ie_templates WHERE tenant_id = ? AND code = ? AND version = ?", [Number(tenantId), row.code, nextVersion]);
  writeAudit(db, { actor, action: "data_exchange.template.version", resourceType: "ie_templates", resourceId: row.code, details: { version: nextVersion }, ip });
  return publicTemplate(updated);
}

export function setTemplateStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = requireTemplateRow(db, tenantId, ref);
  run(db, "UPDATE ie_templates SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [assertDefinitionStatus(status), actor?.id ?? null, nowIso(), row.id]);
  const updated = queryOne(db, "SELECT * FROM ie_templates WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "data_exchange.template.status", resourceType: "ie_templates", resourceId: row.code, details: { status }, ip });
  return publicTemplate(updated);
}

export function getTemplate(db, tenantId, ref) {
  return publicTemplate(requireTemplateRow(db, tenantId, ref));
}

export function listTemplates(db, { tenantId, direction, objectType, status, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (direction) {
    clauses.push("direction = ?");
    params.push(assertDirection(direction));
  }
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(normalizeText(objectType, { max: 120 }));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(assertDefinitionStatus(status));
  }
  const term = normalizeText(q);
  if (term) {
    clauses.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${term}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM ie_templates ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM ie_templates ${where} ORDER BY direction, code, version DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicTemplate), total, page: currentPage, page_size: limit };
}

export function validateTemplate(db, tenantId, ref) {
  const template = getTemplate(db, tenantId, ref);
  const errors = [];
  if (!template.definition || typeof template.definition !== "object") errors.push({ code: "invalid_definition", message: "Template definition must be an object" });
  if (template.direction === "IMPORT" && !template.object_type) errors.push({ code: "missing_object_type", message: "An object_type is required for import templates" });
  if (template.direction === "EXPORT" && !template.object_type) errors.push({ code: "missing_object_type", message: "An object_type is required for export templates" });
  return { valid: errors.length === 0, errors };
}
