import { HttpError } from "../../validation.js";

// Validation helpers shared by objects, relationship types and references. The
// object attribute payload itself is validated by the metadata engine; this file
// covers the generic contracts owned by the Object & Relationship Framework:
// relationship-type attribute definitions and their instance values.

export const OBJECT_STATUSES = ["draft", "active", "released", "obsolete", "archived"];
export const RELATIONSHIP_STATUSES = ["draft", "active", "inactive", "expired"];
export const EDGE_STATUSES = RELATIONSHIP_STATUSES;
export const CARDINALITIES = ["1:1", "1:N", "N:1", "N:N"];
export const SEMANTICS = ["association", "aggregation", "composition"];
export const REFERENCE_TYPES = ["strong", "weak", "external"];
export const EDGE_DATA_TYPES = [
  "string",
  "integer",
  "decimal",
  "boolean",
  "date",
  "datetime",
  "reference",
  "multi_value",
];

const MAX_STRING = 100000;
const DEFINITION_KEYS = [
  "code",
  "name",
  "description",
  "data_type",
  "required",
  "default_value",
  "min_length",
  "max_length",
  "min_value",
  "max_value",
  "multi_value",
  "validation",
];
const VALIDATION_KEYS = ["pattern", "message", "min_items", "max_items", "integer", "scale"];

function isBlank(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function assertObject(value, message) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, message);
  }
}

// Validates and normalizes the inline attribute contract stored on a
// relationship type (`attributes_json`). Definitions are intentionally a
// metadata-compatible subset, so they can be promoted to full attributes later.
export function normalizeEdgeDefinitions(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "relationship attributes must be a JSON array");
    }
  }
  if (!Array.isArray(parsed)) throw new HttpError(400, "relationship attributes must be a JSON array");
  const seen = new Set();
  return parsed.map((definition, index) => {
    assertObject(definition, `relationship attribute #${index + 1} must be an object`);
    for (const key of Object.keys(definition)) {
      if (!DEFINITION_KEYS.includes(key)) {
        throw new HttpError(400, `Unsupported relationship attribute key: ${key}`);
      }
    }
    if (!definition.code || !/^[a-z][a-z0-9._-]{1,63}$/.test(definition.code)) {
      throw new HttpError(400, `relationship attribute code "${definition.code}" is invalid`);
    }
    if (seen.has(definition.code)) {
      throw new HttpError(400, `Duplicate relationship attribute code: ${definition.code}`);
    }
    seen.add(definition.code);
    const dataType = definition.data_type || "string";
    if (!EDGE_DATA_TYPES.includes(dataType)) {
      throw new HttpError(400, `relationship attribute ${definition.code} has unknown data_type`);
    }
    const validation = definition.validation || {};
    assertObject(validation, `validation for ${definition.code} must be an object`);
    for (const key of Object.keys(validation)) {
      if (!VALIDATION_KEYS.includes(key)) {
        throw new HttpError(400, `Unsupported validation key "${key}" for ${definition.code}`);
      }
    }
    if (validation.pattern !== undefined) {
      if (typeof validation.pattern !== "string" || validation.pattern.length > 200) {
        throw new HttpError(400, `validation.pattern for ${definition.code} must be up to 200 chars`);
      }
      try {
        new RegExp(validation.pattern);
      } catch {
        throw new HttpError(400, `validation.pattern for ${definition.code} is not a valid regex`);
      }
    }
    return {
      code: definition.code,
      name: definition.name || definition.code,
      description: definition.description || "",
      data_type: dataType,
      required: definition.required === true,
      default_value: definition.default_value === undefined || definition.default_value === null
        ? ""
        : String(definition.default_value),
      min_length: definition.min_length ?? null,
      max_length: definition.max_length ?? null,
      min_value: definition.min_value ?? null,
      max_value: definition.max_value ?? null,
      multi_value: dataType === "multi_value" || definition.multi_value === true,
      validation,
    };
  });
}

