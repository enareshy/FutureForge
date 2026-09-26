// Characteristic inheritance.
//
// Inheritance is deterministic and single-parent (the domain model keeps
// multi-parent conflict resolution as an extension point). A class inherits its
// ancestors' characteristics; a local definition of the same characteristic
// overrides the inherited one. Every resolved entry records where it came from
// (INHERITED / LOCAL / OVERRIDDEN) and whether required/default/unit/allowed
// values were overridden, so the UI and validation agree on exactly one meaning.
import { queryAll, queryOne } from "../../db.js";
import { getClassRow } from "./hierarchy.js";
import { publicAllowedValue } from "./repository.js";
import { normalizeUpper } from "./validation.js";
import { classNotFound, characteristicNotFound, invalidClass, inheritanceConflict } from "./errors.js";
import { allowedValueCodes } from "./characteristics.js";

// Returns the ancestor chain root-first, ending with the class itself.
export function classChain(db, tenantId, classRow) {
  const chain = [];
  const guard = new Set();
  let current = classRow;
  while (current) {
    if (guard.has(current.id)) throw inheritanceConflict({ class_id: current.id, reason: "cycle detected" });
    guard.add(current.id);
    chain.unshift(current);
    if (!current.parent_class_id) break;
    current = queryOne(db, "SELECT * FROM cla_classes WHERE id = ?", [current.parent_class_id]);
  }
  return chain;
}

function localRowsForClasses(db, classIds) {
  if (!classIds.length) return [];
  const placeholders = classIds.map(() => "?").join(", ");
  return queryAll(
    db,
    `SELECT cc.*, c.code AS characteristic_code, c.name AS characteristic_name, c.data_type, c.unit AS characteristic_unit,
       c.base_unit, c.min_value AS char_min, c.max_value AS char_max, c.min_inclusive AS char_min_inclusive,
       c.max_inclusive AS char_max_inclusive, c.precision AS char_precision, c.scale AS char_scale,
       c.default_value AS char_default, c.multi_valued AS char_multi_valued, c.required AS char_required,
       c.reference_type, c.searchable, c.status AS char_status
       FROM cla_class_characteristics cc
       JOIN cla_characteristics c ON c.id = cc.characteristic_id
      WHERE cc.class_id IN (${placeholders})
      ORDER BY cc.sequence, c.code`,
    classIds.map(Number)
  );
}

function allowedValuesFor(db, characteristicId, mode, ids) {
  const rows = queryAll(db, "SELECT * FROM cla_allowed_values WHERE characteristic_id = ? AND status = 'ACTIVE' ORDER BY sort_order, code", [Number(characteristicId)]);
  if (mode === "RESTRICT") {
    const allowed = new Set((ids || []).map(Number));
    return rows.filter((row) => allowed.has(Number(row.id))).map(publicAllowedValue);
  }
  if (mode === "EXTEND") {
    return rows.map(publicAllowedValue);
  }
  return rows.map(publicAllowedValue);
}

