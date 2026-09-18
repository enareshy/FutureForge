// Event Monitoring.
//
// Aggregates the operational picture (throughput, failures, latency, backlog,
// dead letters, replays, ordering and broker health) from the delivery and
// event tables. Every function is read-only and tenant-scoped so the same code
// powers the admin console and external observability.
import { queryAll, queryOne, nowIso } from "../../db.js";
import { clampInt } from "./validation.js";
import { windowSince } from "./repository.js";
import { outboxStats } from "./outbox.js";
import { deadLetterStats } from "./deadletter.js";
import { replayStats } from "./replay.js";
import { consumerStats, consumerLagByGroup } from "./consumer.js";
import { handlerStats, slowHandlers } from "./handlers.js";
import { queueDepth, listQueueStats, consumerLag, topologyHealth, brokerHealth, listBusProviders } from "./bus.js";
import { orderingState } from "./ordering.js";

function tenantClause(tenantId, alias = "") {
  const col = alias ? `${alias}.tenant_id` : "tenant_id";
  return tenantId !== undefined && tenantId !== null ? { clause: `AND ${col} = ?`, params: [Number(tenantId)] } : { clause: "", params: [] };
}

// Throughput over time, bucketed. `bucketMinutes` keeps the response small for
// long windows and bounds the number of points the dashboard renders.
export function throughputTimeseries(db, { tenantId = null, windowHours = 24, bucketMinutes = 60 } = {}) {
  const since = windowSince(windowHours);
  const bucket = clampInt(bucketMinutes, 1, 1440, 60);
  const { clause, params } = tenantClause(tenantId);
  const rows = queryAll(
    db,
    `SELECT
       strftime('%Y-%m-%dT%H:%M:00', created_at) AS bucket,
       COUNT(*) AS published
     FROM event_records
     WHERE created_at >= ? ${clause}
     GROUP BY bucket ORDER BY bucket`,
    [since, ...params]
  );
  const deliveryRows = queryAll(
    db,
    `SELECT
       strftime('%Y-%m-%dT%H:%M:00', updated_at) AS bucket,
       SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN status IN ('failed','dead_letter') THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retrying
     FROM event_deliveries
     WHERE updated_at >= ? ${clause}
     GROUP BY bucket ORDER BY bucket`,
    [since, ...params]
  );
  const merged = new Map();
  for (const r of rows) merged.set(r.bucket, { bucket: r.bucket, published: r.published, delivered: 0, failed: 0, retrying: 0 });
  for (const r of deliveryRows) {
    const entry = merged.get(r.bucket) || { bucket: r.bucket, published: 0, delivered: 0, failed: 0, retrying: 0 };
    entry.delivered = r.delivered || 0;
    entry.failed = r.failed || 0;
    entry.retrying = r.retrying || 0;
    merged.set(r.bucket, entry);
  }
  const points = [...merged.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
  const totals = points.reduce(
    (acc, p) => ({ published: acc.published + p.published, delivered: acc.delivered + p.delivered, failed: acc.failed + p.failed }),
    { published: 0, delivered: 0, failed: 0 }
  );
  return { window_hours: Number(windowHours), bucket_minutes: bucket, points, totals };
}

export function deliveryStatusBreakdown(db, { tenantId = null, windowHours = 24 } = {}) {
  const since = windowSince(windowHours);
  const { clause, params } = tenantClause(tenantId);
  const rows = queryAll(db, `SELECT status, COUNT(*) AS count FROM event_deliveries WHERE updated_at >= ? ${clause} GROUP BY status ORDER BY count DESC`, [
    since,
    ...params,
  ]);
  return rows;
}

export function failureBreakdown(db, { tenantId = null, windowHours = 24 } = {}) {
  const since = windowSince(windowHours);
  const { clause, params } = tenantClause(tenantId);
  const byCategory = queryAll(
    db,
    `SELECT error_category, COUNT(*) AS count FROM event_deliveries WHERE updated_at >= ? AND status IN ('failed','dead_letter') ${clause}
     GROUP BY error_category ORDER BY count DESC`,
    [since, ...params]
  );
  const byCode = queryAll(
    db,
    `SELECT error_code, COUNT(*) AS count FROM event_deliveries WHERE updated_at >= ? AND status IN ('failed','dead_letter') ${clause}
     GROUP BY error_code ORDER BY count DESC LIMIT 15`,
    [since, ...params]
  );
  const byType = queryAll(
    db,
    `SELECT event_type_code, COUNT(*) AS count FROM event_deliveries WHERE updated_at >= ? AND status IN ('failed','dead_letter') ${clause}
     GROUP BY event_type_code ORDER BY count DESC LIMIT 15`,
    [since, ...params]
  );
  const recent = queryAll(
    db,
    `SELECT id, event_ref, handler, event_type_code, error_category, error_code, last_error, attempts, updated_at
     FROM event_deliveries WHERE status IN ('failed','dead_letter') ${clause.replace("AND", "AND")}
     ORDER BY updated_at DESC LIMIT 20`,
    tenantId !== undefined && tenantId !== null ? [Number(tenantId)] : []
  );
  return { by_category: byCategory, by_code: byCode, by_event_type: byType, recent };
}

export function latencyStats(db, { tenantId = null, windowHours = 24 } = {}) {
  const since = windowSince(windowHours);
  const { clause, params } = tenantClause(tenantId);
  const overall = queryOne(
    db,
    `SELECT
       AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms, MIN(duration_ms) AS min_ms, COUNT(duration_ms) AS samples
     FROM event_deliveries WHERE updated_at >= ? AND duration_ms IS NOT NULL ${clause}`,
    [since, ...params]
  );
  const byHandler = queryAll(
    db,
    `SELECT COALESCE(NULLIF(handler,''),'(unbound)') AS handler, AVG(duration_ms) AS avg_ms, MAX(duration_ms) AS max_ms, COUNT(*) AS samples
     FROM event_deliveries WHERE updated_at >= ? AND duration_ms IS NOT NULL ${clause}
     GROUP BY handler ORDER BY avg_ms DESC LIMIT 15`,
    [since, ...params]
  );
  return {
    overall: {
      avg_ms: overall?.avg_ms ? Math.round(overall.avg_ms) : null,
      min_ms: overall?.min_ms ?? null,
      max_ms: overall?.max_ms ?? null,
      samples: overall?.samples || 0,
    },
    by_handler: byHandler.map((r) => ({ ...r, avg_ms: r.avg_ms ? Math.round(r.avg_ms) : null })),
  };
}

export function eventTypeActivity(db, { tenantId = null, windowHours = 24, limit = 15 } = {}) {
  const since = windowSince(windowHours);
  const { clause, params } = tenantClause(tenantId);
  return queryAll(
    db,
    `SELECT
       r.event_type_code,
       COUNT(*) AS published,
       SUM(CASE WHEN r.status = 'published' THEN 1 ELSE 0 END) AS published_ok,
       (SELECT COUNT(*) FROM event_deliveries d WHERE d.event_type_code = r.event_type_code AND d.updated_at >= ?) AS deliveries,
       (SELECT COUNT(*) FROM event_deliveries d WHERE d.event_type_code = r.event_type_code AND d.status IN ('failed','dead_letter') AND d.updated_at >= ?) AS failed
     FROM event_records r
     WHERE r.created_at >= ? ${clause.replace("tenant_id", "r.tenant_id")}
     GROUP BY r.event_type_code ORDER BY published DESC LIMIT ?`,
    [since, since, since, ...params, Number(limit)]
  );
}

// The dashboard summary is the single call the admin console needs: totals,
// backlog, health and the most actionable lists.
export function dashboardSummary(db, { tenantId = null, windowHours = 24 } = {}) {
  const since = windowSince(windowHours);
  const { clause, params } = tenantClause(tenantId);
  const published = queryOne(db, `SELECT COUNT(*) AS c FROM event_records WHERE created_at >= ? ${clause}`, [since, ...params]).c;
  const delivered = queryOne(db, `SELECT COUNT(*) AS c FROM event_deliveries WHERE status = 'delivered' AND updated_at >= ? ${clause}`, [since, ...params]).c;
  const failed = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM event_deliveries WHERE status IN ('failed','dead_letter') AND updated_at >= ? ${clause}`,
    [since, ...params]
  ).c;
  const queue = queueDepth(db, { tenantId });
  return {
    window_hours: Number(windowHours),
    events: { published, delivered, failed, success_rate: published + delivered + failed > 0 ? Number(((delivered / (delivered + failed)) * 100).toFixed(2)) : null },
    queue,
    outbox: outboxStats(db, { tenantId }),
    dead_letters: deadLetterStats(db, { tenantId }),
    replays: replayStats(db, { tenantId }),
    consumers: consumerStats(db, { tenantId, windowHours }),
    ordering: orderingState(db, { tenantId }),
    consumer_lag: consumerLag(db, { tenantId }),
    throughput: throughputTimeseries(db, { tenantId, windowHours, bucketMinutes: windowHours <= 24 ? 60 : 360 }).points,
    failures: failureBreakdown(db, { tenantId, windowHours }).by_category,
    top_failing_handlers: handlerStats(db, { tenantId, windowHours }).filter((h) => h.failed > 0).slice(0, 10),
    slow_handlers: slowHandlers(db, { tenantId, windowHours, limit: 5 }),
    event_types: eventTypeActivity(db, { tenantId, windowHours, limit: 10 }),
    generated_at: nowIso(),
  };
}

export function healthCheck(db, { tenantId = null } = {}) {
  const broker = brokerHealth(db);
  const topology = topologyHealth(db, { tenantId });
  const outbox = outboxStats(db, { tenantId });
  const deadLetters = deadLetterStats(db, { tenantId, windowHours: 24 });
  const queue = queueDepth(db, { tenantId });
  const checks = [
    { name: "broker", status: broker.connected ? "up" : "down", detail: broker },
    { name: "outbox_backlog", status: outbox.due > 1000 ? "degraded" : "up", detail: { due: outbox.due, dead_letter: outbox.dead_letter } },
    { name: "dead_letter_24h", status: deadLetters.open > 100 ? "degraded" : "up", detail: { open: deadLetters.open } },
    { name: "queue_backlog", status: queue.depth > 5000 ? "degraded" : "up", detail: queue },
  ];
  const overall = checks.some((c) => c.status === "down") ? "down" : checks.some((c) => c.status === "degraded") ? "degraded" : "up";
  return {
    status: overall,
    provider: broker.provider,
    providers_available: listBusProviders(),
    topology,
    checks,
    queues: listQueueStats(db, { tenantId }),
    consumer_groups: consumerLagByGroup(db, { tenantId }),
    generated_at: nowIso(),
  };
}

// Traceability: given a correlation or trace id, return the complete chain of
// events and deliveries so an operator can follow one business operation.
export function traceability(db, { correlationId, traceId, tenantId = null } = {}) {
  const clauses = [];
  const params = [];
  if (correlationId) {
    clauses.push("correlation_id = ?");
    params.push(correlationId);
  }
  if (traceId) {
    clauses.push("trace_id = ?");
    params.push(traceId);
  }
  if (!clauses.length) return { correlation_id: correlationId || null, trace_id: traceId || null, events: [], deliveries: [] };
  const where = clauses.join(" AND ");
  const tClause = tenantId !== undefined && tenantId !== null ? " AND tenant_id = ?" : "";
  const tParams = tenantId !== undefined && tenantId !== null ? [Number(tenantId)] : [];
  const events = queryAll(db, `SELECT * FROM event_records WHERE ${where} ${tClause} ORDER BY id`, [...params, ...tParams]);
  const deliveries = queryAll(db, `SELECT * FROM event_deliveries WHERE ${where} ${tClause} ORDER BY id`, [...params, ...tParams]);
  return {
    correlation_id: correlationId || null,
    trace_id: traceId || null,
    events: events.map((e) => ({ id: e.id, event_ref: e.event_ref, event_type_code: e.event_type_code, status: e.status, created_at: e.created_at })),
    deliveries: deliveries.map((d) => ({
      id: d.id,
      event_ref: d.event_ref,
      handler: d.handler,
      status: d.status,
      attempts: d.attempts,
      duration_ms: d.duration_ms,
      updated_at: d.updated_at,
    })),
  };
}
