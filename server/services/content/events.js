import { queryAll, run, nowIso } from "../../db.js";
import { recordObjectChange } from "../audit.js";
import { emitDomainEvent } from "../events/emit.js";
import { createEventType, getEventTypeRow } from "../events/registry.js";
import { emitObjectIndexChange } from "../search/hooks.js";
import { publicEvent, safeParse } from "./repository.js";
import { CONTENT_EVENT_TYPES } from "./constants.js";

// Content domain events. Every state change is (1) written to the module outbox
// `content_events` for durability and (2) published through the platform Event &
// Messaging framework. Publishing is best-effort so an event outage never rolls
// back a successful content operation. Audit goes through the shared Audit &
// History service — this module never keeps its own audit trail.

const EVENT_SET = new Set(CONTENT_EVENT_TYPES);

export function assertEventType(type) {
  if (!EVENT_SET.has(type)) {
    throw new Error(`Unknown content event type: ${type}`);
  }
}

export function recordContentEvent(db, {
  eventType,
  content = null,
  versionId = null,
  renditionId = null,
  actor = null,
  tenantId = null,
  organizationId = null,
  correlationId = "",
  payload = {},
  idempotencyKey = null,
} = {}) {
  if (!EVENT_SET.has(eventType)) return null;
  const scope = tenantId ?? content?.tenant_id ?? null;
  const insert = run(
    db,
    `INSERT INTO content_events
      (event_type, content_id, version_id, rendition_id, tenant_id, organization_id, actor_id,
       correlation_id, idempotency_key, payload_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recorded', ?)`,
    [
      eventType,
      content?.id ?? null,
      versionId ?? null,
      renditionId ?? null,
      scope,
      organizationId ?? content?.organization_id ?? null,
      actor?.id ?? null,
      correlationId || "",
      idempotencyKey,
      JSON.stringify(payload || {}),
      nowIso(),
    ]
  );
  const rowId = Number(insert.lastInsertRowid);
  let published = false;
  if (scope) {
    try {
      const result = emitDomainEvent(
        db,
        {
          event_type_code: eventType,
          category: "content",
          source_module: "content",
          source_system: "content",
          source_object_type: content ? "content" : "content_asset",
          source_object_id: content?.id ?? null,
          source_object_revision: content?.revision ?? null,
          tenant_id: scope,
          organization_id: organizationId ?? content?.organization_id ?? null,
          correlation_id: correlationId || undefined,
          idempotency_key: idempotencyKey || undefined,
          payload: {
            content_id: content?.content_id ?? null,
            content_key: content?.content_key ?? null,
            object_type: content?.object_type ?? null,
            object_id: content?.object_id ?? null,
            content_role: content?.content_role ?? null,
            content_version_id: versionId ?? null,
            rendition_id: renditionId ?? null,
            ...payload,
          },
          metadata: { content_event_type: eventType },
        },
        actor
      );
      published = Boolean(result);
    } catch {
      published = false;
    }
  }
  if (published) run(db, "UPDATE content_events SET status = 'published' WHERE id = ?", [rowId]);
  if (content?.id) {
    emitObjectIndexChange(db, {
      tenantId: scope,
      objectType: "content",
      objectId: content.id,
      operation: eventType === "ContentDeleted" ? "delete" : "upsert",
      reason: eventType,
    });
  }
  const stored = queryAll(db, "SELECT * FROM content_events WHERE id = ?", [rowId])[0];
  return publicEvent(stored);
}

export function listContentEvents(db, { contentId = null, eventType = null, tenantId = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (contentId) {
    where.push("content_id = ?");
    params.push(Number(contentId));
  }
  if (eventType) {
    where.push("event_type = ?");
    params.push(eventType);
  }
  if (tenantId !== null && tenantId !== undefined) {
    where.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = queryAll(
    db,
    `SELECT * FROM content_events ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, Math.min(500, Math.max(1, Number(limit) || 100))]
  ).map(publicEvent);
  return { items, total: items.length };
}

export function contentEventSummary(db, tenantId = null) {
  const params = [];
  let clause = "";
  if (tenantId !== null && tenantId !== undefined) {
    clause = "WHERE tenant_id = ?";
    params.push(Number(tenantId));
  }
  return queryAll(
    db,
    `SELECT event_type, COUNT(*) AS count FROM content_events ${clause} GROUP BY event_type ORDER BY count DESC`,
    params
  );
}

export function auditContent(db, {
  actor,
  tenantId,
  organizationId,
  action,
  content = null,
  before = null,
  after = null,
  reason = "",
  details = {},
  ip = null,
  correlationId = "",
  objectType = "content",
  objectId = null,
  objectName = "",
} = {}) {
  if (!action) throw new Error("audit action is required");
  return recordObjectChange(db, {
    actor,
    tenantId,
    organizationId,
    action,
    objectType,
    objectId: objectId ?? content?.id ?? null,
    objectName: objectName || content?.file_name || content?.content_key || "",
    before,
    after,
    reason,
    details,
    ip,
    correlationId,
    source: "api",
  });
}

export function ensureContentEventTypes(db) {
  let created = 0;
  for (const code of CONTENT_EVENT_TYPES) {
    if (getEventTypeRow(db, code)) continue;
    createEventType(db, { code, category: "content", source_module: "content", description: `Content event: ${code}`, system: true, status: "active", enabled: true }, null, null);
    created += 1;
  }
  return created;
}

export function parsePayload(row) {
  return safeParse(row?.payload_json, {});
}
