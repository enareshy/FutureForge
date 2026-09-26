// Rule expression compiler/validator and evaluator.
//
// A rule is a declarative `IF <attribute> <operator> <value> THEN PASS/FAIL`
// predicate. Expressions are data, never code: they are validated against a
// strict grammar before activation and evaluated with a closed set of operators.
// There is no eval/Function, no property access beyond a dotted attribute path
// and no regular expression flag injection, so malformed or unsafe expressions
// can never execute.
import {
  OPERATORS,
  NULLARY_OPERATORS,
  RULE_TYPE_DIMENSIONS,
} from "./constants.js";
import { invalidExpression, unknownRuleType } from "./errors.js";
import { RULE_TYPES } from "./constants.js";
import { isBlank, normalizeText, readAttribute, valuePreview } from "./validation.js";

const ATTRIBUTE_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const LOGIC = ["AND", "OR"];
const ON_MATCH = ["PASS", "FAIL"];
const MAX_CONDITIONS = 50;
const MAX_VALUE_BYTES = 20000;
const MAX_PATTERN_LENGTH = 500;

// Structural rule types are evaluated by dedicated evaluators and only need an
// attribute scope, not a scalar comparison. They normalise to a null-check
// condition so the stored expression is always canonical and inspectable.
const STRUCTURAL_TYPES = new Set(["REQUIRED", "NOT_NULL", "UNIQUE", "REFERENCE"]);

export function normalizeOperator(value) {
  return normalizeText(value).toLowerCase();
}

function assertOperator(operator) {
  if (!OPERATORS.includes(operator)) {
    throw invalidExpression(`Operator "${operator}" is not allowed`, { operator, allowed: OPERATORS });
  }
  return operator;
}

const RESERVED_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function assertAttribute(attribute) {
  const path = normalizeText(attribute, { max: 200 });
  if (!ATTRIBUTE_PATH.test(path)) {
    throw invalidExpression(`Invalid attribute path "${attribute}"`, { attribute });
  }
  if (path.split(".").some((segment) => RESERVED_SEGMENTS.has(segment))) {
    throw invalidExpression(`Invalid attribute path "${attribute}"`, { attribute });
  }
  return path;
}

function compileCondition(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidExpression(`Condition ${index} must be an object`);
  }
  const attribute = assertAttribute(raw.attribute ?? raw.attribute_name ?? raw.field);
  const operator = assertOperator(normalizeOperator(raw.operator ?? raw.op));
  const condition = { attribute, operator };
  if (raw.case_sensitive !== undefined) condition.case_sensitive = Boolean(raw.case_sensitive);
  if (!NULLARY_OPERATORS.includes(operator)) {
    if (raw.value === undefined) throw invalidExpression(`Condition ${index} requires a value for operator "${operator}"`);
    condition.value = raw.value;
    if (operator === "in" || operator === "not_in" || operator === "between") {
      if (!Array.isArray(raw.value) || !raw.value.length) {
        throw invalidExpression(`Condition ${index} operator "${operator}" requires a non-empty array value`);
      }
      if (operator === "between" && raw.value.length !== 2) {
        throw invalidExpression(`Condition ${index} operator "between" requires exactly two values`);
      }
    }
    if (operator === "matches") {
      const pattern = normalizeText(raw.value, { max: MAX_PATTERN_LENGTH });
      if (pattern.length > MAX_PATTERN_LENGTH) throw invalidExpression("Pattern is too long");
      try {
        // eslint-disable-next-line no-new
        new RegExp(pattern);
      } catch (error) {
        throw invalidExpression(`Invalid regular expression: ${error.message}`);
      }
      condition.value = pattern;
    }
  }
  const serialized = JSON.stringify(condition);
  if (serialized.length > MAX_VALUE_BYTES) throw invalidExpression(`Condition ${index} is too large`);
  return condition;
}

// Validates and normalizes a rule expression. Returns the canonical stored
// shape. Throws `invalidExpression` / `unknownRuleType` on any problem.
export function compileExpression(ruleType, raw) {
  const type = normalizeText(ruleType).toUpperCase();
  if (!RULE_TYPES.includes(type)) throw unknownRuleType(ruleType);
  const input = raw && typeof raw === "object" ? raw : {};

  // Accept a shorthand single-condition form: { attribute, operator, value }.
  // Structural types accept an attribute-only form and normalise the operator.
  const structural = STRUCTURAL_TYPES.has(type);
  const attrName = input.attribute ?? input.attribute_name ?? input.field;
  const conditionsInput = Array.isArray(input.conditions)
    ? [...input.conditions]
    : attrName
      ? [{ ...input, attribute: attrName, operator: input.operator ?? input.op ?? (structural ? "is_not_null" : undefined) }]
      : [];

  if (!conditionsInput.length) {
    // Some structural rule types (UNIQUE, CROSS_OBJECT) may carry no scalar
    // condition but still need an attribute scope. Require an attribute for
    // attribute-scoped types unless the rule type is purely structural.
    throw invalidExpression("A rule expression requires at least one condition");
  }
  if (conditionsInput.length > MAX_CONDITIONS) {
    throw invalidExpression(`A rule can define at most ${MAX_CONDITIONS} conditions`);
  }

  const conditions = conditionsInput.map((condition, index) => compileCondition(condition, index + 1));
  const logic = input.logic || input.operator_logic || "AND";
  if (!LOGIC.includes(String(logic).toUpperCase())) {
    throw invalidExpression(`Expression logic must be one of: ${LOGIC.join(", ")}`);
  }
  const onMatch = String(input.on_match || input.outcome || "PASS").toUpperCase();
  if (!ON_MATCH.includes(onMatch)) {
    throw invalidExpression(`Expression on_match must be one of: ${ON_MATCH.join(", ")}`);
  }
  return {
    logic: String(logic).toUpperCase(),
    on_match: onMatch,
    type,
    conditions,
    ...(input.params && typeof input.params === "object" ? { params: input.params } : {}),
  };
}

