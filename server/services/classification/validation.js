// Normalization, assertion and vocabulary helpers for the Enterprise
// Classification Framework. Pure helpers are reused from the Import & Export
// Framework so there is exactly one implementation on the platform.
import { HttpError } from "../../validation.js";
import {
  normalizeText,
  normalizeUpper,
  normalizeLower,
  parseJson,
  parseObject,
  parseArray,
  toBool,
  toNumber,
  toInt,
  paginate,
  sortParams,
  requireCode,
  requireName,
  assertEnum,
  assertTenantId,
} from "../data-exchange/validation.js";
import {
  CLASSIFICATION_STATUSES,
  CLASS_STATUSES,
  APPROVAL_STATUSES,
  CHARACTERISTIC_DATA_TYPES,
  CHARACTERISTIC_STATUSES,
  CHARACTERISTIC_ORIGINS,
  ALLOWED_VALUE_MODES,
  RULE_TYPES,
  RULE_SEVERITIES,
  ASSIGNMENT_STATUSES,
  NUMERIC_DATA_TYPES,
  CONFIG_DEFAULTS,
  CONFIG_BOUNDS,
} from "./constants.js";
import {
  invalidClassification,
  invalidClass,
  invalidCharacteristic,
  invalidGroup,
  invalidAllowedValue,
  invalidAssignment,
  invalidValue,
  invalidRule,
  invalidConfiguration,
} from "./errors.js";

export {
  normalizeText,
  normalizeUpper,
  normalizeLower,
  parseJson,
  parseObject,
  parseArray,
  toBool,
  toNumber,
  toInt,
  paginate,
  sortParams,
  requireCode,
  requireName,
  assertEnum,
  assertTenantId,
  HttpError,
};

export const assertClassificationStatus = (value) =>
  assertEnum(normalizeUpper(value), CLASSIFICATION_STATUSES, "Classification status", invalidClassification);
export const assertClassStatus = (value) =>
  assertEnum(normalizeUpper(value), CLASS_STATUSES, "Class status", invalidClass);
export const assertApprovalStatus = (value) =>
  assertEnum(normalizeUpper(value), APPROVAL_STATUSES, "Approval status", invalidClassification);
export const assertCharacteristicStatus = (value) =>
  assertEnum(normalizeUpper(value), CHARACTERISTIC_STATUSES, "Characteristic status", invalidCharacteristic);
export const assertDataType = (value) =>
  assertEnum(normalizeUpper(value), CHARACTERISTIC_DATA_TYPES, "Characteristic data type", invalidCharacteristic);
export const assertOrigin = (value) =>
  assertEnum(normalizeUpper(value), CHARACTERISTIC_ORIGINS, "Characteristic origin", invalidClass);
export const assertAllowedValueMode = (value) =>
  assertEnum(normalizeUpper(value), ALLOWED_VALUE_MODES, "Allowed value mode", invalidClass);
export const assertRuleType = (value) =>
  assertEnum(normalizeUpper(value), RULE_TYPES, "Classification rule type", invalidRule);
export const assertSeverity = (value) =>
  assertEnum(normalizeUpper(value), RULE_SEVERITIES, "Rule severity", invalidRule);
export const assertAssignmentStatus = (value) =>
  assertEnum(normalizeUpper(value), ASSIGNMENT_STATUSES, "Assignment status", invalidAssignment);

export const isNumericType = (dataType) => NUMERIC_DATA_TYPES.includes(String(dataType || "").toUpperCase());
export const isUnitType = (dataType) => String(dataType || "").toUpperCase() === "UNIT_NUMERIC";

// ── Characteristic input ─────────────────────────────────────────────────────

