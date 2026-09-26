import { queryAll, queryOne, run, nowIso, randomUuid } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { homeTenantId } from "../tenants.js";
import { safeParse, assertChannel, assertPriority } from "./validation.js";

// Delivery request model. A request is the canonical, self-contained unit of
// outbound work: everything the worker needs to hand a rendered message to a
// provider, plus the full delivery-tracking lifecycle. Producers (the
// Notification Management module and other business modules) submit requests
// through `submitRequest`; they never touch the queue or providers.

const TERMINAL = ["sent", "delivered", "cancelled", "dead_lettered"];

function insertRequest(db, fields) {
  const columns = Object.keys(fields);
  const placeholders = columns.map(() => "?").join(", ");
  const result = run(
    db,
    `INSERT INTO delivery_requests (${columns.join(", ")}) VALUES (${placeholders})`,
    columns.map((column) => fields[column])
  );
  return result.lastInsertRowid;
}

export function publicRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    request_ref: row.request_ref,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    site_id: row.site_id ?? null,
    department_id: row.department_id ?? null,
    notification_id: row.notification_id ?? null,
    event_id: row.event_id ?? null,
    source_module: row.source_module || "platform",
    recipient_id: row.recipient_id ?? null,
    recipient_name: row.recipient_name || "",
    recipient_address: row.recipient_address || "",
    recipient: safeParse(row.recipient_json, {}),
    channel: row.channel,
    provider_id: row.provider_id ?? null,
    provider_code: row.provider_code || "",
    subject: row.subject || "",
    body: row.body || "",
    content_ref: row.content_ref || "",
    priority: row.priority,
    status: row.status,
    status_label: String(row.status || "").toUpperCase(),
    attempt: row.attempt,
    max_attempts: row.max_attempts,
    scheduled_at: row.scheduled_at,
    queued_at: row.queued_at || null,
    processing_at: row.processing_at || null,
    sent_at: row.sent_at || null,
    delivered_at: row.delivered_at || null,
    last_retry_at: row.last_retry_at || null,
    processed_at: row.processed_at || null,
    error_code: row.error_code || "",
    error_message: row.error_message || "",
    provider_response: safeParse(row.provider_response_json, {}),
    correlation_id: row.correlation_id || "",
    idempotency_key: row.idempotency_key || null,
    object_type: row.object_type || "",
    object_id: row.object_id || "",
    object_name: row.object_name || "",
    deep_link: row.deep_link || "",
    related: safeParse(row.related_json, {}),
    dead_letter: row.dead_letter === 1,
    cancelled_at: row.cancelled_at || null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeInput(input = {}, actor = null) {
  const recipient = input.recipient || {};
  const tenantId = input.tenant_id ?? input.tenantId ?? actor?.tenant_id ?? null;
  const priority = input.priority || "normal";
  return {
    tenant_id: tenantId !== null && tenantId !== undefined ? Number(tenantId) : null,
    organization_id: Number(input.organization_id ?? input.organizationId ?? actor?.organization_id ?? 0) || null,
    plant_id: input.plant_id ?? input.plantId ?? null,
    site_id: input.site_id ?? input.siteId ?? null,
    department_id: input.department_id ?? input.departmentId ?? null,
    notification_id: input.notification_id ?? input.notificationId ?? null,
    event_id: input.event_id ?? input.eventId ?? null,
    source_module: input.source_module ?? input.sourceModule ?? "platform",
    recipient_id: input.recipient_id ?? input.recipientId ?? recipient.id ?? null,
    recipient_name: input.recipient_name ?? input.recipientName ?? recipient.name ?? recipient.display_name ?? "",
    recipient_address: input.recipient_address ?? input.recipientAddress ?? recipient.address ?? recipient.email ?? "",
    recipient_json: input.recipient_json ?? input.recipientJson ?? (input.recipient ? JSON.stringify(input.recipient) : "{}"),
    channel: input.channel,
    provider_code: input.provider_code ?? input.providerCode ?? "",
    subject: input.subject ?? "",
    body: input.body ?? "",
    content_ref: input.content_ref ?? input.contentRef ?? "",
    priority,
    scheduled_at: input.scheduled_at ?? input.scheduledAt ?? null,
    delay_seconds: Number(input.delay_seconds ?? input.delaySeconds ?? 0) || 0,
    correlation_id: input.correlation_id ?? input.correlationId ?? "",
    idempotency_key: input.idempotency_key ?? input.idempotencyKey ?? null,
    object_type: input.object_type ?? input.objectType ?? "",
    object_id: input.object_id ?? input.objectId ?? "",
    object_name: input.object_name ?? input.objectName ?? "",
    deep_link: input.deep_link ?? input.deepLink ?? "",
    related_json: input.related ? JSON.stringify(input.related) : (input.related_json ?? input.relatedJson ?? "{}"),
    max_attempts: input.max_attempts ?? input.maxAttempts ?? null,
    created_by: actor?.id ?? input.created_by ?? input.createdBy ?? null,
  };
}

