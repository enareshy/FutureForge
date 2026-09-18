// Bulk import/export ("data transfer") framework. Parsing and serialization use
// the shared format helpers; resource-specific persistence is pluggable through
// importer/exporter handlers keyed by resource type so the hub never hard-codes
// business object logic.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { publicTransfer, ref } from "./repository.js";
import {
  TRANSFER_DIRECTIONS,
  TRANSFER_FORMATS,
  TRANSFER_MODES,
  assertEnum,
  maskPayload,
  safeParse,
  toJson,
} from "./validation.js";
import { parseCsv, parseXml, toCsvRows, toXml, applyTransformation, getTransformationRow } from "./transform.js";
import { auditIntegration, classifyError, log } from "./hooks.js";

const IMPORTERS = new Map();
const EXPORTERS = new Map();

export function registerImporter(resourceType, handler, metadata = {}) {
  if (!resourceType || typeof handler !== "function") throw new HttpError(400, "resourceType and handler are required");
  IMPORTERS.set(String(resourceType), { handler, metadata });
  return String(resourceType);
}

export function registerExporter(resourceType, handler, metadata = {}) {
  if (!resourceType || typeof handler !== "function") throw new HttpError(400, "resourceType and handler are required");
  EXPORTERS.set(String(resourceType), { handler, metadata });
  return String(resourceType);
}

export function listTransferHandlers() {
  return {
    importers: [...IMPORTERS.entries()].map(([resourceType, entry]) => ({ resource_type: resourceType, ...entry.metadata })),
    exporters: [...EXPORTERS.entries()].map(([resourceType, entry]) => ({ resource_type: resourceType, ...entry.metadata })),
  };
}

