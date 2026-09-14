import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { recordVersion } from "./versions.js";
import { assertReadable, assertMutable, tenantClause } from "./scope.js";

export const DATA_TYPES = [
  "string",
  "integer",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "reference",
  "multi_value",
];

export const DEFAULT_VALIDATION = {};

function publicAttribute(row) {
  if (!row) return null;
  return {
    ...row,
    required: row.required === 1,
    multi_value: row.multi_value === 1,
    visible: row.visible === 1,
    editable: row.editable === 1,
    is_system: row.is_system === 1,
    validation: safeParse(row.validation_json, {}),
  };
}

// Boolean-normalizing view of an attribute row, reused by the type service.
export const publicAttributeSafe = publicAttribute;

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeValidation(raw, dataType) {
  if (raw === undefined || raw === null || raw === "") return "{}";
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "validation must be a JSON object");
    }
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "validation must be a JSON object");
  }
  const allowed = ["pattern", "message", "min_items", "max_items", "integer", "scale", "reference_type"];
  for (const key of Object.keys(parsed)) {
    if (!allowed.includes(key)) throw new HttpError(400, `Unsupported validation key: ${key}`);
  }
  if (parsed.pattern !== undefined) {
    if (typeof parsed.pattern !== "string" || parsed.pattern.length > 200) {
      throw new HttpError(400, "validation.pattern must be a string up to 200 chars");
    }
    try {
      new RegExp(parsed.pattern);
    } catch {
      throw new HttpError(400, "validation.pattern is not a valid regular expression");
    }
  }
  if (parsed.min_items !== undefined || parsed.max_items !== undefined) {
    if (dataType !== "multi_value") {
      throw new HttpError(400, "min_items/max_items only apply to multi_value attributes");
    }
    for (const key of ["min_items", "max_items"]) {
      if (parsed[key] !== undefined && (!Number.isInteger(parsed[key]) || parsed[key] < 0)) {
        throw new HttpError(400, `validation.${key} must be a non-negative integer`);
      }
    }
    if (
      parsed.min_items !== undefined &&
      parsed.max_items !== undefined &&
      parsed.min_items > parsed.max_items
    ) {
      throw new HttpError(400, "validation.min_items cannot exceed max_items");
    }
  }
  if (parsed.integer !== undefined && typeof parsed.integer !== "boolean") {
    throw new HttpError(400, "validation.integer must be a boolean");
  }
  if (parsed.reference_type !== undefined && !["organization", "user"].includes(parsed.reference_type)) {
    throw new HttpError(400, "validation.reference_type must be organization or user");
  }
  return JSON.stringify(parsed);
}

function assertRange(dataType, body, current = {}) {
  const minLength = body.min_length === undefined ? current.min_length : body.min_length;
  const maxLength = body.max_length === undefined ? current.max_length : body.max_length;
  const minValue = body.min_value === undefined ? current.min_value : body.min_value;
  const maxValue = body.max_value === undefined ? current.max_value : body.max_value;
  for (const [key, value] of Object.entries({ min_length: minLength, max_length: maxLength })) {
    if (value !== undefined && value !== null && value !== "" && (!Number.isInteger(Number(value)) || Number(value) < 0)) {
      throw new HttpError(400, `${key} must be a non-negative integer`);
    }
  }
  for (const [key, value] of Object.entries({ min_value: minValue, max_value: maxValue })) {
    if (value !== undefined && value !== null && value !== "" && Number.isNaN(Number(value))) {
      throw new HttpError(400, `${key} must be a number`);
    }
  }
  if (minLength !== undefined && minLength !== null && minLength !== "" && maxLength !== undefined && maxLength !== null && maxLength !== "") {
    if (Number(minLength) > Number(maxLength)) throw new HttpError(400, "min_length cannot exceed max_length");
  }
  if (minValue !== undefined && minValue !== null && minValue !== "" && maxValue !== undefined && maxValue !== null && maxValue !== "") {
    if (Number(minValue) > Number(maxValue)) throw new HttpError(400, "min_value cannot exceed max_value");
  }
  if (dataType === "string" || (body.multi_value && body.data_type === "multi_value")) {
    if ((minValue !== undefined && minValue !== null && minValue !== "") || (maxValue !== undefined && maxValue !== null && maxValue !== "")) {
      if (dataType === "string") throw new HttpError(400, "min_value/max_value do not apply to string attributes");
    }
  }
  if (dataType === "decimal" || dataType === "integer") {
    if ((minLength !== undefined && minLength !== null && minLength !== "") || (maxLength !== undefined && maxLength !== null && maxLength !== "")) {
      throw new HttpError(400, "min_length/max_length do not apply to numeric attributes");
    }
  }
}

export function getAttributeRow(db, id) {
  return queryOne(db, "SELECT * FROM metadata_attributes WHERE id = ?", [Number(id)]);
}

