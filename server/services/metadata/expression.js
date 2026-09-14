import { HttpError } from "../../validation.js";

// A deliberately small, whitelisted JSON expression language. Rules are stored
// as data (never code) and interpreted here, so a malicious or buggy rule can
// never execute arbitrary JavaScript. Unknown operators and shape violations
// are rejected up front.

const MAX_DEPTH = 32;
const MAX_NODES = 2000;
const MAX_REGEX_LENGTH = 200;

const COMPARISON_OPS = new Set(["eq", "ne", "gt", "gte", "lt", "lte"]);
const LIST_OPS = new Set(["in", "not_in", "contains", "not_contains", "starts_with", "ends_with"]);
const LOGIC_OPS = new Set(["and", "or", "not"]);
const LEAF_OPS = new Set(["value", "literal", "is_empty", "is_not_empty", "matches", "not_matches", "len"]);

export const SUPPORTED_OPERATORS = [
  ...LOGIC_OPS,
  ...COMPARISON_OPS,
  ...LIST_OPS,
  ...LEAF_OPS,
];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function has(node, key) {
  return Object.prototype.hasOwnProperty.call(node, key);
}

function bad(message) {
  return new HttpError(400, `Invalid rule expression: ${message}`);
}

// Validates the structural shape of an expression tree without evaluating it.
export function validateExpression(node, depth = 0, counter = { n: 0 }) {
  if (++counter.n > MAX_NODES) throw bad("expression is too large");
  if (depth > MAX_DEPTH) throw bad("expression is nested too deeply");
  if (node === null || node === undefined) throw bad("missing expression node");
  const type = typeof node;
  if (type === "boolean" || type === "number" || type === "string") return node;
  if (Array.isArray(node)) {
    for (const item of node) validateExpression(item, depth + 1, counter);
    return node;
  }
  if (!isPlainObject(node)) throw bad("node must be an object, array or literal");
  const op = node.op;
  if (!op || typeof op !== "string") throw bad("node is missing an op");
  if (!SUPPORTED_OPERATORS.includes(op)) throw bad(`unsupported operator "${op}"`);
  if (op === "literal") {
    if (!has(node, "value")) throw bad("literal node requires a value");
    return node;
  }
  if (op === "value") {
    if (typeof node.path !== "string" || !node.path.trim()) throw bad("value node requires a path");
    return node;
  }
  if (LOGIC_OPS.has(op)) {
    const args = op === "not" ? [node.arg ?? node.args?.[0]] : node.args;
    if (!Array.isArray(args) || args.length === 0) throw bad(`"${op}" requires args`);
    if (op === "not" && args.length !== 1) throw bad('"not" requires exactly one argument');
    for (const arg of args) validateExpression(arg, depth + 1, counter);
    return node;
  }
  if (op === "len") {
    validateExpression(node.arg ?? node.left, depth + 1, counter);
    return node;
  }
  if (op === "is_empty" || op === "is_not_empty") {
    validateExpression(node.arg ?? node.left, depth + 1, counter);
    return node;
  }
  if (COMPARISON_OPS.has(op) || LIST_OPS.has(op) || op === "matches" || op === "not_matches") {
    validateExpression(node.left, depth + 1, counter);
    if (!has(node, "right") && !LIST_OPS.has(op) && op !== "matches" && op !== "not_matches") {
      throw bad(`"${op}" requires a right operand`);
    }
    if (has(node, "right")) validateExpression(node.right, depth + 1, counter);
    return node;
  }
  throw bad(`unsupported operator "${op}"`);
}

// Resolves a dotted path against the rule context. Attribute codes themselves
// contain dots (e.g. `asset.name`), so resolution first tries the longest
// matching key before falling back to true nested traversal. This lets rules
// address `values.asset.name` as well as genuinely nested objects.
export function resolvePath(context, path) {
  if (!path || typeof path !== "string") return undefined;
  const segments = path.split(".");
  const roots = [
    ["values", context?.values],
    ["record", context?.record],
    ["user", context?.user],
    ["organization", context?.organization],
    ["org", context?.org],
  ];
  for (const [name, root] of roots) {
    if (segments[0] === name && root !== null && root !== undefined) {
      return resolveWithin(root, segments.slice(1));
    }
  }
  if (context && (isPlainObject(context) || typeof context === "object")) {
    return resolveWithin(context, segments);
  }
  return undefined;
}

function resolveWithin(obj, segments) {
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj !== "object") return segments.length ? undefined : obj;
  if (!segments.length) return obj;
  const joined = segments.join(".");
  if (has(obj, joined)) return obj[joined];
  let current = obj;
  for (let i = 0; i < segments.length; i += 1) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === "object" && has(current, segments[i])) {
      current = current[segments[i]];
    } else {
      const rest = segments.slice(i).join(".");
      if (typeof current === "object" && has(current, rest)) return current[rest];
      return undefined;
    }
  }
  return current;
}

function isEmpty(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return NaN;
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return Number(value);
}

