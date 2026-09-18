// Async Event Consumer.
//
// The consumer is the durable worker side of the framework. It atomically
// claims due deliveries, enforces ordering, invokes the bound handler with a
// timeout and records an attempt for every run. Failures are classified:
// retryable errors are rescheduled with policy-driven backoff, permanent
// failures move to the dead-letter store. Every handler invocation carries the
// delivery idempotency key so at-least-once delivery is safe.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import {
  safeParse,
  addSecondsIso,
  computeBackoffSeconds,
  shouldRetry,
  normalizeRetryPolicy,
  DELIVERY_TERMINAL,
} from "./validation.js";
import { publicAttempt, publicDelivery } from "./repository.js";
import { invokeHandler, hasHandler } from "./handlers.js";
import { getSubscriptionRow } from "./subscriptions.js";
import { orderingDecision } from "./ordering.js";
import { createDeadLetter } from "./deadletter.js";
import { auditEvent, classifyError, log } from "./hooks.js";

const DEFAULT_WORKER = "event-consumer";

function withTimeout(promise, seconds) {
  const limit = Number(seconds || 0);
  if (!limit) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const error = new Error(`Handler timed out after ${limit}s`);
      error.category = "timeout";
      error.code = "processing_timeout";
      setTimeout(() => reject(error), limit * 1000).unref?.();
    }),
  ]);
}

// Atomically claims a batch of due deliveries. Priority is respected (critical
// first) and the claim sets a visibility lease so a crashed worker's work is
// reclaimed by releaseStaleDeliveries().
export function claimDeliveries(db, { limit = 25, worker = DEFAULT_WORKER, queueCode = null, consumerGroup = null, tenantId = null } = {}) {
  const ts = nowIso();
  const clauses = ["status IN ('pending','retry')", "(available_at IS NULL OR available_at <= ?)", "(visibility_expires_at IS NULL OR visibility_expires_at <= ?)"];
  const params = [ts, ts];
  if (queueCode) {
    clauses.push("queue_code = ?");
    params.push(queueCode);
  }
  if (consumerGroup) {
    clauses.push("consumer_group = ?");
    params.push(consumerGroup);
  }
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  const candidate = queryAll(
    db,
    `SELECT id FROM event_deliveries WHERE ${clauses.join(" AND ")}
     ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
              available_at, created_at, id
     LIMIT ?`,
    [...params, Number(limit)]
  );
  if (!candidate.length) return [];
  const ids = candidate.map((r) => r.id);
  const placeholders = ids.map(() => "?").join(",");
  run(
    db,
    `UPDATE event_deliveries
       SET status = 'processing', locked_by = ?, locked_at = ?, visibility_expires_at = ?, updated_at = ?
     WHERE id IN (${placeholders}) AND status IN ('pending','retry')`,
    [worker, ts, addSecondsIso(300), ts, ...ids]
  );
  return queryAll(db, `SELECT * FROM event_deliveries WHERE locked_by = ? AND status = 'processing' ORDER BY id`, [worker]);
}

// Reclaims deliveries whose worker lease expired (crashed consumer).
export function releaseStaleDeliveries(db, { limit = 200 } = {}) {
  const ts = nowIso();
  const stale = queryAll(
    db,
    `SELECT id FROM event_deliveries WHERE status = 'processing' AND visibility_expires_at IS NOT NULL AND visibility_expires_at <= ? LIMIT ?`,
    [ts, Number(limit)]
  );
  if (stale.length) {
    const placeholders = stale.map(() => "?").join(",");
    run(
      db,
      `UPDATE event_deliveries SET status = 'retry', locked_by = '', locked_at = NULL, visibility_expires_at = NULL,
         last_error = 'worker lease expired', error_category = 'timeout', available_at = ?, updated_at = ?
       WHERE id IN (${placeholders})`,
      [ts, ts, ...stale.map((r) => r.id)]
    );
  }
  return { reclaimed: stale.length };
}