function assertRequestInput(input) {
  if (!input.channel) throw new HttpError(400, "channel is required");
  assertChannel(input.channel);
  assertPriority(input.priority);
  if (!input.subject && !input.body && !input.content_ref) {
    throw new HttpError(400, "a request needs a subject, body or secure content reference");
  }
  if (input.channel === "email" && !input.recipient_address && !input.content_ref) {
    throw new HttpError(400, "email requests require a recipient address");
  }
}

// Submits a delivery request. Idempotent on idempotency_key: resubmitting the
// same key returns the existing request instead of queueing a duplicate.
export function submitRequest(db, input = {}, { actor = null, ip = null } = {}) {
  const normalized = normalizeInput(input, actor);
  assertRequestInput(normalized);
  if (normalized.idempotency_key) {
    const existing = queryOne(db, "SELECT * FROM delivery_requests WHERE idempotency_key = ?", [normalized.idempotency_key]);
    if (existing) return { ...publicRequest(existing), duplicate: true };
  }
  const ts = nowIso();
  const scheduledAt = normalized.scheduled_at
    || (normalized.delay_seconds > 0
      ? new Date(Date.now() + normalized.delay_seconds * 1000).toISOString().replace("T", " ").slice(0, 19)
      : ts);
  const maxAttempts = Math.max(1, Math.min(50, Number(normalized.max_attempts) || 5));
  const id = insertRequest(db, {
    request_ref: randomUuid(),
    tenant_id: normalized.tenant_id,
    organization_id: normalized.organization_id,
    plant_id: normalized.plant_id,
    site_id: normalized.site_id,
    department_id: normalized.department_id,
    notification_id: normalized.notification_id,
    event_id: normalized.event_id,
    source_module: normalized.source_module,
    recipient_id: normalized.recipient_id,
    recipient_name: normalized.recipient_name,
    recipient_address: normalized.recipient_address,
    recipient_json: normalized.recipient_json,
    channel: normalized.channel,
    provider_code: normalized.provider_code,
    subject: normalized.subject,
    body: normalized.body,
    content_ref: normalized.content_ref,
    priority: normalized.priority,
    status: "queued",
    attempt: 0,
    max_attempts: maxAttempts,
    scheduled_at: scheduledAt,
    queued_at: ts,
    correlation_id: normalized.correlation_id,
    idempotency_key: normalized.idempotency_key,
    object_type: normalized.object_type,
    object_id: normalized.object_id,
    object_name: normalized.object_name,
    deep_link: normalized.deep_link,
    related_json: normalized.related_json,
    created_by: normalized.created_by,
    created_at: ts,
    updated_at: ts,
  });
  writeAudit(db, {
    actor,
    action: "delivery.request.create",
    resourceType: "delivery_request",
    resourceId: id,
    details: { channel: normalized.channel, priority: normalized.priority, source_module: normalized.source_module, notification_id: normalized.notification_id },
    ip,
  });
  return publicRequest(queryOne(db, "SELECT * FROM delivery_requests WHERE id = ?", [id]));
}

