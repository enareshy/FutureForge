// Search field definitions. Indexed fields are never inferred automatically:
// each searchable object type declares which fields may be searched, filtered,
// sorted and faceted. Definitions are provider-independent metadata and are
// cached per tenant (invalidated on any configuration change).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SearchError, SEARCH_ERROR_CODES } from "./errors.js";
import {
  SEARCH_DATA_TYPES,
  normalizeDataType,
  normalizeOperator,
  operatorAllows,
  operatorsForType,
} from "./canonical.js";
import { ATTRIBUTE_PREFIX, CONDITION_COUNT_MAX, isValidIdentifier } from "./validation.js";

// Columns that map directly to physical index columns. Every other canonical
// field is treated as an object-specific attribute (json_extract in the
// relational provider).
export const DIRECT_FIELDS = new Set([
  "object_type",
  "object_id",
  "code",
  "title",
  "status",
  "lifecycle_state",
  "owner_id",
  "owner_name",
  "organization_id",
  "site_id",
  "classification",
  "external_reference",
  "created_at",
  "updated_at",
  "source_revision",
  "revisions",
]);

export const SPECIAL_FIELDS = new Set(["_text", "_title", "_code"]);

const BASE_FIELDS = [
  field("object_type", "string", { filterable: true, facetable: true, searchable: false, exactMatch: true, wildcard: false }),
  field("object_id", "string", { filterable: true, searchable: false, exactMatch: true, wildcard: false }),
  field("code", "string", { searchable: true, filterable: true, sortable: true, exactMatch: true, wildcard: true }),
  field("title", "text", { searchable: true, filterable: true, sortable: true, fullText: true, exactMatch: false, wildcard: true }),
  field("description", "text", { searchable: true, filterable: true, fullText: true }),
  field("status", "enum", { searchable: true, filterable: true, sortable: true, facetable: true }),
  field("lifecycle_state", "enum", { searchable: true, filterable: true, facetable: true }),
  field("owner_id", "number", { filterable: true, searchable: false }),
  field("owner_name", "string", { searchable: true, filterable: true, sortable: true, facetable: true }),
  field("organization_id", "number", { filterable: true, facetable: true, searchable: false }),
  field("site_id", "number", { filterable: true, facetable: true, searchable: false }),
  field("classification", "enum", { searchable: true, filterable: true, facetable: true }),
  field("tags", "array", { searchable: true, filterable: true, facetable: true }),
  field("external_reference", "string", { searchable: true, filterable: true, exactMatch: true, wildcard: true }),
  field("created_at", "datetime", { filterable: true, sortable: true, searchable: false }),
  field("updated_at", "datetime", { filterable: true, sortable: true, searchable: false }),
  field("source_revision", "string", { filterable: true, searchable: false }),
  field("revisions", "string", { searchable: true, filterable: false }),
  field("_text", "text", { searchable: true, filterable: true, fullText: true }),
  field("_title", "text", { searchable: true, filterable: true, fullText: true }),
  field("_code", "string", { searchable: true, filterable: true, exactMatch: true, wildcard: true }),
];

function field(name, dataType, overrides = {}) {
  const wildcardByDefault = dataType === "string" || dataType === "text";
  return {
    field: name,
    displayName: name,
    dataType,
    searchable: false,
    filterable: false,
    sortable: false,
    facetable: false,
    fullText: false,
    exactMatch: false,
    wildcard: wildcardByDefault,
    boost: 1,
    analyzer: "standard",
    securitySensitive: false,
    indexed: true,
    displayOrder: 100,
    source: "system",
    ...overrides,
  };
}

function listOf(value) {
  if (value === undefined || value === null) return [];
  const parsed = typeof value === "string" ? safeParse(value, []) : value;
  const list = Array.isArray(parsed) ? parsed : String(parsed).split(",");
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
}

