// Transactional Outbox.
//
// Business modules write a domain event into the outbox inside the same
// database transaction that mutates their aggregate. A background publisher
// later publishes the event and marks the row published, so a crash between
// commit and publication can never lose an event.
import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { HttpError } from "../../validation.js";
import { normalizeRetryPolicy, computeBackoffSeconds, shouldRetry, addSecondsIso, toJson, safeParse, clampInt } from "./validation.js";
import { publicOutbox } from "./repository.js";
import { auditEvent, classifyError, log } from "./hooks.js";

const DEFAULT_MAX_ATTEMPTS = 10;

// Inserts an outbox row. Safe to call inside an existing transaction; it never
// starts its own so the caller controls the commit boundary.
export function enqueueOutbox(db, input = {}) {
  const ts = nowIso();
  const retry = normalizeRetryPolicy({ max_attempts: DEFAULT_MAX_ATTEMPTS, strategy: "exponential", delay_seconds: 5 });
  const result = run(
    db,
    `INSERT INTO event_outbox
      (event_ref, event_type_code, event_version, payload_json, metadata_json, aggregate_type, aggregate_id,
       correlation_id, status, attempts, max_attempts, next_retry_at, locked_by, locked_at, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, '', NULL, ?, ?, ?)`,
    [
      input.event_ref,
      input.event_type_code,
      Number(input.event_version) || 1,
      toJson(input.payload, {}),
      toJson(input.metadata, {}),
      input.aggregate_type || null,
      input.aggregate_id === undefined || input.aggregate_id === null ? null : String(input.aggregate_id),
      input.correlation_id || null,
      retry.max_attempts,
      input.tenant_id ?? null,
      ts,
      ts,
    ]
  );
  return Number(result.lastInsertRowid);
}

// Atomically claims a batch for one worker. SQLite is single-writer, so an
// UPDATE-then-SELECT claim is sufficient without advisory locks.
export function claimOutboxRows(db, { limit = 50, worker = "event-outbox" } = {}) {
  const ts = nowIso();
  const candidate = queryAll(
    db,
    `SELECT id FROM event_outbox
     WHERE status IN ('pending','failed') AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY created_at LIMIT ?`,
    [ts, Number(limit)]
  );
  if (!candidate.length) return [];
  const ids = candidate.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  run(
    db,
    `UPDATE event_outbox SET status = 'publishing', locked_by = ?, locked_at = ?, updated_at = ?
     WHERE id IN (${placeholders}) AND status IN ('pending','failed')`,
    [worker, ts, ts, ...ids]
  );
  return queryAll(db, `SELECT * FROM event_outbox WHERE locked_by = ? AND status = 'publishing' ORDER BY created_at`, [worker]);
}

// Publishes a single claimed outbox row by routing its event. Any error is
// retried with the outbox's own policy; exhaustion moves it to dead-letter.
export async function publishOutboxRow(db, row, { route = null, worker = "event-outbox" } = {}) {
  const eventRow = queryOne(db, "SELECT * FROM event_records WHERE event_ref = ?", [row.event_ref]);
  if (!eventRow) {
    run(db, "UPDATE event_outbox SET status = 'dead_letter', last_error = ?, error_category = ?, locked_by = '', updated_at = ? WHERE id = ?", [
      "Event record is missing for outbox entry",
      "not_found",
      nowIso(),
      row.id,
    ]);
    return { status: "dead_letter", reason: "missing_event" };
  }
  try {
    const routeFn = route || (await import("./router.js")).routeEvent;
    const result = await routeFn(db, eventRow, { trigger: "outbox", event: eventRow });
    run(
      db,
      `UPDATE event_outbox SET status = 'published', published_at = ?, attempts = attempts + 1, last_error = '', error_category = '', locked_by = '', updated_at = ? WHERE id = ?`,
      [nowIso(), nowIso(), row.id]
    );
    run(db, "UPDATE event_records SET status = ?, subscriber_count = ?, updated_at = ? WHERE id = ?", [
      "published",
      result.deliveries?.length ?? 0,
      nowIso(),
      eventRow.id,
    ]);
    return { status: "published", deliveries: result.deliveries?.length ?? 0 };
  } catch (error) {
    const info = classifyError(error);
    const attempts = Number(row.attempts) + 1;
    const policy = normalizeRetryPolicy({ max_attempts: row.max_attempts || DEFAULT_MAX_ATTEMPTS, strategy: "exponential", delay_seconds: 5, jitter: true });
    if (shouldRetry(policy, attempts, info.category)) {
      const delay = computeBackoffSeconds(policy, attempts);
      run(
        db,
        `UPDATE event_outbox SET status = 'failed', attempts = ?, next_retry_at = ?, last_error = ?, error_category = ?, locked_by = '', updated_at = ? WHERE id = ?`,
        [attempts, addSecondsIso(delay), info.message, info.category, nowIso(), row.id]
      );
      return { status: "retry", attempts };
    }
    run(
      db,
      `UPDATE event_outbox SET status = 'dead_letter', attempts = ?, last_error = ?, error_category = ?, locked_by = '', updated_at = ? WHERE id = ?`,
      [attempts, info.message, info.category, nowIso(), row.id]
    );
    log("warn", "event.outbox.dead_letter", { event_ref: row.event_ref, error: info.message });
    return { status: "dead_letter", attempts };
  }
}

