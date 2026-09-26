// Low-level persistence helpers for Reporting & Analytics.
//
// Rows are stored with `*_json` text columns; these helpers expand them into
// nested DTOs so the service layer never sees serialization details. All list
// queries go through `paged` so pagination, filtering and ordering stay
// consistent and safe (values are always bound, never interpolated).
import { queryAll, queryOne } from "../../db.js";

export function parseJson(raw, fallback = null) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function stringifyJson(value, fallback = "{}") {
  if (value === undefined) return fallback;
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return fallback;
  }
}

export function paged(db, table, { where = [], params = [], orderBy = "id DESC", page = 1, pageSize = 50, map = (row) => row } = {}) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeSize = Math.min(500, Math.max(1, Number(pageSize) || 50));
  const offset = (safePage - 1) * safeSize;
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} ${clause}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM ${table} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, safeSize, offset]);
  return { items: rows.map(map), total, page: safePage, pageSize: safeSize };
}

export function publicReport(row) {
  if (!row) return null;
  return {
    id: row.id,
    report_ref: row.report_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    site: row.site,
    code: row.code,
    name: row.name,
    description: row.description,
    report_type: row.report_type,
    data_source: row.data_source,
    entity: row.entity,
    definition: parseJson(row.definition_json, {}),
    visualization: parseJson(row.visualization_json, {}),
    security_scope: parseJson(row.security_scope_json, {}),
    visibility: row.visibility,
    visibility_subject: row.visibility_subject,
    owner_user_id: row.owner_user_id,
    version: row.version,
    status: row.status,
    immutable: Boolean(row.immutable),
    published_at: row.published_at,
    published_by: row.published_by,
    metadata: parseJson(row.metadata_json, {}),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicDashboard(row) {
  if (!row) return null;
  return {
    id: row.id,
    dashboard_ref: row.dashboard_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    site: row.site,
    code: row.code,
    name: row.name,
    description: row.description,
    dashboard_type: row.dashboard_type,
    layout: parseJson(row.layout_json, {}),
    visibility: row.visibility,
    visibility_subject: row.visibility_subject,
    owner_user_id: row.owner_user_id,
    version: row.version,
    status: row.status,
    immutable: Boolean(row.immutable),
    is_default: Boolean(row.is_default),
    published_at: row.published_at,
    published_by: row.published_by,
    metadata: parseJson(row.metadata_json, {}),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicWidget(row) {
  if (!row) return null;
  return {
    id: row.id,
    widget_ref: row.widget_ref,
    dashboard_id: row.dashboard_id,
    tenant_id: row.tenant_id,
    widget_type: row.widget_type,
    title: row.title,
    report_id: row.report_id,
    kpi_id: row.kpi_id,
    metric_id: row.metric_id,
    sequence: row.sequence,
    config: parseJson(row.config_json, {}),
    layout: parseJson(row.layout_json, {}),
    filters: parseJson(row.filters_json, []),
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicMetric(row) {
  if (!row) return null;
  return {
    id: row.id,
    metric_ref: row.metric_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    code: row.code,
    name: row.name,
    description: row.description,
    entity: row.entity,
    aggregation: row.aggregation,
    attribute: row.attribute,
    filters: parseJson(row.filters_json, []),
    formula: row.formula,
    unit: row.unit,
    version: row.version,
    status: row.status,
    metadata: parseJson(row.metadata_json, {}),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicKpi(row) {
  if (!row) return null;
  return {
    id: row.id,
    kpi_ref: row.kpi_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    code: row.code,
    name: row.name,
    description: row.description,
    metric_code: row.metric_code,
    entity: row.entity,
    aggregation: row.aggregation,
    attribute: row.attribute,
    filters: parseJson(row.filters_json, []),
    formula: row.formula,
    target: row.target,
    thresholds: parseJson(row.thresholds_json, {}),
    direction: row.direction,
    unit: row.unit,
    frequency: row.frequency,
    owner_user_id: row.owner_user_id,
    security_scope: parseJson(row.security_scope_json, {}),
    version: row.version,
    status: row.status,
    metadata: parseJson(row.metadata_json, {}),
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicExecution(row) {
  if (!row) return null;
  return {
    id: row.id,
    execution_ref: row.execution_ref,
    tenant_id: row.tenant_id,
    report_id: row.report_id,
    report_code: row.report_code,
    dashboard_id: row.dashboard_id,
    kpi_id: row.kpi_id,
    mode: row.mode,
    status: row.status,
    user_id: row.user_id,
    parameters: parseJson(row.parameters_json, {}),
    query: parseJson(row.query_json, {}),
    result_summary: parseJson(row.result_json, {}),
    row_count: row.row_count,
    duration_ms: row.duration_ms,
    cache_hit: Boolean(row.cache_hit),
    error_code: row.error_code,
    error_message: row.error_message,
    correlation_id: row.correlation_id,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
  };
}

export function publicExport(row) {
  if (!row) return null;
  return {
    id: row.id,
    export_ref: row.export_ref,
    tenant_id: row.tenant_id,
    report_id: row.report_id,
    execution_id: row.execution_id,
    format: row.format,
    status: row.status,
    platform_job_id: row.platform_job_id,
    row_count: row.row_count,
    size_bytes: row.size_bytes,
    storage_uri: row.storage_uri,
    file_name: row.file_name,
    content_type: row.content_type,
    parameters: parseJson(row.parameters_json, {}),
    error_message: row.error_message,
    created_by: row.created_by,
    started_at: row.started_at,
    finished_at: row.finished_at,
    created_at: row.created_at,
  };
}

export function publicSchedule(row) {
  if (!row) return null;
  return {
    id: row.id,
    schedule_ref: row.schedule_ref,
    tenant_id: row.tenant_id,
    name: row.name,
    target_type: row.target_type,
    report_id: row.report_id,
    dashboard_id: row.dashboard_id,
    kpi_id: row.kpi_id,
    frequency: row.frequency,
    cron: row.cron,
    timezone: row.timezone,
    format: row.format,
    recipients: parseJson(row.recipients_json, []),
    parameters: parseJson(row.parameters_json, {}),
    distribution: parseJson(row.distribution_json, {}),
    status: row.status,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    last_execution_id: row.last_execution_id,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicBiConnection(row) {
  if (!row) return null;
  return {
    id: row.id,
    bi_ref: row.bi_ref,
    tenant_id: row.tenant_id,
    provider: row.provider,
    name: row.name,
    description: row.description,
    config: parseJson(row.config_json, {}),
    status: row.status,
    last_sync_at: row.last_sync_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicBiDataset(row) {
  if (!row) return null;
  return {
    id: row.id,
    dataset_ref: row.dataset_ref,
    connection_id: row.connection_id,
    tenant_id: row.tenant_id,
    name: row.name,
    entity: row.entity,
    definition: parseJson(row.definition_json, {}),
    status: row.status,
    last_published_at: row.last_published_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicBiPublishJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    publish_ref: row.publish_ref,
    dataset_id: row.dataset_id,
    connection_id: row.connection_id,
    tenant_id: row.tenant_id,
    operation: row.operation,
    status: row.status,
    platform_job_id: row.platform_job_id,
    message: row.message,
    created_at: row.created_at,
    finished_at: row.finished_at,
  };
}

export function publicConfigRow(row) {
  if (!row) return null;
  return { key: row.key, value: parseJson(row.value_json, null), updated_at: row.updated_at, updated_by: row.updated_by };
}

export function readModelRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    entity: row.entity,
    object_type: row.object_type,
    object_id: row.object_id,
    organization_id: row.organization_id,
    classification: row.classification,
    attributes: parseJson(row.attributes_json, {}),
    source_updated_at: row.source_updated_at,
    refreshed_at: row.refreshed_at,
  };
}
