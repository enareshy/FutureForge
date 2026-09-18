// Provider-independent event bus abstraction plus topic / queue / consumer
// group topology management.
//
// The framework never talks to a broker directly. `resolveBus()` returns an
// adapter with a uniform contract; the built-in `database` adapter is durable
// and uses the platform's own tables, while `memory` is used by tests and local
// runs. Kafka / RabbitMQ / Azure Service Bus / cloud messaging adapters register
// themselves through `registerBusProvider()` and no other service changes.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { BUS_PROVIDERS, assertCode, clampInt, toJson, safeParse } from "./validation.js";
import { publicTopic, publicQueue, publicConsumerGroup, ref } from "./repository.js";

const providers = new Map();

export function registerBusProvider(code, factory) {
  const key = String(code || "").trim().toLowerCase();
  if (!key || typeof factory !== "function") throw new Error("A bus provider code and factory are required");
  providers.set(key, factory);
  return key;
}

export function unregisterBusProvider(code) {
  return providers.delete(String(code || "").trim().toLowerCase());
}

export function listBusProviders() {
  return [...new Set(["database", "memory", ...providers.keys()])];
}

export function resolveBus(db, { provider = null, config = {} } = {}) {
  const requested = String(provider || "database").trim().toLowerCase();
  if (requested === "memory") return createMemoryBroker();
  if (requested === "database") return createDatabaseBroker(db, config);
  const factory = providers.get(requested);
  if (factory) return factory({ db, config });
  if (BUS_PROVIDERS.includes(requested)) {
    throw new HttpError(400, `Message broker provider '${requested}' is not installed. Register an adapter with registerBusProvider().`);
  }
  throw new HttpError(400, `Unknown message broker provider '${requested}'`);
}

function createDatabaseBroker(db) {
  return {
    code: "database",
    durable: true,
    async publish(envelope, options = {}) {
      const { routeEvent } = await import("./router.js");
      return routeEvent(db, envelope, options);
    },
    async enqueue(queueCode, message, options = {}) {
      const { enqueueMessage } = await import("./router.js");
      return enqueueMessage(db, queueCode, message, options);
    },
    async health() {
      return databaseHealth(db);
    },
  };
}

// Synchronous health snapshot for the built-in durable broker. Kept sync so
// dashboard/health endpoints can read it without awaiting a broker round-trip.
export function databaseHealth(db) {
  const outbox = queryOne(db, "SELECT COUNT(*) AS c FROM event_outbox WHERE status IN ('pending','publishing','failed')");
  const deliveries = queryOne(db, "SELECT COUNT(*) AS c FROM event_deliveries WHERE status IN ('pending','processing','retry','out_of_order')");
  return { provider: "database", connected: true, outbox_pending: outbox?.c || 0, deliveries_pending: deliveries?.c || 0 };
}

// In-memory broker: a real pub/sub + queue implementation for tests and
// single-process runs. Messages are not durable across restarts by design.
function createMemoryBroker() {
  const topics = new Map();
  const queues = new Map();
  const subscribers = new Map();
  const delivered = { published: 0, enqueued: 0 };
  return {
    code: "memory",
    durable: false,
    async publish(envelope) {
      delivered.published += 1;
      const topic = envelope.topic_code || "domain-events";
      const list = topics.get(topic) || [];
      for (const sub of subscribers.get(topic) || []) list.push({ envelope, sub });
      topics.set(topic, list);
      return { published: true, topic_code: topic, subscribers: (subscribers.get(topic) || []).length };
    },
    async enqueue(queueCode, message) {
      delivered.enqueued += 1;
      const list = queues.get(queueCode) || [];
      list.push(message);
      queues.set(queueCode, list);
      return { enqueued: true, queue_code: queueCode, depth: list.length };
    },
    subscribe(topicCode, subscriber) {
      const list = subscribers.get(topicCode) || [];
      list.push(subscriber);
      subscribers.set(topicCode, list);
    },
    async drain(queueCode, limit = 100) {
      const list = queues.get(queueCode) || [];
      return list.splice(0, limit);
    },
    async health() {
      return { provider: "memory", connected: true, topics: topics.size, queues: queues.size, ...delivered };
    },
    stats() {
      return { published: delivered.published, enqueued: delivered.enqueued };
    },
  };
}

