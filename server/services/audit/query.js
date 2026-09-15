import { queryAll, queryOne } from "../../db.js";
import { HttpError } from "../../validation.js";
import { publicEvent, listChangesForEvent } from "./events.js";

// Audit query layer. All reads are tenant scoped unless the caller is a
// platform operator explicitly requesting a global view.

const SORTABLE = {
  created_at: "created_at",
  occurred_at: "created_at",
  action: "action",
  event_type: "event_type",
  actor_username: "actor_username",
  object_type: "resource_type",
  status: "status",
};

function normalizeScope(scope = {}) {
  const tenantId = scope.tenantId === undefined || scope.tenantId === null ? null : Number(scope.tenantId);
  return { tenantId, scopeAll: !!scope.scopeAll };
}

function likeTerm(value) {
  return `%${String(value).trim()}%`;
}

function normalizeDate(value, endOfDay = false) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return endOfDay ? `${raw} 23:59:59` : `${raw} 00:00:00`;
  return raw.replace("T", " ").replace("Z", "").slice(0, 19);
}

export function buildEventFilters(filters = {}, scope = {}) {
  const { tenantId, scopeAll } = normalizeScope(scope);
  const where = [];
  const params = [];

  if (scopeAll) {
    if (filters.tenantId !== undefined && filters.tenantId !== null && filters.tenantId !== "") {
      where.push("tenant_id = ?");
      params.push(Number(filters.tenantId));
    }
  } else {
    where.push("tenant_id = ?");
    params.push(tenantId ?? -1);
  }
  if (filters.organizationId) {
    where.push("organization_id = ?");
    params.push(Number(filters.organizationId));
  }
  if (filters.objectType) {
    where.push("resource_type = ?");
    params.push(String(filters.objectType));
  }
  if (filters.objectId) {
    where.push("resource_id = ?");
    params.push(String(filters.objectId));
  }
  if (filters.actorId) {
    where.push("actor_id = ?");
    params.push(Number(filters.actorId));
  }
  if (filters.actorUsername) {
    where.push("actor_username = ?");
    params.push(String(filters.actorUsername));
  }
  if (filters.action) {
    where.push("action = ?");
    params.push(String(filters.action));
  }
  if (filters.eventType) {
    where.push("event_type = ?");
    params.push(String(filters.eventType).toUpperCase());
  }
  if (filters.source) {
    where.push("source = ?");
    params.push(String(filters.source));
  }
  if (filters.status) {
    where.push("status = ?");
    params.push(String(filters.status));
  }
  if (filters.correlationId) {
    where.push("correlation_id = ?");
    params.push(String(filters.correlationId));
  }
  if (filters.parentEventId) {
    where.push("parent_event_id = ?");
    params.push(Number(filters.parentEventId));
  }
  const from = normalizeDate(filters.from);
  if (from) {
    where.push("created_at >= ?");
    params.push(from);
  }
  const to = normalizeDate(filters.to, true);
  if (to) {
    where.push("created_at <= ?");
    params.push(to);
  }
  if (filters.q) {
    const like = likeTerm(filters.q);
    where.push(
      "(actor_username LIKE ? OR object_name LIKE ? OR action LIKE ? OR resource_id LIKE ? OR details LIKE ? OR error_message LIKE ?)"
    );
    params.push(like, like, like, like, like, like);
  }
  return { where, params };
}

function orderClause(sort, order) {
  const column = SORTABLE[sort] || "created_at";
  const direction = String(order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  return `ORDER BY ${column} ${direction}, id ${direction}`;
}

export function listEvents(db, filters = {}, scope = {}) {
  const { where, params } = buildEventFilters(filters, scope);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(filters.pageSize) || 25));
  const offset = filters.offset !== undefined ? Math.max(0, Number(filters.offset) || 0) : (page - 1) * pageSize;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM audit_logs ${clause}`, params).c;
  const rows = queryAll(
    db,
    `SELECT * FROM audit_logs ${clause} ${orderClause(filters.sort, filters.order)} LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return { items: rows.map(publicEvent), total, page, pageSize };
}

export function getEvent(db, id, scope = {}) {
  const { where, params } = buildEventFilters({}, scope);
  const clause = where.length ? `WHERE ${where.join(" AND ")} AND id = ?` : "WHERE id = ?";
  const row = queryOne(db, `SELECT * FROM audit_logs ${clause}`, [...params, Number(id)]);
  if (!row) throw new HttpError(404, "Audit event not found");
  return { ...publicEvent(row), changes: listChangesForEvent(db, row.id) };
}

export function objectHistory(db, { objectType, objectId }, filters = {}, scope = {}) {
  if (!objectType || !objectId) throw new HttpError(400, "objectType and objectId are required");
  return listEvents(db, { ...filters, objectType, objectId }, scope);
}

export function userActivity(db, userId, filters = {}, scope = {}) {
  if (!userId) throw new HttpError(400, "userId is required");
  return listEvents(db, { ...filters, actorId: userId }, scope);
}

export function eventFacets(db, filters = {}, scope = {}) {
  const { where, params } = buildEventFilters(filters, scope);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const actions = queryAll(
    db,
    `SELECT action, COUNT(*) AS count FROM audit_logs ${clause} GROUP BY action ORDER BY count DESC LIMIT 50`,
    params
  );
  const sources = queryAll(
    db,
    `SELECT source, COUNT(*) AS count FROM audit_logs ${clause} GROUP BY source ORDER BY count DESC`,
    params
  );
  const eventTypes = queryAll(
    db,
    `SELECT event_type, COUNT(*) AS count FROM audit_logs ${clause} GROUP BY event_type ORDER BY count DESC`,
    params
  );
  return { actions, sources, event_types: eventTypes };
}

export function auditSummary(db, filters = {}, scope = {}) {
  const { where, params } = buildEventFilters(filters, scope);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totals = queryOne(
    db,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
            SUM(CASE WHEN status = 'failure' THEN 1 ELSE 0 END) AS failure,
            SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END) AS denied
     FROM audit_logs ${clause}`,
    params
  );
  const byType = queryAll(
    db,
    `SELECT event_type, COUNT(*) AS count FROM audit_logs ${clause} GROUP BY event_type ORDER BY count DESC`,
    params
  );
  const bySource = queryAll(
    db,
    `SELECT source, COUNT(*) AS count FROM audit_logs ${clause} GROUP BY source ORDER BY count DESC`,
    params
  );
  const topActors = queryAll(
    db,
    `SELECT actor_id, actor_username, COUNT(*) AS count FROM audit_logs ${clause}
     GROUP BY actor_id, actor_username ORDER BY count DESC LIMIT 10`,
    params
  );
  const topObjects = queryAll(
    db,
    `SELECT resource_type, resource_id, object_name, COUNT(*) AS count FROM audit_logs ${clause}
     GROUP BY resource_type, resource_id, object_name ORDER BY count DESC LIMIT 10`,
    params
  );
  const byDay = queryAll(
    db,
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count FROM audit_logs ${clause}
     GROUP BY day ORDER BY day DESC LIMIT 30`,
    params
  );
  return {
    total: totals.total || 0,
    success: totals.success || 0,
    failure: totals.failure || 0,
    denied: totals.denied || 0,
    by_type: byType,
    by_source: bySource,
    top_actors: topActors,
    top_objects: topObjects,
    by_day: byDay.reverse(),
  };
}
