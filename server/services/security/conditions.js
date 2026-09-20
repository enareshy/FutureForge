// Minimal, deterministic attribute condition evaluator. Policies stay
// data-driven; richer operators can be registered without changing the engine.
import { assertionError } from "./errors.js";
import { CLASSIFICATION_RANK } from "./constants.js";

const OPERATORS = new Set([
  "eq",
  "neq",
  "in",
  "nin",
  "contains",
  "starts_with",
  "ends_with",
  "exists",
  "not_exists",
  "gt",
  "gte",
  "lt",
  "lte",
  "between",
  "in_org",
  "in_plant",
  "is_classification",
  "matches_any",
]);

export function assertOperator(operator) {
  const value = String(operator || "").trim();
  if (!OPERATORS.has(value)) throw assertionError(`Unknown operator "${operator}"`);
  return value;
}

export function resolvePath(context, path) {
  if (!path) return undefined;
  const segments = String(path).split(".");
  let current = context;
  for (const segment of segments) {
    if (current === undefined || current === null) return undefined;
    current = current[segment];
  }
  return current;
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function compareRank(left, right) {
  const a = CLASSIFICATION_RANK[left];
  const b = CLASSIFICATION_RANK[right];
  if (a === undefined || b === undefined) return null;
  return a - b;
}

function matches(operator, actual, expected) {
  switch (operator) {
    case "eq":
      return String(actual) === String(expected);
    case "neq":
      return String(actual) !== String(expected);
    case "in":
      return asArray(expected).map(String).includes(String(actual));
    case "nin":
      return !asArray(expected).map(String).includes(String(actual));
    case "contains":
      if (Array.isArray(actual)) return actual.map(String).includes(String(expected));
      return String(actual ?? "").includes(String(expected));
    case "starts_with":
      return String(actual ?? "").startsWith(String(expected));
    case "ends_with":
      return String(actual ?? "").endsWith(String(expected));
    case "exists":
      return actual !== undefined && actual !== null && actual !== "";
    case "not_exists":
      return actual === undefined || actual === null || actual === "";
    case "gt":
      return Number(actual) > Number(expected);
    case "gte":
      return Number(actual) >= Number(expected);
    case "lt":
      return Number(actual) < Number(expected);
    case "lte":
      return Number(actual) <= Number(expected);
    case "between": {
      const [min, max] = asArray(expected);
      return Number(actual) >= Number(min) && Number(actual) <= Number(max);
    }
    case "in_org":
      return asArray(expected).map(String).includes(String(actual));
    case "in_plant":
      return asArray(expected).map(String).includes(String(actual));
    case "is_classification": {
      const rank = compareRank(actual, expected);
      if (rank === null) return false;
      return rank <= 0;
    }
    case "matches_any":
      return asArray(actual).some((entry) => asArray(expected).map(String).includes(String(entry)));
    default:
      return false;
  }
}

// A condition is either a leaf { field, operator, value } or a boolean group
// { logic: "and" | "or", conditions: [...] }. Unknown shapes fail closed.
export function evaluateCondition(condition, context) {
  if (!condition || typeof condition !== "object") return true;
  if (Array.isArray(condition.conditions)) {
    const logic = String(condition.logic || "and").toLowerCase() === "or" ? "or" : "and";
    if (!condition.conditions.length) return logic === "and";
    const results = condition.conditions.map((child) => evaluateCondition(child, context));
    return logic === "and" ? results.every(Boolean) : results.some(Boolean);
  }
  const { field, operator = "eq" } = condition;
  if (!field) return true;
  const actual = resolvePath(context, field);
  if (operator === "exists") return actual !== undefined && actual !== null && actual !== "";
  if (operator === "not_exists") return actual === undefined || actual === null || actual === "";
  if (actual === undefined || actual === null) return false;
  return matches(assertOperator(operator), actual, condition.value);
}

export function describeCondition(condition) {
  if (!condition || typeof condition !== "object") return "";
  if (Array.isArray(condition.conditions)) {
    const logic = String(condition.logic || "and").toUpperCase();
    return `(${condition.conditions.map(describeCondition).join(` ${logic} `)})`;
  }
  return `${condition.field} ${condition.operator || "eq"} ${JSON.stringify(condition.value)}`;
}

export const CONDITION_OPERATORS = [...OPERATORS];
