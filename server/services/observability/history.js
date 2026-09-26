// Change history for Data Observability.
//
// Every configuration change, alert lifecycle transition and incident action
// is recorded so auditing and trend analysis have a durable trail. The history
// store is intentionally generic: it is the observability module's own log and
// never replaces the central Audit & History Framework.
import { queryAll, run, nowIso } from "../../db.js";
import { paged, parseJson, stringifyJson } from "./repository.js";

export function publicHistory(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    entity_ref: row.entity_ref,
    actor_id: row.actor_id,
    summary: row.summary,
    detail: parseJson(row.detail_json, {}),
    created_at: row.created_at,
  };
}

export function recordHistory(db, { tenantId, action, entityType = "metric", entityId = "", entityRef = "", actor = null, summary = "", detail = {} }) {
  const result = run(
    db,
    `INSERT INTO observability_history (tenant_id, action, entity_type, entity_id, entity_ref, actor_id, summary, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [Number(tenantId), String(action), String(entityType), String(entityId ?? ""), String(entityRef ?? ""), actor?.id ?? null, String(summary || ""), stringifyJson(detail), nowIso()]
  );
  return Number(result.lastInsertRowid);
}

export function listHistory(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.entity_type || query.entityType) {
    where.push("entity_type = ?");
    params.push(String(query.entity_type || query.entityType));
  }
  if (query.entity_ref || query.entityRef) {
    where.push("entity_ref = ?");
    params.push(String(query.entity_ref || query.entityRef));
  }
  if (query.action) {
    where.push("action = ?");
    params.push(String(query.action));
  }
  return paged(db, "observability_history", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicHistory });
}

export function pruneHistory(db, tenantId, retainDays) {
  const days = Math.max(1, Number(retainDays) || 180);
  const result = run(db, "DELETE FROM observability_history WHERE tenant_id = ? AND created_at < datetime('now', ?)", [Number(tenantId), `-${days} days`]);
  return Number(result.changes || 0);
}
