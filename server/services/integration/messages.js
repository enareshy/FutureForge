// Provider-independent message model and queue semantics: priorities, delayed
// and scheduled delivery, idempotency, attempts, visibility/claiming, retry
// scheduling, acknowledgement/negative acknowledgement and dead-lettering.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { publicMessage } from "./repository.js";
import {
  addSecondsIso,
  computeBackoffSeconds,
  normalizePriority,
  normalizeRetryPolicy,
  safeParse,
  shouldRetry,
  toJson,
} from "./validation.js";
import { auditIntegration, log } from "./hooks.js";

export const DEFAULT_MESSAGE_QUEUE = "INTEGRATION";

function whereFrom({ tenantId, queue, status, direction, integrationId, q } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (queue) {
    clauses.push("queue = ?");
    params.push(queue);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (direction) {
    clauses.push("direction = ?");
    params.push(direction);
  }
  if (integrationId) {
    clauses.push("integration_id = ?");
    params.push(Number(integrationId));
  }
  if (q) {
    clauses.push("(LOWER(message_ref) LIKE ? OR LOWER(message_type) LIKE ? OR LOWER(correlation_id) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listMessages(db, options = {}) {
  const { page = 1, pageSize = 50 } = options;
  const { where, params } = whereFrom(options);
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_messages ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_messages ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicMessage(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getMessageRow(db, ref) {
  const id = Number(ref);
  return queryOne(db, "SELECT * FROM integration_messages WHERE id = ? OR message_ref = ?", [Number.isFinite(id) ? id : -1, String(ref)]);
}

export function getMessage(db, ref, { includePayload = false } = {}) {
  const row = getMessageRow(db, ref);
  if (!row) throw new HttpError(404, "Integration message not found");
  return publicMessage(row, { includePayload });
}

export function enqueueMessage(db, input = {}, actor = null) {
  const idempotencyKey = input.idempotency_key ?? input.idempotencyKey ?? null;
  if (idempotencyKey) {
    const existing = queryOne(db, "SELECT * FROM integration_messages WHERE idempotency_key = ?", [idempotencyKey]);
    if (existing) return { ...publicMessage(existing), duplicate: true };
  }
  const payload = input.payload ?? input.payload_json ?? null;
  const payloadText = payload === null || payload === undefined ? null : toJson(payload, null);
  const ts = nowIso();
  const policy = normalizeRetryPolicy(input.retry_policy || {});
  const result = run(
    db,
    `INSERT INTO integration_messages
      (message_ref, message_type, direction, integration_id, queue, source_system_id, target_system_id,
       correlation_id, idempotency_key, payload_ref, payload_format, payload_json, payload_size, priority, status,
       attempts, max_attempts, next_retry_at, scheduled_at, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.message_ref || `MSG-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      input.message_type || input.messageType || "integration.message",
      input.direction || "outbound",
      input.integration_id ?? null,
      input.queue || DEFAULT_MESSAGE_QUEUE,
      input.source_system_id ?? null,
      input.target_system_id ?? null,
      input.correlation_id ?? null,
      idempotencyKey,
      input.payload_ref || "",
      input.payload_format || "json",
      payloadText,
      payloadText ? Buffer.byteLength(payloadText) : 0,
      normalizePriority(input.priority),
      Number(input.max_attempts) || policy.max_attempts,
      input.next_retry_at || null,
      input.scheduled_at || null,
      input.tenant_id ?? actor?.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  return publicMessage(queryOne(db, "SELECT * FROM integration_messages WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function enqueueBatch(db, messages = [], actor = null) {
  return messages.map((message) => enqueueMessage(db, message, actor));
}

export function claimMessage(db, ref) {
  const row = getMessageRow(db, ref);
  if (!row) throw new HttpError(404, "Integration message not found");
  if (["delivered", "cancelled"].includes(row.status)) return publicMessage(row);
  run(
    db,
    "UPDATE integration_messages SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE id = ?",
    [nowIso(), row.id]
  );
  return publicMessage(queryOne(db, "SELECT * FROM integration_messages WHERE id = ?", [row.id]));
}

export function markDelivered(db, ref) {
  const row = getMessageRow(db, ref);
  if (!row) throw new HttpError(404, "Integration message not found");
  const ts = nowIso();
  run(db, "UPDATE integration_messages SET status = 'delivered', processed_at = ?, last_error = '', updated_at = ? WHERE id = ?", [ts, ts, row.id]);
  return publicMessage(queryOne(db, "SELECT * FROM integration_messages WHERE id = ?", [row.id]));
}

export function markDuplicate(db, ref, reason = "Duplicate message") {
  const row = getMessageRow(db, ref);
  if (!row) throw new HttpError(404, "Integration message not found");
  run(db, "UPDATE integration_messages SET status = 'duplicate', last_error = ?, error_category = 'duplicate', updated_at = ? WHERE id = ?", [
    reason,
    nowIso(),
    row.id,
  ]);
  return publicMessage(queryOne(db, "SELECT * FROM integration_messages WHERE id = ?", [row.id]));
}

export function cancelMessage(db, ref, actor = null, reason = "Cancelled") {
  const row = getMessageRow(db, ref);
  if (!row) throw new HttpError(404, "Integration message not found");
  run(db, "UPDATE integration_messages SET status = 'cancelled', last_error = ?, updated_at = ? WHERE id = ?", [reason, nowIso(), row.id]);
  auditIntegration(db, { actor, action: "integration.message.cancel", resourceType: "integration_message", resourceId: row.id, details: { reason } });
  return publicMessage(queryOne(db, "SELECT * FROM integration_messages WHERE id = ?", [row.id]));
}

// Negative acknowledgement. Decides between retry (with backoff) and
// dead-letter based on the retry policy, attempt count and error category.
export function markFailed(db, ref, error, { retryPolicy = null, actor = null } = {}) {
  const row = getMessageRow(db, ref);
  if (!row) throw new HttpError(404, "Integration message not found");
  const policy = normalizeRetryPolicy({ ...safeParse(retryPolicy, {}), max_attempts: row.max_attempts });
  const category = error?.category || "technical";
  const retry = shouldRetry(policy, row.attempts, category);
  const ts = nowIso();
  if (retry) {
    const delay = computeBackoffSeconds(policy, row.attempts);
    run(
      db,
      `UPDATE integration_messages SET status = 'retry', next_retry_at = ?, last_error = ?, error_category = ?, updated_at = ?
       WHERE id = ?`,
      [addSecondsIso(delay), error?.message || "Delivery failed", category, ts, row.id]
    );
  } else {
    run(
      db,
      `UPDATE integration_messages SET status = 'dead_letter', failed_at = ?, last_error = ?, error_category = ?, updated_at = ?
       WHERE id = ?`,
      [ts, error?.message || "Delivery failed", category, ts, row.id]
    );
  }
  return { message: publicMessage(queryOne(db, "SELECT * FROM integration_messages WHERE id = ?", [row.id])), retry, delay_seconds: retry ? computeBackoffSeconds(policy, row.attempts) : 0 };
}

export function requeueMessage(db, ref, { resetAttempts = false, actor = null } = {}) {
  const row = getMessageRow(db, ref);
  if (!row) throw new HttpError(404, "Integration message not found");
  run(
    db,
    `UPDATE integration_messages SET status = 'pending', next_retry_at = NULL, last_error = '', error_category = '',
       attempts = ?, updated_at = ? WHERE id = ?`,
    [resetAttempts ? 0 : row.attempts, nowIso(), row.id]
  );
  auditIntegration(db, { actor, action: "integration.message.retry", resourceType: "integration_message", resourceId: row.id, details: { reset_attempts: resetAttempts } });
  return publicMessage(queryOne(db, "SELECT * FROM integration_messages WHERE id = ?", [row.id]));
}

// Claims due messages and hands each one to `processFn`. Returns a summary so
// the worker can log progress and the tests can assert behaviour.
export async function processDueMessages(db, processFn, { limit = 20 } = {}) {
  const ts = nowIso();
  const rows = queryAll(
    db,
    `SELECT * FROM integration_messages
     WHERE status IN ('pending', 'retry')
       AND (scheduled_at IS NULL OR scheduled_at <= ?)
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
              COALESCE(next_retry_at, created_at)
     LIMIT ?`,
    [ts, ts, Number(limit)]
  );
  const summary = { claimed: 0, succeeded: 0, failed: 0, retried: 0, dead_lettered: 0 };
  for (const row of rows) {
    const claimed = claimMessage(db, row.id);
    summary.claimed += 1;
    try {
      await processFn(db, claimed);
      markDelivered(db, row.id);
      summary.succeeded += 1;
    } catch (error) {
      const outcome = markFailed(db, row.id, error, { retryPolicy: null });
      if (outcome.retry) summary.retried += 1;
      else summary.dead_lettered += 1;
      summary.failed += 1;
      log("warn", "integration.message.failed", { message_ref: row.message_ref, error: error.message });
    }
  }
  return summary;
}

export function queueDepth(db, { tenantId } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = queryAll(db, `SELECT queue, status, COUNT(*) AS count FROM integration_messages ${where} GROUP BY queue, status`, params);
  const byQueue = new Map();
  let total = 0;
  let due = 0;
  const ts = nowIso();
  for (const row of rows) {
    if (!byQueue.has(row.queue)) byQueue.set(row.queue, { queue: row.queue, total: 0, pending: 0, processing: 0, retry: 0, dead_letter: 0, delivered: 0 });
    const entry = byQueue.get(row.queue);
    entry.total += row.count;
    total += row.count;
    if (entry[row.status] !== undefined) entry[row.status] += row.count;
    if (["pending", "retry"].includes(row.status)) due += row.count;
  }
  return { total, due, queues: [...byQueue.values()] };
}

export function listQueues(db, { tenantId } = {}) {
  const depth = queueDepth(db, { tenantId });
  return depth.queues.length
    ? depth.queues
    : [{ queue: DEFAULT_MESSAGE_QUEUE, total: 0, pending: 0, processing: 0, retry: 0, dead_letter: 0, delivered: 0 }];
}
