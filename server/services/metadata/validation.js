import { HttpError } from "../../validation.js";
import { evaluate } from "./expression.js";
import { assertValueInLov, findLov, listValues } from "./lovs.js";
import { applyRules, rulesFor } from "./rules.js";
import { effectiveAttributes, findType } from "./types.js";
import { referencedEntity } from "./attributes.js";

// The metadata validation engine. It turns a loose values object into a typed,
// rule-checked payload without ever trusting the caller or executing rule code.
// Unknown fields are reported (not silently dropped) so metadata changes cannot
// silently break existing data.

const MAX_STRING = 100000;

function issue(field, code, message, severity = "error") {
  return { field, code, message, severity };
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function coerce(db, attribute, raw, tenantId, errors) {
  const field = attribute.code;
  const type = attribute.data_type;
  const validation = attribute.validation || {};

  if (type === "multi_value") {
    let list = raw;
    if (!Array.isArray(list)) {
      if (isBlank(list)) list = [];
      else if (typeof list === "string" && list.includes(",")) list = list.split(",").map((s) => s.trim());
      else list = [list];
    }
    const values = [];
    for (const item of list) {
      if (isBlank(item)) continue;
      if (attribute.lov_id) {
        try {
          values.push(assertValueInLov(db, attribute.lov_id, item, tenantId).code);
        } catch (err) {
          errors.push(issue(field, "lov", err.message));
        }
      } else {
        values.push(String(item));
      }
    }
    if (validation.min_items !== undefined && values.length < validation.min_items) {
      errors.push(issue(field, "min_items", `${field} needs at least ${validation.min_items} values`));
    }
    if (validation.max_items !== undefined && values.length > validation.max_items) {
      errors.push(issue(field, "max_items", `${field} allows at most ${validation.max_items} values`));
    }
    return values;
  }

  if (type === "string") {
    const value = String(raw);
    if (value.length > MAX_STRING) {
      errors.push(issue(field, "too_long", `${field} is too long`));
      return value.slice(0, MAX_STRING);
    }
    if (attribute.min_length !== null && value.length < attribute.min_length) {
      errors.push(issue(field, "min_length", `${field} must be at least ${attribute.min_length} characters`));
    }
    if (attribute.max_length !== null && value.length > attribute.max_length) {
      errors.push(issue(field, "max_length", `${field} must be at most ${attribute.max_length} characters`));
    }
    if (validation.pattern && !new RegExp(validation.pattern).test(value)) {
      errors.push(issue(field, "pattern", validation.message || `${field} has an invalid format`));
    }
    if (attribute.lov_id) {
      try {
        return assertValueInLov(db, attribute.lov_id, value, tenantId).code;
      } catch (err) {
        errors.push(issue(field, "lov", err.message));
      }
    }
    return value;
  }

  if (type === "integer" || type === "decimal") {
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      errors.push(issue(field, "number", `${field} must be a number`));
      return raw;
    }
    if (type === "integer" && !Number.isInteger(num)) {
      errors.push(issue(field, "integer", `${field} must be an integer`));
    }
    if (type === "decimal" && validation.integer && !Number.isInteger(num)) {
      errors.push(issue(field, "integer", `${field} must be a whole number`));
    }
    if (attribute.min_value !== null && num < attribute.min_value) {
      errors.push(issue(field, "min_value", `${field} must be at least ${attribute.min_value}`));
    }
    if (attribute.max_value !== null && num > attribute.max_value) {
      errors.push(issue(field, "max_value", `${field} must be at most ${attribute.max_value}`));
    }
    if (type === "decimal" && Number.isInteger(validation.scale) && validation.scale >= 0) {
      const decimals = (String(num).split(".")[1] || "").length;
      if (decimals > validation.scale) {
        errors.push(issue(field, "scale", `${field} allows at most ${validation.scale} decimal places`));
      }
    }
    return num;
  }

  if (type === "boolean") {
    if (raw === true || raw === 1 || raw === "1" || raw === "true") return true;
    if (raw === false || raw === 0 || raw === "0" || raw === "false") return false;
    errors.push(issue(field, "boolean", `${field} must be true or false`));
    return raw;
  }

  if (type === "date") {
    const value = String(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
      errors.push(issue(field, "date", `${field} must be a valid date (YYYY-MM-DD)`));
    }
    return value;
  }

  if (type === "datetime") {
    const value = String(raw);
    if (Number.isNaN(Date.parse(value))) {
      errors.push(issue(field, "datetime", `${field} must be a valid date-time`));
    }
    return value;
  }

  if (type === "reference") {
    const refType = validation.reference_type;
    if (!refType) {
      errors.push(issue(field, "reference", `${field} is missing its reference_type configuration`));
      return raw;
    }
    const entity = referencedEntity(db, refType, raw);
    if (!entity) {
      errors.push(issue(field, "reference", `${field} references an unknown ${refType}`));
    }
    return raw;
  }

  return raw;
}

