// Catalog metadata import and export.
//
// Imports/exports metadata only (never business data) in CSV or JSON. File
// transfers are owned by the Integration transfers model; this module accepts
// parsed records (or a transfer reference) and applies them through the same
// domain services so validation, audit, events and versioning are identical to
// an interactive write. Every run is recorded in dc_import_runs.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { importFailed, exportFailed, invalidConfiguration } from "./errors.js";
import { normalizeText, normalizeUpper, parseObject, toBool, toInt } from "./validation.js";
import { getConfig } from "./configuration.js";
import { publicImportRun } from "./repository.js";
import { createTerm, addSynonym, addMapping, listTerms } from "./glossary.js";
import { createCatalogObject, createAttribute } from "./objects.js";
import { createSource, addSourceMapping } from "./sources.js";
import { createConsumer, addConsumerMapping } from "./consumers.js";
import { createClassification } from "./classifications.js";
import { createLineage } from "./lineage.js";

export const IMPORTABLE_RESOURCES = ["terms", "objects", "attributes", "sources", "consumers", "classifications", "term_mappings", "source_mappings", "consumer_mappings", "lineage"];

function createImportRun(db, { tenantId, resourceType, format, dryRun, transferRef, jobRef, actor }) {
  const result = run(
    db,
    "INSERT INTO dc_import_runs (tenant_id, resource_type, format, status, dry_run, stats_json, errors_json, transfer_ref, job_ref, created_by, created_at) VALUES (?, ?, ?, 'running', ?, '{}', '[]', ?, ?, ?, ?)",
    [
      Number(tenantId),
      normalizeText(resourceType),
      normalizeText(format) || "json",
      dryRun ? 1 : 0,
      normalizeText(transferRef),
      normalizeText(jobRef),
      actor?.id ?? null,
      nowIso(),
    ]
  );
  return Number(result.lastInsertRowid);
}

function completeImportRun(db, id, { status, stats, errors }) {
  run(db, "UPDATE dc_import_runs SET status = ?, stats_json = ?, errors_json = ?, completed_at = ? WHERE id = ?", [
    status,
    JSON.stringify(stats || {}),
    JSON.stringify(errors || []),
    nowIso(),
    id,
  ]);
  return publicImportRun(queryOne(db, "SELECT * FROM dc_import_runs WHERE id = ?", [id]));
}

export function listImportRuns(db, { tenantId, status, limit = 50 } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeText(status));
  }
  return queryAll(db, `SELECT * FROM dc_import_runs WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`, [
    ...params,
    Number(limit) || 50,
  ]).map(publicImportRun);
}

