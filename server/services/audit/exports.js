// Asynchronous audit exports. An export request is persisted, then
// materialised by a background job through the Job Scheduling & Execution
// Engine. Results are retained for a bounded window and streamed on download.
import { queryAll, queryOne, run, nowIso, randomUuid } from "../../db.js";
import { HttpError } from "../../validation.js";
import { listEvents } from "./query.js";
import { EXPORT_COLUMNS, toCsv, toExcelXml, EXPORT_FORMATS } from "./export.js";
import { normalizeExportFormat, validateExportRequestInput } from "./validation.js";
import { capture } from "./events.js";
import { publishAuditEvent, AUDIT_EVENT_TYPES } from "./publisher.js";
import { submitJob } from "../jobs/jobs.js";

const RETENTION_DAYS = Number(process.env.AUDIT_EXPORT_RETENTION_DAYS || 7);
const EXPORT_ROW_CAP = Number(process.env.AUDIT_EXPORT_ROW_CAP || 50000);

function addDays(days) {
  const date = new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000);
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export function publicAuditExport(row) {
  if (!row) return null;
  const columns = safeParse(row.columns_json, []);
  return {
    id: row.id,
    uuid: row.uuid,
    tenant_id: row.tenant_id ?? null,
    requested_by: row.requested_by ?? null,
    name: row.name || "",
    format: row.format,
    status: row.status,
    filters: safeParse(row.filters_json, {}),
    columns: columns.length ? columns : EXPORT_COLUMNS.map((column) => column.key),
    reason: row.reason ?? null,
    row_count: Number(row.row_count || 0),
    content_type: row.content_type ?? null,
    error: row.error ?? null,
    job_id: row.job_id ?? null,
    expires_at: row.expires_at ?? null,
    downloaded_at: row.downloaded_at ?? null,
    download_count: Number(row.download_count || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at ?? null,
  };
}

function safeParse(raw, fallback) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function render(items, format, columns) {
  if (format === "json") return JSON.stringify(items, null, 2);
  if (format === "excel") return toExcelXml(items, "Audit export");
  if (!columns || !columns.length) return toCsv(items);
  const selected = EXPORT_COLUMNS.filter((column) => columns.includes(column.key));
  const csvCell = (value) => {
    if (value === undefined || value === null) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = items.map((item) =>
    selected
      .map((column) => {
        const value = item[column.key];
        return csvCell(Array.isArray(value) ? value.join(", ") : value);
      })
      .join(",")
  );
  return `\uFEFF${[selected.map((column) => csvCell(column.label)).join(","), ...rows].join("\r\n")}`;
}

function contentTypeFor(format) {
  if (format === "json") return "application/json; charset=utf-8";
  if (format === "excel") return "application/vnd.ms-excel; charset=utf-8";
  return "text/csv; charset=utf-8";
}

function extensionFor(format) {
  if (format === "json") return "json";
  if (format === "excel") return "xls";
  return "csv";
}

export function requestAuditExport(db, body = {}, actor = null, tenantId = null, ip = null) {
  const input = validateExportRequestInput(body);
  const rawTenant = body.tenant_id !== undefined ? body.tenant_id : (body.tenantId !== undefined ? body.tenantId : tenantId);
  const effectiveTenant = rawTenant === null || rawTenant === undefined || rawTenant === "" ? null : Number(rawTenant);
  const uuid = randomUuid();
  const ts = nowIso();
  const name = input.name || `Audit export ${ts}`;
  const scope = body.scope && typeof body.scope === "object" ? body.scope : {};
  run(
    db,
    `INSERT INTO audit_export_requests
       (uuid, tenant_id, requested_by, name, format, status, filters_json, scope_json, columns_json, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
    [
      uuid,
      effectiveTenant,
      actor?.id ?? null,
      name,
      input.format,
      JSON.stringify(input.filters || {}),
      JSON.stringify(scope),
      JSON.stringify(input.columns || []),
      input.reason,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM audit_export_requests WHERE uuid = ?", [uuid]);
  try {
    const job = submitJob(
      db,
      {
        job_type_code: "AUDIT_EXPORT",
        name: `Audit export ${uuid}`,
        tenant_id: effectiveTenant,
        organization_id: actor?.organization_id ?? null,
        input: { export_id: row.id },
        idempotency_key: `audit-export:${uuid}`,
        related_object_type: "audit_export",
        related_object_id: String(row.id),
        source_module: "audit",
      },
      { actor, ip }
    );
    run(db, "UPDATE audit_export_requests SET job_id = ?, updated_at = ? WHERE id = ?", [
      job?.id ?? null,
      nowIso(),
      row.id,
    ]);
    capture(db, {
      actor,
      tenant_id: effectiveTenant,
      action: "audit.export.request",
      event_type: "EXPORT",
      category: "compliance",
      object_type: "audit_export",
      object_id: uuid,
      object_name: name,
      details: { format: input.format, job: job?.job_ref || null },
      reason: input.reason,
      ip,
    });
    publishAuditEvent(AUDIT_EVENT_TYPES.EXPORT_REQUESTED, {
      tenant_id: effectiveTenant,
      export_uuid: uuid,
      format: input.format,
      actor: actor ? { id: actor.id, username: actor.username } : null,
    });
    return { ...publicAuditExport(queryOne(db, "SELECT * FROM audit_export_requests WHERE id = ?", [row.id])), job_ref: job?.job_ref || null };
  } catch (err) {
    run(db, "UPDATE audit_export_requests SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", [
      String(err.message || err).slice(0, 1000),
      nowIso(),
      row.id,
    ]);
    throw err;
  }
}

export function runAuditExport(db, exportId) {
  const row = queryOne(db, "SELECT * FROM audit_export_requests WHERE id = ?", [Number(exportId)]);
  if (!row) throw new HttpError(404, "Audit export not found");
  run(db, "UPDATE audit_export_requests SET status = 'processing', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  try {
    const filters = safeParse(row.filters_json, {});
    const columns = safeParse(row.columns_json, []);
    const { items, total } = listEvents(
      db,
      { ...filters, page: 1, pageSize: EXPORT_ROW_CAP, sort: filters.sort || "created_at", order: filters.order || "desc" },
      { tenantId: row.tenant_id, scopeAll: row.tenant_id == null }
    );
    const content = render(items, row.format, columns);
    const expiresAt = addDays(RETENTION_DAYS);
    run(
      db,
      `UPDATE audit_export_requests
         SET status = 'completed', row_count = ?, content = ?, content_type = ?, completed_at = ?,
             expires_at = ?, error = NULL, updated_at = ?
       WHERE id = ?`,
      [items.length, content, contentTypeFor(row.format), nowIso(), expiresAt, nowIso(), row.id]
    );
    publishAuditEvent(AUDIT_EVENT_TYPES.EXPORT_COMPLETED, {
      tenant_id: row.tenant_id,
      export_uuid: row.uuid,
      format: row.format,
      row_count: items.length,
      truncated: items.length < total,
    });
  } catch (err) {
    run(
      db,
      "UPDATE audit_export_requests SET status = 'failed', error = ?, updated_at = ? WHERE id = ?",
      [String(err.message || err).slice(0, 1000), nowIso(), row.id]
    );
    throw err;
  }
  return publicAuditExport(queryOne(db, "SELECT * FROM audit_export_requests WHERE id = ?", [row.id]));
}

export function listAuditExports(db, { tenantId, actorId, status, limit = 50 } = {}) {
  const where = [];
  const params = [];
  if (tenantId != null) {
    where.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (actorId !== undefined && actorId !== null) {
    where.push("requested_by = ?");
    params.push(Number(actorId));
  }
  if (status) {
    where.push("status = ?");
    params.push(String(status));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = queryAll(
    db,
    `SELECT * FROM audit_export_requests ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, Math.min(Math.max(Number(limit) || 50, 1), 200)]
  ).map(publicAuditExport);
  return { items, total: items.length };
}

export function getAuditExport(db, reference, { tenantId = null, includeContent = false } = {}) {
  const isNumeric = /^\d+$/.test(String(reference));
  const row = queryOne(
    db,
    `SELECT * FROM audit_export_requests WHERE ${isNumeric ? "id = ?" : "uuid = ?"}`,
    [isNumeric ? Number(reference) : String(reference)]
  );
  if (!row) throw new HttpError(404, "Audit export not found");
  if (tenantId != null && row.tenant_id != null && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Audit export not found");
  }
  const dto = publicAuditExport(row);
  if (!includeContent) return dto;
  if (row.status !== "completed") throw new HttpError(409, `Export is ${row.status}`);
  if (row.expires_at && Date.parse(row.expires_at.replace(" ", "T") + "Z") < Date.now()) {
    throw new HttpError(410, "Export has expired");
  }
  const filename = `audit-export-${row.uuid}.${extensionFor(row.format)}`;
  return { ...dto, content: row.content || "", filename, content_type: row.content_type || contentTypeFor(row.format) };
}

export function markAuditExportDownloaded(db, id) {
  run(
    db,
    "UPDATE audit_export_requests SET downloaded_at = ?, download_count = download_count + 1 WHERE id = ?",
    [nowIso(), Number(id)]
  );
}

export function expireAuditExports(db, { tenantId = null } = {}) {
  const params = [nowIso(), nowIso()];
  let where = "status = 'completed' AND expires_at IS NOT NULL AND expires_at < ?";
  if (tenantId) {
    where += " AND tenant_id = ?";
    params.push(Number(tenantId));
  }
  const result = run(db, `UPDATE audit_export_requests SET status = 'expired', updated_at = ? WHERE ${where}`, params);
  return { expired: result.changes };
}

export { EXPORT_FORMATS, EXPORT_ROW_CAP, RETENTION_DAYS as EXPORT_RETENTION_DAYS };
