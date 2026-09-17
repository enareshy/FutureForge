// Search result exports. Export requests run through the background job engine
// so large result sets never block a request; results are retained for a
// bounded window and served as CSV or JSON.
import { queryAll, queryOne, run, nowIso, randomUuid } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { publicExport, exportRow } from "./repository.js";
import { EXPORT_FORMATS, addDays } from "./validation.js";
import { runSearch } from "./query.js";
import { getConfiguration } from "./config.js";
import { submitJob } from "../jobs/jobs.js";

const RETENTION_DAYS = Number(process.env.SEARCH_EXPORT_RETENTION_DAYS || 7);
const EXPORT_ROW_CAP = 5000;

function csvCell(value) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(items) {
  const columns = [
    "object_type",
    "object_id",
    "object_uuid",
    "code",
    "title",
    "subtitle",
    "summary",
    "status",
    "lifecycle_state",
    "owner_name",
    "classification",
    "tags",
    "indexed_at",
  ];
  const lines = [columns.join(",")];
  for (const item of items) {
    lines.push(columns.map((column) => csvCell(item[column])).join(","));
  }
  return lines.join("\n");
}

export function requestExport(db, input = {}, actor, tenantId, ip) {
  const format = String(input.format || "json").toLowerCase();
  if (!EXPORT_FORMATS.includes(format)) {
    throw new HttpError(400, `format must be one of ${EXPORT_FORMATS.join(", ")}`);
  }
  const query = input.query && typeof input.query === "object" ? input.query : input;
  const uuid = randomUuid();
  const ts = nowIso();
  const name = String(input.name || `Search export ${ts}`).slice(0, 255);
  run(
    db,
    `INSERT INTO search_exports
       (uuid, tenant_id, requested_by, name, query_json, format, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [uuid, Number(tenantId), actor?.id ?? null, name, JSON.stringify(query), format, ts, ts]
  );
  const row = queryOne(db, "SELECT * FROM search_exports WHERE uuid = ?", [uuid]);
  try {
    const job = submitJob(
      db,
      {
        job_type_code: "SEARCH_EXPORT",
        name: `Search export ${row.uuid}`,
        tenant_id: tenantId,
        organization_id: actor?.organization_id ?? null,
        input: { export_id: row.id },
        idempotency_key: `search-export:${row.uuid}`,
        related_object_type: "search_export",
        related_object_id: String(row.id),
        source_module: "search",
      },
      { actor, ip }
    );
    run(db, "UPDATE search_exports SET updated_at = ? WHERE id = ?", [nowIso(), row.id]);
    writeAudit(db, {
      actor,
      action: "search.export.request",
      resourceType: "search_export",
      resourceId: row.uuid,
      details: { format, job: job?.job_ref || null },
      ip,
    });
    return { ...publicExport(queryOne(db, "SELECT * FROM search_exports WHERE id = ?", [row.id])), job_ref: job?.job_ref || null };
  } catch (err) {
    run(db, "UPDATE search_exports SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", [
      String(err.message || err).slice(0, 1000),
      nowIso(),
      row.id,
    ]);
    writeAudit(db, {
      actor,
      action: "search.export.request_failed",
      resourceType: "search_export",
      resourceId: row.uuid,
      details: { error: String(err.message || err) },
      ip,
    });
    throw err;
  }
}

export function runExport(db, exportId) {
  const row = queryOne(db, "SELECT * FROM search_exports WHERE id = ?", [Number(exportId)]);
  if (!row) throw new HttpError(404, "Search export not found");
  run(db, "UPDATE search_exports SET status = 'processing', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  try {
    const query = JSON.parse(row.query_json || "{}");
    const config = getConfiguration(db, row.tenant_id);
    const result = runSearch(
      db,
      { ...query, page: 1, page_size: Math.min(config.max_results, EXPORT_ROW_CAP), recordHistory: false },
      { id: row.requested_by, tenant_id: row.tenant_id, organization_id: null },
      { tenantId: row.tenant_id, recordHistory: false, provider: null }
    );
    const items = (result.items || []).slice(0, EXPORT_ROW_CAP);
    const content = row.format === "csv" ? toCsv(items) : JSON.stringify(items, null, 2);
    const expiresAt = addDays(RETENTION_DAYS);
    run(
      db,
      `UPDATE search_exports
         SET status = 'completed', row_count = ?, result_json = ?, completed_at = ?, expires_at = ?, error = NULL, updated_at = ?
       WHERE id = ?`,
      [items.length, JSON.stringify({ content }), nowIso(), expiresAt, nowIso(), row.id]
    );
  } catch (err) {
    run(
      db,
      "UPDATE search_exports SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
      [String(err.message || err).slice(0, 1000), nowIso(), row.id]
    );
    throw err;
  }
  return publicExport(queryOne(db, "SELECT * FROM search_exports WHERE id = ?", [row.id]));
}

export function listExports(db, { tenantId, actorId, limit = 50 } = {}) {
  const params = [Number(tenantId)];
  let where = "tenant_id = ?";
  if (actorId !== undefined && actorId !== null) {
    where += " AND requested_by = ?";
    params.push(Number(actorId));
  }
  return queryAll(
    db,
    `SELECT * FROM search_exports WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, Math.min(Math.max(Number(limit) || 50, 1), 200)]
  ).map(publicExport);
}

export function getExport(db, reference, actor, tenantId, { includeContent = false } = {}) {
  const row = exportRow(db, reference, tenantId);
  if (!row) throw new HttpError(404, "Search export not found");
  const dto = publicExport(row);
  if (!includeContent) return dto;
  if (row.status !== "completed") throw new HttpError(409, `Export is ${row.status}`);
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    throw new HttpError(410, "Export has expired");
  }
  const parsed = row.result_json ? JSON.parse(row.result_json) : { content: "" };
  return { ...dto, content: parsed.content };
}

export function expireExports(db, { tenantId = null } = {}) {
  const params = [nowIso(), nowIso()];
  let where = "status = 'completed' AND expires_at IS NOT NULL AND expires_at < ?";
  if (tenantId) {
    where += " AND tenant_id = ?";
    params.push(Number(tenantId));
  }
  const result = run(db, `UPDATE search_exports SET status = 'expired', updated_at = ? WHERE ${where}`, params);
  return { expired: result.changes };
}

export { RETENTION_DAYS as EXPORT_RETENTION_DAYS };
