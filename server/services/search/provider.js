// Search provider abstraction. The relational provider is the default and
// compiles declarative queries into parameterised SQLite. Alternative engines
// (for example a dedicated index server) can be registered under a new name
// without changing the search service or its callers.
import { queryAll, queryOne } from "../../db.js";
import { HttpError } from "../../validation.js";
import {
  FILTERABLE_COLUMNS,
  SPECIAL_COLUMNS,
  ATTRIBUTE_PREFIX,
  assertFilterOperator,
  assertConditionOperator,
  CONDITION_DEPTH_MAX,
  CONDITION_COUNT_MAX,
  normalizeText,
  tokenize,
} from "./validation.js";
import { publicIndexedDocument } from "./repository.js";
import {
  applyIndexChange,
  deleteIndexRow,
  indexingStatus,
  reindexTenant,
  reindexType,
  upsertIndexRow,
} from "./indexing.js";

const providers = new Map();
export const DEFAULT_PROVIDER = "relational";

export function registerSearchProvider(name, provider) {
  if (!name || typeof provider?.search !== "function") {
    throw new Error("A search provider needs a name and a search() method");
  }
  providers.set(String(name), { name: String(name), ...provider });
  return providers.get(String(name));
}

export function getSearchProvider(name = DEFAULT_PROVIDER) {
  const provider = providers.get(String(name));
  if (!provider) throw new HttpError(400, `Unknown search provider "${name}"`);
  return provider;
}

export function listSearchProviders() {
  return [...providers.values()].map((provider) => ({
    name: provider.name,
    capabilities: provider.capabilities || {},
  }));
}

const NUMERIC_COLUMNS = new Set(["owner_id", "organization_id", "tenant_id", "site_id"]);

function columnExpression(field) {
  if (typeof field !== "string" || !field) {
    throw new HttpError(400, "Each filter needs a field");
  }
  if (SPECIAL_COLUMNS[field]) return SPECIAL_COLUMNS[field];
  if (field.startsWith(ATTRIBUTE_PREFIX)) {
    const name = field.slice(ATTRIBUTE_PREFIX.length);
    if (!/^[A-Za-z0-9_. -]+$/.test(name)) {
      throw new HttpError(400, `Invalid attribute filter "${field}"`);
    }
    return `json_extract(i.attributes_json, '$."${name.replace(/"/g, "")}"')`;
  }
  if (!FILTERABLE_COLUMNS.includes(field)) {
    throw new HttpError(400, `Field "${field}" is not filterable`);
  }
  return `i.${field}`;
}

function coerceValue(field, value) {
  if (value === undefined) return value;
  if (FILTERABLE_COLUMNS.includes(field) && NUMERIC_COLUMNS.has(field) && value !== null) {
    const num = Number(value);
    return Number.isFinite(num) ? num : value;
  }
  return value;
}

