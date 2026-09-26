// Row → DTO mapping and shared lookups for the Search & Discovery Framework.
import { queryOne } from "../../db.js";

export function safeParse(json, fallback = {}) {
  if (json === null || json === undefined || json === "") return fallback;
  if (typeof json === "object") return json;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

export function publicObjectType(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    source_module: row.source_module || "",
    source_table: row.source_table || "",
    key_column: row.key_column || "id",
    title_attribute: row.title_attribute || "name",
    subtitle_attribute: row.subtitle_attribute || "",
    summary_attribute: row.summary_attribute || "",
    body_attributes: safeParse(row.body_attributes_json, []),
    facet_attributes: safeParse(row.facet_attributes_json, []),
    filter_attributes: safeParse(row.filter_attributes_json, []),
    relationship_types: safeParse(row.relationship_types_json, []),
    index_name: row.index_name || "",
    identifier_field: row.identifier_field || "id",
    searchable_fields: safeParse(row.searchable_fields_json, []),
    sortable_fields: safeParse(row.sortable_fields_json, []),
    facetable_fields: safeParse(row.facetable_fields_json, []),
    display_fields: safeParse(row.display_fields_json, []),
    relationship_fields: safeParse(row.relationship_fields_json, []),
    security_policy: row.security_policy || "tenant",
    indexing_strategy: row.indexing_strategy || "event",
    permission_resource: row.permission_resource || "",
    permission_action: row.permission_action || "read",
    sensitivity: row.sensitivity,
    display_order: row.display_order,
    status: row.status,
    registered_by: row.registered_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicIndexedDocument(row, { includeInternal = false } = {}) {
  if (!row) return null;
  const doc = {
    id: row.id,
    object_type: row.object_type,
    object_id: row.object_id,
    object_uuid: row.object_uuid || null,
    code: row.code || "",
    title: row.title,
    subtitle: row.subtitle || "",
    summary: row.summary || "",
    status: row.status,
    lifecycle_state: row.lifecycle_state || "",
    owner_id: row.owner_id ?? null,
    owner_name: row.owner_name || "",
    classification: row.classification,
    tags: safeParse(row.tags_json, []),
    attributes: safeParse(row.attributes_json, {}),
    relationships: safeParse(row.relationships_json, []),
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    site_id: row.site_id ?? null,
    external_reference: row.external_reference || "",
    source_revision: row.source_revision ?? null,
    revisions: row.revisions || "",
    indexed_at: row.indexed_at,
    updated_at: row.updated_at,
    score: row.score ?? null,
    highlights: row.highlights ?? undefined,
  };
  if (includeInternal) {
    doc.searchable_text = row.searchable_text || "";
    doc.score_weight = row.score_weight;
  }
  return doc;
}

export function publicSavedSearch(row) {
  if (!row) return null;
  return {
    id: row.id,
    uuid: row.uuid,
    tenant_id: row.tenant_id,
    owner_id: row.owner_id ?? null,
    name: row.name,
    description: row.description || "",
    query: safeParse(row.query_json, {}),
    strategy: row.strategy,
    is_shared: row.is_shared === 1,
    sharing_scope: row.sharing_scope,
    use_count: row.use_count,
    last_used_at: row.last_used_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicHistoryEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id ?? null,
    query: row.query_text,
    strategy: row.strategy,
    scope: row.scope,
    filters: safeParse(row.filters_json, {}),
    result_count: row.result_count,
    duration_ms: row.duration_ms,
    saved_search_id: row.saved_search_id ?? null,
    executed_at: row.executed_at,
  };
}

export function publicExport(row) {
  if (!row) return null;
  return {
    id: row.id,
    uuid: row.uuid,
    tenant_id: row.tenant_id,
    requested_by: row.requested_by ?? null,
    name: row.name || "",
    query: safeParse(row.query_json, {}),
    format: row.format,
    status: row.status,
    row_count: row.row_count,
    file_id: row.file_id ?? null,
    has_result: Boolean(row.result_json),
    error: row.error || null,
    expires_at: row.expires_at || null,
    completed_at: row.completed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicIndexStatus(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    object_type: row.object_type,
    object_id: row.object_id,
    operation: row.operation,
    reason: row.reason || "",
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    available_at: row.available_at,
    locked_at: row.locked_at || null,
    last_error: row.last_error || null,
    correlation_id: row.correlation_id || "",
    indexed_at: row.indexed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function defaultConfiguration() {
  return {
    enabled: true,
    default_scope: "tenant",
    page_size: 20,
    max_results: 500,
    min_query_length: 2,
    max_query_length: 400,
    highlight: true,
    fuzzy: true,
    history_retention_days: 90,
    index_files: true,
    excluded_types: [],
    default_sort: "relevance",
    settings: {},
  };
}

export function publicConfiguration(row) {
  const defaults = defaultConfiguration();
  if (!row) return defaults;
  return {
    tenant_id: row.tenant_id,
    enabled: row.enabled === 1,
    default_scope: row.default_scope,
    page_size: row.page_size,
    max_results: row.max_results,
    min_query_length: row.min_query_length,
    max_query_length: row.max_query_length,
    highlight: row.highlight === 1,
    fuzzy: row.fuzzy === 1,
    history_retention_days: row.history_retention_days,
    index_files: row.index_files === 1,
    excluded_types: safeParse(row.excluded_types_json, []),
    default_sort: row.default_sort,
    settings: safeParse(row.settings_json, {}),
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function objectTypeRow(db, code, tenantId) {
  if (!code) return null;
  return queryOne(db, "SELECT * FROM search_object_types WHERE tenant_id = ? AND code = ?", [
    Number(tenantId),
    String(code),
  ]);
}

export function indexRow(db, tenantId, objectType, objectId) {
  return queryOne(
    db,
    "SELECT * FROM search_index WHERE tenant_id = ? AND object_type = ? AND object_id = ?",
    [Number(tenantId), String(objectType), String(objectId)]
  );
}

export function savedSearchRow(db, reference, tenantId) {
  if (reference === undefined || reference === null || reference === "") return null;
  const text = String(reference);
  if (/^\d+$/.test(text)) {
    return queryOne(db, "SELECT * FROM search_saved_searches WHERE id = ? AND tenant_id = ?", [
      Number(text),
      Number(tenantId),
    ]);
  }
  return queryOne(db, "SELECT * FROM search_saved_searches WHERE uuid = ? AND tenant_id = ?", [
    text,
    Number(tenantId),
  ]);
}

export function exportRow(db, reference, tenantId) {
  if (reference === undefined || reference === null || reference === "") return null;
  const text = String(reference);
  if (/^\d+$/.test(text)) {
    return queryOne(db, "SELECT * FROM search_exports WHERE id = ? AND tenant_id = ?", [
      Number(text),
      Number(tenantId),
    ]);
  }
  return queryOne(db, "SELECT * FROM search_exports WHERE uuid = ? AND tenant_id = ?", [
    text,
    Number(tenantId),
  ]);
}

export function configRow(db, tenantId) {
  return queryOne(db, "SELECT * FROM search_configuration WHERE tenant_id = ?", [Number(tenantId)]);
}
