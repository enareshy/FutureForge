// Shared normalization, parsing, date math, assertion helpers and the **safe**
// expression evaluator for the Import & Export Framework. Pure functions only:
// no database access, so they can be unit-tested in isolation and reused by the
// engine, the resolver and the jobs.
//
// The expression evaluator is a small recursive-descent parser. It never calls
// eval/Function and only exposes an allowlisted function set, so user-supplied
// expressions cannot execute arbitrary code (spec §10, §58).
import { HttpError } from "../../validation.js";
import {
  CONNECTOR_TYPES,
  CONNECTOR_CAPABILITIES,
  DIRECTIONS,
  DEFINITION_STATUSES,
  EXECUTION_MODES,
  DUPLICATE_STRATEGIES,
  DUPLICATE_KEY_TYPES,
  ERROR_STRATEGIES,
  TRANSACTION_STRATEGIES,
  RECONCILIATION_STRATEGIES,
  MAPPING_TYPES,
  TRANSFORMATION_TYPES,
  TRANSFORMATION_STAGES,
  VALIDATION_LEVELS,
  VALIDATION_SEVERITIES,
  IMPORT_STATUSES,
  EXPORT_STATUSES,
  EXPORT_FORMATS,
  EXPORT_DESTINATIONS,
  EXPORT_FILTER_TYPES,
  FILTER_OPERATORS,
  SORT_DIRECTIONS,
  LOOKUP_MATCH_MODES,
  TEMPLATE_DIRECTIONS,
  CONNECTOR_DIRECTIONS,
  STORAGE_PROVIDER_TYPES,
  ERROR_TYPES,
  CONFIG_DEFAULTS,
  CONFIG_BOUNDS,
} from "./constants.js";
import {
  invalidDefinition,
  invalidMapping,
  invalidValidation,
  invalidTransformation,
  invalidMode,
  invalidDuplicateStrategy,
  invalidConnector,
  invalidExport,
  invalidConfiguration,
} from "./errors.js";

// ── Normalization ────────────────────────────────────────────────────────────

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

export function paginate(query = {}, { defaultPageSize = 50, maxPageSize = 500 } = {}) {
  const page = Math.max(1, toInt(query.page, 1) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, toInt(query.pageSize ?? query.page_size, defaultPageSize) || defaultPageSize));
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

