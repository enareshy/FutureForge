// Shared normalization, parsing, date math and assertion helpers for the Data
// Lifecycle & Archival service. Pure functions only: no database access, so they
// can be unit-tested in isolation and reused by the REST layer, the resolver and
// the jobs.
import { HttpError } from "../../validation.js";
import {
  LIFECYCLE_STATES,
  DATA_TIERS,
  RETENTION_BASES,
  POLICY_SCOPE_TYPES,
  POLICY_STATUSES,
  POLICY_ACTIONS,
  LEGAL_HOLD_STATUSES,
  LEGAL_HOLD_SCOPE_TYPES,
  ELIGIBILITY_ACTIONS,
  ELIGIBILITY_RESULTS,
  DEPENDENCY_RESULTS,
  RESTORE_CONFLICT_STRATEGIES,
  ARCHIVE_PROVIDER_TYPES,
  LIFECYCLE_ACTIONS,
  DEFAULT_TRANSITIONS,
  DAY_MS,
  MAX_POLICY_PRIORITY,
} from "./constants.js";
import {
  invalidState,
  invalidPolicy,
  invalidLegalHold,
  invalidEligibility,
  invalidRestore,
  invalidTier,
  invalidConfiguration,
} from "./errors.js";

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

export function toIntOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
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

export function requireName(value, label = "Name") {
  const name = normalizeText(value, { max: 200 });
  if (!name) throw new HttpError(400, `${label} is required`);
  return name;
}

export function assertEnum(value, allowed, label, errorFactory) {
  if (!allowed.includes(value)) {
    const message = `${label} must be one of: ${allowed.join(", ")}`;
    if (errorFactory) throw errorFactory(message);
    throw new HttpError(400, message);
  }
  return value;
}

export const assertStateCode = (value) => assertEnum(normalizeUpper(value), LIFECYCLE_STATES, "Lifecycle state", invalidState);
export const assertCustomState = (value) => {
  const code = normalizeUpper(value);
  if (code.length < 2) throw invalidState("Lifecycle state code is required");
  return code;
};
export const assertDataTier = (value) => assertEnum(normalizeUpper(value), DATA_TIERS, "Data tier", invalidTier);
export const assertRetentionBasis = (value) => assertEnum(normalizeUpper(value), RETENTION_BASES, "Retention basis", invalidPolicy);
export const assertPolicyScope = (value) => assertEnum(normalizeUpper(value), POLICY_SCOPE_TYPES, "Policy scope", invalidPolicy);
export const assertPolicyStatus = (value) => assertEnum(normalizeLower(value), POLICY_STATUSES, "Policy status", invalidPolicy);
export const assertPolicyAction = (value) => assertEnum(normalizeUpper(value), POLICY_ACTIONS, "Policy action", invalidPolicy);
export const assertLegalHoldStatus = (value) => assertEnum(normalizeUpper(value), LEGAL_HOLD_STATUSES, "Legal-hold status", invalidLegalHold);
export const assertLegalHoldScope = (value) => assertEnum(normalizeUpper(value), LEGAL_HOLD_SCOPE_TYPES, "Legal-hold scope", invalidLegalHold);
export const assertEligibilityAction = (value) => assertEnum(normalizeUpper(value), ELIGIBILITY_ACTIONS, "Eligibility action", invalidEligibility);
export const assertEligibilityResult = (value) => assertEnum(normalizeUpper(value), ELIGIBILITY_RESULTS, "Eligibility result", invalidEligibility);
export const assertDependencyResult = (value) => assertEnum(normalizeUpper(value), DEPENDENCY_RESULTS, "Dependency result", invalidEligibility);
export const assertRestoreStrategy = (value) => assertEnum(normalizeUpper(value), RESTORE_CONFLICT_STRATEGIES, "Restore conflict strategy", invalidRestore);
export const assertProviderType = (value) => assertEnum(normalizeUpper(value), ARCHIVE_PROVIDER_TYPES, "Provider type", invalidPolicy);
export const assertPriority = (value) => {
  const n = toInt(value, 100);
  if (n < 0 || n > MAX_POLICY_PRIORITY) throw invalidPolicy(`Priority must be between 0 and ${MAX_POLICY_PRIORITY}`);
  return n;
};

export function assertTenantId(tenantId) {
  const n = Number(tenantId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, "A valid tenant is required for this operation");
  }
  return n;
}

export function assertPositiveDays(value, label, { allowZero = true } = {}) {
  const n = toInt(value, null);
  const min = allowZero ? 0 : 1;
  if (n === null || n < min) throw invalidPolicy(`${label} must be an integer >= ${min}`);
  return n;
}

// ── Date math ────────────────────────────────────────────────────────────────

export function nowIso() {
  return new Date().toISOString();
}

export function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toIso(date) {
  return date instanceof Date ? date.toISOString() : null;
}

export function addDays(base, days) {
  const date = parseDate(base);
  if (!date) return null;
  return new Date(date.getTime() + (Number(days) || 0) * DAY_MS).toISOString();
}

export function daysBetween(from, to) {
  const a = parseDate(from);
  const b = parseDate(to);
  if (!a || !b) return null;
  return Math.floor((b.getTime() - a.getTime()) / DAY_MS);
}

export function isPast(value, reference = nowIso()) {
  const date = parseDate(value);
  if (!date) return false;
  const ref = parseDate(reference);
  return date.getTime() <= ref.getTime();
}

export function dateOnly(value) {
  const date = parseDate(value);
  return date ? date.toISOString().slice(0, 10) : null;
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

export function assertConfigurationValue(key, value) {
  const integerKeys = [
    "default_retention_days",
    "cold_storage_after_days",
    "purge_after_days",
    "max_batch_size",
    "quality_min_score",
  ];
  if (integerKeys.includes(key)) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) throw invalidConfiguration(`${key} must be a non-negative integer`);
  }
  if (key === "quality_min_score" && Number(value) > 100) throw invalidConfiguration("quality_min_score must be between 0 and 100");
  if (key === "default_data_tier") assertDataTier(String(value));
  if (key === "archive_eligible_state") return String(value).toUpperCase();
  return value;
}

export function assertHasTransition(from, to, transitions = DEFAULT_TRANSITIONS) {
  const candidate = normalizeUpper(to);
  const allowed = transitions.filter((t) => normalizeUpper(t.from_state) === normalizeUpper(from)).map((t) => normalizeUpper(t.to_state));
  if (!allowed.includes(candidate)) {
    throw invalidState(`Transition ${normalizeUpper(from)} -> ${candidate} is not permitted`, { from: normalizeUpper(from), to: candidate, allowed });
  }
  return candidate;
}

export function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

// Vocabulary surfaced by REST /meta so a UI can build pickers without hardcoding.
export function vocabulary() {
  return {
    lifecycle_states: LIFECYCLE_STATES,
    lifecycle_actions: LIFECYCLE_ACTIONS,
    data_tiers: DATA_TIERS,
    retention_bases: RETENTION_BASES,
    policy_scope_types: POLICY_SCOPE_TYPES,
    policy_statuses: POLICY_STATUSES,
    policy_actions: POLICY_ACTIONS,
    legal_hold_statuses: LEGAL_HOLD_STATUSES,
    legal_hold_scope_types: LEGAL_HOLD_SCOPE_TYPES,
    eligibility_actions: ELIGIBILITY_ACTIONS,
    eligibility_results: ELIGIBILITY_RESULTS,
    dependency_results: DEPENDENCY_RESULTS,
    restore_conflict_strategies: RESTORE_CONFLICT_STRATEGIES,
    archive_provider_types: ARCHIVE_PROVIDER_TYPES,
  };
}
