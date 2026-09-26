// Query engine (§9, §10).
//
// Turns a validated ReportQuery into a result set. It never assembles SQL from
// user input: data sources return authorized flat records and every filter,
// group, aggregation and calculated field is evaluated in a controlled,
// whitelisted runtime. Operators, aggregations, entities and attributes are
// validated against the semantic layer before a single row is read.
import {
  AGGREGATIONS,
  LOGICAL_OPERATORS,
  OPERATORS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_ROWS,
  MAX_GROUP_ROWS,
  MAX_FILTERS,
  MAX_AGGREGATIONS,
  MAX_CALCULATED_FIELDS,
  MAX_COLUMNS,
} from "./constants.js";
import { invalidQuery, invalidExpression, unsupportedOperator, unsupportedAggregation, queryTimeout, rowLimitExceeded } from "./errors.js";
import { getEntity, entityAttributeMap } from "./semantic.js";
import { resolveDataSourceRows } from "./datasources.js";

// ── Definition validation / normalization ───────────────────────────────────

export function normalizeQuery(spec = {}) {
  const entity = getEntity(spec.entity);
  const attributeMap = entityAttributeMap(entity.code);
  const check = (attribute, context) => {
    if (!attribute) throw invalidQuery(`${context} is required`);
    if (!attributeMap.has(String(attribute))) throw invalidQuery(`Unknown attribute ${attribute} on entity ${entity.code}`);
    return String(attribute);
  };

  const columns = (spec.columns || []).slice(0, MAX_COLUMNS).map((column) => {
    const attribute = typeof column === "string" ? column : column.attribute;
    return { attribute: check(attribute, "Column attribute"), label: column.label || attributeMap.get(attribute)?.name || attribute };
  });

  const filters = normalizeFilters(spec.filters || [], attributeMap);
  const groupBy = (spec.group_by || spec.groupBy || []).map((entry) => check(typeof entry === "string" ? entry : entry.attribute, "Group attribute"));

  const aggregations = (spec.aggregations || []).slice(0, MAX_AGGREGATIONS).map((aggregation) => {
    const fn = String(aggregation.function || aggregation.fn || "").toUpperCase();
    if (!AGGREGATIONS.includes(fn)) throw unsupportedAggregation(fn);
    const attribute = aggregation.attribute === null || aggregation.attribute === "*" ? null : check(aggregation.attribute, "Aggregation attribute");
    const alias = aggregation.alias || defaultAlias(fn, attribute);
    return { function: fn, attribute, alias, filters: normalizeFilters(aggregation.filters || [], attributeMap), formula: aggregation.formula || "" };
  });

  const calculatedFields = (spec.calculated_fields || spec.calculatedFields || []).slice(0, MAX_CALCULATED_FIELDS).map((field) => {
    if (!field.alias) throw invalidQuery("Calculated field requires an alias");
    const expression = String(field.expression || "");
    assertExpression(expression);
    return { alias: String(field.alias), expression, label: field.label || field.alias };
  });

  const sort = (spec.sort || []).map((entry) => ({
    target: String(entry.attribute || entry.alias || entry.target || ""),
    direction: String(entry.direction || entry.order || "ASC").toUpperCase() === "DESC" ? "DESC" : "ASC",
  }));

  return {
    entity: entity.code,
    data_source: (spec.data_source || spec.dataSource || "OBJECT_MODEL").toString().toUpperCase(),
    columns,
    filters,
    condition: spec.condition || null,
    group_by: groupBy,
    aggregations,
    calculated_fields: calculatedFields,
    sort,
    page: Math.max(1, Number(spec.page) || 1),
    page_size: Math.min(MAX_PAGE_SIZE, Math.max(1, Number(spec.page_size || spec.pageSize) || DEFAULT_PAGE_SIZE)),
    parameters: spec.parameters || {},
    parameters_declared: spec.parameters_declared || spec.parametersDeclared || [],
    visualization: spec.visualization || {},
    limits: spec.limits || {},
  };
}

function normalizeFilters(filters, attributeMap) {
  if (!Array.isArray(filters)) return [];
  return filters.slice(0, MAX_FILTERS).map((filter) => {
    const operator = String(filter.operator || "EQ").toUpperCase();
    if (!OPERATORS.includes(operator)) throw unsupportedOperator(operator);
    const attribute = String(filter.attribute || "");
    if (!attributeMap.has(attribute)) throw invalidQuery(`Unknown attribute ${attribute} in filter`);
    return { attribute, operator, value: filter.value, values: filter.values };
  });
}

function defaultAlias(fn, attribute) {
  const base = attribute ? `${fn.toLowerCase()}_${attribute}` : fn.toLowerCase();
  return base.replace(/[^a-z0-9_]+/gi, "_");
}