function compileFilter(filter, state) {
  if (!filter || typeof filter !== "object") {
    throw new HttpError(400, "Each filter must be an object");
  }
  state.count += 1;
  if (state.count > CONDITION_COUNT_MAX) {
    throw new HttpError(400, `Too many search conditions (max ${CONDITION_COUNT_MAX})`);
  }
  const { field, operator = "eq" } = filter;
  const value = filter.value;
  assertFilterOperator(operator);
  const expr = columnExpression(field);
  const push = (sql, params = []) => {
    state.params.push(...params);
    return sql;
  };
  const coerce = (input) => coerceValue(field, input);
  switch (operator) {
    case "eq":
      if (value === null) return push(`${expr} IS NULL`);
      return push(`${expr} = ?`, [coerce(value)]);
    case "ne":
      if (value === null) return push(`${expr} IS NOT NULL`);
      return push(`(${expr} IS NULL OR ${expr} != ?)`, [coerce(value)]);
    case "gt":
      return push(`${expr} > ?`, [coerce(value)]);
    case "gte":
      return push(`${expr} >= ?`, [coerce(value)]);
    case "lt":
      return push(`${expr} < ?`, [coerce(value)]);
    case "lte":
      return push(`${expr} <= ?`, [coerce(value)]);
    case "contains":
      return push(`lower(${expr}) LIKE ?`, [`%${normalizeText(value)}%`]);
    case "not_contains":
      return push(`(${expr} IS NULL OR lower(${expr}) NOT LIKE ?)`, [`%${normalizeText(value)}%`]);
    case "starts_with":
      return push(`lower(${expr}) LIKE ?`, [`${normalizeText(value)}%`]);
    case "ends_with":
      return push(`lower(${expr}) LIKE ?`, [`%${normalizeText(value)}`]);
    case "wildcard": {
      const pattern = String(value ?? "")
        .replace(/[%_\\]/g, (ch) => `\\${ch}`)
        .replace(/\*/g, "%")
        .replace(/\?/g, "_");
      return push(`lower(${expr}) LIKE ? ESCAPE '\\'`, [normalizeText(pattern)]);
    }
    case "in": {
      const list = Array.isArray(value) ? value : [value];
      if (!list.length) return "0 = 1";
      return push(`${expr} IN (${list.map(() => "?").join(", ")})`, list.map(coerce));
    }
    case "not_in": {
      const list = Array.isArray(value) ? value : [value];
      if (!list.length) return "1 = 1";
      return push(`(${expr} IS NULL OR ${expr} NOT IN (${list.map(() => "?").join(", ")}))`, list.map(coerce));
    }
    case "between": {
      const list = Array.isArray(value) ? value : [];
      if (list.length !== 2) throw new HttpError(400, "between expects a two-element array");
      return push(`${expr} BETWEEN ? AND ?`, [coerce(list[0]), coerce(list[1])]);
    }
    case "is_null":
      return `${expr} IS NULL`;
    case "is_not_null":
      return `${expr} IS NOT NULL`;
    case "exists":
      return `(${expr} IS NOT NULL AND ${expr} != '')`;
    case "not_exists":
      return `(${expr} IS NULL OR ${expr} = '')`;
    default:
      throw new HttpError(400, `Unsupported filter operator "${operator}"`);
  }
}

function compileCondition(node, state, depth = 0) {
  if (depth > CONDITION_DEPTH_MAX) {
    throw new HttpError(400, `Search conditions may not nest deeper than ${CONDITION_DEPTH_MAX}`);
  }
  if (!node || typeof node !== "object") {
    throw new HttpError(400, "Each condition group must be an object");
  }
  const operator = assertConditionOperator(node.operator || "and");
  const children = [];
  if (Array.isArray(node.filters)) {
    for (const filter of node.filters) children.push(compileFilter(filter, state));
  }
  if (Array.isArray(node.conditions)) {
    for (const child of node.conditions) children.push(compileCondition(child, state, depth + 1));
  }
  if (!children.length) return "1 = 1";
  const joined = children.join(operator === "or" ? " OR " : " AND ");
  if (operator === "not") return `NOT (${joined})`;
  return `(${joined})`;
}

function compileTags(tags, state) {
  const expressions = [];
  for (const tag of tags) {
    state.params.push(`%"${normalizeText(tag)}"%`);
    expressions.push("lower(i.tags_json) LIKE ?");
  }
  return expressions.length ? `(${expressions.join(" AND ")})` : null;
}

function compileRelationshipFilter(rel, state) {
  if (!rel || typeof rel !== "object") return null;
  const params = [];
  let sql = "SELECT 1 FROM search_relationships r WHERE r.tenant_id = i.tenant_id AND r.source_type = i.object_type AND r.source_id = i.object_id";
  if (rel.type) {
    sql += " AND r.relationship_type = ?";
    params.push(String(rel.type));
  }
  if (rel.direction) {
    sql += " AND r.direction = ?";
    params.push(rel.direction === "in" ? "in" : "out");
  }
  if (rel.object_type) {
    sql += " AND r.target_type = ?";
    params.push(String(rel.object_type));
  }
  if (rel.object_id !== undefined && rel.object_id !== null && rel.object_id !== "") {
    sql += " AND r.target_id = ?";
    params.push(String(rel.object_id));
  }
  state.params.push(...params);
  return `EXISTS (${sql})`;
}

