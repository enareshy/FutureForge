// Canonical, provider-independent Search model.
//
// This module owns the public SearchQuery / SearchResult contract defined by
// the Enterprise Search Foundation. It deliberately knows nothing about SQLite
// (or any other engine): callers build a canonical query, and the provider
// adapter translates it internally. Business modules depend only on this model.
import { SearchError, SEARCH_ERROR_CODES } from "./errors.js";
import {
  clampPageSize,
  clampPage,
  normalizeText,
  tokenize,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  ATTRIBUTE_PREFIX,
} from "./validation.js";

// ── Operators ───────────────────────────────────────────────────────────────
export const SEARCH_OPERATORS = Object.freeze([
  "EQ",
  "NE",
  "GT",
  "GTE",
  "LT",
  "LTE",
  "CONTAINS",
  "STARTS_WITH",
  "ENDS_WITH",
  "WILDCARD",
  "IN",
  "NOT_IN",
  "IS_NULL",
  "IS_NOT_NULL",
  "BETWEEN",
]);

// Architecture-ready operators. Represented in the query model now so the
// execution engine can adopt them without a public contract change.
export const SEARCH_EXTENDED_OPERATORS = Object.freeze([
  "AND",
  "OR",
  "NOT",
  "EXISTS",
  "RANGE",
  "RELATIONSHIP",
  "FULL_TEXT",
]);

export const SEARCH_DATA_TYPES = Object.freeze([
  "string",
  "text",
  "number",
  "boolean",
  "date",
  "datetime",
  "enum",
  "reference",
  "array",
  "object",
]);

const OPERATOR_ALIASES = {
  "=": "EQ",
  "==": "EQ",
  EQ: "EQ",
  "!=": "NE",
  "<>": "NE",
  NE: "NE",
  ">": "GT",
  GT: "GT",
  ">=": "GTE",
  GTE: "GTE",
  "<": "LT",
  LT: "LT",
  "<=": "LTE",
  LTE: "LTE",
  CONTAINS: "CONTAINS",
  LIKE: "CONTAINS",
  STARTS_WITH: "STARTS_WITH",
  STARTSWITH: "STARTS_WITH",
  STARTS: "STARTS_WITH",
  ENDS_WITH: "ENDS_WITH",
  ENDSWITH: "ENDS_WITH",
  ENDS: "ENDS_WITH",
  WILDCARD: "WILDCARD",
  IN: "IN",
  NOT_IN: "NOT_IN",
  NIN: "NOT_IN",
  IS_NULL: "IS_NULL",
  NULL: "IS_NULL",
  IS_NOT_NULL: "IS_NOT_NULL",
  NOT_NULL: "IS_NOT_NULL",
  EXISTS: "IS_NOT_NULL",
  BETWEEN: "BETWEEN",
  RANGE: "BETWEEN",
};

// Canonical operator -> internal relational operator. The internal operators
// are an implementation detail of the relational provider.
const INTERNAL_OPERATORS = {
  EQ: "eq",
  NE: "ne",
  GT: "gt",
  GTE: "gte",
  LT: "lt",
  LTE: "lte",
  CONTAINS: "contains",
  STARTS_WITH: "starts_with",
  ENDS_WITH: "ends_with",
  WILDCARD: "wildcard",
  IN: "in",
  NOT_IN: "not_in",
  IS_NULL: "is_null",
  IS_NOT_NULL: "is_not_null",
  BETWEEN: "between",
};

// Which operators are valid for each field data type. Validation uses this so
// an invalid combination (for example GT on a boolean) fails fast and clearly.
const OPERATORS_BY_TYPE = {
  string: ["EQ", "NE", "CONTAINS", "STARTS_WITH", "ENDS_WITH", "WILDCARD", "IN", "NOT_IN", "IS_NULL", "IS_NOT_NULL"],
  text: ["EQ", "NE", "CONTAINS", "STARTS_WITH", "ENDS_WITH", "WILDCARD", "IN", "NOT_IN", "IS_NULL", "IS_NOT_NULL"],
  number: ["EQ", "NE", "GT", "GTE", "LT", "LTE", "IN", "NOT_IN", "BETWEEN", "IS_NULL", "IS_NOT_NULL"],
  date: ["EQ", "NE", "GT", "GTE", "LT", "LTE", "BETWEEN", "IS_NULL", "IS_NOT_NULL"],
  datetime: ["EQ", "NE", "GT", "GTE", "LT", "LTE", "BETWEEN", "IS_NULL", "IS_NOT_NULL"],
  boolean: ["EQ", "NE", "IS_NULL", "IS_NOT_NULL"],
  enum: ["EQ", "NE", "IN", "NOT_IN", "IS_NULL", "IS_NOT_NULL"],
  reference: ["EQ", "NE", "IN", "NOT_IN", "IS_NULL", "IS_NOT_NULL"],
  array: ["CONTAINS", "IN", "NOT_IN", "IS_NULL", "IS_NOT_NULL"],
  object: ["IS_NULL", "IS_NOT_NULL"],
};

