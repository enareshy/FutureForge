// Event Publisher.
//
// The publisher is the single write path for domain events. It validates the
// envelope and payload against the Schema Registry, applies tenant/security
// context, assigns ordering keys and persists the event. By default it uses the
// Transactional Outbox so a business transaction and its event are atomic; the
// low-level `publishEventNow` path routes synchronously for infrastructure
// events that do not need the outbox.
import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { HttpError } from "../../validation.js";
import {
  buildEnvelope,
  validateEnvelope,
  validatePayloadAgainstSchema,
  safeParse,
  toJson,
  clampInt,
  orderingPartitionKey,
  normalizeDeliveryStatus,
} from "./validation.js";
import { publicEvent, publicDelivery, eventUuid, ref } from "./repository.js";
import { getEventTypeRow, createEventType, resolveSchema } from "./registry.js";
import { enqueueOutbox } from "./outbox.js";
import { routeEvent } from "./router.js";
import { nextSequence } from "./ordering.js";
import { auditEvent, log } from "./hooks.js";

export function serializeEvent(event) {
  return JSON.stringify(event);
}

// Resolves the event type, builds and validates the envelope + payload. Returns
// the normalised envelope plus the registry row and resolved schema.
export function validateEvent(db, input = {}, { actor = null, tenantId = null, strictType = false, validatePayload = true } = {}) {
  const rawType = input.event_type_code || input.eventTypeCode || input.event_type || input.eventType;
  if (!rawType) throw new HttpError(400, "event_type_code is required");
  let type = getEventTypeRow(db, rawType);
  if (!type) {
    if (strictType) throw new HttpError(400, `Unknown event type ${rawType}`);
    const created = createEventType(db, {
      code: rawType,
      name: String(rawType).replace(/([A-Z])/g, " $1").trim() || rawType,
      source_module: input.source_module || input.sourceModule || "unknown",
      category: input.category || "domain",
    });
    type = getEventTypeRow(db, created.code);
  }
  if (!type.enabled || type.status === "retired") throw new HttpError(400, `Event type ${type.code} is not enabled`);
  const envelope = buildEnvelope(input, { actor, tenantId, eventType: type });
  validateEnvelope(envelope, type);
  const resolved = resolveSchema(db, type.code, envelope.event_version, { strict: false });
  const schema = resolved.schema;
  if (validatePayload) {
    const errors = validatePayloadAgainstSchema(envelope.payload, schema);
    if (errors.length) {
      const error = new HttpError(400, `Event payload does not match schema: ${errors.join("; ")}`);
      error.category = "schema";
      error.code = "schema_mismatch";
      throw error;
    }
  }
  return { envelope, type, schema, resolvedVersion: resolved.version };
}

function buildEventRecord(db, envelope, type) {
  const partitionKey = orderingPartitionKey(envelope, type);
  const sequence = type.ordering_required || envelope.ordering_scope !== "none" ? nextSequence(db, partitionKey) : null;
  return { ...envelope, partition_key: partitionKey || envelope.partition_key, sequence_number: sequence };
}

