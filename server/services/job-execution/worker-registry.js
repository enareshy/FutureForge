// Worker registry + liveness bookkeeping.
//
// Kept separate from the worker loop (worker.js) so the engine can reconcile
// worker state without importing the loop, avoiding a circular dependency.

import { queryAll, queryOne, run, nowIso, randomUuid } from "../../db.js";
import { HttpError } from "../../validation.js";
import { parseSqlTime, sqlTime } from "./timezone.js";

const OFFLINE_AFTER_SECONDS = 90;

export function generateWorkerId(prefix = "worker") {
  const host = (process.env.HOSTNAME || "local").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 24) || "local";
  return `${prefix}-${host}-${process.pid}-${randomUuid().replace(/-/g, "").slice(0, 6)}`;
}

export function publicWorker(row, { now = Date.now(), offlineAfterSeconds = OFFLINE_AFTER_SECONDS } = {}) {
  if (!row) return null;
  const heartbeat = parseSqlTime(row.last_heartbeat);
  const ageSeconds = heartbeat ? Math.max(0, Math.floor((now - heartbeat.getTime()) / 1000)) : null;
  const stale = ageSeconds === null || ageSeconds > offlineAfterSeconds;
  const status = row.status === "stopped" || row.status === "offline" ? row.status : stale ? "offline" : row.status;
  let queues = [];
  try {
    queues = JSON.parse(row.queues_json || "[]");
  } catch {
    queues = [];
  }
  let capabilities = [];
  try {
    capabilities = JSON.parse(row.capabilities_json || "[]");
  } catch {
    capabilities = [];
  }
  return {
    id: row.id,
    name: row.name || row.id,
    hostname: row.hostname || "",
    pid: row.pid ?? null,
    status,
    concurrency: row.concurrency,
    queues,
    version: row.version || "",
    capabilities,
    active_jobs: row.active_jobs,
    processed_total: row.processed_total,
    failed_total: row.failed_total,
    utilization: row.concurrency > 0 ? Math.round((row.active_jobs / row.concurrency) * 100) : 0,
    started_at: row.started_at || null,
    last_heartbeat: row.last_heartbeat || null,
    heartbeat_age_seconds: ageSeconds,
    stopped_at: row.stopped_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function registerWorker(db, { id, name = "", hostname = "", pid = null, concurrency = 1, queues = [], version = "", capabilities = [] }) {
  const workerId = id || generateWorkerId();
  const ts = nowIso();
  const existing = queryOne(db, "SELECT id FROM job_workers WHERE id = ?", [workerId]);
  if (existing) {
    run(
      db,
      `UPDATE job_workers SET name = ?, hostname = ?, pid = ?, status = 'starting', concurrency = ?,
         queues_json = ?, version = ?, capabilities_json = ?, started_at = ?, stopped_at = NULL,
         last_heartbeat = ?, updated_at = ? WHERE id = ?`,
      [name || workerId, hostname, pid, concurrency, JSON.stringify(queues), version, JSON.stringify(capabilities), ts, ts, ts, workerId]
    );
  } else {
    run(
      db,
      `INSERT INTO job_workers
         (id, name, hostname, pid, status, concurrency, queues_json, version, capabilities_json, started_at, last_heartbeat, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [workerId, name || workerId, hostname, pid, concurrency, JSON.stringify(queues), version, JSON.stringify(capabilities), ts, ts, ts, ts]
    );
  }
  return publicWorker(queryOne(db, "SELECT * FROM job_workers WHERE id = ?", [workerId]));
}

export function heartbeatWorker(db, id, { status, activeJobs, queues } = {}) {
  const fields = ["last_heartbeat = ?", "updated_at = ?"];
  const params = [nowIso(), nowIso()];
  if (status !== undefined) {
    fields.push("status = ?");
    params.push(status);
  }
  if (activeJobs !== undefined) {
    fields.push("active_jobs = ?");
    params.push(Math.max(0, Number(activeJobs) || 0));
  }
  if (queues !== undefined) {
    fields.push("queues_json = ?");
    params.push(JSON.stringify(queues));
  }
  params.push(id);
  run(db, `UPDATE job_workers SET ${fields.join(", ")} WHERE id = ?`, params);
  return publicWorker(queryOne(db, "SELECT * FROM job_workers WHERE id = ?", [id]));
}

export function recordWorkerOutcome(db, id, { success = true } = {}) {
  run(
    db,
    `UPDATE job_workers SET processed_total = processed_total + 1,
       failed_total = failed_total + ?, last_heartbeat = ?, updated_at = ? WHERE id = ?`,
    [success ? 0 : 1, nowIso(), nowIso(), id]
  );
}

export function markWorkerStopped(db, id, status = "stopped") {
  const ts = nowIso();
  run(
    db,
    "UPDATE job_workers SET status = ?, active_jobs = 0, stopped_at = ?, last_heartbeat = ?, updated_at = ? WHERE id = ?",
    [status, ts, ts, ts, id]
  );
  return publicWorker(queryOne(db, "SELECT * FROM job_workers WHERE id = ?", [id]));
}

export function getWorkerRow(db, ref) {
  const row = queryOne(db, "SELECT * FROM job_workers WHERE id = ?", [String(ref || "")]);
  if (!row) throw new HttpError(404, "Worker not found");
  return row;
}

export function listWorkers(db, query = {}) {
  const where = [];
  const params = [];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status));
  }
  if (query.queue) {
    where.push("queues_json LIKE ?");
    params.push(`%${String(query.queue)}%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = queryAll(db, `SELECT * FROM job_workers ${clause} ORDER BY last_heartbeat DESC, id ASC LIMIT 200`, params);
  const now = Date.now();
  const items = rows.map((row) => publicWorker(row, { now }));
  const online = items.filter((worker) => !["offline", "stopped"].includes(worker.status));
  return {
    items,
    total: items.length,
    summary: {
      total: items.length,
      online: online.length,
      busy: online.filter((worker) => worker.status === "busy").length,
      idle: online.filter((worker) => worker.status === "idle").length,
      capacity: online.reduce((sum, worker) => sum + worker.concurrency, 0),
      active_jobs: online.reduce((sum, worker) => sum + worker.active_jobs, 0),
    },
  };
}

// Reconciles workers whose heartbeat has lapsed to `offline` and returns them.
export function reapStaleWorkers(db, { offlineAfterSeconds = OFFLINE_AFTER_SECONDS } = {}) {
  const threshold = sqlTime(new Date(Date.now() - offlineAfterSeconds * 1000));
  const rows = queryAll(
    db,
    `SELECT * FROM job_workers
      WHERE status NOT IN ('offline', 'stopped', 'draining')
        AND (last_heartbeat IS NULL OR last_heartbeat <= ?)`,
    [threshold]
  );
  if (rows.length) {
    run(
      db,
      `UPDATE job_workers SET status = 'offline', active_jobs = 0, updated_at = ?
        WHERE status NOT IN ('offline', 'stopped', 'draining') AND (last_heartbeat IS NULL OR last_heartbeat <= ?)`,
      [nowIso(), threshold]
    );
  }
  return rows.map((row) => publicWorker(queryOne(db, "SELECT * FROM job_workers WHERE id = ?", [row.id])));
}