function coerceEdgeValue(definition, raw, errors) {
  const field = definition.code;
  const type = definition.data_type;
  const validation = definition.validation || {};

  if (type === "multi_value") {
    let list = raw;
    if (!Array.isArray(list)) {
      if (isBlank(list)) list = [];
      else if (typeof list === "string" && list.includes(",")) list = list.split(",").map((s) => s.trim());
      else list = [list];
    }
    const values = list.filter((item) => !isBlank(item)).map(String);
    if (validation.min_items !== undefined && values.length < validation.min_items) {
      errors.push({ field, code: "min_items", message: `${field} needs at least ${validation.min_items} values` });
    }
    if (validation.max_items !== undefined && values.length > validation.max_items) {
      errors.push({ field, code: "max_items", message: `${field} allows at most ${validation.max_items} values` });
    }
    return values;
  }

  if (type === "integer" || type === "decimal") {
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      errors.push({ field, code: "number", message: `${field} must be a number` });
      return raw;
    }
    if (type === "integer" && !Number.isInteger(num)) {
      errors.push({ field, code: "integer", message: `${field} must be an integer` });
    }
    if (definition.min_value !== null && num < definition.min_value) {
      errors.push({ field, code: "min_value", message: `${field} must be at least ${definition.min_value}` });
    }
    if (definition.max_value !== null && num > definition.max_value) {
      errors.push({ field, code: "max_value", message: `${field} must be at most ${definition.max_value}` });
    }
    if (type === "decimal" && Number.isInteger(validation.scale) && validation.scale >= 0) {
      const decimals = (String(num).split(".")[1] || "").length;
      if (decimals > validation.scale) {
        errors.push({ field, code: "scale", message: `${field} allows at most ${validation.scale} decimals` });
      }
    }
    return num;
  }

  if (type === "boolean") {
    if (raw === true || raw === 1 || raw === "1" || raw === "true") return true;
    if (raw === false || raw === 0 || raw === "0" || raw === "false") return false;
    errors.push({ field, code: "boolean", message: `${field} must be true or false` });
    return raw;
  }

  if (type === "date") {
    const value = String(raw);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
      errors.push({ field, code: "date", message: `${field} must be a valid date (YYYY-MM-DD)` });
    }
    return value;
  }

  if (type === "datetime") {
    const value = String(raw);
    if (Number.isNaN(Date.parse(value))) {
      errors.push({ field, code: "datetime", message: `${field} must be a valid date-time` });
    }
    return value;
  }

  const value = String(raw);
  if (value.length > MAX_STRING) {
    errors.push({ field, code: "too_long", message: `${field} is too long` });
    return value.slice(0, MAX_STRING);
  }
  if (definition.min_length !== null && value.length < definition.min_length) {
    errors.push({ field, code: "min_length", message: `${field} must be at least ${definition.min_length} characters` });
  }
  if (definition.max_length !== null && value.length > definition.max_length) {
    errors.push({ field, code: "max_length", message: `${field} must be at most ${definition.max_length} characters` });
  }
  if (validation.pattern && !new RegExp(validation.pattern).test(value)) {
    errors.push({ field, code: "pattern", message: validation.message || `${field} has an invalid format` });
  }
  return value;
}

// Validates an edge/relationship attribute payload against its inline contract.
// Unknown keys are reported rather than dropped, mirroring the metadata engine.
export function validateEdgeValues(definitions, raw = {}) {
  assertObject(raw, "attributes must be an object");
  const byCode = new Map(definitions.map((d) => [d.code, d]));
  const errors = [];
  const normalized = {};
  for (const definition of definitions) {
    const value = raw[definition.code];
    if (isBlank(value)) {
      if (!isBlank(definition.default_value)) {
        normalized[definition.code] = definition.multi_value
          ? String(definition.default_value).split(",").map((s) => s.trim()).filter(Boolean)
          : definition.default_value;
        continue;
      }
      if (definition.required) {
        errors.push({ field: definition.code, code: "required", message: `${definition.name} is required` });
      }
      continue;
    }
    normalized[definition.code] = coerceEdgeValue(definition, value, errors);
  }
  for (const key of Object.keys(raw)) {
    if (!byCode.has(key)) {
      errors.push({ field: key, code: "unknown_field", message: `Unknown relationship attribute "${key}"` });
    }
  }
  return { valid: errors.length === 0, errors, values: normalized };
}

export function assertValidEdgeValues(definitions, values) {
  const result = validateEdgeValues(definitions, values);
  if (!result.valid) throw new HttpError(422, "Relationship validation failed", result.errors);
  return result.values;
}

export function normalizeTags(raw) {
  if (raw === undefined || raw === null || raw === "") return [];
  let list = raw;
  if (typeof raw === "string") {
    list = raw.startsWith("[") ? safeParse(raw, []) : raw.split(",");
  }
  if (!Array.isArray(list)) throw new HttpError(400, "tags must be an array of strings");
  const tags = [...new Set(list.map((t) => String(t).trim()).filter(Boolean))];
  if (tags.length > 50) throw new HttpError(400, "At most 50 tags are allowed");
  return tags;
}

export function assertStatus(status, allowed, message) {
  if (!allowed.includes(status)) {
    throw new HttpError(400, `${message}: ${allowed.join(", ")}`);
  }
  return status;
}

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
