// Schema discovery and target-schema validation.
//
// Source schemas come from the connector (so a REST feed and a CSV file are
// handled the same way). Target schemas come from the platform metadata service,
// so imports validate against the real object definition rather than a copy.
import { getType, effectiveAttributes } from "../../metadata.js";
import { schemaDiscoveryFailed } from "../errors.js";
import { normalizeText } from "../validation.js";
import { inferFields, inferDataType } from "../connectors/codecs.js";

// Fields every object exposes in addition to its type attributes.
export const OBJECT_BUILTIN_FIELDS = [
  { name: "code", data_type: "string", required: false, system: true },
  { name: "name", data_type: "string", required: false, system: true },
  { name: "description", data_type: "string", required: false, system: true },
  { name: "external_ref", data_type: "string", required: false, system: true },
  { name: "external_system", data_type: "string", required: false, system: true },
  { name: "status", data_type: "string", required: false, system: true },
  { name: "revision", data_type: "string", required: false, system: true },
  { name: "owner_id", data_type: "integer", required: false, system: true },
  { name: "organization_id", data_type: "integer", required: false, system: true },
  { name: "tags", data_type: "multi_value", required: false, system: true },
];

export function targetSchema(db, tenantId, objectType) {
  const code = normalizeText(objectType, { max: 120 });
  if (!code) throw schemaDiscoveryFailed("A target object type is required");
  let type;
  try {
    type = getType(db, code, tenantId, { withAttributes: true });
  } catch {
    throw schemaDiscoveryFailed(`Unknown target object type: ${code}`, { object_type: code });
  }
  if (!type || !type.id) throw schemaDiscoveryFailed(`Unknown target object type: ${code}`, { object_type: code });
  const attributes = effectiveAttributes(db, type.id, tenantId).map((attribute) => ({
    name: attribute.code,
    label: attribute.name || attribute.code,
    data_type: attribute.data_type || "string",
    required: Boolean(attribute.required),
    multi_value: Boolean(attribute.multi_value),
    system: false,
    validation: attribute.validation || {},
  }));
  const fields = [...OBJECT_BUILTIN_FIELDS, ...attributes];
  return {
    object_type: type.code,
    type_id: type.id,
    name: type.name,
    fields,
    field_names: fields.map((field) => field.name),
    required_fields: fields.filter((field) => field.required).map((field) => field.name),
  };
}

// Discovers the shape of a source without importing it.
export async function discoverSourceSchema(connector, ctx = {}) {
  if (!connector) throw schemaDiscoveryFailed("A connector is required for schema discovery");
  if (!connector.capabilities.includes("SCHEMA_DISCOVERY")) {
    // Fall back to a bounded read when the connector cannot describe itself.
    const result = typeof connector.read === "function" ? await connector.read({ ...ctx, limit: 10 }) : { fields: [], records: [] };
    return { fields: inferFields(result.records || []), sample: (result.records || []).slice(0, 10), discovered_via: "read" };
  }
  try {
    const result = await connector.discoverSchema(ctx);
    return { fields: normalizeSchemaFields(result.fields), sample: (result.sample || []).slice(0, 10), discovered_via: "connector" };
  } catch (error) {
    if (error.code) throw error;
    throw schemaDiscoveryFailed(`Schema discovery failed: ${error.message}`, { connector: connector.code });
  }
}

function normalizeSchemaFields(fields) {
  if (!Array.isArray(fields)) return [];
  return fields.map((field) => {
    if (typeof field === "string") return { name: field, data_type: "string" };
    return { name: field.name, data_type: field.data_type || inferDataType(field.sample) };
  });
}

// Validates a mapped record against the target schema. `strict` rejects unknown
// fields; the default records them as warnings so a feed can evolve. Target
// schemas address attributes by dotted path (e.g. `part.number`), while mapped
// records may be nested objects, so the record is flattened first.
export function validateTargetRecord(schema, record, { strict = false } = {}) {
  const errors = [];
  const warnings = [];
  const flat = flattenRecord(record);
  const fields = new Map((schema?.fields || []).map((field) => [field.name, field]));
  for (const name of schema?.required_fields || []) {
    const value = flat[name];
    if (value === null || value === undefined || value === "") {
      errors.push({ code: "required", field: name, message: `${name} is required` });
    }
  }
  for (const [name, value] of Object.entries(flat)) {
    const field = fields.get(name);
    if (!field) {
      const entry = { code: "unknown_field", field: name, message: `Unknown target field "${name}"` };
      if (strict) errors.push(entry);
      else warnings.push(entry);
      continue;
    }
    if (value === null || value === undefined || value === "") continue;
    const mismatch = typeMismatch(field.data_type, value);
    if (mismatch) errors.push({ code: "type_mismatch", field: name, message: `${name} ${mismatch}` });
  }
  return { valid: errors.length === 0, errors, warnings };
}

// Flattens nested objects into dotted keys so schema paths match mapped records.
function flattenRecord(record, prefix = "", out = {}) {
  for (const [key, value] of Object.entries(record || {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      flattenRecord(value, name, out);
    } else {
      out[name] = value;
    }
  }
  return out;
}

function typeMismatch(dataType, value) {
  switch (String(dataType || "").toLowerCase()) {
    case "integer":
      return Number.isInteger(Number(value)) && String(value).trim() !== "" ? null : "must be an integer";
    case "decimal":
    case "number":
    case "float":
      return Number.isFinite(Number(value)) ? null : "must be a number";
    case "boolean":
      return ["true", "false", "1", "0", true, false].includes(typeof value === "boolean" ? value : String(value).toLowerCase()) ? null : "must be a boolean";
    case "date":
    case "datetime":
      return Number.isNaN(new Date(String(value)).getTime()) ? "must be a valid date" : null;
    case "multi_value":
      return Array.isArray(value) || typeof value === "string" ? null : "must be a list of values";
    default:
      return null;
  }
}

export { inferFields, inferDataType };
