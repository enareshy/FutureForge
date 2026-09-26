import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { pagination } from "../../validation.js";
import { safeParse, statusLabel } from "./validation.js";

// Immutable job history and status timeline. Every lifecycle move, control
// operation, retry and administrative action is appended here; rows are never
// updated or deleted so the timeline is a faithful audit trail. The Audit &
// History Framework remains the platform-wide record; this table is the
// job-scoped, human-readable timeline shown on the Job Details page.

export const JOB_EVENT_TYPES = [
  "created",
  "status",
  "progress",
  "log",
  "retry",
  "cancel_requested",
  "cancelled",
  "paused",
  "resumed",
  "dependency",
  "result",
  "error",
  "admin",
];

export function publicHistory(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    event_type: row.event_type || "status",
    from_status: row.from_status || "",
    to_status: row.to_status || "",
    from_status_label: row.from_status ? statusLabel(row.from_status) : "",
    to_status_label: row.to_status ? statusLabel(row.to_status) : "",
    progress: row.progress === null || row.progress === undefined ? null : row.progress,
    stage: row.stage || "",
    message: row.message || "",
    detail: safeParse(row.detail_json, {}),
    actor_id: row.actor_id ?? null,
    actor_type: row.actor_type || "system",
    source: row.source || "platform",
    created_at: row.created_at,
  };
}

// Appends a timeline entry. `detail` is stored as JSON and must never contain
// secrets; callers pass operational metadata only.
export function recordHistory(db, jobId, entry = {}) {
  const ts = entry.created_at || nowIso();
  const result = run(
    db,
    `INSERT INTO job_history
       (job_id, event_type, from_status, to_status, progress, stage, message, detail_json, actor_id, actor_type, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(jobId),
      entry.event_type || "status",
      entry.from_status || "",
      entry.to_status || "",
      entry.progress === undefined || entry.progress === null ? null : Math.round(Number(entry.progress)),
      entry.stage || "",
      String(entry.message || ""),
      JSON.stringify(entry.detail || {}),
      entry.actor_id ?? null,
      entry.actor_type || (entry.actor_id ? "user" : "system"),
      entry.source || "platform",
      ts,
    ]
  );
  return Number(result.lastInsertRowid);
}

export function listHistory(db, jobId, query = {}) {
  const { page, pageSize, offset } = pagination(query);
  const where = ["job_id = ?"];
  const params = [Number(jobId)];
  if (query.event_type || query.eventType) {
    where.push("event_type = ?");
    params.push(query.event_type || query.eventType);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM job_history ${clause}`, params).c;
  const order = query.order === "asc" ? "ASC" : "DESC";
  const items = queryAll(
    db,
    `SELECT * FROM job_history ${clause} ORDER BY id ${order} LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicHistory);
  return { items, total, page, pageSize };
}

// Chronological timeline (oldest first) used by the Job Details page.
export function jobTimeline(db, jobId) {
  return queryAll(db, "SELECT * FROM job_history WHERE job_id = ? ORDER BY id ASC", [Number(jobId)]).map(publicHistory);
}