// ── Parameter binding ───────────────────────────────────────────────────────

export function applyParameters(query, provided = {}) {
  const scope = { ...provided };
  for (const declared of query.parameters_declared || []) {
    const name = declared.name;
    if (name === undefined || name === null || name === "") continue;
    const hasValue = provided[name] !== undefined && provided[name] !== null && provided[name] !== "";
    if (!hasValue) {
      if (declared.default !== undefined && declared.default !== null) scope[name] = declared.default;
      else if (declared.required) throw invalidQuery(`Missing required parameter: ${name}`);
    }
  }
  const substitute = (value) => {
    if (value && typeof value === "object" && !Array.isArray(value) && (value.parameter || value.param)) {
      const name = value.parameter || value.param;
      return scope[name] === undefined ? null : scope[name];
    }
    return value;
  };
  query.filters = query.filters.map((filter) => ({ ...filter, value: substitute(filter.value), values: Array.isArray(filter.values) ? filter.values.map(substitute) : filter.values }));
  query.aggregations = query.aggregations.map((aggregation) => ({
    ...aggregation,
    filters: aggregation.filters.map((filter) => ({ ...filter, value: substitute(filter.value), values: Array.isArray(filter.values) ? filter.values.map(substitute) : filter.values })),
  }));
  return query;
}

// ── Filter evaluation ───────────────────────────────────────────────────────

function valueOf(record, attribute) {
  return record.attributes ? record.attributes[attribute] : record[attribute];
}

export function matchesFilter(record, filter) {
  const actual = valueOf(record, filter.attribute);
  const expected = filter.value;
  switch (filter.operator) {
    case "EQ":
      return compareEqual(actual, expected);
    case "NEQ":
      return !compareEqual(actual, expected);
    case "GT":
      return toNumber(actual) > toNumber(expected);
    case "GTE":
      return toNumber(actual) >= toNumber(expected);
    case "LT":
      return toNumber(actual) < toNumber(expected);
    case "LTE":
      return toNumber(actual) <= toNumber(expected);
    case "IN": {
      const list = Array.isArray(filter.values) ? filter.values : Array.isArray(expected) ? expected : String(expected ?? "").split(",").map((entry) => entry.trim());
      return list.some((entry) => compareEqual(actual, entry));
    }
    case "NOT_IN": {
      const list = Array.isArray(filter.values) ? filter.values : Array.isArray(expected) ? expected : String(expected ?? "").split(",").map((entry) => entry.trim());
      return !list.some((entry) => compareEqual(actual, entry));
    }
    case "CONTAINS":
      return actual !== null && actual !== undefined && String(actual).toLowerCase().includes(String(expected ?? "").toLowerCase());
    case "STARTS_WITH":
      return actual !== null && actual !== undefined && String(actual).toLowerCase().startsWith(String(expected ?? "").toLowerCase());
    case "ENDS_WITH":
      return actual !== null && actual !== undefined && String(actual).toLowerCase().endsWith(String(expected ?? "").toLowerCase());
    case "IS_NULL":
      return actual === null || actual === undefined || actual === "";
    case "IS_NOT_NULL":
      return !(actual === null || actual === undefined || actual === "");
    case "BETWEEN": {
      const [low, high] = Array.isArray(expected) ? expected : [filter.from, filter.to];
      return toNumber(actual) >= toNumber(low) && toNumber(actual) <= toNumber(high);
    }
    default:
      throw unsupportedOperator(filter.operator);
  }
}

function compareEqual(actual, expected) {
  if (actual === null || actual === undefined) return expected === null || expected === undefined || expected === "";
  if (expected === null || expected === undefined) return false;
  if (typeof actual === "number" || typeof expected === "number") {
    const a = toNumber(actual);
    const b = toNumber(expected);
    if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
  }
  return String(actual) === String(expected);
}

