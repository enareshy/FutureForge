import { queryAll, run, nowIso } from "../../db.js";
import { recordObjectChange, structuredLog } from "../audit.js";
import { publish } from "../notifications.js";
import { publicEvent, safeParse } from "./repository.js";
import { assertEventType } from "./validation.js";
import { HttpError } from "../../validation.js";
import { emitObjectIndexChange } from "../search/hooks.js";

// File domain events. Every state change is (1) written to the module outbox
// `file_events` for durability/audit and (2) re-published through the platform
// Event & Messaging / Notification framework. Publishing is best-effort: a
// notification outage must never roll back a successful file operation.

export function recordFileEvent(db, {
  eventType,
  file = null,
  versionId = null,
  actor = null,
  tenantId = null,
  organizationId = null,
  correlationId = "",
  payload = {},
  idempotencyKey = null,
} = {}) {
  assertEventType(eventType);
  const eventTenant = tenantId ?? file?.tenant_id ?? null;
  const insert = run(
    db,
    `INSERT INTO file_events
      (event_type, file_id, version_id, tenant_id, organization_id, actor_id,
       correlation_id, idempotency_key, payload_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?)`,
    [
      eventType,
      file?.id ?? null,
      versionId ?? null,
      eventTenant,
      organizationId ?? file?.organization_id ?? null,
      actor?.id ?? null,
      correlationId || "",
      idempotencyKey,
      JSON.stringify(payload || {}),
      nowIso(),
    ]
  );
  const row = { id: Number(insert.lastInsertRowid) };
  let summary = null;
  if (eventTenant) {
    try {
      summary = publish(db, {
        event_type: eventType,
        source_module: "files",
        tenant_id: eventTenant,
        organization_id: organizationId ?? file?.organization_id ?? null,
        object_type: "file",
        object_id: String(file?.id ?? ""),
        object_name: file?.name || "",
        initiator_id: actor?.id ?? null,
        initiator_username: actor?.username || "",
        payload: { ...payload, file_ref: file?.file_ref, version_id: versionId ?? null },
        correlation_id: correlationId || "",
        idempotency_key: idempotencyKey,
      }, { actor });
    } catch (err) {
      structuredLog("files.event.publish_failed", { event_type: eventType, message: err.message });
    }
  }
  if (summary?.published) {
    run(db, "UPDATE file_events SET status = 'published' WHERE id = ?", [row.id]);
  } else if (summary && !summary.published && summary.reason && summary.reason !== "missing_tenant") {
    run(db, "UPDATE file_events SET status = 'failed' WHERE id = ?", [row.id]);
  }
  const stored = queryAll(db, "SELECT * FROM file_events WHERE id = ?", [row.id])[0];
  if (file?.id) {
    emitObjectIndexChange(db, {
      tenantId: eventTenant,
      objectType: "file",
      objectId: file.id,
      operation: eventType === "FileDeleted" ? "delete" : "upsert",
      reason: eventType,
    });
  }
  return { ...publicEvent(stored), notification: summary ? { published: summary.published, event_id: summary.event_id, reason: summary.reason || "" } : null };
}

export function listFileEvents(db, { fileId = null, eventType = null, tenantId = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (fileId) { where.push("file_id = ?"); params.push(Number(fileId)); }
  if (eventType) { where.push("event_type = ?"); params.push(eventType); }
  if (tenantId !== null && tenantId !== undefined) { where.push("tenant_id = ?"); params.push(Number(tenantId)); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = queryAll(
    db,
    `SELECT * FROM file_events ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, Math.min(500, Math.max(1, Number(limit) || 100))]
  ).map(publicEvent);
  return { items, total: items.length };
}

export function fileEventSummary(db, tenantId = null) {
  const params = [];
  let clause = "";
  if (tenantId !== null && tenantId !== undefined) {
    clause = "WHERE tenant_id = ?";
    params.push(Number(tenantId));
  }
  return queryAll(
    db,
    `SELECT event_type, COUNT(*) AS count FROM file_events ${clause} GROUP BY event_type ORDER BY count DESC`,
    params
  );
}

// Audited administrative/operational change. Never throws.
export function auditFile(db, {
  actor,
  tenantId,
  organizationId,
  action,
  file = null,
  before = null,
  after = null,
  reason = "",
  details = {},
  ip = null,
  correlationId = "",
  objectType = "file",
  objectId = null,
  objectName = "",
} = {}) {
  if (!action) throw new HttpError(500, "audit action is required");
  return recordObjectChange(db, {
    actor,
    tenantId,
    organizationId,
    action,
    objectType,
    objectId: objectId ?? file?.id ?? null,
    objectName: objectName || file?.name || "",
    before,
    after,
    reason,
    details,
    ip,
    correlationId,
    source: "api",
  });
}

export function parsePayload(row) {
  return safeParse(row?.payload_json, {});
}
