import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { pagination } from "../../validation.js";
import { homeTenantId } from "../tenants.js";
import { safeParse } from "./validation.js";
import { providerForChannel, providerConfig, providerSecrets } from "./providers.js";
import { ingestNotification } from "../delivery/requests.js";

// Channel provider abstraction and delivery queue. External channels are
// processed asynchronously by `processQueue`, which is pull-based (invoked by
// the scheduler endpoint or an operator) so the platform keeps no in-process
// timers. Failures are retried with exponential backoff and eventually moved to
// the dead-letter state. No credentials are ever written to the history tables.

export const BACKOFF_BASE_SECONDS = 30;
export const MAX_ATTEMPTS = 5;

function addSeconds(seconds) {
  const date = new Date();
  date.setSeconds(date.getSeconds() + seconds);
  return date.toISOString().replace("T", " ").slice(0, 19);
}

// In-app delivery is immediate and stored; it doubles as the inbox record.
function deliverInApp(_db, context) {
  return { ok: true, response: { channel: "in_app", stored: true }, delivered: true, provider: "store" };
}

// Email is delegated to the configured provider. The built-in transport stores
// the delivery and records the provider response; plugging in SMTP/Graph just
// replaces this handler without touching business logic.
function deliverEmail(_db, context) {
  const { provider } = context;
  const config = provider?.row ? providerConfig(provider.row) : {};
  const secrets = provider?.row ? providerSecrets(provider.row) : {};
  if (provider?.type === "smtp" && !config.host) {
    return { ok: false, error: "SMTP host is not configured", response: {} };
  }
  return {
    ok: true,
    response: {
      channel: "email",
      provider: provider?.code || "store",
      to: context.notification.recipient_address || "",
      from: config.from_email || "no-reply@helix.example.com",
      has_credentials: Boolean(secrets.password || secrets.api_key || secrets.client_secret),
      queued: true,
    },
    delivered: false,
    provider: provider?.code || "store",
  };
}

function deliverWebhook(_db, context) {
  const config = context.provider?.row ? providerConfig(context.provider.row) : {};
  if (!config.webhook_url) return { ok: false, error: "Webhook URL is not configured", response: {} };
  return { ok: true, response: { channel: "webhook", url: config.webhook_url, accepted: true }, delivered: false, provider: context.provider?.code || "webhook" };
}

function deliverGeneric(channel) {
  return () => ({ ok: true, response: { channel, stored: true }, delivered: false, provider: "store" });
}

const HANDLERS = {
  in_app: deliverInApp,
  email: deliverEmail,
  webhook: deliverWebhook,
  sms: deliverGeneric("sms"),
  teams: deliverGeneric("teams"),
  slack: deliverGeneric("slack"),
  push: deliverGeneric("push"),
};

export function handlerFor(channel) {
  return HANDLERS[channel] || deliverGeneric(channel);
}

// Queues a delivery for a notification. `delaySeconds` implements the rule's
// delivery delay / digest scheduling.
export function enqueue(db, notification, { delaySeconds = 0, providerCode = null } = {}) {
  const provider = providerCode
    ? { code: providerCode, type: providerCode }
    : providerForChannel(db, notification.channel);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO notification_deliveries
      (notification_id, channel, provider_code, status, attempt, max_attempts, scheduled_at, tenant_id, created_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
    [
      notification.id,
      notification.channel,
      provider.code || "store",
      MAX_ATTEMPTS,
      delaySeconds > 0 ? addSeconds(delaySeconds) : ts,
      notification.tenant_id ?? null,
      ts,
    ]
  );
  run(db, "UPDATE notifications SET status = 'queued', updated_at = ? WHERE id = ?", [ts, notification.id]);
  return queryOne(db, "SELECT * FROM notification_deliveries WHERE id = ?", [result.lastInsertRowid]);
}

