// The observation engine.
//
// A collection run is the unit of work that turns platform telemetry into
// observations, then drives thresholds, alerting, freshness, health and SLO
// evaluation. Runs are themselves recorded (with per-provider errors) so
// observability is observable. Collection is idempotent at the definition
// level and safe to invoke from a job, a schedule or an API call.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { tenantIds } from "../search/registry.js";
import { SIGNAL_CATEGORIES } from "./constants.js";
import { runRef } from "./identifiers.js";
import { parseJson, stringifyJson, paged, tableExists } from "./repository.js";
import { measureMetric } from "./providers.js";
import { recordObservation, listMetrics, getMetricRow } from "./metrics.js";
import { classifyMetric } from "./thresholds.js";
import { applyAlertRules, refreshSuppressions, alertSummary } from "./alerts.js";
import { evaluateFreshness, freshnessSummary } from "./freshness.js";
import { evaluateHealth, persistHealthSnapshots, currentHealth } from "./health.js";
import { evaluateAllSlos } from "./slo.js";
import { incidentSummary } from "./incidents.js";
import { getConfig, getNumericConfig } from "./configuration.js";
import { recordHistory } from "./history.js";
import { observabilityEventCode, publishObservabilityEvent } from "./events.js";

export function publicRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    run_ref: row.run_ref,
    tenant_id: row.tenant_id,
    trigger_type: row.trigger_type,
    status: row.status,
    metric_count: row.metric_count,
    observation_count: row.observation_count,
    error_count: row.error_count,
    alerts_created: row.alerts_created,
    alerts_resolved: row.alerts_resolved,
    slo_breaches: row.slo_breaches,
    started_at: row.started_at,
    finished_at: row.finished_at,
    detail: parseJson(row.detail_json, {}),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRunError(row) {
  if (!row) return null;
  return {
    id: row.id,
    run_id: row.run_id,
    tenant_id: row.tenant_id,
    provider_code: row.provider_code,
    metric_code: row.metric_code,
    message: row.message,
    detail: parseJson(row.detail_json, {}),
    created_at: row.created_at,
  };
}

function createRun(db, tenantId, { trigger = "MANUAL", actor = null } = {}) {
  const result = run(
    db,
    `INSERT INTO observability_observation_runs (run_ref, tenant_id, trigger_type, status, started_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, 'RUNNING', ?, ?, ?, ?)`,
    [runRef(), Number(tenantId), String(trigger).toUpperCase(), nowIso(), actor?.id ?? null, nowIso(), nowIso()]
  );
  return Number(result.lastInsertRowid);
}

function recordRunError(db, tenantId, runId, { providerCode, metricCode, message, detail = {} }) {
  run(
    db,
    "INSERT INTO observability_observation_errors (run_id, tenant_id, provider_code, metric_code, message, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [runId ?? null, Number(tenantId), providerCode ?? null, metricCode ?? null, String(message || ""), stringifyJson(detail), nowIso()]
  );
}

function finalizeRun(db, runId, patch = {}) {
  run(
    db,
    "UPDATE observability_observation_runs SET status = ?, metric_count = ?, observation_count = ?, error_count = ?, alerts_created = ?, alerts_resolved = ?, slo_breaches = ?, finished_at = ?, detail_json = ?, updated_at = ? WHERE id = ?",
    [
      patch.status || "COMPLETED",
      Number(patch.metric_count || 0),
      Number(patch.observation_count || 0),
      Number(patch.error_count || 0),
      Number(patch.alerts_created || 0),
      Number(patch.alerts_resolved || 0),
      Number(patch.slo_breaches || 0),
      nowIso(),
      stringifyJson(patch.detail || {}),
      nowIso(),
      runId,
    ]
  );
}

