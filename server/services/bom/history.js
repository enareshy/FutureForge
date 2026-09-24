// BOM change history and centralized audit integration.
//
// BOM lifecycle, line, substitute, baseline, transformation and validation
// changes are recorded in the BOM change history (the queryable lineage the
// engine owns) AND written to the centralized Audit & History Framework. There
// is exactly one audit engine on the platform; this module never duplicates it.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { publicHistory } from "./repository.js";
import { normalizeText, normalizeUpper, paginate } from "./validation.js";
import { SOURCE_MODULE } from "./constants.js";

export function recordChange(db, input = {}) {
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO bom_change_history
       (tenant_id, organization_id, entity_type, entity_id, entity_ref, action, version, status,
        before_json, after_json, actor_user_id, actor_username, correlation_id, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(input.tenantId),
      input.organizationId != null ? Number(input.organizationId) : null,
      normalizeUpper(input.entityType || "BOM"),
      input.entityId != null ? Number(input.entityId) : null,
      normalizeText(input.entityRef, { max: 200 }),
      normalizeUpper(input.action || "UPDATED"),
      Number(input.version || 0),
      normalizeUpper(input.status || ""),
      JSON.stringify(input.before && typeof input.before === "object" ? input.before : {}),
      JSON.stringify(input.after && typeof input.after === "object" ? input.after : {}),
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
        action: `bom.${String(input.action || "updated").toLowerCase()}`,
        resourceType: `bom_${String(input.entityType || "bom").toLowerCase()}`,
        resourceId: input.entityId ?? input.entityRef ?? null,
        resourceName: input.entityRef || "",
        details: {
          entity_type: input.entityType,
          entity_ref: input.entityRef,
          version: input.version,
          status: input.status,
          before: input.before,
          after: input.after,
          ...(input.details || {}),
        },
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
    params.push(Number(entityId));
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
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM bom_change_history ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM bom_change_history ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicHistory), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

// Full BOM lineage for one object (all header/revision/line history).
export function objectLineage(db, tenantId, objectType, objectId) {
  const ref = `${normalizeText(objectType, { max: 120 })}:${normalizeText(objectId, { max: 300 })}`;
  const rows = queryAll(
    db,
    "SELECT * FROM bom_change_history WHERE tenant_id = ? AND entity_ref = ? ORDER BY id ASC",
    [Number(tenantId), ref]
  );
  return rows.map(publicHistory);
}