export function parseInput(content, format) {
  const source = String(format || "json").toLowerCase();
  if (content === undefined || content === null || content === "") return [];
  if (source === "csv" || source === "txt") return parseCsv(content);
  if (source === "xml") return parseXml(content);
  if (source === "json") {
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  throw new HttpError(400, `Unsupported import format ${format}`);
}

function serializeRows(rows, format) {
  if (format === "csv" || format === "xlsx") {
    return toCsvRows(rows);
  }
  if (format === "xml") {
    return toXml(rows, "rows");
  }
  return JSON.stringify(rows, null, 2);
}

// ── Transfer records ────────────────────────────────────────────────────────
export function listTransfers(db, options = {}) {
  const { tenantId, direction, status, resourceType, q } = options;
  const { page = 1, pageSize = 50 } = options;
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (direction) {
    clauses.push("direction = ?");
    params.push(direction);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (resourceType) {
    clauses.push("resource_type = ?");
    params.push(resourceType);
  }
  if (q) {
    clauses.push("(LOWER(transfer_ref) LIKE ? OR LOWER(name) LIKE ? OR LOWER(filename) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_transfers ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_transfers ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicTransfer(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getTransferRow(db, refValue) {
  const id = Number(refValue);
  return queryOne(db, "SELECT * FROM integration_transfers WHERE id = ? OR transfer_ref = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
}

export function getTransfer(db, refValue) {
  const row = getTransferRow(db, refValue);
  if (!row) throw new HttpError(404, "Transfer not found");
  return publicTransfer(row);
}

function insertTransfer(db, input, actor, tenantId, direction) {
  assertEnum(direction, TRANSFER_DIRECTIONS, "direction");
  assertEnum(input.format || "csv", TRANSFER_FORMATS, "format");
  assertEnum(input.mode || "upsert", TRANSFER_MODES, "mode");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO integration_transfers
      (transfer_ref, direction, name, format, resource_type, integration_id, mapping_id, mode, dry_run, filename,
       content_type, content, template_code, size_bytes, status, tenant_id, initiated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    [
      ref("TRF"),
      direction,
      input.name || `${direction} ${input.resource_type || "data"}`,
      input.format || "csv",
      input.resource_type || "",
      input.integration_id ?? null,
      input.mapping_id ?? null,
      input.mode || "upsert",
      input.dry_run ? 1 : 0,
      input.filename || "",
      input.content_type || (input.format === "json" ? "application/json" : "text/csv"),
      input.content ?? null,
      input.template_code || "",
      input.content ? Buffer.byteLength(String(input.content)) : 0,
      tenantId ?? input.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  return queryOne(db, "SELECT * FROM integration_transfers WHERE id = ?", [Number(result.lastInsertRowid)]);
}

// Parses + (optionally) transforms an import payload without persisting objects.
export function previewImport(db, input = {}, actor = null, tenantId = null) {
  const format = input.format || "csv";
  const rows = parseInput(input.content, format);
  let transformed = rows;
  let transformErrors = [];
  if (input.mapping_id) {
    const transformation = getTransformationRow(db, input.mapping_id);
    if (!transformation) throw new HttpError(404, "Transformation definition not found");
    const def = {
      ...transformation,
      mappings: safeParse(transformation.mappings_json, []),
      constants: safeParse(transformation.constants_json, {}),
      conditionals: safeParse(transformation.conditionals_json, []),
      conversions: safeParse(transformation.conversions_json, []),
      lookups: safeParse(transformation.lookups_json, []),
      validation: safeParse(transformation.validation_json, []),
      error_handling: transformation.error_handling,
    };
    transformed = rows.map((row, index) => {
      const result = applyTransformation(def, row);
      transformErrors.push(...result.errors.map((e) => ({ row: index + 1, ...e })));
      return result.output;
    });
  }
  const fields = [...new Set(transformed.flatMap((row) => Object.keys(row || {})))];
  if (input.transfer_ref || input.name) {
    const row = insertTransfer(db, { ...input, content: input.content }, actor, tenantId, "import");
    run(db, "UPDATE integration_transfers SET status = 'preview', total_rows = ?, errors_json = ?, summary_json = ?, updated_at = ? WHERE id = ?", [
      transformed.length,
      toJson(transformErrors.slice(0, 100), []),
      toJson({ fields, sample_count: Math.min(transformed.length, 10) }, {}),
      nowIso(),
      row.id,
    ]);
    auditIntegration(db, { actor, action: "integration.transfer.preview", resourceType: "integration_transfer", resourceId: row.id, details: { direction: "import", total_rows: transformed.length } });
    return { ...getTransfer(db, row.id), fields, errors: transformErrors.slice(0, 100), sample: transformed.slice(0, 10).map((row) => maskPayload(row)) };
  }
  return { direction: "import", format, fields, total_rows: transformed.length, errors: transformErrors.slice(0, 100), sample: transformed.slice(0, 10).map((row) => maskPayload(row)) };
}

// Executes an import transfer. Uses a registered importer for the resource type
// when present; otherwise the rows are validated and counted only.
export async function runImportTransfer(db, input = {}, actor = null, tenantId = null) {
  const row = input.transfer_ref || input.id ? getTransferRow(db, input.transfer_ref || input.id) : insertTransfer(db, input, actor, tenantId, "import");
  if (!row) throw new HttpError(404, "Transfer not found");
  const started = nowIso();
  run(db, "UPDATE integration_transfers SET status = 'running', started_at = ?, progress = 0, updated_at = ? WHERE id = ?", [started, started, row.id]);

  let rows = [];
  let errors = [];
  try {
    rows = parseInput(row.content, row.format);
  } catch (error) {
    run(db, "UPDATE integration_transfers SET status = 'failed', finished_at = ?, errors_json = ?, updated_at = ? WHERE id = ?", [
      nowIso(),
      toJson([{ code: "parse_error", message: error.message }], []),
      nowIso(),
      row.id,
    ]);
    return getTransfer(db, row.id);
  }

  if (row.mapping_id) {
    const transformation = getTransformationRow(db, row.mapping_id);
    const def = transformation
      ? { ...transformation, mappings: safeParse(transformation.mappings_json, []), constants: safeParse(transformation.constants_json, {}), conditionals: safeParse(transformation.conditionals_json, []), conversions: safeParse(transformation.conversions_json, []), lookups: safeParse(transformation.lookups_json, []), validation: safeParse(transformation.validation_json, []), error_handling: transformation.error_handling }
      : null;
    if (def) {
      rows = rows.map((source, index) => {
        const result = applyTransformation(def, source);
        errors.push(...result.errors.map((e) => ({ row: index + 1, ...e })));
        return result.output;
      });
    }
  }

  const importer = IMPORTERS.get(String(row.resource_type || ""));
  let outcome = { created: 0, updated: 0, skipped: 0, duplicates: 0, errors: [] };
  if (importer) {
    try {
      outcome = await importer.handler(db, rows, { mode: row.mode, dryRun: Boolean(row.dry_run), actor, tenantId: row.tenant_id, transfer: publicTransfer(row) });
    } catch (error) {
      errors.push({ code: classifyError(error).code, message: error.message });
    }
  } else {
    outcome.created = row.dry_run ? 0 : rows.length;
  }

  const total = rows.length;
  const failure = (outcome.errors?.length || 0) + errors.length;
  const success = (outcome.created || 0) + (outcome.updated || 0);
  const status = failure && success ? "partial" : failure && !success ? "failed" : "completed";
  const finished = nowIso();
  run(
    db,
    `UPDATE integration_transfers SET status = ?, total_rows = ?, success_count = ?, failure_count = ?, skipped_count = ?,
       duplicate_count = ?, progress = 100, errors_json = ?, summary_json = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
    [status, total, success, failure, outcome.skipped || 0, outcome.duplicates || 0, toJson([...errors, ...(outcome.errors || [])].slice(0, 200), []), toJson({ created: outcome.created || 0, updated: outcome.updated || 0, handled: Boolean(importer) }, {}), finished, finished, row.id]
  );
  auditIntegration(db, { actor, action: "integration.transfer.import", resourceType: "integration_transfer", resourceId: row.id, details: { total, success, failure, status }, status: status === "failed" ? "failure" : "success" });
  return getTransfer(db, row.id);
}

// Executes an export transfer: collect rows via the registered exporter, apply
// an optional transformation and serialize into the requested format.
export async function runExportTransfer(db, input = {}, actor = null, tenantId = null) {
  const row = input.transfer_ref || input.id ? getTransferRow(db, input.transfer_ref || input.id) : insertTransfer(db, { ...input, content: null }, actor, tenantId, "export");
  if (!row) throw new HttpError(404, "Transfer not found");
  const started = nowIso();
  run(db, "UPDATE integration_transfers SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?", [started, started, row.id]);
  const exporter = EXPORTERS.get(String(row.resource_type || ""));
  let rows = [];
  let errors = [];
  if (exporter) {
    try {
      rows = (await exporter.handler(db, input.query || {}, { actor, tenantId: row.tenant_id, transfer: publicTransfer(row) })) || [];
    } catch (error) {
      errors.push({ code: classifyError(error).code, message: error.message });
    }
  }
  if (row.mapping_id && rows.length) {
    const transformation = getTransformationRow(db, row.mapping_id);
    if (transformation) {
      const def = { ...transformation, mappings: safeParse(transformation.mappings_json, []), constants: safeParse(transformation.constants_json, {}), conditionals: safeParse(transformation.conditionals_json, []), conversions: safeParse(transformation.conversions_json, []), lookups: safeParse(transformation.lookups_json, []), validation: safeParse(transformation.validation_json, []), error_handling: transformation.error_handling };
      rows = rows.map((source) => applyTransformation(def, source).output);
    }
  }
  let content = "";
  try {
    content = serializeRows(rows, row.format);
  } catch (error) {
    errors.push({ code: "serialization_error", message: error.message });
  }
  const status = errors.length && !rows.length ? "failed" : "completed";
  const finished = nowIso();
  run(
    db,
    `UPDATE integration_transfers SET status = ?, content = ?, size_bytes = ?, content_type = ?, total_rows = ?, success_count = ?,
       failure_count = ?, progress = 100, errors_json = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
    [status, content, Buffer.byteLength(content), row.format === "json" ? "application/json" : "text/csv", rows.length, rows.length, errors.length, toJson(errors, []), finished, finished, row.id]
  );
  auditIntegration(db, { actor, action: "integration.transfer.export", resourceType: "integration_transfer", resourceId: row.id, details: { total: rows.length, status } });
  return getTransfer(db, row.id);
}

export function getTransferContent(db, refValue) {
  const row = getTransferRow(db, refValue);
  if (!row) throw new HttpError(404, "Transfer not found");
  const filename = row.filename || `${row.transfer_ref}.${row.format === "xlsx" ? "csv" : row.format}`;
  const contentType = row.content_type || (row.format === "json" ? "application/json" : "text/csv");
  return { filename, content_type: contentType, content: row.content ?? "", transfer: publicTransfer(row) };
}

export function cancelTransfer(db, refValue, actor = null) {
  const row = getTransferRow(db, refValue);
  if (!row) throw new HttpError(404, "Transfer not found");
  run(db, "UPDATE integration_transfers SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?", [nowIso(), nowIso(), row.id]);
  auditIntegration(db, { actor, action: "integration.transfer.cancel", resourceType: "integration_transfer", resourceId: row.id, details: {} });
  return getTransfer(db, row.id);
}

export function transferStats(db, { tenantId } = {}) {
  const params = [];
  let where = "";
  if (tenantId !== undefined && tenantId !== null) {
    where = "WHERE tenant_id = ?";
    params.push(Number(tenantId));
  }
  const rows = queryAll(db, `SELECT direction, status, COUNT(*) AS count FROM integration_transfers ${where} GROUP BY direction, status`, params);
  const byDirection = { import: 0, export: 0 };
  const byStatus = {};
  for (const row of rows) {
    byDirection[row.direction] = (byDirection[row.direction] || 0) + row.count;
    byStatus[row.status] = (byStatus[row.status] || 0) + row.count;
  }
  return { by_direction: byDirection, by_status: byStatus, total: Object.values(byDirection).reduce((a, b) => a + b, 0) };
}