export function sortParams(query = {}, allowed = [], fallback = "id") {
  const column = allowed.includes(String(query.sort)) ? String(query.sort) : fallback;
  const direction = String(query.order || query.direction || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  return { column, direction: SORT_DIRECTIONS.includes(direction.toLowerCase()) ? direction : "DESC" };
}

// ── Assertions ───────────────────────────────────────────────────────────────

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

export const assertDirection = (value) => assertEnum(normalizeUpper(value), DIRECTIONS, "Direction", invalidDefinition);
export const assertConnectorType = (value) => assertEnum(normalizeUpper(value), CONNECTOR_TYPES, "Connector type", invalidConnector);
export const assertCapability = (value) => assertEnum(normalizeUpper(value), CONNECTOR_CAPABILITIES, "Connector capability", invalidConnector);
export const assertConnectorDirection = (value) => assertEnum(normalizeUpper(value), CONNECTOR_DIRECTIONS, "Connector direction", invalidConnector);
export const assertDefinitionStatus = (value) => assertEnum(normalizeUpper(value), DEFINITION_STATUSES, "Definition status", invalidDefinition);
export const assertExecutionMode = (value) => assertEnum(normalizeUpper(value), EXECUTION_MODES, "Execution mode", invalidMode);
export const assertDuplicateStrategy = (value) => assertEnum(normalizeUpper(value), DUPLICATE_STRATEGIES, "Duplicate strategy", invalidDuplicateStrategy);
export const assertDuplicateKeyType = (value) => assertEnum(normalizeUpper(value), DUPLICATE_KEY_TYPES, "Duplicate key type", invalidDefinition);
export const assertErrorStrategy = (value) => assertEnum(normalizeUpper(value), ERROR_STRATEGIES, "Error strategy", invalidDefinition);
export const assertTransactionStrategy = (value) => assertEnum(normalizeUpper(value), TRANSACTION_STRATEGIES, "Transaction strategy", invalidDefinition);
export const assertReconciliationStrategy = (value) => assertEnum(normalizeUpper(value), RECONCILIATION_STRATEGIES, "Reconciliation strategy", invalidDefinition);
export const assertMappingType = (value) => assertEnum(normalizeUpper(value), MAPPING_TYPES, "Mapping type", invalidMapping);
export const assertTransformationType = (value) => assertEnum(normalizeUpper(value), TRANSFORMATION_TYPES, "Transformation type", invalidTransformation);
export const assertTransformationStage = (value) => assertEnum(normalizeUpper(value), TRANSFORMATION_STAGES, "Transformation stage", invalidTransformation);
export const assertValidationLevel = (value) => assertEnum(normalizeUpper(value), VALIDATION_LEVELS, "Validation level", invalidValidation);
export const assertSeverity = (value) => assertEnum(normalizeUpper(value), VALIDATION_SEVERITIES, "Validation severity", invalidValidation);
export const assertImportStatus = (value) => assertEnum(normalizeUpper(value), IMPORT_STATUSES, "Import status", invalidDefinition);
export const assertExportStatus = (value) => assertEnum(normalizeUpper(value), EXPORT_STATUSES, "Export status", invalidDefinition);
export const assertExportFormat = (value) => assertEnum(normalizeUpper(value), EXPORT_FORMATS, "Export format", invalidExport);
export const assertExportDestination = (value) => assertEnum(normalizeUpper(value), EXPORT_DESTINATIONS, "Export destination", invalidExport);
export const assertFilterType = (value) => assertEnum(normalizeUpper(value), EXPORT_FILTER_TYPES, "Filter type", invalidExport);
export const assertFilterOperator = (value) => assertEnum(normalizeLower(value), FILTER_OPERATORS, "Filter operator", invalidExport);
export const assertLookupMode = (value) => assertEnum(normalizeUpper(value), LOOKUP_MATCH_MODES, "Lookup match mode", invalidMapping);
export const assertTemplateDirection = (value) => assertEnum(normalizeUpper(value), TEMPLATE_DIRECTIONS, "Template direction", invalidDefinition);
export const assertStorageProvider = (value) => assertEnum(normalizeUpper(value), STORAGE_PROVIDER_TYPES, "Storage provider", invalidExport);
export const assertErrorType = (value) => assertEnum(normalizeUpper(value), ERROR_TYPES, "Error type", invalidDefinition);

export function assertTenantId(tenantId) {
  const n = Number(tenantId);
  if (!Number.isInteger(n) || n <= 0) {
    throw new HttpError(400, "A valid tenant is required for this operation");
  }
  return n;
}

// Configuration values are validated against the type of their default so a bad
// value can never reach the engine.
export function assertConfigurationValue(key, value) {
  if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)) {
    throw invalidConfiguration(`Unknown configuration key: ${key}`, { key, allowed: Object.keys(CONFIG_DEFAULTS) });
  }
  const fallback = CONFIG_DEFAULTS[key];
  if (Array.isArray(fallback)) {
    if (!Array.isArray(value)) throw invalidConfiguration(`${key} must be an array`, { key });
    return value.map((entry) => normalizeText(entry, { max: 200 }));
  }
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

