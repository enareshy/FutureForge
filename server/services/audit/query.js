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
  const col = (name) => `audit_logs.${name}`;

  if (scopeAll) {
    if (filters.tenantId !== undefined && filters.tenantId !== null && filters.tenantId !== "") {
      where.push(`${col("tenant_id")} = ?`);
      params.push(Number(filters.tenantId));
    }
  } else {
    where.push(`${col("tenant_id")} = ?`);
    params.push(tenantId ?? -1);
  }
  if (filters.organizationId) {
    where.push(`${col("organization_id")} = ?`);
    params.push(Number(filters.organizationId));
  }
  if (filters.objectType) {
    where.push(`${col("resource_type")} = ?`);
    params.push(String(filters.objectType));
  }
  if (filters.objectId) {
    where.push(`${col("resource_id")} = ?`);
    params.push(String(filters.objectId));
  }
  if (filters.actorId) {
    where.push(`${col("actor_id")} = ?`);
    params.push(Number(filters.actorId));
  }
  if (filters.actorUsername) {
    where.push(`${col("actor_username")} = ?`);
    params.push(String(filters.actorUsername));
  }
  if (filters.action) {
    where.push(`${col("action")} = ?`);
    params.push(String(filters.action));
  }
  if (filters.category) {
    where.push(`${col("category")} = ?`);
    params.push(String(filters.category).toLowerCase());
  }
  if (filters.actorType) {
    where.push(`${col("actor_type")} = ?`);
    params.push(String(filters.actorType).toLowerCase());
  }
  if (filters.securityClassification) {
    where.push(`${col("security_classification")} = ?`);
    params.push(String(filters.securityClassification).toLowerCase());
  }
  if (filters.retentionCategory) {
    where.push(`${col("retention_category")} = ?`);
    params.push(String(filters.retentionCategory).toLowerCase());
  }
  if (filters.sessionId) {
    where.push(`${col("session_id")} = ?`);
    params.push(String(filters.sessionId));
  }
  if (filters.objectRevision) {
    where.push(`${col("object_revision")} = ?`);
    params.push(String(filters.objectRevision));
  }
  if (filters.failureCategory) {
    where.push(`${col("failure_category")} = ?`);
    params.push(String(filters.failureCategory));
  }
  const relatedType = filters.relatedResourceType || filters.relatedObjectType;
  if (relatedType) {
    where.push(`${col("related_resource_type")} = ?`);
    params.push(String(relatedType));
  }
  const relatedId = filters.relatedResourceId || filters.relatedObjectId;
  if (relatedId) {
    where.push(`${col("related_resource_id")} = ?`);
    params.push(String(relatedId));
  }
  if (filters.changedAttribute) {
    where.push(`EXISTS (SELECT 1 FROM audit_event_changes c WHERE c.event_id = audit_logs.id AND c.attribute = ?)`);
    params.push(String(filters.changedAttribute));
  }
  if (filters.hasChanges === true || filters.hasChanges === "true") {
    where.push(`${col("changed_fields")} IS NOT NULL AND ${col("changed_fields")} <> '[]'`);
  }
  if (filters.eventType) {
    where.push(`${col("event_type")} = ?`);
    params.push(String(filters.eventType).toUpperCase());
  }
  if (filters.source) {
    where.push(`${col("source")} = ?`);
    params.push(String(filters.source));
  }
  if (filters.status) {
    where.push(`${col("status")} = ?`);
    params.push(String(filters.status));
  }
  if (filters.correlationId) {
    where.push(`${col("correlation_id")} = ?`);
    params.push(String(filters.correlationId));
  }
  if (filters.parentEventId) {
    where.push(`${col("parent_event_id")} = ?`);
    params.push(Number(filters.parentEventId));
  }
  const from = normalizeDate(filters.from);
  if (from) {
    where.push(`${col("created_at")} >= ?`);
    params.push(from);
  }
  const to = normalizeDate(filters.to, true);
  if (to) {
    where.push(`${col("created_at")} <= ?`);
    params.push(to);
  }
  if (filters.q) {
    const like = likeTerm(filters.q);
    where.push(
      `(${col("actor_username")} LIKE ? OR ${col("object_name")} LIKE ? OR ${col("action")} LIKE ? OR ${col("resource_id")} LIKE ? OR ${col("details")} LIKE ? OR ${col("error_message")} LIKE ?)`
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
  const categories = queryAll(
    db,
    `SELECT category, COUNT(*) AS count FROM audit_logs ${clause} GROUP BY category ORDER BY count DESC`,
    params
  );
  const actorTypes = queryAll(
    db,
    `SELECT actor_type, COUNT(*) AS count FROM audit_logs ${clause} GROUP BY actor_type ORDER BY count DESC`,
    params
  );
  const statuses = queryAll(
    db,
    `SELECT status, COUNT(*) AS count FROM audit_logs ${clause} GROUP BY status ORDER BY count DESC`,
    params
  );
  return { actions, sources, event_types: eventTypes, categories, actor_types: actorTypes, statuses };
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

// Attribute-level history for a single object: every event that changed the
// named attribute, with the before/after values extracted from the change
// table so callers get a compact timeline instead of full events.
export function attributeHistory(db, { objectType, objectId, attribute }, filters = {}, scope = {}) {
  if (!objectType || !objectId) throw new HttpError(400, "objectType and objectId are required");
  if (!attribute) throw new HttpError(400, "attribute is required");
  const { where, params } = buildEventFilters(
    { ...filters, objectType, objectId, changedAttribute: attribute },
    scope
  );
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(500, Math.max(1, Number(filters.pageSize) || 100));
  const rows = queryAll(
    db,
    `SELECT audit_logs.id, audit_logs.action, audit_logs.event_type, audit_logs.category,
            audit_logs.actor_id, audit_logs.actor_username, audit_logs.status, audit_logs.reason,
            audit_logs.created_at, c.old_value, c.new_value, c.value_type, c.masked
       FROM audit_logs
       JOIN audit_event_changes c ON c.event_id = audit_logs.id
       ${clause ? `${clause} AND` : "WHERE"} c.attribute = ?
      ORDER BY audit_logs.created_at DESC, audit_logs.id DESC LIMIT ?`,
    [...params, String(attribute), limit]
  );
  return {
    object_type: objectType,
    object_id: String(objectId),
    attribute,
    items: rows.map((row) => ({
      event_id: row.id,
      action: row.action,
      event_type: row.event_type,
      category: row.category,
      actor_id: row.actor_id ?? null,
      actor_username: row.actor_username ?? null,
      status: row.status,
      reason: row.reason ?? null,
      old_value: safeJson(row.old_value),
      new_value: safeJson(row.new_value),
      value_type: row.value_type,
      masked: !!row.masked,
      occurred_at: row.created_at,
    })),
  };
}

function safeJson(raw) {
  if (raw === null || raw === undefined) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Relationship history for an object, matching events where the object is
// either the subject or the related resource.
export function relationshipHistory(db, { objectType, objectId }, filters = {}, scope = {}) {
  if (!objectType || !objectId) throw new HttpError(400, "objectType and objectId are required");
  const base = buildEventFilters({ ...filters, objectType, objectId }, scope);
  const related = buildEventFilters(
    { ...filters, relatedResourceType: objectType, relatedResourceId: objectId },
    scope
  );
  const clause = `WHERE (${base.where.join(" AND ")}) OR (${related.where.join(" AND ")})`;
  const page = Math.max(1, Number(filters.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(filters.pageSize) || 25));
  const offset = (page - 1) * pageSize;
  const params = [...base.params, ...related.params];
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM audit_logs ${clause}`, params).c;
  const rows = queryAll(
    db,
    `SELECT * FROM audit_logs ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return { items: rows.map(publicEvent), total, page, pageSize };
}

// Category-scoped activity views. Each delegates to listEvents so filters,
// pagination and tenant scoping behave identically to the main event stream.
function categoryView(category) {
  return (db, filters = {}, scope = {}) => listEvents(db, { ...filters, category }, scope);
}

export const securityActivity = categoryView("security");
export const workflowAudit = categoryView("workflow");
export const lifecycleAudit = categoryView("lifecycle");
export const configurationAudit = categoryView("configuration");
export const approvalAudit = categoryView("approval");
export const documentAudit = categoryView("document");
export const integrationAudit = categoryView("integration");
export const backgroundJobAudit = categoryView("background_job");

// Operational metrics for the audit console: volume, security outcomes,
// storage growth, retention/archive state and export activity. Tenant scoped
// unless the caller is a platform operator.
export function auditMetrics(db, filters = {}, scope = {}) {
  const { where, params } = buildEventFilters(filters, scope);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const totals = queryOne(
    db,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN security_classification IN ('confidential','restricted') THEN 1 ELSE 0 END) AS sensitive,
            SUM(CASE WHEN status IN ('failure','denied') THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN event_type = 'LOGIN_FAILED' THEN 1 ELSE 0 END) AS login_failures,
            SUM(CASE WHEN event_type = 'ACCESS_DENIED' THEN 1 ELSE 0 END) AS access_denials,
            SUM(CASE WHEN event_type = 'EXPORT' THEN 1 ELSE 0 END) AS exports,
            MIN(created_at) AS oldest,
            MAX(created_at) AS newest
     FROM audit_logs ${clause}`,
    params
  );
  const byCategory = queryAll(
    db,
    `SELECT category, COUNT(*) AS count FROM audit_logs ${clause} GROUP BY category ORDER BY count DESC`,
    params
  );
  const byActorType = queryAll(
    db,
    `SELECT actor_type, COUNT(*) AS count FROM audit_logs ${clause} GROUP BY actor_type ORDER BY count DESC`,
    params
  );
  const byDayClause = where.length
    ? `WHERE ${where.join(" AND ")} AND created_at >= datetime('now', '-30 days')`
    : "WHERE created_at >= datetime('now', '-30 days')";
  const byDay = queryAll(
    db,
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count FROM audit_logs ${byDayClause}
     GROUP BY day ORDER BY day ASC`,
    params
  );
  const growth = queryAll(
    db,
    `SELECT
        SUM(CASE WHEN created_at >= datetime('now', '-1 day') THEN 1 ELSE 0 END) AS last_24h,
        SUM(CASE WHEN created_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS last_7d,
        SUM(CASE WHEN created_at >= datetime('now', '-30 days') THEN 1 ELSE 0 END) AS last_30d
     FROM audit_logs ${clause}`,
    params
  )[0] || {};
  const archive = archiveStatsFor(db, scope);
  const retention = queryOne(
    db,
    "SELECT COUNT(*) AS runs FROM audit_retention_runs WHERE tenant_id IS NULL OR tenant_id = ?",
    [normalizeScope(scope).tenantId ?? -1]
  );
  const exports = queryOne(
    db,
    "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed FROM audit_export_requests WHERE tenant_id IS NULL OR tenant_id = ?",
    [normalizeScope(scope).tenantId ?? -1]
  );
  return {
    total: totals.total || 0,
    sensitive: totals.sensitive || 0,
    failed: totals.failed || 0,
    login_failures: totals.login_failures || 0,
    access_denials: totals.access_denials || 0,
    export_events: totals.exports || 0,
    oldest: totals.oldest || null,
    newest: totals.newest || null,
    growth: {
      last_24h: growth.last_24h || 0,
      last_7d: growth.last_7d || 0,
      last_30d: growth.last_30d || 0,
    },
    by_category: byCategory,
    by_actor_type: byActorType,
    by_day: byDay,
    archive,
    retention_runs: retention?.runs || 0,
    exports: { total: exports?.total || 0, completed: exports?.completed || 0 },
  };
}

function archiveStatsFor(db, scope) {
  const { tenantId, scopeAll } = normalizeScope(scope);
  if (scopeAll) {
    return { live: queryOne(db, "SELECT COUNT(*) AS c FROM audit_logs").c, archived: queryOne(db, "SELECT COUNT(*) AS c FROM audit_logs_archive").c };
  }
  return {
    live: queryOne(db, "SELECT COUNT(*) AS c FROM audit_logs WHERE tenant_id = ?", [tenantId ?? -1]).c,
    archived: queryOne(db, "SELECT COUNT(*) AS c FROM audit_logs_archive WHERE tenant_id = ?", [tenantId ?? -1]).c,
  };
}
