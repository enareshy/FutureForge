// Characteristics, characteristic groups, allowed values and their assignment to
// classes. A characteristic is a reusable, typed property definition (Flow,
// Pressure, Speed...). Groups are reusable bundles. Allowed values are governed
// data, never hard-coded. Class assignments capture local definitions and
// overrides that inheritance then composes.
import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import {
  publicCharacteristic,
  publicCharacteristicVersion,
  publicGroup,
  publicGroupMember,
  publicClassCharacteristic,
  publicAllowedValue,
} from "./repository.js";
import { characteristicRef } from "./refs.js";
import { SOURCE_MODULE, MAX_CLASS_CHARACTERISTICS, MAX_ALLOWED_VALUES } from "./constants.js";
import { getConfig } from "./configuration.js";
import {
  normalizeText,
  normalizeUpper,
  parseObject,
  paginate,
  orderClause,
  requireCode,
  requireName,
  assertCharacteristicStatus,
  assertDataType,
  assertAllowedValueMode,
  normalizeCharacteristicInput,
} from "./validation.js";
import {
  characteristicNotFound,
  characteristicConflict,
  invalidCharacteristic,
  invalidGroup,
  groupNotFound,
  groupConflict,
  invalidAllowedValue,
  allowedValueNotFound,
  allowedValueConflict,
  classNotFound,
  invalidClass,
} from "./errors.js";
import { recordChange } from "./history.js";
import { publishClassificationEvent, classificationEventCode } from "./events.js";
import { invalidate } from "./cache.js";
import { getClassRow } from "./hierarchy.js";

// ── Characteristics ──────────────────────────────────────────────────────────

export function getCharacteristicRow(db, tenantId, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM cla_characteristics WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM cla_characteristics WHERE tenant_id = ? AND code = ?", [Number(tenantId), normalizeUpper(ref)]);
}

export function requireCharacteristicRow(db, tenantId, ref) {
  const row = getCharacteristicRow(db, tenantId, ref);
  if (!row) throw characteristicNotFound(ref);
  return row;
}

