// Acceptance-criteria evaluation service.
//
// A small, pure, declarative rule evaluator used to decide whether a recorded test
// result satisfies its acceptance criteria. It is deliberately database-free so the
// same rules run identically in the API, in background jobs and in tests; unit
// conversion reuses the Classification unit model via `convertValue`.
//
// Supported leaves: comparison (eq/ne/lt/lte/gt/gte) with optional numeric
// tolerance, inclusive/exclusive ranges, allowed-value sets, categorical/expected
// outcome equality, boolean truth, regex/contains matching, step-completion and
// explicit manual outcomes. Supported combinators: `all`/`and`, `any`/`or`,
// `not`. A missing or invalid measurement is never PASS: it is NOT_EVALUABLE.
import { convertValue } from "../classification/units.js";
import { parseObject, normalizeUpper, normalizeText } from "../data-lifecycle/validation.js";

export const EVALUATION_OUTCOMES = Object.freeze(["PASS", "FAIL", "NOT_EVALUABLE"]);

export const CRITERIA_OPERATORS = Object.freeze([
  "eq", "ne", "lt", "lte", "gt", "gte", "between", "in", "not_in", "contains", "matches",
  "boolean", "step_complete", "expected_outcome", "manual", "custom",
]);

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBoolValue(value) {
  if (typeof value === "boolean") return value;
  const s = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "pass", "passed", "ok", "on"].includes(s)) return true;
  if (["false", "0", "no", "n", "fail", "failed", "off"].includes(s)) return false;
  return null;
}

function isMissing(value) {
  return value === null || value === undefined || value === "";
}

function verdict(ok, reason) {
  return { outcome: ok ? "PASS" : "FAIL", reason };
}

function notEvaluable(reason) {
  return { outcome: "NOT_EVALUABLE", reason };
}

function invert(result) {
  if (result.outcome === "PASS") return { outcome: "FAIL", reason: `not(${result.reason})` };
  if (result.outcome === "FAIL") return { outcome: "PASS", reason: `not(${result.reason})` };
  return result;
}

function combine(mode, results) {
  const outcomes = results.map((r) => r.outcome);
  if (!outcomes.length) return notEvaluable(`empty ${mode} criteria`);
  if (mode === "all") {
    if (outcomes.includes("FAIL")) return { outcome: "FAIL", reason: results.find((r) => r.outcome === "FAIL")?.reason || "one or more conditions failed" };
    if (outcomes.every((o) => o === "PASS")) return { outcome: "PASS", reason: "all conditions satisfied" };
    return notEvaluable("one or more conditions could not be evaluated");
  }
  if (outcomes.includes("PASS")) return { outcome: "PASS", reason: results.find((r) => r.outcome === "PASS")?.reason || "at least one condition satisfied" };
  if (outcomes.every((o) => o === "FAIL")) return { outcome: "FAIL", reason: "all conditions failed" };
  return notEvaluable("no condition could be evaluated");
}

function unitContext(node, ctx) {
  const expectedUnit = node.unit ?? node.expected_unit ?? node.expectedUnit ?? null;
  const actualUnit = ctx.actualUnit ?? node.actual_unit ?? node.actualUnit ?? null;
  return { expectedUnit, actualUnit, units: ctx.units || null };
}

// Convert the expected value into the actual's unit so the comparison is
// dimensionally valid. Returns { value, converted, compatible }.
function normalizeExpectedWithUnit(node, expected, ctx) {
  const { expectedUnit, actualUnit, units } = unitContext(node, ctx);
  if (!expectedUnit || !actualUnit || normalizeUpper(expectedUnit) === normalizeUpper(actualUnit)) {
    return { value: expected, converted: false, compatible: true };
  }
  const numeric = toNumber(expected);
  if (numeric === null) return { value: expected, converted: false, compatible: true };
  try {
    const converted = convertValue(numeric, expectedUnit, actualUnit, { units, strict: Boolean(units) });
    return { value: converted.value, converted: true, compatible: converted.compatible !== false, unit: converted.unit };
  } catch (error) {
    return { value: expected, converted: false, compatible: false, error: error?.message };
  }
}