export function getImportRun(db, id, tenantId = null) {
  const row = tenantId
    ? queryOne(db, "SELECT * FROM dc_import_runs WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)])
    : queryOne(db, "SELECT * FROM dc_import_runs WHERE id = ?", [Number(id)]);
  return publicImportRun(row);
}

// Applies one parsed record for a resource type. Each branch delegates to the
// owning domain service so behavior is identical to an interactive write.
function applyRecord(db, resourceType, record, actor, tenantId) {
  switch (resourceType) {
    case "terms": {
      const term = createTerm(db, record, actor, tenantId);
      if (Array.isArray(record.synonyms)) for (const synonym of record.synonyms) addSynonym(db, term.id, synonym, actor, tenantId);
      return term;
    }
    case "objects":
      return createCatalogObject(db, record, actor, tenantId);
    case "attributes":
      return createAttribute(db, record.object_ref ?? record.object_type ?? record.object_id, record, actor, tenantId);
    case "sources":
      return createSource(db, record, actor, tenantId);
    case "consumers":
      return createConsumer(db, record, actor, tenantId);
    case "classifications":
      return createClassification(db, record, actor, tenantId);
    case "term_mappings":
      return addMapping(db, record.term_ref ?? record.term_id, record, actor, tenantId);
    case "source_mappings":
      return addSourceMapping(db, record.source_ref ?? record.source_code ?? record.source_id, record, actor, tenantId);
    case "consumer_mappings":
      return addConsumerMapping(db, record.consumer_ref ?? record.consumer_code ?? record.consumer_id, record, actor, tenantId);
    case "lineage":
      return createLineage(db, record, actor, tenantId);
    default:
      throw importFailed(`Unsupported import resource: ${resourceType}`, { resource_type: resourceType, allowed: IMPORTABLE_RESOURCES });
  }
}

export function importCatalog(db, { tenantId, resourceType, records = [], dryRun = false, transferRef = "", jobRef = "", actor = null, ip = null } = {}) {
  const resource = normalizeText(resourceType);
  if (!IMPORTABLE_RESOURCES.includes(resource)) {
    throw importFailed(`Unsupported import resource: ${resource}`, { resource_type: resource, allowed: IMPORTABLE_RESOURCES });
  }
  const batchSize = toInt(getConfig(db, tenantId, "import_batch_size"), 500) || 500;
  if (!Array.isArray(records)) throw importFailed("Import records must be an array", { resource_type: resource });
  const runId = createImportRun(db, { tenantId, resourceType: resource, format: "json", dryRun, transferRef, jobRef, actor });
  const stats = { total: records.length, created: 0, skipped: 0, failed: 0, batches: 0 };
  const errors = [];
  for (let offset = 0; offset < records.length; offset += batchSize) {
    const batch = records.slice(offset, offset + batchSize);
    stats.batches += 1;
    for (const record of batch) {
      if (dryRun) {
        stats.skipped += 1;
        continue;
      }
      try {
        applyRecord(db, resource, record, actor, tenantId);
        stats.created += 1;
      } catch (error) {
        stats.failed += 1;
        if (errors.length < 200) errors.push({ index: offset, message: error.message, code: error.code || null });
      }
    }
  }
  const status = stats.failed === 0 ? "completed" : stats.created === 0 ? "failed" : "partial";
  const importRun = completeImportRun(db, runId, { status, stats, errors });
  writeAudit(db, {
    actor,
    action: "data_catalog.import",
    resourceType: "dc_import_run",
    resourceId: runId,
    details: { resource_type: resource, dry_run: dryRun, stats },
    ip,
  });
  return { import_run: importRun, stats, errors };
}

export function exportCatalog(db, { tenantId, resourceTypes = null, format = "json", limit = 5000 } = {}) {
  const requested = (Array.isArray(resourceTypes) && resourceTypes.length ? resourceTypes : ["terms", "objects", "sources", "consumers", "classifications", "lineage"]).map(normalizeText);
  const data = {};
  for (const resource of requested) {
    data[resource] = exportResource(db, tenantId, resource, limit);
  }
  if (format === "csv") {
    const rows = [];
    for (const [resource, items] of Object.entries(data)) {
      for (const item of items) rows.push({ resource, ...flatten(item) });
    }
    return { format: "csv", content: toCsv(rows), record_count: rows.length, resources: requested };
  }
  if (format !== "json") throw exportFailed(`Unsupported export format: ${format}`, { format });
  const count = Object.values(data).reduce((total, items) => total + items.length, 0);
  return { format: "json", data, content: JSON.stringify(data, null, 2), record_count: count, resources: requested };
}

function exportResource(db, tenantId, resource, limit) {
  switch (resource) {
    case "terms":
      return listTerms(db, { tenantId, page: 1, pageSize: limit }).items;
    case "objects":
      return queryAll(db, "SELECT * FROM dc_catalog_objects WHERE tenant_id = ? ORDER BY object_type LIMIT ?", [Number(tenantId), limit]);
    case "attributes":
      return queryAll(db, "SELECT * FROM dc_catalog_attributes WHERE tenant_id = ? ORDER BY object_id, attribute_name LIMIT ?", [Number(tenantId), limit]);
    case "sources":
      return queryAll(db, "SELECT * FROM dc_sources WHERE tenant_id = ? ORDER BY code LIMIT ?", [Number(tenantId), limit]);
    case "consumers":
      return queryAll(db, "SELECT * FROM dc_consumers WHERE tenant_id = ? ORDER BY code LIMIT ?", [Number(tenantId), limit]);
    case "classifications":
      return queryAll(db, "SELECT * FROM dc_classifications WHERE tenant_id = ? ORDER BY code LIMIT ?", [Number(tenantId), limit]);
    case "lineage":
      return queryAll(db, "SELECT * FROM dc_lineage WHERE tenant_id = ? ORDER BY id LIMIT ?", [Number(tenantId), limit]);
    default:
      throw exportFailed(`Unsupported export resource: ${resource}`, { resource_type: resource });
  }
}

function flatten(value) {
  const out = {};
  for (const [key, raw] of Object.entries(value || {})) {
    if (raw === null || raw === undefined) out[key] = "";
    else if (typeof raw === "object") out[key] = JSON.stringify(raw);
    else out[key] = raw;
  }
  return out;
}

function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(rows) {
  if (!rows.length) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(headers.map((header) => csvEscape(flatten(row)[header])).join(","));
  return lines.join("\n");
}

// Minimal, dependency-free CSV parser (RFC 4180 subset) used when an importer
// supplies raw CSV text rather than parsed records.
export function parseCsv(text) {
  const input = String(text ?? "");
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') inQuotes = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  if (!rows.length) return [];
  const [headers, ...records] = rows;
  return records
    .filter((record) => record.some((value) => String(value).trim() !== ""))
    .map((record) => Object.fromEntries(headers.map((header, index) => [normalizeText(header), record[index] ?? ""])));
}

export function parseRecords(text, format = "json") {
  if (format === "json") {
    const parsed = parseObject(text, null) ?? null;
    if (parsed && Array.isArray(parsed.records)) return parsed.records;
    if (Array.isArray(parsed)) return parsed;
    try {
      const value = JSON.parse(String(text));
      return Array.isArray(value) ? value : value?.records ?? [];
    } catch {
      return [];
    }
  }
  if (format === "csv") return parseCsv(text);
  throw importFailed(`Unsupported import format: ${format}`, { format });
}

export { invalidConfiguration };