// Creates a notification for a concrete recipient without going through rule
// matching. Used by template test-sends, reminders/escalations and simple
// integrations that already know the target user. Returns the notification id or
// null when it cannot be delivered.
export function deliverDirect(db, {
  user,
  tenantId = null,
  channel = "in_app",
  subject = "",
  body = "",
  templateId = null,
  templateCode = "",
  priority = "normal",
  objectType = "",
  objectId = "",
  objectName = "",
  deepLink = "",
  actions = [],
  correlationId = "",
  idempotencyKey = null,
  delaySeconds = 0,
  deliverVia = "notification",
} = {}) {
  if (!user || !user.id) return null;
  const resolvedTenant = tenantId ?? user.tenant_id ?? homeTenantId(db, user);
  if (!resolvedTenant) return null;
  if (idempotencyKey) {
    const existing = queryOne(db, "SELECT id FROM notifications WHERE idempotency_key = ?", [idempotencyKey]);
    if (existing) return existing.id;
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO notifications
      (tenant_id, recipient_id, recipient_address, channel, template_id, template_code, subject, body,
       status, priority, correlation_id, object_type, object_id, object_name, deep_link, action_links_json,
       idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      resolvedTenant,
      user.id,
      user.email || "",
      channel,
      templateId,
      templateCode,
      subject,
      body,
      priority,
      correlationId,
      objectType,
      objectId,
      objectName,
      deepLink,
      JSON.stringify(Array.isArray(actions) ? actions : []),
      idempotencyKey,
      ts,
      ts,
    ]
  );
  const nowTs = nowIso();
  if (deliverVia === "delivery") {
    // Hand the finished message to the Communication & Delivery Services
    // engine. The notification module keeps its own history record but does
    // not process the external channel itself, so the message is never
    // delivered twice.
    ingestNotification(
      db,
      {
        id: result.lastInsertRowid,
        tenant_id: resolvedTenant,
        recipient_id: user.id,
        recipient_name: user.display_name || user.username || "",
        recipient_address: user.email || "",
        channel,
        subject,
        body,
        priority,
        correlation_id: correlationId,
        object_type: objectType,
        object_id: objectId,
        object_name: objectName,
        deep_link: deepLink,
      },
      { delaySeconds }
    );
    run(db, "UPDATE notifications SET status = 'processing', updated_at = ? WHERE id = ?", [nowTs, result.lastInsertRowid]);
    return result.lastInsertRowid;
  }
  enqueue(db, { id: result.lastInsertRowid, channel, tenant_id: resolvedTenant }, { delaySeconds });
  return result.lastInsertRowid;
}

function nextBackoff(attempt) {
  return BACKOFF_BASE_SECONDS * Math.pow(2, Math.max(0, attempt - 1));
}

// Processes up to `limit` due deliveries. Safe to call repeatedly; returns a
// summary of what happened so callers can surface metrics.
export function processQueue(db, { limit = 50, now = null } = {}) {
  const stamp = now || nowIso();
  const due = queryAll(
    db,
    `SELECT d.*, n.recipient_id, n.recipient_address, n.subject, n.channel AS notification_channel
       FROM notification_deliveries d
       JOIN notifications n ON n.id = d.notification_id
      WHERE d.status IN ('queued', 'retrying') AND d.dead_letter = 0 AND d.scheduled_at <= ?
      ORDER BY d.scheduled_at, d.id LIMIT ?`,
    [stamp, limit]
  );
  const stats = { processed: 0, sent: 0, failed: 0, retried: 0, dead_letter: 0 };
  for (const delivery of due) {
    stats.processed += 1;
    run(db, "UPDATE notification_deliveries SET status = 'processing' WHERE id = ?", [delivery.id]);
    const provider = providerForChannel(db, delivery.channel);
    const context = { delivery, provider, notification: { ...delivery, id: delivery.notification_id, channel: delivery.notification_channel || delivery.channel } };
    let outcome;
    try {
      outcome = handlerFor(delivery.channel)(db, context);
    } catch (err) {
      outcome = { ok: false, error: err.message };
    }
    const attempt = Number(delivery.attempt) + 1;
    if (outcome.ok) {
      const ts = nowIso();
      run(
        db,
        `UPDATE notification_deliveries SET status = 'sent', attempt = ?, processed_at = ?, response_json = ?, error = '', provider_code = ? WHERE id = ?`,
        [attempt, ts, JSON.stringify(outcome.response || {}), outcome.provider || provider.code || "store", delivery.id]
      );
      run(
        db,
        `UPDATE notifications SET status = 'sent', sent_at = ?, provider_response = ?, last_error = '', updated_at = ? WHERE id = ?`,
        [ts, JSON.stringify(outcome.response || {}), ts, delivery.notification_id]
      );
      stats.sent += 1;
    } else if (attempt >= Number(delivery.max_attempts || MAX_ATTEMPTS)) {
      const ts = nowIso();
      run(
        db,
        `UPDATE notification_deliveries SET status = 'dead_letter', attempt = ?, processed_at = ?, error = ?, dead_letter = 1 WHERE id = ?`,
        [attempt, ts, String(outcome.error || "delivery failed"), delivery.id]
      );
      run(
        db,
        `UPDATE notifications SET status = 'failed', last_error = ?, retry_count = ?, updated_at = ? WHERE id = ?`,
        [String(outcome.error || "delivery failed"), attempt, ts, delivery.notification_id]
      );
      stats.failed += 1;
      stats.dead_letter += 1;
    } else {
      const ts = nowIso();
      const backoff = nextBackoff(attempt);
      run(
        db,
        `UPDATE notification_deliveries SET status = 'retrying', attempt = ?, scheduled_at = ?, error = ? WHERE id = ?`,
        [attempt, addSeconds(backoff), String(outcome.error || "delivery failed"), delivery.id]
      );
      run(
        db,
        `UPDATE notifications SET status = 'retrying', retry_count = ?, last_error = ?, updated_at = ? WHERE id = ?`,
        [attempt, String(outcome.error || "delivery failed"), ts, delivery.notification_id]
      );
      stats.retried += 1;
    }
  }
  return stats;
}

