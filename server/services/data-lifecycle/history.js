// Append-only lifecycle history.
//
// Every state change, archive, restore, recovery and purge appends a row here.
// History is the authoritative evidence trail for the lifecycle ledger and is
// never mutated.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { SOURCE_MODULE } from "./constants.js";
import { publicHistory } from "./repository.js";
import { normalizeText, normalizeUpper, paginate } from "./validation.js";

export { publicHistory };

export function recordHistory(db, input = {}) {
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO lc_history (tenant_id, object_type, object_id, object_ref, action, from_state, to_state, data_tier, policy_id, reason, details_json, actor_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(input.tenantId),
      normalizeText(input.objectType, { max: 120 }),
      String(input.objectId),
      normalizeText(input.objectRef, { max: 200 }),
      normalizeUpper(input.action),
      input.fromState ? normalizeUpper(input.fromState) : null,
      input.toState ? normalizeUpper(input.toState) : null,
      input.dataTier ? normalizeUpper(input.dataTier) : null,
      input.policyId != null ? Number(input.policyId) : null,
      normalizeText(input.reason),
      JSON.stringify(input.details && typeof input.details === "object" ? input.details : {}),
      input.actorId != null ? Number(input.actorId) : input.actor?.id ?? null,
      ts,
    ]
  );
  return publicHistory(queryOne(db, "SELECT * FROM lc_history WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function listHistory(db, { tenantId, objectType, objectId, action, from, to, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(normalizeText(objectType, { max: 120 }));
  }
  if (objectId !== undefined && objectId !== null && objectId !== "") {
    clauses.push("object_id = ?");
    params.push(String(objectId));
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
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM lc_history ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM lc_history ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicHistory), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}
