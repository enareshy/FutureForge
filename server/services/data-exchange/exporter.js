// Export execution engine.
//
// Collects records from the object framework, applies row/field security,
// field selection, filtering and transformations, serialises the result and
// stores (or delivers) the generated artifact through a pluggable destination.
//
// Like the importer it never keeps a second copy of the business data: each run
// reads live objects and produces a derived artifact.
import { createHash } from "node:crypto";
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { exportJobRef as makeJobRef, resultRef as makeResultRef } from "./refs.js";
import { publicExportJob, publicExportResult } from "./repository.js";
import { requireConnector } from "./connectors/registry.js";
import { serializeCsv, serializeJson, serializeXml, serializeSpreadsheet } from "./connectors/codecs.js";
import { invalidDefinition, invalidExport, jobConflict, resultNotFound, resultExpired } from "./errors.js";
import { normalizeText, normalizeUpper, paginate, parseObject, parseArray, toBool } from "./validation.js";
import { getPath } from "./engines/transform.js";
import { Engines } from "./engines/index.js";
import { createLookupResolver } from "./engines/lookup.js";
import { authorizeRecord, enforceRecordFields } from "./security.js";
import { listConfig } from "./configuration.js";
import { publishExchangeEvent } from "./events.js";
import { recordHistory } from "./history.js";
import { getExportDefinitionRow, withExportChildren } from "./export-definitions.js";
import * as Lifecycle from "./lifecycle.js";

const CONTENT_TYPES = {
  CSV: "text/csv",
  JSON: "application/json",
  XML: "application/xml",
  EXCEL: "application/vnd.ms-excel",
};

const BUILTIN_RECORD_FIELDS = ["id", "uuid", "code", "name", "description", "status", "revision", "external_ref", "external_system", "owner_id", "organization_id", "tags"];

function configFor(db, tenantId) {
  return listConfig(db, tenantId);
}

// ── Job ledger ───────────────────────────────────────────────────────────────

export function getExportJobRow(db, tenantId, ref) {
  return queryOne(
    db,
    "SELECT * FROM ie_export_jobs WHERE tenant_id = ? AND (job_ref = ? OR CAST(id AS TEXT) = ?)",
    [Number(tenantId), String(ref), String(ref)]
  );
}