export function getAttribute(db, id, tenantId) {
  const row = getAttributeRow(db, id);
  assertReadable(row, tenantId, "Attribute not found");
  return publicAttribute(row);
}

function findAttributeByCode(db, code, tenantId) {
  const scope = tenantClause(null, tenantId);
  return queryOne(
    db,
    `SELECT * FROM metadata_attributes WHERE code = ? AND ${scope.sql} ORDER BY tenant_id IS NULL LIMIT 1`,
    [code, ...scope.params]
  );
}

function assertNoAttributeCycle(db, id, parentId) {
  if (!parentId) return;
  if (Number(id) === Number(parentId)) throw new HttpError(400, "An attribute cannot inherit from itself");
  let current = parentId;
  const seen = new Set();
  while (current) {
    if (seen.has(current) || Number(current) === Number(id)) {
      throw new HttpError(400, "Attribute inheritance cycle detected");
    }
    seen.add(current);
    const row = queryOne(db, "SELECT parent_attribute_id FROM metadata_attributes WHERE id = ?", [current]);
    if (!row) throw new HttpError(400, "Parent attribute not found");
    current = row.parent_attribute_id;
  }
}

export function listAttributes(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause(null, tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.dataType || query.data_type) {
    const dataType = query.dataType || query.data_type;
    if (!DATA_TYPES.includes(dataType)) throw new HttpError(400, "Unknown data type");
    where.push("data_type = ?");
    params.push(dataType);
  }
  if (query.status) {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.q) {
    where.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM metadata_attributes ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT * FROM metadata_attributes ${clause} ORDER BY code LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicAttribute);
  return { items, total, page, pageSize };
}

export function createAttribute(db, body, actor, ip, tenantId) {
  requireFields(body, ["code", "name", "data_type"]);
  const dataType = body.data_type || body.dataType;
  if (!DATA_TYPES.includes(dataType)) {
    throw new HttpError(400, `data_type must be one of: ${DATA_TYPES.join(", ")}`);
  }
  validateCode(body.code, "Attribute code");
  assertRange(dataType, body, {});
  if (body.lov_id) {
    const lov = queryOne(db, "SELECT * FROM metadata_lovs WHERE id = ?", [Number(body.lov_id)]);
    if (!lov) throw new HttpError(400, "Referenced LOV not found");
  }
  const multiValue = dataType === "multi_value" || body.multi_value ? 1 : 0;
  if (dataType === "multi_value" && !body.multi_value) {
    /* data type already implies multi-value */
  }
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO metadata_attributes
        (code, name, description, data_type, required, default_value, min_length, max_length,
         min_value, max_value, validation_json, multi_value, visible, editable,
         parent_attribute_id, lov_id, status, tenant_id, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.description || "",
        dataType,
        body.required ? 1 : 0,
        body.default_value === undefined || body.default_value === null ? "" : String(body.default_value),
        body.min_length ?? null,
        body.max_length ?? null,
        body.min_value ?? null,
        body.max_value ?? null,
        normalizeValidation(body.validation, dataType),
        multiValue,
        body.visible === false ? 0 : 1,
        body.editable === false ? 0 : 1,
        body.parent_attribute_id || body.parentAttributeId || null,
        body.lov_id || body.lovId || null,
        body.status || "active",
        tenantId ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE") || String(err.message).includes("unique")) {
      throw new HttpError(409, "Attribute code already exists in this scope");
    }
    throw err;
  }
  const row = getAttributeRow(db, result.lastInsertRowid);
  recordVersion(db, "attribute", row.id, row, actor, "create");
  writeAudit(db, {
    actor,
    action: "metadata.attribute.create",
    resourceType: "metadata_attribute",
    resourceId: row.id,
    details: { code: row.code, data_type: dataType },
    ip,
  });
  return publicAttribute(row);
}

