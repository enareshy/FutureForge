// Centralized metric engine (§10).
//
// A metric is a reusable, centrally defined calculation (entity + aggregation +
// filters + optional formula). Reports, dashboards, KPIs and BI integrations
// reference metrics instead of hard-coding calculations in a component. KPI
// formulas therefore never live in the frontend.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { AGGREGATIONS, METRIC_UNITS, IMMUTABLE_STATUSES } from "./constants.js";
import { metricNotFound, metricConflict, invalidMetric } from "./errors.js";
import { metricRef as makeMetricRef } from "./identifiers.js";
import { publicMetric, parseJson, stringifyJson, paged } from "./repository.js";
import { getEntity, requireAttribute, entityAttributeMap } from "./semantic.js";
import { executeQuery } from "./query-engine.js";
import { publishReportingEvent } from "./events.js";

const STATUSES = ["DRAFT", "ACTIVE", "DEPRECATED", "ARCHIVED"];

function validateMetric(db, tenantId, input = {}) {
  if (!input.code || !String(input.code).trim()) throw invalidMetric("Metric code is required");
  if (!input.name || !String(input.name).trim()) throw invalidMetric("Metric name is required");
  const entity = getEntity(input.entity);
  const aggregation = String(input.aggregation || "COUNT").toUpperCase();
  if (!AGGREGATIONS.includes(aggregation)) throw invalidMetric(`Unsupported aggregation: ${aggregation}`);
  if (input.attribute) requireAttribute(entity.code, input.attribute);
  for (const filter of input.filters || []) {
    if (!entityAttributeMap(entity.code).has(String(filter.attribute))) throw invalidMetric(`Unknown filter attribute: ${filter.attribute}`);
  }
  if (input.unit && !METRIC_UNITS.includes(String(input.unit).toUpperCase())) throw invalidMetric(`Unsupported metric unit: ${input.unit}`);
  return {
    code: String(input.code).trim().toUpperCase(),
    name: String(input.name).trim(),
    description: input.description ? String(input.description) : "",
    entity: entity.code,
    aggregation,
    attribute: input.attribute ? String(input.attribute) : "",
    filters: input.filters || [],
    formula: input.formula ? String(input.formula) : "",
    unit: input.unit ? String(input.unit).toUpperCase() : "NUMBER",
    metadata: input.metadata || {},
    organization_id: input.organization_id ?? input.organizationId ?? null,
  };
}