// Runs a full collection cycle for one tenant.
export function collectTenant(db, tenantId, { trigger = "MANUAL", actor = null, runId = null } = {}) {
  const scope = Number(tenantId);
  const id = runId || createRun(db, scope, { trigger, actor });
  const counts = { metric_count: 0, observation_count: 0, error_count: 0, alerts_created: 0, alerts_resolved: 0, escalated: 0, incidents_created: 0, slo_breaches: 0 };
  const errors = [];
  let alertEval = { created: 0, resolved: 0, escalated: 0, incidents_created: 0 };
  try {
    const suppressed = refreshSuppressions(db, scope);
    if (suppressed) counts.detail_suppressions_refreshed = suppressed;

    const maxMetrics = getNumericConfig(db, scope, "max_metrics_per_run");
    const metrics = listMetrics(db, scope, { status: "ACTIVE", page_size: maxMetrics }).items;
    for (const metric of metrics) {
      counts.metric_count += 1;
      const measurement = measureMetric(db, scope, metric);
      if (measurement.error) {
        counts.error_count += 1;
        errors.push({ providerCode: metric.provider_code, metricCode: metric.code, message: measurement.error });
        recordRunError(db, scope, id, { providerCode: metric.provider_code, metricCode: metric.code, message: measurement.error });
        continue;
      }
      const observationId = recordObservation(db, scope, metric, { value: measurement.value, providerCode: metric.provider_code, runId: id });
      counts.observation_count += 1;
      const evaluation = applyAlertRules(db, scope, metric, { value: measurement.value, observation_id: observationId, observed_at: nowIso() }, { actor, runId: id });
      alertEval = {
        created: alertEval.created + evaluation.created,
        resolved: alertEval.resolved + evaluation.resolved,
        escalated: alertEval.escalated + evaluation.escalated,
        incidents_created: alertEval.incidents_created + evaluation.incidents_created,
      };
      const band = classifyMetric(db, scope, metric, measurement.value);
      publishObservabilityEvent(
        db,
        { eventType: observabilityEventCode("METRIC_OBSERVED"), payload: { metric_code: metric.code, value: measurement.value, band: band.band, run_id: id }, objectType: "observability_metric", objectId: metric.id, tenantId: scope },
        actor
      );
    }
    const healthEvaluation = evaluateHealth(db, scope, { runId: id });
    persistHealthSnapshots(db, scope, healthEvaluation, { runId: id, actor });
    const slo = evaluateAllSlos(db, scope, { actor });
    counts.slo_breaches = slo.breached;
    counts.alerts_created = alertEval.created;
    counts.alerts_resolved = alertEval.resolved;
    finalizeRun(db, id, {
      status: counts.error_count > 0 ? "PARTIAL" : "COMPLETED",
      ...counts,
      escalated: alertEval.escalated,
      incidents_created: alertEval.incidents_created,
      detail: { errors: errors.length, health: healthEvaluation.overall, slo_breaches: slo.breached },
    });
    recordHistory(db, { tenantId: scope, action: "COLLECTION_RUN", entityType: "run", entityId: id, entityRef: `run:${id}`, actor, summary: `Collection run collected ${counts.observation_count} observations`, detail: counts });
  } catch (err) {
    counts.error_count += 1;
    recordRunError(db, scope, id, { message: err.message, detail: { fatal: true } });
    finalizeRun(db, id, { status: "FAILED", ...counts, detail: { error: err.message } });
  }
  return { run: publicRun(queryOne(db, "SELECT * FROM observability_observation_runs WHERE id = ?", [id])), counts };
}

export function collectAllTenants(db, { trigger = "SCHEDULED", actor = null } = {}) {
  let tenants = [];
  try {
    tenants = tenantIds(db);
  } catch {
    tenants = [];
  }
  const runs = [];
  for (const tenantId of tenants) {
    if (!getConfig(db, tenantId, "enabled")) continue;
    runs.push(collectTenant(db, tenantId, { trigger, actor }));
  }
  return { tenants: tenants.length, runs };
}

export function listRuns(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.trigger_type || query.triggerType) {
    where.push("trigger_type = ?");
    params.push(String(query.trigger_type || query.triggerType).toUpperCase());
  }
  return paged(db, "observability_observation_runs", { where, params, orderBy: "started_at DESC, id DESC", page: query.page, pageSize: query.page_size || query.pageSize, map: publicRun });
}

export function getRun(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const id = Number(raw);
  const row = Number.isInteger(id) && id > 0
    ? queryOne(db, "SELECT * FROM observability_observation_runs WHERE tenant_id = ? AND id = ?", [Number(tenantId), id])
    : queryOne(db, "SELECT * FROM observability_observation_runs WHERE tenant_id = ? AND run_ref = ?", [Number(tenantId), raw]);
  if (!row) return null;
  const errors = queryAll(db, "SELECT * FROM observability_observation_errors WHERE run_id = ? ORDER BY id", [row.id]).map(publicRunError);
  return { ...publicRun(row), errors };
}