// ── Broker health / connectivity ────────────────────────────────────────────
export function brokerHealth(db, { config = {} } = {}) {
  let provider;
  try {
    provider = resolveBus(db, { provider: config.provider, config });
  } catch (error) {
    return { provider: config.provider || "database", connected: false, error: error.message };
  }
  if (provider.code === "database") return databaseHealth(db);
  if (provider.code === "memory") return { provider: "memory", connected: true };
  try {
    const result = provider.health?.();
    // Custom adapters may report health asynchronously; surface them as
    // connected with a flag rather than blocking the synchronous health path.
    if (result && typeof result.then === "function") return { provider: provider.code, connected: true, asynchronous: true };
    return result || { provider: provider.code, connected: true };
  } catch (error) {
    return { provider: provider.code, connected: false, error: error.message };
  }
}

// ── Topics ──────────────────────────────────────────────────────────────────
export function listTopics(db, { tenantId, status, q, page = 1, pageSize = 50 } = {}) {
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
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM event_topics ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM event_topics ${where} ORDER BY code LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicTopic(r, { stats: topicStats(db, r.code) })), total, page: Number(page), page_size: Number(pageSize) };
}

export function getTopicRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM event_topics WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
}

export function getTopic(db, refValue) {
  const row = getTopicRow(db, refValue);
  if (!row) throw new HttpError(404, "Topic not found");
  return publicTopic(row, { stats: topicStats(db, row.code) });
}