function toNumber(value) {
  if (typeof value === "number") return value;
  if (value === null || value === undefined || value === "") return NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function matchesCondition(record, condition) {
  if (!condition) return true;
  const type = String(condition.type || condition.logic || "AND").toUpperCase();
  if (!LOGICAL_OPERATORS.includes(type) && !["AND", "OR", "NOT"].includes(type)) throw unsupportedOperator(type);
  const conditions = condition.conditions || [];
  if (type === "NOT") return !matchesCondition(record, conditions[0] || { type: "AND", conditions: [] });
  if (type === "OR") return conditions.some((entry) => matchesCondition(record, entry));
  return conditions.every((entry) => matchesCondition(record, entry));
}

function filterRecords(records, filters, condition) {
  return records.filter((record) => filters.every((filter) => matchesFilter(record, filter)) && matchesCondition(record, condition));
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export function aggregateRows(rows, aggregation) {
  const fn = aggregation.function;
  let source = rows;
  if (aggregation.filters?.length) source = rows.filter((record) => aggregation.filters.every((filter) => matchesFilter(record, filter)));
  const values = aggregation.attribute === null ? source : source.map((record) => valueOf(record, aggregation.attribute)).filter((value) => value !== null && value !== undefined && value !== "");
  switch (fn) {
    case "COUNT":
      return source.length;
    case "COUNT_DISTINCT":
      return new Set(values.map((value) => String(value))).size;
    case "SUM":
      return round(values.reduce((sum, value) => sum + (Number(value) || 0), 0));
    case "AVG":
      return values.length ? round(values.reduce((sum, value) => sum + (Number(value) || 0), 0) / values.length) : null;
    case "MIN":
      return values.length ? round(Math.min(...values.map((value) => toNumber(value)).filter((value) => Number.isFinite(value)))) : null;
    case "MAX":
      return values.length ? round(Math.max(...values.map((value) => toNumber(value)).filter((value) => Number.isFinite(value)))) : null;
    case "PERCENTAGE":
    case "RATIO":
      return computeDerivedAggregation(aggregation, rows);
    default:
      throw unsupportedAggregation(fn);
  }
}

function computeDerivedAggregation(aggregation, rows) {
  if (!aggregation.formula) throw unsupportedAggregation(aggregation.function);
  throw invalidExpression(`Derived aggregation ${aggregation.function} must be expressed as a calculated field, not an aggregation`);
}

function round(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1e6) / 1e6;
}

// ── Safe calculated-field expression evaluator ──────────────────────────────
// Supports numbers, identifiers, unary minus, + - * / and parentheses. No
// property access, no function calls, no eval — an expression can only read
// named aggregation values from the current scope.

export function assertExpression(expression) {
  if (!expression || typeof expression !== "string") throw invalidExpression("Expression must be a non-empty string");
  tokenize(expression);
  return true;
}

const TOKEN = /\s*(\d+(?:\.\d+)?|\.\d+|[A-Za-z_][A-Za-z0-9_]*|[()+\-*/])/y;

function tokenize(expression) {
  const tokens = [];
  let index = 0;
  TOKEN.lastIndex = 0;
  while (index < expression.length) {
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(expression);
    if (!match || match.index !== index) throw invalidExpression(`Unsupported token in expression: ${expression.slice(index, index + 8)}`);
    tokens.push(match[1]);
    index = TOKEN.lastIndex;
  }
  return tokens;
}

export function evaluateExpression(expression, scope) {
  const tokens = tokenize(expression);
  let position = 0;
  const peek = () => tokens[position];
  const consume = () => tokens[position++];
  const parseFactor = () => {
    const token = consume();
    if (token === undefined) throw invalidExpression("Unexpected end of expression");
    if (token === "(") {
      const value = parseExpression();
      if (consume() !== ")") throw invalidExpression("Unbalanced parentheses");
      return value;
    }
    if (token === "-") return -parseFactor();
    if (/^\d/.test(token) || /^\.\d/.test(token)) return Number(token);
    const value = scope[token];
    if (value === undefined || value === null || value === "") return 0;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  };
  const parseTerm = () => {
    let value = parseFactor();
    while (peek() === "*" || peek() === "/") {
      const operator = consume();
      const right = parseFactor();
      value = operator === "*" ? value * right : right === 0 ? 0 : value / right;
    }
    return value;
  };
  const parseExpression = () => {
    let value = parseTerm();
    while (peek() === "+" || peek() === "-") {
      const operator = consume();
      const right = parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };
  const result = parseExpression();
  if (position !== tokens.length) throw invalidExpression("Unexpected trailing tokens in expression");
  return round(result);
}

// ── Execution ───────────────────────────────────────────────────────────────

export function executeQuery(db, tenantId, spec, context = {}) {
  const started = Date.now();
  const maxExecutionMs = Number(context.maxExecutionMs) || 30000;
  const maxRows = Number(context.maxRows) || MAX_ROWS;
  const maxGroupRows = Number(context.maxGroupRows) || MAX_GROUP_ROWS;
  const query = applyParameters(normalizeQuery(spec), context.parameters || {});

  const checkTime = () => {
    if (Date.now() - started > maxExecutionMs) throw queryTimeout(maxExecutionMs, { entity: query.entity });
  };

  const resolved = resolveDataSourceRows(db, query.data_source, {
    entity: query.entity,
    tenantId,
    actor: context.actor,
    organizationId: context.organizationId ?? null,
    ip: context.ip ?? null,
    context: context.securityContext ?? null,
    limit: Math.max(maxRows, maxGroupRows),
    options: context.options || {},
  });
  checkTime();

  const filtered = filterRecords(resolved.records, query.filters, query.condition);
  const hasAggregations = query.aggregations.length > 0;

  let columns;
  let rows;
  let truncated = false;

  if (hasAggregations) {
    const grouped = query.group_by.length ? groupRecords(filtered, query.group_by) : [{ key: {}, rows: filtered }];
    if (grouped.length > maxGroupRows) {
      truncated = true;
    }
    const sliced = grouped.slice(0, maxGroupRows);
    rows = sliced.map((group) => buildAggregateRow(group, query));
    columns = buildAggregateColumns(query);
    sortRows(rows, query.sort, columns);
  } else {
    columns = query.columns.length ? query.columns : defaultColumns(query.entity, query.columns);
    rows = filtered.map((record) => projectRow(record, columns, query.entity));
    sortRows(rows, query.sort, columns);
    if (rows.length > maxRows) {
      rows = rows.slice(0, maxRows);
      truncated = true;
    }
  }

  checkTime();
  const total = rows.length;
  const offset = (query.page - 1) * query.page_size;
  const pageRows = rows.slice(offset, offset + query.page_size);

  return {
    entity: query.entity,
    data_source: query.data_source,
    query_type: hasAggregations ? (query.group_by.length ? "ANALYTICAL" : "SUMMARY") : "TABULAR",
    columns: columns.map((column) => ({ attribute: column.attribute || column.alias, alias: column.alias || column.attribute, label: column.label || column.alias || column.attribute })),
    rows: pageRows,
    total,
    page: query.page,
    page_size: query.page_size,
    groups: hasAggregations ? rows.length : 0,
    truncated,
    denied: resolved.denied,
    scanned: resolved.total_before_security,
    visualization: query.visualization,
    took_ms: Date.now() - started,
  };
}

function defaultColumns(entityCode, columns) {
  const entity = getEntity(entityCode);
  const chosen = columns.length ? columns : entity.attributes.filter((attribute) => !attribute.derived).slice(0, 6);
  return chosen.map((attribute) => ({ attribute: attribute.attribute || attribute.code, label: attribute.label || attribute.name }));
}

function projectRow(record, columns, entityCode) {
  const map = entityAttributeMap(entityCode);
  const row = {};
  for (const column of columns) {
    const attribute = map.get(column.attribute);
    row[column.alias || column.attribute] = attribute ? record.attributes[column.attribute] : undefined;
  }
  return row;
}

function groupRecords(records, groupBy) {
  const groups = new Map();
  for (const record of records) {
    const key = {};
    for (const attribute of groupBy) key[attribute] = record.attributes[attribute] ?? null;
    const signature = JSON.stringify(key);
    if (!groups.has(signature)) groups.set(signature, { key, rows: [] });
    groups.get(signature).rows.push(record);
  }
  return [...groups.values()];
}

function buildAggregateColumns(query) {
  return [
    ...query.group_by.map((attribute) => ({ attribute, alias: attribute, label: attribute })),
    ...query.aggregations.map((aggregation) => ({ attribute: aggregation.alias, alias: aggregation.alias, label: aggregation.alias })),
    ...query.calculated_fields.map((field) => ({ attribute: field.alias, alias: field.alias, label: field.label })),
  ];
}

function buildAggregateRow(group, query) {
  const row = { ...group.key };
  const scope = { ...group.key };
  for (const aggregation of query.aggregations) {
    const value = aggregateRows(group.rows, aggregation);
    row[aggregation.alias] = value;
    scope[aggregation.alias] = value;
  }
  for (const field of query.calculated_fields) {
    try {
      row[field.alias] = evaluateExpression(field.expression, scope);
      scope[field.alias] = row[field.alias];
    } catch (error) {
      row[field.alias] = null;
      row[`${field.alias}__error`] = error.message;
    }
  }
  return row;
}

function sortRows(rows, sort, columns) {
  if (!sort.length) return rows;
  const valid = new Set(columns.map((column) => column.alias || column.attribute));
  const active = sort.filter((entry) => valid.has(entry.target));
  if (!active.length) return rows;
  rows.sort((left, right) => {
    for (const entry of active) {
      const a = left[entry.target];
      const b = right[entry.target];
      if (a === b) continue;
      if (a === null || a === undefined) return 1;
      if (b === null || b === undefined) return -1;
      const comparison = typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b));
      if (comparison !== 0) return entry.direction === "DESC" ? -comparison : comparison;
    }
    return 0;
  });
  return rows;
}

export function queryTypeOf(spec) {
  const hasAggregations = (spec.aggregations || []).length > 0;
  if (!hasAggregations) return "TABULAR";
  return (spec.group_by || spec.groupBy || []).length ? "ANALYTICAL" : "SUMMARY";
}
