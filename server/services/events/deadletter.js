// Dead-Letter Manager.
//
// When a delivery exhausts its retries (or fails with a permanent error) it is
// moved here with the full failure context. Operators can requeue it, ignore it
// or resolve it; every action is audited. Dead-letter rows are tenant-scoped and
// never silently dropped.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { clampInt, safeParse } from "./validation.js";
import { publicDeadLetter } from "./repository.js";
import { auditEvent } from "./hooks.js";

export function createDeadLetter(db, { delivery, error, subscription = null } = {}) {
  const existing = delivery.id ? queryOne(db, "SELECT * FROM event_dead_letters WHERE delivery_id = ? AND status = 'open'", [delivery.id]) : null;
  const ts = nowIso();
  if (existing) {
    run(
      db,
      `UPDATE event_dead_letters SET attempts = ?, error_code = ?, error_category = ?, error_message = ?, last_processing_step = ?, updated_at = ?
       WHERE id = ?`,
      [
        delivery.attempts || existing.attempts,
        error?.code || existing.error_code,
        error?.category || existing.error_category,
        error?.message || existing.error_message,
        delivery.last_processing_step || existing.last_processing_step,
        ts,
        existing.id,
      ]
    );
    return publicDeadLetter(queryOne(db, "SELECT * FROM event_dead_letters WHERE id = ?", [existing.id]), { includePayload: true });
  }
  const result = run(
    db,
    `INSERT INTO event_dead_letters
      (event_id, delivery_id, event_ref, event_type_code, event_version, subscriber, handler, subscription_id, topic_code, queue_code,
       correlation_id, causation_id, trace_id, attempts, error_code, error_category, error_message, last_processing_step, failure_at,
       payload_json, security_classification, status, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    [
      delivery.event_id ?? null,
      delivery.id ?? null,
      delivery.event_ref || "",
      delivery.event_type_code,
      delivery.event_version ?? 1,
      delivery.subscriber || "",
      delivery.handler || "",
      delivery.subscription_id ?? null,
      delivery.topic_code || "",
      delivery.queue_code || "",
      delivery.correlation_id || null,
      delivery.causation_id || null,
      delivery.trace_id || null,
      delivery.attempts || 0,
      error?.code || "",
      error?.category || "technical",
      error?.message || "",
      delivery.last_processing_step || "",
      ts,
      delivery.payload_json || "{}",
      delivery.security_classification || "internal",
      delivery.tenant_id ?? null,
      ts,
      ts,
    ]
  );
  return publicDeadLetter(queryOne(db, "SELECT * FROM event_dead_letters WHERE id = ?", [Number(result.lastInsertRowid)]), { includePayload: true });
}

export function listDeadLetters(db, { tenantId, status, eventTypeCode, handler, queueCode, q, from, to, page = 1, pageSize = 50 } = {}) {
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
  if (handler) {
    clauses.push("handler = ?");
    params.push(handler);
  }
  if (queueCode) {
    clauses.push("queue_code = ?");
    params.push(queueCode);
  }
  if (from) {
    clauses.push("failure_at >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("failure_at <= ?");
    params.push(to);
  }
  if (q) {
    clauses.push("(LOWER(event_ref) LIKE ? OR LOWER(event_type_code) LIKE ? OR LOWER(error_message) LIKE ? OR LOWER(handler) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM event_dead_letters ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM event_dead_letters ${where} ORDER BY failure_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicDeadLetter(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getDeadLetter(db, id) {
  const row = queryOne(db, "SELECT * FROM event_dead_letters WHERE id = ?", [Number(id)]);
  if (!row) throw new HttpError(404, "Dead letter not found");
  return publicDeadLetter(row, { includePayload: true });
}

// Resolves a dead letter. `retry` requeues the underlying delivery with cleared
// attempts; `ignore` and `resolve` close it without requeuing.
export function resolveDeadLetter(db, id, { action = "resolve", reason = "", actor = null } = {}) {
  const row = queryOne(db, "SELECT * FROM event_dead_letters WHERE id = ?", [Number(id)]);
  if (!row) throw new HttpError(404, "Dead letter not found");
  const ts = nowIso();
  if (action === "retry") {
    if (row.delivery_id) {
      const delivery = queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [row.delivery_id]);
      if (delivery) {
        run(
          db,
          `UPDATE event_deliveries SET status = 'pending', attempts = 0, next_retry_at = NULL, available_at = ?, locked_by = '', locked_at = NULL,
             visibility_expires_at = NULL, last_error = '', error_code = '', error_category = '', updated_at = ? WHERE id = ?`,
          [ts, ts, delivery.id]
        );
      }
    } else if (row.event_ref) {
      const delivery = queryOne(db, "SELECT * FROM event_deliveries WHERE event_ref = ? AND status = 'dead_letter' LIMIT 1", [row.event_ref]);
      if (delivery) {
        run(
          db,
          `UPDATE event_deliveries SET status = 'pending', attempts = 0, available_at = ?, last_error = '', error_code = '', error_category = '', updated_at = ? WHERE id = ?`,
          [ts, ts, delivery.id]
        );
      }
    }
    run(db, "UPDATE event_dead_letters SET status = 'retrying', resolved_by = ?, resolved_at = ?, resolution_reason = ?, updated_at = ? WHERE id = ?", [
      actor?.id ?? null,
      ts,
      reason || "requeued by operator",
      ts,
      row.id,
    ]);
    auditEvent(db, { actor, action: "event.dead_letter.retry", resourceType: "event_dead_letter", resourceId: row.id, details: { event_ref: row.event_ref, handler: row.handler, reason } });
  } else {
    const status = action === "ignore" ? "ignored" : "resolved";
    run(db, "UPDATE event_dead_letters SET status = ?, resolved_by = ?, resolved_at = ?, resolution_reason = ?, updated_at = ? WHERE id = ?", [
      status,
      actor?.id ?? null,
      ts,
      reason || "",
      ts,
      row.id,
    ]);
    auditEvent(db, { actor, action: `event.dead_letter.${status}`, resourceType: "event_dead_letter", resourceId: row.id, details: { event_ref: row.event_ref, reason } });
  }
  return publicDeadLetter(queryOne(db, "SELECT * FROM event_dead_letters WHERE id = ?", [row.id]), { includePayload: true });
}

export function deadLetterStats(db, { tenantId = null, windowHours = 168 } = {}) {
  const since = new Date(Date.now() - Number(windowHours || 168) * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const clause = tenantId !== undefined && tenantId !== null ? "AND tenant_id = ?" : "";
  const params = tenantId !== undefined && tenantId !== null ? [since, Number(tenantId)] : [since];
  const totals = queryOne(
    db,
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN status = 'retrying' THEN 1 ELSE 0 END) AS retrying,
       SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) AS resolved,
       SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END) AS ignored
     FROM event_dead_letters WHERE failure_at >= ? ${clause}`,
    params
  );
  const byCategory = queryAll(
    db,
    `SELECT error_category, COUNT(*) AS count FROM event_dead_letters WHERE failure_at >= ? ${clause} GROUP BY error_category ORDER BY count DESC`,
    params
  );
  const byHandler = queryAll(
    db,
    `SELECT COALESCE(NULLIF(handler,''),'(unbound)') AS handler, COUNT(*) AS count FROM event_dead_letters
      WHERE failure_at >= ? ${clause} GROUP BY handler ORDER BY count DESC LIMIT 10`,
    params
  );
  return {
    window_hours: Number(windowHours),
    total: totals?.total || 0,
    open: totals?.open || 0,
    retrying: totals?.retrying || 0,
    resolved: totals?.resolved || 0,
    ignored: totals?.ignored || 0,
    by_category: byCategory,
    by_handler: byHandler,
  };
}

export function purgeDeadLetters(db, { retentionDays = 90 } = {}) {
  const cutoff = new Date(Date.now() - clampInt(retentionDays, 1, 3650, 90) * 86400000).toISOString().replace("T", " ").slice(0, 19);
  const result = run(db, "DELETE FROM event_dead_letters WHERE status IN ('resolved','ignored') AND resolved_at IS NOT NULL AND resolved_at <= ?", [cutoff]);
  return { purged: Number(result.changes || 0) };
}

export function deadLetterPayload(row) {
  return safeParse(row.payload_json, {});
}