export function normalizeOperator(operator, { fallback = null } = {}) {
  if (operator === undefined || operator === null || operator === "") return fallback;
  const key = String(operator).trim().toUpperCase().replace(/\s+/g, "_");
  const canonical = OPERATOR_ALIASES[key];
  if (!canonical) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_OPERATOR, `Unknown search operator "${operator}"`);
  }
  return canonical;
}

export function operatorAllows(operator, dataType) {
  const list = OPERATORS_BY_TYPE[normalizeDataType(dataType)] || OPERATORS_BY_TYPE.string;
  return list.includes(operator);
}

export function operatorsForType(dataType) {
  return [...(OPERATORS_BY_TYPE[normalizeDataType(dataType)] || OPERATORS_BY_TYPE.string)];
}

export function normalizeDataType(dataType) {
  if (!dataType) return "string";
  const value = String(dataType).trim().toLowerCase();
  return SEARCH_DATA_TYPES.includes(value) ? value : "string";
}

export function internalOperator(operator) {
  const canonical = normalizeOperator(operator);
  const mapped = INTERNAL_OPERATORS[canonical];
  if (!mapped) {
    throw new SearchError(
      SEARCH_ERROR_CODES.UNSUPPORTED_OPERATOR,
      `Operator ${canonical} is reserved for a future search phase`
    );
  }
  return mapped;
}

// ── Normalisation helpers ───────────────────────────────────────────────────
function normalizeList(input) {
  if (input === undefined || input === null) return [];
  const list = Array.isArray(input) ? input : String(input).split(",");
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeFilter(filter) {
  if (!filter || typeof filter !== "object") {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "Each filter must be an object");
  }
  const field = String(filter.field ?? filter.name ?? "").trim();
  if (!field) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_FIELD, "Each filter needs a field");
  }
  const operator = normalizeOperator(filter.operator ?? filter.op, { fallback: null });
  const value = filter.value ?? filter.values ?? null;
  return { field, operator, value };
}

export function normalizeFilters(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input.map(normalizeFilter);
  if (typeof input === "object") {
    return Object.entries(input).map(([field, value]) =>
      normalizeFilter({ field, operator: value === null ? "IS_NULL" : "EQ", value })
    );
  }
  throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "filters must be an array or object");
}

function normalizeSortEntry(entry) {
  if (typeof entry === "string") {
    const [field, direction] = entry.trim().split(/[\s:]+/);
    return { field, direction: (direction || "asc").toUpperCase() };
  }
  if (entry && typeof entry === "object") {
    const field = String(entry.field ?? entry.name ?? "").trim();
    const direction = String(entry.direction ?? entry.order ?? "asc").toUpperCase();
    return { field, direction };
  }
  throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "Each sort must be a field or { field, direction }");
}

export function normalizeSort(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : String(input).split(",").map((item) => item.trim()).filter(Boolean);
  return list
    .map(normalizeSortEntry)
    .filter((entry) => entry.field)
    .map((entry) => ({ field: entry.field, direction: entry.direction === "DESC" ? "DESC" : "ASC" }));
}

export function normalizeCondition(node, depth = 0) {
  if (!node) return null;
  if (depth > 5) {
    throw new SearchError(SEARCH_ERROR_CODES.QUERY_TOO_COMPLEX, "Boolean expression is too deeply nested");
  }
  if (typeof node !== "object") {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "A condition group must be an object");
  }
  const operator = String(node.operator ?? node.op ?? "and").toLowerCase();
  const resolved = ["and", "or", "not"].includes(operator) ? operator : null;
  if (!resolved) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_OPERATOR, `Unknown condition operator "${node.operator}"`);
  }
  const filters = Array.isArray(node.filters) ? node.filters.map(normalizeFilter) : [];
  const conditions = Array.isArray(node.conditions) ? node.conditions.map((child) => normalizeCondition(child, depth + 1)) : [];
  return { operator: resolved, filters, conditions };
}

export function normalizeRelationship(input) {
  if (!input || typeof input !== "object") return null;
  const source = input.sourceObject || input.source_object || {};
  const target = input.targetObject || input.target_object || {};
  const objectType = input.objectType ?? input.object_type ?? source.objectType ?? source.object_type;
  const objectId = input.objectId ?? input.object_id ?? source.objectId ?? source.object_id;
  return {
    object_type: objectType !== undefined && objectType !== null ? String(objectType) : undefined,
    object_id: objectId !== undefined && objectId !== null ? String(objectId) : undefined,
    relationship_type: input.relationshipType ?? input.relationship_type ?? input.type ?? "",
    target_type: target.objectType ?? target.object_type ?? input.targetType ?? input.target_type,
    direction: input.direction === "in" ? "in" : "out",
    depth: Math.max(1, Math.min(Number(input.depth) || 1, 5)),
  };
}

