import { queryAll, queryOne } from "../../db.js";
import { providerHealth } from "./providers.js";

// Delivery tracking, reporting and operational metrics. All queries are
// tenant-scoped when a tenantId is supplied.

function scope(tenantId, from, to, alias = "") {
  const column = alias ? `${alias}.tenant_id` : "tenant_id";
  const where = [];
  const params = [];
  if (tenantId) {
    where.push(`COALESCE(${column}, 0) = ?`);
    params.push(Number(tenantId));
  }
  if (from) {
    where.push(`${alias ? `${alias}.` : ""}created_at >= ?`);
    params.push(String(from));
  }
  if (to) {
    where.push(`${alias ? `${alias}.` : ""}created_at <= ?`);
    params.push(String(to));
  }
  return { clause: where.length ? `WHERE ${where.join(" AND ")}` : "", params };
}

export function deliveryMetrics(db, { tenantId = null, from = null, to = null } = {}) {
  const { clause, params } = scope(tenantId, from, to);
  const byStatusRows = queryAll(db, `SELECT status, COUNT(*) AS count FROM delivery_requests ${clause} GROUP BY status`, params);
  const byStatus = byStatusRows.reduce((acc, row) => {
    acc[row.status] = row.count;
    return acc;
  }, {});
  const total = byStatusRows.reduce((sum, row) => sum + row.count, 0);

  const byChannelRows = queryAll(
    db,
    `SELECT channel, status, COUNT(*) AS count FROM delivery_requests ${clause} GROUP BY channel, status`,
    params
  );
  const channelMap = new Map();
  for (const row of byChannelRows) {
    if (!channelMap.has(row.channel)) channelMap.set(row.channel, { channel: row.channel, total: 0, sent: 0, failed: 0, dead_lettered: 0, retrying: 0, queued: 0 });
    const entry = channelMap.get(row.channel);
    entry.total += row.count;
    if (row.status === "sent" || row.status === "delivered") entry.sent += row.count;
    if (row.status === "failed") entry.failed += row.count;
    if (row.status === "dead_lettered") entry.dead_lettered += row.count;
    if (row.status === "retrying") entry.retrying += row.count;
    if (row.status === "queued" || row.status === "processing" || row.status === "created") entry.queued += row.count;
  }
  const byChannel = [...channelMap.values()];

  const byProvider = queryAll(
    db,
    `SELECT provider_code, status, COUNT(*) AS count FROM delivery_requests
      ${clause}${clause ? " AND" : "WHERE"} provider_code <> '' GROUP BY provider_code, status`,
    params
  ).reduce((acc, row) => {
    if (!acc[row.provider_code]) acc[row.provider_code] = { provider_code: row.provider_code, total: 0, sent: 0, failed: 0 };
    acc[row.provider_code].total += row.count;
    if (row.status === "sent" || row.status === "delivered") acc[row.provider_code].sent += row.count;
    if (row.status === "failed" || row.status === "dead_lettered") acc[row.provider_code].failed += row.count;
    return acc;
  }, {});

  // Latency: success attempts and queue time (created -> sent).
  const latencyParams = [...params];
  const latency = queryOne(
    db,
    `SELECT AVG(duration_ms) AS avg_attempt_ms, MAX(duration_ms) AS max_attempt_ms
       FROM delivery_attempts a
       JOIN delivery_requests r ON r.id = a.request_id
      ${clause.replace(/\btenant_id\b/g, "r.tenant_id").replace(/\bcreated_at\b/g, "r.created_at") || ""}
        ${clause ? "AND" : "WHERE"} a.status IN ('sent', 'delivered')`,
    latencyParams
  );
  const queueRow = queryOne(
    db,
    `SELECT AVG((julianday(sent_at) - julianday(created_at)) * 86400) AS avg_queue_seconds
       FROM delivery_requests ${clause}${clause ? " AND" : "WHERE"} sent_at IS NOT NULL`,
    params
  );

  const retryRow = queryOne(
    db,
    `SELECT SUM(CASE WHEN attempt > 1 THEN 1 ELSE 0 END) AS retried, SUM(attempt) AS attempts FROM delivery_requests ${clause}`,
    params
  );

  const timeseries = queryAll(
    db,
    `SELECT substr(created_at, 1, 10) AS day, status, COUNT(*) AS count
       FROM delivery_requests ${clause}
      GROUP BY day, status ORDER BY day`,
    params
  ).reduce((acc, row) => {
    const entry = acc.find((item) => item.day === row.day) || { day: row.day, total: 0, sent: 0, failed: 0 };
    entry.total += row.count;
    if (row.status === "sent" || row.status === "delivered") entry.sent += row.count;
    if (row.status === "failed" || row.status === "dead_lettered") entry.failed += row.count;
    if (!acc.includes(entry)) acc.push(entry);
    return acc;
  }, []);

  const attempts = queryOne(db, "SELECT COUNT(*) AS c FROM delivery_attempts a JOIN delivery_requests r ON r.id = a.request_id " + (clause ? clause.replace(/\btenant_id\b/g, "r.tenant_id").replace(/\bcreated_at\b/g, "r.created_at") : ""), params);

  return {
    total,
    by_status: byStatus,
    created: byStatus.created || 0,
    queued: (byStatus.queued || 0) + (byStatus.created || 0),
    processing: byStatus.processing || 0,
    sent: (byStatus.sent || 0) + (byStatus.delivered || 0),
    delivered: byStatus.delivered || 0,
    failed: byStatus.failed || 0,
    retrying: byStatus.retrying || 0,
    cancelled: byStatus.cancelled || 0,
    dead_lettered: byStatus.dead_lettered || 0,
    dead_letter: (byStatus.failed || 0) + (byStatus.dead_lettered || 0),
    retry_count: retryRow?.retried || 0,
    attempt_count: retryRow?.attempts || 0,
    attempts: attempts?.c || 0,
    avg_delivery_ms: latency?.avg_attempt_ms ? Math.round(latency.avg_attempt_ms) : 0,
    max_delivery_ms: latency?.max_attempt_ms || 0,
    avg_queue_seconds: queueRow?.avg_queue_seconds ? Math.round(queueRow.avg_queue_seconds * 10) / 10 : 0,
    by_channel: byChannel,
    by_provider: Object.values(byProvider),
    timeseries,
    providers: providerHealth(db, tenantId),
  };
}

// Compact stats shape used by the notification compatibility layer and the
// delivery widget.
export function deliveryStats(db, tenantId = null) {
  const metrics = deliveryMetrics(db, { tenantId });
  return {
    total: metrics.total,
    by_status: metrics.by_status,
    queued: metrics.queued,
    sent: metrics.sent,
    failed: metrics.failed,
    dead_letter: metrics.dead_letter,
    retrying: metrics.retrying,
    cancelled: metrics.cancelled,
    by_channel: metrics.by_channel,
  };
}

export function deliveryTimeseries(db, options = {}) {
  return deliveryMetrics(db, options).timeseries;
}

export function providerFailureSummary(db, tenantId = null) {
  const { clause, params } = scope(tenantId, null, null);
  return queryAll(
    db,
    `SELECT provider_code, COUNT(*) AS count, SUM(permanent) AS permanent
       FROM delivery_provider_failures ${clause}${clause ? " AND" : "WHERE"} provider_code <> ''
      GROUP BY provider_code ORDER BY count DESC`,
    params
  );
}
