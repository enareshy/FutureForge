// Reusable KPI service (§11).
//
// A KPI is a centrally defined, target-bearing metric that reports, dashboards,
// alerts, APIs and BI integrations share. Values are computed through the
// metric/query engine with centralized security and cached per security scope.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { AGGREGATIONS, KPI_DIRECTIONS, METRIC_UNITS, IMMUTABLE_STATUSES } from "./constants.js";
import { kpiNotFound, kpiConflict, invalidKpi } from "./errors.js";
import { kpiRef as makeKpiRef } from "./identifiers.js";
import { publicKpi, parseJson, stringifyJson, paged } from "./repository.js";
import { getEntity, requireAttribute, entityAttributeMap } from "./semantic.js";
import { executeQuery } from "./query-engine.js";
import { computeMetric, getMetric } from "./metrics.js";
import { buildCacheKey, getCached, setCached, securityFingerprint } from "./cache.js";
import { getNumericConfig } from "./configuration.js";
import { publishReportingEvent } from "./events.js";

const STATUSES = ["DRAFT", "ACTIVE", "DEPRECATED", "ARCHIVED"];

function validateKpi(db, tenantId, input = {}) {
  if (!input.code || !String(input.code).trim()) throw invalidKpi("KPI code is required");
  if (!input.name || !String(input.name).trim()) throw invalidKpi("KPI name is required");
  const entity = getEntity(input.entity);
  const aggregation = String(input.aggregation || "COUNT").toUpperCase();
  if (!AGGREGATIONS.includes(aggregation)) throw invalidKpi(`Unsupported aggregation: ${aggregation}`);
  if (input.attribute) requireAttribute(entity.code, input.attribute);
  for (const filter of input.filters || []) {
    if (!entityAttributeMap(entity.code).has(String(filter.attribute))) throw invalidKpi(`Unknown filter attribute: ${filter.attribute}`);
  }
  const direction = String(input.direction || "HIGHER_IS_BETTER").toUpperCase();
  if (!KPI_DIRECTIONS.includes(direction)) throw invalidKpi(`Unsupported KPI direction: ${direction}`);
  if (input.unit && !METRIC_UNITS.includes(String(input.unit).toUpperCase())) throw invalidKpi(`Unsupported KPI unit: ${input.unit}`);
  if (input.metric_code) getMetric(db, tenantId, input.metric_code);
  return {
    code: String(input.code).trim().toUpperCase(),
    name: String(input.name).trim(),
    description: input.description ? String(input.description) : "",
    metric_code: input.metric_code ? String(input.metric_code).toUpperCase() : "",
    entity: entity.code,
    aggregation,
    attribute: input.attribute ? String(input.attribute) : "",
    filters: input.filters || [],
    formula: input.formula ? String(input.formula) : "",
    target: input.target === undefined || input.target === null || input.target === "" ? null : Number(input.target),
    thresholds: input.thresholds || {},
    direction,
    unit: input.unit ? String(input.unit).toUpperCase() : "NUMBER",
    frequency: input.frequency ? String(input.frequency).toUpperCase() : "DAILY",
    security_scope: input.security_scope || {},
    metadata: input.metadata || {},
    organization_id: input.organization_id ?? input.organizationId ?? null,
  };
}