function recordAttempt(db, delivery, { status, step = "", durationMs = null, error = null, startedAt, finishedAt = null }) {
  const info = error ? classifyError(error) : null;
  const result = run(
    db,
    `INSERT INTO event_delivery_attempts
      (delivery_id, event_id, attempt, status, step, duration_ms, error_code, error_category, error_message, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      delivery.id,
      delivery.event_id ?? null,
      Number(delivery.attempts) + 1,
      status,
      step,
      durationMs,
      info?.code || "",
      info?.category || "",
      info?.message || "",
      startedAt,
      finishedAt,
      nowIso(),
    ]
  );
  return Number(result.lastInsertRowid);
}

// Attempts a single delivery. Returns a small result object the caller can
// aggregate; it never throws for handler failures (they become retry/dead-letter
// transitions) so a single poison message cannot stop the batch.
export async function processDelivery(db, delivery, { worker = DEFAULT_WORKER, ignoreIdempotency = false, timeoutSeconds = 0 } = {}) {
  const startedAt = nowIso();
  const startMs = Date.now();
  const subscription = delivery.subscription_id ? getSubscriptionRow(db, delivery.subscription_id) : null;
  const retryPolicy = normalizeRetryPolicy({
    ...(subscription ? safeParse(subscription.retry_policy_json, {}) : {}),
    max_attempts: delivery.max_attempts || (subscription ? undefined : 5),
  });
  const timeout = timeoutSeconds || retryPolicy.timeout_seconds || (subscription?.ordering_required ? 0 : 0);

  // Idempotency: a message whose key was already consumed is marked duplicate
  // instead of invoking the handler again. Replay passes ignoreIdempotency.
  if (!ignoreIdempotency && delivery.idempotency_key) {
    const consumed = queryOne(db, "SELECT * FROM event_idempotency WHERE key = ?", [delivery.idempotency_key]);
    if (consumed && Number(consumed.delivery_id) !== Number(delivery.id)) {
      run(db, "UPDATE event_deliveries SET status = 'duplicate', last_error = 'duplicate message', updated_at = ? WHERE id = ?", [nowIso(), delivery.id]);
      recordAttempt(db, delivery, { status: "duplicate", step: "idempotency", startedAt, finishedAt: nowIso() });
      return { status: "duplicate", delivery_id: delivery.id };
    }
  }

  // Ordering: if an earlier sequence in the same partition is still open, buffer
  // this delivery as out_of_order until the gap fills or the timeout elapses.
  const orderingRequired = Boolean(subscription?.ordering_required) || (delivery.partition_key && delivery.sequence_number !== null && delivery.sequence_number !== undefined);
  if (orderingRequired && !ignoreIdempotency) {
    const decision = orderingDecision(db, delivery, { timeoutSeconds: subscription?.ordering_timeout_seconds || 30 });
    if (!decision.ok) {
      run(
        db,
        `UPDATE event_deliveries SET status = 'out_of_order', attempts = attempts, last_processing_step = 'ordering',
           last_error = ?, error_category = 'ordering', available_at = ?, updated_at = ? WHERE id = ?`,
        [decision.reason, decision.available_at, nowIso(), delivery.id]
      );
      recordAttempt(db, delivery, { status: "out_of_order", step: "ordering", startedAt, finishedAt: nowIso() });
      return { status: "out_of_order", delivery_id: delivery.id, blocking: decision.blocking?.id ?? null };
    }
  }

  const eventRow = delivery.event_id ? queryOne(db, "SELECT * FROM event_records WHERE id = ?", [delivery.event_id]) : null;
  const event = eventRow
    ? {
        ...eventRow,
        payload: safeParse(eventRow.payload_json, {}),
        metadata: safeParse(eventRow.metadata_json, {}),
      }
    : {
        event_ref: delivery.event_ref,
        event_type_code: delivery.event_type_code,
        event_version: delivery.event_version,
        payload_json: delivery.payload_json,
        payload: safeParse(delivery.payload_json, {}),
        metadata: {},
        source_module: null,
        tenant_id: delivery.tenant_id,
      };
  const payload = safeParse(delivery.payload_json, {});

  // Unbound deliveries (no handler) are recorded as ignored rather than failing.
  if (!delivery.handler) {
    run(db, "UPDATE event_deliveries SET status = 'ignored', last_processing_step = 'unbound', delivered_at = ?, updated_at = ? WHERE id = ?", [
      nowIso(),
      nowIso(),
      delivery.id,
    ]);
    recordAttempt(db, delivery, { status: "ignored", step: "unbound", startedAt, finishedAt: nowIso() });
    return { status: "ignored", delivery_id: delivery.id };
  }

  try {
    const context = {
      event,
      payload,
      delivery,
      subscription: subscription ? { ...subscription, filter: safeParse(subscription.filter_json, {}) } : null,
      worker,
    };
    const result = await withTimeout(Promise.resolve(invokeHandler(db, delivery.handler, context)), timeout);
    const durationMs = Date.now() - startMs;
    const finish = nowIso();
    const attempts = Number(delivery.attempts) + 1;
    run(
      db,
      `UPDATE event_deliveries SET status = 'delivered', attempts = ?, delivered_at = ?, duration_ms = ?, locked_by = '', locked_at = NULL,
         visibility_expires_at = NULL, last_error = '', error_code = '', error_category = '', last_processing_step = 'completed', updated_at = ?
       WHERE id = ?`,
      [attempts, finish, durationMs, finish, delivery.id]
    );
    if (delivery.idempotency_key) {
      run(db, "INSERT OR IGNORE INTO event_idempotency (key, delivery_id, event_id, consumer, created_at) VALUES (?, ?, ?, ?, ?)", [
        delivery.idempotency_key,
        delivery.id,
        delivery.event_id ?? null,
        delivery.handler,
        finish,
      ]);
    }
    recordAttempt(db, delivery, { status: "delivered", step: "handler", durationMs, startedAt, finishedAt: finish });
    if (delivery.event_id) {
      run(db, "UPDATE event_records SET delivered_count = delivered_count + 1, updated_at = ? WHERE id = ?", [finish, delivery.event_id]);
    }
    log("info", "event.delivery.delivered", { delivery_id: delivery.id, handler: delivery.handler, event_ref: delivery.event_ref, duration_ms: durationMs });
    return { status: "delivered", delivery_id: delivery.id, duration_ms: durationMs, result };
  } catch (error) {
    const info = classifyError(error);
    const durationMs = Date.now() - startMs;
    const finish = nowIso();
    const attempts = Number(delivery.attempts) + 1;
    recordAttempt(db, delivery, { status: "failed", step: "handler", durationMs, error, startedAt, finishedAt: finish });
    const canRetry = shouldRetry(retryPolicy, attempts, info.category);
    if (canRetry) {
      const delay = computeBackoffSeconds(retryPolicy, attempts);
      run(
        db,
        `UPDATE event_deliveries SET status = 'retry', attempts = ?, next_retry_at = ?, available_at = ?, last_error = ?, error_code = ?,
           error_category = ?, last_processing_step = 'handler', locked_by = '', locked_at = NULL, visibility_expires_at = NULL, updated_at = ?
         WHERE id = ?`,
        [attempts, addSecondsIso(delay), addSecondsIso(delay), info.message, info.code, info.category, finish, delivery.id]
      );
      log("warn", "event.delivery.retry", { delivery_id: delivery.id, handler: delivery.handler, attempts, category: info.category, delay_seconds: delay });
      return { status: "retry", delivery_id: delivery.id, attempts, error: info };
    }
    run(
      db,
      `UPDATE event_deliveries SET status = 'dead_letter', attempts = ?, last_error = ?, error_code = ?, error_category = ?,
         last_processing_step = 'handler', locked_by = '', locked_at = NULL, visibility_expires_at = NULL, updated_at = ?
       WHERE id = ?`,
      [attempts, info.message, info.code, info.category, finish, delivery.id]
    );
    if (delivery.event_id) {
      run(db, "UPDATE event_records SET failed_count = failed_count + 1, updated_at = ? WHERE id = ?", [finish, delivery.event_id]);
    }
    let deadLetter = null;
    const deadLetterEnabled = subscription ? safeParse(subscription.dead_letter_policy_json, { enabled: true }).enabled !== false : true;
    if (deadLetterEnabled) {
      deadLetter = createDeadLetter(db, { delivery: { ...delivery, attempts }, error: info, subscription });
    }
    auditEvent(db, {
      actor: null,
      action: "event.delivery.dead_letter",
      resourceType: "event_delivery",
      resourceId: delivery.id,
      status: "failure",
      category: "data",
      errorMessage: info.message,
      details: { event_ref: delivery.event_ref, handler: delivery.handler, category: info.category },
      correlation: delivery.correlation_id,
    });
    log("error", "event.delivery.dead_letter", { delivery_id: delivery.id, handler: delivery.handler, category: info.category, error: info.message });
    return { status: "dead_letter", delivery_id: delivery.id, attempts, error: info, dead_letter_id: deadLetter?.id ?? null };
  }
}

// Claims and processes a batch. `queueCode` / `consumerGroup` let a worker own a
// slice of the topology; `max` bounds the batch size. Concurrency stays 1 per
// partition when ordering is required because deliveries are processed in
// sequence; independent partitions are still drained in one pass.
export async function processDeliveries(db, { limit = 25, worker = DEFAULT_WORKER, queueCode = null, consumerGroup = null, tenantId = null, ignoreIdempotency = false } = {}) {
  const deliveries = claimDeliveries(db, { limit, worker, queueCode, consumerGroup, tenantId });
  const summary = { claimed: deliveries.length, delivered: 0, retried: 0, dead_lettered: 0, buffered: 0, ignored: 0, duplicated: 0, failures: [] };
  for (const delivery of deliveries) {
    const result = await processDelivery(db, delivery, { worker, ignoreIdempotency });
    switch (result.status) {
      case "delivered":
        summary.delivered += 1;
        break;
      case "retry":
        summary.retried += 1;
        break;
      case "dead_letter":
        summary.dead_lettered += 1;
        summary.failures.push({ delivery_id: delivery.id, error: result.error });
        break;
      case "out_of_order":
        summary.buffered += 1;
        break;
      case "ignored":
        summary.ignored += 1;
        break;
      case "duplicate":
        summary.duplicated += 1;
        break;
      default:
        break;
    }
  }
  return summary;
}

// Manual operations exposed through the API / monitoring console.
export function retryDelivery(db, id, actor = null) {
  const row = queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [Number(id)]);
  if (!row) throw new HttpError(404, "Delivery not found");
  if (row.status === "delivered") {
    throw new HttpError(409, "Delivery already succeeded; use replay to re-deliver");
  }
  run(
    db,
    `UPDATE event_deliveries SET status = 'pending', attempts = 0, next_retry_at = NULL, available_at = ?, locked_by = '', locked_at = NULL,
       visibility_expires_at = NULL, last_error = '', error_code = '', error_category = '', updated_at = ? WHERE id = ?`,
    [nowIso(), nowIso(), row.id]
  );
  auditEvent(db, { actor, action: "event.delivery.retry", resourceType: "event_delivery", resourceId: row.id, details: { event_ref: row.event_ref, handler: row.handler } });
  return publicDelivery(queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [row.id]));
}

export function skipDelivery(db, id, actor = null, reason = "") {
  const row = queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [Number(id)]);
  if (!row) throw new HttpError(404, "Delivery not found");
  if (DELIVERY_TERMINAL.includes(row.status) && row.status !== "failed") {
    throw new HttpError(409, `Delivery is already ${row.status}`);
  }
  run(db, "UPDATE event_deliveries SET status = 'skipped', last_error = ?, updated_at = ? WHERE id = ?", [reason || "skipped by operator", nowIso(), row.id]);
  auditEvent(db, { actor, action: "event.delivery.skip", resourceType: "event_delivery", resourceId: row.id, details: { event_ref: row.event_ref, reason } });
  return publicDelivery(queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [row.id]));
}

export function listAttempts(db, deliveryId) {
  const rows = queryAll(db, "SELECT * FROM event_delivery_attempts WHERE delivery_id = ? ORDER BY id DESC", [Number(deliveryId)]);
  return rows.map(publicAttempt);
}

export function consumerStats(db, { tenantId = null, windowHours = 24 } = {}) {
  const since = new Date(Date.now() - Number(windowHours || 24) * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const clause = tenantId !== undefined && tenantId !== null ? "AND tenant_id = ?" : "";
  const params = tenantId !== undefined && tenantId !== null ? [since, Number(tenantId)] : [since];
  const totals = queryOne(
    db,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retrying,
       SUM(CASE WHEN status IN ('failed','dead_letter') THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'duplicate' THEN 1 ELSE 0 END) AS duplicate,
       SUM(CASE WHEN status = 'out_of_order' THEN 1 ELSE 0 END) AS out_of_order,
       SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
       AVG(duration_ms) AS avg_duration_ms
     FROM event_deliveries WHERE updated_at >= ? ${clause}`,
    params
  );
  const registered = queryAll(db, "SELECT DISTINCT handler FROM event_deliveries WHERE handler != ''").map((r) => r.handler);
  return {
    window_hours: Number(windowHours),
    total: totals?.total || 0,
    delivered: totals?.delivered || 0,
    retrying: totals?.retrying || 0,
    failed: totals?.failed || 0,
    duplicate: totals?.duplicate || 0,
    out_of_order: totals?.out_of_order || 0,
    processing: totals?.processing || 0,
    avg_duration_ms: totals?.avg_duration_ms ? Math.round(totals.avg_duration_ms) : null,
    handlers_seen: registered.length,
    handlers_missing: registered.filter((h) => !hasHandler(h)),
  };
}

export function consumerLagByGroup(db, { tenantId = null } = {}) {
  const clause = tenantId !== undefined && tenantId !== null ? "AND tenant_id = ?" : "";
  const params = tenantId !== undefined && tenantId !== null ? [Number(tenantId)] : [];
  return queryAll(
    db,
    `SELECT
       COALESCE(NULLIF(consumer_group,''),'(default)') AS consumer_group,
       COUNT(*) AS total,
       SUM(CASE WHEN status IN ('pending','retry','out_of_order') THEN 1 ELSE 0 END) AS backlog,
       SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN status IN ('failed','dead_letter') THEN 1 ELSE 0 END) AS failed
     FROM event_deliveries WHERE 1=1 ${clause}
     GROUP BY consumer_group ORDER BY backlog DESC`,
    params
  );
}