export function updateAttribute(db, id, body, actor, ip, tenantId) {
  const row = getAttributeRow(db, id);
  assertMutable(db, row, tenantId, actor, "Attribute not found");
  const dataType = body.data_type || body.dataType || row.data_type;
  if (!DATA_TYPES.includes(dataType)) {
    throw new HttpError(400, `data_type must be one of: ${DATA_TYPES.join(", ")}`);
  }
  if (body.code && body.code !== row.code) validateCode(body.code, "Attribute code");
  assertRange(dataType, body, row);
  const parentId =
    body.parent_attribute_id === undefined && body.parentAttributeId === undefined
      ? row.parent_attribute_id
      : body.parent_attribute_id ?? body.parentAttributeId ?? null;
  if (parentId) {
    if (parentId === Number(id)) throw new HttpError(400, "An attribute cannot inherit from itself");
    assertNoAttributeCycle(db, id, parentId);
  }
  const ts = nowIso();
  try {
    run(
      db,
      `UPDATE metadata_attributes SET
        code = ?, name = ?, description = ?, data_type = ?, required = ?, default_value = ?,
        min_length = ?, max_length = ?, min_value = ?, max_value = ?, validation_json = ?,
        multi_value = ?, visible = ?, editable = ?, parent_attribute_id = ?, lov_id = ?,
        status = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.code ?? row.code,
        (body.name ?? row.name).trim(),
        body.description ?? row.description,
        dataType,
        body.required === undefined ? row.required : body.required ? 1 : 0,
        body.default_value === undefined ? row.default_value : String(body.default_value ?? ""),
        body.min_length === undefined ? row.min_length : body.min_length,
        body.max_length === undefined ? row.max_length : body.max_length,
        body.min_value === undefined ? row.min_value : body.min_value,
        body.max_value === undefined ? row.max_value : body.max_value,
        body.validation === undefined ? row.validation_json : normalizeValidation(body.validation, dataType),
        body.multi_value === undefined && dataType === row.data_type
          ? row.multi_value
          : body.multi_value || dataType === "multi_value"
            ? 1
            : 0,
        body.visible === undefined ? row.visible : body.visible ? 1 : 0,
        body.editable === undefined ? row.editable : body.editable ? 1 : 0,
        parentId,
        body.lov_id === undefined && body.lovId === undefined ? row.lov_id : body.lov_id ?? body.lovId ?? null,
        body.status ?? row.status,
        ts,
        id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE") || String(err.message).includes("unique")) {
      throw new HttpError(409, "Attribute code already exists in this scope");
    }
    throw err;
  }
  const next = getAttributeRow(db, id);
  recordVersion(db, "attribute", id, next, actor, "update");
  writeAudit(db, {
    actor,
    action: "metadata.attribute.update",
    resourceType: "metadata_attribute",
    resourceId: id,
    details: { code: next.code },
    ip,
  });
  return publicAttribute(next);
}

export function setAttributeStatus(db, id, status, actor, ip, tenantId) {
  if (!["active", "inactive"].includes(status)) throw new HttpError(400, "status must be active or inactive");
  const row = getAttributeRow(db, id);
  assertMutable(db, row, tenantId, actor, "Attribute not found");
  run(db, "UPDATE metadata_attributes SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), id]);
  writeAudit(db, {
    actor,
    action: `metadata.attribute.${status}`,
    resourceType: "metadata_attribute",
    resourceId: id,
    ip,
  });
  return publicAttribute(getAttributeRow(db, id));
}

// Walks the parent_attribute_id chain and returns ancestors, nearest first.
export function ancestorAttributes(db, attributeId) {
  const result = [];
  let current = attributeId;
  const seen = new Set();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const row = queryOne(db, "SELECT * FROM metadata_attributes WHERE id = ?", [current]);
    if (!row) break;
    result.push(row);
    current = row.parent_attribute_id;
  }
  return result;
}

// Effective attribute definition after inheritance: the child wins for scalar
// overrides, while inheritance simply provides a default. Constraints are the
// strictest of the chain to avoid weakening validation silently.
export function resolveAttribute(db, attributeId, tenantId) {
  const chain = ancestorAttributes(db, attributeId);
  if (!chain.length) throw new HttpError(404, "Attribute not found");
  assertReadable(chain[0], tenantId, "Attribute not found");
  const merged = { ...chain[0] };
  const inheritedFrom = chain[0].parent_attribute_id || null;
  merged.inherited_from = inheritedFrom;
  merged.chain = chain.map((a) => ({ id: a.id, code: a.code, data_type: a.data_type }));
  merged.required = chain.some((a) => a.required === 1) ? 1 : chain[0].required;
  for (const ancestor of chain.slice(1)) {
    if (merged.min_length === null && ancestor.min_length !== null) merged.min_length = ancestor.min_length;
    if (merged.max_length === null && ancestor.max_length !== null) merged.max_length = ancestor.max_length;
    if (merged.min_value === null && ancestor.min_value !== null) merged.min_value = ancestor.min_value;
    if (merged.max_value === null && ancestor.max_value !== null) merged.max_value = ancestor.max_value;
    if (!merged.lov_id && ancestor.lov_id) merged.lov_id = ancestor.lov_id;
  }
  return publicAttribute(merged);
}

// Reference resolution used by the validation engine for reference attributes.
export function referencedEntity(db, refType, refId) {
  if (!refType || refId === undefined || refId === null || refId === "") return null;
  if (refType === "organization") {
    return queryOne(db, "SELECT id, code, name, kind, status FROM organizations WHERE id = ?", [Number(refId)]);
  }
  if (refType === "user") {
    return queryOne(db, "SELECT id, username, display_name, status FROM users WHERE id = ?", [Number(refId)]);
  }
  return null;
}