function looseEqual(left, right) {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (typeof left === "boolean" || typeof right === "boolean") {
    const normalize = (v) => (v === true || v === 1 || v === "1" || v === "true" ? 1 : v === false || v === 0 || v === "0" || v === "false" ? 0 : v);
    return normalize(left) === normalize(right);
  }
  if (typeof left === "number" || typeof right === "number") {
    const a = toNumber(left);
    const b = toNumber(right);
    if (!Number.isNaN(a) && !Number.isNaN(b)) return a === b;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    const a = Array.isArray(left) ? left : [left];
    const b = Array.isArray(right) ? right : [right];
    return a.length === b.length && a.every((item, i) => looseEqual(item, b[i]));
  }
  return String(left) === String(right);
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === null || value === undefined) return [];
  return [value];
}

function safeRegex(pattern) {
  if (typeof pattern !== "string") throw bad("matches requires a string pattern");
  if (pattern.length > MAX_REGEX_LENGTH) throw bad("regex pattern is too long");
  try {
    return new RegExp(pattern);
  } catch {
    throw bad("invalid regex pattern");
  }
}

function evaluateOperand(operand, context, depth, counter) {
  if (isPlainObject(operand) && typeof operand.op === "string") {
    return evaluateNode(operand, context, depth, counter);
  }
  if (Array.isArray(operand)) {
    return operand.map((item) => evaluateOperand(item, context, depth, counter));
  }
  return operand;
}

function evaluateComparison(op, node, context, depth, counter) {
  const left = evaluateOperand(node.left, context, depth + 1, counter);
  const right = evaluateOperand(node.right, context, depth + 1, counter);
  switch (op) {
    case "eq":
      return looseEqual(left, right);
    case "ne":
      return !looseEqual(left, right);
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const a = toNumber(left);
      const b = toNumber(right);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      if (op === "gt") return a > b;
      if (op === "gte") return a >= b;
      if (op === "lt") return a < b;
      return a <= b;
    }
    case "in":
      return toArray(right).some((item) => looseEqual(left, item));
    case "not_in":
      return !toArray(right).some((item) => looseEqual(left, item));
    case "contains":
      if (Array.isArray(left)) return left.some((item) => looseEqual(item, right));
      return String(left ?? "").includes(String(right ?? ""));
    case "not_contains":
      if (Array.isArray(left)) return !left.some((item) => looseEqual(item, right));
      return !String(left ?? "").includes(String(right ?? ""));
    case "starts_with":
      return String(left ?? "").startsWith(String(right ?? ""));
    case "ends_with":
      return String(left ?? "").endsWith(String(right ?? ""));
    case "matches":
      return safeRegex(right).test(String(left ?? ""));
    case "not_matches":
      return !safeRegex(right).test(String(left ?? ""));
    default:
      throw bad(`unsupported operator "${op}"`);
  }
}

function evaluateNode(node, context, depth, counter) {
  if (++counter.n > MAX_NODES) throw bad("expression is too large");
  if (depth > MAX_DEPTH) throw bad("expression is nested too deeply");
  if (!isPlainObject(node) || typeof node.op !== "string") {
    if (Array.isArray(node)) return node;
    return node;
  }
  const { op } = node;
  if (op === "literal") return node.value;
  if (op === "value") return resolvePath(context, node.path);
  if (op === "and") {
    validateArgs(node, op);
    return node.args.every((arg) => Boolean(evaluateNode(arg, context, depth + 1, counter)));
  }
  if (op === "or") {
    validateArgs(node, op);
    return node.args.some((arg) => Boolean(evaluateNode(arg, context, depth + 1, counter)));
  }
  if (op === "not") {
    const arg = node.arg ?? node.args?.[0];
    return !Boolean(evaluateNode(arg, context, depth + 1, counter));
  }
  if (COMPARISON_OPS.has(op) || LIST_OPS.has(op) || op === "matches" || op === "not_matches") {
    return evaluateComparison(op, node, context, depth, counter);
  }
  if (op === "is_empty") return isEmpty(evaluateOperand(node.arg ?? node.left, context, depth + 1, counter));
  if (op === "is_not_empty") return !isEmpty(evaluateOperand(node.arg ?? node.left, context, depth + 1, counter));
  if (op === "len") {
    const value = evaluateOperand(node.arg ?? node.left, context, depth + 1, counter);
    if (value === null || value === undefined) return 0;
    if (Array.isArray(value) || typeof value === "string") return value.length;
    return 0;
  }
  throw bad(`unsupported operator "${op}"`);
}

function validateArgs(node, op) {
  if (!Array.isArray(node.args) || node.args.length === 0) {
    throw bad(`"${op}" requires args`);
  }
}

// Evaluates an expression to a boolean using only whitelisted operators.
export function evaluate(expression, context = {}) {
  const counter = { n: 0 };
  return Boolean(evaluateNode(expression, context, 0, counter));
}

// Evaluates an expression to a raw value (used by default-value rules).
export function evaluateValue(expression, context = {}) {
  const counter = { n: 0 };
  return evaluateOperand(expression, context, 0, counter);
}

export function expressionSummary(expression) {
  if (!isPlainObject(expression)) return String(expression);
  return expression.op ? `op:${expression.op}` : "literal";
}
