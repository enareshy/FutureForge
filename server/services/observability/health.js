// Health checks, snapshots and the platform health roll-up.
//
// Health is derived, never hand-maintained: it is computed from current alert
// state, freshness bands and threshold bands and persisted as snapshots so
// historical health can be trended. A snapshot is written whenever the computed
// status changes and on every scheduled run.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { HEALTH_STATUSES, HEALTH_RANK, HEALTH_SCOPES, HEALTH_CHECK_TYPES, SEVERITY_RANK, ALERT_OPEN_STATUSES } from "./constants.js";
import { healthCheckRef, healthSnapshotRef } from "./identifiers.js";
import { parseJson, stringifyJson, paged, tableExists } from "./repository.js";
import { probeProvider } from "./providers.js";
import { healthCheckNotFound, invalidHealthCheck } from "./errors.js";
import { recordHistory } from "./history.js";
import { evaluateFreshness } from "./freshness.js";
import { getMetricRow } from "./metrics.js";
import { classifyMetric } from "./thresholds.js";
import { observabilityEventCode, publishObservabilityEvent } from "./events.js";

export function publicHealthCheck(row) {
  if (!row) return null;
  return {
    id: row.id,
    check_ref: row.check_ref,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description,
    scope: row.scope,
    service_code: row.service_code,
    provider_code: row.provider_code,
    metric_code: row.metric_code,
    check_type: row.check_type,
    config: parseJson(row.config_json, {}),
    severity: row.severity,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    snapshot_ref: row.snapshot_ref,
    tenant_id: row.tenant_id,
    scope: row.scope,
    service_code: row.service_code,
    status: row.status,
    score: row.score,
    previous_status: row.previous_status,
    details: parseJson(row.details_json, {}),
    run_id: row.run_id,
    captured_at: row.captured_at,
    created_at: row.created_at,
  };
}

export function createHealthCheck(db, tenantId, input = {}, actor = null) {
  const code = String(input.code || "").trim().toUpperCase();
  if (!code) throw invalidHealthCheck("Health check code is required");
  const scope = String(input.scope || "PLATFORM").toUpperCase();
  if (!HEALTH_SCOPES.includes(scope)) throw invalidHealthCheck(`Unsupported scope: ${input.scope}`);
  const checkType = String(input.check_type || "THRESHOLD").toUpperCase();
  if (!HEALTH_CHECK_TYPES.includes(checkType)) throw invalidHealthCheck(`Unsupported check type: ${input.check_type}`);
  if (queryOne(db, "SELECT id FROM observability_health_checks WHERE tenant_id = ? AND code = ?", [Number(tenantId), code])) {
    throw invalidHealthCheck(`Health check already exists: ${code}`);
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO observability_health_checks (check_ref, tenant_id, code, name, description, scope, service_code, provider_code, metric_code, check_type, config_json, severity, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.check_ref || healthCheckRef(code),
      Number(tenantId),
      code,
      String(input.name || code),
      String(input.description || ""),
      scope,
      input.service_code ?? null,
      String(input.provider_code || "PLATFORM").toUpperCase(),
      input.metric_code ?? null,
      checkType,
      stringifyJson(input.config || {}),
      String(input.severity || "WARNING").toUpperCase(),
      String(input.status || "ACTIVE").toUpperCase(),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM observability_health_checks WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordHistory(db, { tenantId, action: "HEALTH_CHECK_CREATED", entityType: "health_check", entityId: row.id, entityRef: row.check_ref, actor, summary: `Health check ${code} created` });
  writeAudit(db, { actor_id: actor?.id ?? null, actor_username: actor?.username ?? null, action: "observability.health_check.create", resource_type: "observability_health_check", resource_id: row.check_ref, details: { code } });
  return publicHealthCheck(row);
}

export function listHealthChecks(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.service_code || query.serviceCode) {
    where.push("service_code = ?");
    params.push(String(query.service_code || query.serviceCode));
  }
  return paged(db, "observability_health_checks", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicHealthCheck });
}

export function getHealthCheckRow(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) return queryOne(db, "SELECT * FROM observability_health_checks WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
  return queryOne(db, "SELECT * FROM observability_health_checks WHERE tenant_id = ? AND (check_ref = ? OR code = ?)", [Number(tenantId), raw, raw]);
}

