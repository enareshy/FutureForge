// Integration monitoring: external-system health history/uptime, execution and
// delivery metrics, error taxonomy rollups and operational dashboards.
import { queryAll, queryOne, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { publicHealthCheck } from "./repository.js";
import { getSystemRow, testConnection } from "./systems.js";
import { deadLetterStats } from "./deadletter.js";
import { queueDepth } from "./messages.js";
import { transferStats } from "./transfers.js";

function hoursAgoIso(hours) {
  return new Date(Date.now() - Number(hours) * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function tenantPair(tenantId, alias = "") {
  const col = alias ? `${alias}.tenant_id` : "tenant_id";
  if (tenantId === undefined || tenantId === null) return { clause: "", params: [] };
  return { clause: `${col} = ?`, params: [Number(tenantId)] };
}

// Runs a health check for every (optionally filtered) external system and
// records the result in integration_health_checks.
export function runHealthChecks(db, { actor = null, tenantId = null, systemType = null, onlyActive = true } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (systemType) {
    clauses.push("system_type = ?");
    params.push(systemType);
  }
  if (onlyActive) clauses.push("status = 'active'");
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const systems = queryAll(db, `SELECT * FROM external_systems ${where} ORDER BY code`, params);
  const summary = { checked: 0, healthy: 0, degraded: 0, down: 0 };
  const results = [];
  for (const system of systems) {
    try {
      const result = testConnection(db, system.id, actor);
      summary.checked += 1;
      summary[result.status] = (summary[result.status] || 0) + 1;
      results.push({ system_id: system.id, code: system.code, status: result.status, latency_ms: result.latency_ms, message: result.message });
    } catch (error) {
      summary.checked += 1;
      summary.down = (summary.down || 0) + 1;
      results.push({ system_id: system.id, code: system.code, status: "down", message: error.message });
    }
  }
  return { summary, results };
}

export function listSystemsHealth(db, { tenantId = null, status = null } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("s.tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (status) {
    clauses.push("s.connection_status = ?");
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const systems = queryAll(db, `SELECT s.* FROM external_systems s ${where} ORDER BY s.code`, params);
  return systems.map((system) => {
    const latest = queryOne(db, "SELECT * FROM integration_health_checks WHERE system_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1", [system.id]);
    const counts = queryOne(
      db,
      `SELECT
         SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) AS healthy,
         SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) AS degraded,
         SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down,
         COUNT(*) AS total
       FROM integration_health_checks WHERE system_id = ? AND checked_at >= ?`,
      [system.id, hoursAgoIso(24)]
    );
    return {
      system_id: system.id,
      code: system.code,
      name: system.name,
      system_type: system.system_type,
      environment: system.environment,
      status: system.status,
      connection_status: system.connection_status,
      last_health_at: system.last_health_at || null,
      last_health_message: system.last_health_message || "",
      latest_check: latest ? publicHealthCheck(latest) : null,
      last_24h: { healthy: counts?.healthy || 0, degraded: counts?.degraded || 0, down: counts?.down || 0, total: counts?.total || 0 },
    };
  });
}

export function systemUptime(db, systemRef, { hours = 24 } = {}) {
  const row = getSystemRow(db, systemRef);
  if (!row) throw new HttpError(404, "External system not found");
  const since = hoursAgoIso(hours);
  const counts = queryOne(
    db,
    `SELECT
       SUM(CASE WHEN status = 'healthy' THEN 1 ELSE 0 END) AS healthy,
       SUM(CASE WHEN status = 'degraded' THEN 1 ELSE 0 END) AS degraded,
       SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END) AS down,
       COUNT(*) AS total
     FROM integration_health_checks WHERE system_id = ? AND checked_at >= ?`,
    [row.id, since]
  );
  const total = counts?.total || 0;
  return {
    system_id: row.id,
    code: row.code,
    hours: Number(hours),
    healthy: counts?.healthy || 0,
    degraded: counts?.degraded || 0,
    down: counts?.down || 0,
    total,
    uptime_percent: total ? Number((((counts.healthy || 0) + (counts.degraded || 0) * 0.5) / total) * 100).toFixed(2) : null,
  };
}

export function executionMetrics(db, { tenantId = null, hours = 24 } = {}) {
  const since = hoursAgoIso(hours);
  const t = tenantPair(tenantId);
  const params = [since, ...t.params];
  const clause = `created_at >= ?${t.clause ? ` AND ${t.clause}` : ""}`;
  const totals = queryOne(
    db,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status IN ('succeeded') THEN 1 ELSE 0 END) AS succeeded,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
       SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
       SUM(CASE WHEN status = 'timed_out' THEN 1 ELSE 0 END) AS timed_out,
       SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
       AVG(duration_ms) AS avg_duration_ms,
       MAX(duration_ms) AS max_duration_ms
     FROM integration_executions WHERE ${clause}`,
    params
  );
  const durations = queryAll(
    db,
    `SELECT duration_ms FROM integration_executions WHERE ${clause} AND duration_ms IS NOT NULL ORDER BY duration_ms`,
    params
  ).map((r) => r.duration_ms);
  const p95 = durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))] : null;
  const topFailing = queryAll(
    db,
    `SELECT definition_id, integration_code, COUNT(*) AS failures
       FROM integration_executions WHERE ${clause} AND status IN ('failed','timed_out','partial')
       GROUP BY definition_id, integration_code ORDER BY failures DESC LIMIT 10`,
    params
  );
  const byCategory = queryAll(
    db,
    `SELECT error_category, COUNT(*) AS count FROM integration_executions
      WHERE ${clause} AND error_category != '' GROUP BY error_category ORDER BY count DESC`,
    params
  );
  const total = totals?.total || 0;
  const terminal = total - (totals?.running || 0);
  return {
    window_hours: Number(hours),
    totals: {
      total,
      succeeded: totals?.succeeded || 0,
      failed: totals?.failed || 0,
      partial: totals?.partial || 0,
      cancelled: totals?.cancelled || 0,
      timed_out: totals?.timed_out || 0,
      running: totals?.running || 0,
    },
    success_rate: terminal ? Number(((totals?.succeeded || 0) / terminal) * 100).toFixed(2) : null,
    avg_duration_ms: totals?.avg_duration_ms ? Math.round(totals.avg_duration_ms) : null,
    max_duration_ms: totals?.max_duration_ms || null,
    p95_duration_ms: p95,
    top_failing: topFailing,
    errors_by_category: byCategory,
  };
}

export function deliveryMetrics(db, { tenantId = null } = {}) {
  const t = tenantPair(tenantId);
  const where = t.clause ? `WHERE ${t.clause}` : "";
  const events = queryOne(
    db,
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN status IN ('processed','published') THEN 1 ELSE 0 END) AS processed,
       SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END) AS partial,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM integration_events ${where}`,
    t.params
  );
  const eventDeliveries = queryAll(
    db,
    `SELECT status, COUNT(*) AS count FROM integration_event_deliveries ${where} GROUP BY status`,
    t.params
  );
  const webhookDeliveries = queryAll(
    db,
    `SELECT status, COUNT(*) AS count FROM integration_webhook_deliveries ${where} GROUP BY status`,
    t.params
  );
  return {
    events: events || { total: 0, processed: 0, partial: 0, failed: 0 },
    event_deliveries: Object.fromEntries(eventDeliveries.map((r) => [r.status, r.count])),
    webhook_deliveries: Object.fromEntries(webhookDeliveries.map((r) => [r.status, r.count])),
    message_queues: queueDepth(db, { tenantId }),
    dead_letters: deadLetterStats(db, { tenantId }),
    transfers: transferStats(db, { tenantId }),
  };
}

// Single operational dashboard payload used by the integration monitor UI.
export function monitoringOverview(db, { tenantId = null, hours = 24 } = {}) {
  const t = tenantPair(tenantId);
  const where = t.clause ? `WHERE ${t.clause}` : "";
  const definitions = queryAll(db, `SELECT status, COUNT(*) AS count FROM integration_definitions ${where} GROUP BY status`, t.params);
  const schedules = queryOne(
    db,
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM integration_schedules ${where}`,
    t.params
  );
  const endpointWhere = t.clause ? `WHERE ${t.clause}` : "";
  const endpoints = queryOne(db, `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'enabled' THEN 1 ELSE 0 END) AS enabled FROM integration_endpoints ${endpointWhere}`, t.params);
  const webhooks = queryOne(
    db,
    `SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active FROM integration_webhook_subscriptions ${endpointWhere}`,
    t.params
  );
  const health = listSystemsHealth(db, { tenantId });
  const healthSummary = health.reduce((acc, item) => {
    acc[item.connection_status] = (acc[item.connection_status] || 0) + 1;
    return acc;
  }, {});
  return {
    generated_at: nowIso(),
    definitions: { by_status: Object.fromEntries(definitions.map((r) => [r.status, r.count])), total: definitions.reduce((a, r) => a + r.count, 0) },
    schedules: { total: schedules?.total || 0, active: schedules?.active || 0 },
    endpoints: { total: endpoints?.total || 0, enabled: endpoints?.enabled || 0 },
    webhooks: { total: webhooks?.total || 0, active: webhooks?.active || 0 },
    systems_health: healthSummary,
    executions: executionMetrics(db, { tenantId, hours }),
    deliveries: deliveryMetrics(db, { tenantId }),
  };
}
