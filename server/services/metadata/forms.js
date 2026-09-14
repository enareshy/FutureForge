import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { recordVersion } from "./versions.js";
import { assertReadable, assertMutable, tenantClause } from "./scope.js";
import { effectiveAttributes, findType, getTypeRow } from "./types.js";
import { validateExpression } from "./expression.js";

export const FORM_MODES = ["create", "edit", "view"];
export const FORM_STATUSES = ["draft", "active", "inactive"];
export const NODE_KINDS = ["tab", "section", "group"];

function publicForm(row) {
  if (!row) return null;
  return { ...row, is_system: row.is_system === 1 };
}

function safeParseArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function publicField(row) {
  if (!row) return null;
  return {
    ...row,
    visible: row.visible === 1,
    editable: row.editable === 1,
    conditions: safeParseArray(row.conditions_json),
  };
}

function publicNode(row) {
  if (!row) return null;
  return {
    ...row,
    visible: row.visible === 1,
    conditions: safeParseArray(row.conditions_json),
  };
}

export function getFormRow(db, id) {
  return queryOne(db, "SELECT * FROM metadata_forms WHERE id = ?", [Number(id)]);
}

function findFormByCode(db, code, tenantId) {
  const scope = tenantClause(null, tenantId);
  return queryOne(
    db,
    `SELECT * FROM metadata_forms WHERE code = ? AND ${scope.sql} ORDER BY tenant_id IS NULL LIMIT 1`,
    [code, ...scope.params]
  );
}

export function findForm(db, idOrCode, tenantId) {
  if (idOrCode === undefined || idOrCode === null || idOrCode === "") return null;
  if (typeof idOrCode === "number" || /^\d+$/.test(String(idOrCode))) {
    const byId = queryOne(db, "SELECT * FROM metadata_forms WHERE id = ?", [Number(idOrCode)]);
    if (byId) {
      assertReadable(byId, tenantId, "Form not found");
      return byId;
    }
  }
  const byCode = findFormByCode(db, String(idOrCode), tenantId);
  if (!byCode) throw new HttpError(404, "Form not found");
  return byCode;
}

export function listForms(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause("f", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.typeId || query.type_id) {
    where.push("f.type_id = ?");
    params.push(Number(query.typeId || query.type_id));
  }
  if (query.mode) {
    if (!FORM_MODES.includes(query.mode)) throw new HttpError(400, "Unknown form mode");
    where.push("f.mode = ?");
    params.push(query.mode);
  }
  if (query.status) {
    where.push("f.status = ?");
    params.push(query.status);
  }
  if (query.q) {
    where.push("(f.code LIKE ? OR f.name LIKE ? OR f.description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM metadata_forms f ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT f.*, t.code AS type_code, t.name AS type_name,
       (SELECT COUNT(*) FROM metadata_form_fields ff WHERE ff.form_id = f.id) AS field_count
     FROM metadata_forms f JOIN metadata_types t ON t.id = f.type_id
     ${clause} ORDER BY f.code LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicForm);
  return { items, total, page, pageSize };
}

export function getForm(db, idOrCode, tenantId, { withLayout = true } = {}) {
  const row = findForm(db, idOrCode, tenantId);
  const result = publicForm(row);
  const type = queryOne(db, "SELECT id, code, name, status FROM metadata_types WHERE id = ?", [row.type_id]);
  result.type = type || null;
  if (withLayout) {
    result.nodes = queryAll(db, "SELECT * FROM metadata_form_nodes WHERE form_id = ? ORDER BY sequence, label", [
      row.id,
    ]).map(publicNode);
    result.fields = queryAll(db, "SELECT * FROM metadata_form_fields WHERE form_id = ? ORDER BY sequence", [
      row.id,
    ]).map(publicField);
  }
  return result;
}

export function createForm(db, body, actor, ip, tenantId) {
  requireFields(body, ["code", "name", "type_id"]);
  validateCode(body.code, "Form code");
  const mode = body.mode || "create";
  if (!FORM_MODES.includes(mode)) throw new HttpError(400, `mode must be one of: ${FORM_MODES.join(", ")}`);
  const type = getTypeRow(db, body.type_id);
  assertReadable(type, tenantId, "Type not found");
  const status = body.status || "draft";
  if (!FORM_STATUSES.includes(status)) throw new HttpError(400, "status must be draft, active or inactive");
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO metadata_forms
        (code, name, description, type_id, mode, status, version, tenant_id, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.description || "",
        type.id,
        mode,
        status,
        tenantId ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE") || String(err.message).includes("unique")) {
      throw new HttpError(409, "Form code already exists in this scope");
    }
    throw err;
  }
  const row = getFormRow(db, result.lastInsertRowid);
  recordVersion(db, "form", row.id, getForm(db, row.id, tenantId), actor, "create");
  writeAudit(db, {
    actor,
    action: "metadata.form.create",
    resourceType: "metadata_form",
    resourceId: row.id,
    details: { code: row.code, type_id: type.id, mode },
    ip,
  });
  return getForm(db, row.id, tenantId);
}