export function assertBatchSize(value, { max = 5000, fallback = 500 } = {}) {
  const n = toInt(value, fallback) || fallback;
  if (n < 1 || n > max) throw invalidDefinition(`Batch size must be between 1 and ${max}`);
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

export function addDays(base, days) {
  const date = parseDate(base);
  if (!date) return null;
  return new Date(date.getTime() + (Number(days) || 0) * 24 * 60 * 60 * 1000).toISOString();
}

export function isPast(value, reference = nowIso()) {
  const date = parseDate(value);
  if (!date) return false;
  const ref = parseDate(reference);
  return date.getTime() <= ref.getTime();
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

// ── Safe expression language ─────────────────────────────────────────────────
//
// Grammar (subset, intentionally small):
//   expr    := ternary
//   ternary := or ( '?' expr ':' expr )?
//   or      := and ( '||' and )*
//   and     := equality ( '&&' equality )*
//   equality:= comparison ( ('=='|'!=') comparison )*
//   comparison := additive ( ('<'|'<='|'>'|'>=') additive )*
//   additive:= multiplicative ( ('+'|'-') multiplicative )*
//   multiplicative := unary ( ('*'|'/'|'%') unary )*
//   unary   := ('!'|'-') unary | primary
//   primary := number | string | boolean | null | path | call | '(' expr ')'
//   call    := IDENT '(' (expr (',' expr)*)? ')'
//   path    := IDENT ('.' IDENT | '[' number ']')*

const EXPRESSION_FUNCTIONS = Object.freeze({
  trim: (v) => String(v ?? "").trim(),
  upper: (v) => String(v ?? "").toUpperCase(),
  uppercase: (v) => String(v ?? "").toUpperCase(),
  lower: (v) => String(v ?? "").toLowerCase(),
  lowercase: (v) => String(v ?? "").toLowerCase(),
  length: (v) => (v === null || v === undefined ? 0 : String(v).length),
  substring: (v, start, len) => {
    const s = String(v ?? "");
    const from = Number(start) || 0;
    return len === undefined ? s.slice(from) : s.slice(from, from + (Number(len) || 0));
  },
  replace: (v, find, replaceWith) => String(v ?? "").split(String(find ?? "")).join(String(replaceWith ?? "")),
  concat: (...args) => args.map((a) => (a === null || a === undefined ? "" : String(a))).join(""),
  split: (v, separator, index) => {
    const parts = String(v ?? "").split(String(separator ?? ","));
    return index === undefined ? parts : parts[Number(index) || 0] ?? null;
  },
  coalesce: (...args) => args.find((a) => a !== null && a !== undefined && a !== "") ?? null,
  default: (v, fallback) => (v === null || v === undefined || v === "" ? fallback : v),
  number: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`Cannot convert "${v}" to number`);
    return n;
  },
  integer: (v) => {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) throw new Error(`Cannot convert "${v}" to integer`);
    return n;
  },
  round: (v, digits) => {
    const factor = 10 ** (Number(digits) || 0);
    return Math.round(Number(v) * factor) / factor;
  },
  floor: (v) => Math.floor(Number(v)),
  ceil: (v) => Math.ceil(Number(v)),
  abs: (v) => Math.abs(Number(v)),
  min: (...args) => Math.min(...args.map(Number)),
  max: (...args) => Math.max(...args.map(Number)),
  upper_first: (v) => String(v ?? "").replace(/\b\w/g, (c) => c.toUpperCase()),
  capitalize: (v) => String(v ?? "").replace(/\b\w/g, (c) => c.toUpperCase()),
  to_string: (v) => (v === null || v === undefined ? "" : String(v)),
  to_number: (v) => Number(v),
});

export function expressionFunctionNames() {
  return Object.keys(EXPRESSION_FUNCTIONS);
}

function tokenizeExpression(input) {
  const tokens = [];
  const source = String(input ?? "");
  let i = 0;
  const isDigit = (c) => c >= "0" && c <= "9";
  const isIdentStart = (c) => /[A-Za-z_$]/.test(c);
  const isIdent = (c) => /[A-Za-z0-9_$]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(source[i + 1]))) {
      let num = "";
      while (i < source.length && (isDigit(source[i]) || source[i] === ".")) num += source[i++];
      tokens.push({ type: "number", value: Number(num) });
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let str = "";
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < source.length) {
          const next = source[i + 1];
          str += next === "n" ? "\n" : next === "t" ? "\t" : next;
          i += 2;
        } else {
          str += source[i++];
        }
      }
      if (source[i] !== quote) throw invalidExpression("Unterminated string literal in expression");
      i += 1;
      tokens.push({ type: "string", value: str });
      continue;
    }
    if (isIdentStart(c)) {
      let name = "";
      while (i < source.length && isIdent(source[i])) name += source[i++];
      tokens.push({ type: "ident", value: name });
      continue;
    }
    const two = source.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      tokens.push({ type: "op", value: two });
      i += 2;
      continue;
    }
    if ("+-*/%<>!?:.,()[]".includes(c)) {
      tokens.push({ type: "op", value: c });
      i += 1;
      continue;
    }
    throw invalidExpression(`Unexpected character "${c}" in expression`);
  }
  return tokens;
}

class ExpressionParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }

  expect(value) {
    const token = this.next();
    if (!token || token.value !== value) throw invalidExpression(`Expected "${value}" in expression`);
    return token;
  }

  isOp(value) {
    const token = this.peek();
    return token && token.type === "op" && token.value === value;
  }

  parse() {
    const node = this.parseTernary();
    if (this.pos < this.tokens.length) throw invalidExpression("Unexpected trailing tokens in expression");
    return node;
  }

  parseTernary() {
    const condition = this.parseOr();
    if (this.isOp("?")) {
      this.next();
      const consequent = this.parseTernary();
      this.expect(":");
      const alternate = this.parseTernary();
      return { type: "ternary", condition, consequent, alternate };
    }
    return condition;
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.isOp("||")) {
      this.next();
      left = { type: "binary", op: "||", left, right: this.parseAnd() };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseEquality();
    while (this.isOp("&&")) {
      this.next();
      left = { type: "binary", op: "&&", left, right: this.parseEquality() };
    }
    return left;
  }

  parseEquality() {
    let left = this.parseComparison();
    while (this.isOp("==") || this.isOp("!=")) {
      const op = this.next().value;
      left = { type: "binary", op, left, right: this.parseComparison() };
    }
    return left;
  }

  parseComparison() {
    let left = this.parseAdditive();
    while (this.isOp("<") || this.isOp("<=") || this.isOp(">") || this.isOp(">=")) {
      const op = this.next().value;
      left = { type: "binary", op, left, right: this.parseAdditive() };
    }
    return left;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().value;
      left = { type: "binary", op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = this.next().value;
      left = { type: "binary", op, left, right: this.parseUnary() };
    }
    return left;
  }

  parseUnary() {
    if (this.isOp("!") || this.isOp("-")) {
      const op = this.next().value;
      return { type: "unary", op, argument: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.peek();
    if (!token) throw invalidExpression("Unexpected end of expression");
    if (token.type === "number" || token.type === "string") {
      this.next();
      return { type: "literal", value: token.value };
    }
    if (token.type === "ident") {
      this.next();
      const name = token.value;
      if (name === "true" || name === "false") return { type: "literal", value: name === "true" };
      if (name === "null") return { type: "literal", value: null };
      if (this.isOp("(")) {
        this.next();
        const args = [];
        if (!this.isOp(")")) {
          args.push(this.parseTernary());
          while (this.isOp(",")) {
            this.next();
            args.push(this.parseTernary());
          }
        }
        this.expect(")");
        return { type: "call", name, args };
      }
      return this.parsePathTail({ type: "path", root: name, segments: [] });
    }
    if (this.isOp("(")) {
      this.next();
      const node = this.parseTernary();
      this.expect(")");
      return node;
    }
    if (this.isOp("[")) {
      this.next();
      const items = [];
      if (!this.isOp("]")) {
        items.push(this.parseTernary());
        while (this.isOp(",")) {
          this.next();
          items.push(this.parseTernary());
        }
      }
      this.expect("]");
      return { type: "array", items };
    }
    throw invalidExpression("Unexpected token in expression");
  }

  parsePathTail(node) {
    while (this.isOp(".") || this.isOp("[")) {
      if (this.isOp(".")) {
        this.next();
        const token = this.next();
        if (!token || token.type !== "ident") throw invalidExpression("Expected a property name after '.'");
        node.segments.push({ key: token.value });
      } else {
        this.next();
        const token = this.next();
        if (!token || token.type !== "number") throw invalidExpression("Expected a numeric index in expression");
        this.expect("]");
        node.segments.push({ index: token.value });
      }
    }
    return node;
  }
}

export function compileExpression(expression) {
  const text = String(expression ?? "").trim();
  if (!text) throw invalidExpression("Expression is empty");
  const parser = new ExpressionParser(tokenizeExpression(text));
  return parser.parse();
}

function resolvePath(context, node) {
  let value = context?.[node.root];
  for (const segment of node.segments) {
    if (value === null || value === undefined) return undefined;
    value = segment.index !== undefined ? value[segment.index] : value[segment.key];
  }
  return value;
}

function evaluateNode(node, context) {
  switch (node.type) {
    case "literal":
      return node.value;
    case "path":
      return resolvePath(context, node);
    case "array":
      return node.items.map((item) => evaluateNode(item, context));
    case "unary": {
      const value = evaluateNode(node.argument, context);
      if (node.op === "!") return !value;
      return -Number(value);
    }
    case "ternary":
      return evaluateNode(node.condition, context) ? evaluateNode(node.consequent, context) : evaluateNode(node.alternate, context);
    case "call": {
      const fn = EXPRESSION_FUNCTIONS[node.name] || EXPRESSION_FUNCTIONS[node.name.toLowerCase()];
      if (!fn) throw invalidExpression(`Function "${node.name}" is not permitted in expressions`);
      return fn(...node.args.map((arg) => evaluateNode(arg, context)));
    }
    case "binary": {
      const { op } = node;
      if (op === "&&") return Boolean(evaluateNode(node.left, context)) && Boolean(evaluateNode(node.right, context));
      if (op === "||") return Boolean(evaluateNode(node.left, context)) || Boolean(evaluateNode(node.right, context));
      const left = evaluateNode(node.left, context);
      const right = evaluateNode(node.right, context);
      switch (op) {
        case "==":
          return left === right || (left != null && right != null && String(left) === String(right));
        case "!=":
          return !(left === right || (left != null && right != null && String(left) === String(right)));
        case "<":
          return left < right;
        case "<=":
          return left <= right;
        case ">":
          return left > right;
        case ">=":
          return left >= right;
        case "+":
          return Number(left) + Number(right);
        case "-":
          return Number(left) - Number(right);
        case "*":
          return Number(left) * Number(right);
        case "/":
          return Number(left) / Number(right);
        case "%":
          return Number(left) % Number(right);
        default:
          throw invalidExpression(`Unsupported operator "${op}" in expression`);
      }
    }
    default:
      throw invalidExpression("Unsupported expression node");
  }
}

// Validates an expression without executing it (used by mapping validation).
export function validateExpression(expression) {
  try {
    compileExpression(expression);
    return { valid: true, errors: [] };
  } catch (error) {
    return { valid: false, errors: [{ code: "invalid_expression", message: error.message }] };
  }
}

export function evaluateExpression(expression, context = {}) {
  if (typeof expression === "function") return expression(context);
  const ast = compileExpression(expression);
  return evaluateNode(ast, context);
}

// Resolves an expression reference used by mappings/transformations: a literal,
// a `{{ path }}` template, or a bare expression.
export function resolveValueExpression(expression, context = {}) {
  if (expression === null || expression === undefined) return undefined;
  if (typeof expression !== "string") return expression;
  const template = expression.trim();
  if (template.startsWith("{{") && template.endsWith("}}")) {
    const inner = template.slice(2, -2).trim();
    return evaluateExpression(inner, context);
  }
  return evaluateExpression(template, context);
}

export function applyTemplate(template, context) {
  return String(template ?? "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr) => {
    const value = evaluateExpression(expr, context);
    return value === null || value === undefined ? "" : String(value);
  });
}

