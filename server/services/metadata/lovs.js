import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { recordVersion } from "./versions.js";
import { assertReadable, assertMutable, tenantClause } from "./scope.js";

export const SELECTION_TYPES = ["single", "multi"];

function publicLov(row) {
  if (!row) return null;
  return { ...row, is_system: row.is_system === 1 };
}

function publicValue(row) {
  if (!row) return null;
  return {
    ...row,
    active: row.active === 1,
    metadata: safeParse(row.metadata_json, {}),
  };
}

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function getLovRow(db, id) {
  return queryOne(db, "SELECT * FROM metadata_lovs WHERE id = ?", [Number(id)]);
}

function findLovByCode(db, code, tenantId) {
  const scope = tenantClause(null, tenantId);
  return queryOne(
    db,
    `SELECT * FROM metadata_lovs WHERE code = ? AND ${scope.sql} ORDER BY tenant_id IS NULL LIMIT 1`,
    [code, ...scope.params]
  );
}

export function findLov(db, idOrCode, tenantId) {
  if (idOrCode === undefined || idOrCode === null || idOrCode === "") return null;
  if (typeof idOrCode === "number" || /^\d+$/.test(String(idOrCode))) {
    const byId = queryOne(db, "SELECT * FROM metadata_lovs WHERE id = ?", [Number(idOrCode)]);
    if (byId) {
      assertReadable(byId, tenantId, "LOV not found");
      return byId;
    }
  }
  const byCode = findLovByCode(db, String(idOrCode), tenantId);
  if (!byCode) throw new HttpError(404, "LOV not found");
  return byCode;
}

export function listValues(db, lovId, { activeOnly = false } = {}) {
  const clause = activeOnly ? "AND active = 1" : "";
  return queryAll(
    db,
    `SELECT * FROM metadata_lov_values WHERE lov_id = ? ${clause} ORDER BY sequence, label`,
    [Number(lovId)]
  ).map(publicValue);
}

export function getLov(db, idOrCode, tenantId, { withValues = true } = {}) {
  const row = findLov(db, idOrCode, tenantId);
  const result = publicLov(row);
  if (withValues) {
    result.values = listValues(db, row.id);
    if (row.parent_lov_id) {
      const parent = queryOne(db, "SELECT id, code, name FROM metadata_lovs WHERE id = ?", [row.parent_lov_id]);
      result.parent_lov = parent || null;
    }
  }
  return result;
}