function evalLeaf(node, ctx) {
  const rawActual = ctx.actual !== undefined && ctx.actual !== null ? ctx.actual : node.actual;
  const operator = String(node.operator || node.op || "").trim().toLowerCase();
  const expectedRaw = ctx.expected !== undefined ? ctx.expected : node.expected !== undefined ? node.expected : node.value !== undefined ? node.value : node.target;
  const resolved = operator
    || (node.regex !== undefined || node.pattern !== undefined ? "matches"
      : node.min !== undefined || node.max !== undefined ? "between"
        : Array.isArray(node.allowed) || Array.isArray(node.values) || Array.isArray(node.in) ? "in"
          : node.expected_outcome !== undefined || node.expectedOutcome !== undefined ? "expected_outcome"
            : node.boolean !== undefined ? "boolean"
              : expectedRaw !== undefined ? "eq" : "");

  if (!resolved) return notEvaluable("no acceptance criteria defined");

  if (resolved === "manual") {
    const manual = toBoolValue(node.outcome ?? node.value ?? node.passed);
    if (manual === null) return notEvaluable("manual evaluation pending");
    return verdict(manual, "manual evaluation");
  }

  if (resolved === "custom") {
    const ok = toBoolValue(node.pass ?? node.passed ?? node.satisfied);
    return ok === null ? notEvaluable("custom rule not resolved") : verdict(ok, "custom rule");
  }

  if (resolved === "step_complete" || resolved === "complete") {
    if (isMissing(rawActual) && rawActual !== false && rawActual !== 0) return notEvaluable("no step completion recorded");
    const done = toBoolValue(rawActual);
    if (done === null) return notEvaluable("step completion not recorded");
    return verdict(done, "step completion");
  }

  if (resolved === "boolean" || resolved === "is_true" || resolved === "is_false") {
    const actualBool = toBoolValue(rawActual);
    const expectedBool = toBoolValue(node.expected_bool ?? node.expectedBool ?? expectedRaw ?? true);
    if (actualBool === null) return notEvaluable("no boolean actual recorded");
    const wanted = resolved === "is_false" ? false : resolved === "is_true" ? true : expectedBool ?? true;
    return verdict(actualBool === wanted, `boolean ${actualBool} == ${wanted}`);
  }

  if (resolved === "expected_outcome") {
    const wanted = normalizeUpper(node.expected_outcome ?? node.expectedOutcome ?? expectedRaw ?? "");
    const actual = normalizeUpper(rawActual);
    if (isMissing(rawActual)) return notEvaluable("no outcome recorded");
    return verdict(actual === wanted, `outcome ${actual} == ${wanted}`);
  }

  if (resolved === "matches" || resolved === "regex") {
    const pattern = node.regex ?? node.pattern ?? expectedRaw;
    if (pattern === undefined || pattern === null) return notEvaluable("no regex pattern provided");
    try {
      return verdict(new RegExp(String(pattern)).test(String(rawActual ?? "")), `${rawActual} matches /${pattern}/`);
    } catch {
      return notEvaluable(`invalid regex: ${pattern}`);
    }
  }

  if (resolved === "contains") {
    if (isMissing(rawActual)) return notEvaluable("no actual value recorded");
    const needle = String(node.substring ?? expectedRaw ?? "");
    return verdict(String(rawActual).includes(needle), `${rawActual} contains ${needle}`);
  }

  if (resolved === "in" || resolved === "not_in") {
    if (isMissing(rawActual)) return notEvaluable("no actual value recorded");
    const list = (Array.isArray(node.allowed) ? node.allowed : Array.isArray(node.values) ? node.values : Array.isArray(node.in) ? node.in : []).map((v) => String(v));
    const present = list.includes(String(rawActual));
    return resolved === "in" ? verdict(present, `${rawActual} in [${list.join(", ")}]`) : verdict(!present, `${rawActual} not in [${list.join(", ")}]`);
  }

  // Numeric / ordered comparisons.
  if (isMissing(rawActual)) return notEvaluable("no actual value recorded");
  const normalized = normalizeExpectedWithUnit(node, expectedRaw, ctx);
  if (!normalized.compatible) return notEvaluable(`incompatible or unknown unit conversion (${normalized.error || "unit"})`);
  const actualNum = toNumber(rawActual);
  const expectedNum = toNumber(normalized.value);
  const tolerance = toNumber(node.tolerance);
  const reasonSuffix = normalized.converted ? ` (expected ${normalized.value} ${normalized.unit})` : "";

  switch (resolved) {
    case "eq":
    case "equals":
    case "==": {
      if (actualNum !== null && expectedNum !== null) {
        return verdict(tolerance !== null ? Math.abs(actualNum - expectedNum) <= tolerance : actualNum === expectedNum, `${rawActual} ${tolerance !== null ? "~=" : "=="} ${expectedRaw}${reasonSuffix}`);
      }
      return verdict(String(rawActual) === String(expectedRaw), `${rawActual} == ${expectedRaw}`);
    }
    case "ne":
    case "!=":
      if (actualNum !== null && expectedNum !== null) return verdict(actualNum !== expectedNum, `${rawActual} != ${expectedRaw}`);
      return verdict(String(rawActual) !== String(expectedRaw), `${rawActual} != ${expectedRaw}`);
    case "lt":
    case "<":
      return numericCompare(actualNum, expectedNum, (a, b) => a < b, rawActual, expectedRaw, "<");
    case "lte":
    case "<=":
      return numericCompare(actualNum, expectedNum, (a, b) => a <= b, rawActual, expectedRaw, "<=");
    case "gt":
    case ">":
      return numericCompare(actualNum, expectedNum, (a, b) => a > b, rawActual, expectedRaw, ">");
    case "gte":
    case ">=":
      return numericCompare(actualNum, expectedNum, (a, b) => a >= b, rawActual, expectedRaw, ">=");
    case "between": {
      const min = toNumber(node.min);
      const max = toNumber(node.max);
      if (actualNum === null || (min === null && max === null)) return notEvaluable("incomplete range criteria");
      const lowerOk = min === null || (node.minInclusive === false || node.min_inclusive === false ? actualNum > min : actualNum >= min);
      const upperOk = max === null || (node.maxInclusive === false || node.max_inclusive === false ? actualNum < max : actualNum <= max);
      const bounds = `${node.minInclusive === false || node.min_inclusive === false ? "(" : "["}${node.min ?? "-inf"}, ${node.max ?? "+inf"}${node.maxInclusive === false || node.max_inclusive === false ? ")" : "]"}`;
      return verdict(lowerOk && upperOk, `${rawActual} in ${bounds}`);
    }
    default:
      return notEvaluable(`unsupported operator: ${resolved}`);
  }
}

