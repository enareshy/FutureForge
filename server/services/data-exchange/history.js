// Append-only import/export history.
//
// Every definition change and job execution appends a row to ie_import_history
// or ie_export_history. History is the authoritative evidence trail and is never
// mutated.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { SOURCE_MODULE } from "./constants.js";
import { publicHistory } from "./repository.js";
import { normalizeText, normalizeUpper, paginate } from "./validation.js";

export { publicHistory };

const TABLES = Object.freeze({ IMPORT: "ie_import_history", EXPORT: "ie_export_history" });

function tableFor(direction) {
  const table = TABLES[normalizeUpper(direction)];
  if (!table) throw new Error(`Unsupported history direction: ${direction}`);
  return table;
}

export function recordHistory(db, input = {}) {
  const direction = normalizeUpper(input.direction || "IMPORT");
  const table = tableFor(direction);
  const ts = nowIso();
  const base = {
    tenant_id: Number(input.tenantId),
    job_id: input.jobId != null ? Number(input.jobId) : null,
    definition_id: input.definitionId != null ? Number(input.definitionId) : null,
    definition_version: Number(input.definitionVersion || 1),
    action: normalizeUpper(input.action),
    status: normalizeUpper(input.status || ""),
    details_json: JSON.stringify(input.details && typeof input.details === "object" ? input.details : {}),
    actor_id: input.actorId != null ? Number(input.actorId) : input.actor?.id ?? null,
    organization_id: input.organizationId != null ? Number(input.organizationId) : null,
    created_at: ts,
  };

  if (direction === "IMPORT") {
    const result = run(
      db,
      `INSERT INTO ie_import_history (tenant_id, job_id, definition_id, definition_version, action, status, source_type, target_object_type, total_records, success_count, failed_count, details_json, actor_id, organization_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        base.tenant_id,
        base.job_id,
        base.definition_id,
        base.definition_version,
        base.action,
        base.status,
        normalizeText(input.sourceType, { max: 64 }),
        normalizeText(input.targetObjectType, { max: 120 }),
        Number(input.totalRecords || 0),
        Number(input.successCount || 0),
        Number(input.failedCount || 0),
        base.details_json,
        base.actor_id,
        base.organization_id,
        base.created_at,
      ]
    );
    return publicHistory(queryOne(db, `SELECT * FROM ${table} WHERE id = ?`, [Number(result.lastInsertRowid)]));
  }

  const result = run(
    db,
    `INSERT INTO ie_export_history (tenant_id, job_id, definition_id, definition_version, action, status, object_type, format, record_count, details_json, actor_id, organization_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      base.tenant_id,
      base.job_id,
      base.definition_id,
      base.definition_version,
      base.action,
      base.status,
      normalizeText(input.objectType, { max: 120 }),
      normalizeUpper(input.format || ""),
      Number(input.recordCount || 0),
      base.details_json,
      base.actor_id,
      base.organization_id,
      base.created_at,
    ]
  );
  return publicHistory(queryOne(db, `SELECT * FROM ${table} WHERE id = ?`, [Number(result.lastInsertRowid)]));
}

export function listHistory(db, { tenantId, direction = null, definitionId, jobId, action, from, to, page, pageSize } = {}) {
  if (direction) {
    return listHistoryFor(db, tableFor(direction), { tenantId, definitionId, jobId, action, from, to, page, pageSize });
  }
  const importItems = listHistoryFor(db, TABLES.IMPORT, { tenantId, definitionId, jobId, action, from, to, page: 1, pageSize });
  const exportItems = listHistoryFor(db, TABLES.EXPORT, { tenantId, definitionId, jobId, action, from, to, page: 1, pageSize });
  const items = [...importItems.items, ...exportItems.items]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, importItems.page_size);
  return { items, total: importItems.total + exportItems.total, page: 1, page_size: importItems.page_size, source_module: SOURCE_MODULE };
}

function listHistoryFor(db, table, { tenantId, definitionId, jobId, action, from, to, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (definitionId != null) {
    clauses.push("definition_id = ?");
    params.push(Number(definitionId));
  }
  if (jobId != null) {
    clauses.push("job_id = ?");
    params.push(Number(jobId));
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
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM ${table} ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM ${table} ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicHistory), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}