// Finds documents that are related to a focus object. `direction: "out"`
// returns the focus object's targets; `direction: "in"` returns its sources.
function compileRelatedTo(rel, state) {
  if (!rel || typeof rel !== "object" || rel.object_type === undefined || rel.object_id === undefined) {
    throw new HttpError(400, "related_to requires object_type and object_id");
  }
  const direction = rel.direction === "in" ? "in" : "out";
  const focusType = String(rel.object_type);
  const focusId = String(rel.object_id);
  const params = [state.tenantId, focusType, focusId];
  let sql;
  if (direction === "out") {
    sql = `SELECT 1 FROM search_relationships r
           WHERE r.tenant_id = ? AND r.source_type = ? AND r.source_id = ?
             AND r.target_type = i.object_type AND r.target_id = i.object_id`;
  } else {
    sql = `SELECT 1 FROM search_relationships r
           WHERE r.tenant_id = ? AND r.target_type = ? AND r.target_id = ?
             AND r.source_type = i.object_type AND r.source_id = i.object_id`;
  }
  if (rel.relationship_type) {
    sql += " AND r.relationship_type = ?";
    params.push(String(rel.relationship_type));
  }
  state.params.push(...params);
  return `EXISTS (${sql})`;
}

export function compileWhere(query, { allowedTypes, tenantId, scope, organizationIds, securityPredicate } = {}) {
  const state = { params: [], count: 0, tenantId };
  const clauses = [];

  if (scope === "global") {
    // Platform-wide search deliberately has no tenant predicate; callers must
    // be authorized before requesting this scope.
  } else {
    clauses.push("i.tenant_id = ?");
    state.params.push(Number(tenantId));
  }

  if (scope === "organization") {
    const ids = Array.isArray(organizationIds) ? organizationIds : [];
    if (!ids.length) clauses.push("0 = 1");
    else {
      clauses.push(`i.organization_id IN (${ids.map(() => "?").join(", ")})`);
      state.params.push(...ids.map(Number));
    }
  }

  // Centralized data-security row predicate. Applied at the data layer so
  // unauthorized rows never influence counts, facets or pagination.
  if (securityPredicate && securityPredicate.sql) {
    clauses.push(securityPredicate.sql);
    state.params.push(...(securityPredicate.params || []));
  }

  if (Array.isArray(allowedTypes)) {
    if (!allowedTypes.length) clauses.push("0 = 1");
    else {
      clauses.push(`i.object_type IN (${allowedTypes.map(() => "?").join(", ")})`);
      state.params.push(...allowedTypes);
    }
  }

  const terms = tokenize(query.text);
  for (const term of terms) {
    state.params.push(`%${term}%`);
    clauses.push("i.searchable_text LIKE ?");
  }

  for (const status of query.statuses || []) {
    clauses.push("i.status = ?");
    state.params.push(String(status));
  }
  for (const stateCode of query.lifecycle_states || []) {
    clauses.push("i.lifecycle_state = ?");
    state.params.push(String(stateCode));
  }
  if (query.owner_id !== undefined && query.owner_id !== null && query.owner_id !== "") {
    clauses.push("i.owner_id = ?");
    state.params.push(Number(query.owner_id));
  }
  if (query.organization_id !== undefined && query.organization_id !== null && query.organization_id !== "") {
    clauses.push("i.organization_id = ?");
    state.params.push(Number(query.organization_id));
  }
  if (query.date_from) {
    clauses.push("i.updated_at >= ?");
    state.params.push(String(query.date_from));
  }
  if (query.date_to) {
    clauses.push("i.updated_at <= ?");
    state.params.push(String(query.date_to));
  }
  if (query.exclude_deleted !== false && !(query.statuses || []).includes("deleted")) {
    clauses.push("i.status != 'deleted'");
  }

  const tags = compileTags(query.tags || [], state);
  if (tags) clauses.push(tags);

  if (query.filters?.length) {
    for (const filter of query.filters) clauses.push(compileFilter(filter, state));
  }
  if (query.condition) clauses.push(compileCondition(query.condition, state));

  if (query.relationship) {
    const rel = compileRelationshipFilter(query.relationship, state);
    if (rel) clauses.push(rel);
  }
  if (query.related_to) clauses.push(compileRelatedTo(query.related_to, state));

  if (!clauses.length) return { where: "1 = 1", params: [] };
  return { where: clauses.join(" AND "), params: state.params };
}

const SORT_SQL = {
  modified: "i.updated_at DESC, i.id DESC",
  created: "i.created_at DESC, i.id DESC",
  title: "lower(i.title) ASC, i.id ASC",
  type: "i.object_type ASC, lower(i.title) ASC",
  owner: "i.owner_name ASC, lower(i.title) ASC",
  relevance: "i.updated_at DESC, i.id DESC",
};

