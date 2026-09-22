// Declarative validation-rule engine.
//
// Rules are data: a level, a target field, a type, a config, and a severity.
// The engine returns a result per rule so the caller can decide what to block
// (ERROR), report (WARNING) or log (INFO). External truth (uniqueness,
// references, lookups) is resolved through injected checkers so the engine
// stays pure and testable.
import { invalidValidation } from "../errors.js";
import { evaluateExpression, normalizeUpper, toNumber } from "../validation.js";
import { getPath } from "./transform.js";

const handlers = new Map();

export function registerValidationHandler(type, handler) {
  if (!type || typeof handler !== "function") throw invalidValidation("A validation type and handler are required");
  handlers.set(normalizeUpper(type), handler);
  return type;
}

export function validationTypes() {
  return [...handlers.keys()];
}

function fail(message) {
  return { passed: false, message };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

registerValidationHandler("REQUIRED", (value) => (value === null || value === undefined || String(value).trim() === "" ? fail("Value is required") : { passed: true }));
registerValidationHandler("TYPE", (value, config) => {
  if (value === null || value === undefined || value === "") return { passed: true };
  const type = normalizeUpper(config.data_type || config.dataType || "STRING");
  const ok =
    type === "STRING" ||
    (type === "NUMBER" && Number.isFinite(Number(value))) ||
    (type === "INTEGER" && Number.isInteger(Number(value))) ||
    (type === "BOOLEAN" && ["true", "false", "1", "0"].includes(String(value).toLowerCase())) ||
    (type === "DATE" && !Number.isNaN(new Date(String(value)).getTime())) ||
    (type === "ARRAY" && Array.isArray(value)) ||
    (type === "OBJECT" && value !== null && typeof value === "object");
  return ok ? { passed: true } : fail(`Expected ${type}`);
});
registerValidationHandler("RANGE", (value, config) => {
  if (value === null || value === undefined || value === "") return { passed: true };
  const n = toNumber(value, null);
  if (n === null) return fail("Value is not numeric");
  if (config.min !== undefined && n < Number(config.min)) return fail(`Must be at least ${config.min}`);
  if (config.max !== undefined && n > Number(config.max)) return fail(`Must be at most ${config.max}`);
  return { passed: true };
});
registerValidationHandler("LENGTH", (value, config) => {
  const length = value === null || value === undefined ? 0 : String(value).length;
  if (config.min !== undefined && length < Number(config.min)) return fail(`Must be at least ${config.min} characters`);
  if (config.max !== undefined && length > Number(config.max)) return fail(`Must be at most ${config.max} characters`);
  return { passed: true };
});
registerValidationHandler("PATTERN", (value, config) => {
  if (value === null || value === undefined || value === "") return { passed: true };
  try {
    const re = new RegExp(config.pattern || config.regex || ".*");
    return re.test(String(value)) ? { passed: true } : fail(config.message || "Value does not match the required pattern");
  } catch {
    return fail("Validation pattern is invalid");
  }
});
registerValidationHandler("EMAIL", (value) => (value === null || value === undefined || value === "" || EMAIL_RE.test(String(value)) ? { passed: true } : fail("Invalid email address")));
registerValidationHandler("ENUM", (value, config) => {
  if (value === null || value === undefined || value === "") return { passed: true };
  const allowed = config.values || config.enum || [];
  return allowed.map(String).includes(String(value)) ? { passed: true } : fail(`Value must be one of: ${allowed.join(", ")}`);
});
registerValidationHandler("EXPRESSION", (value, config, ctx) => {
  try {
    const ok = evaluateExpression(config.expression || "true", { ...ctx.record, value });
    return ok ? { passed: true } : fail(config.message || "Expression evaluated to false");
  } catch (error) {
    return fail(`Expression error: ${error.message}`);
  }
});
registerValidationHandler("UNIQUE", (value, config, ctx) => {
  if (value === null || value === undefined || value === "") return { passed: true };
  if (typeof ctx.uniqueChecker !== "function") return { passed: true };
  return ctx.uniqueChecker(value, config) ? { passed: true } : fail(config.message || `Duplicate value: ${value}`);
});
registerValidationHandler("LOOKUP_EXISTS", (value, config, ctx) => {
  if (value === null || value === undefined || value === "") return { passed: true };
  if (typeof ctx.lookupChecker !== "function") return { passed: true };
  return ctx.lookupChecker(value, config) ? { passed: true } : fail(config.message || `No matching record for ${value}`);
});
registerValidationHandler("REFERENCE_EXISTS", (value, config, ctx) => {
  if (value === null || value === undefined || value === "") return { passed: true };
  if (typeof ctx.referenceChecker !== "function") return { passed: true };
  return ctx.referenceChecker(value, config) ? { passed: true } : fail(config.message || `Referenced object not found: ${value}`);
});
registerValidationHandler("DATE", (value, config) => {
  if (value === null || value === undefined || value === "") return { passed: true };
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) return fail("Invalid date");
  const now = config.reference ? new Date(String(config.reference)) : new Date();
  if (config.not_future && date.getTime() > now.getTime()) return fail("Date cannot be in the future");
  if (config.not_past && date.getTime() < now.getTime()) return fail("Date cannot be in the past");
  return { passed: true };
});

export function evaluateRule(rule, record, ctx = {}) {
  const type = normalizeUpper(rule.rule_type || rule.type);
  const handler = handlers.get(type);
  if (!handler) return { passed: false, message: `Unknown validation rule type: ${rule.rule_type}`, severity: "ERROR", unknown: true };
  const value = getPath(record, rule.target_field || "");
  const result = handler(value, rule.config || {}, { ...ctx, record });
  return {
    rule: rule.rule_type || rule.type,
    field: rule.target_field || "",
    level: normalizeUpper(rule.level || "FIELD"),
    severity: normalizeUpper(rule.severity || "ERROR"),
    passed: Boolean(result.passed),
    message: result.message || rule.message || "",
    value,
  };
}

export function evaluateRules(rules = [], record = {}, ctx = {}) {
  const results = [];
  const ordered = [...rules].filter((rule) => rule.status !== "inactive").sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
  for (const rule of ordered) results.push(evaluateRule(rule, record, ctx));
  const errors = results.filter((r) => !r.passed && r.severity === "ERROR");
  const warnings = results.filter((r) => !r.passed && r.severity === "WARNING");
  const infos = results.filter((r) => !r.passed && r.severity === "INFO");
  return { results, errors, warnings, infos, hasErrors: errors.length > 0 };
}

// Validates a rule definition without running it.
export function validateRule(rule) {
  const errors = [];
  const level = normalizeUpper(rule.level || "FIELD");
  if (!handlers.has(normalizeUpper(rule.rule_type || rule.type))) errors.push({ code: "unknown_rule", message: `Unknown rule type: ${rule.rule_type}` });
  if (["FIELD", "RECORD"].includes(level) && !rule.target_field && normalizeUpper(rule.rule_type) !== "EXPRESSION") {
    errors.push({ code: "missing_field", message: `A ${level} rule requires a target_field` });
  }
  if (normalizeUpper(rule.rule_type) === "EXPRESSION" && !(rule.config || {}).expression) {
    errors.push({ code: "missing_expression", message: "An EXPRESSION rule requires config.expression" });
  }
  return { valid: errors.length === 0, errors };
}

export { getPath };