// ── Canonical SearchQuery ───────────────────────────────────────────────────
export function normalizeCanonicalQuery(input = {}) {
  const pageSize = clampPageSize(input.pageSize ?? input.page_size, PAGE_SIZE_DEFAULT);
  return {
    text: String(input.text ?? input.q ?? input.query ?? "").trim(),
    objectTypes: normalizeList(input.objectTypes ?? input.object_types ?? input.types),
    filters: normalizeFilters(input.filters),
    condition: normalizeCondition(input.condition),
    facets: normalizeList(input.facets ?? input.facetFields ?? input.facet_fields),
    sort: normalizeSort(input.sort),
    page: clampPage(input.page ?? input.pageNumber ?? 1) - 1,
    pageSize,
    scope: input.scope ? String(input.scope) : "tenant",
    highlight: input.highlight === undefined ? true : Boolean(input.highlight),
    relationship: normalizeRelationship(input.relationship),
    savedSearchId: input.savedSearchId ?? input.saved_search_id ?? null,
    effectivity: normalizeEffectivity(input.effectivity ?? input.asOf ?? null),
  };
}

export function normalizeEffectivity(input) {
  if (!input || typeof input !== "object") return null;
  const out = {};
  const map = {
    asOfDate: input.asOfDate ?? input.as_of_date ?? input.asOf,
    serialNumber: input.serialNumber ?? input.serial_number,
    plant: input.plant,
    unit: input.unit,
    model: input.model,
    variant: input.variant,
    configuration: input.configuration,
    revision: input.revision,
  };
  for (const [key, value] of Object.entries(map)) {
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

export function emptyCanonicalQuery() {
  return {
    text: "",
    objectTypes: [],
    filters: [],
    condition: null,
    facets: [],
    sort: [],
    page: 0,
    pageSize: PAGE_SIZE_DEFAULT,
    scope: "tenant",
    highlight: true,
    relationship: null,
    savedSearchId: null,
    effectivity: null,
  };
}

// ── Canonical -> internal query ─────────────────────────────────────────────
function translateCondition(node) {
  if (!node) return null;
  return {
    operator: node.operator,
    filters: node.filters.map((filter) => ({
      field: filter.field,
      operator: internalOperator(filter.operator),
      value: filter.value,
    })),
    conditions: node.conditions.map(translateCondition).filter(Boolean),
  };
}

function translateFilter(filter) {
  return {
    field: filter.field,
    operator: internalOperator(filter.operator),
    value: filter.value,
  };
}

export function toInternalQuery(canonical) {
  const objectTypes = canonical.objectTypes.map((type) => String(type));
  const sorts = canonical.sort
    .filter((entry) => entry.field)
    .map((entry) => ({ field: entry.field, direction: entry.direction }));
  return {
    text: canonical.text,
    object_types: objectTypes,
    filters: canonical.filters.map(translateFilter),
    condition: translateCondition(canonical.condition),
    relationship: canonical.relationship,
    sorts,
    sort: sorts.length ? "custom" : "relevance",
    page: canonical.page + 1,
    page_size: canonical.pageSize,
    scope: canonical.scope,
    highlight: canonical.highlight,
    include_facets: canonical.facets.length > 0,
    facet_fields: canonical.facets,
    saved_search_id: canonical.savedSearchId,
    highlight_terms: collectTerms(canonical),
    effectivity: canonical.effectivity,
  };
}

// Terms used for scoring and highlighting. Includes free text plus any text
// predicates expressed in filters/conditions.
export function collectTerms(canonical) {
  const terms = new Set(tokenize(canonical.text));
  const visit = (filter) => {
    if (!filter) return;
    if (["CONTAINS", "STARTS_WITH", "ENDS_WITH", "WILDCARD"].includes(filter.operator)) {
      for (const token of tokenize(String(filter.value ?? "").replace(/[*?]/g, " "))) terms.add(token);
    } else if (filter.operator === "EQ" && filter.field === "_text") {
      for (const token of tokenize(filter.value)) terms.add(token);
    }
  };
  canonical.filters.forEach(visit);
  const walk = (node) => {
    if (!node) return;
    node.filters.forEach(visit);
    node.conditions.forEach(walk);
  };
  walk(canonical.condition);
  return [...terms];
}

// ── Canonical SearchResult ──────────────────────────────────────────────────
export function matchedFields(document, terms) {
  if (!terms?.length) return [];
  const fields = [];
  const title = normalizeText(document.title);
  const code = normalizeText(document.code);
  const summary = normalizeText(document.summary || document.description);
  const tags = (document.tags || []).map((tag) => normalizeText(tag));
  const attributes = normalizeText(JSON.stringify(document.attributes || {}));
  for (const term of terms) {
    if (title.includes(term) && !fields.includes("title")) fields.push("title");
    if (code.includes(term) && !fields.includes("code")) fields.push("code");
    if (summary.includes(term) && !fields.includes("description")) fields.push("description");
    if (tags.some((tag) => tag.includes(term)) && !fields.includes("tags")) fields.push("tags");
    if (attributes.includes(term) && !fields.includes("attributes")) fields.push("attributes");
  }
  return fields;
}

export function toCanonicalResultItem(document, terms = []) {
  return {
    objectType: document.object_type,
    objectId: String(document.object_id),
    revisionId: document.source_revision ?? null,
    versionId: document.revisions || null,
    title: document.title || "",
    code: document.code || "",
    description: document.summary || "",
    status: document.status || "",
    lifecycleState: document.lifecycle_state || "",
    owner: document.owner_name || null,
    ownerId: document.owner_id ?? null,
    organizationId: document.organization_id ?? null,
    siteId: document.site_id ?? null,
    externalReference: document.external_reference || "",
    classification: document.classification || "internal",
    tags: document.tags || [],
    attributes: document.attributes || {},
    relationshipCount: (document.relationships || []).length,
    thumbnail: null,
    highlight: document.highlights || null,
    score: document.score ?? null,
    matchedFields: matchedFields(document, terms),
    indexedAt: document.indexed_at || null,
    updatedAt: document.updated_at || null,
  };
}

export function canonicalFacets(internalFacets, canonical) {
  const selectedByField = new Map();
  for (const filter of canonical.filters) {
    const set = selectedByField.get(filter.field) || new Set();
    const values = Array.isArray(filter.value) ? filter.value : [filter.value];
    values.forEach((value) => set.add(String(value)));
    selectedByField.set(filter.field, set);
  }
  return (internalFacets || []).map((facet) => {
    const selected = selectedByField.get(facet.field) || new Set();
    return {
      name: facet.field,
      field: facet.field,
      values: (facet.values || []).map((entry) => ({
        value: entry.value,
        count: entry.count,
        selected: selected.has(String(entry.value)),
      })),
    };
  });
}

export function toCanonicalResult(internal, canonical, { facets = null } = {}) {
  const terms = collectTerms(canonical);
  return {
    results: (internal.items || []).map((item) => toCanonicalResultItem(item, terms)),
    facets: facets ? canonicalFacets(facets, canonical) : [],
    total: internal.total || 0,
    page: canonical.page,
    pageSize: canonical.pageSize,
    pages: internal.pages || 0,
    tookMs: internal.took_ms ?? 0,
    objectTypes: internal.object_types || canonical.objectTypes,
    sort: canonical.sort,
    strategy: internal.strategy || "standard",
    scope: internal.scope || canonical.scope,
    query: canonical.text,
    disabled: internal.disabled === true,
    provider: internal.provider || null,
  };
}

// Facet aggregation over an already authorisation-filtered document set. This
// is the security-correct path: counts are derived from documents the caller
// may actually see, never from the raw provider index.
export function computeFacetsFromDocuments(rows, fields) {
  const results = [];
  for (const field of fields) {
    const counts = new Map();
    for (const row of rows) {
      for (const value of facetValues(row, field)) {
        const key = value === null || value === undefined ? null : String(value);
        if (key === null || key === "") continue;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    results.push({
      field,
      values: [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, 50),
    });
  }
  return results;
}

function facetValues(row, field) {
  switch (field) {
    case "object_type":
      return [row.object_type];
    case "status":
      return [row.status];
    case "lifecycle_state":
      return [row.lifecycle_state];
    case "classification":
      return [row.classification];
    case "owner_name":
      return [row.owner_name];
    case "owner_id":
      return [row.owner_id];
    case "organization_id":
      return [row.organization_id];
    case "site_id":
      return [row.site_id];
    case "tags":
      return safeArray(row.tags_json);
    default: {
      if (field.startsWith(ATTRIBUTE_PREFIX) || row.attributes_json) {
        const name = field.startsWith(ATTRIBUTE_PREFIX) ? field.slice(ATTRIBUTE_PREFIX.length) : field;
        const attributes = safeObject(row.attributes_json);
        const value = attributes[name];
        if (Array.isArray(value)) return value;
        return [value];
      }
      return [];
    }
  }
}

function safeArray(json) {
  try {
    const value = typeof json === "string" ? JSON.parse(json || "[]") : json;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function safeObject(json) {
  try {
    const value = typeof json === "string" ? JSON.parse(json || "{}") : json;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export const PAGE_LIMITS = { default: PAGE_SIZE_DEFAULT, max: PAGE_SIZE_MAX };