export function listLovs(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause("l", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.status) {
    where.push("l.status = ?");
    params.push(query.status);
  }
  if (query.q) {
    where.push("(l.code LIKE ? OR l.name LIKE ? OR l.description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM metadata_lovs l ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT l.*, (SELECT COUNT(*) FROM metadata_lov_values v WHERE v.lov_id = l.id) AS value_count
     FROM metadata_lovs l ${clause} ORDER BY l.code LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicLov);
  return { items, total, page, pageSize };
}

function assertLovNoCycle(db, id, parentLovId) {
  if (!parentLovId) return;
  if (Number(id) === Number(parentLovId)) throw new HttpError(400, "A LOV cannot depend on itself");
  let current = Number(parentLovId);
  const seen = new Set();
  while (current) {
    if (seen.has(current) || current === Number(id)) throw new HttpError(400, "LOV dependency cycle detected");
    seen.add(current);
    const row = queryOne(db, "SELECT parent_lov_id FROM metadata_lovs WHERE id = ?", [current]);
    if (!row) throw new HttpError(400, "Parent LOV not found");
    current = row.parent_lov_id;
  }
}

export function createLov(db, body, actor, ip, tenantId) {
  requireFields(body, ["code", "name"]);
  validateCode(body.code, "LOV code");
  const selectionType = body.selection_type || body.selectionType || "single";
  if (!SELECTION_TYPES.includes(selectionType)) {
    throw new HttpError(400, "selection_type must be single or multi");
  }
  let parentLovId = body.parent_lov_id ?? body.parentLovId ?? null;
  if (parentLovId) {
    const parent = getLovRow(db, parentLovId);
    assertReadable(parent, tenantId, "Parent LOV not found");
    parentLovId = Number(parentLovId);
  }
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO metadata_lovs
        (code, name, description, selection_type, parent_lov_id, status, tenant_id, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.description || "",
        selectionType,
        parentLovId,
        body.status || "active",
        tenantId ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE") || String(err.message).includes("unique")) {
      throw new HttpError(409, "LOV code already exists in this scope");
    }
    throw err;
  }
  const row = getLovRow(db, result.lastInsertRowid);
  recordVersion(db, "lov", row.id, { ...row, values: [] }, actor, "create");
  writeAudit(db, {
    actor,
    action: "metadata.lov.create",
    resourceType: "metadata_lov",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  return getLov(db, row.id, tenantId);
}

export function updateLov(db, id, body, actor, ip, tenantId) {
  const row = getLovRow(db, id);
  assertMutable(db, row, tenantId, actor, "LOV not found");
  if (body.code && body.code !== row.code) validateCode(body.code, "LOV code");
  const selectionType = body.selection_type || body.selectionType || row.selection_type;
  if (!SELECTION_TYPES.includes(selectionType)) {
    throw new HttpError(400, "selection_type must be single or multi");
  }
  let parentLovId =
    body.parent_lov_id === undefined && body.parentLovId === undefined
      ? row.parent_lov_id
      : body.parent_lov_id ?? body.parentLovId ?? null;
  if (parentLovId !== null && parentLovId !== undefined) {
    parentLovId = Number(parentLovId);
    assertReadable(getLovRow(db, parentLovId), tenantId, "Parent LOV not found");
    assertLovNoCycle(db, id, parentLovId);
  } else {
    parentLovId = null;
  }
  try {
    run(
      db,
      `UPDATE metadata_lovs SET code = ?, name = ?, description = ?, selection_type = ?,
        parent_lov_id = ?, status = ?, updated_at = ? WHERE id = ?`,
      [
        body.code ?? row.code,
        (body.name ?? row.name).trim(),
        body.description ?? row.description,
        selectionType,
        parentLovId,
        body.status ?? row.status,
        nowIso(),
        id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE") || String(err.message).includes("unique")) {
      throw new HttpError(409, "LOV code already exists in this scope");
    }
    throw err;
  }
  recordVersion(db, "lov", id, getLov(db, id, tenantId), actor, "update");
  writeAudit(db, {
    actor,
    action: "metadata.lov.update",
    resourceType: "metadata_lov",
    resourceId: id,
    ip,
  });
  return getLov(db, id, tenantId);
}

export function setLovStatus(db, id, status, actor, ip, tenantId) {
  if (!["active", "inactive"].includes(status)) throw new HttpError(400, "status must be active or inactive");
  const row = getLovRow(db, id);
  assertMutable(db, row, tenantId, actor, "LOV not found");
  run(db, "UPDATE metadata_lovs SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), id]);
  writeAudit(db, { actor, action: `metadata.lov.${status}`, resourceType: "metadata_lov", resourceId: id, ip });
  return getLov(db, id, tenantId);
}

export function deleteLov(db, id, actor, ip, tenantId) {
  const row = getLovRow(db, id);
  assertMutable(db, row, tenantId, actor, "LOV not found");
  const dependents = queryOne(db, "SELECT COUNT(*) AS c FROM metadata_lovs WHERE parent_lov_id = ?", [id]).c;
  if (dependents) throw new HttpError(409, "Cannot delete a LOV that dependent LOVs use");
  const attributes = queryOne(db, "SELECT COUNT(*) AS c FROM metadata_attributes WHERE lov_id = ?", [id]).c;
  if (attributes) throw new HttpError(409, "Cannot delete a LOV that attributes reference");
  const usage = queryOne(db, "SELECT COUNT(*) AS c FROM metadata_lov_usage WHERE lov_id = ?", [id]).c;
  if (usage) throw new HttpError(409, "Cannot delete a LOV whose values are in use");
  run(db, "DELETE FROM metadata_lov_values WHERE lov_id = ?", [id]);
  run(db, "DELETE FROM metadata_lovs WHERE id = ?", [id]);
  writeAudit(db, {
    actor,
    action: "metadata.lov.delete",
    resourceType: "metadata_lov",
    resourceId: id,
    details: { code: row.code },
    ip,
  });
  return { deleted: true, id: Number(id) };
}

// ---------------------------------------------------------------------------
// LOV values
// ---------------------------------------------------------------------------

export function addValue(db, lovId, body, actor, ip, tenantId) {
  const lov = getLovRow(db, lovId);
  assertMutable(db, lov, tenantId, actor, "LOV not found");
  requireFields(body, ["code", "label"]);
  const parentValueId = body.parent_value_id ?? body.parentValueId ?? null;
  if (parentValueId) {
    const parent = queryOne(db, "SELECT * FROM metadata_lov_values WHERE id = ? AND lov_id = ?", [
      Number(parentValueId),
      lov.id,
    ]);
    if (!parent) throw new HttpError(400, "Parent value must belong to the same LOV");
  }
  let result;
  try {
    result = run(
      db,
      `INSERT INTO metadata_lov_values
        (lov_id, code, label, sequence, active, parent_value_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        lov.id,
        body.code,
        String(body.label).trim(),
        body.sequence ?? 0,
        body.active === false ? 0 : 1,
        parentValueId,
        JSON.stringify(body.metadata || {}),
        nowIso(),
        nowIso(),
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE") || String(err.message).includes("unique")) {
      throw new HttpError(409, "Value code already exists in this LOV");
    }
    throw err;
  }
  recordVersion(db, "lov", lov.id, getLov(db, lov.id, tenantId), actor, "add value");
  writeAudit(db, {
    actor,
    action: "metadata.lov.value.create",
    resourceType: "metadata_lov",
    resourceId: lov.id,
    details: { value: body.code },
    ip,
  });
  return publicValue(queryOne(db, "SELECT * FROM metadata_lov_values WHERE id = ?", [result.lastInsertRowid]));
}

export function updateValue(db, lovId, valueId, body, actor, ip, tenantId) {
  const lov = getLovRow(db, lovId);
  assertMutable(db, lov, tenantId, actor, "LOV not found");
  const existing = queryOne(db, "SELECT * FROM metadata_lov_values WHERE id = ? AND lov_id = ?", [
    Number(valueId),
    lov.id,
  ]);
  if (!existing) throw new HttpError(404, "LOV value not found");
  const parentValueId =
    body.parent_value_id === undefined && body.parentValueId === undefined
      ? existing.parent_value_id
      : body.parent_value_id ?? body.parentValueId ?? null;
  if (parentValueId) {
    if (Number(parentValueId) === Number(valueId)) throw new HttpError(400, "A value cannot be its own parent");
    const parent = queryOne(db, "SELECT * FROM metadata_lov_values WHERE id = ? AND lov_id = ?", [
      Number(parentValueId),
      lov.id,
    ]);
    if (!parent) throw new HttpError(400, "Parent value must belong to the same LOV");
  }
  run(
    db,
    `UPDATE metadata_lov_values SET code = ?, label = ?, sequence = ?, active = ?,
      parent_value_id = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
    [
      body.code ?? existing.code,
      (body.label ?? existing.label).trim(),
      body.sequence === undefined ? existing.sequence : body.sequence,
      body.active === undefined ? existing.active : body.active ? 1 : 0,
      parentValueId,
      body.metadata === undefined ? existing.metadata_json : JSON.stringify(body.metadata || {}),
      nowIso(),
      Number(valueId),
    ]
  );
  recordVersion(db, "lov", lov.id, getLov(db, lov.id, tenantId), actor, "update value");
  return publicValue(queryOne(db, "SELECT * FROM metadata_lov_values WHERE id = ?", [Number(valueId)]));
}

export function removeValue(db, lovId, valueId, actor, ip, tenantId) {
  const lov = getLovRow(db, lovId);
  assertMutable(db, lov, tenantId, actor, "LOV not found");
  const existing = queryOne(db, "SELECT * FROM metadata_lov_values WHERE id = ? AND lov_id = ?", [
    Number(valueId),
    lov.id,
  ]);
  if (!existing) throw new HttpError(404, "LOV value not found");
  const children = queryOne(db, "SELECT COUNT(*) AS c FROM metadata_lov_values WHERE parent_value_id = ?", [
    Number(valueId),
  ]).c;
  if (children) throw new HttpError(409, "Cannot delete a value that has dependent child values");
  const usage = queryOne(db, "SELECT COUNT(*) AS c FROM metadata_lov_usage WHERE value_id = ?", [Number(valueId)]).c;
  if (usage) {
    // Values already referenced by records are retired, never deleted, so old
    // data keeps resolving to a label.
    run(db, "UPDATE metadata_lov_values SET active = 0, updated_at = ? WHERE id = ?", [nowIso(), Number(valueId)]);
    writeAudit(db, {
      actor,
      action: "metadata.lov.value.retire",
      resourceType: "metadata_lov",
      resourceId: lov.id,
      details: { value_id: Number(valueId), reason: "in_use" },
      ip,
    });
    return { id: Number(valueId), retired: true, deleted: false };
  }
  run(db, "DELETE FROM metadata_lov_values WHERE id = ?", [Number(valueId)]);
  recordVersion(db, "lov", lov.id, getLov(db, lov.id, tenantId), actor, "remove value");
  writeAudit(db, {
    actor,
    action: "metadata.lov.value.delete",
    resourceType: "metadata_lov",
    resourceId: lov.id,
    details: { value_id: Number(valueId) },
    ip,
  });
  return { id: Number(valueId), deleted: true };
}

// Dependent/cascading options: when parentValueId is provided only children of
// that value are returned, otherwise the root options are returned.
export function cascadeOptions(db, lovId, parentValueId, tenantId) {
  const lov = findLov(db, lovId, tenantId);
  if (parentValueId === undefined || parentValueId === null || parentValueId === "") {
    return listValues(db, lov.id, { activeOnly: true }).filter((v) => !v.parent_value_id);
  }
  return listValues(db, lov.id, { activeOnly: true }).filter(
    (v) => Number(v.parent_value_id) === Number(parentValueId)
  );
}

export function markUsage(db, lovId, valueId, refType = "record", refId = "") {
  run(
    db,
    `INSERT OR IGNORE INTO metadata_lov_usage (lov_id, value_id, ref_type, ref_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [Number(lovId), valueId === null || valueId === undefined ? null : Number(valueId), refType, String(refId), nowIso()]
  );
}

export function releaseUsage(db, lovId, refType, refId) {
  return run(db, "DELETE FROM metadata_lov_usage WHERE lov_id = ? AND ref_type = ? AND ref_id = ?", [
    Number(lovId),
    refType,
    String(refId),
  ]).changes;
}

export function listUsage(db, lovId) {
  return queryAll(
    db,
    `SELECT u.*, v.code AS value_code, v.label AS value_label
     FROM metadata_lov_usage u LEFT JOIN metadata_lov_values v ON v.id = u.value_id
     WHERE u.lov_id = ? ORDER BY u.id`,
    [Number(lovId)]
  );
}

// Confirms a submitted value belongs to the LOV and is selectable.
export function assertValueInLov(db, lovId, rawValue, tenantId) {
  const lov = findLov(db, lovId, tenantId);
  const values = listValues(db, lov.id, { activeOnly: true });
  const match = values.find((v) => v.code === String(rawValue) || String(v.id) === String(rawValue));
  if (!match) throw new HttpError(400, `"${rawValue}" is not a valid value for LOV ${lov.code}`);
  return match;
}

export function resolveLov(db, lovId, tenantId, { activeOnly = true } = {}) {
  const lov = findLov(db, lovId, tenantId);
  return { ...publicLov(lov), values: listValues(db, lov.id, { activeOnly }) };
}