export function updateForm(db, id, body, actor, ip, tenantId) {
  const row = getFormRow(db, id);
  assertMutable(db, row, tenantId, actor, "Form not found");
  if (body.code && body.code !== row.code) validateCode(body.code, "Form code");
  const mode = body.mode ?? row.mode;
  if (!FORM_MODES.includes(mode)) throw new HttpError(400, `mode must be one of: ${FORM_MODES.join(", ")}`);
  if (body.status && !FORM_STATUSES.includes(body.status)) {
    throw new HttpError(400, "status must be draft, active or inactive");
  }
  let typeId = row.type_id;
  if (body.type_id !== undefined || body.typeId !== undefined) {
    typeId = Number(body.type_id ?? body.typeId);
    assertReadable(getTypeRow(db, typeId), tenantId, "Type not found");
  }
  try {
    run(
      db,
      `UPDATE metadata_forms SET code = ?, name = ?, description = ?, type_id = ?, mode = ?,
        status = ?, updated_at = ? WHERE id = ?`,
      [
        body.code ?? row.code,
        (body.name ?? row.name).trim(),
        body.description ?? row.description,
        typeId,
        mode,
        body.status ?? row.status,
        nowIso(),
        id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE") || String(err.message).includes("unique")) {
      throw new HttpError(409, "Form code already exists in this scope");
    }
    throw err;
  }
  recordVersion(db, "form", id, getForm(db, id, tenantId), actor, "update");
  writeAudit(db, { actor, action: "metadata.form.update", resourceType: "metadata_form", resourceId: id, ip });
  return getForm(db, id, tenantId);
}

export function setFormStatus(db, id, status, actor, ip, tenantId) {
  if (!FORM_STATUSES.includes(status)) throw new HttpError(400, "status must be draft, active or inactive");
  const row = getFormRow(db, id);
  assertMutable(db, row, tenantId, actor, "Form not found");
  if (status === "active") assertFormRenderable(db, row, tenantId);
  run(db, "UPDATE metadata_forms SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), id]);
  writeAudit(db, { actor, action: `metadata.form.${status}`, resourceType: "metadata_form", resourceId: id, ip });
  return getForm(db, id, tenantId);
}

export function deleteForm(db, id, actor, ip, tenantId) {
  const row = getFormRow(db, id);
  assertMutable(db, row, tenantId, actor, "Form not found");
  run(db, "DELETE FROM metadata_form_nodes WHERE form_id = ?", [id]);
  run(db, "DELETE FROM metadata_form_fields WHERE form_id = ?", [id]);
  run(db, "DELETE FROM metadata_forms WHERE id = ?", [id]);
  writeAudit(db, {
    actor,
    action: "metadata.form.delete",
    resourceType: "metadata_form",
    resourceId: id,
    details: { code: row.code },
    ip,
  });
  return { deleted: true, id: Number(id) };
}

// Replaces the entire layout (nodes + fields) atomically. Every field must
// reference an attribute that the form's type exposes, and every condition
// expression is validated before it is persisted.
export function replaceLayout(db, id, body, actor, ip, tenantId) {
  const form = getFormRow(db, id);
  assertMutable(db, form, tenantId, actor, "Form not found");
  const incomingNodes = Array.isArray(body.nodes) ? body.nodes : [];
  const incomingFields = Array.isArray(body.fields) ? body.fields : [];
  const attributeIndex = new Map(
    effectiveAttributes(db, form.type_id, tenantId).map((a) => [a.id, a])
  );
  const byAttributeCode = new Map(
    effectiveAttributes(db, form.type_id, tenantId).map((a) => [a.code, a])
  );

  const nodeIds = new Map();
  const seenNodeCodes = new Set();
  for (const node of incomingNodes) {
    if (!node.code || !node.label) throw new HttpError(400, "Every node requires a code and label");
    if (!NODE_KINDS.includes(node.kind)) {
      throw new HttpError(400, `Node kind must be one of: ${NODE_KINDS.join(", ")}`);
    }
    if (seenNodeCodes.has(node.code)) throw new HttpError(400, `Duplicate node code: ${node.code}`);
    seenNodeCodes.add(node.code);
    const conditions = node.conditions || [];
    if (!Array.isArray(conditions)) throw new HttpError(400, "Node conditions must be an array");
    for (const condition of conditions) validateExpression(condition);
  }
  const seenFieldCodes = new Set();
  for (const field of incomingFields) {
    const attr = field.attribute_id
      ? attributeIndex.get(Number(field.attribute_id))
      : byAttributeCode.get(field.attribute_code || field.attributeCode || field.code);
    if (!attr) {
      throw new HttpError(
        400,
        `Form field ${field.code || field.attribute_code} references an attribute that is not on type ${form.type_id}`
      );
    }
    const code = field.code || attr.code;
    if (seenFieldCodes.has(code)) throw new HttpError(400, `Duplicate field code: ${code}`);
    seenFieldCodes.add(code);
    const conditions = field.conditions || [];
    if (!Array.isArray(conditions)) throw new HttpError(400, "Field conditions must be an array");
    for (const condition of conditions) validateExpression(condition);
  }

  run(db, "DELETE FROM metadata_form_nodes WHERE form_id = ?", [id]);
  run(db, "DELETE FROM metadata_form_fields WHERE form_id = ?", [id]);
  const ts = nowIso();
  for (const node of incomingNodes) {
    const parentRef = node.parent_code
      ? nodeIds.get(node.parent_code)
      : node.parent_id
        ? nodeIds.get(String(node.parent_id))
        : null;
    const result = run(
      db,
      `INSERT INTO metadata_form_nodes
        (form_id, kind, parent_id, code, label, sequence, visible, conditions_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        node.kind,
        parentRef || null,
        node.code,
        node.label,
        node.sequence ?? 0,
        node.visible === false ? 0 : 1,
        JSON.stringify(node.conditions || []),
        ts,
        ts,
      ]
    );
    nodeIds.set(node.code, result.lastInsertRowid);
    nodeIds.set(String(node.code), result.lastInsertRowid);
  }
  for (const field of incomingFields) {
    const attr = field.attribute_id
      ? attributeIndex.get(Number(field.attribute_id))
      : byAttributeCode.get(field.attribute_code || field.attributeCode || field.code);
    const nodeRef = field.node_code ? nodeIds.get(field.node_code) : field.node_id ? Number(field.node_id) : null;
    run(
      db,
      `INSERT INTO metadata_form_fields
        (form_id, attribute_id, node_id, code, label_override, placeholder, help_text, sequence,
         required_override, visible, editable, default_override, col_span, conditions_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        attr.id,
        nodeRef || null,
        field.code || attr.code,
        field.label_override || field.labelOverride || "",
        field.placeholder || "",
        field.help_text || field.helpText || "",
        field.sequence ?? 0,
        field.required_override === undefined ? null : field.required_override ? 1 : 0,
        field.visible === false ? 0 : 1,
        field.editable === false ? 0 : 1,
        field.default_override ?? null,
        field.col_span ?? field.colSpan ?? 12,
        JSON.stringify(field.conditions || []),
        ts,
        ts,
      ]
    );
  }
  recordVersion(db, "form", id, getForm(db, id, tenantId), actor, "replace layout");
  writeAudit(db, {
    actor,
    action: "metadata.form.layout.replace",
    resourceType: "metadata_form",
    resourceId: id,
    details: { nodes: incomingNodes.length, fields: incomingFields.length },
    ip,
  });
  return getForm(db, id, tenantId);
}

function assertFormRenderable(db, form, tenantId) {
  const fields = queryAll(db, "SELECT * FROM metadata_form_fields WHERE form_id = ?", [form.id]);
  if (!fields.length) throw new HttpError(409, "Cannot activate a form with no fields");
  const available = new Set(effectiveAttributes(db, form.type_id, tenantId).map((a) => a.id));
  for (const field of fields) {
    if (!available.has(field.attribute_id)) {
      throw new HttpError(409, "Cannot activate a form whose fields are not on the type");
    }
  }
}

export function formVersions(db, id) {
  return queryAll(
    db,
    `SELECT version, status, notes, created_by, created_at FROM metadata_versions
     WHERE artifact_type = 'form' AND artifact_id = ? ORDER BY version DESC`,
    [Number(id)]
  );
}