export function pruneRuns(db, tenantId, retainDays) {
  const days = Math.max(1, Number(retainDays) || 30);
  const runIds = queryAll(db, "SELECT id FROM observability_observation_runs WHERE tenant_id = ? AND started_at < datetime('now', ?)", [Number(tenantId), `-${days} days`]).map((row) => row.id);
  for (const id of runIds) run(db, "DELETE FROM observability_observation_errors WHERE run_id = ?", [id]);
  const result = run(db, "DELETE FROM observability_observation_runs WHERE tenant_id = ? AND started_at < datetime('now', ?)", [Number(tenantId), `-${days} days`]);
  return Number(result.changes || 0);
}

// ── Read-model summaries (the overview APIs) ────────────────────────────────
// Builds the grouped overview used by /overview and the dashboard page.
export function observabilityOverview(db, tenantId) {
  const metrics = listMetrics(db, tenantId, { status: "ACTIVE", page_size: 500 }).items;
  const groups = {};
  for (const category of SIGNAL_CATEGORIES) groups[category] = [];
  for (const metric of metrics) {
    const latest = tableExists(db, "observability_metric_observations")
      ? queryOne(db, "SELECT value, observed_at, unit FROM observability_metric_observations WHERE tenant_id = ? AND metric_code = ? ORDER BY observed_at DESC, id DESC LIMIT 1", [Number(tenantId), metric.code])
      : null;
    const classified = classifyMetric(db, tenantId, metric, latest?.value ?? null);
    const entry = {
      metric_code: metric.code,
      name: metric.name,
      category: metric.category,
      provider_code: metric.provider_code,
      unit: metric.unit,
      value: latest?.value ?? null,
      observed_at: latest?.observed_at ?? null,
      band: classified.band,
      threshold: classified.threshold ?? null,
    };
    (groups[metric.category] = groups[metric.category] || []).push(entry);
  }
  const health = currentHealth(db, tenantId);
  const alerts = alertSummary(db, tenantId);
  const incidents = incidentSummary(db, tenantId);
  const freshness = freshnessSummary(db, tenantId);
  const slo = evaluateAllSlos(db, tenantId, { notify: false });
  const lastRun = queryOne(db, "SELECT * FROM observability_observation_runs WHERE tenant_id = ? ORDER BY started_at DESC, id DESC LIMIT 1", [Number(tenantId)]);
  const bands = { OK: 0, WARNING: 0, CRITICAL: 0, UNKNOWN: 0 };
  for (const list of Object.values(groups)) for (const entry of list) bands[entry.band] = (bands[entry.band] || 0) + 1;
  return {
    health,
    alert_summary: alerts,
    incident_summary: incidents,
    freshness: { total: freshness.total, buckets: freshness.buckets },
    slo: { total: slo.total, compliant: slo.compliant, at_risk: slo.at_risk, breached: slo.breached, no_data: slo.no_data },
    metric_bands: bands,
    categories: groups,
    last_run: publicRun(lastRun),
    generated_at: nowIso(),
  };
}

export function categorySummary(db, tenantId, categories) {
  const overview = observabilityOverview(db, tenantId);
  const selected = {};
  for (const category of categories) selected[category] = overview.categories[category] || [];
  return { categories: selected, metric_bands: overview.metric_bands, generated_at: overview.generated_at };
}

export function failureSummary(db, tenantId) {
  const overview = observabilityOverview(db, tenantId);
  const codes = ["ERROR_RATE", "JOB", "INTEGRATION", "IMPORT", "EXPORT", "EVENT"];
  const items = [];
  for (const category of codes) for (const entry of overview.categories[category] || []) items.push(entry);
  return { items, open_alerts: overview.alert_summary, open_incidents: overview.incident_summary, generated_at: overview.generated_at };
}

export function throughputSummary(db, tenantId) {
  const overview = observabilityOverview(db, tenantId);
  const codes = ["THROUGHPUT", "LATENCY", "WORKFLOW", "DATA_VOLUME"];
  const items = [];
  for (const category of codes) for (const entry of overview.categories[category] || []) items.push(entry);
  return { items, generated_at: overview.generated_at };
}