export function createCharacteristic(db, tenantId, body = {}, actor = null, ip = null) {
  const normalized = normalizeCharacteristicInput(body);
  if (getCharacteristicRow(db, tenantId, normalized.code)) throw characteristicConflict(normalized.code);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO cla_characteristics
       (characteristic_ref, tenant_id, code, name, description, data_type, unit, base_unit, precision, scale,
        min_value, max_value, min_inclusive, max_inclusive, default_value, multi_valued, searchable, required,
        reference_type, status, version, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      characteristicRef(normalized.code),
      Number(tenantId),
      normalized.code,
      normalized.name,
      normalized.description,
      normalized.data_type,
      normalized.unit,
      normalized.base_unit,
      normalized.precision,
      normalized.scale,
      normalized.min_value,
      normalized.max_value,
      normalized.min_inclusive ? 1 : 0,
      normalized.max_inclusive ? 1 : 0,
      normalized.default_value,
      normalized.multi_valued ? 1 : 0,
      normalized.searchable ? 1 : 0,
      normalized.required ? 1 : 0,
      normalized.reference_type,
      normalized.status,
      JSON.stringify(normalized.metadata),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const id = Number(result.lastInsertRowid);
  invalidate(tenantId);
  const row = queryOne(db, "SELECT * FROM cla_characteristics WHERE id = ?", [id]);
  recordChange(db, { tenantId, entityType: "CHARACTERISTIC", entityId: id, entityRef: normalized.code, action: "CREATED", version: 1, status: normalized.status, after: publicCharacteristic(row), actor, ip });
  publishClassificationEvent(
    db,
    { eventType: classificationEventCode("CHARACTERISTIC_CREATED"), payload: { characteristic_id: id, code: normalized.code }, objectType: "characteristic", objectId: id, tenantId },
    actor
  );
  return publicCharacteristic(row);
}

export function listCharacteristics(db, { tenantId, dataType, status, q, searchable, page, pageSize, sort } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (dataType) {
    clauses.push("data_type = ?");
    params.push(assertDataType(dataType));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (searchable !== undefined) {
    clauses.push("searchable = ?");
    params.push(searchable ? 1 : 0);
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(description) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const { clause: order, params: orderParams } = orderClause(sort, { allowed: ["code", "name", "data_type", "status", "created_at"], default: "code", direction: "ASC" });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM cla_characteristics ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM cla_characteristics ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, ...orderParams, limit, offset]);
  return { items: rows.map(publicCharacteristic), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function getCharacteristic(db, tenantId, ref) {
  return publicCharacteristic(requireCharacteristicRow(db, tenantId, ref));
}

export function updateCharacteristic(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const row = requireCharacteristicRow(db, tenantId, ref);
  const before = publicCharacteristic(row);
  const normalized = normalizeCharacteristicInput(body, {
    ...row,
    min_inclusive: row.min_inclusive,
    max_inclusive: row.max_inclusive,
    metadata_json: row.metadata_json,
  });
  run(
    db,
    `UPDATE cla_characteristics SET name = ?, description = ?, data_type = ?, unit = ?, base_unit = ?, precision = ?, scale = ?,
       min_value = ?, max_value = ?, min_inclusive = ?, max_inclusive = ?, default_value = ?, multi_valued = ?, searchable = ?,
       required = ?, reference_type = ?, status = ?, metadata_json = ?, updated_by = ?, updated_at = ?
     WHERE id = ?`,
    [
      normalized.name,
      normalized.description,
      normalized.data_type,
      normalized.unit,
      normalized.base_unit,
      normalized.precision,
      normalized.scale,
      normalized.min_value,
      normalized.max_value,
      normalized.min_inclusive ? 1 : 0,
      normalized.max_inclusive ? 1 : 0,
      normalized.default_value,
      normalized.multi_valued ? 1 : 0,
      normalized.searchable ? 1 : 0,
      normalized.required ? 1 : 0,
      normalized.reference_type,
      normalized.status,
      JSON.stringify(normalized.metadata),
      actor?.id ?? null,
      nowIso(),
      row.id,
    ]
  );
  invalidate(tenantId);
  const after = publicCharacteristic(queryOne(db, "SELECT * FROM cla_characteristics WHERE id = ?", [row.id]));
  recordChange(db, { tenantId, entityType: "CHARACTERISTIC", entityId: row.id, entityRef: row.code, action: "UPDATED", version: row.version, status: normalized.status, before, after, actor, ip });
  publishClassificationEvent(
    db,
    { eventType: classificationEventCode("CHARACTERISTIC_UPDATED"), payload: { characteristic_id: row.id }, objectType: "characteristic", objectId: row.id, tenantId },
    actor
  );
  return after;
}

export function setCharacteristicStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = requireCharacteristicRow(db, tenantId, ref);
  const next = assertCharacteristicStatus(status);
  run(db, "UPDATE cla_characteristics SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [next, actor?.id ?? null, nowIso(), row.id]);
  invalidate(tenantId);
  const after = publicCharacteristic(queryOne(db, "SELECT * FROM cla_characteristics WHERE id = ?", [row.id]));
  recordChange(db, { tenantId, entityType: "CHARACTERISTIC", entityId: row.id, entityRef: row.code, action: "STATUS_CHANGED", version: row.version, status: next, before: publicCharacteristic(row), after, actor, ip });
  return after;
}

export function deleteCharacteristic(db, tenantId, ref, actor = null, ip = null) {
  const row = requireCharacteristicRow(db, tenantId, ref);
  const usage = Number(queryOne(db, "SELECT COUNT(*) AS c FROM cla_class_characteristics WHERE characteristic_id = ?", [row.id])?.c || 0);
  if (usage > 0) throw characteristicConflict(`Characteristic ${row.code} is used by ${usage} class(es); deactivate it instead`);
  run(db, "DELETE FROM cla_characteristics WHERE id = ?", [row.id]);
  invalidate(tenantId);
  recordChange(db, { tenantId, entityType: "CHARACTERISTIC", entityId: row.id, entityRef: row.code, action: "DELETED", version: row.version, status: row.status, before: publicCharacteristic(row), actor, ip });
  return { deleted: true, id: row.id, code: row.code };
}

export function createCharacteristicVersion(db, tenantId, ref, { changeReason = "", actor = null } = {}) {
  const row = requireCharacteristicRow(db, tenantId, ref);
  const version = Number(row.version || 1) + 1;
  run(db, "UPDATE cla_characteristics SET version = ?, updated_by = ?, updated_at = ? WHERE id = ?", [version, actor?.id ?? null, nowIso(), row.id]);
  const snapshot = publicCharacteristic(queryOne(db, "SELECT * FROM cla_characteristics WHERE id = ?", [row.id]));
  run(
    db,
    `INSERT INTO cla_characteristic_versions (characteristic_id, tenant_id, version, status, snapshot_json, change_reason, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, Number(tenantId), version, row.status, JSON.stringify(snapshot), normalizeText(changeReason, { max: 500 }), actor?.id ?? null, nowIso()]
  );
  invalidate(tenantId);
  return { version, snapshot };
}

export function listCharacteristicVersions(db, tenantId, ref) {
  const row = requireCharacteristicRow(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM cla_characteristic_versions WHERE characteristic_id = ? ORDER BY version DESC", [row.id]);
  return { items: rows.map(publicCharacteristicVersion), total: rows.length };
}

// ── Allowed values ───────────────────────────────────────────────────────────

export function getAllowedValueRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM cla_allowed_values WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
  }
  return null;
}

export function listAllowedValues(db, tenantId, characteristicRef, { status = null, q = null } = {}) {
  const characteristic = requireCharacteristicRow(db, tenantId, characteristicRef);
  const clauses = ["characteristic_id = ?"];
  const params = [characteristic.id];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(display_name) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  const rows = queryAll(db, `SELECT * FROM cla_allowed_values WHERE ${clauses.join(" AND ")} ORDER BY sort_order, code`, params);
  return { characteristic: publicCharacteristic(characteristic), items: rows.map(publicAllowedValue), total: rows.length };
}

export function createAllowedValue(db, tenantId, characteristicRef, body = {}, actor = null, ip = null) {
  const characteristic = requireCharacteristicRow(db, tenantId, characteristicRef);
  const code = normalizeUpper(requireCode(body.code));
  if (!code) throw invalidAllowedValue("Allowed value code is required");
  const existing = queryOne(db, "SELECT id FROM cla_allowed_values WHERE characteristic_id = ? AND code = ?", [characteristic.id, code]);
  if (existing) throw allowedValueConflict(code);
  const count = Number(queryOne(db, "SELECT COUNT(*) AS c FROM cla_allowed_values WHERE characteristic_id = ?", [characteristic.id])?.c || 0);
  const limit = Number(getConfig(db, tenantId, "max_allowed_values") || MAX_ALLOWED_VALUES);
  if (count >= limit) throw invalidAllowedValue(`At most ${limit} allowed values are permitted`);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO cla_allowed_values
       (tenant_id, characteristic_id, code, display_name, description, sort_order, status, effective_date, obsolete_date, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(tenantId),
      characteristic.id,
      code,
      normalizeText(body.display_name ?? body.displayName ?? code, { max: 200 }),
      normalizeText(body.description, { max: 1000 }),
      body.sort_order != null ? Number(body.sort_order) : count,
      normalizeUpper(body.status || "ACTIVE") === "INACTIVE" ? "INACTIVE" : "ACTIVE",
      normalizeText(body.effective_date, { max: 40 }) || null,
      normalizeText(body.obsolete_date, { max: 40 }) || null,
      JSON.stringify(parseObject(body.metadata, {})),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  invalidate(tenantId);
  return publicAllowedValue(queryOne(db, "SELECT * FROM cla_allowed_values WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function updateAllowedValue(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const row = getAllowedValueRow(db, tenantId, ref);
  if (!row) throw allowedValueNotFound(ref);
  const code = body.code === undefined ? row.code : normalizeUpper(requireCode(body.code));
  if (code !== row.code) {
    const dup = queryOne(db, "SELECT id FROM cla_allowed_values WHERE characteristic_id = ? AND code = ? AND id <> ?", [row.characteristic_id, code, row.id]);
    if (dup) throw allowedValueConflict(code);
  }
  run(
    db,
    `UPDATE cla_allowed_values SET code = ?, display_name = ?, description = ?, sort_order = ?, status = ?, effective_date = ?, obsolete_date = ?, metadata_json = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
    [
      code,
      normalizeText(body.display_name ?? body.displayName ?? row.display_name, { max: 200 }),
      normalizeText(body.description ?? row.description, { max: 1000 }),
      body.sort_order != null ? Number(body.sort_order) : row.sort_order,
      body.status === undefined ? row.status : normalizeUpper(body.status) === "INACTIVE" ? "INACTIVE" : "ACTIVE",
      body.effective_date === undefined ? row.effective_date : normalizeText(body.effective_date, { max: 40 }) || null,
      body.obsolete_date === undefined ? row.obsolete_date : normalizeText(body.obsolete_date, { max: 40 }) || null,
      body.metadata === undefined ? row.metadata_json : JSON.stringify(parseObject(body.metadata, {})),
      actor?.id ?? null,
      nowIso(),
      row.id,
    ]
  );
  invalidate(tenantId);
  return publicAllowedValue(queryOne(db, "SELECT * FROM cla_allowed_values WHERE id = ?", [row.id]));
}

export function deleteAllowedValue(db, tenantId, ref, actor = null, ip = null) {
  const row = getAllowedValueRow(db, tenantId, ref);
  if (!row) throw allowedValueNotFound(ref);
  run(db, "DELETE FROM cla_allowed_values WHERE id = ?", [row.id]);
  invalidate(tenantId);
  return { deleted: true, id: row.id, code: row.code };
}

export function allowedValueCodes(db, characteristicId, { status = "ACTIVE" } = {}) {
  const clauses = ["characteristic_id = ?"];
  const params = [Number(characteristicId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  const rows = queryAll(db, `SELECT code FROM cla_allowed_values WHERE ${clauses.join(" AND ")} ORDER BY sort_order, code`, params);
  return rows.map((row) => row.code);
}

// ── Characteristic groups ────────────────────────────────────────────────────

export function getGroupRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM cla_characteristic_groups WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
  }
  return queryOne(db, "SELECT * FROM cla_characteristic_groups WHERE tenant_id = ? AND code = ?", [Number(tenantId), normalizeUpper(ref)]);
}

export function requireGroupRow(db, tenantId, ref) {
  const row = getGroupRow(db, tenantId, ref);
  if (!row) throw groupNotFound(ref);
  return row;
}

export function createGroup(db, tenantId, body = {}, actor = null, ip = null) {
  const code = normalizeUpper(requireCode(body.code));
  if (!code) throw invalidGroup("Group code is required");
  if (getGroupRow(db, tenantId, code)) throw groupConflict(code);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO cla_characteristic_groups (tenant_id, code, name, description, sort_order, status, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(tenantId),
      code,
      normalizeText(requireName(body.name ?? code), { max: 200 }),
      normalizeText(body.description, { max: 1000 }),
      body.sort_order != null ? Number(body.sort_order) : 0,
      normalizeUpper(body.status || "ACTIVE") === "INACTIVE" ? "INACTIVE" : "ACTIVE",
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  invalidate(tenantId);
  return publicGroup(queryOne(db, "SELECT * FROM cla_characteristic_groups WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function listGroups(db, { tenantId, status, q } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  const rows = queryAll(db, `SELECT * FROM cla_characteristic_groups WHERE ${clauses.join(" AND ")} ORDER BY sort_order, code`, params);
  return { items: rows.map(publicGroup), total: rows.length, source_module: SOURCE_MODULE };
}

export function updateGroup(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const row = requireGroupRow(db, tenantId, ref);
  const code = body.code === undefined ? row.code : normalizeUpper(requireCode(body.code));
  if (code !== row.code && getGroupRow(db, tenantId, code)) throw groupConflict(code);
  run(
    db,
    "UPDATE cla_characteristic_groups SET code = ?, name = ?, description = ?, sort_order = ?, status = ?, updated_by = ?, updated_at = ? WHERE id = ?",
    [
      code,
      normalizeText(body.name ?? row.name, { max: 200 }),
      normalizeText(body.description ?? row.description, { max: 1000 }),
      body.sort_order != null ? Number(body.sort_order) : row.sort_order,
      body.status === undefined ? row.status : normalizeUpper(body.status) === "INACTIVE" ? "INACTIVE" : "ACTIVE",
      actor?.id ?? null,
      nowIso(),
      row.id,
    ]
  );
  invalidate(tenantId);
  return publicGroup(queryOne(db, "SELECT * FROM cla_characteristic_groups WHERE id = ?", [row.id]));
}

export function deleteGroup(db, tenantId, ref, actor = null, ip = null) {
  const row = requireGroupRow(db, tenantId, ref);
  run(db, "DELETE FROM cla_characteristic_groups WHERE id = ?", [row.id]);
  invalidate(tenantId);
  return { deleted: true, id: row.id, code: row.code };
}

export function addGroupMember(db, tenantId, groupRef, characteristicRef2, { sequence = null } = {}, actor = null, ip = null) {
  const group = requireGroupRow(db, tenantId, groupRef);
  const characteristic = requireCharacteristicRow(db, tenantId, characteristicRef2);
  const existing = queryOne(db, "SELECT id FROM cla_characteristic_group_members WHERE group_id = ? AND characteristic_id = ?", [group.id, characteristic.id]);
  if (existing) return publicGroupMember(existing);
  const count = Number(queryOne(db, "SELECT COUNT(*) AS c FROM cla_characteristic_group_members WHERE group_id = ?", [group.id])?.c || 0);
  const result = run(
    db,
    "INSERT INTO cla_characteristic_group_members (tenant_id, group_id, characteristic_id, sequence, created_at) VALUES (?, ?, ?, ?, ?)",
    [Number(tenantId), group.id, characteristic.id, sequence != null ? Number(sequence) : count, nowIso()]
  );
  invalidate(tenantId);
  return publicGroupMember(queryOne(db, "SELECT * FROM cla_characteristic_group_members WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function removeGroupMember(db, tenantId, groupRef, characteristicRef2) {
  const group = requireGroupRow(db, tenantId, groupRef);
  const characteristic = requireCharacteristicRow(db, tenantId, characteristicRef2);
  run(db, "DELETE FROM cla_characteristic_group_members WHERE group_id = ? AND characteristic_id = ?", [group.id, characteristic.id]);
  invalidate(tenantId);
  return { removed: true, group_id: group.id, characteristic_id: characteristic.id };
}

export function listGroupMembers(db, tenantId, groupRef) {
  const group = requireGroupRow(db, tenantId, groupRef);
  const rows = queryAll(
    db,
    `SELECT m.*, c.code AS characteristic_code, c.name AS characteristic_name, c.data_type
       FROM cla_characteristic_group_members m
       JOIN cla_characteristics c ON c.id = m.characteristic_id
      WHERE m.group_id = ? ORDER BY m.sequence`,
    [group.id]
  );
  return {
    group: publicGroup(group),
    items: rows.map((row) => ({ ...publicGroupMember(row), characteristic_code: row.characteristic_code, characteristic_name: row.characteristic_name, data_type: row.data_type })),
    total: rows.length,
  };
}

// ── Class characteristics (local definitions & overrides) ────────────────────

export function getClassCharacteristicRow(db, tenantId, classId, characteristicId) {
  return queryOne(db, "SELECT * FROM cla_class_characteristics WHERE tenant_id = ? AND class_id = ? AND characteristic_id = ?", [Number(tenantId), Number(classId), Number(characteristicId)]);
}

export function addClassCharacteristic(db, tenantId, classRef, body = {}, actor = null, ip = null) {
  const classRow = getClassRow(db, tenantId, classRef);
  if (!classRow) throw classNotFound(classRef);
  const characteristic = requireCharacteristicRow(db, tenantId, body.characteristic_id ?? body.characteristicId ?? body.characteristic);
  const existing = getClassCharacteristicRow(db, tenantId, classRow.id, characteristic.id);
  if (existing) return publicClassCharacteristic(existing);
  const count = Number(queryOne(db, "SELECT COUNT(*) AS c FROM cla_class_characteristics WHERE class_id = ?", [classRow.id])?.c || 0);
  if (count >= MAX_CLASS_CHARACTERISTICS) throw invalidClass(`At most ${MAX_CLASS_CHARACTERISTICS} characteristics per class are allowed`);
  const allowedIds = Array.isArray(body.allowed_value_ids ?? body.allowedValueIds) ? (body.allowed_value_ids ?? body.allowedValueIds).map(Number) : [];
  const result = run(
    db,
    `INSERT INTO cla_class_characteristics
       (tenant_id, class_id, characteristic_id, sequence, required, multi_valued, origin, override_required, override_default,
        unit_override, min_value, max_value, allowed_value_mode, allowed_value_ids_json, default_value, status, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(tenantId),
      classRow.id,
      characteristic.id,
      body.sequence != null ? Number(body.sequence) : count,
      body.required != null ? (body.required ? 1 : 0) : characteristic.required,
      body.multi_valued != null || body.multiValued != null ? (body.multi_valued ?? body.multiValued ? 1 : 0) : characteristic.multi_valued,
      "LOCAL",
      body.override_required ?? body.overrideRequired ? 1 : 0,
      body.override_default ?? body.overrideDefault ? 1 : 0,
      normalizeText(body.unit_override ?? body.unitOverride, { max: 60 }),
      body.min_value != null ? Number(body.min_value) : null,
      body.max_value != null ? Number(body.max_value) : null,
      assertAllowedValueMode(body.allowed_value_mode ?? body.allowedValueMode ?? "INHERIT"),
      JSON.stringify(allowedIds),
      normalizeText(body.default_value ?? body.defaultValue, { max: 500 }),
      normalizeUpper(body.status || "ACTIVE") === "INACTIVE" ? "INACTIVE" : "ACTIVE",
      actor?.id ?? null,
      actor?.id ?? null,
      nowIso(),
      nowIso(),
    ]
  );
  invalidate(tenantId);
  const row = queryOne(db, "SELECT * FROM cla_class_characteristics WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordChange(db, { tenantId, entityType: "CLASS_CHARACTERISTIC", entityId: row.id, entityRef: `${classRow.code}:${characteristic.code}`, action: "CREATED", after: publicClassCharacteristic(row), actor, ip });
  return publicClassCharacteristic(row);
}

export function updateClassCharacteristic(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const row = queryOne(db, "SELECT * FROM cla_class_characteristics WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(ref)]);
  if (!row) throw characteristicNotFound(ref);
  const allowedIds = body.allowed_value_ids !== undefined || body.allowedValueIds !== undefined
    ? JSON.stringify((body.allowed_value_ids ?? body.allowedValueIds ?? []).map(Number))
    : row.allowed_value_ids_json;
  run(
    db,
    `UPDATE cla_class_characteristics SET sequence = ?, required = ?, multi_valued = ?, origin = ?, override_required = ?, override_default = ?,
       unit_override = ?, min_value = ?, max_value = ?, allowed_value_mode = ?, allowed_value_ids_json = ?, default_value = ?, status = ?, updated_by = ?, updated_at = ?
     WHERE id = ?`,
    [
      body.sequence != null ? Number(body.sequence) : row.sequence,
      body.required === undefined ? row.required : body.required ? 1 : 0,
      body.multi_valued === undefined && body.multiValued === undefined ? row.multi_valued : (body.multi_valued ?? body.multiValued) ? 1 : 0,
      body.origin === undefined ? row.origin : normalizeUpper(body.origin) === "OVERRIDDEN" ? "OVERRIDDEN" : "LOCAL",
      body.override_required === undefined && body.overrideRequired === undefined ? row.override_required : (body.override_required ?? body.overrideRequired) ? 1 : 0,
      body.override_default === undefined && body.overrideDefault === undefined ? row.override_default : (body.override_default ?? body.overrideDefault) ? 1 : 0,
      body.unit_override === undefined && body.unitOverride === undefined ? row.unit_override : normalizeText(body.unit_override ?? body.unitOverride, { max: 60 }),
      body.min_value === undefined ? row.min_value : body.min_value == null ? null : Number(body.min_value),
      body.max_value === undefined ? row.max_value : body.max_value == null ? null : Number(body.max_value),
      body.allowed_value_mode === undefined && body.allowedValueMode === undefined ? row.allowed_value_mode : assertAllowedValueMode(body.allowed_value_mode ?? body.allowedValueMode),
      allowedIds,
      body.default_value === undefined && body.defaultValue === undefined ? row.default_value : normalizeText(body.default_value ?? body.defaultValue, { max: 500 }),
      body.status === undefined ? row.status : normalizeUpper(body.status) === "INACTIVE" ? "INACTIVE" : "ACTIVE",
      actor?.id ?? null,
      nowIso(),
      row.id,
    ]
  );
  invalidate(tenantId);
  return publicClassCharacteristic(queryOne(db, "SELECT * FROM cla_class_characteristics WHERE id = ?", [row.id]));
}

export function removeClassCharacteristic(db, tenantId, ref, actor = null, ip = null) {
  const row = queryOne(db, "SELECT * FROM cla_class_characteristics WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(ref)]);
  if (!row) throw characteristicNotFound(ref);
  run(db, "DELETE FROM cla_class_characteristics WHERE id = ?", [row.id]);
  invalidate(tenantId);
  recordChange(db, { tenantId, entityType: "CLASS_CHARACTERISTIC", entityId: row.id, action: "DELETED", before: publicClassCharacteristic(row), actor, ip });
  return { deleted: true, id: row.id };
}

export function listClassCharacteristics(db, tenantId, classRef) {
  const classRow = getClassRow(db, tenantId, classRef);
  if (!classRow) throw classNotFound(classRef);
  const rows = queryAll(
    db,
    `SELECT cc.*, c.code AS characteristic_code, c.name AS characteristic_name, c.data_type, c.unit AS characteristic_unit, c.base_unit
       FROM cla_class_characteristics cc
       JOIN cla_characteristics c ON c.id = cc.characteristic_id
      WHERE cc.class_id = ? AND cc.status = 'ACTIVE'
      ORDER BY cc.sequence, c.code`,
    [classRow.id]
  );
  return {
    class: publicClass(classRow),
    items: rows.map((row) => ({
      ...publicClassCharacteristic(row),
      characteristic_code: row.characteristic_code,
      characteristic_name: row.characteristic_name,
      data_type: row.data_type,
      characteristic_unit: row.characteristic_unit,
      base_unit: row.base_unit,
    })),
    total: rows.length,
  };
}

export { transaction };
