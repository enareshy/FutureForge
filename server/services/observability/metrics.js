// Metric definitions and the observation store.
//
// A MetricDefinition is operational configuration: what to measure, from which
// provider, how to aggregate, in what direction "worse" is, and the default
// thresholds. Observations are the high-write measurement stream; they are kept
// in a separate table so the store can move to a time-series backend later
// without touching the definition model.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import {
  CALCULATIONS,
  AGGREGATIONS,
  METRIC_UNITS,
  METRIC_DIRECTIONS,
  METRIC_STATUSES,
  SIGNAL_CATEGORIES,
  DEFAULT_COLLECTION_INTERVAL_SECONDS,
} from "./constants.js";
import { metricRef } from "./identifiers.js";
import { parseJson, stringifyJson, paged, tableExists, toNumber } from "./repository.js";
import { getProvider } from "./providers.js";
import { metricNotFound, metricConflict, invalidMetric, invalidParameters } from "./errors.js";
import { recordHistory } from "./history.js";
import { observabilityEventCode, publishObservabilityEvent } from "./events.js";

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
    category: row.category,
    provider_code: row.provider_code,
    entity_code: row.entity_code,
    calculation: row.calculation,
    attribute: row.attribute,
    unit: row.unit,
    direction: row.direction,
    frequency_seconds: row.frequency_seconds,
    aggregation: row.aggregation,
    warning_threshold: row.warning_threshold,
    critical_threshold: row.critical_threshold,
    owner_user_id: row.owner_user_id,
    version: row.version,
    status: row.status,
    metadata: parseJson(row.metadata_json, {}),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getMetricRow(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) {
    return queryOne(db, "SELECT * FROM observability_metric_definitions WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
  }
  return queryOne(db, "SELECT * FROM observability_metric_definitions WHERE tenant_id = ? AND (metric_ref = ? OR code = ?)", [Number(tenantId), raw, raw]);
}

export function getMetric(db, tenantId, ref) {
  const row = getMetricRow(db, tenantId, ref);
  if (!row) throw metricNotFound(ref);
  return publicMetric(row);
}

function validate(def) {
  if (!def.code || !String(def.code).trim()) throw invalidMetric("Metric code is required");
  if (!def.name || !String(def.name).trim()) throw invalidMetric("Metric name is required");
  if (def.provider_code && !getProvider(def.provider_code)) throw invalidMetric(`Unknown provider: ${def.provider_code}`);
  if (def.calculation && !CALCULATIONS.includes(String(def.calculation).toUpperCase())) throw invalidMetric(`Unsupported calculation: ${def.calculation}`);
  if (def.aggregation && !AGGREGATIONS.includes(String(def.aggregation).toUpperCase())) throw invalidMetric(`Unsupported aggregation: ${def.aggregation}`);
  if (def.unit && !METRIC_UNITS.includes(String(def.unit).toUpperCase())) throw invalidMetric(`Unsupported unit: ${def.unit}`);
  if (def.direction && !METRIC_DIRECTIONS.includes(String(def.direction).toUpperCase())) throw invalidMetric(`Unsupported direction: ${def.direction}`);
  if (def.category && !SIGNAL_CATEGORIES.includes(String(def.category).toUpperCase())) throw invalidMetric(`Unsupported category: ${def.category}`);
}

function snapshotVersion(db, row, actor) {
  run(
    db,
    "INSERT INTO observability_metric_versions (metric_id, tenant_id, version, snapshot_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [row.id, row.tenant_id, row.version, stringifyJson(publicMetric(row)), actor?.id ?? null, nowIso()]
  );
}

