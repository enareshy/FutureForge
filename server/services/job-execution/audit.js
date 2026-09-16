// Audit trail for engine administrative configuration changes.
//
// Queue and schedule mutations are recorded both in the platform audit log
// (writeAudit) and in `job_engine_audit` so the engine retains a self-contained
// history even when the platform audit log is queried separately.

import { run, queryAll, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";

export function recordEngineAudit(db, { tenantId = null, entityType, entityId = "", entityCode = "", action, actor = null, detail = {}, ip = null }) {
  run(
    db,
    `INSERT INTO job_engine_audit (tenant_id, entity_type, entity_id, entity_code, action, actor_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId === null || tenantId === undefined ? null : Number(tenantId),
      String(entityType),
      String(entityId || ""),
      String(entityCode || ""),
      String(action),
      actor?.id ?? null,
      JSON.stringify(detail || {}),
      nowIso(),
    ]
  );
  writeAudit(db, {
    actor,
    action: `job_engine.${entityType}.${action}`,
    resourceType: entityType,
    resourceId: entityId || entityCode,
    details: { entity_code: entityCode, ...detail },
    ip,
  });
}

export function listEngineAudit(db, { tenantId = null, entityType = null, entityId = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (tenantId !== null && tenantId !== undefined) {
    where.push("COALESCE(tenant_id, 0) = ?");
    params.push(Number(tenantId));
  }
  if (entityType) {
    where.push("entity_type = ?");
    params.push(String(entityType));
  }
  if (entityId) {
    where.push("entity_id = ?");
    params.push(String(entityId));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return queryAll(
    db,
    `SELECT * FROM job_engine_audit ${clause} ORDER BY id DESC LIMIT ?`,
    [...params, Math.max(1, Math.min(500, Number(limit) || 100))]
  ).map((row) => ({
    id: row.id,
    tenant_id: row.tenant_id ?? null,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    entity_code: row.entity_code,
    action: row.action,
    actor_id: row.actor_id ?? null,
    detail: row.detail_json ? JSON.parse(row.detail_json) : {},
    created_at: row.created_at,
  }));
}
