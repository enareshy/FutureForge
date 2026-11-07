// Deployment history and centralized audit integration.
//
// Every profile or entitlement change is written to this domain's own
// queryable ledger AND to the platform Audit & History Framework — there is
// exactly one audit engine on the platform and this module never duplicates it
// (mirrors server/services/change/history.js).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { paginate } from "../data-exchange/validation.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { SOURCE_MODULE } from "./constants.js";

function deploymentChangeInsertParams(input) {
  return [
    String(input.action || "updated"),
    String(input.entityType || "profile"),
    String(input.entityRef || ""),
    JSON.stringify(input.before && typeof input.before === "object" ? input.before : {}),
    JSON.stringify(input.after && typeof input.after === "object" ? input.after : {}),
    JSON.stringify(input.details && typeof input.details === "object" ? input.details : {}),
    input.actor?.id != null ? Number(input.actor.id) : null,
    String(input.actor?.username || ""),
    input.ip || null,
    nowIso(),
  ];
}

const DEPLOYMENT_CHANGE_INSERT_SQL = `INSERT INTO deployment_history
   (action, entity_type, entity_ref, before_json, after_json, details_json,
    actor_user_id, actor_username, ip, created_at)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function deploymentChangeAudit(input) {
  return {
    actor: input.actor || null,
    action: `deployment.${String(input.action || "updated").toLowerCase()}`,
    resourceType: `deployment_${String(input.entityType || "profile").toLowerCase()}`,
    resourceId: input.entityRef || null,
    resourceName: input.entityRef || "",
    details: {
      entity_type: input.entityType,
      entity_ref: input.entityRef,
      ...(input.details || {}),
    },
    sourceModule: SOURCE_MODULE,
    ip: input.ip || null,
  };
}

export function recordDeploymentChange(db, input = {}) {
  const result = run(db, DEPLOYMENT_CHANGE_INSERT_SQL, deploymentChangeInsertParams(input));

  try {
    writeAudit(db, deploymentChangeAudit(input));
  } catch {
    // Auditing must never fail the business write.
  }
  return Number(result.lastInsertId);
}

export async function recordDeploymentChangeAsync(db, input = {}) {
  const result = await runAsync(db, DEPLOYMENT_CHANGE_INSERT_SQL, deploymentChangeInsertParams(input));

  try {
    await writeAuditAsync(db, deploymentChangeAudit(input));
  } catch {
    // Auditing must never fail the business write.
  }
  return Number(result.lastInsertId);
}

function publicHistory(row) {
  return {
    id: row.id,
    action: row.action,
    entity_type: row.entity_type,
    entity_ref: row.entity_ref,
    before: safeParse(row.before_json),
    after: safeParse(row.after_json),
    details: safeParse(row.details_json),
    actor_user_id: row.actor_user_id,
    actor_username: row.actor_username,
    ip: row.ip,
    created_at: row.created_at,
  };
}

function safeParse(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function historyFilters({ action, entityType, entityRef } = {}) {
  const clauses = [];
  const params = [];
  if (action) {
    clauses.push("action = ?");
    params.push(String(action));
  }
  if (entityType) {
    clauses.push("entity_type = ?");
    params.push(String(entityType));
  }
  if (entityRef) {
    clauses.push("entity_ref = ?");
    params.push(String(entityRef));
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listDeploymentHistory(db, { action, entityType, entityRef, page, pageSize } = {}) {
  const { where, params } = historyFilters({ action, entityType, entityRef });
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 200 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM deployment_history ${where}`, params)?.c || 0);
  const rows = queryAll(
    db,
    `SELECT * FROM deployment_history ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { items: rows.map(publicHistory), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listDeploymentHistoryAsync(db, { action, entityType, entityRef, page, pageSize } = {}) {
  const { where, params } = historyFilters({ action, entityType, entityRef });
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 200 });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM deployment_history ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(
    db,
    `SELECT * FROM deployment_history ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  return { items: rows.map(publicHistory), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}
