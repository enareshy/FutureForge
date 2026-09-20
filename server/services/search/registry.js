// Searchable object type registry. Business modules declare which object
// types participate in search and how they map into the index.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { publicObjectType, objectTypeRow, safeParse } from "./repository.js";
import { registerBuiltinSources } from "./sources.js";
import { OBJECT_TYPE_STATUSES, isValidIdentifier } from "./validation.js";
import { ensureConfiguration, getConfiguration } from "./config.js";
import { searchState, setRegisteredObjectTypes, setSearchEnabled } from "./state.js";
import { seedFieldDefinitionsForType, ensureDefaultFieldDefinitions, invalidateFieldCatalog } from "./fields.js";

function normalizeList(input, fallback = []) {
  if (input === undefined) return fallback;
  if (input === null) return [];
  const list = Array.isArray(input) ? input : [input];
  return [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
}

export function listObjectTypes(db, { tenantId, includeDisabled = false } = {}) {
  const rows = queryAll(
    db,
    `SELECT * FROM search_object_types
     WHERE tenant_id = ? ${includeDisabled ? "" : "AND status = 'active'"}
     ORDER BY display_order, code`,
    [Number(tenantId)]
  );
  return rows.map(publicObjectType);
}

export function getObjectType(db, code, tenantId) {
  const row = objectTypeRow(db, code, tenantId);
  if (!row) throw new HttpError(404, "Search object type not found");
  return publicObjectType(row);
}

export function registerObjectType(db, input = {}, actor, tenantId, ip) {
  const code = String(input.code || "").trim();
  if (!code || !isValidIdentifier(code)) {
    throw new HttpError(400, "A valid object type code is required");
  }
  const name = String(input.name ?? code).trim() || code;
  const existing = objectTypeRow(db, code, tenantId);
  const ts = nowIso();
  const values = {
    name,
    description: String(input.description || ""),
    source_module: String(input.source_module ?? input.sourceModule ?? ""),
    source_table: String(input.source_table ?? input.sourceTable ?? ""),
    key_column: String(input.key_column ?? input.keyColumn ?? "id"),
    title_attribute: String(input.title_attribute ?? input.titleAttribute ?? "name"),
    subtitle_attribute: String(input.subtitle_attribute ?? input.subtitleAttribute ?? ""),
    summary_attribute: String(input.summary_attribute ?? input.summaryAttribute ?? "description"),
    body_attributes: normalizeList(input.body_attributes ?? input.bodyAttributes, []),
    facet_attributes: normalizeList(input.facet_attributes ?? input.facetAttributes, []),
    filter_attributes: normalizeList(input.filter_attributes ?? input.filterAttributes, []),
    relationship_types: normalizeList(input.relationship_types ?? input.relationshipTypes, []),
    index_name: String(input.index_name ?? input.indexName ?? ""),
    identifier_field: String(input.identifier_field ?? input.identifierField ?? "id"),
    searchable_fields: normalizeList(input.searchable_fields ?? input.searchableFields, []),
    sortable_fields: normalizeList(input.sortable_fields ?? input.sortableFields, []),
    facetable_fields: normalizeList(input.facetable_fields ?? input.facetableFields, []),
    display_fields: normalizeList(input.display_fields ?? input.displayFields, []),
    relationship_fields: normalizeList(input.relationship_fields ?? input.relationshipFields, []),
    security_policy: ["tenant", "organization", "site", "object", "public"].includes(
      input.security_policy ?? input.securityPolicy
    )
      ? input.security_policy ?? input.securityPolicy
      : "tenant",
    indexing_strategy: ["event", "manual", "scheduled", "none"].includes(
      input.indexing_strategy ?? input.indexingStrategy
    )
      ? input.indexing_strategy ?? input.indexingStrategy
      : "event",
    permission_resource: String(input.permission_resource ?? input.permissionResource ?? ""),
    permission_action: String(input.permission_action ?? input.permissionAction ?? "read"),
    sensitivity: ["public", "internal", "confidential", "restricted"].includes(input.sensitivity)
      ? input.sensitivity
      : "internal",
    display_order: Number(input.display_order ?? input.displayOrder ?? 100) || 100,
    status: OBJECT_TYPE_STATUSES.includes(input.status) ? input.status : "active",
  };
  if (existing) {
    run(
      db,
      `UPDATE search_object_types SET
         name = ?, description = ?, source_module = ?, source_table = ?, key_column = ?,
         title_attribute = ?, subtitle_attribute = ?, summary_attribute = ?,
         body_attributes_json = ?, facet_attributes_json = ?, filter_attributes_json = ?,
         relationship_types_json = ?, index_name = ?, identifier_field = ?,
         searchable_fields_json = ?, sortable_fields_json = ?, facetable_fields_json = ?,
         display_fields_json = ?, relationship_fields_json = ?, security_policy = ?,
         indexing_strategy = ?, permission_resource = ?, permission_action = ?,
         sensitivity = ?, display_order = ?, status = ?, updated_at = ?
       WHERE tenant_id = ? AND code = ?`,
      [
        values.name,
        values.description,
        values.source_module,
        values.source_table,
        values.key_column,
        values.title_attribute,
        values.subtitle_attribute,
        values.summary_attribute,
        JSON.stringify(values.body_attributes),
        JSON.stringify(values.facet_attributes),
        JSON.stringify(values.filter_attributes),
        JSON.stringify(values.relationship_types),
        values.index_name,
        values.identifier_field,
        JSON.stringify(values.searchable_fields),
        JSON.stringify(values.sortable_fields),
        JSON.stringify(values.facetable_fields),
        JSON.stringify(values.display_fields),
        JSON.stringify(values.relationship_fields),
        values.security_policy,
        values.indexing_strategy,
        values.permission_resource,
        values.permission_action,
        values.sensitivity,
        values.display_order,
        values.status,
        ts,
        Number(tenantId),
        code,
      ]
    );
  } else {
    run(
      db,
      `INSERT INTO search_object_types
         (tenant_id, code, name, description, source_module, source_table, key_column,
          title_attribute, subtitle_attribute, summary_attribute, body_attributes_json,
          facet_attributes_json, filter_attributes_json, relationship_types_json,
          index_name, identifier_field, searchable_fields_json, sortable_fields_json,
          facetable_fields_json, display_fields_json, relationship_fields_json,
          security_policy, indexing_strategy,
          permission_resource, permission_action, sensitivity, display_order, status,
          registered_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        Number(tenantId),
        code,
        values.name,
        values.description,
        values.source_module,
        values.source_table,
        values.key_column,
        values.title_attribute,
        values.subtitle_attribute,
        values.summary_attribute,
        JSON.stringify(values.body_attributes),
        JSON.stringify(values.facet_attributes),
        JSON.stringify(values.filter_attributes),
        JSON.stringify(values.relationship_types),
        values.index_name,
        values.identifier_field,
        JSON.stringify(values.searchable_fields),
        JSON.stringify(values.sortable_fields),
        JSON.stringify(values.facetable_fields),
        JSON.stringify(values.display_fields),
        JSON.stringify(values.relationship_fields),
        values.security_policy,
        values.indexing_strategy,
        values.permission_resource,
        values.permission_action,
        values.sensitivity,
        values.display_order,
        values.status,
        actor?.id ?? null,
        ts,
        ts,
      ]
    );
  }
  writeAudit(db, {
    actor,
    action: existing ? "search.object_type.update" : "search.object_type.register",
    resourceType: "search_object_type",
    resourceId: code,
    details: { code, tenant_id: Number(tenantId), status: values.status },
    ip,
  });
  refreshState(db);
  const finalized = getObjectType(db, code, tenantId);
  seedFieldDefinitionsForType(db, tenantId, finalized);
  return finalized;
}

export function updateObjectType(db, code, patch = {}, actor, tenantId, ip) {
  const existing = objectTypeRow(db, code, tenantId);
  if (!existing) throw new HttpError(404, "Search object type not found");
  return registerObjectType(db, { ...publicObjectType(existing), ...patch, code }, actor, tenantId, ip);
}

export function setObjectTypeStatus(db, code, status, actor, tenantId, ip) {
  if (!OBJECT_TYPE_STATUSES.includes(status)) {
    throw new HttpError(400, `status must be one of ${OBJECT_TYPE_STATUSES.join(", ")}`);
  }
  const existing = objectTypeRow(db, code, tenantId);
  if (!existing) throw new HttpError(404, "Search object type not found");
  run(db, "UPDATE search_object_types SET status = ?, updated_at = ? WHERE tenant_id = ? AND code = ?", [
    status,
    nowIso(),
    Number(tenantId),
    code,
  ]);
  writeAudit(db, {
    actor,
    action: "search.object_type.status",
    resourceType: "search_object_type",
    resourceId: code,
    details: { status },
    ip,
  });
  refreshState(db);
  return getObjectType(db, code, tenantId);
}

export function deleteObjectType(db, code, actor, tenantId, ip) {
  const existing = objectTypeRow(db, code, tenantId);
  if (!existing) throw new HttpError(404, "Search object type not found");
  run(db, "DELETE FROM search_object_types WHERE tenant_id = ? AND code = ?", [Number(tenantId), code]);
  run(db, "DELETE FROM search_index WHERE tenant_id = ? AND object_type = ?", [Number(tenantId), code]);
  run(db, "DELETE FROM search_relationships WHERE tenant_id = ? AND (source_type = ? OR target_type = ?)", [
    Number(tenantId),
    code,
    code,
  ]);
  run(db, "DELETE FROM search_index_status WHERE tenant_id = ? AND object_type = ?", [Number(tenantId), code]);
  run(db, "DELETE FROM search_field_definitions WHERE tenant_id = ? AND object_type = ?", [Number(tenantId), code]);
  invalidateFieldCatalog(tenantId);
  writeAudit(db, {
    actor,
    action: "search.object_type.delete",
    resourceType: "search_object_type",
    resourceId: code,
    details: { tenant_id: Number(tenantId) },
    ip,
  });
  refreshState(db);
  return { deleted: true, code };
}

export function tenantIds(db) {
  const rows = queryAll(
    db,
    "SELECT DISTINCT tenant_id FROM organizations WHERE tenant_id IS NOT NULL ORDER BY tenant_id"
  );
  return rows.map((row) => Number(row.tenant_id));
}

const DEFAULT_REGISTRATIONS = [
  {
    code: "object",
    name: "Business objects",
    description: "Objects, their attributes, lifecycle and relationships",
    source_module: "objects",
    source_table: "objects",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["description", "tags", "external_ref", "external_system"],
    facet_attributes: ["object_type_code", "status", "lifecycle_state"],
    filter_attributes: ["object_type_code", "status", "revision"],
    permission_resource: "iam.objects.instances",
    display_order: 10,
  },
  {
    code: "file",
    name: "Documents & files",
    description: "File documents, versions and business associations",
    source_module: "files",
    source_table: "files",
    title_attribute: "name",
    subtitle_attribute: "original_name",
    summary_attribute: "description",
    body_attributes: ["description", "extension", "file_category"],
    facet_attributes: ["file_category", "status", "security_classification"],
    filter_attributes: ["file_category", "extension", "mime_type"],
    permission_resource: "iam.files.browser",
    display_order: 20,
  },
];

export function ensureDefaultRegistrations(db) {
  let created = 0;
  for (const tenantId of tenantIds(db)) {
    ensureConfiguration(db, tenantId);
    for (const def of DEFAULT_REGISTRATIONS) {
      if (objectTypeRow(db, def.code, tenantId)) continue;
      registerObjectType(db, def, null, tenantId, null);
      created += 1;
    }
  }
  return { created, registrations: DEFAULT_REGISTRATIONS };
}

// Recomputes the active object type set held in process state so that change
// hooks can cheaply decide whether to enqueue work.
export function refreshState(db) {
  const rows = queryAll(
    db,
    "SELECT DISTINCT code FROM search_object_types WHERE status = 'active'"
  );
  setRegisteredObjectTypes(rows.map((row) => row.code));
  setSearchEnabled(rows.length > 0);
  searchState.initialized = true;
  return rows.map((row) => row.code);
}

export function initializeSearch(db) {
  registerBuiltinSources();
  ensureDefaultRegistrations(db);
  ensureDefaultFieldDefinitions(db);
  const codes = refreshState(db);
  return { enabled: searchState.enabled, object_types: codes };
}

export function searchableObjectTypes(db, tenantId) {
  const config = getConfiguration(db, tenantId);
  const excluded = new Set((config.excluded_types || []).map((code) => String(code)));
  return listObjectTypes(db, { tenantId }).filter((type) => !excluded.has(type.code));
}

export function searchableObjectTypeCodes(db, tenantId) {
  return searchableObjectTypes(db, tenantId).map((type) => type.code);
}

export { DEFAULT_REGISTRATIONS };