// Validates and normalizes a values object for a type (optionally using a form
// for conditional behaviour). Returns errors/warnings plus normalized values,
// applied defaults and the list of attributes that participated.
export function validateRecord(db, input, tenantId) {
  const values = input?.values || {};
  if (typeof values !== "object" || Array.isArray(values)) {
    throw new HttpError(400, "values must be an object");
  }
  const typeRef = input.typeId ?? input.type_id ?? input.type;
  if (typeRef === undefined || typeRef === null || typeRef === "") {
    throw new HttpError(400, "typeId is required to validate a record");
  }
  const typeRow = findType(db, typeRef, tenantId);
  if (!typeRow) throw new HttpError(404, "Type not found");
  const attributes = effectiveAttributes(db, typeRow.id, tenantId);
  const byCode = new Map(attributes.map((a) => [a.code, a]));
  const errors = [];
  const warnings = [];
  const normalized = {};
  const defaultsApplied = {};

  const context = {
    values,
    record: values,
    user: input.user || null,
    organization: input.organization || null,
    type: { id: typeRow.id, code: typeRow.code },
    ...(input.context || {}),
  };

  // 1. Rule-driven defaults / required / visibility first, so validation sees
  //    the effective shape of the record.
  const ruleResult = applyRules(db, { typeId: typeRow.id, formId: input.formId ?? input.form_id, values, context }, tenantId);
  const working = ruleResult.values;

  for (const attribute of attributes) {
    const required = ruleResult.required[attribute.code] !== undefined
      ? ruleResult.required[attribute.code]
      : Boolean(attribute.required);
    const raw = working[attribute.code];
    if (isBlank(raw)) {
      if (!isBlank(attribute.default_value)) {
        normalized[attribute.code] = attribute.multi_value
          ? String(attribute.default_value).split(",").map((s) => s.trim()).filter(Boolean)
          : attribute.default_value;
        defaultsApplied[attribute.code] = true;
        continue;
      }
      if (required) {
        const visible = ruleResult.visibility[attribute.code] !== false && attribute.visible !== false;
        if (visible) errors.push(issue(attribute.code, "required", `${attribute.name} is required`));
      }
      continue;
    }
    normalized[attribute.code] = coerce(db, attribute, raw, tenantId, errors);
  }

  // 2. Reject unknown fields explicitly.
  for (const key of Object.keys(working)) {
    if (!byCode.has(key) && !key.startsWith("__")) {
      errors.push(issue(key, "unknown_field", `Unknown attribute "${key}" for type ${typeRow.code}`));
    }
  }

  // 3. Validation rules.
  for (const rule of rulesFor(db, { typeId: typeRow.id, formId: input.formId ?? input.form_id }, tenantId)) {
    if (rule.category !== "validation") continue;
    const condition = rule.condition || {};
    const matched = !Object.keys(condition).length
      ? true
      : evaluate(condition, { ...context, values: normalized, record: normalized });
    if (!matched) continue;
    const actions = rule.actions.length ? rule.actions : [{ type: "error", field: rule.target_field, message: rule.description }];
    for (const action of actions) {
      const severity = action.type === "warn" ? "warning" : "error";
      const message = action.message || action.value || rule.description || `Rule ${rule.code} failed`;
      const field = action.field || rule.target_field || "";
      const entry = issue(field, rule.code, message, severity);
      if (severity === "warning") warnings.push(entry);
      else errors.push(entry);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    values: normalized,
    defaults: defaultsApplied,
    visibility: ruleResult.visibility,
    editability: ruleResult.editability,
    required: ruleResult.required,
    type: { id: typeRow.id, code: typeRow.code, name: typeRow.name },
  };
}

// Convenience guard for modules that mutate metadata-backed records.
export function assertValidRecord(db, input, tenantId) {
  const result = validateRecord(db, input, tenantId);
  if (!result.valid) {
    throw new HttpError(422, "Metadata validation failed", result.errors);
  }
  return result;
}

// Exposes the resolved, effective field contract for a type (used by other
// modules that render or serialize records without a form).
export function attributeContract(db, idOrCode, tenantId) {
  const type = findType(db, idOrCode, tenantId);
  return effectiveAttributes(db, type.id, tenantId).map((a) => ({
    code: a.code,
    name: a.name,
    data_type: a.data_type,
    required: Boolean(a.required),
    multi_value: Boolean(a.multi_value),
    default: a.default_value,
    min_length: a.min_length,
    max_length: a.max_length,
    min_value: a.min_value,
    max_value: a.max_value,
    validation: a.validation || {},
    lov_id: a.lov_id,
    lov_values: a.lov_id
      ? listValues(db, a.lov_id, { activeOnly: true }).map((v) => ({ code: v.code, label: v.label }))
      : [],
  }));
}

export { findLov };
