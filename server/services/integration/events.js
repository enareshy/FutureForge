// Centralised event framework: event-type catalog, subscriptions with filters,
// publish/fan-out, delivery tracking with retry, idempotency and safe replay.
// Business modules publish domain events here instead of calling external
// systems directly.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { publicEventType, publicSubscription, publicEvent, publicDelivery, ref } from "./repository.js";
import {
  EVENT_STATUSES,
  SUBSCRIBER_TYPES,
  assertEnum,
  addSecondsIso,
  computeBackoffSeconds,
  normalizeRetryPolicy,
  safeParse,
  shouldRetry,
  toJson,
} from "./validation.js";
import { auditIntegration, log } from "./hooks.js";

export const SYSTEM_EVENT_TYPES = [
  { code: "ProductCreated", category: "product", description: "A product master record was created." },
  { code: "ProductUpdated", category: "product", description: "A product master record was updated." },
  { code: "ProductReleased", category: "product", description: "A product revision was released." },
  { code: "ProductRevisionCreated", category: "product", description: "A new product revision was created." },
  { code: "BOMCreated", category: "bom", description: "A bill of material was created." },
  { code: "BOMUpdated", category: "bom", description: "A bill of material was updated." },
  { code: "ChangeRequestCreated", category: "change", description: "An engineering change request was created." },
  { code: "ChangeReleased", category: "change", description: "An engineering change was released." },
  { code: "ManufacturingStructureUpdated", category: "manufacturing", description: "A manufacturing structure was updated." },
  { code: "ItemStatusChanged", category: "lifecycle", description: "An item lifecycle status changed." },
  { code: "DocumentReleased", category: "document", description: "A document was released." },
  { code: "UserCreated", category: "identity", description: "A user account was created." },
  { code: "IntegrationExecutionCompleted", category: "integration", description: "An integration execution completed." },
];

