// Reusable data transformation & mapping engine plus the versioned
// transformation-definition registry. The engine is declarative: definitions
// describe field mappings, defaults, conditionals, conversions, lookups and
// validation. Custom functions are referenced by name through an extension
// registry so the framework stays provider- and business-independent.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { publicTransformation } from "./repository.js";
import {
  ERROR_HANDLING,
  TRANSFER_FORMATS,
  applyTemplate,
  assertEnum,
  getPath,
  safeParse,
  setPath,
  toJson,
  maskPayload,
} from "./validation.js";
import { classifyError } from "./hooks.js";

const LOOKUP_TABLES = new Map();
const EXTENSIONS = new Map();

export function registerLookup(name, table) {
  LOOKUP_TABLES.set(String(name), table);
  return true;
}

export function registerTransformExtension(name, fn) {
  EXTENSIONS.set(String(name), fn);
  return true;
}

export function listTransformExtensions() {
  return { lookups: [...LOOKUP_TABLES.keys()], functions: [...EXTENSIONS.keys()] };
}

function assertDefinitionInput(input, { partial = false } = {}) {
  if (!partial || input.error_handling !== undefined) {
    assertEnum(input.error_handling ?? "fail", ERROR_HANDLING, "error_handling");
  }
  if (!partial || input.source_format !== undefined) {
    assertEnum(input.source_format ?? "json", TRANSFER_FORMATS, "source_format");
  }
  if (!partial || input.target_format !== undefined) {
    assertEnum(input.target_format ?? "json", TRANSFER_FORMATS, "target_format");
  }
}

function normalizeMappings(list) {
  if (!Array.isArray(list)) return [];
  return list.map((m) => {
    const source = m.source ?? m.from ?? "";
    const target = m.target === undefined ? m.to ?? source : m.target;
    return {
      source,
      target,
      type: m.type || m.data_type || "string",
      default: m.default,
      required: Boolean(m.required),
      enum: m.enum || m.lov || null,
      concat: Array.isArray(m.concat) ? m.concat : null,
      separator: m.separator ?? "",
      split: m.split || null,
      transform: m.transform || null,
      lookup: m.lookup || null,
      date_format: m.date_format || null,
      unit: m.unit || null,
      template: m.template || null,
    };
  });
}