function safeParse(json, fallback) {
  if (json === null || json === undefined || json === "") return fallback;
  if (typeof json === "object") return json;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

// Derives the default field catalog for a registration when no explicit fields
// have been configured. Keeps existing registrations working unchanged.
export function derivedFieldsForRegistration(registration) {
  const searchable = listOf(registration.searchable_fields_json).length
    ? listOf(registration.searchable_fields_json)
    : [...listOf(registration.body_attributes_json), "title", "code", "description", "tags"];
  const facetable = listOf(registration.facetable_fields_json).length
    ? listOf(registration.facetable_fields_json)
    : listOf(registration.facet_attributes_json);
  const sortable = listOf(registration.sortable_fields_json);
  const filterable = listOf(registration.filter_attributes_json);
  return { searchable, facetable, sortable, filterable };
}

const catalogCache = new Map();

export function invalidateFieldCatalog(tenantId) {
  if (tenantId === undefined || tenantId === null) catalogCache.clear();
  else catalogCache.delete(Number(tenantId));
}

function fieldKey(objectType, name) {
  return `${objectType}\u0000${name}`;
}

function definitionRow(row) {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    object_type: row.object_type,
    field: row.field,
    display_name: row.display_name || row.field,
    data_type: row.data_type,
    searchable: row.searchable === 1,
    filterable: row.filterable === 1,
    sortable: row.sortable === 1,
    facetable: row.facetable === 1,
    full_text: row.full_text === 1,
    exact_match: row.exact_match === 1,
    wildcard: row.wildcard === 1,
    boost: Number(row.boost ?? 1),
    analyzer: row.analyzer || "standard",
    security_sensitive: row.security_sensitive === 1,
    indexed: row.indexed === 1,
    display_order: row.display_order,
    source: "configured",
  };
}