export function createTopic(db, input = {}, actor = null, tenantId = null) {
  assertCode(input.code, "Topic code");
  const existing = getTopicRow(db, input.code);
  if (existing) return publicTopic(existing);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO event_topics
      (code, name, description, event_type_code, partitions, retention_hours, max_message_bytes, status, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      input.description || "",
      input.event_type_code || null,
      clampInt(input.partitions, 1, 256, 1),
      clampInt(input.retention_hours, 1, 87600, 168),
      clampInt(input.max_message_bytes, 1024, 10485760, 262144),
      input.status || "active",
      tenantId ?? input.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  return publicTopic(queryOne(db, "SELECT * FROM event_topics WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function updateTopic(db, refValue, input = {}) {
  const row = getTopicRow(db, refValue);
  if (!row) throw new HttpError(404, "Topic not found");
  run(
    db,
    `UPDATE event_topics SET name=?, description=?, event_type_code=?, partitions=?, retention_hours=?, max_message_bytes=?, status=?, updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.description ?? row.description,
      input.event_type_code !== undefined ? input.event_type_code : row.event_type_code,
      input.partitions !== undefined ? clampInt(input.partitions, 1, 256, row.partitions) : row.partitions,
      input.retention_hours !== undefined ? clampInt(input.retention_hours, 1, 87600, row.retention_hours) : row.retention_hours,
      input.max_message_bytes !== undefined ? clampInt(input.max_message_bytes, 1024, 10485760, row.max_message_bytes) : row.max_message_bytes,
      input.status ?? row.status,
      nowIso(),
      row.id,
    ]
  );
  return publicTopic(queryOne(db, "SELECT * FROM event_topics WHERE id = ?", [row.id]));
}

export function deleteTopic(db, refValue) {
  const row = getTopicRow(db, refValue);
  if (!row) throw new HttpError(404, "Topic not found");
  const used = queryOne(db, "SELECT COUNT(*) AS c FROM event_subscriptions WHERE topic_code = ?", [row.code]).c;
  if (used) throw new HttpError(409, "Topic is referenced by subscriptions");
  run(db, "DELETE FROM event_topics WHERE id = ?", [row.id]);
  return { deleted: true, id: row.id };
}

export function topicStats(db, code) {
  const subs = queryOne(db, "SELECT COUNT(*) AS c FROM event_subscriptions WHERE topic_code = ?", [code]).c;
  const dl = queryOne(db, "SELECT COUNT(*) AS c FROM event_deliveries WHERE topic_code = ?", [code]).c;
  return { subscriptions: subs, deliveries: dl };
}

// ── Queues ──────────────────────────────────────────────────────────────────
export function listQueues(db, { tenantId, status, q, page = 1, pageSize = 50 } = {}) {
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
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM event_queues ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM event_queues ${where} ORDER BY code LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicQueue(r, { stats: queueStats(db, r.code) })), total, page: Number(page), page_size: Number(pageSize) };
}

export function getQueueRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM event_queues WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
}

export function getQueue(db, refValue) {
  const row = getQueueRow(db, refValue);
  if (!row) throw new HttpError(404, "Queue not found");
  return publicQueue(row, { stats: queueStats(db, row.code) });
}

export function createQueue(db, input = {}, actor = null, tenantId = null) {
  assertCode(input.code, "Queue code");
  const existing = getQueueRow(db, input.code);
  if (existing) return publicQueue(existing);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO event_queues
      (code, name, description, consumer_group, max_concurrency, visibility_timeout_seconds, max_attempts, retention_days, dead_letter_enabled, status, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      input.description || "",
      input.consumer_group || "",
      clampInt(input.max_concurrency, 1, 64, 4),
      clampInt(input.visibility_timeout_seconds, 1, 86400, 300),
      clampInt(input.max_attempts, 1, 50, 5),
      clampInt(input.retention_days, 1, 3650, 30),
      input.dead_letter_enabled === false ? 0 : 1,
      input.status || "active",
      tenantId ?? input.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  return publicQueue(queryOne(db, "SELECT * FROM event_queues WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function updateQueue(db, refValue, input = {}) {
  const row = getQueueRow(db, refValue);
  if (!row) throw new HttpError(404, "Queue not found");
  run(
    db,
    `UPDATE event_queues SET name=?, description=?, consumer_group=?, max_concurrency=?, visibility_timeout_seconds=?, max_attempts=?, retention_days=?, dead_letter_enabled=?, status=?, updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.description ?? row.description,
      input.consumer_group !== undefined ? input.consumer_group : row.consumer_group,
      input.max_concurrency !== undefined ? clampInt(input.max_concurrency, 1, 64, row.max_concurrency) : row.max_concurrency,
      input.visibility_timeout_seconds !== undefined ? clampInt(input.visibility_timeout_seconds, 1, 86400, row.visibility_timeout_seconds) : row.visibility_timeout_seconds,
      input.max_attempts !== undefined ? clampInt(input.max_attempts, 1, 50, row.max_attempts) : row.max_attempts,
      input.retention_days !== undefined ? clampInt(input.retention_days, 1, 3650, row.retention_days) : row.retention_days,
      input.dead_letter_enabled !== undefined ? (input.dead_letter_enabled ? 1 : 0) : row.dead_letter_enabled,
      input.status ?? row.status,
      nowIso(),
      row.id,
    ]
  );
  return publicQueue(queryOne(db, "SELECT * FROM event_queues WHERE id = ?", [row.id]));
}

export function deleteQueue(db, refValue) {
  const row = getQueueRow(db, refValue);
  if (!row) throw new HttpError(404, "Queue not found");
  const used = queryOne(db, "SELECT COUNT(*) AS c FROM event_subscriptions WHERE queue_code = ?", [row.code]).c;
  if (used) throw new HttpError(409, "Queue is referenced by subscriptions");
  run(db, "DELETE FROM event_queues WHERE id = ?", [row.id]);
  return { deleted: true, id: row.id };
}

// Queue depth, due count and consumer lag drive back-pressure and dashboards.
export function queueStats(db, code) {
  const counts = queryOne(
    db,
    `SELECT
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
       SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retry,
       SUM(CASE WHEN status = 'out_of_order' THEN 1 ELSE 0 END) AS out_of_order,
       SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN status IN ('failed','dead_letter') THEN 1 ELSE 0 END) AS failed,
       COUNT(*) AS total
     FROM event_deliveries WHERE queue_code = ?`,
    [code]
  );
  const due = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM event_deliveries
      WHERE queue_code = ? AND status IN ('pending','retry','out_of_order')
        AND (available_at IS NULL OR available_at <= ?)`,
    [code, nowIso()]
  ).c;
  const pending = counts?.pending || 0;
  const processing = counts?.processing || 0;
  const retry = counts?.retry || 0;
  const outOfOrder = counts?.out_of_order || 0;
  return {
    total: counts?.total || 0,
    pending,
    processing,
    retry,
    out_of_order: outOfOrder,
    delivered: counts?.delivered || 0,
    failed: counts?.failed || 0,
    due,
    depth: pending + retry + outOfOrder,
  };
}

export function queueDepth(db, { tenantId = null } = {}) {
  const clause = tenantId !== undefined && tenantId !== null ? "WHERE tenant_id = ?" : "";
  const params = tenantId !== undefined && tenantId !== null ? [Number(tenantId)] : [];
  const row = queryOne(
    db,
    `SELECT
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
       SUM(CASE WHEN status = 'retry' THEN 1 ELSE 0 END) AS retry,
       SUM(CASE WHEN status = 'out_of_order' THEN 1 ELSE 0 END) AS out_of_order,
       COUNT(*) AS total
     FROM event_deliveries ${clause}`,
    params
  );
  const due = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM event_deliveries
      WHERE status IN ('pending','retry','out_of_order') AND (available_at IS NULL OR available_at <= ?)
      ${tenantId !== undefined && tenantId !== null ? "AND tenant_id = ?" : ""}`,
    tenantId !== undefined && tenantId !== null ? [nowIso(), Number(tenantId)] : [nowIso()]
  ).c;
  return {
    total: row?.total || 0,
    pending: row?.pending || 0,
    processing: row?.processing || 0,
    retry: row?.retry || 0,
    out_of_order: row?.out_of_order || 0,
    due,
    depth: (row?.pending || 0) + (row?.retry || 0) + (row?.out_of_order || 0),
  };
}

export function listQueueStats(db, { tenantId = null } = {}) {
  const queues = listQueues(db, { tenantId, pageSize: 200 }).items;
  return queues.map((queue) => ({ ...queue, stats: queueStats(db, queue.code) }));
}

// ── Consumer groups ─────────────────────────────────────────────────────────
export function listConsumerGroups(db, { tenantId, status, page = 1, pageSize = 50 } = {}) {
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
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM event_consumer_groups ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM event_consumer_groups ${where} ORDER BY code LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicConsumerGroup(r, { stats: consumerGroupStats(db, r.code) })), total, page: Number(page), page_size: Number(pageSize) };
}