function compileSort(query) {
  const sorts = Array.isArray(query.sorts) ? query.sorts.filter((entry) => entry?.field) : [];
  if (!sorts.length) return SORT_SQL[query.sort] || SORT_SQL.relevance;
  const parts = sorts.map((entry) => {
    const direction = String(entry.direction).toUpperCase() === "DESC" ? "DESC" : "ASC";
    return `${columnExpression(entry.field)} ${direction}`;
  });
  parts.push("i.id DESC");
  return parts.join(", ");
}

// Normalises a canonical index document (camelCase / spec shape) into the
// internal denormalised document consumed by the index writer.
export function normalizeIndexDocument(input = {}) {
  const tenantId = input.tenantId ?? input.tenant_id;
  const objectType = input.objectType ?? input.object_type;
  const objectId = input.objectId ?? input.object_id;
  if (tenantId === undefined || tenantId === null) throw new HttpError(400, "A tenantId is required to index a document");
  if (!objectType || !objectId) throw new HttpError(400, "objectType and objectId are required to index a document");
  const attributes = input.attributes && typeof input.attributes === "object" ? input.attributes : {};
  const tags = Array.isArray(input.tags) ? input.tags : [];
  const summary = input.description ?? input.summary ?? "";
  const searchableText =
    input.searchableText ??
    input.searchable_text ??
    [input.code, input.title, input.name, summary, tags.join(" "), JSON.stringify(attributes)]
      .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
      .join(" \n ")
      .toLowerCase();
  return {
    tenantId: Number(tenantId),
    organizationId: input.organizationId ?? input.organization_id ?? null,
    siteId: input.siteId ?? input.site_id ?? null,
    objectType: String(objectType),
    objectId: String(objectId),
    objectUuid: input.objectUuid ?? input.object_uuid ?? null,
    code: input.code || "",
    title: input.title ?? input.name ?? "",
    subtitle: input.subtitle || "",
    summary: String(summary || ""),
    searchableText,
    externalReference: input.externalReference ?? input.external_reference ?? input.external_ref ?? "",
    status: input.status || "active",
    lifecycleState: input.lifecycleState ?? input.lifecycle_state ?? "",
    ownerId: input.ownerId ?? input.owner_id ?? null,
    ownerName: input.ownerName ?? input.owner_name ?? "",
    classification: input.classification || "internal",
    tags,
    attributes,
    relationships: Array.isArray(input.relationships) ? input.relationships : [],
    revisions: input.versionId ?? input.revisions ?? "",
    sourceRevision: input.revisionId ?? input.sourceRevision ?? input.source_revision ?? null,
    scoreWeight: Number(input.scoreWeight ?? input.score_weight ?? 1),
  };
}

export const SEARCH_PROVIDER_METHODS = ["search", "index", "bulkIndex", "update", "delete", "rebuild", "health"];

export function assertSearchProvider(provider, name = "provider") {
  const missing = SEARCH_PROVIDER_METHODS.filter((method) => typeof provider?.[method] !== "function");
  if (missing.length) {
    throw new Error(`Search ${name} is missing required method(s): ${missing.join(", ")}`);
  }
  return provider;
}

function providerIndex(db, document) {
  const doc = normalizeIndexDocument(document);
  upsertIndexRow(db, doc);
  return publicIndexedDocument(indexRowOf(db, doc.tenantId, doc.objectType, doc.objectId));
}

function indexRowOf(db, tenantId, objectType, objectId) {
  return queryOne(
    db,
    "SELECT * FROM search_index WHERE tenant_id = ? AND object_type = ? AND object_id = ?",
    [Number(tenantId), String(objectType), String(objectId)]
  );
}