// Manual retry of a failed/dead-letter delivery (administrator action).
export function retryDelivery(db, id, tenantId = null) {
  const row = queryOne(db, "SELECT * FROM notification_deliveries WHERE id = ?", [Number(id)]);
  if (!row) return { retried: false };
  if (row.dead_letter === 0 && !["failed", "dead_letter"].includes(row.status)) {
    return { retried: false, reason: "not_failed" };
  }
  const ts = nowIso();
  run(db, "UPDATE notification_deliveries SET status = 'queued', dead_letter = 0, scheduled_at = ?, processed_at = NULL WHERE id = ?", [ts, row.id]);
  run(db, "UPDATE notifications SET status = 'queued', updated_at = ? WHERE id = ?", [ts, row.notification_id]);
  return { retried: true, id: row.id };
}

export function listDeliveries(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  if (tenantId) {
    where.push("d.tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (query.status) {
    where.push("d.status = ?");
    params.push(query.status);
  }
  if (query.channel) {
    where.push("d.channel = ?");
    params.push(query.channel);
  }
  if (query.notificationId) {
    where.push("d.notification_id = ?");
    params.push(Number(query.notificationId));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM notification_deliveries d ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT d.*, n.subject, n.recipient_id, n.object_type, n.object_id, n.object_name
       FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id
       ${clause} ORDER BY d.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map((row) => ({
    id: row.id,
    notification_id: row.notification_id,
    channel: row.channel,
    provider_code: row.provider_code,
    status: row.status,
    attempt: row.attempt,
    max_attempts: row.max_attempts,
    scheduled_at: row.scheduled_at,
    processed_at: row.processed_at,
    error: row.error,
    response: safeParse(row.response_json, {}),
    dead_letter: row.dead_letter === 1,
    subject: row.subject || "",
    recipient_id: row.recipient_id,
    object_type: row.object_type || "",
    object_id: row.object_id || "",
    object_name: row.object_name || "",
    created_at: row.created_at,
  }));
  return { items, total, page, pageSize };
}

export function deliveryStats(db, tenantId = null) {
  const params = [];
  const clause = tenantId ? "WHERE tenant_id = ?" : "";
  if (tenantId) params.push(Number(tenantId));
  const rows = queryAll(
    db,
    `SELECT status, COUNT(*) AS count FROM notification_deliveries ${clause} GROUP BY status`,
    params
  );
  const byChannel = queryAll(
    db,
    `SELECT channel, status, COUNT(*) AS count FROM notification_deliveries ${clause} GROUP BY channel, status`,
    params
  );
  const byStatus = rows.reduce((acc, row) => {
    acc[row.status] = row.count;
    return acc;
  }, {});
  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    by_status: byStatus,
    queued: byStatus.queued || 0,
    sent: byStatus.sent || 0,
    failed: byStatus.failed || 0,
    dead_letter: byStatus.dead_letter || 0,
    retrying: byStatus.retrying || 0,
    by_channel: byChannel,
  };
}
