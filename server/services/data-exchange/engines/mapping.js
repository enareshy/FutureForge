// Declarative mapping engine.
//
// A mapping says how one source field (or expression) becomes one target field.
// The engine resolves it against the source record, then the caller validates
// the mapped object against the target schema and security policy. No user code
// is executed: every mapping kind is a documented, bounded operation.
import { invalidExpression, invalidLookup, invalidMapping } from "../errors.js";
import { getPath, setPath, applyTransformations } from "./transform.js";
import { applyTemplate, evaluateExpression, normalizeUpper, validateExpression } from "../validation.js";

function resolveLookup(mapping, value, ctx) {
  const config = mapping.lookup || {};
  const mode = normalizeUpper(config.match_mode || config.matchMode || "EXACT");
  const map = config.map || config.mapping || null;
  if (map && typeof map === "object") {
    const key = String(value);
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    return config.default ?? value;
  }
  if (typeof ctx.lookupResolver === "function") {
    const resolved = ctx.lookupResolver(value, { ...config, mode, mapping });
    if (resolved !== undefined) return resolved;
  }
  if (config.default !== undefined) return config.default;
  if (config.required) throw invalidLookup(`No lookup value for "${value}"`, { field: mapping.target_field, value });
  return value;
}

function buildNested(mapping, sourceRecord, ctx) {
  const spec = mapping.nested || {};
  const fields = Array.isArray(spec.fields) ? spec.fields : [];
  const nested = {};
  for (const field of fields) {
    const raw = field.expression ? evaluateExpression(field.expression, { ...sourceRecord, ...ctx.context }) : getPath(sourceRecord, field.source_field || field.sourceField);
    setPath(nested, field.target_field || field.targetField || field.name, raw);
  }
  if (Object.keys(nested).length === 0 && mapping.source_field) {
    const raw = getPath(sourceRecord, mapping.source_field);
    if (raw && typeof raw === "object") return raw;
  }
  return nested;
}