// Vocabulary surfaced by REST /meta so a UI can build pickers without hardcoding.
export function vocabulary() {
  return {
    directions: DIRECTIONS,
    connector_types: CONNECTOR_TYPES,
    connector_capabilities: CONNECTOR_CAPABILITIES,
    definition_statuses: DEFINITION_STATUSES,
    execution_modes: EXECUTION_MODES,
    duplicate_strategies: DUPLICATE_STRATEGIES,
    duplicate_key_types: DUPLICATE_KEY_TYPES,
    error_strategies: ERROR_STRATEGIES,
    transaction_strategies: TRANSACTION_STRATEGIES,
    reconciliation_strategies: RECONCILIATION_STRATEGIES,
    mapping_types: MAPPING_TYPES,
    transformation_types: TRANSFORMATION_TYPES,
    transformation_stages: TRANSFORMATION_STAGES,
    validation_levels: VALIDATION_LEVELS,
    validation_severities: VALIDATION_SEVERITIES,
    import_statuses: IMPORT_STATUSES,
    export_statuses: EXPORT_STATUSES,
    export_formats: EXPORT_FORMATS,
    export_destinations: EXPORT_DESTINATIONS,
    export_filter_types: EXPORT_FILTER_TYPES,
    filter_operators: FILTER_OPERATORS,
    sort_directions: SORT_DIRECTIONS,
    lookup_match_modes: LOOKUP_MATCH_MODES,
    template_directions: TEMPLATE_DIRECTIONS,
    connector_directions: CONNECTOR_DIRECTIONS,
    storage_provider_types: STORAGE_PROVIDER_TYPES,
    error_types: ERROR_TYPES,
    expression_functions: expressionFunctionNames(),
  };
}
