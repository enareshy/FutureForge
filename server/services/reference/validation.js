// Shared vocabulary and pure helpers for Enterprise Reference Data Management.
// Keeping this dependency-free lets every service and the router reuse the same
// validation rules without importing the database or the service graph.
import { HttpError } from "../../validation.js";

export const ITEM_STATUSES = Object.freeze([
  "draft",
  "submitted",
  "under_review",
  "approved",
  "active",
  "inactive",
  "retired",
  "rejected",
  "returned",
]);

export const DOMAIN_STATUSES = Object.freeze(["draft", "active", "inactive", "retired"]);
export const CODE_STATUSES = Object.freeze(["active", "inactive", "deprecated", "retired"]);
export const TRANSLATION_STATUSES = Object.freeze(["draft", "approved", "active", "inactive"]);
export const APPROVAL_STATUSES = Object.freeze(["submitted", "under_review", "approved", "rejected", "returned", "cancelled"]);

export const SCOPE_TYPES = Object.freeze([
  "GLOBAL",
  "TENANT",
  "ORGANIZATION",
  "COMPANY",
  "BUSINESS_UNIT",
  "PLANT",
  "SITE",
]);

export const CODE_TYPES = Object.freeze(["primary", "external", "legacy", "deprecated", "replacement"]);
export const ALIAS_TYPES = Object.freeze(["synonym", "abbreviation", "translation", "external", "legacy", "search"]);
export const RELATIONSHIP_TYPES = Object.freeze(["parent_child", "component", "classification", "grouping"]);
export const CHANGE_TYPES = Object.freeze(["create", "update", "retire", "governance", "import"]);
export const CONFLICT_STRATEGIES = Object.freeze(["error", "highest_precedence", "latest_version"]);

export const SCOPE_COLUMN = Object.freeze({
  GLOBAL: null,
  TENANT: "tenant_id",
  ORGANIZATION: "organization_id",
  COMPANY: "company_id",
  BUSINESS_UNIT: "business_unit_id",
  PLANT: "plant_id",
  SITE: "site_id",
});

// Lifecycle graph. Both the full governed flow and the short DRAFT -> ACTIVE ->
// RETIRED flow are supported because governance is per-domain configuration.
const TRANSITIONS = Object.freeze({
  draft: ["submitted", "under_review", "approved", "active", "retired", "returned"],
  submitted: ["under_review", "approved", "active", "rejected", "returned", "draft"],
  under_review: ["approved", "active", "rejected", "returned", "draft"],
  approved: ["active", "inactive", "retired", "rejected"],
  active: ["inactive", "retired", "under_review"],
  inactive: ["active", "retired"],
  retired: [],
  rejected: ["draft", "submitted"],
  returned: ["draft", "submitted"],
});

export function canTransition(from, to) {
  const allowed = TRANSITIONS[String(from || "").toLowerCase()] || [];
  return allowed.includes(String(to || "").toLowerCase());
}

export function nextStatuses(from) {
  return [...(TRANSITIONS[String(from || "").toLowerCase()] || [])];
}

export function isStatus(value) {
  return ITEM_STATUSES.includes(String(value || "").toLowerCase());
}

export function normalizeStatus(value, fallback = "draft") {
  const status = String(value || "").trim().toLowerCase();
  return isStatus(status) ? status : fallback;
}

export function normalizeUpper(value) {
  return String(value ?? "").trim().toUpperCase();
}

export function normalizeText(value, fallback = "") {
  return String(value ?? "").trim() || fallback;
}

export function isScopeType(value) {
  return SCOPE_TYPES.includes(String(value || "").toUpperCase());
}

export function normalizeScopeType(value, fallback = "GLOBAL") {
  const scope = String(value || "").trim().toUpperCase();
  return isScopeType(scope) ? scope : fallback;
}

export function normalizeLanguage(value, fallback = "en") {
  const language = String(value || "").trim().toLowerCase();
  if (!language) return fallback;
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(language)) {
    throw new HttpError(400, `Invalid language tag: ${value}`);
  }
  return language;
}

export function parseObject(value, fallback = {}) {
  if (value === null || value === undefined || value === "") return { ...fallback };
  if (typeof value === "object") return Array.isArray(value) ? [...value] : { ...value };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

export function parseArray(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined || value === "") return [...fallback];
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [...fallback];
    } catch {
      return [...fallback];
    }
  }
  return [...fallback];
}

export function json(value, fallback) {
  if (value === undefined) return JSON.stringify(fallback ?? {});
  return JSON.stringify(value ?? fallback ?? {});
}

export function toBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(text)) return true;
  if (["0", "false", "no", "n", "off"].includes(text)) return false;
  return fallback;
}

// Builds the canonical scope key used by the uniqueness constraint. GLOBAL is a
// single shared bucket; every other dimension is keyed by its organization id.
export function scopeValueFor(scopeType, context = {}) {
  switch (scopeType) {
    case "TENANT":
      return context.tenantId ?? context.tenant_id ?? null;
    case "ORGANIZATION":
      return context.organizationId ?? context.organization_id ?? context.tenantId ?? null;
    case "COMPANY":
      return context.companyId ?? context.company_id ?? null;
    case "BUSINESS_UNIT":
      return context.businessUnitId ?? context.business_unit_id ?? null;
    case "PLANT":
      return context.plantId ?? context.plant_id ?? null;
    case "SITE":
      return context.siteId ?? context.site_id ?? null;
    default:
      return null;
  }
}

export function buildScopeKey(scopeType, context = {}) {
  const scope = normalizeScopeType(scopeType, "GLOBAL");
  if (scope === "GLOBAL") return "GLOBAL";
  const value = scopeValueFor(scope, context);
  if (value === null || value === undefined || value === "") {
    throw new HttpError(422, `Scope ${scope} requires a matching organization identifier`);
  }
  return `${scope}:${value}`;
}

export function scopeFromKey(scopeKey) {
  const text = String(scopeKey || "GLOBAL");
  const [scope, value] = text.split(":");
  return { scope_type: normalizeScopeType(scope, "GLOBAL"), value: value ?? null };
}

export function isGlobalScope(scopeType) {
  return normalizeScopeType(scopeType, "GLOBAL") === "GLOBAL";
}

export function validateEffectiveRange(effectiveFrom, effectiveTo) {
  if (effectiveFrom && effectiveTo && String(effectiveFrom) > String(effectiveTo)) {
    return false;
  }
  return true;
}

export function isEffectiveAt(effectiveFrom, effectiveTo, asOf) {
  if (!asOf) return true;
  if (effectiveFrom && String(asOf) < String(effectiveFrom)) return false;
  if (effectiveTo && String(asOf) > String(effectiveTo)) return false;
  return true;
}

export function pagination(query = {}, { defaultPageSize = 50, maxPageSize = 200 } = {}) {
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, Number(query.pageSize || query.page_size) || defaultPageSize));
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

export function vocabulary() {
  return {
    item_statuses: [...ITEM_STATUSES],
    domain_statuses: [...DOMAIN_STATUSES],
    code_statuses: [...CODE_STATUSES],
    translation_statuses: [...TRANSLATION_STATUSES],
    approval_statuses: [...APPROVAL_STATUSES],
    scope_types: [...SCOPE_TYPES],
    code_types: [...CODE_TYPES],
    alias_types: [...ALIAS_TYPES],
    relationship_types: [...RELATIONSHIP_TYPES],
    change_types: [...CHANGE_TYPES],
    conflict_strategies: [...CONFLICT_STRATEGIES],
    lifecycle: Object.fromEntries(ITEM_STATUSES.map((status) => [status, nextStatuses(status)])),
  };
}