export function createMetric(db, tenantId, input = {}, actor = null) {
  const code = String(input.code || "").trim().toUpperCase();
  validate({ ...input, code });
  if (queryOne(db, "SELECT id FROM observability_metric_definitions WHERE tenant_id = ? AND code = ?", [Number(tenantId), code])) {
    throw metricConflict(code);
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO observability_metric_definitions
      (metric_ref, tenant_id, organization_id, code, name, description, category, provider_code, entity_code, calculation, attribute, unit, direction, frequency_seconds, aggregation, warning_threshold, critical_threshold, owner_user_id, version, status, metadata_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      input.metric_ref || metricRef(code),
      Number(tenantId),
      input.organization_id ?? null,
      code,
      String(input.name).trim(),
      String(input.description || ""),
      String(input.category || "PLATFORM").toUpperCase(),
      String(input.provider_code || "OBJECT_MODEL").toUpperCase(),
      input.entity_code ?? null,
      String(input.calculation || "COUNT").toUpperCase(),
      input.attribute ?? null,
      String(input.unit || "COUNT").toUpperCase(),
      String(input.direction || "HIGHER_IS_WORSE").toUpperCase(),
      Math.max(30, Number(input.frequency_seconds) || DEFAULT_COLLECTION_INTERVAL_SECONDS),
      String(input.aggregation || "AVG").toUpperCase(),
      toNumber(input.warning_threshold),
      toNumber(input.critical_threshold),
      input.owner_user_id ?? actor?.id ?? null,
      String(input.status || "ACTIVE").toUpperCase(),
      stringifyJson(input.metadata || {}),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM observability_metric_definitions WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordHistory(db, { tenantId, action: "METRIC_CREATED", entityType: "metric", entityId: row.id, entityRef: row.metric_ref, actor, summary: `Metric ${code} created`, detail: { code } });
  writeAudit(db, { actor_id: actor?.id ?? null, actor_username: actor?.username ?? null, action: "observability.metric.create", resource_type: "observability_metric", resource_id: row.metric_ref, details: { code } });
  publishObservabilityEvent(db, { eventType: observabilityEventCode("METRIC_OBSERVED"), payload: { metric_ref: row.metric_ref, code, action: "created" }, objectType: "observability_metric", objectId: row.id, tenantId }, actor);
  return publicMetric(row);
}

export function updateMetric(db, tenantId, ref, input = {}, actor = null) {
  const row = getMetricRow(db, tenantId, ref);
  if (!row) throw metricNotFound(ref);
  validate({
    code: input.code ?? row.code,
    name: input.name ?? row.name,
    provider_code: input.provider_code ?? row.provider_code,
    calculation: input.calculation ?? row.calculation,
    aggregation: input.aggregation ?? row.aggregation,
    unit: input.unit ?? row.unit,
    direction: input.direction ?? row.direction,
    category: input.category ?? row.category,
  });
  snapshotVersion(db, row, actor);
  const ts = nowIso();
  const next = {
    name: input.name ?? row.name,
    description: input.description ?? row.description,
    category: (input.category ?? row.category).toUpperCase(),
    provider_code: (input.provider_code ?? row.provider_code).toUpperCase(),
    entity_code: input.entity_code ?? row.entity_code,
    calculation: (input.calculation ?? row.calculation).toUpperCase(),
    attribute: input.attribute ?? row.attribute,
    unit: (input.unit ?? row.unit).toUpperCase(),
    direction: (input.direction ?? row.direction).toUpperCase(),
    frequency_seconds: Math.max(30, Number(input.frequency_seconds ?? row.frequency_seconds) || DEFAULT_COLLECTION_INTERVAL_SECONDS),
    aggregation: (input.aggregation ?? row.aggregation).toUpperCase(),
    warning_threshold: input.warning_threshold !== undefined ? toNumber(input.warning_threshold) : row.warning_threshold,
    critical_threshold: input.critical_threshold !== undefined ? toNumber(input.critical_threshold) : row.critical_threshold,
    status: (input.status ?? row.status).toUpperCase(),
    metadata: input.metadata !== undefined ? input.metadata : parseJson(row.metadata_json, {}),
  };
  if (!METRIC_STATUSES.includes(next.status)) throw invalidMetric(`Unsupported status: ${next.status}`);
  run(
    db,
    `UPDATE observability_metric_definitions SET name = ?, description = ?, category = ?, provider_code = ?, entity_code = ?, calculation = ?, attribute = ?, unit = ?, direction = ?, frequency_seconds = ?, aggregation = ?, warning_threshold = ?, critical_threshold = ?, status = ?, metadata_json = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    [
      next.name,
      next.description,
      next.category,
      next.provider_code,
      next.entity_code,
      next.calculation,
      next.attribute,
      next.unit,
      next.direction,
      next.frequency_seconds,
      next.aggregation,
      next.warning_threshold,
      next.critical_threshold,
      next.status,
      stringifyJson(next.metadata),
      ts,
      row.id,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM observability_metric_definitions WHERE id = ?", [row.id]);
  recordHistory(db, { tenantId, action: "METRIC_UPDATED", entityType: "metric", entityId: row.id, entityRef: row.metric_ref, actor, summary: `Metric ${row.code} updated`, detail: { version: updated.version } });
  writeAudit(db, { actor_id: actor?.id ?? null, actor_username: actor?.username ?? null, action: "observability.metric.update", resource_type: "observability_metric", resource_id: row.metric_ref, details: { code: row.code } });
  return publicMetric(updated);
}

export function setMetricStatus(db, tenantId, ref, status, actor = null) {
  const next = String(status || "").toUpperCase();
  if (!METRIC_STATUSES.includes(next)) throw invalidMetric(`Unsupported status: ${status}`);
  return updateMetric(db, tenantId, ref, { status: next }, actor);
}

export function deleteMetric(db, tenantId, ref, actor = null) {
  const row = getMetricRow(db, tenantId, ref);
  if (!row) throw metricNotFound(ref);
  run(db, "UPDATE observability_metric_definitions SET status = 'ARCHIVED', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  recordHistory(db, { tenantId, action: "METRIC_ARCHIVED", entityType: "metric", entityId: row.id, entityRef: row.metric_ref, actor, summary: `Metric ${row.code} archived` });
  return { archived: true, metric_ref: row.metric_ref };
}

export function listMetrics(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.category) {
    where.push("category = ?");
    params.push(String(query.category).toUpperCase());
  }
  if (query.provider_code || query.providerCode) {
    where.push("provider_code = ?");
    params.push(String(query.provider_code || query.providerCode).toUpperCase());
  }
  if (query.search) {
    where.push("(code LIKE ? OR name LIKE ?)");
    params.push(`%${query.search}%`, `%${query.search}%`);
  }
  return paged(db, "observability_metric_definitions", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicMetric });
}

export function listMetricVersions(db, tenantId, ref) {
  const row = getMetricRow(db, tenantId, ref);
  if (!row) throw metricNotFound(ref);
  return queryAll(db, "SELECT * FROM observability_metric_versions WHERE metric_id = ? ORDER BY version DESC", [row.id]).map((version) => ({
    id: version.id,
    metric_id: version.metric_id,
    version: version.version,
    snapshot: parseJson(version.snapshot_json, {}),
    created_by: version.created_by,
    created_at: version.created_at,
  }));
}

// ── Observations ────────────────────────────────────────────────────────────
export function publicObservation(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    metric_id: row.metric_id,
    metric_code: row.metric_code,
    value: row.value,
    unit: row.unit,
    dimensions: parseJson(row.dimension_json, {}),
    dimension_hash: row.dimension_hash || "",
    provider_code: row.provider_code,
    run_id: row.run_id,
    observed_at: row.observed_at,
    created_at: row.created_at,
  };
}

export function recordObservation(db, tenantId, metric, { value, dimensions = {}, dimensionHash = "", providerCode = null, runId = null, observedAt = null } = {}) {
  const ts = observedAt || nowIso();
  const result = run(
    db,
    `INSERT INTO observability_metric_observations (tenant_id, metric_id, metric_code, value, unit, dimension_json, dimension_hash, provider_code, run_id, observed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(tenantId),
      metric.id ?? null,
      metric.code,
      Number(value),
      metric.unit || "",
      stringifyJson(dimensions),
      String(dimensionHash || ""),
      String(providerCode || metric.provider_code || ""),
      runId ?? null,
      ts,
      nowIso(),
    ]
  );
  return Number(result.lastInsertRowid);
}

export function listObservations(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.metric_code || query.metricCode) {
    where.push("metric_code = ?");
    params.push(String(query.metric_code || query.metricCode));
  }
  if (query.metric_id || query.metricId) {
    where.push("metric_id = ?");
    params.push(Number(query.metric_id || query.metricId));
  }
  if (query.from) {
    where.push("observed_at >= ?");
    params.push(String(query.from));
  }
  if (query.to) {
    where.push("observed_at <= ?");
    params.push(String(query.to));
  }
  return paged(db, "observability_metric_observations", { where, params, orderBy: "observed_at DESC, id DESC", page: query.page, pageSize: query.page_size || query.pageSize, map: publicObservation });
}

// Latest observation per metric code for a tenant.
export function latestObservations(db, tenantId, codes = null) {
  if (!tableExists(db, "observability_metric_observations")) return [];
  const params = [Number(tenantId)];
  let codeClause = "";
  if (Array.isArray(codes) && codes.length) {
    codeClause = `AND metric_code IN (${codes.map(() => "?").join(", ")})`;
    params.push(...codes);
  }
  const rows = queryAll(
    db,
    `SELECT o.* FROM observability_metric_observations o
     JOIN (SELECT metric_code, MAX(observed_at) AS mx FROM observability_metric_observations WHERE tenant_id = ? ${codeClause} GROUP BY metric_code) latest
       ON latest.metric_code = o.metric_code AND latest.mx = o.observed_at
     WHERE o.tenant_id = ? ORDER BY o.metric_code`,
    [...params, Number(tenantId)]
  );
  return rows.map(publicObservation);
}

export function latestObservationFor(db, tenantId, metricCode) {
  const row = queryOne(db, "SELECT * FROM observability_metric_observations WHERE tenant_id = ? AND metric_code = ? ORDER BY observed_at DESC, id DESC LIMIT 1", [Number(tenantId), String(metricCode)]);
  return publicObservation(row);
}

// Time series for a metric, optionally bucketed for trend charts.
export function metricHistory(db, tenantId, ref, query = {}) {
  const metric = getMetricRow(db, tenantId, ref);
  if (!metric) throw metricNotFound(ref);
  const limit = Math.min(2000, Math.max(1, Number(query.limit) || 200));
  const windowSeconds = Math.max(300, Math.min(7776000, Number(query.window_seconds || query.windowSeconds) || 604800));
  const rows = queryAll(
    db,
    `SELECT * FROM observability_metric_observations
     WHERE tenant_id = ? AND metric_code = ? AND observed_at >= datetime('now', ?)
     ORDER BY observed_at ASC LIMIT ?`,
    [Number(tenantId), metric.code, `-${windowSeconds} seconds`, limit]
  );
  const points = rows.map((row) => ({ observed_at: row.observed_at, value: row.value, dimensions: parseJson(row.dimension_json, {}) }));
  const values = points.map((point) => Number(point.value));
  const summary = {
    count: values.length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    avg: values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(4)) : null,
    last: values.length ? values[values.length - 1] : null,
    first: values.length ? values[0] : null,
  };
  return { metric: publicMetric(metric), window_seconds: windowSeconds, summary, points };
}

export function countMetrics(db, tenantId) {
  return Number(queryOne(db, "SELECT COUNT(*) AS c FROM observability_metric_definitions WHERE tenant_id = ?", [Number(tenantId)])?.c || 0);
}

export function pruneObservations(db, tenantId, retainDays) {
  const days = Math.max(1, Number(retainDays) || 30);
  const result = run(db, "DELETE FROM observability_metric_observations WHERE tenant_id = ? AND observed_at < datetime('now', ?)", [Number(tenantId), `-${days} days`]);
  return Number(result.changes || 0);
}

export { invalidParameters };