function compareValues(actual, operator, value, caseSensitive) {
  const bothNumbers = actual !== "" && value !== "" && Number.isFinite(Number(actual)) && Number.isFinite(Number(value));
  const left = bothNumbers ? Number(actual) : actual;
  const right = bothNumbers ? Number(value) : value;

  switch (operator) {
    case "eq":
      return looseEqual(actual, value, caseSensitive);
    case "neq":
      return !looseEqual(actual, value, caseSensitive);
    case "gt":
      return left > right;
    case "gte":
      return left >= right;
    case "lt":
      return left < right;
    case "lte":
      return left <= right;
    default:
      return false;
  }
}

function looseEqual(actual, value, caseSensitive) {
  if (actual === null || actual === undefined) return value === null || value === undefined;
  if (typeof actual === "object" || typeof value === "object") {
    try {
      return JSON.stringify(actual) === JSON.stringify(value);
    } catch {
      return false;
    }
  }
  const a = String(actual);
  const b = String(value);
  return caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();
}

function stringOf(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function lengthOf(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  return String(value).length;
}

export function evaluateCondition(condition, payload) {
  const { attribute, operator } = condition;
  const actual = readAttribute(payload, attribute);
  const caseSensitive = Boolean(condition.case_sensitive);
  const value = condition.value;
  let passed = false;
  switch (operator) {
    case "is_null":
      passed = actual === null || actual === undefined;
      break;
    case "is_not_null":
      passed = actual !== null && actual !== undefined;
      break;
    case "in":
      passed = (value || []).some((candidate) => looseEqual(actual, candidate, caseSensitive));
      break;
    case "not_in":
      passed = !(value || []).some((candidate) => looseEqual(actual, candidate, caseSensitive));
      break;
    case "contains":
      passed = Array.isArray(actual)
        ? actual.some((item) => looseEqual(item, value, caseSensitive))
        : stringOf(actual).toLowerCase().includes(stringOf(value).toLowerCase());
      break;
    case "not_contains":
      passed = Array.isArray(actual)
        ? !actual.some((item) => looseEqual(item, value, caseSensitive))
        : !stringOf(actual).toLowerCase().includes(stringOf(value).toLowerCase());
      break;
    case "starts_with":
      passed = stringOf(actual).toLowerCase().startsWith(stringOf(value).toLowerCase());
      break;
    case "ends_with":
      passed = stringOf(actual).toLowerCase().endsWith(stringOf(value).toLowerCase());
      break;
    case "matches": {
      const pattern = new RegExp(value, caseSensitive ? "" : "i");
      passed = pattern.test(stringOf(actual));
      break;
    }
    case "between": {
      const n = Number(actual);
      const [min, max] = value;
      passed = Number.isFinite(n) && n >= Number(min) && n <= Number(max);
      break;
    }
    case "length_gt":
      passed = lengthOf(actual) > Number(value);
      break;
    case "length_gte":
      passed = lengthOf(actual) >= Number(value);
      break;
    case "length_lt":
      passed = lengthOf(actual) < Number(value);
      break;
    case "length_lte":
      passed = lengthOf(actual) <= Number(value);
      break;
    default:
      passed = compareValues(actual, operator, value, caseSensitive);
      break;
  }
  return {
    attribute,
    operator,
    expected: NULLARY_OPERATORS.includes(operator) ? null : value,
    actual: valuePreview(actual),
    passed,
  };
}

// Evaluates a compiled (or raw) expression against an object payload.
// `passed` reflects the declared PASS/FAIL outcome; `matched` is the raw
// aggregate of the conditions (useful for diagnostics).
export function evaluateExpression(expression, payload) {
  const compiled = Array.isArray(expression?.conditions) ? expression : compileExpression(expression?.type || "CUSTOM", expression);
  const checks = compiled.conditions.map((condition) => evaluateCondition(condition, payload));
  const matched =
    compiled.logic === "OR" ? checks.some((check) => check.passed) : checks.every((check) => check.passed);
  const outcome = compiled.on_match === "FAIL" ? !matched : matched;
  return { matched, passed: outcome, on_match: compiled.on_match, logic: compiled.logic, checks };
}

export function defaultDimensionFor(ruleType) {
  return RULE_TYPE_DIMENSIONS[String(ruleType || "").toUpperCase()] || "validity";
}

export function describeExpression(expression) {
  const compiled = Array.isArray(expression?.conditions) ? expression : null;
  if (!compiled) return "";
  const joiner = compiled.logic === "OR" ? " OR " : " AND ";
  const parts = compiled.conditions.map((condition) => {
    const value = NULLARY_OPERATORS.includes(condition.operator) ? "" : ` ${JSON.stringify(condition.value)}`;
    return `${condition.attribute} ${condition.operator}${value}`;
  });
  return `IF ${parts.join(joiner)} THEN ${compiled.on_match}`;
}

export function isBlankValue(value) {
  return isBlank(value);
}