// Resolves the effective characteristic contract for a class.
export function resolveEffectiveCharacteristics(db, tenantId, classRef, { includeInherited = true, includeInactive = false } = {}) {
  const classRow = getClassRow(db, tenantId, classRef);
  if (!classRow) throw classNotFound(classRef);
  const chain = classChain(db, tenantId, classRow);
  const chainIds = includeInherited ? chain.map((entry) => entry.id) : [classRow.id];
  const rows = localRowsForClasses(db, chainIds);
  const byCharacteristic = new Map();

  for (const row of rows) {
    if (!includeInactive && row.status === "INACTIVE") continue;
    if (!includeInactive && row.char_status === "INACTIVE") continue;
    const ownerClass = chain.find((entry) => entry.id === row.class_id);
    const isLocal = Number(row.class_id) === Number(classRow.id);
    const existing = byCharacteristic.get(row.characteristic_id);
    const allowedMode = existing && existing.allowed_value_mode === "RESTRICT" && row.allowed_value_mode === "INHERIT"
      ? "RESTRICT"
      : row.allowed_value_mode;
    const merged = {
      characteristic_id: row.characteristic_id,
      code: row.characteristic_code,
      name: row.characteristic_name,
      description: row.description || "",
      data_type: row.data_type,
      unit: row.unit_override || row.characteristic_unit || "",
      base_unit: row.base_unit || row.unit_override || row.characteristic_unit || "",
      required: Boolean(row.required),
      multi_valued: Boolean(row.multi_valued ?? row.char_multi_valued),
      searchable: Boolean(row.searchable),
      precision: row.char_precision == null ? null : Number(row.char_precision),
      scale: row.char_scale == null ? null : Number(row.char_scale),
      min_value: row.min_value != null ? Number(row.min_value) : row.char_min != null ? Number(row.char_min) : null,
      max_value: row.max_value != null ? Number(row.max_value) : row.char_max != null ? Number(row.char_max) : null,
      min_inclusive: Boolean(row.char_min_inclusive),
      max_inclusive: Boolean(row.char_max_inclusive),
      default_value: row.override_default ? row.default_value : row.char_default || row.default_value || "",
      reference_type: row.reference_type || "",
      allowed_value_mode: allowedMode,
      allowed_value_ids: JSON.parse(row.allowed_value_ids_json || "[]"),
      origin: isLocal ? (existing ? "OVERRIDDEN" : "LOCAL") : "INHERITED",
      source_class_id: row.class_id,
      source_class_code: ownerClass ? ownerClass.code : "",
      source_class_path: ownerClass ? ownerClass.path : "",
      sequence: row.sequence,
      status: row.status,
    };
    byCharacteristic.set(row.characteristic_id, merged);
  }

  const items = [...byCharacteristic.values()].map((entry) => ({
    ...entry,
    allowed_values: allowedValuesFor(db, entry.characteristic_id, entry.allowed_value_mode, entry.allowed_value_ids),
  }));

  items.sort((left, right) => left.sequence - right.sequence || left.code.localeCompare(right.code));
  return {
    class: { id: classRow.id, code: classRow.code, name: classRow.name, path: classRow.path, level: classRow.level, classification_id: classRow.classification_id },
    chain: chain.map((entry) => ({ id: entry.id, code: entry.code, path: entry.path, level: entry.level })),
    items,
    inherited_count: items.filter((entry) => entry.origin === "INHERITED").length,
    local_count: items.filter((entry) => entry.origin === "LOCAL").length,
    overridden_count: items.filter((entry) => entry.origin === "OVERRIDDEN").length,
    total: items.length,
  };
}

export function effectiveCharacteristic(db, tenantId, classRef, characteristicRef) {
  const resolved = resolveEffectiveCharacteristics(db, tenantId, classRef);
  const characteristic = resolved.items.find(
    (entry) => Number(entry.characteristic_id) === Number(characteristicRef) || normalizeUpper(entry.code) === normalizeUpper(characteristicRef)
  );
  if (!characteristic) throw characteristicNotFound(characteristicRef);
  return characteristic;
}

// Validates that a class's local allowed-value restriction is a subset of the
// inherited set. Over-extension/restriction can never silently change meaning.
export function validateAllowedValueModes(db, tenantId, classRef) {
  const classRow = getClassRow(db, tenantId, classRef);
  if (!classRow) throw classNotFound(classRef);
  const resolved = resolveEffectiveCharacteristics(db, tenantId, classRef);
  const issues = [];
  for (const entry of resolved.items) {
    if (entry.allowed_value_mode === "RESTRICT" && Array.isArray(entry.allowed_value_ids) && entry.allowed_value_ids.length) {
      const parent = classRow.parent_class_id ? classRow.parent_class_id : null;
      if (!parent) continue;
      const inheritedCodes = new Set(allowedValueCodes(db, entry.characteristic_id));
      const restricted = queryAll(
        db,
        `SELECT code FROM cla_allowed_values WHERE characteristic_id = ? AND id IN (${entry.allowed_value_ids.map(() => "?").join(", ")})`,
        [entry.characteristic_id, ...entry.allowed_value_ids]
      );
      for (const value of restricted) {
        if (inheritedCodes.size && !inheritedCodes.has(value.code)) {
          issues.push({ characteristic_id: entry.characteristic_id, code: entry.code, value_code: value.code, reason: "RESTRICT_NOT_SUBSET" });
        }
      }
    }
  }
  if (issues.length) throw invalidClass("Allowed value restriction is not a subset of the inherited values", { issues });
  return { valid: true, items: resolved.items.length };
}
