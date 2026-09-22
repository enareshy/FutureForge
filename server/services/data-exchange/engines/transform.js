// Declarative transformation engine shared by import and export.
//
// Transformations are data: a type plus a JSON config. Nothing here executes
// user-supplied code (see the safe evaluator in ../validation.js). New
// transformation types are added by registering a handler, so the engine stays
// open for extension without hard-coding business rules.
import { invalidTransformation, transformationFailed } from "../errors.js";
import { applyTemplate, evaluateExpression, normalizeText, normalizeUpper, resolveValueExpression } from "../validation.js";

const handlers = new Map();

export function registerTransformationHandler(type, handler) {
  if (!type || typeof handler !== "function") throw invalidTransformation("A transformation type and handler are required");
  handlers.set(normalizeUpper(type), handler);
  return type;
}

export function transformationTypes() {
  return [...handlers.keys()];
}

function empty(value) {
  return value === null || value === undefined || value === "";
}

const DATE_FORMATS = ["YYYY-MM-DD", "DD/MM/YYYY", "MM/DD/YYYY", "YYYYMMDD", "YYYY-MM-DDTHH:mm:ss", "ISO", "EPOCH"];

function parseFlexibleDate(value, format) {
  if (empty(value)) return null;
  const text = String(value).trim();
  const upper = normalizeUpper(format || "ISO");
  if (upper === "EPOCH" || /^\d{10,13}$/.test(text)) {
    const n = Number(text);
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  if (upper === "YYYYMMDD" && /^\d{8}$/.test(text)) {
    return new Date(`${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T00:00:00Z`);
  }
  if (upper === "DD/MM/YYYY") {
    const m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T00:00:00Z`);
  }
  if (upper === "MM/DD/YYYY") {
    const m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return new Date(`${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}T00:00:00Z`);
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date, format) {
  if (!date) return null;
  const upper = normalizeUpper(format || "ISO");
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  if (upper === "EPOCH") return Math.floor(date.getTime() / 1000);
  if (upper === "YYYYMMDD") return `${y}${mo}${d}`;
  if (upper === "DD/MM/YYYY") return `${d}/${mo}/${y}`;
  if (upper === "MM/DD/YYYY") return `${mo}/${d}/${y}`;
  if (upper === "YYYY-MM-DD") return `${y}-${mo}-${d}`;
  return date.toISOString();
}

const UNIT_FAMILIES = {
  length: { mm: 1, cm: 10, m: 1000, km: 1000000, in: 25.4, ft: 304.8 },
  mass: { g: 1, kg: 1000, t: 1000000, lb: 453.59237, oz: 28.349523125 },
  temperature: null,
};

function convertUnit(value, from, to) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw transformationFailed(`Cannot convert non-numeric value "${value}"`);
  const f = normalizeLowerToken(from);
  const t = normalizeLowerToken(to);
  if ((f === "c" || f === "celsius") && (t === "f" || t === "fahrenheit")) return (n * 9) / 5 + 32;
  if ((f === "f" || f === "fahrenheit") && (t === "c" || t === "celsius")) return ((n - 32) * 5) / 9;
  if ((f === "c" || f === "celsius") && (t === "k" || t === "kelvin")) return n + 273.15;
  if ((f === "k" || t === "kelvin") && (t === "c" || t === "celsius")) return n - 273.15;
  for (const family of Object.values(UNIT_FAMILIES)) {
    if (!family) continue;
    if (f in family && t in family) return (n * family[f]) / family[t];
  }
  throw transformationFailed(`Unsupported unit conversion ${from} -> ${to}`);
}

function normalizeLowerToken(value) {
  return String(value || "").trim().toLowerCase();
}

function maskValue(value, config = {}) {
  if (empty(value)) return value;
  const text = String(value);
  const type = normalizeUpper(config.type || "PARTIAL");
  if (type === "EMAIL") {
    const [name, domain] = text.split("@");
    if (!domain) return "****";
    return `${name.slice(0, 1)}***@${domain}`;
  }
  if (type === "FULL") return config.replacement || "****";
  const keepFirst = Number(config.keep_first ?? config.keepFirst ?? 0);
  const keepLast = Number(config.keep_last ?? config.keepLast ?? 4);
  if (text.length <= keepFirst + keepLast) return "*".repeat(text.length);
  return `${text.slice(0, keepFirst)}${"*".repeat(text.length - keepFirst - keepLast)}${text.slice(text.length - keepLast)}`;
}

// Extracts a value at a dot/bracket path from an object.
export function getPath(object, path) {
  if (path === null || path === undefined || path === "") return object;
  let value = object;
  for (const segment of String(path).split(".")) {
    if (value === null || value === undefined) return undefined;
    const arrayMatch = segment.match(/^([^[\]]*)\[(\d+)\]$/);
    if (arrayMatch) {
      value = value[arrayMatch[1]];
      value = Array.isArray(value) ? value[Number(arrayMatch[2])] : undefined;
    } else {
      value = value[segment];
    }
  }
  return value;
}

export function setPath(object, path, value) {
  const segments = String(path).split(".");
  let cursor = object;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const key = segments[i];
    if (cursor[key] === null || typeof cursor[key] !== "object") cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[segments[segments.length - 1]] = value;
  return object;
}

// ── Built-in handlers ────────────────────────────────────────────────────────

registerTransformationHandler("TRIM", (value) => (value === null || value === undefined ? value : String(value).trim()));
registerTransformationHandler("UPPERCASE", (value) => (value === null || value === undefined ? value : String(value).toUpperCase()));
registerTransformationHandler("LOWERCASE", (value) => (value === null || value === undefined ? value : String(value).toLowerCase()));
registerTransformationHandler("SUBSTRING", (value, config) => String(value ?? "").slice(Number(config.start || 0), config.length !== undefined ? Number(config.start || 0) + Number(config.length) : undefined));
registerTransformationHandler("REPLACE", (value, config) => String(value ?? "").split(String(config.find ?? config.from ?? "")).join(String(config.replace ?? config.to ?? "")));
registerTransformationHandler("CONCAT", (value, config, ctx) => {
  const parts = Array.isArray(config.fields || config.fields_json || config.parts) ? config.fields || config.parts : [];
  const separator = String(config.separator ?? "");
  const evaluated = parts.map((part) => (typeof part === "string" && /[({]/.test(part) ? resolveValueExpression(part, { ...ctx.record, value }) : part));
  return evaluated.map((entry) => (entry === null || entry === undefined ? "" : String(entry))).join(separator);
});
registerTransformationHandler("SPLIT", (value, config) => {
  const parts = String(value ?? "").split(String(config.separator ?? ","));
  const index = Number(config.index || 0);
  return parts[index] ?? config.default ?? null;
});
registerTransformationHandler("DATE_CONVERT", (value, config) => formatDate(parseFlexibleDate(value, config.input_format || config.from), config.output_format || config.to || "ISO"));
registerTransformationHandler("UNIT_CONVERT", (value, config) => convertUnit(value, config.from, config.to));
registerTransformationHandler("DEFAULT", (value, config) => (empty(value) ? config.default ?? config.value ?? null : value));
registerTransformationHandler("EXPRESSION", (value, config, ctx) => evaluateExpression(config.expression || config.value || "value", { ...ctx.record, value }));
registerTransformationHandler("MASK", (value, config) => maskValue(value, config));
registerTransformationHandler("LOOKUP", (value, config, ctx) => {
  if (config.map && typeof config.map === "object") {
    const key = String(value);
    return Object.prototype.hasOwnProperty.call(config.map, key) ? config.map[key] : config.default ?? value;
  }
  if (typeof ctx.lookup === "function") return ctx.lookup(value, config);
  return value;
});

export function applyTransformation(type, value, config = {}, ctx = {}) {
  const handler = handlers.get(normalizeUpper(type));
  if (!handler) throw invalidTransformation(`Unknown transformation type: ${type}`);
  try {
    return handler(value, config || {}, ctx);
  } catch (error) {
    if (error.code) throw error;
    throw transformationFailed(`Transformation ${type} failed: ${error.message}`, { type });
  }
}

// Applies an ordered list of transformations to a single value.
export function applyTransformations(transformations, value, ctx = {}) {
  let current = value;
  for (const transformation of transformations || []) {
    const type = transformation.transformation_type || transformation.type;
    const config = transformation.config || transformation.config_json || {};
    current = applyTransformation(type, current, typeof config === "string" ? JSON.parse(config) : config, ctx);
  }
  return current;
}

// Applies definition-level transformations. FIELD-stage transformations target
// `target_field`; RECORD/FILE-stage transformations may target a field path too.
export function applyDefinitionTransformations(transformations = [], record = {}, ctx = {}) {
  let target = { ...record };
  for (const transformation of transformations) {
    if (normalizeUpper(transformation.stage) !== "FIELD") continue;
    const field = transformation.target_field;
    if (!field) continue;
    const current = getPath(target, field);
    const next = applyTransformation(transformation.transformation_type, current, transformation.config || {}, { ...ctx, record: target });
    setPath(target, field, next);
  }
  return target;
}

export function applyTemplateString(template, record) {
  return applyTemplate(template, record);
}

export { maskValue, parseFlexibleDate, formatDate, DATE_FORMATS };

export function normalizeTemplate(value) {
  return normalizeText(value, { max: 4000 });
}
