import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { safeParse } from "./validation.js";

// In-app notification inbox. Every query is scoped to the recipient so a user
// can only ever read or mutate their own notifications. Administrators view the
// wider stream through the history/delivery endpoints instead.

export function publicNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    event_id: row.event_id ?? null,
    rule_id: row.rule_id ?? null,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    recipient_id: row.recipient_id,
    recipient_username: row.recipient_username || null,
    channel: row.channel,
    template_code: row.template_code || "",
    subject: row.subject || "",
    body: row.body || "",
    status: row.status,
    read: Boolean(row.read_at),
    priority: row.priority,
    read_at: row.read_at || null,
    sent_at: row.sent_at || null,
    delivered_at: row.delivered_at || null,
    correlation_id: row.correlation_id || "",
    object_type: row.object_type || "",
    object_id: row.object_id || "",
    object_name: row.object_name || "",
    deep_link: row.deep_link || "",
    action_links: safeParse(row.action_links_json, []),
    event_type: row.event_type || "",
    source_module: row.source_module || "",
    archived_at: row.archived_at || null,
    created_at: row.created_at,
  };
}

const BASE_SELECT = `
  SELECT n.*, e.event_type AS event_type, e.source_module AS source_module, u.username AS recipient_username
  FROM notifications n
  LEFT JOIN notification_events e ON e.id = n.event_id
  LEFT JOIN users u ON u.id = n.recipient_id
`;

function tabClause(tab) {
  switch (tab) {
    case "unread":
      return "n.read_at IS NULL";
    case "tasks":
      return "(e.event_type LIKE 'task.%' OR e.event_type LIKE 'workflow.task%' OR e.source_module = 'workflow')";
    case "approvals":
      return "(e.event_type LIKE '%approval%' OR e.event_type LIKE '%release%')";
    case "system":
      return "(e.source_module IN ('platform', 'system', 'admin') OR n.channel = 'in_app' AND e.event_type IS NULL)";
    default:
      return null;
  }
}

