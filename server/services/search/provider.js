// Search provider abstraction. The relational provider is the default and
// compiles declarative queries into parameterised SQLite. Alternative engines
// (for example a dedicated index server) can be registered under a new name
// without changing the search service or its callers.
import { queryAll, queryOne } from "../../db.js";
import { HttpError } from "../../validation.js";
import {
  FILTERABLE_COLUMNS,
  ATTRIBUTE_PREFIX,
  assertFilterOperator,
  assertConditionOperator,
  CONDITION_DEPTH_MAX,
  CONDITION_COUNT_MAX,
  normalizeText,
  tokenize,
} from "./validation.js";

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

const NUMERIC_COLUMNS = new Set(["owner_id", "organization_id", "tenant_id"]);

function columnExpression(field) {
  if (typeof field !== "string" || !field) {
    throw new HttpError(400, "Each filter needs a field");
  }
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
  return `(${children.join(operator === "or" ? " OR " : " AND ")})`;
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

export function compileWhere(query, { allowedTypes, tenantId, scope, organizationIds } = {}) {
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

export const relationalProvider = {
  name: DEFAULT_PROVIDER,
  capabilities: { full_text: true, attributes: true, facets: true, relationships: true, highlighting: "client" },
  search(db, query, context = {}) {
    const compiled = compileWhere(query, context);
    const countRow = queryOne(
      db,
      `SELECT COUNT(*) AS total FROM search_index i WHERE ${compiled.where}`,
      compiled.params
    );
    const orderBy = SORT_SQL[query.sort] || SORT_SQL.relevance;
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
};

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

registerSearchProvider(DEFAULT_PROVIDER, relationalProvider);
