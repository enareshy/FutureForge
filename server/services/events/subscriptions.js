// Subscription Registry.
//
// A subscription binds one event type (and optionally a version) to one
// subscriber — a handler, a queue, a topic or an external integration — with
// its own filter, ordering, retry and dead-letter policy. Subscriptions are
// validated before they are activated so a typo cannot silently drop events.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import {
  assertCode,
  assertEnum,
  SUBSCRIPTION_STATUSES,
  normalizeSubscriptionStatus,
  normalizePriority,
  normalizeOrderingScope,
  normalizeRetryPolicy,
  normalizeDeadLetterPolicy,
  toJson,
  safeParse,
  matchesSubscriptionFilter,
  clampInt,
  priorityRank,
} from "./validation.js";
import { publicSubscription } from "./repository.js";
import { getEventTypeRow } from "./registry.js";
import { getHandler } from "./handlers.js";
import { getTopicRow } from "./bus.js";
import { getQueueRow } from "./bus.js";
import { auditEvent } from "./hooks.js";

export function listSubscriptions(db, { tenantId, eventTypeCode, subscriber, status, queueCode, handler, q, page = 1, pageSize = 50 } = {}) {
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
  if (subscriber) {
    clauses.push("subscriber = ?");
    params.push(subscriber);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (queueCode) {
    clauses.push("queue_code = ?");
    params.push(queueCode);
  }
  if (handler) {
    clauses.push("handler = ?");
    params.push(handler);
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(subscriber) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM event_subscriptions ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM event_subscriptions ${where} ORDER BY event_type_code, code LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicSubscription(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getSubscriptionRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM event_subscriptions WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
}

export function getSubscription(db, refValue) {
  const row = getSubscriptionRow(db, refValue);
  if (!row) throw new HttpError(404, "Event subscription not found");
  return publicSubscription(row);
}

export function createSubscription(db, input = {}, actor = null, tenantId = null) {
  assertCode(input.code, "Subscription code");
  const eventTypeCode = input.event_type_code || input.eventTypeCode || input.event_type;
  if (!eventTypeCode) throw new HttpError(400, "event_type_code is required");
  const type = getEventTypeRow(db, eventTypeCode);
  if (!type) throw new HttpError(400, `Unknown event type ${eventTypeCode}`);
  const status = normalizeSubscriptionStatus(input.status || "draft");
  const orderingRequired = input.ordering_required ?? (type.ordering_required ? true : false);
  const orderingScope = input.ordering_scope || type.ordering_scope || "none";
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO event_subscriptions
      (code, name, description, subscriber, event_type_code, event_version, topic_code, queue_code, consumer_group, handler,
       filter_json, ordering_required, ordering_scope, ordering_timeout_seconds, retry_policy_json, dead_letter_policy_json,
       status, tenant_id, organization_id, plant_id, site_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      input.description || "",
      input.subscriber || input.code,
      eventTypeCode,
      input.event_version !== undefined && input.event_version !== null ? Number(input.event_version) : null,
      input.topic_code || "",
      input.queue_code || "",
      input.consumer_group || "",
      input.handler || "",
      toJson(input.filter, {}),
      orderingRequired ? 1 : 0,
      normalizeOrderingScope(orderingScope),
      clampInt(input.ordering_timeout_seconds, 0, 86400, 30),
      toJson(normalizeRetryPolicy(input.retry_policy), {}),
      toJson(normalizeDeadLetterPolicy(input.dead_letter_policy), {}),
      status,
      tenantId ?? input.tenant_id ?? null,
      input.organization_id ?? null,
      input.plant_id ?? null,
      input.site_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM event_subscriptions WHERE id = ?", [Number(result.lastInsertRowid)]);
  auditEvent(db, { actor, action: "event.subscription.create", resourceType: "event_subscription", resourceId: row.id, details: { code: row.code, event_type: row.event_type_code } });
  return publicSubscription(row);
}

export function updateSubscription(db, refValue, input = {}, actor = null) {
  const row = getSubscriptionRow(db, refValue);
  if (!row) throw new HttpError(404, "Event subscription not found");
  if (input.event_type_code && !getEventTypeRow(db, input.event_type_code)) {
    throw new HttpError(400, `Unknown event type ${input.event_type_code}`);
  }
  if (input.status !== undefined) assertEnum(input.status, SUBSCRIPTION_STATUSES, "status");
  run(
    db,
    `UPDATE event_subscriptions SET name=?, description=?, subscriber=?, event_type_code=?, event_version=?, topic_code=?, queue_code=?,
       consumer_group=?, handler=?, filter_json=?, ordering_required=?, ordering_scope=?, ordering_timeout_seconds=?, retry_policy_json=?,
       dead_letter_policy_json=?, status=?, organization_id=?, plant_id=?, site_id=?, updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.description ?? row.description,
      input.subscriber ?? row.subscriber,
      input.event_type_code ?? row.event_type_code,
      input.event_version !== undefined ? (input.event_version === null ? null : Number(input.event_version)) : row.event_version,
      input.topic_code !== undefined ? input.topic_code : row.topic_code,
      input.queue_code !== undefined ? input.queue_code : row.queue_code,
      input.consumer_group !== undefined ? input.consumer_group : row.consumer_group,
      input.handler !== undefined ? input.handler : row.handler,
      input.filter !== undefined ? toJson(input.filter, {}) : row.filter_json,
      input.ordering_required !== undefined ? (input.ordering_required ? 1 : 0) : row.ordering_required,
      input.ordering_scope !== undefined ? normalizeOrderingScope(input.ordering_scope) : row.ordering_scope,
      input.ordering_timeout_seconds !== undefined ? clampInt(input.ordering_timeout_seconds, 0, 86400, row.ordering_timeout_seconds) : row.ordering_timeout_seconds,
      input.retry_policy !== undefined ? toJson(normalizeRetryPolicy(input.retry_policy), {}) : row.retry_policy_json,
      input.dead_letter_policy !== undefined ? toJson(normalizeDeadLetterPolicy(input.dead_letter_policy), {}) : row.dead_letter_policy_json,
      input.status !== undefined ? normalizeSubscriptionStatus(input.status) : row.status,
      input.organization_id !== undefined ? input.organization_id : row.organization_id,
      input.plant_id !== undefined ? input.plant_id : row.plant_id,
      input.site_id !== undefined ? input.site_id : row.site_id,
      nowIso(),
      row.id,
    ]
  );
  auditEvent(db, { actor, action: "event.subscription.update", resourceType: "event_subscription", resourceId: row.id, details: { code: row.code } });
  return publicSubscription(queryOne(db, "SELECT * FROM event_subscriptions WHERE id = ?", [row.id]));
}

// Validation is run before activation. Errors block activation; warnings do not.
export function validateSubscription(db, refValue) {
  const row = getSubscriptionRow(db, refValue);
  if (!row) throw new HttpError(404, "Event subscription not found");
  const errors = [];
  const warnings = [];
  const type = getEventTypeRow(db, row.event_type_code);
  if (!type) errors.push(`Unknown event type ${row.event_type_code}`);
  else {
    if (type.status === "deprecated") warnings.push(`Event type ${type.code} is deprecated`);
    if (type.status === "inactive" || !type.enabled) errors.push(`Event type ${type.code} is not enabled`);
  }
  if (row.event_version !== null && type) {
    const schema = queryOne(db, "SELECT * FROM event_schemas WHERE event_type_id = ? AND version = ?", [type.id, row.event_version]);
    if (!schema) errors.push(`Event version v${row.event_version} is not registered for ${row.event_type_code}`);
    else if (schema.status === "retired") errors.push(`Event version v${row.event_version} is retired`);
  }
  if (row.topic_code && !getTopicRow(db, row.topic_code)) errors.push(`Unknown topic ${row.topic_code}`);
  if (row.queue_code && !getQueueRow(db, row.queue_code)) errors.push(`Unknown queue ${row.queue_code}`);
  if (row.queue_code && row.consumer_group) {
    const group = queryOne(db, "SELECT * FROM event_consumer_groups WHERE code = ?", [row.consumer_group]);
    if (!group) warnings.push(`Consumer group ${row.consumer_group} is not registered`);
  }
  if (!row.handler && !row.queue_code) warnings.push("No handler or queue is bound; deliveries will be marked ignored");
  if (row.handler && !getHandler(row.handler)) warnings.push(`Handler ${row.handler} is not registered in this process`);
  const filter = safeParse(row.filter_json, {});
  if (filter && typeof filter === "object" && Object.keys(filter).length === 0) warnings.push("Subscription has no filter and will receive every event of its type");
  return { valid: errors.length === 0, errors, warnings, subscription: publicSubscription(row) };
}

// Activation runs validation and refuses on hard errors. Deactivation is always
// allowed. Returns the updated subscription.
export function setSubscriptionStatus(db, refValue, status, actor = null) {
  assertEnum(status, SUBSCRIPTION_STATUSES, "status");
  const row = getSubscriptionRow(db, refValue);
  if (!row) throw new HttpError(404, "Event subscription not found");
  if (status === "active") {
    const validation = validateSubscription(db, refValue);
    if (!validation.valid) throw new HttpError(400, `Subscription cannot be activated: ${validation.errors.join("; ")}`, validation.errors);
  }
  run(db, "UPDATE event_subscriptions SET status = ?, updated_at = ? WHERE id = ?", [normalizeSubscriptionStatus(status), nowIso(), row.id]);
  auditEvent(db, { actor, action: "event.subscription.status", resourceType: "event_subscription", resourceId: row.id, details: { code: row.code, status } });
  return publicSubscription(queryOne(db, "SELECT * FROM event_subscriptions WHERE id = ?", [row.id]));
}

export function deleteSubscription(db, refValue, actor = null) {
  const row = getSubscriptionRow(db, refValue);
  if (!row) throw new HttpError(404, "Event subscription not found");
  run(db, "DELETE FROM event_subscriptions WHERE id = ?", [row.id]);
  auditEvent(db, { actor, action: "event.subscription.delete", resourceType: "event_subscription", resourceId: row.id, details: { code: row.code } });
  return { deleted: true, id: row.id };
}

// Dry-runs a subscription against a sample event. It never invokes the handler;
// it reports filter matching, routing target and validation state so operators
// can confirm behaviour before activating.
export function testSubscription(db, refValue, input = {}) {
  const row = getSubscriptionRow(db, refValue);
  if (!row) throw new HttpError(404, "Event subscription not found");
  const sample = {
    event_type_code: row.event_type_code,
    event_version: row.event_version ?? 1,
    source_module: input.source_module || "test",
    source_system: "test",
    source_object_type: input.source_object_type || null,
    source_object_id: input.source_object_id || null,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id,
    metadata: input.metadata || {},
  };
  const event = { ...sample, payload: input.payload || {} };
  const filter = safeParse(row.filter_json, {});
  const matched = matchesSubscriptionFilter(filter, { event, payload: input.payload || {} });
  const handlerRegistered = row.handler ? Boolean(getHandler(row.handler)) : false;
  const validation = validateSubscription(db, refValue);
  return {
    subscription: publicSubscription(row),
    matched,
    filter,
    sample_payload: input.payload || {},
    handler_registered: handlerRegistered,
    target: row.queue_code || row.handler || row.topic_code || "unbound",
    validation,
  };
}

export function subscriptionStats(db, refValue) {
  const row = getSubscriptionRow(db, refValue);
  if (!row) throw new HttpError(404, "Event subscription not found");
  const stats = queryOne(
    db,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN status IN ('pending','retry','out_of_order') THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
       SUM(CASE WHEN status IN ('failed','dead_letter') THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN status = 'duplicate' THEN 1 ELSE 0 END) AS duplicate,
       AVG(duration_ms) AS avg_duration_ms
     FROM event_deliveries WHERE subscription_id = ?`,
    [row.id]
  );
  return {
    subscription_id: row.id,
    total: stats?.total || 0,
    delivered: stats?.delivered || 0,
    pending: stats?.pending || 0,
    processing: stats?.processing || 0,
    failed: stats?.failed || 0,
    duplicate: stats?.duplicate || 0,
    avg_duration_ms: stats?.avg_duration_ms ? Math.round(stats.avg_duration_ms) : null,
  };
}

// Ranks a set of subscriptions deterministically so ordering-sensitive
// subscriptions are processed by priority then id.
export function orderSubscriptions(rows) {
  return [...rows].sort((a, b) => priorityRank(b.priority) - priorityRank(a.priority) || a.id - b.id);
}
