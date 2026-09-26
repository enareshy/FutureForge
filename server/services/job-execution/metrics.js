// Execution metrics + health aggregation for the engine dashboard.

import { queryAll, queryOne, nowIso } from "../../db.js";
import { JOB_STATUSES, TERMINAL_STATUSES } from "../jobs/validation.js";
import { queueLoad, publicQueue } from "./queues.js";
import { listWorkers } from "./worker-registry.js";
import { listHandlers } from "./handlers.js";
import { getLock } from "./locks.js";

function scopeClause(tenantId, column = "tenant_id") {
  if (tenantId === null || tenantId === undefined) return { clause: "", params: [] };
  return { clause: `WHERE COALESCE(${column}, 0) = ?`, params: [Number(tenantId)] };
}

export function jobStatusCounts(db, tenantId = null) {
  const { clause, params } = scopeClause(tenantId);
  const rows = queryAll(db, `SELECT status, COUNT(*) AS c FROM jobs ${clause} GROUP BY status`, params);
  const counts = Object.fromEntries(JOB_STATUSES.map((status) => [status, 0]));
  for (const row of rows) counts[row.status] = row.c;
  return counts;
}

export function executionMetrics(db, tenantId = null) {
  const { clause, params } = scopeClause(tenantId);
  const counts = jobStatusCounts(db, tenantId);
  const load = queueLoad(db);

  const queues = queryAll(db, "SELECT * FROM job_queues ORDER BY priority DESC, code ASC").map((row) =>
    publicQueue(row, load.get(row.code))
  );

  const activeStatuses = ["queued", "scheduled", "retrying"];
  const queued = activeStatuses.reduce((sum, status) => sum + (counts[status] || 0), 0);
  const running = (counts.running || 0) + (counts.cancel_requested || 0);
  const waiting = counts.waiting_for_dependency || 0;

  const completedHour = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM jobs WHERE status = 'completed' AND completed_at >= datetime('now', '-1 hour') ${
      tenantId === null || tenantId === undefined ? "" : "AND COALESCE(tenant_id, 0) = ?"
    }`,
    tenantId === null || tenantId === undefined ? [] : [Number(tenantId)]
  ).c;
  const failedHour = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM jobs WHERE status = 'failed' AND completed_at >= datetime('now', '-1 hour') ${
      tenantId === null || tenantId === undefined ? "" : "AND COALESCE(tenant_id, 0) = ?"
    }`,
    tenantId === null || tenantId === undefined ? [] : [Number(tenantId)]
  ).c;
  const completedDay = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM jobs WHERE status = 'completed' AND completed_at >= datetime('now', '-1 day') ${
      tenantId === null || tenantId === undefined ? "" : "AND COALESCE(tenant_id, 0) = ?"
    }`,
    tenantId === null || tenantId === undefined ? [] : [Number(tenantId)]
  ).c;
  const failedDay = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM jobs WHERE status IN ('failed', 'timed_out') AND completed_at >= datetime('now', '-1 day') ${
      tenantId === null || tenantId === undefined ? "" : "AND COALESCE(tenant_id, 0) = ?"
    }`,
    tenantId === null || tenantId === undefined ? [] : [Number(tenantId)]
  ).c;

  const durationRow = queryOne(
    db,
    `SELECT AVG(e.duration_ms) AS avg_ms, COUNT(*) AS c
       FROM job_executions e JOIN jobs j ON j.id = e.job_id
      WHERE e.status = 'completed' AND e.finished_at >= datetime('now', '-1 day') ${
        tenantId === null || tenantId === undefined ? "" : "AND COALESCE(j.tenant_id, 0) = ?"
      }`,
    tenantId === null || tenantId === undefined ? [] : [Number(tenantId)]
  );
  const retryRow = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM jobs WHERE retry_count > 0 AND created_at >= datetime('now', '-1 day') ${
      tenantId === null || tenantId === undefined ? "" : "AND COALESCE(tenant_id, 0) = ?"
    }`,
    tenantId === null || tenantId === undefined ? [] : [Number(tenantId)]
  );

  const deadLetters = queryAll(
    db,
    `SELECT category, COUNT(*) AS c FROM job_dead_letters WHERE status = 'open' ${
      tenantId === null || tenantId === undefined ? "" : "AND COALESCE(tenant_id, 0) = ?"
    } GROUP BY category ORDER BY c DESC`,
    tenantId === null || tenantId === undefined ? [] : [Number(tenantId)]
  );
  const openDeadLetters = deadLetters.reduce((sum, row) => sum + row.c, 0);

  const schedulesDue = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM job_schedules WHERE enabled = 1 AND status = 'active' AND next_run_at IS NOT NULL ${
      tenantId === null || tenantId === undefined ? "" : "AND COALESCE(tenant_id, 0) = ?"
    }`,
    tenantId === null || tenantId === undefined ? [] : [Number(tenantId)]
  ).c;

  const totalFinished = completedDay + failedDay;
  const workers = listWorkers(db);

  const capacity = queues.reduce((sum, queue) => sum + (queue.enabled ? queue.max_concurrency : 0), 0);
  const utilization = capacity > 0 ? Math.round((running / capacity) * 100) : 0;

  return {
    generated_at: nowIso(),
    queues,
    queue_count: queues.length,
    totals: {
      ...counts,
      queued,
      running,
      waiting_for_dependency: waiting,
      open_dead_letters: openDeadLetters,
      active: queued + running + waiting,
    },
    throughput: {
      completed_last_hour: completedHour,
      failed_last_hour: failedHour,
      completed_last_day: completedDay,
      failed_last_day: failedDay,
      retried_last_day: retryRow.c,
      failure_rate: totalFinished > 0 ? Math.round((failedDay / totalFinished) * 100) : 0,
    },
    performance: {
      average_duration_ms: Math.round(durationRow.avg_ms || 0),
      completed_samples: durationRow.c,
      capacity,
      utilization,
    },
    workers: workers.summary,
    worker_details: workers.items,
    dead_letters: { open: openDeadLetters, by_category: deadLetters },
    schedules: { due_active: schedulesDue },
    handlers: listHandlers().map((handler) => handler.code),
    leader: getLock(db, "engine:scheduler"),
  };
}
