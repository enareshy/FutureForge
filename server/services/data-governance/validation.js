// Shared normalization, parsing and assertion helpers for the Data Governance
// & Data Quality service. Pure functions only: no database access, so they can
// be unit tested in isolation and reused by the rule validator.
import { HttpError } from "../../validation.js";
import {
  DOMAIN_STATUSES,
  OWNERSHIP_RELATIONSHIPS,
  OWNERSHIP_SCOPES,
  POLICY_STATUSES,
  RULE_STATUSES,
  RULE_TYPES,
  EXECUTION_MODES,
  EXCEPTION_STATUSES,
  EXCEPTION_PRIORITIES,
  DUPLICATE_STRATEGIES,
  SUBJECT_TYPES,
  SEVERITIES,
  QUALITY_DIMENSIONS,
  OPERATORS,
} from "./constants.js";
import { invalidDomain, invalidOwnership, invalidPolicy, invalidRule, invalidExceptionTransition, invalidConfiguration } from "./errors.js";

export function normalizeText(value, { max = 2000 } = {}) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, max);
}

export function normalizeUpper(value, { max = 64 } = {}) {
  return normalizeText(value, { max }).toUpperCase();
}

export function normalizeLower(value, { max = 64 } = {}) {
  return normalizeText(value, { max }).toLowerCase();
}

export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

export function parseObject(value, fallback = {}) {
  const parsed = parseJson(value, fallback);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
}

export function parseArray(value, fallback = []) {
  const parsed = parseJson(value, fallback);
  return Array.isArray(parsed) ? parsed : fallback;
}

export function toBool(value, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function toInt(value, fallback = null) {
  const n = toNumber(value, null);
  return n === null ? fallback : Math.trunc(n);
}

export function paginate(query = {}, { defaultPageSize = 100, maxPageSize = 500 } = {}) {
  const page = Math.max(1, toInt(query.page, 1) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, toInt(query.pageSize ?? query.page_size, defaultPageSize) || defaultPageSize));
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

export function requireCode(value, label = "Code") {
  const code = normalizeUpper(value);
  if (!/^[A-Z][A-Z0-9_.-]{1,63}$/.test(code)) {
    throw new HttpError(400, `${label} must be 2-64 uppercase letters, digits, . _ - and start with a letter`);
  }
  return code;
}

export function assertEnum(value, allowed, label, errorFactory) {
  if (!allowed.includes(value)) {
    const message = `${label} must be one of: ${allowed.join(", ")}`;
    if (errorFactory) throw errorFactory(message);
    throw new HttpError(400, message);
  }
  return value;
}

export const assertDomainStatus = (value) => assertEnum(value, DOMAIN_STATUSES, "Domain status", invalidDomain);
export const assertPolicyStatus = (value) => assertEnum(value, POLICY_STATUSES, "Policy status", invalidPolicy);
export const assertRuleStatus = (value) => assertEnum(value, RULE_STATUSES, "Rule status", invalidRule);
export const assertRuleType = (value) => assertEnum(value, RULE_TYPES, "Rule type", invalidRule);
export const assertSeverity = (value) => assertEnum(value, SEVERITIES, "Severity", invalidRule);
export const assertExecutionMode = (value) => assertEnum(value, EXECUTION_MODES, "Execution mode", invalidRule);
export const assertDimension = (value) => assertEnum(value, QUALITY_DIMENSIONS, "Quality dimension", invalidRule);
export const assertPriority = (value) => assertEnum(value, EXCEPTION_PRIORITIES, "Priority", invalidExceptionTransition);
export const assertExceptionStatus = (value) => assertEnum(value, EXCEPTION_STATUSES, "Exception status", invalidExceptionTransition);
export const assertDuplicateStrategy = (value) => assertEnum(value, DUPLICATE_STRATEGIES, "Duplicate strategy", invalidRule);
export const assertSubjectType = (value) => assertEnum(value, SUBJECT_TYPES, "Subject type", invalidOwnership);
export const assertRelationship = (value) => assertEnum(value, OWNERSHIP_RELATIONSHIPS, "Relationship", invalidOwnership);
export const assertScopeType = (value) => assertEnum(value, OWNERSHIP_SCOPES, "Scope type", invalidOwnership);

// Ranking used by dashboards and to decide whether a violation warrants an
// exception. Higher is more severe.
export function severityRank(severity) {
  const order = { info: 1, warning: 2, error: 3, critical: 4 };
  return order[String(severity || "").toLowerCase()] || 0;
}

// Reads a (possibly nested, dot separated) attribute from an object payload.
export function readAttribute(source, path) {
  if (!path) return undefined;
  if (source === null || source === undefined) return undefined;
  // Prefer an exact (flat) key so attributes whose names legitimately contain a
  // dot, e.g. "part.number", resolve against flat payloads as stored by the
  // Object framework and referenced by JSON1 duplicate matching.
  if (typeof source === "object" && Object.prototype.hasOwnProperty.call(source, path)) {
    return source[path];
  }
  const parts = String(path).split(".");
  let current = source;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
    } else if (typeof current === "object") {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

export function valuePreview(value, max = 500) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value).slice(0, max);
    } catch {
      return String(value).slice(0, max);
    }
  }
  return String(value).slice(0, max);
}

export function validateConfigurationValue(key, value) {
  if (key === "status_thresholds") {
    if (!Array.isArray(value) || !value.length) throw invalidConfiguration("status_thresholds must be a non-empty array");
    for (const entry of value) {
      if (typeof entry.min !== "number" || !entry.status) throw invalidConfiguration("Each threshold needs a status and numeric min");
    }
  }
  if (key === "dimension_weights") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidConfiguration("dimension_weights must be an object");
  }
  if (key === "duplicate_threshold") {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw invalidConfiguration("duplicate_threshold must be between 0 and 1");
  }
  if (key === "history_retention_days") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw invalidConfiguration("history_retention_days must be a positive integer");
  }
  return value;
}

export function assertTenantId(tenantId) {
  const n = Number(tenantId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, "A valid tenant is required for this operation");
  }
  return n;
}

// Vocabulary surfaced by the REST /meta endpoints and the SDK so a UI can build
// pickers without hardcoding values.
export function vocabulary() {
  return {
    domain_statuses: DOMAIN_STATUSES,
    policy_statuses: POLICY_STATUSES,
    rule_statuses: RULE_STATUSES,
    rule_types: RULE_TYPES,
    dimensions: QUALITY_DIMENSIONS,
    severities: SEVERITIES,
    priority: EXCEPTION_PRIORITIES,
    exception_statuses: EXCEPTION_STATUSES,
    execution_modes: EXECUTION_MODES,
    duplicate_strategies: DUPLICATE_STRATEGIES,
    operators: OPERATORS,
    ownership_scopes: OWNERSHIP_SCOPES,
    ownership_relationships: OWNERSHIP_RELATIONSHIPS,
    subject_types: SUBJECT_TYPES,
  };
}