export function getHealthCheck(db, tenantId, ref) {
  const row = getHealthCheckRow(db, tenantId, ref);
  if (!row) throw healthCheckNotFound(ref);
  return publicHealthCheck(row);
}

export function updateHealthCheck(db, tenantId, ref, input = {}, actor = null) {
  const row = getHealthCheckRow(db, tenantId, ref);
  if (!row) throw healthCheckNotFound(ref);
  run(
    db,
    `UPDATE observability_health_checks SET name = ?, description = ?, scope = ?, service_code = ?, provider_code = ?, metric_code = ?, check_type = ?, config_json = ?, severity = ?, status = ?, updated_at = ? WHERE id = ?`,
    [
      input.name ?? row.name,
      input.description ?? row.description,
      input.scope ? String(input.scope).toUpperCase() : row.scope,
      input.service_code !== undefined ? input.service_code : row.service_code,
      input.provider_code ? String(input.provider_code).toUpperCase() : row.provider_code,
      input.metric_code !== undefined ? input.metric_code : row.metric_code,
      input.check_type ? String(input.check_type).toUpperCase() : row.check_type,
      input.config !== undefined ? stringifyJson(input.config) : row.config_json,
      input.severity ? String(input.severity).toUpperCase() : row.severity,
      input.status ? String(input.status).toUpperCase() : row.status,
      nowIso(),
      row.id,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM observability_health_checks WHERE id = ?", [row.id]);
  recordHistory(db, { tenantId, action: "HEALTH_CHECK_UPDATED", entityType: "health_check", entityId: row.id, entityRef: row.check_ref, actor, summary: `Health check ${row.code} updated` });
  return publicHealthCheck(updated);
}

export function deleteHealthCheck(db, tenantId, ref, actor = null) {
  const row = getHealthCheckRow(db, tenantId, ref);
  if (!row) throw healthCheckNotFound(ref);
  run(db, "UPDATE observability_health_checks SET status = 'ARCHIVED', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  recordHistory(db, { tenantId, action: "HEALTH_CHECK_ARCHIVED", entityType: "health_check", entityId: row.id, entityRef: row.check_ref, actor, summary: `Health check ${row.code} archived` });
  return { archived: true, check_ref: row.check_ref };
}

// ── Health evaluation ───────────────────────────────────────────────────────
function worstStatus(statuses) {
  let worst = "HEALTHY";
  let seen = false;
  for (const status of statuses) {
    if (!status || !(status in HEALTH_RANK)) continue;
    seen = true;
    if (HEALTH_RANK[status] > HEALTH_RANK[worst]) worst = status;
  }
  return seen ? worst : "UNKNOWN";
}

function statusScore(status) {
  switch (status) {
    case "HEALTHY":
      return 100;
    case "MAINTENANCE":
      return 100;
    case "WARNING":
      return 75;
    case "DEGRADED":
      return 50;
    case "CRITICAL":
      return 20;
    default:
      return null;
  }
}

// Aggregates open alerts per service into a health status.
export function serviceAlertStatus(db, tenantId) {
  if (!tableExists(db, "observability_alerts")) return {};
  const placeholders = ALERT_OPEN_STATUSES.map(() => "?").join(", ");
  const rows = queryAll(
    db,
    `SELECT COALESCE(service_code, 'platform') AS service_code, severity, COUNT(*) AS c
     FROM observability_alerts WHERE tenant_id = ? AND status IN (${placeholders})
     GROUP BY service_code, severity`,
    [Number(tenantId), ...ALERT_OPEN_STATUSES]
  );
  const byService = {};
  for (const row of rows) {
    const service = row.service_code || "platform";
    byService[service] = byService[service] || { status: "HEALTHY", alerts: { INFO: 0, WARNING: 0, HIGH: 0, CRITICAL: 0 } };
    const severity = String(row.severity || "WARNING").toUpperCase();
    byService[service].alerts[severity] = (byService[service].alerts[severity] || 0) + Number(row.c);
  }
  for (const service of Object.keys(byService)) {
    const alerts = byService[service].alerts;
    let status = "HEALTHY";
    if (alerts.CRITICAL > 0) status = "CRITICAL";
    else if (alerts.HIGH > 0) status = "DEGRADED";
    else if (alerts.WARNING > 0) status = "WARNING";
    byService[service].status = status;
  }
  return byService;
}

// Evaluates configured health checks plus the derived service roll-up.
export function evaluateHealth(db, tenantId, { runId = null } = {}) {
  const checks = queryAll(db, "SELECT * FROM observability_health_checks WHERE tenant_id = ? AND status = 'ACTIVE' ORDER BY code", [Number(tenantId)]);
  const freshness = evaluateFreshness(db, tenantId);
  const freshnessByProvider = {};
  for (const item of freshness) {
    const list = freshnessByProvider[item.provider_code] || [];
    list.push(item.status);
    freshnessByProvider[item.provider_code] = list;
  }
  const checkResults = checks.map((check) => {
    let status = "UNKNOWN";
    let detail = {};
    try {
      if (check.check_type === "THRESHOLD" && check.metric_code) {
        const metric = getMetricRow(db, tenantId, check.metric_code);
        const observation = queryOne(db, "SELECT value, observed_at FROM observability_metric_observations WHERE tenant_id = ? AND metric_code = ? ORDER BY observed_at DESC, id DESC LIMIT 1", [Number(tenantId), check.metric_code]);
        if (metric && observation) {
          const classified = classifyMetric(db, tenantId, metric, observation.value);
          status = classified.band === "OK" ? "HEALTHY" : classified.band === "UNKNOWN" ? "UNKNOWN" : classified.band;
          detail = { value: observation.value, band: classified.band, threshold: classified.threshold, observed_at: observation.observed_at };
        } else {
          detail = { reason: "no observation" };
        }
      } else if (check.check_type === "FRESHNESS") {
        const asset = check.config?.asset_code || check.service_code;
        const item = freshness.find((entry) => entry.asset_code === asset || entry.code === asset);
        if (item) {
          status = item.status === "FRESH" ? "HEALTHY" : item.status;
          detail = { age_seconds: item.age_seconds, status: item.status };
        } else {
          detail = { reason: "no freshness definition" };
        }
      } else if (check.check_type === "AVAILABILITY") {
        const probe = probeProvider(db, check.provider_code);
        status = probe.available ? "HEALTHY" : "CRITICAL";
        detail = { latency_ms: probe.latency_ms, error: probe.error };
      } else {
        detail = { reason: "unhandled check type" };
      }
    } catch (err) {
      status = "UNKNOWN";
      detail = { error: err.message };
    }
    return {
      check_ref: check.check_ref,
      code: check.code,
      name: check.name,
      scope: check.scope,
      service_code: check.service_code,
      check_type: check.check_type,
      severity: check.severity,
      status,
      score: statusScore(status),
      detail,
    };
  });

  const alertStatuses = serviceAlertStatus(db, tenantId);
  const services = {};
  const serviceCodes = new Set([...Object.keys(alertStatuses), ...Object.keys(freshnessByProvider), ...checkResults.map((c) => c.service_code).filter(Boolean)]);
  for (const service of serviceCodes) {
    const statuses = [];
    if (alertStatuses[service]) statuses.push(alertStatuses[service].status);
    if (freshnessByProvider[service]) statuses.push(...freshnessByProvider[service].map((s) => (s === "FRESH" ? "HEALTHY" : s)));
    for (const check of checkResults) if (check.service_code === service) statuses.push(check.status);
    services[service] = {
      service_code: service,
      status: worstStatus(statuses),
      alerts: alertStatuses[service]?.alerts || { INFO: 0, WARNING: 0, HIGH: 0, CRITICAL: 0 },
      checks: checkResults.filter((check) => check.service_code === service).map((check) => ({ code: check.code, status: check.status })),
    };
  }

  const overallStatuses = [ ...Object.values(services).map((s) => s.status), ...checkResults.map((c) => c.status) ];
  const overall = worstStatus(overallStatuses);
  const overallScore = statusScore(overall);
  return { overall, overall_score: overallScore, checks: checkResults, services: Object.values(services), freshness, generated_at: nowIso() };
}

// Persists snapshots for changed service statuses and records the run.
export function persistHealthSnapshots(db, tenantId, evaluation, { runId = null, actor = null } = {}) {
  const results = [];
  const entries = [{ scope: "PLATFORM", service_code: null, status: evaluation.overall, score: evaluation.overall_score, details: { services: evaluation.services.length, checks: evaluation.checks.length } }];
  for (const service of evaluation.services) {
    entries.push({ scope: "SERVICE", service_code: service.service_code, status: service.status, score: statusScore(service.status), details: service });
  }
  for (const entry of entries) {
    const previous = queryOne(
      db,
      "SELECT * FROM observability_health_snapshots WHERE tenant_id = ? AND scope = ? AND COALESCE(service_code, '') = ? ORDER BY captured_at DESC, id DESC LIMIT 1",
      [Number(tenantId), entry.scope, entry.service_code || ""]
    );
    const changed = !previous || previous.status !== entry.status;
    const result = run(
      db,
      `INSERT INTO observability_health_snapshots (snapshot_ref, tenant_id, scope, service_code, status, score, previous_status, details_json, run_id, captured_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [healthSnapshotRef(), Number(tenantId), entry.scope, entry.service_code, entry.status, entry.score, previous?.status ?? null, stringifyJson(entry.details), runId ?? null, nowIso(), nowIso()]
    );
    results.push({ snapshot_ref: result.lastInsertRowid, ...entry, changed, previous_status: previous?.status ?? null });
    if (changed) {
      publishObservabilityEvent(
        db,
        {
          eventType: observabilityEventCode("HEALTH_CHANGED"),
          payload: { scope: entry.scope, service_code: entry.service_code, status: entry.status, previous_status: previous?.status ?? null },
          objectType: "observability_health",
          objectId: result.lastInsertRowid,
          tenantId,
        },
        actor
      );
    }
  }
  return results;
}

export function currentHealth(db, tenantId) {
  if (!tableExists(db, "observability_health_snapshots")) return { overall: "UNKNOWN", services: [] };
  const platform = queryOne(db, "SELECT * FROM observability_health_snapshots WHERE tenant_id = ? AND scope = 'PLATFORM' ORDER BY captured_at DESC, id DESC LIMIT 1", [Number(tenantId)]);
  const services = queryAll(
    db,
    `SELECT s.* FROM observability_health_snapshots s
     JOIN (SELECT service_code, MAX(id) AS mx FROM observability_health_snapshots WHERE tenant_id = ? AND scope = 'SERVICE' AND service_code IS NOT NULL GROUP BY service_code) latest
       ON latest.mx = s.id
     WHERE s.tenant_id = ? ORDER BY s.service_code`,
    [Number(tenantId), Number(tenantId)]
  ).map(publicSnapshot);
  return {
    overall: platform?.status || "UNKNOWN",
    score: platform?.score ?? null,
    captured_at: platform?.captured_at || null,
    services,
  };
}

export function listHealthSnapshots(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.scope) {
    where.push("scope = ?");
    params.push(String(query.scope).toUpperCase());
  }
  if (query.service_code || query.serviceCode) {
    where.push("service_code = ?");
    params.push(String(query.service_code || query.serviceCode));
  }
  return paged(db, "observability_health_snapshots", { where, params, orderBy: "captured_at DESC, id DESC", page: query.page, pageSize: query.page_size || query.pageSize, map: publicSnapshot });
}

export function healthTrend(db, tenantId, query = {}) {
  const hours = Math.max(1, Math.min(720, Number(query.hours) || 24));
  const rows = queryAll(
    db,
    "SELECT status, captured_at FROM observability_health_snapshots WHERE tenant_id = ? AND scope = 'PLATFORM' AND captured_at >= datetime('now', ?) ORDER BY captured_at ASC",
    [Number(tenantId), `-${hours} hours`]
  );
  const buckets = { HEALTHY: 0, WARNING: 0, DEGRADED: 0, CRITICAL: 0, UNKNOWN: 0, MAINTENANCE: 0 };
  for (const row of rows) buckets[row.status] = (buckets[row.status] || 0) + 1;
  return { hours, points: rows.map((row) => ({ captured_at: row.captured_at, status: row.status })), buckets };
}

export function pruneHealthSnapshots(db, tenantId, retainDays) {
  const days = Math.max(1, Number(retainDays) || 90);
  const result = run(db, "DELETE FROM observability_health_snapshots WHERE tenant_id = ? AND captured_at < datetime('now', ?)", [Number(tenantId), `-${days} days`]);
  return Number(result.changes || 0);
}

export { HEALTH_RANK, SEVERITY_RANK };