export function publicFieldDefinition(row) {
  if (!row) return null;
  const def = definitionRow(row);
  return {
    id: def.id,
    tenantId: def.tenant_id,
    objectType: def.object_type,
    field: def.field,
    displayName: def.display_name,
    dataType: def.data_type,
    searchable: def.searchable,
    filterable: def.filterable,
    sortable: def.sortable,
    facetable: def.facetable,
    fullText: def.full_text,
    exactMatch: def.exact_match,
    wildcard: def.wildcard,
    boost: def.boost,
    analyzer: def.analyzer,
    securitySensitive: def.security_sensitive,
    indexed: def.indexed,
    displayOrder: def.display_order,
    source: def.source,
    allowedOperators: operatorsForType(def.data_type),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listFieldDefinitions(db, { tenantId, objectType = null } = {}) {
  const params = [Number(tenantId)];
  let where = "tenant_id = ?";
  if (objectType) {
    where += " AND object_type = ?";
    params.push(String(objectType));
  }
  const rows = queryAll(
    db,
    `SELECT * FROM search_field_definitions WHERE ${where} ORDER BY object_type, display_order, field`,
    params
  );
  return rows.map(publicFieldDefinition);
}

export function getFieldDefinition(db, tenantId, objectType, name) {
  const row = queryOne(
    db,
    "SELECT * FROM search_field_definitions WHERE tenant_id = ? AND object_type = ? AND field = ?",
    [Number(tenantId), String(objectType), String(name)]
  );
  return row ? publicFieldDefinition(row) : null;
}

export function upsertFieldDefinition(db, input = {}, actor, tenantId, ip) {
  const objectType = String(input.objectType ?? input.object_type ?? "").trim();
  const name = String(input.field ?? input.name ?? "").trim();
  if (!objectType || !isValidIdentifier(objectType)) {
    throw new SearchError(SEARCH_ERROR_CODES.OBJECT_TYPE_NOT_FOUND, "A valid object type is required");
  }
  if (!name || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_FIELD, "A valid field name is required");
  }
  const registration = queryOne(
    db,
    "SELECT * FROM search_object_types WHERE tenant_id = ? AND code = ?",
    [Number(tenantId), objectType]
  );
  if (!registration) {
    throw new SearchError(SEARCH_ERROR_CODES.OBJECT_TYPE_NOT_FOUND, `Object type "${objectType}" is not registered`);
  }
  const ts = nowIso();
  const values = {
    display_name: String(input.displayName ?? input.display_name ?? name),
    data_type: normalizeDataType(input.dataType ?? input.data_type),
    searchable: bool(input.searchable, false) ? 1 : 0,
    filterable: bool(input.filterable, false) ? 1 : 0,
    sortable: bool(input.sortable, false) ? 1 : 0,
    facetable: bool(input.facetable, false) ? 1 : 0,
    full_text: bool(input.fullText ?? input.full_text, false) ? 1 : 0,
    exact_match: bool(input.exactMatch ?? input.exact_match, false) ? 1 : 0,
    wildcard: bool(input.wildcard, false) ? 1 : 0,
    boost: clampBoost(input.boost),
    analyzer: String(input.analyzer || "standard"),
    security_sensitive: bool(input.securitySensitive ?? input.security_sensitive, false) ? 1 : 0,
    indexed: bool(input.indexed, true) ? 1 : 0,
    display_order: Number(input.displayOrder ?? input.display_order ?? 100) || 100,
  };
  const existing = queryOne(
    db,
    "SELECT * FROM search_field_definitions WHERE tenant_id = ? AND object_type = ? AND field = ?",
    [Number(tenantId), objectType, name]
  );
  if (existing) {
    run(
      db,
      `UPDATE search_field_definitions SET
         display_name = ?, data_type = ?, searchable = ?, filterable = ?, sortable = ?,
         facetable = ?, full_text = ?, exact_match = ?, wildcard = ?, boost = ?,
         analyzer = ?, security_sensitive = ?, indexed = ?, display_order = ?, updated_at = ?
       WHERE tenant_id = ? AND object_type = ? AND field = ?`,
      [
        values.display_name,
        values.data_type,
        values.searchable,
        values.filterable,
        values.sortable,
        values.facetable,
        values.full_text,
        values.exact_match,
        values.wildcard,
        values.boost,
        values.analyzer,
        values.security_sensitive,
        values.indexed,
        values.display_order,
        ts,
        Number(tenantId),
        objectType,
        name,
      ]
    );
  } else {
    run(
      db,
      `INSERT INTO search_field_definitions
         (tenant_id, object_type, field, display_name, data_type, searchable, filterable, sortable,
          facetable, full_text, exact_match, wildcard, boost, analyzer, security_sensitive, indexed,
          display_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(tenantId),
        objectType,
        name,
        values.display_name,
        values.data_type,
        values.searchable,
        values.filterable,
        values.sortable,
        values.facetable,
        values.full_text,
        values.exact_match,
        values.wildcard,
        values.boost,
        values.analyzer,
        values.security_sensitive,
        values.indexed,
        values.display_order,
        ts,
        ts,
      ]
    );
  }
  writeAudit(db, {
    actor,
    action: existing ? "search.field.update" : "search.field.create",
    resourceType: "search_field_definition",
    resourceId: `${objectType}:${name}`,
    details: { object_type: objectType, field: name, data_type: values.data_type },
    ip,
  });
  invalidateFieldCatalog(tenantId);
  return getFieldDefinition(db, tenantId, objectType, name);
}

export function deleteFieldDefinition(db, tenantId, objectType, name, actor, ip) {
  const existing = queryOne(
    db,
    "SELECT * FROM search_field_definitions WHERE tenant_id = ? AND object_type = ? AND field = ?",
    [Number(tenantId), String(objectType), String(name)]
  );
  if (!existing) throw new SearchError(SEARCH_ERROR_CODES.INVALID_FIELD, "Field definition not found");
  run(db, "DELETE FROM search_field_definitions WHERE id = ?", [existing.id]);
  writeAudit(db, {
    actor,
    action: "search.field.delete",
    resourceType: "search_field_definition",
    resourceId: `${objectType}:${name}`,
    details: { object_type: objectType, field: name },
    ip,
  });
  invalidateFieldCatalog(tenantId);
  return { deleted: true, object_type: objectType, field: name };
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function clampBoost(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return 1;
  return Math.min(num, 100);
}

// Builds the effective per-object-type field catalog: system fields, fields
// derived from the registration, then explicit configured definitions.
export function canonicalFieldCatalog(db, tenantId, { objectTypes = null } = {}) {
  const tenant = Number(tenantId);
  const cached = catalogCache.get(tenant);
  if (cached && !objectTypes) return cached;

  const registrations = queryAll(
    db,
    `SELECT * FROM search_object_types WHERE tenant_id = ? AND status = 'active'`,
    [tenant]
  );
  const wanted = objectTypes ? new Set(objectTypes.map(String)) : null;
  const catalog = new Map();
  const registrationByType = new Map();
  for (const registration of registrations) {
    if (wanted && !wanted.has(registration.code)) continue;
    registrationByType.set(registration.code, registration);
    const fields = new Map();
    for (const base of BASE_FIELDS) fields.set(base.field, { ...base });
    for (const name of listOf(registration.searchable_fields_json)) {
      merge(fields, name, { searchable: true });
    }
    const derived = derivedFieldsForRegistration(registration);
    for (const name of derived.searchable) merge(fields, name, { searchable: true });
    for (const name of derived.filterable) merge(fields, name, { filterable: true });
    for (const name of derived.facetable) merge(fields, name, { facetable: true });
    for (const name of derived.sortable) merge(fields, name, { sortable: true });
    for (const name of listOf(registration.display_fields_json)) merge(fields, name, {});
    catalog.set(registration.code, fields);
  }

  const configured = queryAll(
    db,
    `SELECT * FROM search_field_definitions WHERE tenant_id = ?`,
    [tenant]
  );
  for (const row of configured) {
    const fields = catalog.get(row.object_type);
    if (!fields) continue;
    fields.set(row.field, definitionRow(row));
  }

  if (!objectTypes) catalogCache.set(tenant, catalog);
  return catalog;
}

function merge(fields, name, overrides) {
  const existing = fields.get(name);
  if (existing) {
    fields.set(name, {
      ...existing,
      ...overrides,
      searchable: Boolean(overrides.searchable ?? existing.searchable),
      filterable: Boolean(overrides.filterable ?? existing.filterable),
      sortable: Boolean(overrides.sortable ?? existing.sortable),
      facetable: Boolean(overrides.facetable ?? existing.facetable),
    });
    return;
  }
  fields.set(
    name,
    field(name, "string", { searchable: false, filterable: false, sortable: false, facetable: false, ...overrides })
  );
}

// Ensures explicit field-definition rows exist for a newly registered type so
// administrators can see and tune the effective configuration.
export function seedFieldDefinitionsForType(db, tenantId, registration) {
  if (!registration?.code) return { created: 0 };
  const derived = derivedFieldsForRegistration(registration);
  const fields = new Map();
  for (const base of BASE_FIELDS) fields.set(base.field, { ...base });
  for (const name of derived.searchable) merge(fields, name, { searchable: true });
  for (const name of derived.filterable) merge(fields, name, { filterable: true });
  for (const name of derived.facetable) merge(fields, name, { facetable: true });
  for (const name of derived.sortable) merge(fields, name, { sortable: true });
  let created = 0;
  const ts = nowIso();
  for (const def of fields.values()) {
    if (SPECIAL_FIELDS.has(def.field)) continue;
    const existing = queryOne(
      db,
      "SELECT id FROM search_field_definitions WHERE tenant_id = ? AND object_type = ? AND field = ?",
      [Number(tenantId), registration.code, def.field]
    );
    if (existing) continue;
    run(
      db,
      `INSERT INTO search_field_definitions
         (tenant_id, object_type, field, display_name, data_type, searchable, filterable, sortable,
          facetable, full_text, exact_match, wildcard, boost, analyzer, security_sensitive, indexed,
          display_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(tenantId),
        registration.code,
        def.field,
        def.displayName || def.field,
        def.dataType || "string",
        def.searchable ? 1 : 0,
        def.filterable ? 1 : 0,
        def.sortable ? 1 : 0,
        def.facetable ? 1 : 0,
        def.fullText ? 1 : 0,
        def.exactMatch ? 1 : 0,
        def.wildcard ? 1 : 0,
        def.boost ?? 1,
        def.analyzer || "standard",
        def.securitySensitive ? 1 : 0,
        def.indexed === false ? 0 : 1,
        def.displayOrder ?? 100,
        ts,
        ts,
      ]
    );
    created += 1;
  }
  invalidateFieldCatalog(tenantId);
  return { created };
}

export function ensureDefaultFieldDefinitions(db) {
  const tenants = queryAll(db, "SELECT DISTINCT tenant_id FROM search_object_types");
  let created = 0;
  for (const row of tenants) {
    const registrations = queryAll(
      db,
      "SELECT * FROM search_object_types WHERE tenant_id = ?",
      [Number(row.tenant_id)]
    );
    for (const registration of registrations) {
      created += seedFieldDefinitionsForType(db, row.tenant_id, registration).created;
    }
  }
  return { created };
}

// Maps a canonical field name to the internal provider field identifier.
export function internalFieldFor(name) {
  if (DIRECT_FIELDS.has(name) || SPECIAL_FIELDS.has(name)) return name;
  return `${ATTRIBUTE_PREFIX}${name}`;
}

// Validates a canonical query against the effective field catalog. Returns the
// resolved catalog so execution can translate fields without re-querying.
export function validateCanonicalQuery(db, canonical, { tenantId, availableTypes } = {}) {
  const tenant = Number(tenantId);
  const types = availableTypes || [...canonicalFieldCatalog(db, tenant).keys()];
  const requested = canonical.objectTypes.length ? canonical.objectTypes : types;
  for (const type of requested) {
    if (!types.includes(type)) {
      throw new SearchError(
        SEARCH_ERROR_CODES.OBJECT_TYPE_NOT_FOUND,
        `Search object type "${type}" is not registered`
      );
    }
  }
  const catalog = canonicalFieldCatalog(db, tenant, requested.length ? { objectTypes: requested } : {});

  const conditionCount =
    canonical.filters.length + countConditionLeaves(canonical.condition);
  if (conditionCount > CONDITION_COUNT_MAX) {
    throw new SearchError(
      SEARCH_ERROR_CODES.QUERY_TOO_COMPLEX,
      `Too many search conditions (max ${CONDITION_COUNT_MAX})`
    );
  }

  for (const filter of canonical.filters) validateFilter(catalog, requested, filter);
  validateCondition(catalog, requested, canonical.condition);

  for (const entry of canonical.sort) {
    const allowed = requested.some((type) => catalog.get(type)?.get(entry.field)?.sortable);
    if (!allowed) {
      throw new SearchError(SEARCH_ERROR_CODES.FIELD_NOT_SORTABLE, `Field "${entry.field}" is not sortable`);
    }
  }
  for (const facet of canonical.facets) {
    const allowed = requested.some((type) => catalog.get(type)?.get(facet)?.facetable);
    if (!allowed) {
      throw new SearchError(SEARCH_ERROR_CODES.FIELD_NOT_FACETABLE, `Field "${facet}" is not facetable`);
    }
  }

  return { catalog, objectTypes: requested };
}

function countConditionLeaves(node) {
  if (!node) return 0;
  return node.filters.length + node.conditions.reduce((sum, child) => sum + countConditionLeaves(child), 0);
}

function validateCondition(catalog, requested, node) {
  if (!node) return;
  for (const filter of node.filters) validateFilter(catalog, requested, filter);
  for (const child of node.conditions) validateCondition(catalog, requested, child);
}

function validateFilter(catalog, requested, filter) {
  const definitions = requested
    .map((type) => catalog.get(type)?.get(filter.field))
    .filter(Boolean);
  if (!definitions.length) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_FIELD, `Unknown search field "${filter.field}"`);
  }
  const filterable = definitions.some((def) => def.filterable || filter.field.startsWith("_"));
  if (!filterable) {
    throw new SearchError(SEARCH_ERROR_CODES.FIELD_NOT_FILTERABLE, `Field "${filter.field}" is not filterable`);
  }
  const dataType = definitions[0].dataType || definitions[0].data_type || "string";
  if (!operatorAllows(filter.operator, dataType)) {
    throw new SearchError(
      SEARCH_ERROR_CODES.INVALID_OPERATOR,
      `Operator ${filter.operator} is not valid for ${dataType} field "${filter.field}"`
    );
  }
  const def = definitions[0];
  if (filter.operator === "WILDCARD") {
    if (def.wildcard === false) {
      throw new SearchError(
        SEARCH_ERROR_CODES.INVALID_OPERATOR,
        `Wildcard search is not enabled for field "${filter.field}"`
      );
    }
    assertWildcard(filter.value);
  }
  if (
    filter.operator === "BETWEEN" &&
    (!Array.isArray(filter.value) || filter.value.length !== 2)
  ) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "BETWEEN expects a two-element array");
  }
  if (typeof filter.value === "string" && filter.value.length > 400) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "Filter value is too long");
  }
  return true;
}

