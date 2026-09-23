// Reusable classification validation.
//
// The single validation contract other modules call before save, release,
// import or migration. It validates data type, allowed values, min/max,
// precision/scale, unit presence and compatibility, reference integrity,
// required characteristics (inherited included) and class rules. It never
// trusts client-provided values and always uses the server-resolved definition.
import { queryAll, queryOne } from "../../db.js";
import { coerceCharacteristicValue, normalizeText, normalizeUpper } from "./validation.js";
import { resolveEffectiveCharacteristics } from "./inheritance.js";
import { convertValue, listUnits } from "./units.js";
import { getConfig } from "./configuration.js";
import { evaluateRules } from "./rules.js";
import { validationFailed } from "./errors.js";
import { publicAssignment, publicAssignmentValue } from "./repository.js";

// Flattens the many accepted client value shapes into uniform entries.
export function flattenValues(raw) {
  const entries = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item === null || item === undefined) continue;
      const ref = item.characteristic_id ?? item.characteristicId ?? item.code ?? item.characteristic;
      const unit = item.unit ?? null;
      if (Array.isArray(item.values)) {
        for (const value of item.values) {
          entries.push({
            ref,
            value: typeof value === "object" && value !== null ? value.value : value,
            unit: (typeof value === "object" && value !== null ? value.unit : null) ?? unit,
          });
        }
      } else {
        entries.push({ ref, value: item.value ?? item.value_text ?? null, unit });
      }
    }
    return entries;
  }
  if (raw && typeof raw === "object") {
    for (const [ref, value] of Object.entries(raw)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          entries.push({
            ref,
            value: typeof entry === "object" && entry !== null ? entry.value : entry,
            unit: (typeof entry === "object" && entry !== null ? entry.unit : null) ?? null,
          });
        }
      } else if (value && typeof value === "object" && "value" in value) {
        entries.push({ ref, value: value.value, unit: value.unit ?? null });
      } else {
        entries.push({ ref, value, unit: null });
      }
    }
  }
  return entries;
}

function matchCharacteristic(resolved, entry) {
  const raw = entry.ref;
  if (raw === null || raw === undefined) return null;
  const numeric = Number(raw);
  if (Number.isInteger(numeric) && String(numeric) === String(raw).trim()) {
    return resolved.items.find((item) => Number(item.characteristic_id) === numeric) || null;
  }
  return resolved.items.find((item) => normalizeUpper(item.code) === normalizeUpper(raw)) || null;
}

function groupValues(resolved, raw) {
  const grouped = new Map();
  const unmatched = [];
  for (const entry of flattenValues(raw)) {
    const characteristic = matchCharacteristic(resolved, entry);
    if (!characteristic) {
      unmatched.push(entry);
      continue;
    }
    const list = grouped.get(characteristic.characteristic_id) || [];
    list.push(entry);
    grouped.set(characteristic.characteristic_id, list);
  }
  return { grouped, unmatched };
}