function buildArray(mapping, sourceRecord, ctx) {
  const spec = mapping.nested || {};
  const items = Array.isArray(spec.items) ? spec.items : [];
  if (items.length) {
    return items.map((item) => (typeof item === "string" ? evaluateExpression(item, { ...sourceRecord, ...ctx.context }) : getPath(sourceRecord, item.source_field || item)));
  }
  const raw = getPath(sourceRecord, mapping.source_field);
  if (raw === null || raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

export function mapRecord(mapping, sourceRecord, ctx = {}) {
  const type = normalizeUpper(mapping.mapping_type || "DIRECT");
  const expressionContext = { ...sourceRecord, ...(ctx.context || {}) };
  const base = { source: sourceRecord, ...expressionContext };
  switch (type) {
    case "DIRECT":
    case "RENAME":
      return getPath(sourceRecord, mapping.source_field);
    case "DEFAULT": {
      const value = getPath(sourceRecord, mapping.source_field);
      return value === null || value === undefined || value === "" ? mapping.default_value : value;
    }
    case "CONSTANT":
      return mapping.constant_value;
    case "LOOKUP":
      return resolveLookup(mapping, getPath(sourceRecord, mapping.source_field), ctx);
    case "CONDITIONAL": {
      const condition = mapping.condition || {};
      const expression = condition.expression || condition.when || "true";
      const branch = evaluateExpression(expression, { ...base, value: getPath(sourceRecord, mapping.source_field) })
        ? condition.then ?? condition.then_value ?? mapping.default_value
        : condition.else ?? condition.else_value ?? mapping.default_value;
      return typeof branch === "string" && branch.includes("{{") ? applyTemplate(branch, base) : branch;
    }
    case "CONCAT": {
      const parts = Array.isArray(mapping.concat) && mapping.concat.length ? mapping.concat : [mapping.source_field];
      const separator = (mapping.condition && mapping.condition.separator) || "";
      return parts
        .map((part) => (typeof part === "string" ? getPath(sourceRecord, part) : evaluateExpression(part.expression, base)))
        .map((entry) => (entry === null || entry === undefined ? "" : String(entry)))
        .join(separator);
    }
    case "SPLIT": {
      const config = mapping.split || {};
      const parts = String(getPath(sourceRecord, mapping.source_field) ?? "").split(config.separator || ",");
      const index = Number(config.index ?? 0);
      return parts[index] ?? config.default ?? null;
    }
    case "EXPRESSION":
      return evaluateExpression(mapping.expression || "source", { ...base, value: getPath(sourceRecord, mapping.source_field) });
    case "NESTED":
      return buildNested(mapping, sourceRecord, ctx);
    case "ARRAY":
      return buildArray(mapping, sourceRecord, ctx);
    default:
      throw invalidMapping(`Unknown mapping type: ${mapping.mapping_type}`);
  }
}

// Applies an ordered mapping set. Field-stage inline `transform` arrays run
// after the base value is resolved.
export function applyMappings(mappings, sourceRecord, ctx = {}) {
  const target = {};
  const errors = [];
  const warnings = [];
  const ordered = [...(mappings || [])].filter((m) => m.status !== "inactive").sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
  for (const mapping of ordered) {
    try {
      let value = mapRecord(mapping, sourceRecord, ctx);
      const inline = Array.isArray(mapping.transform) ? mapping.transform : [];
      if (inline.length) {
        value = applyTransformations(inline, value, { record: sourceRecord, context: ctx.context, lookup: ctx.lookupResolver });
      }
      if ((value === null || value === undefined || value === "") && mapping.required) {
        errors.push({ code: "required", field: mapping.target_field, message: `${mapping.target_field} is required` });
        continue;
      }
      if (value !== undefined) setPath(target, mapping.target_field, value);
    } catch (error) {
      errors.push({ code: error.code || "mapping_error", field: mapping.target_field, message: error.message });
    }
  }
  return { target, errors, warnings };
}

// Static validation used before an import starts (spec §9). Returns blocking
// errors and advisory warnings so the UI can explain exactly what is wrong.
export function validateMappings(mappings = [], { sourceFields = null, targetFields = null, expressionValidator = validateExpression } = {}) {
  const errors = [];
  const warnings = [];
  const targetSeen = new Map();
  const sourceSet = sourceFields ? new Set(sourceFields) : null;
  const targetSet = targetFields ? new Set(targetFields) : null;
  if (!mappings.length) {
    return { valid: false, errors: [{ code: "no_mappings", message: "At least one mapping is required" }], warnings };
  }
  for (const mapping of mappings) {
    const type = normalizeUpper(mapping.mapping_type || "DIRECT");
    const target = mapping.target_field;
    if (!target) errors.push({ code: "missing_target", message: "A mapping requires a target_field" });
    else if (targetSet && !targetSet.has(target) && type !== "NESTED") {
      errors.push({ code: "unknown_target", field: target, message: `Target field "${target}" does not exist on the target object type` });
    }
    if (target) {
      const count = (targetSeen.get(target) || 0) + 1;
      targetSeen.set(target, count);
      if (count > 1) errors.push({ code: "duplicate_target", field: target, message: `Multiple mappings write to "${target}"` });
    }
    if (["DIRECT", "RENAME", "DEFAULT", "LOOKUP", "SPLIT"].includes(type) && mapping.source_field && sourceSet && !sourceSet.has(mapping.source_field)) {
      warnings.push({ code: "unknown_source", field: mapping.source_field, message: `Source field "${mapping.source_field}" was not found in the source schema` });
    }
    if (type === "EXPRESSION") {
      if (!mapping.expression) errors.push({ code: "missing_expression", field: target, message: "An EXPRESSION mapping requires an expression" });
      else {
        const check = expressionValidator(mapping.expression);
        if (!check.valid) check.errors.forEach((entry) => errors.push({ code: "invalid_expression", field: target, message: entry.message }));
      }
    }
    if (type === "LOOKUP") {
      const config = mapping.lookup || {};
      if (!config.map && !config.source && !config.table && !config.lookup_definition) {
        errors.push({ code: "missing_lookup", field: target, message: "A LOOKUP mapping requires a map, source, table or lookup_definition" });
      }
    }
    if (type === "CONSTANT" && (mapping.constant_value === null || mapping.constant_value === undefined)) {
      errors.push({ code: "missing_constant", field: target, message: "A CONSTANT mapping requires a constant_value" });
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

export { getPath, setPath };