export const relationalProvider = {
  name: DEFAULT_PROVIDER,
  capabilities: {
    full_text: true,
    attributes: true,
    facets: true,
    relationships: true,
    sorting: true,
    pagination: true,
    highlighting: "client",
    lifecycle: true,
  },
  search(db, query, context = {}) {
    const compiled = compileWhere(query, context);
    const countRow = queryOne(
      db,
      `SELECT COUNT(*) AS total FROM search_index i WHERE ${compiled.where}`,
      compiled.params
    );
    const orderBy = compileSort(query);
    const limit = Math.max(1, Math.min(Number(context.maxResults) || 500, 5000));
    const rows = queryAll(
      db,
      `SELECT i.* FROM search_index i WHERE ${compiled.where} ORDER BY ${orderBy} LIMIT ?`,
      [...compiled.params, limit]
    );
    return { total: countRow?.total || 0, rows, compiled };
  },
  facets(db, query, facetFields, context = {}) {
    const compiled = compileWhere(query, context);
    const results = [];
    for (const field of facetFields) {
      results.push(facetForField(db, field, compiled));
    }
    return results;
  },
  suggest(db, query, context = {}) {
    const compiled = compileWhere(query, context);
    const term = normalizeText(query.text);
    const params = [...compiled.params];
    let where = compiled.where;
    if (term) {
      where += " AND lower(i.title) LIKE ?";
      params.push(`%${term}%`);
    }
    const limit = Math.max(1, Math.min(Number(context.limit) || 10, 50));
    const titles = queryAll(
      db,
      `SELECT i.title AS value, i.object_type, COUNT(*) AS count
       FROM search_index i WHERE ${where}
       GROUP BY lower(i.title) ORDER BY count DESC, lower(i.title) ASC LIMIT ?`,
      [...params, limit]
    );
    return titles;
  },
  // Index lifecycle. These methods are what makes the provider replaceable: a
  // future OpenSearch provider implements the same seven methods.
  index(db, document) {
    return providerIndex(db, document);
  },
  bulkIndex(db, documents = []) {
    const items = Array.isArray(documents) ? documents : [];
    const indexed = [];
    for (const document of items) indexed.push(providerIndex(db, document));
    return { indexed: indexed.length, documents: indexed };
  },
  update(db, document) {
    return providerIndex(db, document);
  },
  delete(db, reference, context = {}) {
    if (reference && typeof reference === "object") {
      const tenantId = reference.tenantId ?? reference.tenant_id;
      const objectType = reference.objectType ?? reference.object_type;
      const objectId = reference.objectId ?? reference.object_id;
      deleteIndexRow(db, Number(tenantId), objectType, objectId);
      return { deleted: true, objectType, objectId };
    }
    const [objectType, objectId] = String(reference).split(":");
    const tenantId = context.tenantId ?? context.tenant_id;
    if (!tenantId) throw new HttpError(400, "tenantId is required to delete an indexed document");
    deleteIndexRow(db, Number(tenantId), objectType, objectId);
    return { deleted: true, objectType, objectId };
  },
  rebuild(db, options = {}) {
    const tenantId = options.tenantId ?? options.tenant_id;
    if (!tenantId) throw new HttpError(400, "tenantId is required to rebuild an index");
    const objectType = options.objectType ?? options.object_type;
    if (objectType) {
      return reindexType(db, { tenantId, objectType, limit: options.limit }, options.actor ?? null, options.ip ?? null);
    }
    return reindexTenant(db, { tenantId, limit: options.limit }, options.actor ?? null, options.ip ?? null);
  },
  health(db, options = {}) {
    const status = indexingStatus(db, { tenantId: options.tenantId ?? options.tenant_id });
    return {
      status: "up",
      provider: DEFAULT_PROVIDER,
      capabilities: relationalProvider.capabilities,
      documents: status.documents_total,
      queue: status.queue,
      lastIndexedAt: status.last_indexed_at,
    };
  },
};

// The relational provider is also exposed under the `sqlite` name used by the
// spec's initial implementation; both names resolve to the same engine.
registerSearchProvider("sqlite", relationalProvider);
registerSearchProvider(DEFAULT_PROVIDER, relationalProvider);

const ATTRIBUTE_FACETS = new Set(["tags"]);

function facetForField(db, field, compiled) {
  if (ATTRIBUTE_FACETS.has(field)) {
    const rows = queryAll(
      db,
      `SELECT i.tags_json FROM search_index i WHERE ${compiled.where} LIMIT 2000`,
      compiled.params
    );
    const counts = new Map();
    for (const row of rows) {
      let tags = [];
      try {
        tags = JSON.parse(row.tags_json || "[]");
      } catch {
        tags = [];
      }
      for (const tag of tags) counts.set(String(tag), (counts.get(String(tag)) || 0) + 1);
    }
    return {
      field,
      values: [...counts.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, 50),
    };
  }
  const expression = columnExpression(field);
  const rows = queryAll(
    db,
    `SELECT ${expression} AS value, COUNT(*) AS count
     FROM search_index i WHERE ${compiled.where}
     GROUP BY value ORDER BY count DESC LIMIT 50`,
    compiled.params
  );
  return {
    field,
    values: rows
      .filter((row) => row.value !== null && row.value !== undefined && row.value !== "")
      .map((row) => ({ value: row.value, count: row.count })),
  };
}

export { compileSort, columnExpression };