export function createKpi(db, tenantId, input = {}, actor = null, ip = null) {
  const normalized = validateKpi(db, tenantId, input);
  if (queryOne(db, "SELECT id FROM reporting_kpis WHERE tenant_id = ? AND code = ?", [Number(tenantId), normalized.code])) {
    throw kpiConflict(normalized.code);
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reporting_kpis (kpi_ref, tenant_id, organization_id, code, name, description, metric_code, entity, aggregation, attribute, filters_json, formula, target, thresholds_json, direction, unit, frequency, owner_user_id, security_scope_json, version, status, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'DRAFT', ?, ?, ?, ?, ?)`,
    [
      makeKpiRef(normalized.code),
      Number(tenantId),
      normalized.organization_id ?? null,
      normalized.code,
      normalized.name,
      normalized.description,
      normalized.metric_code,
      normalized.entity,
      normalized.aggregation,
      normalized.attribute,
      stringifyJson(normalized.filters, "[]"),
      normalized.formula,
      normalized.target,
      stringifyJson(normalized.thresholds, "{}"),
      normalized.direction,
      normalized.unit,
      normalized.frequency,
      input.owner_user_id ?? input.ownerUserId ?? actor?.id ?? null,
      stringifyJson(normalized.security_scope, "{}"),
      stringifyJson(normalized.metadata, "{}"),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  writeAudit(db, { actor, action: "reporting.kpi.create", resourceType: "reporting_kpi", resourceId: normalized.code, details: { entity: normalized.entity }, sourceModule: "reporting", ip });
  publishReportingEvent(db, { eventType: "KpiUpdated", payload: { code: normalized.code, action: "created" }, objectType: "reporting_kpi", tenantId }, actor);
  return getKpiById(db, Number(tenantId), Number(result.lastInsertRowid));
}

export function getKpiById(db, tenantId, id) {
  return publicKpi(queryOne(db, "SELECT * FROM reporting_kpis WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)]));
}

export function getKpi(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM reporting_kpis WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM reporting_kpis WHERE tenant_id = ? AND (code = ? OR kpi_ref = ?)", [Number(tenantId), raw.toUpperCase(), raw]);
  if (!row) throw kpiNotFound(ref);
  return publicKpi(row);
}

export function listKpis(db, tenantId, query = {}) {
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
  return paged(db, "reporting_kpis", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicKpi });
}

export function updateKpi(db, tenantId, ref, input = {}, actor = null) {
  const existing = getKpi(db, tenantId, ref);
  if (IMMUTABLE_STATUSES.includes(existing.status)) throw invalidKpi(`KPI ${existing.code} is ${existing.status} and cannot be edited; create a new version`);
  const normalized = validateKpi(db, tenantId, { ...existing, ...input, code: existing.code });
  run(
    db,
    `UPDATE reporting_kpis SET name = ?, description = ?, metric_code = ?, entity = ?, aggregation = ?, attribute = ?, filters_json = ?, formula = ?, target = ?, thresholds_json = ?, direction = ?, unit = ?, frequency = ?, security_scope_json = ?, metadata_json = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?`,
    [
      normalized.name,
      normalized.description,
      normalized.metric_code,
      normalized.entity,
      normalized.aggregation,
      normalized.attribute,
      stringifyJson(normalized.filters, "[]"),
      normalized.formula,
      normalized.target,
      stringifyJson(normalized.thresholds, "{}"),
      normalized.direction,
      normalized.unit,
      normalized.frequency,
      stringifyJson(normalized.security_scope, "{}"),
      stringifyJson(normalized.metadata, "{}"),
      actor?.id ?? null,
      nowIso(),
      existing.id,
      Number(tenantId),
    ]
  );
  writeAudit(db, { actor, action: "reporting.kpi.update", resourceType: "reporting_kpi", resourceId: existing.code, sourceModule: "reporting" });
  publishReportingEvent(db, { eventType: "KpiUpdated", payload: { code: existing.code, action: "updated" }, objectType: "reporting_kpi", tenantId }, actor);
  return getKpiById(db, Number(tenantId), existing.id);
}

export function setKpiStatus(db, tenantId, ref, status, actor = null) {
  const existing = getKpi(db, tenantId, ref);
  const next = String(status || "").toUpperCase();
  if (!STATUSES.includes(next)) throw invalidKpi(`Unsupported KPI status: ${status}`);
  run(db, "UPDATE reporting_kpis SET status = ?, updated_by = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [next, actor?.id ?? null, nowIso(), existing.id, Number(tenantId)]);
  writeAudit(db, { actor, action: "reporting.kpi.status", resourceType: "reporting_kpi", resourceId: existing.code, details: { status: next }, sourceModule: "reporting" });
  return getKpiById(db, Number(tenantId), existing.id);
}

export function deleteKpi(db, tenantId, ref) {
  const existing = getKpi(db, tenantId, ref);
  run(db, "DELETE FROM reporting_kpi_versions WHERE kpi_id = ?", [existing.id]);
  run(db, "DELETE FROM reporting_kpi_targets WHERE kpi_id = ?", [existing.id]);
  run(db, "DELETE FROM reporting_kpis WHERE id = ? AND tenant_id = ?", [existing.id, Number(tenantId)]);
  return { deleted: true, code: existing.code };
}

// Evaluates a KPI value against its target and thresholds.
export function evaluateKpi(kpi, value) {
  if (value === null || value === undefined) {
    return { value: null, status: "NO_DATA", tone: "warn", target: kpi.target, delta: null };
  }
  const target = kpi.target === null || kpi.target === undefined ? null : Number(kpi.target);
  const thresholds = kpi.thresholds || {};
  const higher = kpi.direction !== "LOWER_IS_BETTER";
  let status = "OK";
  if (target !== null && Number.isFinite(target)) {
    if (higher) {
      if (value >= target) status = "OK";
      else if (thresholds.warning !== undefined && value >= Number(thresholds.warning)) status = "WARNING";
      else status = "CRITICAL";
    } else {
      if (value <= target) status = "OK";
      else if (thresholds.warning !== undefined && value <= Number(thresholds.warning)) status = "WARNING";
      else status = "CRITICAL";
    }
  }
  const tone = status === "OK" ? "ok" : status === "WARNING" ? "warn" : "danger";
  return { value, status, tone, target, thresholds, direction: kpi.direction, delta: target === null ? null : Number((value - target).toFixed(6)) };
}

export function computeKpi(db, tenantId, kpi, context = {}) {
  const definition = typeof kpi === "string" ? getKpi(db, tenantId, kpi) : kpi;
  let value;
  let raw;
  if (definition.metric_code) {
    const metric = computeMetric(db, tenantId, definition.metric_code, context);
    value = metric.value;
    raw = metric;
  } else {
    raw = computeMetric(db, tenantId, { ...definition, code: definition.code, aggregation: definition.aggregation, entity: definition.entity, attribute: definition.attribute, filters: definition.filters, formula: definition.formula, metadata: definition.metadata }, context);
    value = raw.value;
  }
  return { ...evaluateKpi(definition, value), kpi: definition.code, metric: definition.metric_code || null, took_ms: raw.took_ms, denied: raw.denied, scanned: raw.scanned };
}

// Cached KPI value for dashboards. The cache key embeds the security scope.
export function getKpiValue(db, tenantId, ref, context = {}) {
  const kpi = getKpi(db, tenantId, ref);
  const useCache = context.enableCache !== false;
  const securityHash = securityFingerprint({ tenantId, organizationId: context.organizationId, userId: context.actor?.id, roles: context.roles || [] });
  const cacheKey = buildCacheKey("kpi", [kpi.code, kpi.version, securityHash, context.parameters || {}]);
  if (useCache) {
    const cached = getCached(db, cacheKey);
    if (cached) return { ...cached, cache_hit: true };
  }
  const value = computeKpi(db, tenantId, kpi, context);
  const ttl = context.cacheTtlSeconds ?? getNumericConfig(db, tenantId, "cache_ttl_seconds");
  if (useCache) setCached(db, { tenantId, scope: "kpi", cacheKey, payload: value, ttlSeconds: ttl, securityHash });
  return { ...value, cache_hit: false };
}

export function listKpiVersions(db, tenantId, ref) {
  const kpi = getKpi(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM reporting_kpi_versions WHERE kpi_id = ? ORDER BY version DESC", [kpi.id]);
  return { items: rows.map((row) => ({ version: row.version, status: row.status, change_summary: row.change_summary, snapshot: parseJson(row.snapshot_json, {}), created_at: row.created_at })), total: rows.length };
}
