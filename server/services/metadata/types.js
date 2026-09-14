import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { recordVersion } from "./versions.js";
import { assertReadable, assertMutable, tenantClause } from "./scope.js";
import { ancestorAttributes, getAttributeRow, publicAttributeSafe } from "./attributes.js";

export const TYPE_STATUSES = ["draft", "active", "inactive"];

function publicType(row) {
  if (!row) return null;
  return {
    ...row,
    is_system: row.is_system === 1,
    attributes: row.attributes ?? undefined,
  };
}

export function getTypeRow(db, id) {
  return queryOne(db, "SELECT * FROM metadata_types WHERE id = ?", [Number(id)]);
}

function findTypeByCode(db, code, tenantId) {
  const scope = tenantClause(null, tenantId);
  return queryOne(
    db,
    `SELECT * FROM metadata_types WHERE code = ? AND ${scope.sql} ORDER BY tenant_id IS NULL LIMIT 1`,
    [code, ...scope.params]
  );
}

export function findType(db, idOrCode, tenantId) {
  if (idOrCode === undefined || idOrCode === null || idOrCode === "") return null;
  if (typeof idOrCode === "number" || /^\d+$/.test(String(idOrCode))) {
    const byId = queryOne(db, "SELECT * FROM metadata_types WHERE id = ?", [Number(idOrCode)]);
    if (byId) {
      assertReadable(byId, tenantId, "Type not found");
      return byId;
    }
  }
  const byCode = findTypeByCode(db, String(idOrCode), tenantId);
  if (!byCode) throw new HttpError(404, "Type not found");
  return byCode;
}

export function getType(db, idOrCode, tenantId, { withAttributes = true } = {}) {
  const row = findType(db, idOrCode, tenantId);
  const result = publicType(row);
  if (withAttributes) {
    result.attributes = effectiveAttributes(db, row.id, tenantId);
  }
  return result;
}

function assertNoTypeCycle(db, id, parentId) {
  if (!parentId) return;
  if (Number(id) === Number(parentId)) throw new HttpError(400, "A type cannot inherit from itself");
  let current = Number(parentId);
  const seen = new Set();
  while (current) {
    if (seen.has(current) || current === Number(id)) {
      throw new HttpError(400, "Type inheritance cycle detected");
    }
    seen.add(current);
    const row = queryOne(db, "SELECT parent_type_id FROM metadata_types WHERE id = ?", [current]);
    if (!row) throw new HttpError(400, "Parent type not found");
    current = row.parent_type_id;
  }
}

export function ancestorTypes(db, typeId) {
  const result = [];
  let current = typeId;
  const seen = new Set();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const row = queryOne(db, "SELECT * FROM metadata_types WHERE id = ?", [current]);
    if (!row) break;
    result.push(row);
    current = row.parent_type_id;
  }
  return result;
}

function descendantTypeIds(db, typeId) {
  const result = [];
  const queue = [Number(typeId)];
  const seen = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const children = queryAll(db, "SELECT id FROM metadata_types WHERE parent_type_id = ?", [current]);
    for (const child of children) {
      result.push(child.id);
      queue.push(child.id);
    }
  }
  return result;
}

export function listTypes(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause("t", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.status) {
    where.push("t.status = ?");
    params.push(query.status);
  }
  if (query.module) {
    where.push("t.module = ?");
    params.push(query.module);
  }
  if (query.q) {
    where.push("(t.code LIKE ? OR t.name LIKE ? OR t.description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM metadata_types t ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT t.*,
      (SELECT COUNT(*) FROM metadata_type_attributes ta WHERE ta.type_id = t.id) AS own_attribute_count,
      (SELECT COUNT(*) FROM metadata_types c WHERE c.parent_type_id = t.id) AS child_type_count
     FROM metadata_types t ${clause}
     ORDER BY t.code LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicType);
  return { items, total, page, pageSize };
}

export function createType(db, body, actor, ip, tenantId) {
  requireFields(body, ["code", "name"]);
  validateCode(body.code, "Type code");
  const status = body.status || "draft";
  if (!TYPE_STATUSES.includes(status)) throw new HttpError(400, "status must be draft, active or inactive");
  let parentId = body.parent_type_id ?? body.parentTypeId ?? null;
  if (parentId) {
    const parent = queryOne(db, "SELECT * FROM metadata_types WHERE id = ?", [Number(parentId)]);
    assertReadable(parent, tenantId, "Parent type not found");
    parentId = Number(parentId);
  }
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO metadata_types
        (code, name, description, module, parent_type_id, status, version, tenant_id, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.description || "",
        body.module || "platform",
        parentId,
        status,
        tenantId ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE") || String(err.message).includes("unique")) {
      throw new HttpError(409, "Type code already exists in this scope");
    }
    throw err;
  }
  const row = getTypeRow(db, result.lastInsertRowid);
  recordVersion(db, "type", row.id, row, actor, "create");
  writeAudit(db, {
    actor,
    action: "metadata.type.create",
    resourceType: "metadata_type",
    resourceId: row.id,
    details: { code: row.code, parent: parentId },
    ip,
  });
  return getType(db, row.id, tenantId);
}