// ── Transformation definition registry ──────────────────────────────────────
export function listTransformations(db, { tenantId, status, q, page, pageSize, offset } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
    params.push(`%${String(q).toLowerCase()}%`, `%${String(q).toLowerCase()}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM transformation_definitions ${where}`, params).c;
  const limit = pageSize || 50;
  const rows = queryAll(
    db,
    `SELECT * FROM transformation_definitions ${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset || 0]
  );
  return { items: rows.map((r) => publicTransformation(r)), total, page: page || 1, page_size: limit };
}

export function getTransformationRow(db, ref) {
  const id = Number(ref);
  return queryOne(db, "SELECT * FROM transformation_definitions WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(ref)]);
}

export function getTransformation(db, ref, scope = {}) {
  const row = getTransformationRow(db, ref);
  if (!row) throw new HttpError(404, "Transformation definition not found");
  if (scope.tenantId !== undefined && scope.tenantId !== null && row.tenant_id && Number(row.tenant_id) !== Number(scope.tenantId)) {
    throw new HttpError(404, "Transformation definition not found");
  }
  return publicTransformation(row);
}

export function createTransformation(db, input = {}, actor = null, tenantId = null) {
  assertDefinitionInput(input);
  if (!input.code) throw new HttpError(400, "code is required");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO transformation_definitions
      (code, name, description, version, status, source_format, target_format, source_schema_json, target_schema_json,
       mappings_json, constants_json, conditionals_json, conversions_json, lookups_json, validation_json,
       error_handling, sample_input_json, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      input.description || "",
      Number(input.version) || 1,
      input.status || "draft",
      input.source_format || "json",
      input.target_format || "json",
      toJson(input.source_schema, {}),
      toJson(input.target_schema, {}),
      toJson(normalizeMappings(input.mappings), []),
      toJson(input.constants, {}),
      toJson(input.conditionals, []),
      toJson(input.conversions, []),
      toJson(input.lookups, []),
      toJson(input.validation, []),
      input.error_handling || "fail",
      toJson(input.sample_input, {}),
      tenantId ?? input.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM transformation_definitions WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, {
    actor,
    action: "integration.transformation.create",
    resourceType: "transformation_definition",
    resourceId: row.id,
    details: { code: row.code, version: row.version },
  });
  return publicTransformation(row);
}

export function updateTransformation(db, ref, input = {}, actor = null) {
  const row = getTransformationRow(db, ref);
  if (!row) throw new HttpError(404, "Transformation definition not found");
  assertDefinitionInput(input, { partial: true });
  const fields = {
    name: input.name ?? row.name,
    description: input.description ?? row.description,
    status: input.status ?? row.status,
    source_format: input.source_format ?? row.source_format,
    target_format: input.target_format ?? row.target_format,
    source_schema_json: input.source_schema !== undefined ? toJson(input.source_schema, {}) : row.source_schema_json,
    target_schema_json: input.target_schema !== undefined ? toJson(input.target_schema, {}) : row.target_schema_json,
    mappings_json: input.mappings !== undefined ? toJson(normalizeMappings(input.mappings), []) : row.mappings_json,
    constants_json: input.constants !== undefined ? toJson(input.constants, {}) : row.constants_json,
    conditionals_json: input.conditionals !== undefined ? toJson(input.conditionals, []) : row.conditionals_json,
    conversions_json: input.conversions !== undefined ? toJson(input.conversions, []) : row.conversions_json,
    lookups_json: input.lookups !== undefined ? toJson(input.lookups, []) : row.lookups_json,
    validation_json: input.validation !== undefined ? toJson(input.validation, []) : row.validation_json,
    error_handling: input.error_handling ?? row.error_handling,
    sample_input_json: input.sample_input !== undefined ? toJson(input.sample_input, {}) : row.sample_input_json,
    version: input.bump_version ? Number(row.version) + 1 : Number(input.version) || row.version,
  };
  run(
    db,
    `UPDATE transformation_definitions SET name=?, description=?, status=?, source_format=?, target_format=?,
     source_schema_json=?, target_schema_json=?, mappings_json=?, constants_json=?, conditionals_json=?,
     conversions_json=?, lookups_json=?, validation_json=?, error_handling=?, sample_input_json=?, version=?, updated_at=?
     WHERE id=?`,
    [
      fields.name, fields.description, fields.status, fields.source_format, fields.target_format,
      fields.source_schema_json, fields.target_schema_json, fields.mappings_json, fields.constants_json,
      fields.conditionals_json, fields.conversions_json, fields.lookups_json, fields.validation_json,
      fields.error_handling, fields.sample_input_json, fields.version, nowIso(), row.id,
    ]
  );
  writeAudit(db, { actor, action: "integration.transformation.update", resourceType: "transformation_definition", resourceId: row.id, details: { code: row.code } });
  return publicTransformation(queryOne(db, "SELECT * FROM transformation_definitions WHERE id = ?", [row.id]));
}

export function deleteTransformation(db, ref, actor = null) {
  const row = getTransformationRow(db, ref);
  if (!row) throw new HttpError(404, "Transformation definition not found");
  run(db, "DELETE FROM transformation_definitions WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "integration.transformation.delete", resourceType: "transformation_definition", resourceId: row.id, details: { code: row.code } });
  return { deleted: true, id: row.id };
}

// ── Type coercion & conversions ─────────────────────────────────────────────
export function coerceValue(value, type) {
  if (value === undefined || value === null) return value;
  switch (String(type || "string")) {
    case "string":
      return String(value);
    case "number":
    case "float":
    case "decimal": {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`Cannot convert "${value}" to number`);
      return n;
    }
    case "integer":
    case "int": {
      const n = parseInt(value, 10);
      if (!Number.isFinite(n)) throw new Error(`Cannot convert "${value}" to integer`);
      return n;
    }
    case "boolean":
    case "bool":
      return ["true", "1", "yes", "y", "on"].includes(String(value).toLowerCase());
    case "date":
    case "datetime": {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) throw new Error(`Cannot convert "${value}" to date`);
      return date.toISOString();
    }
    case "json":
      return typeof value === "string" ? JSON.parse(value) : value;
    default:
      return value;
  }
}

const UNIT_TABLE = {
  length: { mm: 1, cm: 10, m: 1000, km: 1000000, in: 25.4, ft: 304.8 },
  mass: { mg: 0.001, g: 1, kg: 1000, t: 1000000, lb: 453.59237, oz: 28.349523125 },
  time: { ms: 0.001, s: 1, min: 60, h: 3600, d: 86400 },
};

export function convertUnit(value, fromUnit, toUnit, dimension) {
  const dim = dimension || Object.keys(UNIT_TABLE).find((key) => UNIT_TABLE[key][fromUnit] && UNIT_TABLE[key][toUnit]);
  if (!dim || !UNIT_TABLE[dim]) throw new Error(`Unsupported unit conversion ${fromUnit} -> ${toUnit}`);
  const table = UNIT_TABLE[dim];
  if (!table[fromUnit] || !table[toUnit]) throw new Error(`Unsupported unit conversion ${fromUnit} -> ${toUnit}`);
  return (Number(value) * table[fromUnit]) / table[toUnit];
}

function applyTransformFunction(name, value) {
  switch (String(name || "").toLowerCase()) {
    case "lower":
    case "lowercase":
      return String(value).toLowerCase();
    case "upper":
    case "uppercase":
      return String(value).toUpperCase();
    case "trim":
      return String(value).trim();
    case "capitalize":
      return String(value).replace(/\b\w/g, (c) => c.toUpperCase());
    default:
      if (EXTENSIONS.has(String(name))) return EXTENSIONS.get(String(name))(value);
      return value;
  }
}

// ── Core engine ─────────────────────────────────────────────────────────────
export function applyTransformation(definition, source, { strict = false } = {}) {
  const def = definition && definition.code ? definition : publicTransformation(definition);
  if (!def) throw new HttpError(400, "Transformation definition is required");
  const input = source === undefined || source === null ? {} : source;
  const output = {};
  const errors = [];
  const warnings = [];
  const applied = [];
  const errorHandling = def.error_handling || "fail";

  const record = (entry) => {
    if (errorHandling === "fail") errors.push(entry);
    else if (errorHandling === "skip") warnings.push({ ...entry, action: "skip" });
    else warnings.push({ ...entry, action: errorHandling });
  };

  try {
    for (const mapping of normalizeMappings(def.mappings)) {
      const target = mapping.target || mapping.source;
      if (!target) continue;
      let value;
      try {
        if (mapping.template) {
          value = applyTemplate(mapping.template, input);
        } else if (mapping.concat) {
          value = mapping.concat.map((path) => getPath(input, path)).filter((v) => v !== undefined && v !== null).join(mapping.separator || "");
        } else if (mapping.split) {
          const raw = getPath(input, mapping.source);
          value = String(raw ?? "").split(mapping.split.separator || ",")[mapping.split.index ?? 0];
        } else {
          value = getPath(input, mapping.source);
        }
        if ((value === undefined || value === null || value === "") && mapping.default !== undefined) value = mapping.default;
        if (mapping.required && (value === undefined || value === null || value === "")) {
          record({ field: target, code: "required_field_missing", message: `Required field ${target} is missing` });
          continue;
        }
        if (value === undefined || value === null) continue;
        if (mapping.enum) {
          const mapped = mapping.enum[value] ?? mapping.enum[String(value)];
          if (mapped === undefined) {
            record({ field: target, code: "invalid_value", message: `No enumeration mapping for ${value}` });
            continue;
          }
          value = mapped;
        }
        if (mapping.lookup) {
          const name = typeof mapping.lookup === "string" ? mapping.lookup : mapping.lookup.name;
          const table = LOOKUP_TABLES.get(name);
          if (table) value = table[value] ?? (typeof mapping.lookup === "object" ? mapping.lookup.default : undefined) ?? value;
        }
        if (mapping.unit) {
          value = convertUnit(value, mapping.unit.from, mapping.unit.to, mapping.unit.dimension);
        }
        if (mapping.transform) value = applyTransformFunction(mapping.transform, value);
        value = coerceValue(value, mapping.type);
        setPath(output, target, value);
        applied.push(target);
      } catch (error) {
        record({ field: target, code: "mapping_failed", message: error.message });
      }
    }

    for (const [target, value] of Object.entries(def.constants || {})) {
      setPath(output, target, value);
      applied.push(target);
    }

    for (const conditional of def.conditionals || []) {
      const condition = conditional.if || conditional.when || {};
      const passed = evaluateCondition(condition, input);
      const branch = passed ? conditional.then : conditional.else;
      if (!branch) continue;
      for (const [target, value] of Object.entries(branch)) {
        setPath(output, target, typeof value === "string" && value.includes("{{") ? applyTemplate(value, input) : value);
        applied.push(target);
      }
    }

    for (const conversion of def.conversions || []) {
      const raw = getPath(output, conversion.target ?? conversion.source);
      if (raw === undefined || raw === null) continue;
      let value = raw;
      if (conversion.from_unit && conversion.to_unit) value = convertUnit(raw, conversion.from_unit, conversion.to_unit, conversion.dimension);
      else value = coerceValue(raw, conversion.type || "string");
      setPath(output, conversion.target ?? conversion.source, value);
      applied.push(conversion.target ?? conversion.source);
    }

    for (const rule of def.validation || []) {
      if (!validateRule(rule, output)) {
        record({ field: rule.path || rule.field, code: rule.code || "validation_failed", message: rule.message || `Validation failed for ${rule.path || rule.field}` });
      }
    }
  } catch (error) {
    const classified = classifyError(error);
    errors.push({ code: classified.code, message: classified.message, category: classified.category });
  }

  if (strict && errors.length) {
    throw new HttpError(422, "Transformation validation failed", errors);
  }
  return { output, errors, warnings, applied, error_handling: errorHandling };
}

function evaluateCondition(condition, source) {
  if (!condition || typeof condition !== "object") return false;
  const value = getPath(source, condition.path || condition.field);
  if (condition.exists !== undefined) return condition.exists ? value !== undefined && value !== null : value === undefined || value === null;
  if (condition.equals !== undefined) return value === condition.equals;
  if (condition.not_equals !== undefined) return value !== condition.not_equals;
  if (condition.in !== undefined) return Array.isArray(condition.in) && condition.in.includes(value);
  if (condition.gt !== undefined) return Number(value) > Number(condition.gt);
  if (condition.gte !== undefined) return Number(value) >= Number(condition.gte);
  if (condition.lt !== undefined) return Number(value) < Number(condition.lt);
  if (condition.lte !== undefined) return Number(value) <= Number(condition.lte);
  if (condition.matches) return new RegExp(condition.matches).test(String(value ?? ""));
  return false;
}

function validateRule(rule, data) {
  const value = getPath(data, rule.path || rule.field);
  if (rule.required && (value === undefined || value === null || value === "")) return false;
  if (value === undefined || value === null) return true;
  if (rule.type) {
    try {
      coerceValue(value, rule.type);
    } catch {
      return false;
    }
  }
  if (rule.min !== undefined && Number(value) < Number(rule.min)) return false;
  if (rule.max !== undefined && Number(value) > Number(rule.max)) return false;
  if (rule.min_length !== undefined && String(value).length < Number(rule.min_length)) return false;
  if (rule.max_length !== undefined && String(value).length > Number(rule.max_length)) return false;
  if (rule.matches && !new RegExp(rule.matches).test(String(value))) return false;
  if (rule.one_of && !rule.one_of.includes(value)) return false;
  return true;
}

// ── Format conversion helpers (CSV / JSON / XML) ────────────────────────────
export function parseCsv(text) {
  const rows = [];
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n").filter((l) => l.length);
  if (!lines.length) return rows;
  const headers = splitCsvLine(lines[0]);
  for (let i = 1; i < lines.length; i += 1) {
    const cells = splitCsvLine(lines[i]);
    const row = {};
    headers.forEach((header, index) => {
      row[header.trim()] = cells[index] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function splitCsvLine(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      cells.push(current);
      current = "";
    } else current += char;
  }
  cells.push(current);
  return cells;
}

export function toCsvRows(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return "";
  const headers = [...new Set(list.flatMap((row) => Object.keys(row || {})))];
  const escape = (value) => {
    const text = value === undefined || value === null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers.join(","), ...list.map((row) => headers.map((h) => escape(row?.[h])).join(","))].join("\n");
}

// Minimal, dependency-free XML parser sufficient for integration payloads
// (elements, attributes, nested text). Namespaces are preserved as prefixes.
export function parseXml(text) {
  const source = String(text || "").replace(/<\?xml[^>]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  const root = { name: "#root", attributes: {}, children: [], text: "" };
  const stack = [root];
  const tagRe = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
  let match;
  while ((match = tagRe.exec(source))) {
    const [, closing, name, attrs, selfClose, textContent] = match;
    const current = stack[stack.length - 1];
    if (textContent !== undefined) {
      current.text += textContent.trim();
      continue;
    }
    if (closing) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = { name, attributes: {}, children: [], text: "" };
    const attrRe = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
    let attrMatch;
    while ((attrMatch = attrRe.exec(attrs || ""))) node.attributes[attrMatch[1]] = attrMatch[2];
    current.children.push(node);
    if (!selfClose) stack.push(node);
  }
  return nodeToValue(root.children[0] || { name: "root", attributes: {}, children: [], text: "" });
}

function nodeToValue(node) {
  if (!node) return null;
  if (!node.children.length && !Object.keys(node.attributes).length) return node.text || null;
  if (!node.children.length && Object.keys(node.attributes).length) return { ...node.attributes, value: node.text || undefined };
  const value = {};
  for (const [key, val] of Object.entries(node.attributes)) value[`@${key}`] = val;
  const grouped = {};
  for (const child of node.children) {
    const childValue = nodeToValue(child);
    if (grouped[child.name] === undefined) grouped[child.name] = childValue;
    else if (Array.isArray(grouped[child.name])) grouped[child.name].push(childValue);
    else grouped[child.name] = [grouped[child.name], childValue];
  }
  if (node.text) value["#text"] = node.text;
  return { ...value, ...grouped };
}

export function toXml(value, rootName = "root") {
  const escape = (text) => String(text).replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
  const render = (name, val) => {
    if (val === null || val === undefined) return `<${name}/>`;
    if (Array.isArray(val)) return val.map((item) => render(name, item)).join("");
    if (typeof val === "object") {
      const attrs = Object.entries(val).filter(([k]) => k.startsWith("@")).map(([k, v]) => ` ${k.slice(1)}="${escape(v)}"`).join("");
      const inner = Object.entries(val).filter(([k]) => !k.startsWith("@") && k !== "#text").map(([k, v]) => render(k, v)).join("");
      const text = val["#text"] !== undefined ? escape(val["#text"]) : "";
      return `<${name}${attrs}>${text}${inner}</${name}>`;
    }
    return `<${name}>${escape(val)}</${name}>`;
  };
  return `<?xml version="1.0" encoding="utf-8"?>${render(rootName, value)}`;
}

export function convertFormat(value, fromFormat, toFormat) {
  const from = String(fromFormat || "json").toLowerCase();
  const to = String(toFormat || "json").toLowerCase();
  if (from === to) return value;
  let normalized = value;
  if (from === "csv") normalized = Array.isArray(value) ? value : parseCsv(value);
  else if (from === "xml") normalized = typeof value === "string" ? parseXml(value) : value;
  else if (from === "json") normalized = typeof value === "string" ? JSON.parse(value) : value;
  if (to === "csv") return toCsvRows(Array.isArray(normalized) ? normalized : [normalized]);
  if (to === "xml") return toXml(normalized);
  if (to === "json") return typeof normalized === "string" ? normalized : JSON.stringify(normalized);
  return normalized;
}

// Test execution entry point used by the API and the frontend mapping editor.
export function testTransformation(db, ref, { input = {}, source_sample = null } = {}, actor = null) {
  const row = getTransformationRow(db, ref);
  if (!row) throw new HttpError(404, "Transformation definition not found");
  const def = publicTransformation(row);
  let sample = input;
  if ((!input || !Object.keys(input).length) && source_sample) {
    sample = typeof source_sample === "string" ? parseInputByFormat(source_sample, def.source_format) : source_sample;
  }
  const started = Date.now();
  let result;
  let error = null;
  try {
    result = applyTransformation(def, sample);
  } catch (err) {
    error = classifyError(err);
    result = { output: null, errors: [error], warnings: [], applied: [] };
  }
  writeAudit(db, {
    actor,
    action: "integration.transformation.test",
    resourceType: "transformation_definition",
    resourceId: row.id,
    details: { code: row.code, ok: !error, errors: result.errors.length },
    status: error ? "failure" : "success",
    errorMessage: error?.message || null,
  });
  return {
    transformation_code: def.code,
    source_format: def.source_format,
    target_format: def.target_format,
    input: maskPayload(sample),
    output: result.output,
    errors: result.errors,
    warnings: result.warnings,
    applied: result.applied,
    duration_ms: Date.now() - started,
    ok: !error && result.errors.length === 0,
  };
}

function parseInputByFormat(text, format) {
  const lower = String(format || "json").toLowerCase();
  if (lower === "csv") return parseCsv(text);
  if (lower === "xml") return parseXml(text);
  if (lower === "json") return safeParse(text, text);
  return text;
}
