import { queryAll, queryOne } from "../../db.js";
import { JOB_STATUSES, TERMINAL_STATUSES, statusLabel } from "./validation.js";

// Operational monitoring for the Job Dashboard. Aggregates the job records into
// counters, queue depth, per-type/module breakdowns, success rate, duration and
// recent failures. Pure read model: no state is mutated.

function tenantClause(tenantId, params) {
  if (tenantId === null || tenantId === undefined) return "";
  params.push(Number(tenantId));
  return "WHERE COALESCE(tenant_id, 0) = ?";
}

export function jobStatusCounts(db, tenantId = null) {
  const params = [];
  const clause = tenantClause(tenantId, params);
  const rows = queryAll(db, `SELECT status, COUNT(*) AS c FROM jobs ${clause} GROUP BY status`, params);
  const map = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0]));
  for (const row of rows) map[row.status] = row.c;
  return map;
}

export function jobMetrics(db, tenantId = null) {
  const params = [];
  const clause = tenantClause(tenantId, params);
  const counts = jobStatusCounts(db, tenantId);
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const active = JOB_STATUSES.filter((status) => !TERMINAL_STATUSES.includes(status)).reduce((sum, status) => sum + counts[status], 0);
  const finished = TERMINAL_STATUSES.reduce((sum, status) => sum + counts[status], 0);
  const succeeded = counts.completed;
  const successRate = finished > 0 ? Math.round((succeeded / finished) * 1000) / 10 : null;

  const byStatus = JOB_STATUSES.map((status) => ({
    status,
    status_label: statusLabel(status),
    count: counts[status],
    active: !TERMINAL_STATUSES.includes(status),
  })).filter((entry) => entry.count > 0 || entry.active);

  const byType = queryAll(
    db,
    `SELECT job_type_code AS type, COUNT(*) AS c,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status IN ('failed', 'timed_out') THEN 1 ELSE 0 END) AS failed
       FROM jobs ${clause} GROUP BY job_type_code ORDER BY c DESC LIMIT 25`,
    params
  ).map((row) => ({
    type: row.type,
    total: row.c,
    completed: row.completed || 0,
    failed: row.failed || 0,
  }));

  const byModule = queryAll(
    db,
    `SELECT source_module AS module, COUNT(*) AS c,
            SUM(CASE WHEN status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(", ")}) THEN 1 ELSE 0 END) AS active
       FROM jobs ${clause} GROUP BY source_module ORDER BY c DESC LIMIT 25`,
    [...TERMINAL_STATUSES, ...params]
  ).map((row) => ({ module: row.module, total: row.c, active: row.active || 0 }));

  const queueDepth = queryAll(
    db,
    `SELECT queue, COUNT(*) AS c FROM jobs
      ${clause ? `${clause} AND` : "WHERE"} status IN ('queued', 'scheduled', 'retrying', 'running')
      GROUP BY queue ORDER BY c DESC`,
    params
  ).map((row) => ({ queue: row.queue, depth: row.c }));

  const duration = queryOne(
    db,
    `SELECT AVG((julianday(completed_at) - julianday(started_at)) * 86400.0) AS avg_seconds,
            MAX((julianday(completed_at) - julianday(started_at)) * 86400.0) AS max_seconds
       FROM jobs
      ${clause ? `${clause} AND` : "WHERE"} completed_at IS NOT NULL AND started_at IS NOT NULL`,
    params
  );

  const retries = queryOne(db, `SELECT COALESCE(SUM(retry_count), 0) AS c FROM jobs ${clause}`, params).c;

  const recentFailures = queryAll(
    db,
    `SELECT id, job_ref, name, job_type_code, status, error_code, error_message, source_module, created_at, completed_at
       FROM jobs
      ${clause ? `${clause} AND` : "WHERE"} status IN ('failed', 'timed_out', 'cancelled')
      ORDER BY updated_at DESC LIMIT 10`,
    params
  ).map((row) => ({
    id: row.id,
    job_ref: row.job_ref,
    name: row.name,
    job_type_code: row.job_type_code,
    status: row.status,
    status_label: statusLabel(row.status),
    error_code: row.error_code || "",
    error_message: row.error_message || "",
    source_module: row.source_module,
    created_at: row.created_at,
    completed_at: row.completed_at || null,
  }));

  return {
    total,
    active,
    finished,
    success_rate: successRate,
    avg_duration_seconds: duration?.avg_seconds ? Math.round(duration.avg_seconds * 10) / 10 : null,
    max_duration_seconds: duration?.max_seconds ? Math.round(duration.max_seconds * 10) / 10 : null,
    retries,
    statuses: counts,
    by_status: byStatus,
    by_type: byType,
    by_module: byModule,
    queue_depth: queueDepth,
    recent_failures: recentFailures,
  };
}

// Daily throughput for the dashboard chart (defaults to the last 14 days).
export function jobTimeseries(db, tenantId = null, { days = 14 } = {}) {
  const params = [];
  const clause = tenantClause(tenantId, params);
  const limit = Math.max(1, Math.min(90, Number(days) || 14));
  const rows = queryAll(
    db,
    `SELECT date(created_at) AS day,
            COUNT(*) AS c,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status IN ('failed', 'timed_out') THEN 1 ELSE 0 END) AS failed
       FROM jobs
      ${clause ? `${clause} AND` : "WHERE"} created_at >= date('now', ?)
      GROUP BY date(created_at) ORDER BY day ASC`,
    [...params, `-${limit} days`]
  );
  return rows.map((row) => ({
    day: row.day,
    total: row.c,
    completed: row.completed || 0,
    failed: row.failed || 0,
  }));
}
