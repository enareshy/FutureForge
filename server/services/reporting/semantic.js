// Semantic layer (§22).
//
// Reports, dashboards, KPIs and BI datasets talk to *business entities* and
// *business attributes*, never to database tables. This module declares the
// reusable semantic model and resolves each entity into flat, authorized
// records that the query engine can filter, group and aggregate without any
// knowledge of the underlying storage.
//
// The layer never becomes a source of truth: it reads the owning platform
// tables (object model, PDM, BOM, workflow) through fixed, parameterized
// queries and always applies centralized authorization before returning rows.
import { queryAll } from "../../db.js";
import { SEMANTIC_ENTITIES } from "./constants.js";
import { unknownEntity, unknownAttribute } from "./errors.js";
import { createRecordAuthorizer } from "./security.js";
import { parseJson } from "./repository.js";

const ENTITY_BY_CODE = new Map(SEMANTIC_ENTITIES.map((entry) => [entry.code, entry]));

export function listEntities() {
  return SEMANTIC_ENTITIES.map((entity) => ({
    code: entity.code,
    name: entity.name,
    domain: entity.domain,
    source: entity.source,
    object_type: entity.object_type,
    description: entity.description,
    attributes: entity.attributes.map((attribute) => ({ ...attribute })),
  }));
}

export function getEntity(code) {
  const entity = ENTITY_BY_CODE.get(String(code || ""));
  if (!entity) throw unknownEntity(code);
  return entity;
}

export function entityAttributeMap(code) {
  const entity = getEntity(code);
  return new Map(entity.attributes.map((attribute) => [attribute.code, attribute]));
}

export function requireAttribute(entityCode, attributeCode) {
  const map = entityAttributeMap(entityCode);
  const attribute = map.get(String(attributeCode || ""));
  if (!attribute) throw unknownAttribute(entityCode, attributeCode);
  return attribute;
}

function nestedValue(source, path) {
  return String(path || "")
    .split(".")
    .filter(Boolean)
    .reduce((current, key) => (current === null || current === undefined ? undefined : current[key]), source);
}

function readAttribute(row, attribute) {
  if (!attribute) return undefined;
  if (attribute.derived) return row._derived?.[attribute.derived];
  if (attribute.json_path) return nestedValue(row.data_values || {}, attribute.json_path);
  if (attribute.column) return row[attribute.column];
  return undefined;
}

function baseRecord(entity, row) {
  return {
    object_type: entity.source === "object" ? row.type_code || entity.object_type || "object" : entity.source,
    object_id: String(row.id),
    organization_id: row.organization_id ?? null,
    classification: row.classification_code || "",
    _row: row,
    _derived: {},
  };
}

// Resolves an entity to a list of authorized flat records. `limit` bounds the
// number of operational rows read before authorization; the query engine
// applies the tenant's configured row limit on top.
export function resolveEntityRows(db, entityCode, { tenantId, actor, organizationId = null, ip = null, context = null, limit = 50000, system = false } = {}) {
  const entity = getEntity(entityCode);
  const tenant = Number(tenantId);
  const cappedLimit = Math.min(100000, Math.max(1, Number(limit) || 50000));
  const rawRows = readSource(db, entity, tenant, cappedLimit);

  const records = rawRows.map((row) => baseRecord(entity, row));
  attachDerived(db, entity, tenant, rawRows, records);

  const attributes = entityAttributeMap(entity.code);
  const projected = records.map((record) => {
    const values = {};
    for (const attribute of attributes.values()) values[attribute.code] = normalizeValue(attribute.derived ? record._derived?.[attribute.derived] : readAttribute(record._row, attribute), attribute);
    return {
      object_type: record.object_type,
      object_id: record.object_id,
      organization_id: record.organization_id,
      classification: record.classification,
      attributes: values,
    };
  });

  // The read-model builder runs as the platform, not as a subject: it copies
  // every row; per-subject authorization is applied when the model is queried.
  if (system) return { records: projected, denied: 0, total_before_security: projected.length };

  const authorizer = createRecordAuthorizer(db, actor, { tenantId: tenant, action: "read", organizationId, ip, context });
  return { records: authorizer.filter(projected), denied: authorizer.deniedCount(projected), total_before_security: projected.length };
}

function readSource(db, entity, tenant, limit) {
  if (entity.source === "object") {
    if (entity.object_type) {
      return queryAll(
        db,
        `SELECT o.*, t.code AS type_code FROM objects o
           JOIN metadata_types t ON t.id = o.object_type_id
          WHERE o.tenant_id = ? AND o.deleted_at IS NULL AND t.code = ?
          ORDER BY o.id LIMIT ?`,
        [tenant, entity.object_type, limit]
      );
    }
    return queryAll(
      db,
      `SELECT o.*, t.code AS type_code FROM objects o
         JOIN metadata_types t ON t.id = o.object_type_id
        WHERE o.tenant_id = ? AND o.deleted_at IS NULL
        ORDER BY o.id LIMIT ?`,
      [tenant, limit]
    );
  }
  if (entity.source === "pdm_item") {
    return queryAll(db, "SELECT * FROM pdm_items WHERE tenant_id = ? ORDER BY id LIMIT ?", [tenant, limit]);
  }
  if (entity.source === "bom_line") {
    return queryAll(db, "SELECT * FROM bom_lines WHERE tenant_id = ? ORDER BY id LIMIT ?", [tenant, limit]);
  }
  if (entity.source === "workflow_instance") {
    return queryAll(db, "SELECT * FROM workflow_instances WHERE tenant_id = ? ORDER BY id LIMIT ?", [tenant, limit]);
  }
  return [];
}

function attachDerived(db, entity, tenant, rawRows, records) {
  const dataValues = rawRows.map((row) => parseJson(row.data_json, {}));
  rawRows.forEach((row, index) => {
    if (row.data_json !== undefined) row.data_values = dataValues[index];
  });

  const derivedCodes = new Set(entity.attributes.filter((attribute) => attribute.derived).map((attribute) => attribute.derived));
  if (!derivedCodes.size) return;
  if (derivedCodes.has("object_type")) {
    for (const record of records) record._derived.object_type = record._row.type_code || entity.object_type || entity.source;
  }
  if (derivedCodes.has("bom_component_count")) {
    const counts = new Map(
      queryAll(db, "SELECT parent_object_id AS pid, COUNT(*) AS c FROM bom_lines WHERE tenant_id = ? GROUP BY parent_object_id", [tenant]).map((row) => [
        String(row.pid),
        Number(row.c),
      ])
    );
    for (const record of records) record._derived.bom_component_count = counts.get(record.object_id) ?? 0;
  }
  if (derivedCodes.has("open_change_count")) {
    const counts = new Map(
      queryAll(
        db,
        "SELECT object_id AS oid, COUNT(*) AS c FROM workflow_instances WHERE tenant_id = ? AND status IN ('running','paused','pending') GROUP BY object_id",
        [tenant]
      ).map((row) => [String(row.oid), Number(row.c)])
    );
    for (const record of records) record._derived.open_change_count = counts.get(record.object_id) ?? 0;
  }
}

function normalizeValue(value, attribute) {
  if (value === null || value === undefined) return null;
  if (attribute.type === "NUMBER") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (attribute.type === "BOOL") return Boolean(value);
  return value;
}