export function createExportJob(db, { tenantId, definition, params = {}, actor = null, ip = null, idempotencyKey = "" }) {
  const tenant = Number(tenantId);
  if (idempotencyKey) {
    const existing = queryOne(db, "SELECT * FROM ie_export_jobs WHERE tenant_id = ? AND idempotency_key = ?", [tenant, idempotencyKey]);
    if (existing) return { job: existing, existing: true };
  }
  const ts = nowIso();
  const destination = normalizeUpper(params.destination || definition?.destination || "DOWNLOAD");
  const result = run(
    db,
    `INSERT INTO ie_export_jobs (job_ref, tenant_id, organization_id, definition_id, definition_version, object_type, format, destination, status,
       filters_json, fields_json, transformation_json, destination_json, idempotency_key, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      makeJobRef(definition?.code || "JOB"),
      tenant,
      params.organization_id ?? params.organizationId ?? definition?.organization_id ?? null,
      definition?.id ?? null,
      definition?.version ?? 1,
      definition?.object_type || "",
      definition?.format || "CSV",
      destination,
      JSON.stringify([...(definition?.export_filters || []), ...parseArray(params.filters, [])]),
      JSON.stringify(definition?.field_selections || []),
      JSON.stringify({ transformations: definition?.export_transformations || [], transformation: definition?.transformation || {} }),
      JSON.stringify({ ...(definition?.destination_config || {}), ...parseObject(params.destination_config, {}) }),
      normalizeText(idempotencyKey, { max: 200 }),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const job = queryOne(db, "SELECT * FROM ie_export_jobs WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, { actor, action: "data_exchange.export_job.create", resourceType: "ie_export_jobs", resourceId: job.job_ref, details: { definition: definition?.code || null }, ip });
  recordHistory(db, { direction: "EXPORT", tenantId: tenant, jobId: job.id, definitionId: job.definition_id, definitionVersion: job.definition_version, action: "JOB_CREATED", status: job.status, objectType: job.object_type, format: job.format, actor });
  return { job, existing: false };
}

function updateJob(db, jobId, patch) {
  const columns = Object.keys(patch);
  if (!columns.length) return;
  const assignments = columns.map((column) => `${column} = ?`).join(", ");
  run(db, `UPDATE ie_export_jobs SET ${assignments}, updated_at = ? WHERE id = ?`, [...columns.map((column) => patch[column]), nowIso(), Number(jobId)]);
}

// ── Collection ───────────────────────────────────────────────────────────────

function objectToRecord(row) {
  const record = {};
  for (const field of BUILTIN_RECORD_FIELDS) record[field] = row[field];
  record.tags = parseArray(row.tags_json, []);
  const data = parseObject(row.data_json, {});
  return { ...record, ...data, data };
}

function matchesFilter(record, filter) {
  const operator = normalizeLower(filter.operator);
  const actual = getPath(record, filter.field);
  const expected = filter.value !== undefined ? filter.value : parseJsonValue(filter.value_json);
  switch (operator) {
    case "eq":
      return String(actual ?? "") === String(expected ?? "");
    case "ne":
      return String(actual ?? "") !== String(expected ?? "");
    case "gt":
      return Number(actual) > Number(expected);
    case "gte":
      return Number(actual) >= Number(expected);
    case "lt":
      return Number(actual) < Number(expected);
    case "lte":
      return Number(actual) <= Number(expected);
    case "in":
      return Array.isArray(expected) ? expected.map(String).includes(String(actual)) : String(expected).split(",").map((v) => v.trim()).includes(String(actual));
    case "not_in":
    case "nin":
      return Array.isArray(expected) ? !expected.map(String).includes(String(actual)) : !String(expected).split(",").map((v) => v.trim()).includes(String(actual));
    case "contains":
      return String(actual ?? "").toLowerCase().includes(String(expected ?? "").toLowerCase());
    case "starts_with":
      return String(actual ?? "").toLowerCase().startsWith(String(expected ?? "").toLowerCase());
    case "ends_with":
      return String(actual ?? "").toLowerCase().endsWith(String(expected ?? "").toLowerCase());
    case "between": {
      const [low, high] = Array.isArray(expected) ? expected : String(expected).split(",").map((v) => v.trim());
      return Number(actual) >= Number(low) && Number(actual) <= Number(high);
    }
    case "is_null":
      return actual === null || actual === undefined || actual === "";
    case "not_null":
      return !(actual === null || actual === undefined || actual === "");
    case "exists": {
      const present = !(actual === null || actual === undefined || actual === "");
      return expected === false ? !present : present;
    }
    default:
      return true;
  }
}

function parseJsonValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function normalizeLower(value) {
  return String(value ?? "").toLowerCase();
}

export function applyExportFilters(records, filters = []) {
  const active = filters.filter((filter) => normalizeLower(filter.status || "active") === "active");
  if (!active.length) return records;
  let result = records.filter((record) => matchesFilter(record, active[0]));
  for (let i = 1; i < active.length; i += 1) {
    const filter = active[i];
    const matches = (record) => matchesFilter(record, filter);
    result = filter.conjunction === "OR" ? [...result, ...records.filter(matches)].filter((record, index, all) => all.indexOf(record) === index) : result.filter(matches);
  }
  return result;
}

export function applyExportSort(records, sort = []) {
  if (!Array.isArray(sort) || !sort.length) return records;
  const spec = [...sort];
  return [...records].sort((left, right) => {
    for (const entry of spec) {
      const field = entry.field || entry.field_path;
      if (!field) continue;
      const direction = normalizeLower(entry.direction || entry.order || "asc") === "desc" ? -1 : 1;
      const a = getPath(left, field);
      const b = getPath(right, field);
      if (a === b) continue;
      if (a === null || a === undefined) return 1;
      if (b === null || b === undefined) return -1;
      return (a > b ? 1 : -1) * direction;
    }
    return 0;
  });
}

export function applyFieldSelection(record, fields = []) {
  if (!fields.length) return { ...record };
  const output = {};
  for (const field of fields) {
    if (normalizeLower(field.status || "active") !== "active") continue;
    const path = field.field_path;
    if (!path) continue;
    output[field.display_name || path] = getPath(record, path);
  }
  return output;
}

export function collectExportRecords(db, tenantId, definition, { filters, sort } = {}) {
  const type = queryOne(db, "SELECT id FROM metadata_types WHERE code = ? AND (tenant_id IS NULL OR tenant_id = ?) AND status = 'active'", [
    definition.object_type,
    Number(tenantId),
  ]);
  if (!type) throw invalidDefinition(`Unknown object type for export: ${definition.object_type}`);
  const rows = queryAll(db, "SELECT * FROM objects WHERE tenant_id = ? AND object_type_id = ? AND deleted_at IS NULL ORDER BY id", [Number(tenantId), type.id]);
  const records = rows.map(objectToRecord);
  const activeFilters = filters !== undefined ? filters : definition.export_filters || [];
  const activeSort = sort !== undefined ? sort : definition.sort || [];
  return applyExportSort(applyExportFilters(records, activeFilters), activeSort);
}

// Export transformations are stored field-oriented; adapt them to the generic
// FIELD-stage format understood by the transformation engine.
function normalizeExportTransformations(transformations = []) {
  return transformations.map((entry) => ({
    stage: "FIELD",
    target_field: entry.target_field || entry.field_path,
    transformation_type: entry.transformation_type,
    config: entry.config || {},
    status: entry.status || "active",
  }));
}

// ── Serialisation & storage ──────────────────────────────────────────────────

export function serializeExport(format, records, fieldNames = []) {
  const normalized = normalizeUpper(format);
  switch (normalized) {
    case "CSV":
      return serializeCsv(records, fieldNames.length ? fieldNames : null);
    case "JSON":
      return serializeJson(records, null, { ndjson: false, pretty: true });
    case "XML":
      return serializeXml(records, fieldNames.length ? fieldNames : null);
    case "EXCEL":
      return serializeSpreadsheet(records, fieldNames.length ? fieldNames : null);
    default:
      throw invalidExport(`Unsupported export format: ${format}`);
  }
}

function checksumOf(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function storeBlob(db, tenantId, { content, contentType, filename }) {
  const checksum = checksumOf(content);
  const storageUri = `ie://export/${checksum.slice(0, 24)}/${filename}`;
  run(
    db,
    `INSERT INTO ie_blobs (tenant_id, storage_uri, content_type, checksum, size_bytes, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, storage_uri) DO UPDATE SET content = excluded.content, size_bytes = excluded.size_bytes, checksum = excluded.checksum`,
    [Number(tenantId), storageUri, contentType, checksum, Buffer.byteLength(content, "utf8"), content, nowIso()]
  );
  return { storageUri, checksum, sizeBytes: Buffer.byteLength(content, "utf8") };
}

export function readBlob(db, tenantId, storageUri) {
  const row = queryOne(db, "SELECT * FROM ie_blobs WHERE tenant_id = ? AND storage_uri = ?", [Number(tenantId), storageUri]);
  return row ? row.content : null;
}

// ── Run ──────────────────────────────────────────────────────────────────────

export async function runExportJob(db, { jobId, params = {}, actor = null, ip = null } = {}) {
  const job = queryOne(db, "SELECT * FROM ie_export_jobs WHERE id = ?", [Number(jobId)]);
  if (!job) throw jobConflict(`Export job not found: ${jobId}`);
  const tenantId = Number(job.tenant_id);
  const config = configFor(db, tenantId);
  const definitionRow = job.definition_id ? queryOne(db, "SELECT * FROM ie_export_definitions WHERE id = ?", [job.definition_id]) : null;
  const definition = definitionRow ? withExportChildren(db, definitionRow) : null;
  if (!definition) throw invalidDefinition("The definition for this export job no longer exists");

  updateJob(db, job.id, { status: "RUNNING", started_at: job.started_at || nowIso() });
  publishExchangeEvent(db, { eventType: "ExportStarted", tenantId, objectId: job.job_ref, payload: { job_ref: job.job_ref, format: job.format } }, actor);
  const started = Date.now();

  let records;
  try {
    const jobFilters = parseArray(job.filters_json, []);
    records = collectExportRecords(db, tenantId, definition, { filters: jobFilters.length ? jobFilters : definition.export_filters });
  } catch (error) {
    updateJob(db, job.id, { status: "FAILED", error_message: normalizeText(error.message, { max: 1000 }), completed_at: nowIso() });
    publishExchangeEvent(db, { eventType: "ExportFailed", tenantId, objectId: job.job_ref, payload: { error: error.message } }, actor);
    recordHistory(db, { direction: "EXPORT", tenantId, jobId: job.id, definitionId: job.definition_id, definitionVersion: job.definition_version, action: "JOB_FAILED", status: "FAILED", objectType: job.object_type, format: job.format, actor, details: { error: error.message } });
    return publicExportJob(queryOne(db, "SELECT * FROM ie_export_jobs WHERE id = ?", [job.id]));
  }

  const maxRecords = Math.min(Number(definition.max_records) || config.max_export_records || 1000000, Number(params.limit) || Infinity);
  const lifecycleFiltered = Lifecycle.filterExportableRecords(db, tenantId, definition.object_type, records);
  records = lifecycleFiltered.records;
  const lifecycleExcluded = lifecycleFiltered.excluded.length;
  records = records.slice(0, maxRecords);
  updateJob(db, job.id, { record_count: records.length });

  const lookupResolver = createLookupResolver({ staticMaps: parseObject(definition.transformation?.lookups, {}), cacheSize: config.lookup_cache_size });
  const selections = definition.field_selections || [];
  const transformations = normalizeExportTransformations(definition.export_transformations || []);
  const exported = [];
  const errors = [];
  let denied = 0;

  for (const record of records) {
    try {
      authorizeRecord(db, actor, { objectType: definition.object_type, objectId: record.id, action: "read", tenantId, organizationId: record.organization_id, classification: record.classification || "", ip });
    } catch (error) {
      denied += 1;
      errors.push({ record: record.code || record.id, code: "ROW_SECURITY", message: error.message });
      continue;
    }
    let safe = record;
    try {
      const enforced = enforceRecordFields(db, actor, { objectType: definition.object_type, record, action: "read", tenantId, organizationId: record.organization_id, ip });
      safe = enforced.record;
    } catch {
      /* masking is best effort; deny-by-default handled by authorizeRecord */
    }
    const selected = selections.length ? applyFieldSelection(safe, selections) : safe;
    const transformed = Engines.applyDefinitionTransformations(transformations, selected, { lookup: lookupResolver });
    exported.push(transformed);
  }

  const fieldNames = selections.length ? selections.filter((field) => normalizeLower(field.status || "active") === "active").map((field) => field.display_name || field.field_path) : [];
  const format = normalizeUpper(job.format);
  const filename = `${definition.code || job.object_type}-${new Date().toISOString().replace(/[:.]/g, "-")}.${format === "EXCEL" ? "xls" : format.toLowerCase()}`;
  const serialized = serializeExport(format, exported, fieldNames);
  const content = serialized.content;
  const contentType = serialized.content_type || CONTENT_TYPES[format] || "application/octet-stream";

  const destination = normalizeUpper(job.destination);
  let storageUri = "";
  let checksum = "";
  let sizeBytes = 0;
  let destinationStatus = "COMPLETED";
  let deliveryError = "";
  try {
    if (destination === "DOWNLOAD" || destination === "FILE_STORAGE" || destination === "OBJECT_STORAGE") {
      const stored = storeBlob(db, tenantId, { content, contentType, filename });
      storageUri = stored.storageUri;
      checksum = stored.checksum;
      sizeBytes = stored.sizeBytes;
    } else if (destination === "REST_API" || destination === "EXTERNAL_SYSTEM") {
      const destinationConfig = parseObject(job.destination_json, {});
      const connectorType = destinationConfig.connector_type || (destination === "REST_API" ? "REST" : "EXTERNAL_SYSTEM");
      const connector = requireConnector(connectorType);
      const stored = storeBlob(db, tenantId, { content, contentType, filename });
      storageUri = stored.storageUri;
      checksum = stored.checksum;
      sizeBytes = stored.sizeBytes;
      await connector.write({ db, tenant_id: tenantId, settings: destinationConfig, credentials: destinationConfig.credentials || null, records: exported, content, filename });
    } else if (destination === "DATABASE") {
      const stored = storeBlob(db, tenantId, { content, contentType, filename });
      storageUri = stored.storageUri;
      checksum = stored.checksum;
      sizeBytes = stored.sizeBytes;
    } else {
      const stored = storeBlob(db, tenantId, { content, contentType, filename });
      storageUri = stored.storageUri;
      checksum = stored.checksum;
      sizeBytes = stored.sizeBytes;
    }
  } catch (error) {
    destinationStatus = "FAILED";
    deliveryError = normalizeText(error.message, { max: 1000 });
    errors.push({ code: "DESTINATION", message: error.message });
  }

  const expiresAt = toBool(params.no_expiry) ? null : nowIsoExpiry(config.export_expiry_days);
  const resultRef = makeResultRef(job.job_ref);
  run(
    db,
    `INSERT INTO ie_export_results (job_id, tenant_id, result_ref, format, storage_uri, filename, content_type, size_bytes, checksum, record_count, expires_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [job.id, tenantId, resultRef, format, storageUri, filename, contentType, sizeBytes, checksum, exported.length, expiresAt, destinationStatus === "FAILED" ? "EXPIRED" : "AVAILABLE", nowIso()]
  );

  const summary = {
    record_count: records.length,
    exported_count: exported.length,
    denied_count: denied,
    lifecycle_excluded_count: lifecycleExcluded,
    error_count: errors.length,
    destination,
    output_size: sizeBytes,
    duration_ms: Date.now() - started,
  };
  const status = destinationStatus === "FAILED" ? "FAILED" : errors.length && exported.length ? "PARTIAL" : !exported.length && records.length ? "FAILED" : "COMPLETED";
  updateJob(db, job.id, {
    status,
    exported_count: exported.length,
    error_count: errors.length,
    output_size: sizeBytes,
    output_uri: storageUri,
    output_filename: filename,
    expires_at: expiresAt,
    summary_json: JSON.stringify({ ...summary, errors: errors.slice(0, 20) }),
    error_message: deliveryError,
    completed_at: nowIso(),
  });
  const finalJob = queryOne(db, "SELECT * FROM ie_export_jobs WHERE id = ?", [job.id]);
  writeAudit(db, { actor, action: "data_exchange.export_job.complete", resourceType: "ie_export_jobs", resourceId: job.job_ref, details: summary, ip });
  recordHistory(db, {
    direction: "EXPORT",
    tenantId,
    jobId: job.id,
    definitionId: job.definition_id,
    definitionVersion: job.definition_version,
    action: "JOB_COMPLETED",
    status,
    objectType: job.object_type,
    format: job.format,
    totalRecords: exported.length,
    successCount: exported.length,
    failedCount: errors.length,
    actor,
    details: summary,
  });
  const eventType = status === "COMPLETED" ? "ExportCompleted" : status === "PARTIAL" ? "ExportPartiallyCompleted" : "ExportFailed";
  publishExchangeEvent(db, { eventType, tenantId, objectId: job.job_ref, payload: { job_ref: job.job_ref, ...summary } }, actor);
  return publicExportJob(finalJob);
}

function nowIsoExpiry(days) {
  const retention = Number(days) || 30;
  const date = new Date(Date.now() + retention * 24 * 60 * 60 * 1000);
  return date.toISOString();
}

// ── Preview ──────────────────────────────────────────────────────────────────

export function previewExport(db, tenantId, definition, params = {}, actor = null, ip = null) {
  const config = configFor(db, tenantId);
  const limit = Math.min(Number(params.limit) || config.preview_limit || 50, 200);
  const runtimeFilters = parseArray(params.filters, []);
  const collected = collectExportRecords(db, tenantId, definition, { filters: runtimeFilters.length ? [...definition.export_filters, ...runtimeFilters] : definition.export_filters });
  const lifecycleFiltered = Lifecycle.filterExportableRecords(db, tenantId, definition.object_type, collected);
  const records = lifecycleFiltered.records;
  const selections = definition.field_selections || [];
  const transformations = normalizeExportTransformations(definition.export_transformations || []);
  const lookupResolver = createLookupResolver({ staticMaps: parseObject(definition.transformation?.lookups, {}), cacheSize: config.lookup_cache_size });
  const rows = [];
  let denied = 0;
  for (const record of records.slice(0, limit)) {
    try {
      authorizeRecord(db, actor, { objectType: definition.object_type, objectId: record.id, action: "read", tenantId, organizationId: record.organization_id, ip });
    } catch (error) {
      denied += 1;
      rows.push({ id: record.id, denied: true, message: error.message });
      continue;
    }
    let safe = record;
    try {
      safe = enforceRecordFields(db, actor, { objectType: definition.object_type, record, action: "read", tenantId, organizationId: record.organization_id, ip }).record;
    } catch {
      /* best effort */
    }
    const selected = selections.length ? applyFieldSelection(safe, selections) : safe;
    rows.push({ id: record.id, record: Engines.applyDefinitionTransformations(transformations, selected, { lookup: lookupResolver }) });
  }
  return {
    object_type: definition.object_type,
    format: definition.format,
    destination: definition.destination,
    fields: selections.map((field) => field.field_path),
    record_count: records.length,
    sample_size: rows.length,
    denied,
    lifecycle_excluded_count: lifecycleFiltered.excluded.length,
    rows,
  };
}

// ── Query helpers ────────────────────────────────────────────────────────────

export function listExportJobs(db, { tenantId, status, definitionId, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (definitionId != null) {
    clauses.push("definition_id = ?");
    params.push(Number(definitionId));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM ie_export_jobs ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM ie_export_jobs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicExportJob), total, page: currentPage, page_size: limit };
}

export function listExportResults(db, { tenantId, jobId, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (jobId != null) {
    clauses.push("job_id = ?");
    params.push(Number(jobId));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM ie_export_results ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM ie_export_results ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicExportResult), total, page: currentPage, page_size: limit };
}

export function listExportHistory(db, { tenantId, jobId, definitionId, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (jobId != null) {
    clauses.push("job_id = ?");
    params.push(Number(jobId));
  }
  if (definitionId != null) {
    clauses.push("definition_id = ?");
    params.push(Number(definitionId));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM ie_export_history ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM ie_export_history ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return {
    items: rows.map((row) => ({ ...row, details: parseObject(row.details_json, {}), created_at: row.created_at })),
    total,
    page: currentPage,
    page_size: limit,
  };
}

export function getExportJob(db, tenantId, ref) {
  const row = getExportJobRow(db, tenantId, ref);
  return row ? publicExportJob(row) : null;
}

export function cancelExportJob(db, tenantId, ref, actor = null, ip = null) {
  const row = getExportJobRow(db, tenantId, ref);
  if (!row) throw jobConflict(`Export job not found: ${ref}`);
  if (!["QUEUED", "RUNNING", "PAUSED"].includes(row.status)) {
    throw jobConflict(`Export job is not cancellable in status ${row.status}`);
  }
  updateJob(db, row.id, { status: "CANCELLED", completed_at: nowIso() });
  writeAudit(db, { actor, action: "data_exchange.export_job.cancel", resourceType: "ie_export_jobs", resourceId: row.job_ref, details: {}, ip });
  publishExchangeEvent(db, { eventType: "ExportCancelled", tenantId: Number(tenantId), objectId: row.job_ref, payload: { job_ref: row.job_ref } }, actor);
  return publicExportJob(queryOne(db, "SELECT * FROM ie_export_jobs WHERE id = ?", [row.id]));
}

export function getExportResultRow(db, tenantId, ref) {
  return queryOne(db, "SELECT * FROM ie_export_results WHERE tenant_id = ? AND (result_ref = ? OR CAST(id AS TEXT) = ?)", [Number(tenantId), String(ref), String(ref)]);
}

export function downloadExportResult(db, tenantId, ref) {
  const row = getExportResultRow(db, tenantId, ref);
  if (!row) throw resultNotFound(ref);
  if (row.status !== "AVAILABLE") throw resultExpired(ref);
  const content = readBlob(db, tenantId, row.storage_uri);
  if (content === null) throw resultExpired(ref);
  return { filename: row.filename, content_type: row.content_type, content, result: publicExportResult(row) };
}

export { getExportDefinitionRow };
