// Change Management history and centralized audit integration. Writes are
// recorded in the domain's own queryable lineage AND in the centralized
// Audit & History Framework — there is exactly one audit engine on the
// platform; this module never duplicates it (mirrors server/services/pdm/history.js).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { publicHistory } from "./repository.js";
import { normalizeText, normalizeUpper, paginate } from "./validation.js";
import { SOURCE_MODULE } from "./constants.js";

const CHANGE_HISTORY_INSERT_SQL = `INSERT INTO change_history
   (tenant_id, organization_id, entity_type, entity_id, entity_ref, action, version, status,
    before_json, after_json, actor_user_id, actor_username, correlation_id, details_json, created_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function changeHistoryInsertParams(input) {
  return [
    Number(input.tenantId),
    input.organizationId != null ? Number(input.organizationId) : null,
    normalizeUpper(input.entityType || "REQUEST"),
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
    nowIso(),
  ];
}

function changeHistoryAudit(input) {
  return {
    actor: input.actor || (input.actorUserId ? { id: input.actorUserId, username: input.actorUsername } : null),
    action: `change.${String(input.action || "updated").toLowerCase()}`,
    resourceType: `change_${String(input.entityType || "request").toLowerCase()}`,
    resourceId: input.entityId ?? input.entityRef ?? null,
    resourceName: input.entityRef || "",
    details: {
      entity_type: input.entityType,
      entity_ref: input.entityRef,
      version: input.version,
      status: input.status,
      ...(input.details || {}),
    },
    sourceModule: SOURCE_MODULE,
    ip: input.ip || null,
  };
}

export function recordChange(db, input = {}) {
  const result = run(db, CHANGE_HISTORY_INSERT_SQL, changeHistoryInsertParams(input));

  try {
    writeAudit(db, changeHistoryAudit(input));
  } catch {
    // Auditing must never fail the business write.
  }
  return Number(result.lastInsertId);
}

export async function recordChangeAsync(db, input = {}) {
  const result = await runAsync(db, CHANGE_HISTORY_INSERT_SQL, changeHistoryInsertParams(input));

  try {
    await writeAuditAsync(db, changeHistoryAudit(input));
  } catch {
    // Auditing must never fail the business write.
  }
  return Number(result.lastInsertId);
}

function historyFilters({ tenantId, entityType, entityId, entityRef } = {}) {
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
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listHistory(db, { tenantId, entityType, entityId, entityRef, page, pageSize } = {}) {
  const { where, params } = historyFilters({ tenantId, entityType, entityId, entityRef });
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM change_history ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM change_history ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicHistory), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listHistoryAsync(db, { tenantId, entityType, entityId, entityRef, page, pageSize } = {}) {
  const { where, params } = historyFilters({ tenantId, entityType, entityId, entityRef });
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM change_history ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM change_history ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicHistory), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}