// Publishes one event. `useOutbox` (default true) makes publication atomic with
// the caller's transaction; `immediate` routes synchronously.
export function publishEvent(db, input = {}, actor = null, options = {}) {
  const tenantId = options.tenantId ?? input.tenant_id ?? actor?.tenant_id ?? null;
  const useOutbox = options.useOutbox === undefined ? !options.immediate : Boolean(options.useOutbox);
  const idempotencyKey = input.idempotency_key ?? input.idempotencyKey ?? null;
  if (idempotencyKey) {
    const existing = queryOne(db, "SELECT * FROM event_records WHERE idempotency_key = ?", [idempotencyKey]);
    if (existing) {
      return { ...publicEvent(existing, { includePayload: true }), duplicate: true, deliveries: [] };
    }
  }
  const { envelope, type } = validateEvent(db, input, { actor, tenantId, ...options });
  const ts = nowIso();
  const eventRef = envelope.event_ref || ref("EVT");
  const eventIdUuid = input.event_id || eventUuid();
  const traceId = envelope.trace_id || input.trace_id || null;
  const status = useOutbox ? "queued" : "published";

  const persist = () => {
    const record = buildEventRecord(db, envelope, type);
    const result = run(
      db,
      `INSERT INTO event_records
        (event_id, event_ref, event_type_code, event_version, source_module, source_system, source_object_type, source_object_id,
         source_object_revision, actor_id, actor_type, correlation_id, causation_id, trace_id, parent_event_id, sequence_number,
         partition_key, priority, payload_json, payload_schema_version, metadata_json, security_classification, status,
         subscriber_count, delivered_count, failed_count, tenant_id, organization_id, plant_id, site_id, idempotency_key,
         occurred_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        eventIdUuid,
        eventRef,
        envelope.event_type_code,
        envelope.event_version,
        envelope.source_module,
        envelope.source_system,
        envelope.source_object_type,
        envelope.source_object_id === undefined || envelope.source_object_id === null ? null : String(envelope.source_object_id),
        envelope.source_object_revision === undefined || envelope.source_object_revision === null ? null : String(envelope.source_object_revision),
        envelope.actor_id,
        envelope.actor_type,
        envelope.correlation_id || null,
        envelope.causation_id || null,
        traceId,
        envelope.parent_event_id ?? null,
        record.sequence_number,
        record.partition_key ?? null,
        envelope.priority,
        toJson(envelope.payload, {}),
        envelope.payload_schema_version,
        toJson(envelope.metadata, {}),
        envelope.security_classification,
        status,
        tenantId,
        input.organization_id ?? envelope.metadata?.organization_id ?? null,
        input.plant_id ?? envelope.metadata?.plant_id ?? null,
        input.site_id ?? envelope.metadata?.site_id ?? null,
        idempotencyKey,
        envelope.occurred_at,
        ts,
        ts,
      ]
    );
    const id = Number(result.lastInsertRowid);
    if (useOutbox) {
      enqueueOutbox(db, {
        event_ref: eventRef,
        event_type_code: envelope.event_type_code,
        event_version: envelope.event_version,
        payload: envelope.payload,
        metadata: envelope.metadata,
        aggregate_type: envelope.source_object_type,
        aggregate_id: envelope.source_object_id,
        correlation_id: envelope.correlation_id,
        tenant_id: tenantId,
      });
    }
    return queryOne(db, "SELECT * FROM event_records WHERE id = ?", [id]);
  };

  // When the caller already opened a transaction (business write + outbox), we
  // reuse it. Otherwise we create one so record + outbox commit together.
  const eventRow = db.__inTransaction ? persist() : transaction(db, persist);

  let deliveries = [];
  if (!useOutbox) {
    const routeResult = routeEvent(db, eventRow, { trigger: options.trigger || "publish" });
    deliveries = routeResult.deliveries;
  }

  auditEvent(db, {
    actor,
    action: "event.publish",
    resourceType: "event_record",
    resourceId: eventRow.id,
    details: { event_type: envelope.event_type_code, event_ref: eventRef, queued: useOutbox, subscribers: deliveries.length },
    correlation: envelope.correlation_id,
    category: "data",
  });
  log("info", "event.published", { event_ref: eventRef, event_type: envelope.event_type_code, queued: useOutbox });
  return { ...publicEvent(eventRow, { includePayload: true }), deliveries, queued: useOutbox };
}

// Publishes many events, each with an independent transaction. Returns both the
// accepted events and per-item failures so one bad event never blocks a batch.
export function publishBatch(db, inputs = [], actor = null, options = {}) {
  const items = Array.isArray(inputs) ? inputs : inputs.events || [];
  const events = [];
  const failures = [];
  for (const input of items) {
    try {
      events.push(publishEvent(db, input, actor, options));
    } catch (error) {
      failures.push({ event_type_code: input?.event_type_code || input?.event_type || null, error: error.message, category: error.category || "business_validation" });
    }
  }
  return { total: items.length, published: events.length, failed: failures.length, events, failures };
}

// `publishAsync` and `publishWithCorrelation` are convenience shapes required by
// the framework contract. Async publishing always goes through the outbox.
export function publishAsync(db, input = {}, actor = null, options = {}) {
  return publishEvent(db, input, actor, { ...options, useOutbox: true, immediate: false });
}

export function publishWithCorrelation(db, input = {}, actor = null, options = {}) {
  const correlationId = input.correlation_id || input.correlationId || ref("COR");
  return publishEvent(db, { ...input, correlation_id: correlationId }, actor, options);
}

// Routes an already-stored event (used by the outbox, replay and manual
// re-route). Returns the created deliveries.
export function routeStoredEvent(db, refValue, options = {}) {
  const row = getEventRow(db, refValue);
  if (!row) throw new HttpError(404, "Event not found");
  return routeEvent(db, row, options);
}

export { routeEvent };

// ── Event queries ───────────────────────────────────────────────────────────
export function getEventRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM event_records WHERE id = ? OR event_ref = ? OR event_id = ?", [
    Number.isFinite(id) ? id : -1,
    String(refValue),
    String(refValue),
  ]);
}

export function getEvent(db, refValue, { includePayload = false } = {}) {
  const row = getEventRow(db, refValue);
  if (!row) throw new HttpError(404, "Event not found");
  const deliveries = listDeliveries(db, { eventId: row.id });
  return { ...publicEvent(row, { includePayload }), deliveries: deliveries.items };
}

export function listEvents(db, { tenantId, eventTypeCode, eventVersion, sourceModule, status, correlationId, traceId, objectId, q, from, to, page = 1, pageSize = 50 } = {}) {
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
  if (eventVersion) {
    clauses.push("event_version = ?");
    params.push(Number(eventVersion));
  }
  if (sourceModule) {
    clauses.push("source_module = ?");
    params.push(sourceModule);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (correlationId) {
    clauses.push("correlation_id = ?");
    params.push(correlationId);
  }
  if (traceId) {
    clauses.push("trace_id = ?");
    params.push(traceId);
  }
  if (objectId) {
    clauses.push("source_object_id = ?");
    params.push(String(objectId));
  }
  if (from) {
    clauses.push("created_at >= ?");
    params.push(from);
  }
  if (to) {
    clauses.push("created_at <= ?");
    params.push(to);
  }
  if (q) {
    clauses.push("(LOWER(event_ref) LIKE ? OR LOWER(event_type_code) LIKE ? OR LOWER(correlation_id) LIKE ? OR LOWER(source_object_id) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM event_records ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM event_records ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicEvent(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function listDeliveries(db, { tenantId, eventId, eventRef, subscriptionId, status, handler, correlationId, queueCode, q, page = 1, pageSize = 50 } = {}) {
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
  if (eventRef) {
    clauses.push("event_ref = ?");
    params.push(String(eventRef));
  }
  if (subscriptionId) {
    clauses.push("subscription_id = ?");
    params.push(Number(subscriptionId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (handler) {
    clauses.push("handler = ?");
    params.push(handler);
  }
  if (correlationId) {
    clauses.push("correlation_id = ?");
    params.push(correlationId);
  }
  if (queueCode) {
    clauses.push("queue_code = ?");
    params.push(queueCode);
  }
  if (q) {
    clauses.push("(LOWER(event_ref) LIKE ? OR LOWER(event_type_code) LIKE ? OR LOWER(handler) LIKE ? OR LOWER(subscriber) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM event_deliveries ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM event_deliveries ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicDelivery(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function normalizeStatusFilter(status) {
  return status ? normalizeDeliveryStatus(status) : null;
}
