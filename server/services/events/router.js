// Event Router.
//
// Matches a stored event to the active subscriptions that should receive it and
// materialises one delivery row per subscription. Deliveries are the durable
// unit of work: retry, ordering, idempotency and dead-letter all operate on
// them, so a broker outage never loses an event.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { safeParse, matchesSubscriptionFilter, normalizeRetryPolicy, normalizeDeadLetterPolicy, toJson } from "./validation.js";
import { ref } from "./repository.js";
import { queueDepth } from "./bus.js";
import { log } from "./hooks.js";

// Resolves the active subscriptions for an event, honouring event type,
// version, tenant/organization scope and payload filters.
export function matchSubscriptions(db, event) {
  const rows = queryAll(
    db,
    `SELECT * FROM event_subscriptions
     WHERE event_type_code = ? AND status = 'active'
       AND (tenant_id IS NULL OR tenant_id = ?)
     ORDER BY id`,
    [event.event_type_code, event.tenant_id ?? -1]
  );
  const payload = safeParse(event.payload_json, {});
  const context = { event, payload };
  return rows.filter((sub) => {
    if (sub.event_version !== null && sub.event_version !== undefined && Number(sub.event_version) !== Number(event.event_version)) return false;
    if (sub.organization_id && Number(sub.organization_id) !== Number(event.organization_id ?? -1)) return false;
    if (sub.plant_id && Number(sub.plant_id) !== Number(event.plant_id ?? -1)) return false;
    if (sub.site_id && Number(sub.site_id) !== Number(event.site_id ?? -1)) return false;
    return matchesSubscriptionFilter(safeParse(sub.filter_json, {}), context);
  });
}

// Routes an event: creates deliveries for matching subscriptions. Safe to call
// twice for the same event (INSERT OR IGNORE on event_id + subscription_id) so
// outbox replay and manual routing converge instead of duplicating.
export function routeEvent(db, event, _options = {}) {
  const subscriptions = matchSubscriptions(db, event);
  const ts = nowIso();
  const deliveries = [];
  for (const sub of subscriptions) {
    const retry = normalizeRetryPolicy(safeParse(sub.retry_policy_json, {}));
    const dlq = normalizeDeadLetterPolicy(safeParse(sub.dead_letter_policy_json, {}));
    const maxAttempts = dlq.enabled ? Math.max(retry.max_attempts, 1) : retry.max_attempts;
    const result = run(
      db,
      `INSERT OR IGNORE INTO event_deliveries
        (event_id, event_ref, subscription_id, event_type_code, event_version, subscriber, handler, topic_code, queue_code,
         consumer_group, partition_key, sequence_number, priority, status, attempts, max_attempts, available_at,
         payload_json, correlation_id, causation_id, trace_id, idempotency_key, security_classification,
         tenant_id, organization_id, plant_id, site_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.id,
        event.event_ref,
        sub.id,
        event.event_type_code,
        event.event_version,
        sub.subscriber,
        sub.handler || "",
        sub.topic_code || "",
        sub.queue_code || "",
        sub.consumer_group || "",
        event.partition_key || null,
        event.sequence_number ?? null,
        event.priority || "normal",
        maxAttempts,
        ts,
        event.payload_json,
        event.correlation_id || null,
        event.causation_id || null,
        event.trace_id || null,
        `${event.event_ref}:${sub.id}`,
        event.security_classification || "internal",
        event.tenant_id ?? null,
        event.organization_id ?? null,
        event.plant_id ?? null,
        event.site_id ?? null,
        ts,
        ts,
      ]
    );
    if (Number(result.changes || 0) > 0) {
      deliveries.push(queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [Number(result.lastInsertRowid)]));
    }
  }
  run(db, "UPDATE event_records SET subscriber_count = ?, status = ?, updated_at = ? WHERE id = ?", [
    deliveries.length,
    "published",
    ts,
    event.id,
  ]);
  if (subscriptions.length === 0) {
    log("debug", "event.routed.no_subscribers", { event_ref: event.event_ref, event_type: event.event_type_code });
  }
  return { event_ref: event.event_ref, event_type_code: event.event_type_code, matched: subscriptions.length, deliveries };
}

// Dry-run routing used by the replay wizard preview and subscription tests.
export function previewRoute(db, event) {
  const subscriptions = matchSubscriptions(db, event);
  return subscriptions.map((sub) => ({
    subscription_id: sub.id,
    code: sub.code,
    subscriber: sub.subscriber,
    handler: sub.handler || "",
    queue_code: sub.queue_code || "",
    consumer_group: sub.consumer_group || "",
    ordering_required: Boolean(sub.ordering_required),
  }));
}

// Enqueues a first-class queue message (asynchronous work that is not tied to a
// published domain event). It materialises as a delivery so operators see and
// retry it through the same tooling.
export function enqueueMessage(db, queueCode, message = {}, options = {}) {
  const ts = nowIso();
  const eventRef = message.event_ref || ref("MSG");
  const handler = message.handler || "";
  const subscriptionId = message.subscription_id ?? null;
  const retry = normalizeRetryPolicy(options.retry_policy || message.retry_policy);
  const result = run(
    db,
    `INSERT INTO event_deliveries
      (event_id, event_ref, subscription_id, event_type_code, event_version, subscriber, handler, topic_code, queue_code,
       consumer_group, partition_key, sequence_number, priority, status, attempts, max_attempts, available_at,
       payload_json, correlation_id, causation_id, trace_id, idempotency_key, security_classification,
       tenant_id, organization_id, plant_id, site_id, created_at, updated_at)
     VALUES (NULL, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?, 'internal', ?, ?, ?, ?, ?, ?)`,
    [
      eventRef,
      subscriptionId,
      message.event_type_code || message.message_type || "SystemMessage",
      message.subscriber || handler || queueCode,
      handler,
      message.topic_code || "",
      queueCode,
      message.consumer_group || "",
      message.partition_key || null,
      message.sequence_number ?? null,
      message.priority || "normal",
      retry.max_attempts,
      ts,
      toJson(message.payload, {}),
      message.correlation_id || null,
      message.causation_id || null,
      message.trace_id || null,
      message.idempotency_key || `${eventRef}:${queueCode}`,
      message.tenant_id ?? null,
      message.organization_id ?? null,
      message.plant_id ?? null,
      message.site_id ?? null,
      ts,
      ts,
    ]
  );
  return queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [Number(result.lastInsertRowid)]);
}

// Priority-ordered routing statistics for the dashboard.
export function routingStats(db, { tenantId = null } = {}) {
  const clause = tenantId !== undefined && tenantId !== null ? "WHERE tenant_id = ?" : "";
  const params = tenantId !== undefined && tenantId !== null ? [Number(tenantId)] : [];
  const byType = queryAll(
    db,
    `SELECT event_type_code, COUNT(*) AS total,
       SUM(CASE WHEN status IN ('failed','dead_letter') THEN 1 ELSE 0 END) AS failed
     FROM event_deliveries ${clause} GROUP BY event_type_code ORDER BY total DESC LIMIT 10`,
    params
  );
  const subscriptions = queryOne(db, `SELECT COUNT(*) AS c FROM event_subscriptions ${clause}`, params).c;
  return { subscriptions, top_event_types: byType, queue_depth: queueDepth(db, { tenantId }) };
}