// Validates a raw value map against a class. `partial` skips the
// required-characteristic check (used while editing before save).
export function validateClassValues(db, tenantId, classRef, rawValues = {}, { partial = false } = {}) {
  const resolved = resolveEffectiveCharacteristics(db, tenantId, classRef);
  const { grouped, unmatched } = groupValues(resolved, rawValues);
  const units = listUnits(db, { limit: 2000 });
  const enforceUnits = getConfig(db, tenantId, "enforce_units") !== false;
  const errors = [];
  const warnings = [];
  const missingRequired = [];
  const invalidValues = [];
  const unitErrors = [];
  const items = [];

  if (unmatched.length) {
    warnings.push({
      code: "UNKNOWN_CHARACTERISTIC",
      message: "Values were supplied for characteristics not defined on this class",
      refs: unmatched.map((entry) => entry.ref),
    });
  }

  for (const entry of resolved.items) {
    const values = grouped.get(entry.characteristic_id) || [];
    const characteristic = {
      id: entry.characteristic_id,
      code: entry.code,
      name: entry.name,
      data_type: entry.data_type,
      required: entry.required,
      min_value: entry.min_value,
      max_value: entry.max_value,
      min_inclusive: entry.min_inclusive,
      max_inclusive: entry.max_inclusive,
      scale: entry.scale,
      unit: entry.unit,
      base_unit: entry.base_unit,
    };
    const allowedCodes = (entry.allowed_values || []).map((value) => normalizeUpper(value.code));

    if (entry.required && values.length === 0 && !partial) {
      const record = { characteristic_id: entry.characteristic_id, characteristic_code: entry.code, code: "REQUIRED", message: `${entry.name || entry.code} is required` };
      missingRequired.push(record);
      errors.push(record);
      continue;
    }
    if (values.length > 1 && !entry.multi_valued) {
      warnings.push({ characteristic_id: entry.characteristic_id, code: entry.code, code: "MULTIPLE_VALUES", message: `${entry.code} is single-valued; only the first value is used` });
    }
    const effective = entry.multi_valued ? values : values.slice(0, 1);
    let itemValid = true;
    for (const valueEntry of effective) {
      const coerced = coerceCharacteristicValue(characteristic, valueEntry.value, { allowedCodes: entry.data_type === "ENUMERATION" ? allowedCodes : null });
      if (!coerced.valid) {
        itemValid = false;
        for (const issue of coerced.issues) {
          const record = { characteristic_id: entry.characteristic_id, code: entry.code, ...issue };
          if (issue.code === "REQUIRED") missingRequired.push(record);
          else invalidValues.push(record);
          errors.push(record);
        }
      }
      if (entry.data_type === "UNIT_NUMERIC" && enforceUnits && valueEntry.value !== null && valueEntry.value !== undefined && valueEntry.value !== "") {
        const providedUnit = valueEntry.unit || entry.unit;
        const conversion = convertValue(Number(valueEntry.value), providedUnit, entry.base_unit || entry.unit, { units, strict: false });
        if (conversion.compatible === false) {
          itemValid = false;
          const record = { characteristic_id: entry.characteristic_id, code: entry.code, code: "UNIT_INCOMPATIBLE", message: `${entry.code} unit ${providedUnit} is not compatible with ${entry.base_unit || entry.unit}`, value: valueEntry.value };
          unitErrors.push(record);
          errors.push(record);
        }
      }
    }
    items.push({
      characteristic_id: entry.characteristic_id,
      code: entry.code,
      origin: entry.origin,
      valid: itemValid,
      value_count: values.length,
      allowed_value_mode: entry.allowed_value_mode,
    });
  }

  const effectiveByCharacteristic = new Map();
  for (const entry of resolved.items) effectiveByCharacteristic.set(Number(entry.characteristic_id), entry);
  for (const issue of evaluateRules(db, tenantId, resolved.chain.map((entry) => entry.id), grouped, effectiveByCharacteristic)) {
    if (issue.severity === "error") errors.push(issue);
    else if (issue.severity === "warning") warnings.push(issue);
  }

  return {
    valid: errors.length === 0,
    class: resolved.class,
    errors,
    warnings,
    missing_required: missingRequired,
    invalid_values: invalidValues,
    unit_errors: unitErrors,
    items,
    evaluated: resolved.items.length,
  };
}

// ── Assignment / object / batch validation ───────────────────────────────────

export function storedValuesForAssignment(db, assignmentId) {
  const rows = queryAll(
    db,
    `SELECT v.*, c.code AS characteristic_code FROM cla_assignment_values v
       JOIN cla_characteristics c ON c.id = v.characteristic_id
      WHERE v.assignment_id = ? AND v.status = 'ACTIVE' ORDER BY v.characteristic_id, v.sequence`,
    [Number(assignmentId)]
  );
  return rows.map((row) => ({ ...publicAssignmentValue(row), characteristic_code: row.characteristic_code }));
}

export function validateAssignmentValues(db, tenantId, assignment, rawValues = null, { partial = false } = {}) {
  const values = rawValues === null || rawValues === undefined ? storedValuesForAssignment(db, assignment.id) : rawValues;
  return validateClassValues(db, tenantId, assignment.class_id, values, { partial });
}

export function getAssignmentForValidation(db, tenantId, assignmentId) {
  const row = queryOne(db, "SELECT * FROM cla_assignments WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(assignmentId)]);
  if (!row) throw validationFailed({ assignment_id: Number(assignmentId), reason: "not found" });
  return row;
}

export function validateObject(db, tenantId, { objectType, objectId }) {
  const assignments = queryAll(
    db,
    "SELECT * FROM cla_assignments WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND status = 'ACTIVE'",
    [Number(tenantId), normalizeText(objectType, { max: 120 }), normalizeText(objectId, { max: 300 })]
  );
  const results = assignments.map((assignment) => ({
    assignment: publicAssignment(assignment),
    validation: validateAssignmentValues(db, tenantId, assignment),
  }));
  const valid = results.every((entry) => entry.validation.valid);
  return {
    object_type: objectType,
    object_id: objectId,
    valid,
    assignment_count: results.length,
    results,
    errors: results.flatMap((entry) => entry.validation.errors),
    warnings: results.flatMap((entry) => entry.validation.warnings),
  };
}

export function validateBatch(db, tenantId, { objectType, objectIds = [] } = {}) {
  const items = [];
  let valid = 0;
  let invalid = 0;
  for (const objectId of objectIds) {
    const result = validateObject(db, tenantId, { objectType, objectId });
    if (result.valid) valid += 1;
    else invalid += 1;
    items.push({ object_id: objectId, valid: result.valid, assignment_count: result.assignment_count, errors: result.errors.length, warnings: result.warnings.length });
  }
  return { object_type: objectType, total: items.length, valid_count: valid, invalid_count: invalid, items };
}