// Wildcard complexity guard. Prevents `*` / `?` patterns that would force an
// unbounded scan, without exposing provider query syntax.
export const WILDCARD_MAX_TOKENS = 5;
export const WILDCARD_MIN_LITERAL = 2;

export function assertWildcard(value) {
  const pattern = String(value ?? "");
  if (!pattern) {
    throw new SearchError(SEARCH_ERROR_CODES.INVALID_QUERY, "Wildcard pattern is empty");
  }
  if (pattern.length > 128) {
    throw new SearchError(SEARCH_ERROR_CODES.WILDCARD_TOO_BROAD, "Wildcard pattern is too long");
  }
  const wildcards = (pattern.match(/[*?]/g) || []).length;
  if (wildcards > WILDCARD_MAX_TOKENS) {
    throw new SearchError(
      SEARCH_ERROR_CODES.WILDCARD_TOO_BROAD,
      `Wildcard pattern has too many wildcards (max ${WILDCARD_MAX_TOKENS})`
    );
  }
  const literal = pattern.replace(/[*?]/g, "");
  const minLiteral = /^[*?]/.test(pattern) ? WILDCARD_MIN_LITERAL + 1 : WILDCARD_MIN_LITERAL;
  if (literal.length < minLiteral) {
    throw new SearchError(
      SEARCH_ERROR_CODES.WILDCARD_TOO_BROAD,
      "Wildcard pattern is too broad; add more literal characters"
    );
  }
  return pattern;
}

export const FIELD_DATA_TYPES = SEARCH_DATA_TYPES;
export { normalizeOperator };