export async function processOutbox(db, { limit = 50, worker = "event-outbox", route = null } = {}) {
  const rows = claimOutboxRows(db, { limit, worker });
  const summary = { claimed: rows.length, published: 0, retried: 0, dead_lettered: 0 };
  for (const row of rows) {
    const result = await publishOutboxRow(db, row, { route, worker });
    if (result.status === "published") summary.published += 1;
    else if (result.status === "retry") summary.retried += 1;
    else summary.dead_lettered += 1;
  }
  return summary;
}

// Reclaims publishing rows abandoned by a crashed publisher (lease expiry).
export function reclaimStaleOutbox(db, { visibilitySeconds = 300 } = {}) {
  const cutoff = addSecondsIso(-Math.abs(Number(visibilitySeconds) || 300));
  const stale = queryAll(db, "SELECT id FROM event_outbox WHERE status = 'publishing' AND locked_at IS NOT NULL AND locked_at <= ?", [cutoff]);
  if (stale.length) {
    const placeholders = stale.map(() => "?").join(",");
    run(db, `UPDATE event_outbox SET status = 'failed', locked_by = '', last_error = 'lease expired', updated_at = ? WHERE id IN (${placeholders})`, [
      nowIso(),
      ...stale.map((r) => r.id),
    ]);
  }
  return { reclaimed: stale.length };
}

export function listOutbox(db, { tenantId, status, eventTypeCode, q, page = 1, pageSize = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (eventTypeCode) {
    clauses.push("event_type_code = ?");
    params.push(eventTypeCode);
  }
  if (q) {
    clauses.push("(LOWER(event_ref) LIKE ? OR LOWER(event_type_code) LIKE ? OR LOWER(correlation_id) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM event_outbox ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM event_outbox ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map(publicOutbox), total, page: Number(page), page_size: Number(pageSize) };
}

export function getOutboxRow(db, id) {
  return queryOne(db, "SELECT * FROM event_outbox WHERE id = ?", [Number(id)]);
}

export function retryOutbox(db, id, actor = null) {
  const row = getOutboxRow(db, id);
  if (!row) throw new HttpError(404, "Outbox entry not found");
  run(db, "UPDATE event_outbox SET status = 'pending', next_retry_at = NULL, locked_by = '', locked_at = NULL, updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  auditEvent(db, { actor, action: "event.outbox.retry", resourceType: "event_outbox", resourceId: row.id, details: { event_ref: row.event_ref } });
  return publicOutbox(queryOne(db, "SELECT * FROM event_outbox WHERE id = ?", [row.id]));
}

export function outboxStats(db, { tenantId = null } = {}) {
  const clause = tenantId !== undefined && tenantId !== null ? "WHERE tenant_id = ?" : "";
  const params = tenantId !== undefined && tenantId !== null ? [Number(tenantId)] : [];
  const rows = queryAll(db, `SELECT status, COUNT(*) AS count FROM event_outbox ${clause} GROUP BY status`, params);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  const due = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM event_outbox WHERE status IN ('pending','failed') AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ${tenantId !== undefined && tenantId !== null ? "AND tenant_id = ?" : ""}`,
    tenantId !== undefined && tenantId !== null ? [nowIso(), Number(tenantId)] : [nowIso()]
  ).c;
  return {
    total: rows.reduce((acc, r) => acc + r.count, 0),
    pending: byStatus.pending || 0,
    publishing: byStatus.publishing || 0,
    published: byStatus.published || 0,
    failed: byStatus.failed || 0,
    dead_letter: byStatus.dead_letter || 0,
    due,
    by_status: byStatus,
  };
}

// Deletes published outbox rows past their retention window. Never touches
// pending/failed rows so retained events are not silently dropped.
export function pruneOutbox(db, { retentionDays = 7 } = {}) {
  const cutoff = new Date(Date.now() - clampInt(retentionDays, 1, 3650, 7) * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const result = run(db, "DELETE FROM event_outbox WHERE status = 'published' AND published_at IS NOT NULL AND published_at <= ?", [cutoff]);
  return { pruned: Number(result.changes || 0) };
}

export { transaction };