export function normalizeCharacteristicInput(body = {}, current = {}) {
  const dataType = assertDataType(body.data_type ?? body.dataType ?? current.data_type ?? "STRING");
  if (!requireCode(body.code ?? current.code)) throw invalidCharacteristic("Characteristic code is required");
  const numeric = isNumericType(dataType);
  const unit = normalizeText(body.unit ?? current.unit ?? "", { max: 60 });
  const baseUnit = normalizeText(body.base_unit ?? body.baseUnit ?? current.base_unit ?? unit, { max: 60 });
  const result = {
    code: normalizeUpper(body.code ?? current.code),
    name: normalizeText(body.name ?? current.name ?? body.code, { max: 200 }) || normalizeUpper(body.code ?? current.code),
    description: normalizeText(body.description ?? current.description ?? "", { max: 2000 }),
    data_type: dataType,
    unit: unit || "",
    base_unit: baseUnit || "",
    precision: body.precision === undefined ? current.precision ?? null : optionalInt(body.precision, "precision", 0, 15),
    scale: body.scale === undefined ? current.scale ?? null : optionalInt(body.scale, "scale", 0, 15),
    min_value: body.min_value === undefined && body.minValue === undefined ? current.min_value ?? null : optionalNumber(body.min_value ?? body.minValue, "min_value"),
    max_value: body.max_value === undefined && body.maxValue === undefined ? current.max_value ?? null : optionalNumber(body.max_value ?? body.maxValue, "max_value"),
    min_inclusive: toBool(body.min_inclusive ?? body.minInclusive ?? current.min_inclusive, true),
    max_inclusive: toBool(body.max_inclusive ?? body.maxInclusive ?? current.max_inclusive, true),
    default_value: normalizeText(body.default_value ?? body.defaultValue ?? current.default_value ?? "", { max: 500 }),
    multi_valued: toBool(body.multi_valued ?? body.multiValued ?? current.multi_valued, false),
    searchable: toBool(body.searchable ?? current.searchable, true),
    required: toBool(body.required ?? current.required, false),
    reference_type: normalizeText(body.reference_type ?? body.referenceType ?? current.reference_type ?? "", { max: 120 }),
    status: assertCharacteristicStatus(body.status ?? current.status ?? "ACTIVE"),
    metadata: parseObject(body.metadata ?? current.metadata_json, {}),
  };
  if (result.min_value !== null && result.max_value !== null && Number(result.min_value) > Number(result.max_value)) {
    throw invalidCharacteristic("min_value cannot exceed max_value");
  }
  if (result.scale !== null && result.precision !== null && Number(result.scale) > Number(result.precision)) {
    throw invalidCharacteristic("scale cannot exceed precision");
  }
  if (!numeric && (result.min_value !== null || result.max_value !== null)) {
    throw invalidCharacteristic("min_value/max_value only apply to numeric characteristics");
  }
  if (isUnitType(dataType) && !result.unit) {
    throw invalidCharacteristic("A unit-based numeric characteristic requires a unit");
  }
  if (dataType === "REFERENCE" && !result.reference_type) {
    throw invalidCharacteristic("A reference characteristic requires a reference_type");
  }
  return result;
}

function optionalInt(value, name, min, max) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw invalidCharacteristic(`${name} must be an integer between ${min} and ${max}`);
  return n;
}

function optionalNumber(value, name) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw invalidCharacteristic(`${name} must be a number`);
  return n;
}

// ── Value coercion and validation (the reusable validation contract) ─────────

// Coerces a raw client value to the characteristic's canonical representation
// and returns validation issues. Never trusts the client: bounds, type, unit and
// allowed-value checks all happen server-side.
export function coerceCharacteristicValue(characteristic, rawValue, { allowedCodes = null, unit = null } = {}) {
  const dataType = String(characteristic.data_type || "STRING").toUpperCase();
  const issues = [];
  const result = {
    value_text: "",
    value_number: null,
    value_boolean: null,
    value_date: null,
    value_reference: "",
    unit: unit != null ? normalizeText(unit, { max: 60 }) : normalizeText(characteristic.unit || "", { max: 60 }),
    normalized_value: null,
    normalized_unit: normalizeText(characteristic.base_unit || characteristic.unit || "", { max: 60 }),
  };

  if (rawValue === null || rawValue === undefined || rawValue === "") {
    if (characteristic.required) issues.push({ code: "REQUIRED", message: `${characteristic.name || characteristic.code} is required`, characteristic_id: characteristic.id });
    return { ...result, valid: issues.length === 0, issues };
  }

  const text = typeof rawValue === "object" && rawValue !== null ? rawValue.value ?? "" : rawValue;

  if (isNumericType(dataType)) {
    const n = Number(text);
    if (!Number.isFinite(n)) {
      issues.push({ code: "TYPE", message: `${characteristic.code} must be a number`, value: text });
      return { ...result, valid: false, issues };
    }
    if (characteristic.min_value !== null && characteristic.min_value !== undefined) {
      const fail = Boolean(characteristic.min_inclusive) ? n < Number(characteristic.min_value) : n <= Number(characteristic.min_value);
      if (fail) issues.push({ code: "MIN", message: `${characteristic.code} must be ${characteristic.min_inclusive ? ">=" : ">"} ${characteristic.min_value}`, value: n });
    }
    if (characteristic.max_value !== null && characteristic.max_value !== undefined) {
      const fail = Boolean(characteristic.max_inclusive) ? n > Number(characteristic.max_value) : n >= Number(characteristic.max_value);
      if (fail) issues.push({ code: "MAX", message: `${characteristic.code} must be ${characteristic.max_inclusive ? "<=" : "<"} ${characteristic.max_value}`, value: n });
    }
    if (characteristic.scale !== null && characteristic.scale !== undefined) {
      const decimals = (String(n).split(".")[1] || "").length;
      if (decimals > Number(characteristic.scale)) {
        issues.push({ code: "SCALE", message: `${characteristic.code} allows at most ${characteristic.scale} decimal place(s)`, value: n });
      }
    }
    result.value_number = n;
    result.value_text = String(n);
    result.normalized_value = n;
    return { ...result, valid: issues.length === 0, issues };
  }

  if (dataType === "BOOLEAN") {
    const parsed = String(text).toLowerCase();
    if (!["true", "false", "1", "0", "yes", "no"].includes(parsed)) {
      issues.push({ code: "TYPE", message: `${characteristic.code} must be a boolean`, value: text });
      return { ...result, valid: false, issues };
    }
    const bool = ["true", "1", "yes"].includes(parsed);
    result.value_boolean = bool;
    result.value_text = String(bool);
    return { ...result, valid: true, issues };
  }

  if (dataType === "DATE" || dataType === "DATETIME") {
    const normalized = normalizeDate(text, dataType === "DATETIME");
    if (!normalized) {
      issues.push({ code: "TYPE", message: `${characteristic.code} must be a valid ${dataType.toLowerCase()}`, value: text });
      return { ...result, valid: false, issues };
    }
    result.value_date = normalized;
    result.value_text = normalized;
    return { ...result, valid: true, issues };
  }

  if (dataType === "ENUMERATION") {
    const code = normalizeUpper(text);
    if (allowedCodes && !allowedCodes.includes(code)) {
      issues.push({ code: "ENUM", message: `${characteristic.code} must be one of the allowed values`, value: text, allowed: allowedCodes });
      return { ...result, valid: false, issues };
    }
    result.value_text = code;
    return { ...result, valid: true, issues };
  }

  if (dataType === "REFERENCE") {
    result.value_reference = normalizeText(text, { max: 300 });
    result.value_text = result.value_reference;
    return { ...result, valid: true, issues };
  }

  const maxLen = 2000;
  result.value_text = normalizeText(text, { max: maxLen });
  return { ...result, valid: issues.length === 0, issues };
}