export function listInbox(db, userId, tenantId, query = {}) {
  const { page, pageSize, offset } = pagination(query);
  const where = ["n.recipient_id = ?", "n.deleted_at IS NULL"];
  const params = [Number(userId)];
  if (tenantId) {
    where.push("n.tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (query.archived === "true" || query.archived === true) {
    where.push("n.archived_at IS NOT NULL");
  } else if (query.includeArchived !== "true") {
    where.push("n.archived_at IS NULL");
  }
  if (query.unread === "true" || query.unread === true) where.push("n.read_at IS NULL");
  if (query.read === "true" || query.read === true) where.push("n.read_at IS NOT NULL");
  if (query.channel) {
    where.push("n.channel = ?");
    params.push(query.channel);
  }
  if (query.priority) {
    where.push("n.priority = ?");
    params.push(query.priority);
  }
  if (query.objectType || query.object_type) {
    where.push("n.object_type = ?");
    params.push(query.objectType || query.object_type);
  }
  const tab = query.tab && query.tab !== "all" ? tabClause(query.tab) : null;
  if (tab) where.push(`(${tab})`);
  if (query.q) {
    where.push("(n.subject LIKE ? OR n.body LIKE ? OR n.object_name LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM notifications n LEFT JOIN notification_events e ON e.id = n.event_id ${clause}`, params).c;
  const items = queryAll(
    db,
    `${BASE_SELECT} ${clause} ORDER BY n.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicNotification);
  return { items, total, page, pageSize };
}

export function unreadCount(db, userId, tenantId) {
  const params = [Number(userId)];
  let clause = "recipient_id = ? AND read_at IS NULL AND deleted_at IS NULL AND archived_at IS NULL";
  if (tenantId) {
    clause += " AND tenant_id = ?";
    params.push(Number(tenantId));
  }
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM notifications WHERE ${clause}`, params).c;
  const byPriority = queryAll(
    db,
    `SELECT priority, COUNT(*) AS count FROM notifications WHERE ${clause} GROUP BY priority`,
    params
  );
  return { unread: total, total, by_priority: byPriority };
}

function ownNotification(db, id, userId, tenantId) {
  const row = queryOne(db, "SELECT * FROM notifications WHERE id = ?", [Number(id)]);
  if (!row) throw new HttpError(404, "Notification not found");
  if (Number(row.recipient_id) !== Number(userId)) throw new HttpError(404, "Notification not found");
  if (tenantId && Number(row.tenant_id) !== Number(tenantId)) throw new HttpError(404, "Notification not found");
  return row;
}

export function getNotification(db, id, userId, tenantId) {
  const row = ownNotification(db, id, userId, tenantId);
  const event = row.event_id ? queryOne(db, "SELECT event_type, source_module, correlation_id FROM notification_events WHERE id = ?", [row.event_id]) : null;
  return publicNotification({ ...row, event_type: event?.event_type, source_module: event?.source_module });
}

export function markRead(db, id, userId, tenantId, actor = null, ip = null) {
  const row = ownNotification(db, id, userId, tenantId);
  if (!row.read_at) {
    run(db, "UPDATE notifications SET status = 'read', read_at = ?, updated_at = ? WHERE id = ?", [nowIso(), nowIso(), row.id]);
  }
  if (actor) {
    writeAudit(db, { actor, action: "notification.read", resourceType: "notification", resourceId: row.id, ip });
  }
  return getNotification(db, row.id, userId, tenantId);
}

export function markUnread(db, id, userId, tenantId, actor = null, ip = null) {
  const row = ownNotification(db, id, userId, tenantId);
  run(db, "UPDATE notifications SET status = 'sent', read_at = NULL, updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  if (actor) {
    writeAudit(db, { actor, action: "notification.unread", resourceType: "notification", resourceId: row.id, ip });
  }
  return getNotification(db, row.id, userId, tenantId);
}

export function markAllRead(db, userId, tenantId, actor = null, ip = null) {
  const params = [nowIso(), nowIso(), Number(userId)];
  let clause = "recipient_id = ? AND read_at IS NULL AND deleted_at IS NULL";
  if (tenantId) {
    clause += " AND tenant_id = ?";
    params.push(Number(tenantId));
  }
  const result = run(db, `UPDATE notifications SET status = 'read', read_at = ?, updated_at = ? WHERE ${clause}`, params);
  if (actor) {
    writeAudit(db, { actor, action: "notification.read_all", resourceType: "notification", resourceId: userId, details: { updated: result.changes }, ip });
  }
  return { updated: result.changes };
}

export function archiveNotification(db, id, userId, tenantId, actor = null, ip = null) {
  const row = ownNotification(db, id, userId, tenantId);
  run(db, "UPDATE notifications SET archived_at = ?, updated_at = ? WHERE id = ?", [nowIso(), nowIso(), row.id]);
  return { archived: true, id: row.id };
}

export function deleteNotification(db, id, userId, tenantId, actor = null, ip = null) {
  const row = ownNotification(db, id, userId, tenantId);
  run(db, "UPDATE notifications SET deleted_at = ?, updated_at = ? WHERE id = ?", [nowIso(), nowIso(), row.id]);
  if (actor) {
    writeAudit(db, { actor, action: "notification.delete", resourceType: "notification", resourceId: row.id, ip });
  }
  return { deleted: true, id: row.id };
}

export function archiveAllRead(db, userId, tenantId) {
  const params = [nowIso(), nowIso(), Number(userId)];
  let clause = "recipient_id = ? AND read_at IS NOT NULL AND archived_at IS NULL AND deleted_at IS NULL";
  if (tenantId) {
    clause += " AND tenant_id = ?";
    params.push(Number(tenantId));
  }
  const result = run(db, `UPDATE notifications SET archived_at = ?, updated_at = ? WHERE ${clause}`, params);
  return { archived: result.changes };
}

// Administrator-facing history across all recipients for the tenant. Filters
// mirror the inbox but are not restricted to the caller.
export function listHistory(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const where = ["1 = 1"];
  const params = [];
  if (tenantId) {
    where.push("n.tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (query.recipientId || query.recipient_id) {
    where.push("n.recipient_id = ?");
    params.push(Number(query.recipientId || query.recipient_id));
  }
  if (query.status) {
    where.push("n.status = ?");
    params.push(query.status);
  }
  if (query.channel) {
    where.push("n.channel = ?");
    params.push(query.channel);
  }
  if (query.priority) {
    where.push("n.priority = ?");
    params.push(query.priority);
  }
  if (query.eventType || query.event_type) {
    where.push("e.event_type = ?");
    params.push(query.eventType || query.event_type);
  }
  if (query.sourceModule || query.source_module) {
    where.push("e.source_module = ?");
    params.push(query.sourceModule || query.source_module);
  }
  if (query.objectType || query.object_type) {
    where.push("n.object_type = ?");
    params.push(query.objectType || query.object_type);
  }
  if (query.unread === "true" || query.unread === true) where.push("n.read_at IS NULL");
  if (query.from) {
    where.push("n.created_at >= ?");
    params.push(query.from);
  }
  if (query.to) {
    where.push("n.created_at <= ?");
    params.push(query.to);
  }
  if (query.q) {
    where.push("(n.subject LIKE ? OR n.body LIKE ? OR n.object_name LIKE ? OR u.username LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM notifications n LEFT JOIN notification_events e ON e.id = n.event_id LEFT JOIN users u ON u.id = n.recipient_id ${clause}`,
    params
  ).c;
  const items = queryAll(
    db,
    `${BASE_SELECT} ${clause} ORDER BY n.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicNotification);
  const byStatus = queryAll(
    db,
    `SELECT n.status, COUNT(*) AS count FROM notifications n LEFT JOIN notification_events e ON e.id = n.event_id LEFT JOIN users u ON u.id = n.recipient_id ${clause} GROUP BY n.status`,
    params
  );
  return { items, total, page, pageSize, by_status: byStatus };
}