export function getConsumerGroupRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM event_consumer_groups WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
}

export function getConsumerGroup(db, refValue) {
  const row = getConsumerGroupRow(db, refValue);
  if (!row) throw new HttpError(404, "Consumer group not found");
  return publicConsumerGroup(row, { stats: consumerGroupStats(db, row.code) });
}

export function createConsumerGroup(db, input = {}, actor = null, tenantId = null) {
  assertCode(input.code, "Consumer group code");
  const existing = getConsumerGroupRow(db, input.code);
  if (existing) return publicConsumerGroup(existing);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO event_consumer_groups
      (code, name, topic_code, queue_code, partition_strategy, max_concurrency, ordering_required, members, status, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      input.topic_code || "",
      input.queue_code || "",
      input.partition_strategy || "key_hash",
      clampInt(input.max_concurrency, 1, 64, 4),
      input.ordering_required ? 1 : 0,
      clampInt(input.members, 0, 256, 0),
      input.status || "active",
      tenantId ?? input.tenant_id ?? null,
      ts,
      ts,
    ]
  );
  return publicConsumerGroup(queryOne(db, "SELECT * FROM event_consumer_groups WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function updateConsumerGroup(db, refValue, input = {}) {
  const row = getConsumerGroupRow(db, refValue);
  if (!row) throw new HttpError(404, "Consumer group not found");
  run(
    db,
    `UPDATE event_consumer_groups SET name=?, topic_code=?, queue_code=?, partition_strategy=?, max_concurrency=?, ordering_required=?, members=?, status=?, updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.topic_code !== undefined ? input.topic_code : row.topic_code,
      input.queue_code !== undefined ? input.queue_code : row.queue_code,
      input.partition_strategy ?? row.partition_strategy,
      input.max_concurrency !== undefined ? clampInt(input.max_concurrency, 1, 64, row.max_concurrency) : row.max_concurrency,
      input.ordering_required !== undefined ? (input.ordering_required ? 1 : 0) : row.ordering_required,
      input.members !== undefined ? clampInt(input.members, 0, 256, row.members) : row.members,
      input.status ?? row.status,
      nowIso(),
      row.id,
    ]
  );
  return publicConsumerGroup(queryOne(db, "SELECT * FROM event_consumer_groups WHERE id = ?", [row.id]));
}

export function deleteConsumerGroup(db, refValue) {
  const row = getConsumerGroupRow(db, refValue);
  if (!row) throw new HttpError(404, "Consumer group not found");
  run(db, "DELETE FROM event_consumer_groups WHERE id = ?", [row.id]);
  return { deleted: true, id: row.id };
}

export function consumerGroupStats(db, code) {
  const subs = queryOne(db, "SELECT COUNT(*) AS c FROM event_subscriptions WHERE consumer_group = ?", [code]).c;
  const stats = queryOne(
    db,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
       SUM(CASE WHEN status IN ('failed','dead_letter') THEN 1 ELSE 0 END) AS failed
     FROM event_deliveries WHERE consumer_group = ?`,
    [code]
  );
  return { subscriptions: subs, deliveries: stats?.total || 0, delivered: stats?.delivered || 0, failed: stats?.failed || 0 };
}

// Consumer lag = backlog divided by observed throughput over the window. It is
// intentionally a simple, provider-independent estimate.
export function consumerLag(db, { tenantId = null, windowMinutes = 60 } = {}) {
  const since = new Date(Date.now() - Number(windowMinutes) * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  const clause = tenantId !== undefined && tenantId !== null ? "AND tenant_id = ?" : "";
  const params = tenantId !== undefined && tenantId !== null ? [Number(tenantId)] : [];
  const delivered = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM event_deliveries WHERE status = 'delivered' AND updated_at >= ? ${clause}`,
    [since, ...params]
  ).c;
  const backlog = queueDepth(db, { tenantId }).depth;
  const ratePerMinute = windowMinutes > 0 ? delivered / windowMinutes : 0;
  const minutes = ratePerMinute > 0 ? backlog / ratePerMinute : null;
  return {
    backlog,
    delivered_in_window: delivered,
    window_minutes: Number(windowMinutes),
    throughput_per_minute: Number(ratePerMinute.toFixed(2)),
    lag_minutes: minutes === null ? null : Number(minutes.toFixed(2)),
  };
}

export function topologyHealth(db, { tenantId = null } = {}) {
  const queues = listQueueStats(db, { tenantId });
  const unhealthy = queues.filter((queue) => queue.status !== "active" || queue.stats.failed > 0);
  return {
    queues: queues.length,
    unhealthy: unhealthy.length,
    queue_depth: queueDepth(db, { tenantId }),
    consumer_lag: consumerLag(db, { tenantId }),
    broker: brokerHealth(db),
  };
}

// Default topology registered at seed time so operators start from a working
// configuration. Idempotent.
const DEFAULT_TOPIC = { code: "domain-events", name: "Domain events", description: "Platform-wide domain event stream" };
const DEFAULT_QUEUE = { code: "event-consumers", name: "Event consumers", description: "Default asynchronous event consumer queue", consumer_group: "event-default" };
const DEFAULT_GROUP = { code: "event-default", name: "Default event consumers", topic_code: "domain-events", queue_code: "event-consumers" };

export function ensureDefaultTopology(db) {
  const topic = createTopic(db, DEFAULT_TOPIC);
  const queue = createQueue(db, DEFAULT_QUEUE);
  const group = createConsumerGroup(db, DEFAULT_GROUP);
  return { topic: topic.code, queue: queue.code, consumer_group: group.code };
}

export const DEFAULT_TOPIC_CODE = DEFAULT_TOPIC.code;
export const DEFAULT_QUEUE_CODE = DEFAULT_QUEUE.code;
export const DEFAULT_CONSUMER_GROUP = DEFAULT_GROUP.code;