export function createMetric(db, tenantId, input = {}, actor = null, ip = null) {
  const normalized = validateMetric(db, tenantId, input);
  if (queryOne(db, "SELECT id FROM reporting_metrics WHERE tenant_id = ? AND code = ?", [Number(tenantId), normalized.code])) {
    throw metricConflict(normalized.code);
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reporting_metrics (metric_ref, tenant_id, organization_id, code, name, description, entity, aggregation, attribute, filters_json, formula, unit, version, status, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'DRAFT', ?, ?, ?, ?, ?)`,
    [
      makeMetricRef(normalized.code),
      Number(tenantId),
      normalized.organization_id ?? null,
      normalized.code,
      normalized.name,
      normalized.description,
      normalized.entity,
      normalized.aggregation,
      normalized.attribute,
      stringifyJson(normalized.filters, "[]"),
      normalized.formula,
      normalized.unit,
      stringifyJson(normalized.metadata, "{}"),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  writeAudit(db, { actor, action: "reporting.metric.create", resourceType: "reporting_metric", resourceId: normalized.code, details: { entity: normalized.entity }, sourceModule: "reporting", ip });
  publishReportingEvent(db, { eventType: "MetricUpdated", payload: { code: normalized.code, action: "created" }, objectType: "reporting_metric", tenantId, organizationId: normalized.organization_id }, actor);
  return getMetricById(db, Number(tenantId), Number(result.lastInsertRowid));
}

export function getMetricById(db, tenantId, id) {
  return publicMetric(queryOne(db, "SELECT * FROM reporting_metrics WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)]));
}

export function getMetric(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM reporting_metrics WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM reporting_metrics WHERE tenant_id = ? AND (code = ? OR metric_ref = ?)", [Number(tenantId), raw.toUpperCase(), raw]);
  if (!row) throw metricNotFound(ref);
  return publicMetric(row);
}

export function listMetrics(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.entity) {
    where.push("entity = ?");
    params.push(String(query.entity));
  }
  return paged(db, "reporting_metrics", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicMetric });
}

export function updateMetric(db, tenantId, ref, input = {}, actor = null) {
  const existing = getMetric(db, tenantId, ref);
  if (IMMUTABLE_STATUSES.includes(existing.status)) throw invalidMetric(`Metric ${existing.code} is ${existing.status} and cannot be edited; create a new version`);
  const normalized = validateMetric(db, tenantId, { ...existing, ...input, code: existing.code });
  run(
    db,
    `UPDATE reporting_metrics SET name = ?, description = ?, entity = ?, aggregation = ?, attribute = ?, filters_json = ?, formula = ?, unit = ?, metadata_json = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?`,
    [
      normalized.name,
      normalized.description,
      normalized.entity,
      normalized.aggregation,
      normalized.attribute,
      stringifyJson(normalized.filters, "[]"),
      normalized.formula,
      normalized.unit,
      stringifyJson(normalized.metadata, "{}"),
      actor?.id ?? null,
      nowIso(),
      existing.id,
      Number(tenantId),
    ]
  );
  writeAudit(db, { actor, action: "reporting.metric.update", resourceType: "reporting_metric", resourceId: existing.code, details: { entity: normalized.entity }, sourceModule: "reporting" });
  publishReportingEvent(db, { eventType: "MetricUpdated", payload: { code: existing.code, action: "updated" }, objectType: "reporting_metric", tenantId }, actor);
  return getMetricById(db, Number(tenantId), existing.id);
}

export function setMetricStatus(db, tenantId, ref, status, actor = null) {
  const existing = getMetric(db, tenantId, ref);
  const next = String(status || "").toUpperCase();
  if (!STATUSES.includes(next)) throw invalidMetric(`Unsupported metric status: ${status}`);
  run(db, "UPDATE reporting_metrics SET status = ?, updated_by = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [next, actor?.id ?? null, nowIso(), existing.id, Number(tenantId)]);
  writeAudit(db, { actor, action: "reporting.metric.status", resourceType: "reporting_metric", resourceId: existing.code, details: { status: next }, sourceModule: "reporting" });
  return getMetricById(db, Number(tenantId), existing.id);
}

export function deleteMetric(db, tenantId, ref) {
  const existing = getMetric(db, tenantId, ref);
  run(db, "DELETE FROM reporting_metric_versions WHERE metric_id = ?", [existing.id]);
  run(db, "DELETE FROM reporting_metrics WHERE id = ? AND tenant_id = ?", [existing.id, Number(tenantId)]);
  return { deleted: true, code: existing.code };
}

// Computes a metric for the current security context. Missing authorization
// yields zero rows, so the aggregate can never leak a count of restricted data.
export function computeMetric(db, tenantId, metric, context = {}) {
  const definition = typeof metric === "string" ? getMetric(db, tenantId, metric) : metric;
  const extra = definition.metadata?.aggregations || null;
  const aggregations =
    Array.isArray(extra) && extra.length
      ? extra
      : [{ function: definition.aggregation, attribute: definition.attribute || null, alias: "value", filters: definition.filters || [] }];
  const calculated_fields = definition.formula ? [{ alias: "value", expression: definition.formula }] : [];
  const spec = { entity: definition.entity, data_source: context.data_source || "OBJECT_MODEL", aggregations, calculated_fields, filters: [] };
  const result = executeQuery(db, tenantId, spec, {
    ...context,
    maxRows: context.maxRows,
    maxGroupRows: 1,
  });
  const row = result.rows[0] || {};
  const value = row.value ?? Object.values(row).find((entry) => typeof entry === "number") ?? null;
  return {
    metric: definition.code,
    entity: definition.entity,
    value,
    row,
    denied: result.denied,
    scanned: result.scanned,
    took_ms: result.took_ms,
  };
}

export function listMetricVersions(db, tenantId, ref) {
  const metric = getMetric(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM reporting_metric_versions WHERE metric_id = ? ORDER BY version DESC", [metric.id]);
  return { items: rows.map((row) => ({ version: row.version, status: row.status, change_summary: row.change_summary, snapshot: parseJson(row.snapshot_json, {}), created_at: row.created_at })), total: rows.length };
}