function normalizeDate(value, withTime) {
  const text = normalizeText(value, { max: 40 });
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if (!match) {
    const parsed = Date.parse(text);
    if (Number.isNaN(parsed)) return null;
    const iso = new Date(parsed).toISOString();
    return withTime ? iso : iso.slice(0, 10);
  }
  const [, y, m, d, hh = "00", mm = "00", ss = "00"] = match;
  return withTime ? `${y}-${m}-${d}T${hh}:${mm}:${ss}` : `${y}-${m}-${d}`;
}

// ── Configuration ────────────────────────────────────────────────────────────

export function assertConfigurationValue(key, value) {
  if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)) {
    throw invalidConfiguration(`Unknown configuration key: ${key}`, { key, allowed: Object.keys(CONFIG_DEFAULTS) });
  }
  const fallback = CONFIG_DEFAULTS[key];
  if (typeof fallback === "boolean") return toBool(value, fallback);
  if (typeof fallback === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw invalidConfiguration(`${key} must be a number`, { key });
    const bounds = CONFIG_BOUNDS[key];
    if (bounds && (n < bounds.min || n > bounds.max)) {
      throw invalidConfiguration(`${key} must be between ${bounds.min} and ${bounds.max}`, { key, min: bounds.min, max: bounds.max, value: n });
    }
    return n;
  }
  if (typeof fallback === "string") {
    const text = normalizeText(value, { max: 200 });
    if (!text) throw invalidConfiguration(`${key} must be a non-empty string`, { key });
    return text;
  }
  return value;
}

export function vocabulary() {
  return {
    classification_statuses: CLASSIFICATION_STATUSES,
    class_statuses: CLASS_STATUSES,
    approval_statuses: APPROVAL_STATUSES,
    characteristic_data_types: CHARACTERISTIC_DATA_TYPES,
    characteristic_statuses: CHARACTERISTIC_STATUSES,
    characteristic_origins: CHARACTERISTIC_ORIGINS,
    allowed_value_modes: ALLOWED_VALUE_MODES,
    rule_types: RULE_TYPES,
    rule_severities: RULE_SEVERITIES,
    assignment_statuses: ASSIGNMENT_STATUSES,
  };
}

export function publicError(error) {
  if (!error) return null;
  return { error: error.message, code: error.code || null, details: error.details || null };
}

// Builds a safe ORDER BY fragment. The column is restricted to an allow-list so
// a client can never inject SQL through the sort parameter.
export function orderClause(sort, { allowed = [], default: fallback = "id", direction = "DESC" } = {}) {
  const column = allowed.includes(String(sort)) ? String(sort) : fallback;
  const dir = String(direction).toUpperCase() === "ASC" ? "ASC" : "DESC";
  return { clause: `${column} ${dir}`, params: [] };
}
