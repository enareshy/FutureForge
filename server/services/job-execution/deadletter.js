// Dead-letter queue management.
//
// A job lands here when it exhausts its retry policy or fails permanently
// (except cancellation). Operators can retry (requeue the same job, keeping its
// history) or discard with a note. Entries are never auto-deleted.

import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { truncate } from "../jobs/validation.js";
import { retryJob, getJobRow } from "../jobs/jobs.js";
import { classifyError, categoryLabel } from "./errors.js";
import { recordHistory } from "../jobs/history.js";

export function recordDeadLetter(db, { job, queue, category, reason, errorCode = "", errorMessage = "", payload = null }) {
  const existing = queryOne(db, "SELECT id FROM job_dead_letters WHERE job_id = ? AND status = 'open'", [job.id]);
  const ts = nowIso();
  if (existing) {
    run(
      db,
      "UPDATE job_dead_letters SET reason = ?, category = ?, attempts = ?, error_code = ?, error_message = ?, updated_at = ? WHERE id = ?",
      [truncate(reason, 500), category, Number(job.attempts) || 0, errorCode, truncate(errorMessage, 2000), ts, existing.id]
    );
    return existing.id;
  }
  const result = run(
    db,
    `INSERT INTO job_dead_letters
       (job_id, queue, job_type_code, tenant_id, reason, category, attempts, error_code, error_message, payload_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    [
      job.id,
      job.queue || "",
      job.job_type_code || "",
      job.tenant_id ?? null,
      truncate(reason, 500),
      category,
      Number(job.attempts) || 0,
      truncate(errorCode, 100),
      truncate(errorMessage, 2000),
      JSON.stringify(payload ?? { input: job.input_json ? safeJson(job.input_json) : {} }),
      ts,
      ts,
    ]
  );
  run(db, "UPDATE jobs SET dead_lettered_at = ?, updated_at = ? WHERE id = ?", [ts, ts, job.id]);
  return Number(result.lastInsertRowid);
}

function safeJson(value) {
  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return {};
  }
}

export function publicDeadLetter(row) {
  if (!row) return null;
  return {
    id: row.id,
    job_id: row.job_id,
    job_ref: row.job_ref || "",
    queue: row.queue || "",
    job_type_code: row.job_type_code || "",
    tenant_id: row.tenant_id ?? null,
    reason: row.reason || "",
    category: row.category || "unknown",
    category_label: categoryLabel(row.category),
    attempts: row.attempts,
    error_code: row.error_code || "",
    error_message: row.error_message || "",
    payload: safeJson(row.payload_json),
    status: row.status,
    requeued_job_id: row.requeued_job_id ?? null,
    resolved_by: row.resolved_by ?? null,
    resolved_at: row.resolved_at || null,
    resolution_note: row.resolution_note || "",
    job_status: row.job_status || "",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getDeadLetterRow(db, id) {
  const row = queryOne(
    db,
    `SELECT d.*, j.job_ref, j.status AS job_status FROM job_dead_letters d
       LEFT JOIN jobs j ON j.id = d.job_id WHERE d.id = ?`,
    [Number(id) || -1]
  );
  if (!row) throw new HttpError(404, "Dead-letter entry not found");
  return row;
}

export function listDeadLetters(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  const scoped = tenantId ?? (query.tenantId !== undefined && query.tenantId !== "" ? Number(query.tenantId) : null);
  if (scoped !== null && scoped !== undefined) {
    where.push("COALESCE(d.tenant_id, 0) = ?");
    params.push(Number(scoped));
  }
  if (query.status) {
    where.push("d.status = ?");
    params.push(String(query.status));
  }
  if (query.queue) {
    where.push("d.queue = ?");
    params.push(String(query.queue));
  }
  if (query.category) {
    where.push("d.category = ?");
    params.push(String(query.category));
  }
  if (query.job_type_code || query.type) {
    where.push("d.job_type_code = ?");
    params.push(String(query.job_type_code || query.type).toUpperCase());
  }
  if (query.q) {
    const like = `%${query.q}%`;
    where.push("(j.job_ref LIKE ? OR d.error_message LIKE ? OR d.reason LIKE ?)");
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM job_dead_letters d LEFT JOIN jobs j ON j.id = d.job_id ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT d.*, j.job_ref, j.status AS job_status FROM job_dead_letters d
       LEFT JOIN jobs j ON j.id = d.job_id
       ${clause}
       ORDER BY CASE d.status WHEN 'open' THEN 0 ELSE 1 END, d.created_at DESC, d.id DESC
       LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicDeadLetter);

  const byCategory = queryAll(
    db,
    `SELECT category, COUNT(*) AS c FROM job_dead_letters d
       ${scoped !== null && scoped !== undefined ? "WHERE COALESCE(d.tenant_id, 0) = ?" : ""}
       GROUP BY category ORDER BY c DESC`,
    scoped !== null && scoped !== undefined ? [Number(scoped)] : []
  );
  const openCount = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM job_dead_letters d WHERE d.status = 'open' ${scoped !== null && scoped !== undefined ? "AND COALESCE(d.tenant_id, 0) = ?" : ""}`,
    scoped !== null && scoped !== undefined ? [Number(scoped)] : []
  ).c;
  return { items, total, page, pageSize, open_count: openCount, by_category: byCategory };
}

export function requeueDeadLetter(db, id, { actor = null, ip = null, note = "" } = {}) {
  const row = getDeadLetterRow(db, id);
  if (row.status !== "open") {
    throw new HttpError(409, `Dead-letter entry is already ${row.status}`);
  }
  const jobRow = getJobRow(db, row.job_id);
  const result = retryJob(db, jobRow.id, { actor, ip });
  const ts = nowIso();
  run(
    db,
    `UPDATE job_dead_letters SET status = 'requeued', requeued_job_id = ?, resolved_by = ?, resolved_at = ?,
       resolution_note = ?, updated_at = ? WHERE id = ?`,
    [result.job?.id ?? jobRow.id, actor?.id ?? null, ts, truncate(note, 1000), ts, row.id]
  );
  run(db, "UPDATE jobs SET dead_lettered_at = NULL, updated_at = ? WHERE id = ?", [ts, jobRow.id]);
  recordHistory(db, jobRow.id, {
    event_type: "retry",
    from_status: jobRow.status,
    to_status: "queued",
    message: note || "Requeued from dead-letter queue",
    detail: { dead_letter_id: row.id, actor_id: actor?.id ?? null },
    actor_id: actor?.id ?? null,
    actor_type: actor ? "user" : "engine",
    source: "platform",
  });
  return { requeued: true, dead_letter: publicDeadLetter(getDeadLetterRow(db, row.id)), job: result.job };
}

export function discardDeadLetter(db, id, { actor = null, note = "" } = {}) {
  const row = getDeadLetterRow(db, id);
  if (row.status !== "open") {
    throw new HttpError(409, `Dead-letter entry is already ${row.status}`);
  }
  const ts = nowIso();
  run(
    db,
    `UPDATE job_dead_letters SET status = 'discarded', resolved_by = ?, resolved_at = ?, resolution_note = ?, updated_at = ?
     WHERE id = ?`,
    [actor?.id ?? null, ts, truncate(note, 1000), ts, row.id]
  );
  return { discarded: true, dead_letter: publicDeadLetter(getDeadLetterRow(db, row.id)) };
}

export function classifyForDeadLetter(error) {
  const classified = classifyError(error);
  return {
    category: classified.category,
    errorCode: classified.code,
    errorMessage: classified.message,
    reason: categoryLabel(classified.category),
  };
}
