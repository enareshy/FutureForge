// Validation, vocabulary and limits for the Search & Discovery Framework.
import { HttpError } from "../../validation.js";

export const SEARCH_SCOPES = ["tenant", "organization", "global"];
export const SEARCH_STRATEGIES = ["standard", "advanced", "full_text", "attribute", "type", "relationship"];
export const SEARCH_SORTS = ["relevance", "modified", "created", "title", "type", "owner", "custom"];
export const OBJECT_TYPE_STATUSES = ["active", "disabled", "draft"];
export const SENSITIVITIES = ["public", "internal", "confidential", "restricted"];
export const INDEX_OPERATIONS = ["upsert", "delete"];
export const QUEUE_STATUSES = ["pending", "processing", "succeeded", "failed", "dead_letter"];
export const EXPORT_FORMATS = ["json", "csv"];
export const EXPORT_STATUSES = ["pending", "processing", "completed", "failed", "expired"];
export const SHARING_SCOPES = ["private", "organization", "tenant"];
export const CONDITION_OPERATORS = ["and", "or", "not"];
export const FILTER_OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "wildcard",
  "in",
  "not_in",
  "between",
  "is_null",
  "is_not_null",
  "exists",
  "not_exists",
];

// Index columns a structured filter may target directly. Attribute filters use
// the reserved `attribute.<name>` prefix and are matched against attributes_json.
// The pseudo-columns `_text`, `_title`, `_code` target the full-text body and
// the primary display fields respectively.
export const FILTERABLE_COLUMNS = [
  "object_type",
  "object_id",
  "code",
  "title",
  "status",
  "lifecycle_state",
  "owner_id",
  "owner_name",
  "classification",
  "organization_id",
  "site_id",
  "tenant_id",
  "external_reference",
  "created_at",
  "updated_at",
  "source_revision",
  "revisions",
];

export const SPECIAL_COLUMNS = {
  _text: "i.searchable_text",
  _title: "i.title",
  _code: "i.code",
};

export const FACET_FIELDS = [
  "object_type",
  "status",
  "lifecycle_state",
  "classification",
  "tags",
  "owner_name",
  "organization_id",
];

export const SORT_COLUMNS = {
  relevance: "score",
  modified: "i.updated_at",
  created: "i.created_at",
  title: "i.title",
  type: "i.object_type",
  owner: "i.owner_name",
};

export const PAGE_SIZE_DEFAULT = 20;
export const PAGE_SIZE_MAX = 100;
export const RESULT_CANDIDATE_MAX = 500;
export const QUERY_TEXT_MAX = 400;
export const CONDITION_DEPTH_MAX = 5;
export const CONDITION_COUNT_MAX = 50;

export const ATTRIBUTE_PREFIX = "attribute.";

export function assertScope(scope, fallback = "tenant") {
  if (scope === undefined || scope === null || scope === "") return fallback;
  if (!SEARCH_SCOPES.includes(scope)) {
    throw new HttpError(400, `scope must be one of ${SEARCH_SCOPES.join(", ")}`);
  }
  return scope;
}

export function assertStrategy(strategy, fallback = "standard") {
  if (strategy === undefined || strategy === null || strategy === "") return fallback;
  if (!SEARCH_STRATEGIES.includes(strategy)) {
    throw new HttpError(400, `strategy must be one of ${SEARCH_STRATEGIES.join(", ")}`);
  }
  return strategy;
}

export function assertSort(sort, fallback = "relevance") {
  if (sort === undefined || sort === null || sort === "") return fallback;
  if (!SEARCH_SORTS.includes(sort)) {
    throw new HttpError(400, `sort must be one of ${SEARCH_SORTS.join(", ")}`);
  }
  return sort;
}

export function assertFilterOperator(operator) {
  if (!FILTER_OPERATORS.includes(operator)) {
    throw new HttpError(400, `Unsupported filter operator "${operator}"`);
  }
  return operator;
}

export function assertConditionOperator(operator) {
  if (!CONDITION_OPERATORS.includes(operator)) {
    throw new HttpError(400, `Unsupported condition operator "${operator}"`);
  }
  return operator;
}

export function normalizeText(value) {
  if (value === undefined || value === null) return "";
  return String(value).toLowerCase().replace(/\s+/g, " ").trim();
}

// Formats a Date (or parseable value) the same way SQLite's datetime('now')
// does, so lexical comparisons between computed and stored timestamps are
// consistent.
export function toSqlDateTime(input) {
  const date = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export function addDays(days) {
  return toSqlDateTime(new Date(Date.now() + Number(days) * 86400000));
}

export function tokenize(value) {
  return normalizeText(value)
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

export function clampPageSize(value, fallback = PAGE_SIZE_DEFAULT) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return fallback;
  return Math.min(Math.floor(size), PAGE_SIZE_MAX);
}

export function clampPage(value) {
  const page = Number(value);
  if (!Number.isFinite(page) || page < 1) return 1;
  return Math.floor(page);
}

export function validateQueryText(text, { min = 0, max = QUERY_TEXT_MAX } = {}) {
  if (text === undefined || text === null) return "";
  const value = String(text).trim();
  if (value.length > max) {
    throw new HttpError(400, `Search query must be ${max} characters or fewer`);
  }
  if (min && value.length < min) {
    throw new HttpError(400, `Search query must be at least ${min} characters`);
  }
  return value;
}

export function normalizeObjectTypes(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : String(input).split(",");
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
}

export function normalizeTags(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : String(input).split(",");
  return [...new Set(list.map((item) => String(item).trim().toLowerCase()).filter(Boolean))];
}

export function isValidIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]+$/.test(value);
}

export const vocabulary = {
  scopes: SEARCH_SCOPES,
  strategies: SEARCH_STRATEGIES,
  sorts: SEARCH_SORTS,
  object_type_statuses: OBJECT_TYPE_STATUSES,
  sensitivities: SENSITIVITIES,
  index_operations: INDEX_OPERATIONS,
  queue_statuses: QUEUE_STATUSES,
  export_formats: EXPORT_FORMATS,
  export_statuses: EXPORT_STATUSES,
  sharing_scopes: SHARING_SCOPES,
  condition_operators: CONDITION_OPERATORS,
  filter_operators: FILTER_OPERATORS,
  facet_fields: FACET_FIELDS,
  filterable_columns: FILTERABLE_COLUMNS,
  attribute_prefix: ATTRIBUTE_PREFIX,
  page_size_default: PAGE_SIZE_DEFAULT,
  page_size_max: PAGE_SIZE_MAX,
};
