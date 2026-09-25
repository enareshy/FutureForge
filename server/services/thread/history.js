// Digital Thread change and query history.
//
// Structural writes are recorded in thread_change_history (the queryable
// lineage the domain owns) and mirrored to the centralized Audit & History
// Framework. Traversals, impact, path and compare queries are recorded in
// thread_query_history so the UI can show recent activity and metrics without
// scanning audit logs.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { publicHistory, publicQueryHistory } from "./repository.js";
import { normalizeText, normalizeUpper, paginate } from "./validation.js";
import { SOURCE_MODULE } from "./constants.js";

export function recordChange(db, input = {}) {
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO thread_change_history
       (tenant_id, entity_type, entity_id, entity_ref, action, version, status,
        before_json, after_json, summary, actor_user_id, actor_username, correlation_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(input.tenantId),
      normalizeUpper(input.entityType || "DEFINITION"),
      input.entityId != null ? String(input.entityId) : null,
      normalizeText(input.entityRef, { max: 300 }),
      normalizeUpper(input.action || "UPDATED"),
      Number(input.version || 0),
      normalizeUpper(input.status || ""),
      JSON.stringify(input.before && typeof input.before === "object" ? input.before : {}),
      JSON.stringify(input.after && typeof input.after === "object" ? input.after : {}),
      normalizeText(input.summary, { max: 1000 }),
      input.actorUserId != null ? Number(input.actorUserId) : input.actor?.id ?? null,
      normalizeText(input.actorUsername || input.actor?.username, { max: 120 }),
      normalizeText(input.correlationId, { max: 120 }),
      JSON.stringify(input.details && typeof input.details === "object" ? input.details : {}),
      ts,
    ]
  );
  if (input.audit !== false) {
    try {
      writeAudit(db, {
        actor: input.actor || (input.actorUserId ? { id: input.actorUserId, username: input.actorUsername } : null),
        action: `thread.${String(input.action || "updated").toLowerCase()}`,
        resourceType: `thread_${String(input.entityType || "definition").toLowerCase()}`,
        resourceId: input.entityId ?? input.entityRef ?? null,
        resourceName: input.entityRef || "",
        details: { entity_type: input.entityType, entity_ref: input.entityRef, version: input.version, status: input.status, ...(input.details || {}) },
        sourceModule: SOURCE_MODULE,
        ip: input.ip || null,
      });
    } catch {
      // Auditing must never fail the business write.
    }
  }
  return Number(result.lastInsertRowid);
}

export function listHistory(db, { tenantId, entityType, entityId, entityRef, action, from, to, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (entityType) {
    clauses.push("entity_type = ?");
    params.push(normalizeUpper(entityType));
  }
  if (entityId != null) {
    clauses.push("entity_id = ?");
    params.push(String(entityId));
  }
  if (entityRef) {
    clauses.push("entity_ref = ?");
    params.push(String(entityRef));
  }
  if (action) {
    clauses.push("action = ?");
    params.push(normalizeUpper(action));
  }
  if (from) {
    clauses.push("created_at >= ?");
    params.push(String(from));
  }
  if (to) {
    clauses.push("created_at <= ?");
    params.push(String(to));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM thread_change_history ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM thread_change_history ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicHistory), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function objectLineage(db, tenantId, objectType, objectId) {
  const ref = `${normalizeText(objectType, { max: 120 })}:${normalizeText(objectId, { max: 300 })}`;
  const rows = queryAll(db, "SELECT * FROM thread_change_history WHERE tenant_id = ? AND entity_ref = ? ORDER BY id ASC", [Number(tenantId), ref]);
  return rows.map(publicHistory);
}

export function recordQuery(db, { tenantId, action, request = {}, summary = {}, durationMs = 0, nodeCount = 0, edgeCount = 0, truncated = false, actor = null } = {}) {
  const result = run(
    db,
    `INSERT INTO thread_query_history
       (tenant_id, action, request_json, result_summary_json, duration_ms, node_count, edge_count, truncated, actor_user_id, actor_username, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(tenantId),
      normalizeUpper(action || "TRAVERSAL"),
      JSON.stringify(request || {}),
      JSON.stringify(summary || {}),
      Number(durationMs) || 0,
      Number(nodeCount) || 0,
      Number(edgeCount) || 0,
      truncated ? 1 : 0,
      actor?.id ?? null,
      normalizeText(actor?.username, { max: 120 }),
      nowIso(),
    ]
  );
  return Number(result.lastInsertRowid);
}

export function listQueryHistory(db, { tenantId, action, from, to, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (action) {
    clauses.push("action = ?");
    params.push(normalizeUpper(action));
  }
  if (from) {
    clauses.push("created_at >= ?");
    params.push(String(from));
  }
  if (to) {
    clauses.push("created_at <= ?");
    params.push(String(to));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 200 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM thread_query_history ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM thread_query_history ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicQueryHistory), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}