// ── Event types ─────────────────────────────────────────────────────────────
export function listEventTypes(db, { tenantId, category, status, q, page = 1, pageSize = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (category) {
    clauses.push("category = ?");
    params.push(category);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_event_types ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_event_types ${where} ORDER BY category, code LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicEventType(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getEventTypeRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM integration_event_types WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
}

export function getEventType(db, refValue) {
  const row = getEventTypeRow(db, refValue);
  if (!row) throw new HttpError(404, "Event type not found");
  return publicEventType(row);
}

export function createEventType(db, input = {}, actor = null, tenantId = null) {
  if (!input.code) throw new HttpError(400, "code is required");
  const existing = getEventTypeRow(db, input.code);
  if (existing) return publicEventType(existing);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO integration_event_types
      (code, name, version, description, category, direction, schema_json, example_json, status, system, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.code,
      input.name || input.code,
      Number(input.version) || 1,
      input.description || "",
      input.category || "domain",
      input.direction || "outbound",
      toJson(input.schema, {}),
      toJson(input.example, {}),
      input.status || "active",
      input.system ? 1 : 0,
      tenantId ?? input.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  auditIntegration(db, { actor, action: "integration.event_type.create", resourceType: "integration_event_type", resourceId: Number(result.lastInsertRowid), details: { code: input.code } });
  return publicEventType(queryOne(db, "SELECT * FROM integration_event_types WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function updateEventType(db, refValue, input = {}, actor = null) {
  const row = getEventTypeRow(db, refValue);
  if (!row) throw new HttpError(404, "Event type not found");
  if (input.status !== undefined) assertEnum(input.status, EVENT_STATUSES, "status");
  run(
    db,
    `UPDATE integration_event_types SET name=?, version=?, description=?, category=?, direction=?, schema_json=?,
     example_json=?, status=?, updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.version !== undefined ? Number(input.version) : row.version,
      input.description ?? row.description,
      input.category ?? row.category,
      input.direction ?? row.direction,
      input.schema !== undefined ? toJson(input.schema, {}) : row.schema_json,
      input.example !== undefined ? toJson(input.example, {}) : row.example_json,
      input.status ?? row.status,
      nowIso(),
      row.id,
    ]
  );
  auditIntegration(db, { actor, action: "integration.event_type.update", resourceType: "integration_event_type", resourceId: row.id, details: { code: row.code } });
  return publicEventType(queryOne(db, "SELECT * FROM integration_event_types WHERE id = ?", [row.id]));
}

export function ensureDefaultEventTypes(db) {
  let created = 0;
  for (const entry of SYSTEM_EVENT_TYPES) {
    if (!getEventTypeRow(db, entry.code)) {
      createEventType(db, { ...entry, system: true }, null, null);
      created += 1;
    }
  }
  return { created, total: SYSTEM_EVENT_TYPES.length };
}

export function deleteEventType(db, refValue, actor = null) {
  const row = getEventTypeRow(db, refValue);
  if (!row) throw new HttpError(404, "Event type not found");
  if (row.system) throw new HttpError(409, "System event types cannot be deleted");
  run(db, "DELETE FROM integration_event_types WHERE id = ?", [row.id]);
  auditIntegration(db, { actor, action: "integration.event_type.delete", resourceType: "integration_event_type", resourceId: row.id, details: { code: row.code } });
  return { deleted: true, id: row.id };
}

// ── Subscriptions ───────────────────────────────────────────────────────────
export function listSubscriptions(db, { tenantId, eventTypeCode, status, subscriberType, q, page = 1, pageSize = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (eventTypeCode) {
    clauses.push("event_type_code = ?");
    params.push(eventTypeCode);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (subscriberType) {
    clauses.push("subscriber_type = ?");
    params.push(subscriberType);
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_event_subscriptions ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_event_subscriptions ${where} ORDER BY code LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicSubscription(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getSubscriptionRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM integration_event_subscriptions WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
}

export function getSubscription(db, refValue) {
  const row = getSubscriptionRow(db, refValue);
  if (!row) throw new HttpError(404, "Event subscription not found");
  return publicSubscription(row);
}

export function createSubscription(db, input = {}, actor = null, tenantId = null) {
  if (!input.code) throw new HttpError(400, "code is required");
  if (!input.event_type_code && !input.event_type) throw new HttpError(400, "event_type_code is required");
  const eventTypeCode = input.event_type_code || input.event_type;
  if (!getEventTypeRow(db, eventTypeCode)) throw new HttpError(400, `Unknown event type ${eventTypeCode}`);
  assertEnum(input.subscriber_type ?? "webhook", SUBSCRIBER_TYPES, "subscriber_type");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO integration_event_subscriptions
      (code, name, event_type_code, subscriber_type, target_ref, filter_json, delivery_mode, retry_policy_json,
       status, tenant_id, organization_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      eventTypeCode,
      input.subscriber_type || "webhook",
      input.target_ref || "",
      toJson(input.filter, {}),
      input.delivery_mode || "push",
      toJson(input.retry_policy, {}),
      input.status || "active",
      tenantId ?? input.tenant_id ?? null,
      input.organization_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM integration_event_subscriptions WHERE id = ?", [Number(result.lastInsertRowid)]);
  auditIntegration(db, { actor, action: "integration.subscription.create", resourceType: "integration_event_subscription", resourceId: row.id, details: { code: row.code, event_type: row.event_type_code } });
  return publicSubscription(row);
}

export function updateSubscription(db, refValue, input = {}, actor = null) {
  const row = getSubscriptionRow(db, refValue);
  if (!row) throw new HttpError(404, "Event subscription not found");
  if (input.event_type_code && !getEventTypeRow(db, input.event_type_code)) throw new HttpError(400, `Unknown event type ${input.event_type_code}`);
  if (input.subscriber_type !== undefined) assertEnum(input.subscriber_type, SUBSCRIBER_TYPES, "subscriber_type");
  run(
    db,
    `UPDATE integration_event_subscriptions SET name=?, event_type_code=?, subscriber_type=?, target_ref=?, filter_json=?,
     delivery_mode=?, retry_policy_json=?, status=?, organization_id=?, updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.event_type_code ?? row.event_type_code,
      input.subscriber_type ?? row.subscriber_type,
      input.target_ref ?? row.target_ref,
      input.filter !== undefined ? toJson(input.filter, {}) : row.filter_json,
      input.delivery_mode ?? row.delivery_mode,
      input.retry_policy !== undefined ? toJson(input.retry_policy, {}) : row.retry_policy_json,
      input.status ?? row.status,
      input.organization_id !== undefined ? input.organization_id : row.organization_id,
      nowIso(),
      row.id,
    ]
  );
  auditIntegration(db, { actor, action: "integration.subscription.update", resourceType: "integration_event_subscription", resourceId: row.id, details: { code: row.code } });
  return publicSubscription(queryOne(db, "SELECT * FROM integration_event_subscriptions WHERE id = ?", [row.id]));
}

export function setSubscriptionStatus(db, refValue, status, actor = null) {
  assertEnum(status, ["active", "inactive"], "status");
  const row = getSubscriptionRow(db, refValue);
  if (!row) throw new HttpError(404, "Event subscription not found");
  run(db, "UPDATE integration_event_subscriptions SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), row.id]);
  auditIntegration(db, { actor, action: "integration.subscription.status", resourceType: "integration_event_subscription", resourceId: row.id, details: { code: row.code, status } });
  return publicSubscription(queryOne(db, "SELECT * FROM integration_event_subscriptions WHERE id = ?", [row.id]));
}

export function deleteSubscription(db, refValue, actor = null) {
  const row = getSubscriptionRow(db, refValue);
  if (!row) throw new HttpError(404, "Event subscription not found");
  run(db, "DELETE FROM integration_event_subscriptions WHERE id = ?", [row.id]);
  auditIntegration(db, { actor, action: "integration.subscription.delete", resourceType: "integration_event_subscription", resourceId: row.id, details: { code: row.code } });
  return { deleted: true, id: row.id };
}

// ── Publish / delivery ───────────────────────────────────────────────────────
function matchesFilter(filter, payload, event) {
  const spec = filter && typeof filter === "object" ? filter : {};
  for (const [key, expected] of Object.entries(spec)) {
    if (key === "tenant_id") continue;
    const actual = key.includes(".") ? getDotted(payload, key) : payload?.[key];
    if (Array.isArray(expected)) {
      if (!expected.includes(actual)) return false;
    } else if (expected !== null && typeof expected === "object") {
      if (expected.equals !== undefined && actual !== expected.equals) return false;
      if (expected.exists === true && (actual === undefined || actual === null)) return false;
    } else if (actual !== expected) {
      return false;
    }
  }
  return true;
}

function getDotted(obj, path) {
  return String(path).split(".").reduce((acc, part) => (acc === undefined || acc === null ? undefined : acc[part]), obj);
}

// Publishes an event and fans it out to matching active subscriptions. Delivery
// rows are the source of truth for retry/replay. External subscribers are
// queued for the webhook dispatcher.
export function publishEvent(db, input = {}, actor = null) {
  const eventTypeCode = input.event_type_code || input.event_type || input.type;
  if (!eventTypeCode) throw new HttpError(400, "event_type_code is required");
  const idempotencyKey = input.idempotency_key ?? input.idempotencyKey ?? null;
  if (idempotencyKey) {
    const existing = queryOne(db, "SELECT * FROM integration_events WHERE idempotency_key = ?", [idempotencyKey]);
    if (existing) return { ...publicEvent(existing), duplicate: true, deliveries: [] };
  }
  let eventType = getEventTypeRow(db, eventTypeCode);
  if (!eventType) eventType = getEventTypeRow(db, createEventType(db, { code: eventTypeCode, name: eventTypeCode, category: "domain" }).code);
  const payload = input.payload || {};
  const tenantId = input.tenant_id ?? actor?.tenant_id ?? null;
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO integration_events
      (event_ref, event_type_code, version, source_module, payload_json, metadata_json, correlation_id, idempotency_key,
       status, subscriber_count, delivered_count, failed_count, tenant_id, organization_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', 0, 0, 0, ?, ?, ?, ?, ?)`,
    [
      input.event_ref || ref("EVT"),
      eventTypeCode,
      eventType.version || 1,
      input.source_module || "integration",
      toJson(payload, {}),
      toJson({ ...(input.metadata || {}), actor_id: actor?.id ?? null }, {}),
      input.correlation_id ?? null,
      idempotencyKey,
      tenantId,
      input.organization_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const eventId = Number(result.lastInsertRowid);
  const eventRow = queryOne(db, "SELECT * FROM integration_events WHERE id = ?", [eventId]);

  const subscriptions = queryAll(
    db,
    `SELECT * FROM integration_event_subscriptions
     WHERE event_type_code = ? AND status = 'active' AND (tenant_id IS NULL OR tenant_id = ?)`,
    [eventTypeCode, tenantId ?? -1]
  );
  const matched = subscriptions.filter((sub) => matchesFilter(safeParse(sub.filter_json, {}), payload, eventRow));
  const deliveries = [];
  for (const sub of matched) {
    const policy = normalizeRetryPolicy(safeParse(sub.retry_policy_json, {}));
    const insert = run(
      db,
      `INSERT INTO integration_event_deliveries
        (event_id, subscription_id, event_type_code, subscriber_type, target_ref, status, attempts, max_attempts,
         payload_json, correlation_id, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?)`,
      [eventId, sub.id, eventTypeCode, sub.subscriber_type, sub.target_ref || "", policy.max_attempts, toJson(payload, {}), eventRow.correlation_id, tenantId, ts, ts]
    );
    deliveries.push(publicDelivery(queryOne(db, "SELECT * FROM integration_event_deliveries WHERE id = ?", [Number(insert.lastInsertRowid)])));
  }
  run(db, "UPDATE integration_events SET subscriber_count = ?, updated_at = ? WHERE id = ?", [deliveries.length, nowIso(), eventId]);

  auditIntegration(db, { actor, action: "integration.event.publish", resourceType: "integration_event", resourceId: eventId, details: { event_type: eventTypeCode, subscribers: deliveries.length } });
  return { ...publicEvent(queryOne(db, "SELECT * FROM integration_events WHERE id = ?", [eventId]), { includePayload: true }), deliveries };
}

export function listEvents(db, { tenantId, eventTypeCode, status, q, page = 1, pageSize = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (eventTypeCode) {
    clauses.push("event_type_code = ?");
    params.push(eventTypeCode);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (q) {
    clauses.push("(LOWER(event_ref) LIKE ? OR LOWER(event_type_code) LIKE ? OR LOWER(correlation_id) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_events ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_events ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicEvent(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getEventRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM integration_events WHERE id = ? OR event_ref = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
}

export function getEvent(db, refValue, { includePayload = false } = {}) {
  const row = getEventRow(db, refValue);
  if (!row) throw new HttpError(404, "Event not found");
  const deliveries = listDeliveries(db, { eventId: row.id });
  return { ...publicEvent(row, { includePayload }), deliveries: deliveries.items };
}

export function listDeliveries(db, { tenantId, eventId, subscriptionId, status, page = 1, pageSize = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (eventId) {
    clauses.push("event_id = ?");
    params.push(Number(eventId));
  }
  if (subscriptionId) {
    clauses.push("subscription_id = ?");
    params.push(Number(subscriptionId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_event_deliveries ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_event_deliveries ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicDelivery(r)), total, page: Number(page), page_size: Number(pageSize) };
}

// Retries or replays deliveries. Replay re-publishes a stored event across the
// current set of subscribers; retry re-attempts only failed deliveries.
export function retryDelivery(db, deliveryId, actor = null) {
  const row = queryOne(db, "SELECT * FROM integration_event_deliveries WHERE id = ?", [Number(deliveryId)]);
  if (!row) throw new HttpError(404, "Delivery not found");
  run(db, "UPDATE integration_event_deliveries SET status = 'pending', next_retry_at = NULL, updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  auditIntegration(db, { actor, action: "integration.event.delivery.retry", resourceType: "integration_event_delivery", resourceId: row.id, details: {} });
  return publicDelivery(queryOne(db, "SELECT * FROM integration_event_deliveries WHERE id = ?", [row.id]));
}

export function replayEvent(db, refValue, actor = null) {
  const row = getEventRow(db, refValue);
  if (!row) throw new HttpError(404, "Event not found");
  const payload = safeParse(row.payload_json, {});
  const result = publishEvent(
    db,
    {
      event_type_code: row.event_type_code,
      payload,
      source_module: row.source_module,
      correlation_id: row.correlation_id,
      metadata: { ...safeParse(row.metadata_json, {}), replay_of: row.event_ref },
      tenant_id: row.tenant_id,
    },
    actor
  );
  auditIntegration(db, { actor, action: "integration.event.replay", resourceType: "integration_event", resourceId: row.id, details: { replay_ref: result.event_ref } });
  return result;
}

// Processes pending internal/queue/integration deliveries. Webhook deliveries
// are handled by the webhook dispatcher. Returns a summary for the worker.
export async function processDueDeliveries(db, dispatchFn = null, { limit = 50 } = {}) {
  const ts = nowIso();
  const rows = queryAll(
    db,
    `SELECT * FROM integration_event_deliveries
     WHERE status IN ('pending', 'retry') AND subscriber_type != 'webhook'
       AND (next_retry_at IS NULL OR next_retry_at <= ?)
     ORDER BY COALESCE(next_retry_at, created_at) LIMIT ?`,
    [ts, Number(limit)]
  );
  const summary = { processed: 0, delivered: 0, failed: 0, retried: 0 };
  for (const row of rows) {
    summary.processed += 1;
    try {
      if (dispatchFn) await dispatchFn(row);
      run(db, "UPDATE integration_event_deliveries SET status = 'delivered', delivered_at = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?", [nowIso(), nowIso(), row.id]);
      summary.delivered += 1;
    } catch (error) {
      const sub = row.subscription_id ? queryOne(db, "SELECT * FROM integration_event_subscriptions WHERE id = ?", [row.subscription_id]) : null;
      const policy = normalizeRetryPolicy(safeParse(sub?.retry_policy_json, {}));
      const attempts = row.attempts + 1;
      if (shouldRetry(policy, attempts, "technical")) {
        const delay = computeBackoffSeconds(policy, attempts);
        run(
          db,
          "UPDATE integration_event_deliveries SET status = 'retry', attempts = ?, max_attempts = ?, next_retry_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
          [attempts, policy.max_attempts, addSecondsIso(delay), error.message, nowIso(), row.id]
        );
        summary.retried += 1;
      } else {
        run(
          db,
          "UPDATE integration_event_deliveries SET status = 'dead_letter', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?",
          [attempts, error.message, nowIso(), row.id]
        );
        summary.failed += 1;
      }
      log("warn", "integration.event.delivery_failed", { delivery_id: row.id, error: error.message });
    }
  }
  // Roll up event status from delivery outcomes.
  for (const row of rows) {
    const counts = queryOne(
      db,
      `SELECT
         SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
         SUM(CASE WHEN status IN ('failed','dead_letter') THEN 1 ELSE 0 END) AS failed
       FROM integration_event_deliveries WHERE event_id = ?`,
      [row.event_id]
    );
    run(db, "UPDATE integration_events SET delivered_count = ?, failed_count = ?, status = ?, updated_at = ? WHERE id = ?", [
      counts?.delivered || 0,
      counts?.failed || 0,
      (counts?.failed || 0) > 0 ? "partial" : "processed",
      nowIso(),
      row.event_id,
    ]);
  }
  return summary;
}