export function updateType(db, id, body, actor, ip, tenantId) {
  const row = getTypeRow(db, id);
  assertMutable(db, row, tenantId, actor, "Type not found");
  if (body.code && body.code !== row.code) validateCode(body.code, "Type code");
  if (body.status && !TYPE_STATUSES.includes(body.status)) {
    throw new HttpError(400, "status must be draft, active or inactive");
  }
  let parentId =
    body.parent_type_id === undefined && body.parentTypeId === undefined
      ? row.parent_type_id
      : body.parent_type_id ?? body.parentTypeId ?? null;
  if (parentId !== null && parentId !== undefined) {
    parentId = Number(parentId);
    const parent = queryOne(db, "SELECT * FROM metadata_types WHERE id = ?", [parentId]);
    assertReadable(parent, tenantId, "Parent type not found");
    assertNoTypeCycle(db, id, parentId);
  } else {
    parentId = null;
  }
  const ts = nowIso();
  try {
    run(
      db,
      `UPDATE metadata_types SET code = ?, name = ?, description = ?, module = ?, parent_type_id = ?,
        status = ?, updated_at = ? WHERE id = ?`,
      [
        body.code ?? row.code,
        (body.name ?? row.name).trim(),
        body.description ?? row.description,
        body.module ?? row.module,
        parentId,
        body.status ?? row.status,
        ts,
        id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE") || String(err.message).includes("unique")) {
      throw new HttpError(409, "Type code already exists in this scope");
    }
    throw err;
  }
  const next = getTypeRow(db, id);
  recordVersion(db, "type", id, next, actor, "update");
  writeAudit(db, {
    actor,
    action: "metadata.type.update",
    resourceType: "metadata_type",
    resourceId: id,
    details: { code: next.code },
    ip,
  });
  return getType(db, id, tenantId);
}

export function setTypeStatus(db, id, status, actor, ip, tenantId) {
  if (!["draft", "active", "inactive"].includes(status)) {
    throw new HttpError(400, "status must be draft, active or inactive");
  }
  const row = getTypeRow(db, id);
  assertMutable(db, row, tenantId, actor, "Type not found");
  if (status === "inactive" && descendantTypeIds(db, id).length) {
    throw new HttpError(409, "Deactivate or detach child types before deactivating this type");
  }
  run(db, "UPDATE metadata_types SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), id]);
  writeAudit(db, {
    actor,
    action: `metadata.type.${status}`,
    resourceType: "metadata_type",
    resourceId: id,
    ip,
  });
  return getType(db, id, tenantId);
}

export function deleteType(db, id, actor, ip, tenantId) {
  const row = getTypeRow(db, id);
  assertMutable(db, row, tenantId, actor, "Type not found");
  if (descendantTypeIds(db, id).length) {
    throw new HttpError(409, "Cannot delete a type that has child types");
  }
  const forms = queryOne(db, "SELECT COUNT(*) AS c FROM metadata_forms WHERE type_id = ?", [id]).c;
  const rules = queryOne(db, "SELECT COUNT(*) AS c FROM metadata_rules WHERE type_id = ?", [id]).c;
  if (forms || rules) {
    throw new HttpError(409, "Cannot delete a type referenced by forms or rules");
  }
  run(db, "DELETE FROM metadata_type_attributes WHERE type_id = ?", [id]);
  run(db, "DELETE FROM metadata_types WHERE id = ?", [id]);
  writeAudit(db, {
    actor,
    action: "metadata.type.delete",
    resourceType: "metadata_type",
    resourceId: id,
    details: { code: row.code },
    ip,
  });
  return { deleted: true, id: Number(id) };
}

// ---------------------------------------------------------------------------
// Attribute associations
// ---------------------------------------------------------------------------

function associationRow(db, typeId, attributeId) {
  return queryOne(
    db,
    "SELECT * FROM metadata_type_attributes WHERE type_id = ? AND attribute_id = ?",
    [Number(typeId), Number(attributeId)]
  );
}

export function addTypeAttribute(db, typeId, body, actor, ip, tenantId) {
  const type = getTypeRow(db, typeId);
  assertMutable(db, type, tenantId, actor, "Type not found");
  const attributeId = body.attribute_id ?? body.attributeId;
  if (!attributeId) throw new HttpError(400, "attribute_id is required");
  const attribute = getAttributeRow(db, Number(attributeId));
  assertReadable(attribute, tenantId, "Attribute not found");
  assertNoTypeCycle(db, type.id, type.parent_type_id);
  const existing = associationRow(db, type.id, attribute.id);
  const ts = nowIso();
  if (existing) {
    run(
      db,
      `UPDATE metadata_type_attributes SET sequence = ?, required_override = ?, default_override = ?,
        visible = ?, editable = ?, removed = 0, updated_at = ? WHERE id = ?`,
      [
        body.sequence ?? existing.sequence,
        body.required_override === undefined ? existing.required_override : body.required_override ? 1 : 0,
        body.default_override === undefined ? existing.default_override : body.default_override,
        body.visible === undefined ? existing.visible : body.visible ? 1 : 0,
        body.editable === undefined ? existing.editable : body.editable ? 1 : 0,
        ts,
        existing.id,
      ]
    );
  } else {
    run(
      db,
      `INSERT INTO metadata_type_attributes
        (type_id, attribute_id, sequence, required_override, default_override, visible, editable, removed, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        type.id,
        attribute.id,
        body.sequence ?? 0,
        body.required_override === undefined ? null : body.required_override ? 1 : 0,
        body.default_override ?? null,
        body.visible === false ? 0 : 1,
        body.editable === false ? 0 : 1,
        ts,
        ts,
      ]
    );
  }
  writeAudit(db, {
    actor,
    action: "metadata.type.attribute.attach",
    resourceType: "metadata_type",
    resourceId: type.id,
    details: { attribute: attribute.code },
    ip,
  });
  recordVersion(db, "type", type.id, getType(db, type.id, tenantId), actor, "attach attribute");
  return getType(db, type.id, tenantId);
}

export function updateTypeAttribute(db, typeId, attributeId, body, actor, ip, tenantId) {
  const type = getTypeRow(db, typeId);
  assertMutable(db, type, tenantId, actor, "Type not found");
  const existing = associationRow(db, type.id, Number(attributeId));
  if (!existing) throw new HttpError(404, "Attribute is not attached to this type");
  run(
    db,
    `UPDATE metadata_type_attributes SET sequence = ?, required_override = ?, default_override = ?,
      visible = ?, editable = ?, removed = 0, updated_at = ? WHERE id = ?`,
    [
      body.sequence === undefined ? existing.sequence : body.sequence,
      body.required_override === undefined ? existing.required_override : body.required_override ? 1 : 0,
      body.default_override === undefined ? existing.default_override : body.default_override,
      body.visible === undefined ? existing.visible : body.visible ? 1 : 0,
      body.editable === undefined ? existing.editable : body.editable ? 1 : 0,
      nowIso(),
      existing.id,
    ]
  );
  recordVersion(db, "type", type.id, getType(db, type.id, tenantId), actor, "update attribute");
  return getType(db, type.id, tenantId);
}

export function removeTypeAttribute(db, typeId, attributeId, actor, ip, tenantId) {
  const type = getTypeRow(db, typeId);
  assertMutable(db, type, tenantId, actor, "Type not found");
  const existing = associationRow(db, type.id, Number(attributeId));
  if (!existing) throw new HttpError(404, "Attribute is not attached to this type");
  const inherited = ancestorTypes(db, type.id)
    .slice(1)
    .some((ancestor) => associationRow(db, ancestor.id, Number(attributeId)));
  if (inherited) {
    // Cannot detach an inherited attribute; mask it locally instead.
    run(
      db,
      "UPDATE metadata_type_attributes SET removed = 1, updated_at = ? WHERE id = ?",
      [nowIso(), existing.id]
    );
  } else {
    run(db, "DELETE FROM metadata_type_attributes WHERE id = ?", [existing.id]);
  }
  writeAudit(db, {
    actor,
    action: "metadata.type.attribute.detach",
    resourceType: "metadata_type",
    resourceId: type.id,
    details: { attribute_id: Number(attributeId) },
    ip,
  });
  recordVersion(db, "type", type.id, getType(db, type.id, tenantId), actor, "detach attribute");
  return getType(db, type.id, tenantId);
}

// ---------------------------------------------------------------------------
// Effective attribute resolution across inheritance
// ---------------------------------------------------------------------------

// Returns the effective, ordered attribute list for a type: ancestors first,
// child overrides applied, locally masked attributes removed. Each entry is a
// resolved attribute plus the type-association metadata used by forms.
export function effectiveAttributes(db, typeId, tenantId) {
  const chain = ancestorTypes(db, typeId);
  if (!chain.length) throw new HttpError(404, "Type not found");
  const ancestorIds = chain.slice(1).map((t) => t.id);
  const map = new Map();

  const orderByType = [...chain].reverse(); // root-first so children override
  for (const type of orderByType) {
    const rows = queryAll(
      db,
      `SELECT ta.*, a.code AS attribute_code, a.name AS attribute_name
       FROM metadata_type_attributes ta
       JOIN metadata_attributes a ON a.id = ta.attribute_id
       WHERE ta.type_id = ? ORDER BY ta.sequence, a.code`,
      [type.id]
    );
    for (const row of rows) {
      if (row.removed === 1) {
        map.delete(row.attribute_id);
        continue;
      }
      const attribute = getAttributeRow(db, row.attribute_id);
      if (!attribute) continue;
      const resolved = resolveAssociation(db, attribute, row, type, tenantId);
      if (resolved && resolved.status === "active") map.set(row.attribute_id, resolved);
    }
  }
  return [...map.values()].sort((a, b) => a.sequence - b.sequence || a.code.localeCompare(b.code));
}

function resolveAssociation(db, attribute, association, type, tenantId) {
  const resolved = publicAttributeViaChain(db, attribute, tenantId);
  if (!resolved) return null;
  const required =
    association.required_override === null || association.required_override === undefined
      ? resolved.required
      : association.required_override === 1;
  const defaultValue =
    association.default_override === null || association.default_override === undefined
      ? resolved.default_value
      : association.default_override;
  return {
    id: attribute.id,
    code: attribute.code,
    name: attribute.name,
    description: attribute.description,
    data_type: resolved.data_type,
    required,
    default_value: defaultValue,
    min_length: resolved.min_length,
    max_length: resolved.max_length,
    min_value: resolved.min_value,
    max_value: resolved.max_value,
    validation: resolved.validation,
    multi_value: resolved.multi_value,
    visible: association.visible === 1 && resolved.visible !== false,
    editable: association.editable === 1 && resolved.editable !== false,
    lov_id: resolved.lov_id,
    status: resolved.status,
    sequence: association.sequence,
    inherited_from: resolved.inherited_from,
    type_id: type.id,
    type_code: type.code,
  };
}

function publicAttributeViaChain(db, attribute, tenantId) {
  const chain = ancestorAttributes(db, attribute.id);
  if (!chain.length) return null;
  const head = chain[0];
  if (head.tenant_id !== null && head.tenant_id !== undefined && tenantId && Number(head.tenant_id) !== Number(tenantId)) {
    return null;
  }
  const merged = { ...head };
  for (const ancestor of chain.slice(1)) {
    if (merged.min_length === null && ancestor.min_length !== null) merged.min_length = ancestor.min_length;
    if (merged.max_length === null && ancestor.max_length !== null) merged.max_length = ancestor.max_length;
    if (merged.min_value === null && ancestor.min_value !== null) merged.min_value = ancestor.min_value;
    if (merged.max_value === null && ancestor.max_value !== null) merged.max_value = ancestor.max_value;
    if (!merged.lov_id && ancestor.lov_id) merged.lov_id = ancestor.lov_id;
  }
  return publicAttributeSafe(merged);
}

// Resolves a type by code/id and returns the effective contract used by other
// modules: type metadata plus the flattened attribute list.
export function resolveType(db, idOrCode, tenantId) {
  const row = findType(db, idOrCode, tenantId);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    module: row.module,
    status: row.status,
    version: row.version,
    tenant_id: row.tenant_id,
    parent_type_id: row.parent_type_id,
    is_system: row.is_system === 1,
    attributes: effectiveAttributes(db, row.id, tenantId),
  };
}

export function typeTree(db, tenantId) {
  const rows = queryAll(
    db,
    `SELECT * FROM metadata_types WHERE ${tenantClause(null, tenantId).sql} ORDER BY code`,
    tenantClause(null, tenantId).params
  );
  const byId = new Map(rows.map((r) => [r.id, { ...publicType(r), children: [] }]));
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_type_id && byId.has(node.parent_type_id)) {
      byId.get(node.parent_type_id).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}