export function getRequest(db, id, tenantId = null) {
  const row = queryOne(db, "SELECT * FROM delivery_requests WHERE id = ? OR request_ref = ?", [Number(id) || -1, String(id)]);
  if (!row) throw new HttpError(404, "Delivery request not found");
  if (tenantId && Number(row.tenant_id) !== Number(tenantId)) throw new HttpError(404, "Delivery request not found");
  return publicRequest(row);
}

export function getRequestRow(db, id, tenantId = null) {
  const row = queryOne(db, "SELECT * FROM delivery_requests WHERE id = ? OR request_ref = ?", [Number(id) || -1, String(id)]);
  if (!row) throw new HttpError(404, "Delivery request not found");
  if (tenantId && Number(row.tenant_id) !== Number(tenantId)) throw new HttpError(404, "Delivery request not found");
  return row;
}

export function listRequests(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  const scopedTenant = tenantId ?? (query.tenantId !== undefined && query.tenantId !== "" ? Number(query.tenantId) : null);
  if (scopedTenant) {
    where.push("COALESCE(tenant_id, 0) = ?");
    params.push(Number(scopedTenant));
  }
  if (query.status) {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.channel) {
    where.push("channel = ?");
    params.push(query.channel);
  }
  if (query.provider || query.provider_code || query.providerCode) {
    where.push("provider_code = ?");
    params.push(query.provider || query.provider_code || query.providerCode);
  }
  if (query.module || query.source_module || query.sourceModule) {
    where.push("source_module = ?");
    params.push(query.module || query.source_module || query.sourceModule);
  }
  if (query.notificationId || query.notification_id) {
    where.push("notification_id = ?");
    params.push(Number(query.notificationId || query.notification_id));
  }
  if (query.eventId || query.event_id) {
    where.push("event_id = ?");
    params.push(Number(query.eventId || query.event_id));
  }
  if (query.recipientId || query.recipient_id) {
    where.push("recipient_id = ?");
    params.push(Number(query.recipientId || query.recipient_id));
  }
  if (query.status === "dead_lettered" || query.deadLetter === "true" || query.dead_letter === "true") {
    where.push("dead_letter = 1");
  }
  if (query.from || query.dateFrom) {
    where.push("created_at >= ?");
    params.push(String(query.from || query.dateFrom));
  }
  if (query.to || query.dateTo) {
    where.push("created_at <= ?");
    params.push(String(query.to || query.dateTo));
  }
  if (query.q) {
    const like = `%${query.q}%`;
    where.push("(subject LIKE ? OR recipient_address LIKE ? OR recipient_name LIKE ? OR error_message LIKE ? OR request_ref LIKE ? OR object_name LIKE ?)");
    params.push(like, like, like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM delivery_requests ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT * FROM delivery_requests ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicRequest);
  return { items, total, page, pageSize };
}

export function cancelRequest(db, id, { tenantId = null, actor = null, ip = null } = {}) {
  const row = getRequestRow(db, id, tenantId);
  if (TERMINAL.includes(row.status)) {
    return { cancelled: false, reason: "already_terminal", request: publicRequest(row) };
  }
  const ts = nowIso();
  run(
    db,
    "UPDATE delivery_requests SET status = 'cancelled', cancelled_at = ?, dead_letter = 0, updated_at = ? WHERE id = ?",
    [ts, ts, row.id]
  );
  writeAudit(db, { actor, action: "delivery.request.cancel", resourceType: "delivery_request", resourceId: row.id, details: { channel: row.channel }, ip });
  return { cancelled: true, request: publicRequest(queryOne(db, "SELECT * FROM delivery_requests WHERE id = ?", [row.id])) };
}

// Manual retry by an authorized administrator. Requeues a failed/dead-lettered
// request immediately and clears the dead-letter flag.
export function retryRequest(db, id, { tenantId = null, actor = null, ip = null } = {}) {
  const row = getRequestRow(db, id, tenantId);
  if (!["failed", "dead_lettered"].includes(row.status) && row.dead_letter !== 1) {
    return { retried: false, reason: "not_failed", request: publicRequest(row) };
  }
  const ts = nowIso();
  run(
    db,
    `UPDATE delivery_requests
        SET status = 'queued', dead_letter = 0, scheduled_at = ?, queued_at = ?, last_retry_at = ?,
            processed_at = NULL, error_code = '', error_message = '', updated_at = ?
      WHERE id = ?`,
    [ts, ts, ts, ts, row.id]
  );
  writeAudit(db, { actor, action: "delivery.request.retry", resourceType: "delivery_request", resourceId: row.id, details: { channel: row.channel, attempt: row.attempt }, ip });
  return { retried: true, request: publicRequest(queryOne(db, "SELECT * FROM delivery_requests WHERE id = ?", [row.id])) };
}

export function listAttempts(db, requestId) {
  return queryAll(db, "SELECT * FROM delivery_attempts WHERE request_id = ? ORDER BY attempt, id", [Number(requestId)]).map((row) => ({
    id: row.id,
    request_id: row.request_id,
    attempt: row.attempt,
    provider_id: row.provider_id ?? null,
    provider_code: row.provider_code || "",
    channel: row.channel || "",
    status: row.status,
    error_code: row.error_code || "",
    error_message: row.error_message || "",
    response: safeParse(row.response_json, {}),
    duration_ms: row.duration_ms ?? null,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    created_at: row.created_at,
  }));
}

export function requestsForNotification(db, notificationId) {
  return queryAll(db, "SELECT * FROM delivery_requests WHERE notification_id = ? ORDER BY id", [Number(notificationId)]).map(publicRequest);
}

export function resolveRequestTenant(db, input, actor) {
  return input?.tenant_id ?? input?.tenantId ?? actor?.tenant_id ?? homeTenantId(db, actor) ?? null;
}

// Hand-off bridge from the Notification Management module. The notification
// module owns rules, templates, recipient resolution and preferences; once it
// has produced a *finished* message it can hand the outbound work to this
// engine rather than processing external channels itself. Idempotent on the
// notification id so a notification is never queued twice.
export function ingestNotification(db, notification, { delaySeconds = 0, providerCode = null, actor = null, ip = null } = {}) {
  if (!notification || !notification.id) throw new HttpError(400, "notification is required");
  return submitRequest(
    db,
    {
      tenant_id: notification.tenant_id ?? notification.tenantId ?? null,
      organization_id: notification.organization_id ?? notification.organizationId ?? null,
      notification_id: notification.id,
      event_id: notification.event_id ?? notification.eventId ?? null,
      source_module: notification.source_module ?? notification.sourceModule ?? "notifications",
      recipient_id: notification.recipient_id ?? notification.recipientId ?? null,
      recipient_name: notification.recipient_name ?? notification.recipientName ?? "",
      recipient_address: notification.recipient_address ?? notification.recipientAddress ?? "",
      channel: notification.channel,
      provider_code: providerCode || "",
      subject: notification.subject ?? "",
      body: notification.body ?? "",
      content_ref: notification.content_ref ?? notification.contentRef ?? "",
      priority: notification.priority || "normal",
      delay_seconds: delaySeconds,
      correlation_id: notification.correlation_id ?? notification.correlationId ?? "",
      idempotency_key: `notification:${notification.id}`,
      object_type: notification.object_type ?? "",
      object_id: notification.object_id ?? "",
      object_name: notification.object_name ?? "",
      deep_link: notification.deep_link ?? "",
      related: { notification_id: notification.id, handoff: true },
    },
    { actor, ip }
  );
}
