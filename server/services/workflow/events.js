import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { pagination } from "../../validation.js";
import { safeParse } from "./validation.js";

// Append-only workflow history. Every meaningful runtime action writes an event
// so the instance timeline is reconstructable without replaying the engine.

export function publicEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    instance_id: row.instance_id,
    task_id: row.task_id ?? null,
    node_key: row.node_key || "",
    event_type: row.event_type,
    actor_id: row.actor_id ?? null,
    actor_username: row.actor_username ?? null,
    message: row.message || "",
    details: safeParse(row.details_json, {}),
    created_at: row.created_at,
  };
}

export function recordEvent(db, { instanceId, taskId = null, nodeKey = "", eventType, actorId = null, message = "", details = {}, tenantId }) {
  if (!tenantId) return null;
  const result = run(
    db,
    `INSERT INTO workflow_events
      (instance_id, task_id, node_key, event_type, actor_id, message, details_json, tenant_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [Number(instanceId), taskId ?? null, nodeKey || "", eventType, actorId ?? null, message || "", JSON.stringify(details || {}), Number(tenantId), nowIso()]
  );
  return queryOne(db, "SELECT * FROM workflow_events WHERE id = ?", [result.lastInsertRowid]);
}

export function listEvents(db, instanceId, query = {}) {
  const { page, pageSize, offset } = pagination(query);
  const total = queryOne(db, "SELECT COUNT(*) AS c FROM workflow_events WHERE instance_id = ?", [Number(instanceId)]).c;
  const items = queryAll(
    db,
    `SELECT e.*, u.username AS actor_username FROM workflow_events e
      LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.instance_id = ? ORDER BY e.id LIMIT ? OFFSET ?`,
    [Number(instanceId), pageSize, offset]
  ).map(publicEvent);
  return { items, total, page, pageSize };
}