function numericCompare(actual, expected, fn, rawActual, rawExpected, symbol) {
  if (actual === null || expected === null) return notEvaluable("non-numeric comparison");
  return verdict(fn(actual, expected), `${rawActual} ${symbol} ${rawExpected}`);
}

function walk(node, ctx) {
  if (Array.isArray(node)) return combine("all", node.map((child) => walk(child, ctx)));
  if (!node || typeof node !== "object") return notEvaluable("invalid criteria");
  if (node.all !== undefined || node.and !== undefined) return combine("all", asArray(node.all ?? node.and).map((child) => walk(child, ctx)));
  if (node.any !== undefined || node.or !== undefined) return combine("any", asArray(node.any ?? node.or).map((child) => walk(child, ctx)));
  if (node.not !== undefined) return invert(walk(node.not, ctx));
  return evalLeaf(node, ctx);
}

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

// Public entry point. `criteria` accepts an object, a JSON string or logical
// combinators. `actualValue` is the recorded result; `expectedOverride` (optional)
// replaces the criteria's expected value. `context` may carry `actualUnit`,
// `units` (from classification), `evidenceCount` and `evidenceRequired` for
// downstream evidence-gating (returned as `evidenceSatisfied`).
export function evaluateCriteria(criteriaInput, actualValue, expectedOverride = undefined, context = {}) {
  const criteria = typeof criteriaInput === "string" ? safeParse(criteriaInput) : parseObject(criteriaInput, {});
  const ctx = { ...context, actual: actualValue, expected: expectedOverride };
  const result = walk(criteria, ctx);
  return {
    outcome: EVALUATION_OUTCOMES.includes(result.outcome) ? result.outcome : "NOT_EVALUABLE",
    reason: normalizeText(result.reason, { max: 500 }),
    evaluated: result.outcome !== "NOT_EVALUABLE",
  };
}

function safeParse(text) {
  const trimmed = String(text).trim();
  if (!trimmed) return {};
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return { expected: text };
    }
  }
  return { expected: text };
}

// Describes the rule that produced an outcome so it can be persisted alongside the
// result (criteria + version + normalized values remain traceable).
export function describeEvaluation(criteriaInput, evaluation, context = {}) {
  const criteria = typeof criteriaInput === "string" ? safeParse(criteriaInput) : parseObject(criteriaInput, {});
  return {
    criteria,
    outcome: evaluation.outcome,
    reason: evaluation.reason,
    actual_unit: context.actualUnit ?? null,
    expected_unit: context.expectedUnit ?? null,
    evidence_required: Boolean(context.evidenceRequired),
    evidence_count: Number(context.evidenceCount || 0),
  };
}
