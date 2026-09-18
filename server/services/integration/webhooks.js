// Webhook framework: inbound receivers with signature/IP/replay protection and
// outbound subscriptions with retry, circuit breaking and delivery logs.
import { createHmac, timingSafeEqual } from "node:crypto";
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { publicInboundWebhook, publicOutboundWebhook, ref } from "./repository.js";
import {
  WEBHOOK_AUTH_TYPES,
  addSecondsIso,
  assertEnum,
  assertSafeUrl,
  computeBackoffSeconds,
  normalizeRetryPolicy,
  safeParse,
  signPayload,
  toJson,
  verifySignature,
} from "./validation.js";
import { auditIntegration, log } from "./hooks.js";
import { resolveCredentialSecret } from "./systems.js";
import { publishEvent } from "./events.js";

function eq(a, b) {
  const ba = Buffer.from(String(a ?? ""));
  const bb = Buffer.from(String(b ?? ""));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ── Inbound endpoints ───────────────────────────────────────────────────────
export function listInboundWebhooks(db, { tenantId, status, q, page = 1, pageSize = 50 } = {}) {
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
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(path) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_webhook_endpoints ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_webhook_endpoints ${where} ORDER BY code LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicInboundWebhook(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getInboundWebhookRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM integration_webhook_endpoints WHERE id = ? OR code = ? OR path = ?", [Number.isFinite(id) ? id : -1, String(refValue), String(refValue)]);
}

export function getInboundWebhook(db, refValue) {
  const row = getInboundWebhookRow(db, refValue);
  if (!row) throw new HttpError(404, "Inbound webhook not found");
  return publicInboundWebhook(row);
}

export function createInboundWebhook(db, input = {}, actor = null, tenantId = null) {
  if (!input.code) throw new HttpError(400, "code is required");
  const path = input.path || `/api/integration/webhooks/${String(input.code).toLowerCase()}`;
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO integration_webhook_endpoints
      (code, name, description, integration_id, path, method, auth_type, credential_id, event_type_code,
       payload_schema_json, ip_allowlist_json, replay_window_seconds, rate_limit_per_minute, status,
       tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      input.description || "",
      input.integration_id ?? null,
      path,
      (input.method || "POST").toUpperCase(),
      input.auth_type || "signature",
      input.credential_id ?? null,
      input.event_type_code || "",
      toJson(input.payload_schema, {}),
      toJson(input.ip_allowlist, []),
      Number(input.replay_window_seconds) || 300,
      Number(input.rate_limit_per_minute) || 0,
      input.status || "active",
      tenantId ?? input.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM integration_webhook_endpoints WHERE id = ?", [Number(result.lastInsertRowid)]);
  auditIntegration(db, { actor, action: "integration.webhook.inbound.create", resourceType: "integration_webhook_endpoint", resourceId: row.id, details: { code: row.code } });
  return publicInboundWebhook(row);
}

export function updateInboundWebhook(db, refValue, input = {}, actor = null) {
  const row = getInboundWebhookRow(db, refValue);
  if (!row) throw new HttpError(404, "Inbound webhook not found");
  if (input.auth_type !== undefined) assertEnum(input.auth_type, WEBHOOK_AUTH_TYPES, "auth_type");
  run(
    db,
    `UPDATE integration_webhook_endpoints SET name=?, description=?, integration_id=?, method=?, auth_type=?, credential_id=?,
     event_type_code=?, payload_schema_json=?, ip_allowlist_json=?, replay_window_seconds=?, rate_limit_per_minute=?,
     status=?, updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.description ?? row.description,
      input.integration_id !== undefined ? input.integration_id : row.integration_id,
      (input.method || row.method).toUpperCase(),
      input.auth_type ?? row.auth_type,
      input.credential_id !== undefined ? input.credential_id : row.credential_id,
      input.event_type_code ?? row.event_type_code,
      input.payload_schema !== undefined ? toJson(input.payload_schema, {}) : row.payload_schema_json,
      input.ip_allowlist !== undefined ? toJson(input.ip_allowlist, []) : row.ip_allowlist_json,
      input.replay_window_seconds !== undefined ? Number(input.replay_window_seconds) : row.replay_window_seconds,
      input.rate_limit_per_minute !== undefined ? Number(input.rate_limit_per_minute) : row.rate_limit_per_minute,
      input.status ?? row.status,
      nowIso(),
      row.id,
    ]
  );
  auditIntegration(db, { actor, action: "integration.webhook.inbound.update", resourceType: "integration_webhook_endpoint", resourceId: row.id, details: { code: row.code } });
  return publicInboundWebhook(queryOne(db, "SELECT * FROM integration_webhook_endpoints WHERE id = ?", [row.id]));
}

export function setInboundWebhookStatus(db, refValue, status, actor = null) {
  assertEnum(status, ["active", "inactive", "disabled"], "status");
  const row = getInboundWebhookRow(db, refValue);
  if (!row) throw new HttpError(404, "Inbound webhook not found");
  run(db, "UPDATE integration_webhook_endpoints SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), row.id]);
  auditIntegration(db, { actor, action: "integration.webhook.inbound.status", resourceType: "integration_webhook_endpoint", resourceId: row.id, details: { status } });
  return publicInboundWebhook(queryOne(db, "SELECT * FROM integration_webhook_endpoints WHERE id = ?", [row.id]));
}

export function deleteInboundWebhook(db, refValue, actor = null) {
  const row = getInboundWebhookRow(db, refValue);
  if (!row) throw new HttpError(404, "Inbound webhook not found");
  run(db, "DELETE FROM integration_webhook_endpoints WHERE id = ?", [row.id]);
  auditIntegration(db, { actor, action: "integration.webhook.inbound.delete", resourceType: "integration_webhook_endpoint", resourceId: row.id, details: { code: row.code } });
  return { deleted: true, id: row.id };
}

function ipAllowed(endpoint, ip) {
  const list = safeParse(endpoint.ip_allowlist_json, []);
  if (!Array.isArray(list) || list.length === 0) return true;
  const value = String(ip || "").replace(/^::ffff:/, "");
  return list.some((entry) => value === entry || value.startsWith(String(entry).replace("*", "")));
}

function verifyInbound(db, endpoint, headers, rawBody) {
  const get = (name) => headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()];
  if (endpoint.auth_type === "none") return { ok: true };
  const secret = endpoint.credential_id ? resolveCredentialSecret(db, endpoint.credential_id)?.secret || "" : "";
  if (endpoint.auth_type === "signature") {
    const signature = get("x-integration-signature") || get("x-hub-signature-256") || "";
    const timestamp = get("x-integration-timestamp") || get("x-timestamp") || "";
    if (!signature || !secret) return { ok: false, reason: "missing signature or secret" };
    if (timestamp && endpoint.replay_window_seconds > 0) {
      const age = Math.abs(Date.now() - Number(timestamp) * (String(timestamp).length > 10 ? 1 : 1000));
      if (Number.isFinite(age) && age > endpoint.replay_window_seconds * 1000) return { ok: false, reason: "timestamp outside replay window" };
    }
    const ok = verifySignature(rawBody, secret, signature);
    return { ok, reason: ok ? "" : "signature mismatch" };
  }
  if (endpoint.auth_type === "api_key") {
    const provided = get("x-api-key") || "";
    if (!provided || !secret) return { ok: false, reason: "missing api key" };
    return { ok: eq(provided, secret), reason: "api key mismatch" };
  }
  if (endpoint.auth_type === "basic") {
    const header = get("authorization") || "";
    const [scheme, encoded] = String(header).split(" ");
    if (String(scheme).toLowerCase() !== "basic" || !encoded || !secret) return { ok: false, reason: "missing basic credentials" };
    try {
      const decoded = Buffer.from(encoded, "base64").toString("utf8");
      const password = decoded.slice(decoded.indexOf(":") + 1);
      return { ok: eq(password, secret), reason: "basic auth mismatch" };
    } catch {
      return { ok: false, reason: "invalid basic credentials" };
    }
  }
  return { ok: false, reason: "unsupported auth type" };
}

// Receives an inbound webhook, validates it, records the receipt and (when the
// endpoint maps an event type) publishes it onto the internal event bus.
export function receiveInboundWebhook(db, pathOrCode, { headers = {}, body = {}, rawBody = null, ip = null, actor = null } = {}) {
  const endpoint = getInboundWebhookRow(db, pathOrCode);
  if (!endpoint) throw new HttpError(404, "Webhook endpoint not found");
  if (endpoint.status !== "active") throw new HttpError(403, "Webhook endpoint is not active");
  if (!ipAllowed(endpoint, ip)) throw new HttpError(403, "Source IP is not allowed");
  const receivedAt = nowIso();
  const raw = rawBody != null ? rawBody : typeof body === "string" ? body : JSON.stringify(body ?? {});
  const signature = headers["x-integration-signature"] || headers["x-hub-signature-256"] || "";
  const correlation = headers["x-correlation-id"] || ref("WHC");

  const check = verifyInbound(db, endpoint, headers, raw);
  if (!check.ok) {
    const receipt = run(
      db,
      `INSERT INTO integration_webhook_receipts
        (endpoint_id, signature, event_type_code, payload_json, status, reason, correlation_id, tenant_id, received_at)
       VALUES (?, ?, ?, ?, 'rejected', ?, ?, ?, ?)`,
      [endpoint.id, signature, endpoint.event_type_code || "", toJson(body, {}), check.reason, correlation, endpoint.tenant_id ?? null, receivedAt]
    );
    run(db, "UPDATE integration_webhook_endpoints SET failure_count = failure_count + 1, updated_at = ? WHERE id = ?", [nowIso(), endpoint.id]);
    auditIntegration(db, { actor, action: "integration.webhook.rejected", resourceType: "integration_webhook_endpoint", resourceId: endpoint.id, details: { reason: check.reason }, status: "failure" });
    log("warn", "integration.webhook.rejected", { endpoint: endpoint.code, reason: check.reason });
    throw new HttpError(401, `Webhook rejected: ${check.reason}`, { receipt_id: Number(receipt.lastInsertRowid) });
  }

  // Replay / duplicate protection by signature.
  if (signature) {
    const duplicate = queryOne(db, "SELECT id FROM integration_webhook_receipts WHERE endpoint_id = ? AND signature = ? AND status = 'accepted'", [endpoint.id, signature]);
    if (duplicate) {
      const receipt = run(
        db,
        `INSERT INTO integration_webhook_receipts
          (endpoint_id, signature, event_type_code, payload_json, status, reason, correlation_id, tenant_id, received_at)
         VALUES (?, ?, ?, ?, 'duplicate', ?, ?, ?, ?)`,
        [endpoint.id, signature, endpoint.event_type_code || "", toJson(body, {}), "duplicate signature", correlation, endpoint.tenant_id ?? null, receivedAt]
      );
      auditIntegration(db, { actor, action: "integration.webhook.duplicate", resourceType: "integration_webhook_endpoint", resourceId: endpoint.id, details: {} });
      return { duplicate: true, receipt_id: Number(receipt.lastInsertRowid) };
    }
  }

  const receipt = run(
    db,
    `INSERT INTO integration_webhook_receipts
      (endpoint_id, signature, event_type_code, payload_json, status, reason, correlation_id, tenant_id, received_at)
     VALUES (?, ?, ?, ?, 'accepted', '', ?, ?, ?)`,
    [endpoint.id, signature, endpoint.event_type_code || "", toJson(body, {}), correlation, endpoint.tenant_id ?? null, receivedAt]
  );
  const receiptId = Number(receipt.lastInsertRowid);
  run(
    db,
    "UPDATE integration_webhook_endpoints SET receive_count = receive_count + 1, last_received_at = ?, updated_at = ? WHERE id = ?",
    [receivedAt, nowIso(), endpoint.id]
  );

  let event = null;
  const eventType = endpoint.event_type_code || body?.event_type;
  if (eventType) {
    event = publishEvent(
      db,
      {
        event_type_code: eventType,
        payload: body,
        source_module: "integration.webhook",
        correlation_id: correlation,
        metadata: { webhook_code: endpoint.code, receipt_id: receiptId },
        tenant_id: endpoint.tenant_id,
      },
      actor
    );
    run(db, "UPDATE integration_webhook_receipts SET event_type_code = ?, correlation_id = ? WHERE id = ?", [eventType, event.event_ref || correlation, receiptId]);
  }

  auditIntegration(db, { actor, action: "integration.webhook.received", resourceType: "integration_webhook_endpoint", resourceId: endpoint.id, details: { receipt_id: receiptId, event_type: eventType || null } });
  return { duplicate: false, receipt_id: receiptId, accepted: true, event };
}

export function listInboundReceipts(db, { endpointId, status, page = 1, pageSize = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (endpointId) {
    clauses.push("endpoint_id = ?");
    params.push(Number(endpointId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_webhook_receipts ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_webhook_receipts ${where} ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows, total, page: Number(page), page_size: Number(pageSize) };
}

// ── Outbound subscriptions ──────────────────────────────────────────────────
export function listOutboundWebhooks(db, { tenantId, status, q, page = 1, pageSize = 50 } = {}) {
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
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(url) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_webhook_subscriptions ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_webhook_subscriptions ${where} ORDER BY code LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicOutboundWebhook(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getOutboundWebhookRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM integration_webhook_subscriptions WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
}

export function getOutboundWebhook(db, refValue) {
  const row = getOutboundWebhookRow(db, refValue);
  if (!row) throw new HttpError(404, "Outbound webhook not found");
  return publicOutboundWebhook(row);
}

export function createOutboundWebhook(db, input = {}, actor = null, tenantId = null) {
  if (!input.code) throw new HttpError(400, "code is required");
  if (!input.url) throw new HttpError(400, "url is required");
  assertSafeUrl(input.url, { allowedHosts: input.allowed_hosts || [] });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO integration_webhook_subscriptions
      (code, name, description, url, event_filter_json, credential_id, header_json, retry_policy_json, timeout_seconds,
       status, failure_threshold, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      input.description || "",
      input.url,
      toJson(input.event_filter, {}),
      input.credential_id ?? null,
      toJson(input.header, {}),
      toJson(input.retry_policy, {}),
      Number(input.timeout_seconds) || 30,
      input.status || "active",
      Number(input.failure_threshold) || 10,
      tenantId ?? input.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM integration_webhook_subscriptions WHERE id = ?", [Number(result.lastInsertRowid)]);
  auditIntegration(db, { actor, action: "integration.webhook.outbound.create", resourceType: "integration_webhook_subscription", resourceId: row.id, details: { code: row.code } });
  return publicOutboundWebhook(row);
}

export function updateOutboundWebhook(db, refValue, input = {}, actor = null) {
  const row = getOutboundWebhookRow(db, refValue);
  if (!row) throw new HttpError(404, "Outbound webhook not found");
  if (input.url) assertSafeUrl(input.url, { allowedHosts: input.allowed_hosts || [] });
  run(
    db,
    `UPDATE integration_webhook_subscriptions SET name=?, description=?, url=?, event_filter_json=?, credential_id=?,
     header_json=?, retry_policy_json=?, timeout_seconds=?, status=?, failure_threshold=?, updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.description ?? row.description,
      input.url ?? row.url,
      input.event_filter !== undefined ? toJson(input.event_filter, {}) : row.event_filter_json,
      input.credential_id !== undefined ? input.credential_id : row.credential_id,
      input.header !== undefined ? toJson(input.header, {}) : row.header_json,
      input.retry_policy !== undefined ? toJson(input.retry_policy, {}) : row.retry_policy_json,
      input.timeout_seconds !== undefined ? Number(input.timeout_seconds) : row.timeout_seconds,
      input.status ?? row.status,
      input.failure_threshold !== undefined ? Number(input.failure_threshold) : row.failure_threshold,
      nowIso(),
      row.id,
    ]
  );
  auditIntegration(db, { actor, action: "integration.webhook.outbound.update", resourceType: "integration_webhook_subscription", resourceId: row.id, details: { code: row.code } });
  return publicOutboundWebhook(queryOne(db, "SELECT * FROM integration_webhook_subscriptions WHERE id = ?", [row.id]));
}

export function setOutboundWebhookStatus(db, refValue, status, actor = null, reason = "") {
  assertEnum(status, ["active", "inactive", "disabled"], "status");
  const row = getOutboundWebhookRow(db, refValue);
  if (!row) throw new HttpError(404, "Outbound webhook not found");
  run(db, "UPDATE integration_webhook_subscriptions SET status = ?, disabled_reason = ?, consecutive_failures = 0, updated_at = ? WHERE id = ?", [status, reason, nowIso(), row.id]);
  auditIntegration(db, { actor, action: "integration.webhook.outbound.status", resourceType: "integration_webhook_subscription", resourceId: row.id, details: { status, reason } });
  return publicOutboundWebhook(queryOne(db, "SELECT * FROM integration_webhook_subscriptions WHERE id = ?", [row.id]));
}

export function deleteOutboundWebhook(db, refValue, actor = null) {
  const row = getOutboundWebhookRow(db, refValue);
  if (!row) throw new HttpError(404, "Outbound webhook not found");
  run(db, "DELETE FROM integration_webhook_subscriptions WHERE id = ?", [row.id]);
  auditIntegration(db, { actor, action: "integration.webhook.outbound.delete", resourceType: "integration_webhook_subscription", resourceId: row.id, details: { code: row.code } });
  return { deleted: true, id: row.id };
}

// ── Outbound dispatch ───────────────────────────────────────────────────────
async function postWebhook(sub, { body, headers, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(sub.url, { method: "POST", headers, body, signal: controller.signal });
    const text = await response.text().catch(() => "");
    return { status: response.status, body: text.slice(0, 4000), durationMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// Dispatches pending event deliveries whose subscriber_type is `webhook`. The
// outbound webhook is resolved from the subscription's target_ref. Attempts are
// additionally logged to integration_webhook_deliveries for HTTP-level history.
export async function processDueWebhookDeliveries(db, { limit = 50, fetchImpl = postWebhook } = {}) {
  const ts = nowIso();
  const rows = queryAll(
    db,
    `SELECT d.*, s.retry_policy_json AS subscription_retry_json
       FROM integration_event_deliveries d
       LEFT JOIN integration_event_subscriptions s ON s.id = d.subscription_id
      WHERE d.subscriber_type = 'webhook'
        AND d.status IN ('pending', 'retry')
        AND (d.next_retry_at IS NULL OR d.next_retry_at <= ?)
      ORDER BY COALESCE(d.next_retry_at, d.created_at) LIMIT ?`,
    [ts, Number(limit)]
  );
  const summary = { processed: 0, delivered: 0, failed: 0, retried: 0, skipped: 0 };
  for (const delivery of rows) {
    summary.processed += 1;
    const sub = getOutboundWebhookRow(db, delivery.target_ref);
    if (!sub || sub.status !== "active") {
      run(db, "UPDATE integration_event_deliveries SET status = 'skipped', last_error = ?, updated_at = ? WHERE id = ?", ["outbound webhook unavailable or inactive", nowIso(), delivery.id]);
      summary.skipped += 1;
      continue;
    }
    const payload = delivery.payload_json || "{}";
    const headers = { "content-type": "application/json", "x-integration-event": delivery.event_type_code || "", "x-integration-delivery": String(delivery.id), ...safeParse(sub.header_json, {}) };
    if (sub.credential_id) {
      const secret = resolveCredentialSecret(db, sub.credential_id)?.secret || "";
      if (secret) headers["x-integration-signature"] = signPayload(payload, secret);
    }
    const timeoutMs = (Number(sub.timeout_seconds) || 30) * 1000;
    const attempt = delivery.attempts + 1;
    let result = null;
    let error = null;
    try {
      result = await fetchImpl(sub, { body: payload, headers, timeoutMs });
    } catch (err) {
      error = err;
    }
    const ok = result && result.status >= 200 && result.status < 300;
    run(
      db,
      `INSERT INTO integration_webhook_deliveries
        (subscription_id, event_id, event_type_code, direction, status, attempt, max_attempts, request_headers_json,
         payload_json, response_code, response_body, duration_ms, error, correlation_id, tenant_id, delivered_at)
       VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sub.id,
        delivery.event_id,
        delivery.event_type_code || "",
        ok ? "delivered" : "failed",
        attempt,
        delivery.max_attempts,
        toJson(headers, {}),
        payload,
        result?.status ?? null,
        result?.body || "",
        result?.durationMs ?? null,
        error ? error.message : ok ? "" : `HTTP ${result.status}`,
        delivery.correlation_id || "",
        sub.tenant_id ?? null,
        ok ? nowIso() : null,
      ]
    );
    if (ok) {
      run(db, "UPDATE integration_event_deliveries SET status = 'delivered', attempts = ?, response_code = ?, delivered_at = ?, updated_at = ? WHERE id = ?", [attempt, result.status, nowIso(), nowIso(), delivery.id]);
      run(db, "UPDATE integration_webhook_subscriptions SET consecutive_failures = 0, last_delivery_at = ?, last_status_code = ?, updated_at = ? WHERE id = ?", [nowIso(), result.status, nowIso(), sub.id]);
      summary.delivered += 1;
    } else {
      const policy = normalizeRetryPolicy({ ...safeParse(delivery.subscription_retry_json, {}), max_attempts: delivery.max_attempts });
      const failures = sub.consecutive_failures + 1;
      run(db, "UPDATE integration_webhook_subscriptions SET consecutive_failures = ?, last_delivery_at = ?, last_status_code = ?, updated_at = ? WHERE id = ?", [failures, nowIso(), result?.status ?? null, nowIso(), sub.id]);
      if (failures >= sub.failure_threshold) setOutboundWebhookStatus(db, sub.id, "disabled", null, "failure threshold exceeded");
      if (shouldRetryLocal(policy, attempt)) {
        const delay = computeBackoffSeconds(policy, attempt);
        run(
          db,
          "UPDATE integration_event_deliveries SET status = 'retry', attempts = ?, next_retry_at = ?, response_code = ?, last_error = ?, updated_at = ? WHERE id = ?",
          [attempt, addSecondsIso(delay), result?.status ?? null, error?.message || `HTTP ${result.status}`, nowIso(), delivery.id]
        );
        summary.retried += 1;
      } else {
        run(
          db,
          "UPDATE integration_event_deliveries SET status = 'dead_letter', attempts = ?, response_code = ?, last_error = ?, updated_at = ? WHERE id = ?",
          [attempt, result?.status ?? null, error?.message || `HTTP ${result.status}`, nowIso(), delivery.id]
        );
        summary.failed += 1;
      }
    }
  }
  return summary;
}

function shouldRetryLocal(policy, attempt) {
  return attempt < policy.max_attempts;
}

export function listOutboundDeliveries(db, { subscriptionId, status, page = 1, pageSize = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (subscriptionId) {
    clauses.push("subscription_id = ?");
    params.push(Number(subscriptionId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_webhook_deliveries ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_webhook_deliveries ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      subscription_id: r.subscription_id,
      event_id: r.event_id ?? null,
      event_type_code: r.event_type_code || "",
      direction: r.direction,
      status: r.status,
      attempt: r.attempt,
      max_attempts: r.max_attempts,
      response_code: r.response_code ?? null,
      response_body: r.response_body || "",
      duration_ms: r.duration_ms ?? null,
      error: r.error || "",
      next_retry_at: r.next_retry_at || null,
      correlation_id: r.correlation_id || "",
      created_at: r.created_at,
      delivered_at: r.delivered_at || null,
    })),
    total,
    page: Number(page),
    page_size: Number(pageSize),
  };
}

// Test helper: synchronously verify an outbound webhook config can be reached.
export async function testOutboundWebhook(db, refValue, { fetchImpl = postWebhook } = {}) {
  const row = getOutboundWebhookRow(db, refValue);
  if (!row) throw new HttpError(404, "Outbound webhook not found");
  const body = JSON.stringify({ event_type: "IntegrationWebhookTest", test: true, sent_at: nowIso() });
  const headers = { "content-type": "application/json", "x-integration-event": "IntegrationWebhookTest", ...safeParse(row.header_json, {}) };
  if (row.credential_id) {
    const secret = resolveCredentialSecret(db, row.credential_id)?.secret || "";
    if (secret) headers["x-integration-signature"] = signPayload(body, secret);
  }
  try {
    const result = await fetchImpl(row, { body, headers, timeoutMs: (Number(row.timeout_seconds) || 30) * 1000 });
    return { ok: result.status >= 200 && result.status < 300, status: result.status, duration_ms: result.durationMs, body: result.body };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}
