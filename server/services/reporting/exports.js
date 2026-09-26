// Export and download (§22).
//
// Exports reuse the report query engine and write a durable artefact (CSV,
// JSON or Excel SpreadsheetML) that can be downloaded or handed to a scheduled
// distribution. Every export is authorized, audited and tracked as an
// execution so usage stays observable. PDF is a recognized target format but
// is not produced natively yet.
import { queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { EXPORT_FORMATS, NATIVE_EXPORT_FORMATS, MAX_EXPORT_ROWS } from "./constants.js";
import { exportNotFound, invalidExport, exportFailed } from "./errors.js";
import { exportRef as makeExportRef, executionRef as makeExecutionRef } from "./identifiers.js";
import { publicExport, stringifyJson, paged } from "./repository.js";
import { getReport, runReport } from "./reports.js";
import { getNumericConfig } from "./configuration.js";
import { recordExecution, recordHistory } from "./history.js";
import { publishReportingEvent } from "./events.js";

const CONTENT_TYPES = {
  CSV: "text/csv; charset=utf-8",
  JSON: "application/json; charset=utf-8",
  EXCEL: "application/vnd.ms-excel; charset=utf-8",
};

const EXTENSIONS = { CSV: "csv", JSON: "json", EXCEL: "xls" };

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeRows(format, result) {
  const normalized = String(format || "CSV").toUpperCase();
  if (!NATIVE_EXPORT_FORMATS.includes(normalized)) {
    throw exportFailed(`Export format ${format} is not available natively; supported: ${NATIVE_EXPORT_FORMATS.join(", ")}`);
  }
  const headers = (result.columns || []).map((column) => column.alias || column.attribute);
  if (normalized === "JSON") {
    return { content: JSON.stringify({ report: result.report, entity: result.entity, generated_at: nowIso(), columns: headers, total: result.total, rows: result.rows }, null, 2), content_type: CONTENT_TYPES.JSON, extension: EXTENSIONS.JSON };
  }
  if (normalized === "EXCEL") {
    const headerCells = headers.map((header) => `<Cell><Data ss:Type="String">${escapeXml(header)}</Data></Cell>`).join("");
    const body = (result.rows || [])
      .map((row) => `<Row>${headers.map((header) => { const value = row[header]; const numeric = typeof value === "number"; return `<Cell><Data ss:Type="${numeric ? "Number" : "String"}">${escapeXml(numeric ? value : value === null || value === undefined ? "" : String(value))}</Data></Cell>`; }).join("")}</Row>`)
      .join("");
    const content = `<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Worksheet ss:Name="${escapeXml(result.entity || "Report")}"><Table><Row>${headerCells}</Row>${body}</Table></Worksheet></Workbook>`;
    return { content, content_type: CONTENT_TYPES.EXCEL, extension: EXTENSIONS.EXCEL };
  }
  const lines = [headers.map(csvCell).join(",")];
  for (const row of result.rows || []) lines.push(headers.map((header) => csvCell(row[header])).join(","));
  return { content: lines.join("\r\n"), content_type: CONTENT_TYPES.CSV, extension: EXTENSIONS.CSV };
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function validateExportFormat(format) {
  const normalized = String(format || "CSV").toUpperCase();
  if (!EXPORT_FORMATS.includes(normalized)) throw invalidExport(`Unsupported export format: ${format}`);
  return normalized;
}

// Creates an export request. When `input.async` is truthy the request is queued
// and the caller (router/job) is responsible for running it; otherwise it runs
// inline and returns the completed export.
export function requestExport(db, tenantId, reportRefValue, input = {}, actor = null, ip = null) {
  const format = validateExportFormat(input.format);
  const report = getReport(db, tenantId, reportRefValue);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reporting_exports (export_ref, tenant_id, report_id, execution_id, format, status, parameters_json, created_by, started_at, created_at)
     VALUES (?, ?, ?, NULL, ?, 'QUEUED', ?, ?, NULL, ?)`,
    [makeExportRef(), Number(tenantId), report.id, format, stringifyJson(input.parameters || {}), actor?.id ?? null, ts]
  );
  const exportId = Number(result.lastInsertRowid);
  const created = publicExport(queryOne(db, "SELECT * FROM reporting_exports WHERE id = ?", [exportId]));
  if (input.async) return { async: true, ...created };
  return { async: false, ...executeExport(db, tenantId, created.export_ref, { parameters: input.parameters || {}, enableCache: false }, actor, ip) };
}

export function getExportById(db, tenantId, id) {
  return publicExport(queryOne(db, "SELECT * FROM reporting_exports WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)]));
}

export function getExport(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM reporting_exports WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM reporting_exports WHERE tenant_id = ? AND export_ref = ?", [Number(tenantId), raw]);
  if (!row) throw exportNotFound(ref);
  return publicExport(row);
}

export function listExports(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.format) {
    where.push("format = ?");
    params.push(String(query.format).toUpperCase());
  }
  return paged(db, "reporting_exports", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicExport });
}

// Runs a queued/inline export and persists the artefact.
export function executeExport(db, tenantId, exportRefValue, context = {}, actor = null, ip = null) {
  const existing = getExport(db, tenantId, exportRefValue);
  const report = getReport(db, tenantId, existing.report_id);
  const started = Date.now();
  const executionRef = makeExecutionRef();
  const maxExportRows = getNumericConfig(db, tenantId, "max_export_rows") || MAX_EXPORT_ROWS;
  try {
    const result = runReport(db, tenantId, report, {
      ...context,
      mode: "EXPORT",
      parameters: { ...(existing.parameters || {}), ...(context.parameters || {}) },
      enableCache: false,
      maxRows: Math.min(Number(context.maxRows) || maxExportRows, maxExportRows),
      actor,
      ip,
    });
    if (result.total > maxExportRows) throw exportFailed(`Export exceeds maximum of ${maxExportRows} rows`);
    const serialized = serializeRows(existing.format, result);
    const fileName = `${report.code}-${existing.export_ref}.${serialized.extension}`;
    const executionId = recordExecution(db, {
      execution_ref: executionRef,
      tenantId,
      report_id: report.id,
      report_code: report.code,
      mode: "EXPORT",
      status: "COMPLETED",
      user_id: actor?.id,
      parameters: existing.parameters,
      query: { entity: result.entity, data_source: result.data_source, query_type: result.query_type },
      result: { columns: result.columns, total: result.total, format: existing.format },
      row_count: result.total,
      duration_ms: result.took_ms,
    });
    run(
      db,
      `UPDATE reporting_exports SET execution_id = ?, status = 'COMPLETED', row_count = ?, size_bytes = ?, file_name = ?, content_type = ?, storage_uri = ?, content_text = ?, finished_at = ?, error_message = ''
        WHERE id = ? AND tenant_id = ?`,
      [executionId, result.total, Buffer.byteLength(serialized.content, "utf8"), fileName, serialized.content_type, `reporting://exports/${existing.export_ref}`, serialized.content, nowIso(), existing.id, Number(tenantId)]
    );
    writeAudit(db, { actor, action: "reporting.export.run", resourceType: "reporting_export", resourceId: existing.export_ref, details: { report: report.code, format: existing.format, rows: result.total }, sourceModule: "reporting", ip });
    publishReportingEvent(db, { eventType: "ReportExported", payload: { code: report.code, format: existing.format, rows: result.total }, objectType: "reporting_export", tenantId }, actor);
    recordHistory(db, { tenantId, action: "EXPORT", entity_type: "export", entity_id: existing.id, entity_ref: existing.export_ref, actor_id: actor?.id, summary: `Exported ${report.code} as ${existing.format}`, detail: { rows: result.total } });
    return getExportById(db, Number(tenantId), existing.id);
  } catch (error) {
    const message = error.message || "Export failed";
    run(db, "UPDATE reporting_exports SET status = 'FAILED', error_message = ?, finished_at = ? WHERE id = ? AND tenant_id = ?", [message, nowIso(), existing.id, Number(tenantId)]);
    recordExecution(db, {
      execution_ref: executionRef,
      tenantId,
      report_id: report.id,
      report_code: report.code,
      mode: "EXPORT",
      status: "FAILED",
      user_id: actor?.id,
      parameters: existing.parameters,
      row_count: 0,
      duration_ms: Date.now() - started,
      error_code: error.code || "REPORTING_EXPORT_FAILED",
      error_message: message,
    });
    publishReportingEvent(db, { eventType: "ReportFailed", payload: { code: report.code, error: message, scope: "export" }, objectType: "reporting_export", tenantId }, actor);
    throw error;
  }
}

export function downloadExport(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM reporting_exports WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM reporting_exports WHERE tenant_id = ? AND export_ref = ?", [Number(tenantId), raw]);
  if (!row) throw exportNotFound(ref);
  if (row.status !== "COMPLETED" || !row.content_text) throw exportFailed(`Export ${row.export_ref} is not ready (status=${row.status})`);
  return { file_name: row.file_name, content_type: row.content_type, content: row.content_text, size_bytes: row.size_bytes };
}

export function deleteExport(db, tenantId, ref) {
  const existing = getExport(db, tenantId, ref);
  run(db, "DELETE FROM reporting_exports WHERE id = ? AND tenant_id = ?", [existing.id, Number(tenantId)]);
  return { deleted: true, export_ref: existing.export_ref };
}

export function pruneExports(db, tenantId, retentionDays) {
  const cutoff = new Date(Date.now() - Math.max(1, Number(retentionDays) || 30) * 24 * 60 * 60 * 1000).toISOString();
  const changes = run(db, "DELETE FROM reporting_exports WHERE tenant_id = ? AND created_at < ? AND status IN ('COMPLETED','FAILED','CANCELLED')", [Number(tenantId), cutoff]).changes || 0;
  return { deleted: changes };
}
