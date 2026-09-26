// Saved report definitions, versioning and execution (§5–§9, §15, §19, §27).
//
// A report is a versioned, shareable definition of a query over a data source.
// Definitions are validated against the semantic layer, authorized centrally,
// executed by the query engine and recorded in execution history. Published
// (immutable) reports never change in place: an edit snapshots the published
// version and rolls the live definition forward as a new DRAFT.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import {
  REPORT_STATUSES,
  IMMUTABLE_STATUSES,
  REPORT_TYPES,
  VISIBILITY_SCOPES,
  DEFAULT_DATA_SOURCE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ASYNC_ROW_THRESHOLD,
} from "./constants.js";
import { reportNotFound, reportConflict, invalidReport, securityBlocked } from "./errors.js";
import { reportRef as makeReportRef, executionRef as makeExecutionRef } from "./identifiers.js";
import { publicReport, parseJson, stringifyJson } from "./repository.js";
import { normalizeQuery, executeQuery, queryTypeOf } from "./query-engine.js";
import { getEntity } from "./semantic.js";
import { canAccess } from "./visibility.js";
import { buildCacheKey, getCached, setCached, securityFingerprint } from "./cache.js";
import { getNumericConfig, getConfig } from "./configuration.js";
import { publishReportingEvent } from "./events.js";
import { recordExecution, recordHistory } from "./history.js";

// ── Validation ───────────────────────────────────────────────────────────────

function validateReport(db, input = {}) {
  if (!input.code || !String(input.code).trim()) throw invalidReport("Report code is required");
  if (!input.name || !String(input.name).trim()) throw invalidReport("Report name is required");
  const reportType = String(input.report_type || input.reportType || "TABULAR").toUpperCase();
  if (!REPORT_TYPES.includes(reportType)) throw invalidReport(`Unsupported report type: ${reportType}`);
  const visibility = String(input.visibility || "PRIVATE").toUpperCase();
  if (!VISIBILITY_SCOPES.includes(visibility)) throw invalidReport(`Unsupported visibility scope: ${visibility}`);
  const definition = input.definition || {};
  const entity = getEntity(definition.entity || input.entity);
  const normalizedQuery = normalizeQuery({ ...definition, data_source: definition.data_source || input.data_source || DEFAULT_DATA_SOURCE, entity: entity.code });
  if (input.visibility_subject !== undefined && input.visibility_subject !== null && input.visibility_subject !== "") {
    const subject = Number(input.visibility_subject);
    if (!Number.isFinite(subject)) throw invalidReport("visibility_subject must be numeric");
  }
  return {
    code: String(input.code).trim().toUpperCase(),
    name: String(input.name).trim(),
    description: input.description ? String(input.description) : "",
    report_type: reportType,
    data_source: normalizedQuery.data_source,
    entity: entity.code,
    definition: { ...normalizedQuery },
    visualization: input.visualization || definition.visualization || {},
    security_scope: input.security_scope || input.securityScope || {},
    visibility,
    visibility_subject: input.visibility_subject ?? input.visibilitySubject ?? null,
    metadata: input.metadata || {},
    organization_id: input.organization_id ?? input.organizationId ?? null,
    site: input.site ?? null,
    status: input.status ? String(input.status).toUpperCase() : null,
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export function getReportById(db, tenantId, id) {
  return publicReport(queryOne(db, "SELECT * FROM reporting_reports WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)]));
}

export function getReport(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM reporting_reports WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM reporting_reports WHERE tenant_id = ? AND (code = ? OR report_ref = ?)", [Number(tenantId), raw.toUpperCase(), raw]);
  if (!row) throw reportNotFound(ref);
  return publicReport(row);
}

function reportShares(db, reportId) {
  return queryAll(db, "SELECT subject_type, subject_id FROM reporting_report_shares WHERE report_id = ?", [Number(reportId)]);
}

export function isReportVisible(db, actor, report) {
  if (!report) return false;
  return canAccess(db, actor, {
    ownerUserId: report.owner_user_id,
    visibility: report.visibility,
    subjectType: report.visibility_subject === null ? null : "USER",
    subjectId: report.visibility_subject,
    shares: reportShares(db, report.id),
  });
}

export function assertReportVisible(db, actor, report) {
  if (!isReportVisible(db, actor, report)) throw securityBlocked({ reason: "REPORT_NOT_VISIBLE", report: report?.code });
  return report;
}

export function listReports(db, tenantId, query = {}, actor = null) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.report_type || query.reportType) {
    where.push("report_type = ?");
    params.push(String(query.report_type || query.reportType).toUpperCase());
  }
  if (query.entity) {
    where.push("entity = ?");
    params.push(String(query.entity));
  }
  if (query.data_source || query.dataSource) {
    where.push("data_source = ?");
    params.push(String(query.data_source || query.dataSource).toUpperCase());
  }
  if (query.owner_user_id || query.ownerUserId) {
    where.push("owner_user_id = ?");
    params.push(Number(query.owner_user_id || query.ownerUserId));
  }
  const clause = where.join(" AND ");
  const search = query.search ? String(query.search).toLowerCase() : null;
  let rows = queryAll(db, `SELECT * FROM reporting_reports WHERE ${clause} ORDER BY id DESC`, params);
  if (search) rows = rows.filter((row) => row.code.toLowerCase().includes(search) || row.name.toLowerCase().includes(search));
  if (actor) rows = rows.filter((row) => isReportVisible(db, actor, publicReport(row)));
  const total = rows.length;
  const page = Math.max(1, Number(query.page) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.page_size || query.pageSize) || DEFAULT_PAGE_SIZE));
  const items = rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize).map(publicReport);
  return { items, total, page, pageSize };
}

export function listReportVersions(db, tenantId, ref) {
  const report = getReport(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM reporting_report_versions WHERE report_id = ? ORDER BY version DESC", [report.id]);
  return {
    items: rows.map((row) => ({ version: row.version, status: row.status, change_summary: row.change_summary, snapshot: parseJson(row.snapshot_json, {}), created_by: row.created_by, created_at: row.created_at })),
    total: rows.length,
  };
}

export function getReportVersion(db, tenantId, ref, version) {
  const report = getReport(db, tenantId, ref);
  const row = queryOne(db, "SELECT * FROM reporting_report_versions WHERE report_id = ? AND version = ?", [report.id, Number(version)]);
  if (!row) throw reportNotFound(`${report.code}@v${version}`);
  return { version: row.version, status: row.status, change_summary: row.change_summary, definition: parseJson(row.snapshot_json, {}), created_by: row.created_by, created_at: row.created_at };
}

// ── Writes ───────────────────────────────────────────────────────────────────

function snapshotReport(db, reportRow, status, changeSummary, actorId = null) {
  run(
    db,
    `INSERT INTO reporting_report_versions (report_id, tenant_id, version, status, change_summary, snapshot_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [reportRow.id, reportRow.tenant_id, reportRow.version, status, changeSummary || "", stringifyJson(publicReport(reportRow)), actorId, nowIso()]
  );
}

export function createReport(db, tenantId, input = {}, actor = null, ip = null) {
  const normalized = validateReport(db, input);
  if (queryOne(db, "SELECT id FROM reporting_reports WHERE tenant_id = ? AND code = ?", [Number(tenantId), normalized.code])) {
    throw reportConflict(normalized.code);
  }
  const ts = nowIso();
  const status = normalized.status && REPORT_STATUSES.includes(normalized.status) ? normalized.status : "DRAFT";
  const result = run(
    db,
    `INSERT INTO reporting_reports (report_ref, tenant_id, organization_id, site, code, name, description, report_type, data_source, entity, definition_json, visualization_json, security_scope_json, visibility, visibility_subject, owner_user_id, version, status, immutable, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?, ?, ?)`,
    [
      makeReportRef(normalized.code),
      Number(tenantId),
      normalized.organization_id ?? null,
      normalized.site ?? null,
      normalized.code,
      normalized.name,
      normalized.description,
      normalized.report_type,
      normalized.data_source,
      normalized.entity,
      stringifyJson(normalized.definition),
      stringifyJson(normalized.visualization),
      stringifyJson(normalized.security_scope),
      normalized.visibility,
      normalized.visibility_subject ?? null,
      input.owner_user_id ?? input.ownerUserId ?? actor?.id ?? null,
      status,
      stringifyJson(normalized.metadata),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const created = getReportById(db, Number(tenantId), Number(result.lastInsertRowid));
  if (input.shares) replaceReportShares(db, Number(tenantId), created.id, input.shares);
  writeAudit(db, { actor, action: "reporting.report.create", resourceType: "reporting_report", resourceId: normalized.code, details: { entity: normalized.entity, report_type: normalized.report_type }, sourceModule: "reporting", ip });
  publishReportingEvent(db, { eventType: "ReportCreated", payload: { code: normalized.code, report_type: normalized.report_type }, objectType: "reporting_report", tenantId, organizationId: normalized.organization_id }, actor);
  recordHistory(db, { tenantId, action: "CREATE", entity_type: "report", entity_id: created.id, entity_ref: created.report_ref, actor_id: actor?.id, summary: `Created report ${created.code}`, detail: { version: created.version } });
  return created;
}

export function updateReport(db, tenantId, ref, input = {}, actor = null, ip = null) {
  const existing = getReport(db, tenantId, ref);
  const merged = { ...existing, ...input, code: existing.code, entity: existing.entity, definition: input.definition || existing.definition };
  const normalized = validateReport(db, merged);
  const ts = nowIso();
  let version = existing.version;
  let status = existing.status;
  const immutable = IMMUTABLE_STATUSES.includes(existing.status);
  if (immutable) {
    snapshotReport(db, queryOne(db, "SELECT * FROM reporting_reports WHERE id = ?", [existing.id]), existing.status, "Rolled forward from published version", actor?.id);
    version = existing.version + 1;
    status = "DRAFT";
  }
  run(
    db,
    `UPDATE reporting_reports SET name = ?, description = ?, report_type = ?, data_source = ?, entity = ?, definition_json = ?, visualization_json = ?, security_scope_json = ?, visibility = ?, visibility_subject = ?, version = ?, status = ?, immutable = 0, metadata_json = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?`,
    [
      normalized.name,
      normalized.description,
      normalized.report_type,
      normalized.data_source,
      normalized.entity,
      stringifyJson(normalized.definition),
      stringifyJson(normalized.visualization),
      stringifyJson(normalized.security_scope),
      normalized.visibility,
      normalized.visibility_subject ?? null,
      version,
      status,
      stringifyJson(normalized.metadata),
      actor?.id ?? null,
      ts,
      existing.id,
      Number(tenantId),
    ]
  );
  if (input.shares) replaceReportShares(db, Number(tenantId), existing.id, input.shares);
  writeAudit(db, { actor, action: "reporting.report.update", resourceType: "reporting_report", resourceId: existing.code, details: { version, rolled_forward: immutable }, sourceModule: "reporting", ip });
  publishReportingEvent(db, { eventType: "ReportUpdated", payload: { code: existing.code, version }, objectType: "reporting_report", tenantId }, actor);
  recordHistory(db, { tenantId, action: immutable ? "ROLL_FORWARD" : "UPDATE", entity_type: "report", entity_id: existing.id, entity_ref: existing.report_ref, actor_id: actor?.id, summary: `Updated report ${existing.code}`, detail: { version, previous_status: existing.status } });
  return getReportById(db, Number(tenantId), existing.id);
}

export function publishReport(db, tenantId, ref, actor = null) {
  const existing = getReport(db, tenantId, ref);
  const raw = queryOne(db, "SELECT * FROM reporting_reports WHERE id = ?", [existing.id]);
  snapshotReport(db, raw, "ACTIVE", "Published", actor?.id);
  const ts = nowIso();
  run(db, "UPDATE reporting_reports SET status = 'ACTIVE', immutable = 1, published_at = ?, published_by = ?, updated_by = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [
    ts,
    actor?.id ?? null,
    actor?.id ?? null,
    ts,
    existing.id,
    Number(tenantId),
  ]);
  writeAudit(db, { actor, action: "reporting.report.publish", resourceType: "reporting_report", resourceId: existing.code, details: { version: existing.version }, sourceModule: "reporting" });
  publishReportingEvent(db, { eventType: "ReportPublished", payload: { code: existing.code, version: existing.version }, objectType: "reporting_report", tenantId }, actor);
  recordHistory(db, { tenantId, action: "PUBLISH", entity_type: "report", entity_id: existing.id, entity_ref: existing.report_ref, actor_id: actor?.id, summary: `Published report ${existing.code} v${existing.version}`, detail: {} });
  return getReportById(db, Number(tenantId), existing.id);
}

export function setReportStatus(db, tenantId, ref, status, actor = null) {
  const existing = getReport(db, tenantId, ref);
  const next = String(status || "").toUpperCase();
  if (!REPORT_STATUSES.includes(next)) throw invalidReport(`Unsupported report status: ${status}`);
  run(db, "UPDATE reporting_reports SET status = ?, updated_by = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [next, actor?.id ?? null, nowIso(), existing.id, Number(tenantId)]);
  writeAudit(db, { actor, action: "reporting.report.status", resourceType: "reporting_report", resourceId: existing.code, details: { status: next }, sourceModule: "reporting" });
  return getReportById(db, Number(tenantId), existing.id);
}

export function deleteReport(db, tenantId, ref, actor = null) {
  const existing = getReport(db, tenantId, ref);
  run(db, "DELETE FROM reporting_report_versions WHERE report_id = ?", [existing.id]);
  run(db, "DELETE FROM reporting_report_shares WHERE report_id = ?", [existing.id]);
  run(db, "DELETE FROM reporting_reports WHERE id = ? AND tenant_id = ?", [existing.id, Number(tenantId)]);
  writeAudit(db, { actor, action: "reporting.report.delete", resourceType: "reporting_report", resourceId: existing.code, sourceModule: "reporting" });
  return { deleted: true, code: existing.code };
}

export function cloneReport(db, tenantId, ref, input = {}, actor = null) {
  const existing = getReport(db, tenantId, ref);
  return createReport(
    db,
    tenantId,
    {
      ...existing,
      code: input.code || `${existing.code}_COPY`,
      name: input.name || `${existing.name} (Copy)`,
      definition: existing.definition,
      status: "DRAFT",
      organization_id: input.organization_id ?? existing.organization_id,
    },
    actor
  );
}

export function replaceReportShares(db, tenantId, reportId, shares = []) {
  run(db, "DELETE FROM reporting_report_shares WHERE report_id = ? AND tenant_id = ?", [Number(reportId), Number(tenantId)]);
  for (const share of shares) {
    const subjectType = String(share.subject_type || share.subjectType || "USER").toUpperCase();
    run(db, "INSERT INTO reporting_report_shares (tenant_id, report_id, subject_type, subject_id, created_at) VALUES (?, ?, ?, ?, ?)", [Number(tenantId), Number(reportId), subjectType, Number(share.subject_id ?? share.subjectId), nowIso()]);
  }
  return shares.length;
}

// ── Execution ────────────────────────────────────────────────────────────────

function resultSummary(result) {
  return {
    columns: result.columns,
    total: result.total,
    groups: result.groups,
    query_type: result.query_type,
    truncated: result.truncated,
    denied: result.denied,
    sample: result.rows.slice(0, 5),
  };
}

// Executes a report definition. `mode` is PREVIEW / EXECUTE / SCHEDULED / EXPORT.
export function runReport(db, tenantId, report, context = {}) {
  const definition = report.definition || {};
  const mode = context.mode || "EXECUTE";
  const parameters = context.parameters || {};
  const useCache = context.enableCache !== false && mode === "EXECUTE";
  const securityHash = securityFingerprint({ tenantId, organizationId: context.organizationId, userId: context.actor?.id, roles: context.roles || [] });
  const cacheKey = buildCacheKey("report", [report.code, report.version, mode, securityHash, parameters]);
  if (useCache) {
    const cached = getCached(db, cacheKey);
    if (cached) return { ...cached, cache_hit: true };
  }
  const started = Date.now();
  const overrides = {};
  if (context.page) overrides.page = Number(context.page);
  if (context.page_size || context.pageSize) overrides.page_size = Number(context.page_size || context.pageSize);
  const baseDefinition = Object.keys(overrides).length ? { ...definition, ...overrides } : definition;
  const mergedDefinition = Array.isArray(context.filters) && context.filters.length ? { ...baseDefinition, filters: [...(baseDefinition.filters || []), ...context.filters] } : baseDefinition;
  const result = executeQuery(db, tenantId, mergedDefinition, {
    ...context,
    parameters,
    maxRows: context.maxRows ?? getNumericConfig(db, tenantId, "max_rows"),
    maxExecutionMs: context.maxExecutionMs ?? getNumericConfig(db, tenantId, "max_execution_ms"),
    maxGroupRows: context.maxGroupRows ?? getNumericConfig(db, tenantId, "max_group_rows"),
  });
  const payload = { ...result, report: report.code, report_version: report.version, data_source: report.data_source, entity: report.entity, took_ms: Date.now() - started };
  if (useCache) setCached(db, { tenantId, scope: "report", cacheKey, payload, ttlSeconds: context.cacheTtlSeconds ?? getNumericConfig(db, tenantId, "cache_ttl_seconds"), securityHash });
  return { ...payload, cache_hit: false };
}

export function executeReport(db, tenantId, ref, context = {}, actor = null, ip = null) {
  const report = assertReportVisible(db, actor, getReport(db, tenantId, ref));
  const mode = context.mode || "EXECUTE";
  const started = Date.now();
  const executionRef = makeExecutionRef();
  let result;
  let status = "COMPLETED";
  let errorCode = "";
  let errorMessage = "";
  try {
    result = runReport(db, tenantId, report, { ...context, mode, actor, ip, organizationId: context.organizationId ?? report.organization_id });
  } catch (error) {
    status = "FAILED";
    errorCode = error.code || "REPORTING_ERROR";
    errorMessage = error.message;
    recordExecution(db, {
      execution_ref: executionRef,
      tenantId,
      report_id: report.id,
      report_code: report.code,
      mode,
      status,
      user_id: actor?.id,
      parameters: context.parameters,
      query: { entity: report.entity, data_source: report.data_source, query_type: queryTypeOf(report.definition) },
      row_count: 0,
      duration_ms: Date.now() - started,
      error_code: errorCode,
      error_message: errorMessage,
      correlation_id: context.correlationId,
    });
    publishReportingEvent(db, { eventType: "ReportFailed", payload: { code: report.code, error: errorMessage }, objectType: "reporting_report", tenantId, organizationId: report.organization_id }, actor);
    throw error;
  }
  recordExecution(db, {
    execution_ref: executionRef,
    tenantId,
    report_id: report.id,
    report_code: report.code,
    mode,
    status,
    user_id: actor?.id,
    parameters: context.parameters,
    query: { entity: result.entity, data_source: result.data_source, query_type: result.query_type },
    result: resultSummary(result),
    row_count: result.total,
    duration_ms: result.took_ms,
    cache_hit: result.cache_hit,
    correlation_id: context.correlationId,
  });
  writeAudit(db, { actor, action: "reporting.report.execute", resourceType: "reporting_report", resourceId: report.code, details: { mode, rows: result.total, cache_hit: result.cache_hit }, sourceModule: "reporting", ip });
  publishReportingEvent(db, { eventType: "ReportExecuted", payload: { code: report.code, version: report.version, mode, rows: result.total }, objectType: "reporting_report", tenantId, organizationId: report.organization_id }, actor);
  return { execution_ref: executionRef, ...result };
}

export function previewReport(db, tenantId, ref, context = {}, actor = null, ip = null) {
  return executeReport(db, tenantId, ref, { ...context, mode: "PREVIEW" }, actor, ip);
}

export function executeReportDefinition(db, tenantId, report, context = {}, actor = null) {
  if (!report?.definition) throw invalidReport("Report definition is required");
  return runReport(db, tenantId, report, { ...context, actor });
}

export function shouldRunAsync(db, tenantId, rowEstimate) {
  const threshold = getNumericConfig(db, tenantId, "async_row_threshold") || ASYNC_ROW_THRESHOLD;
  return Number(rowEstimate || 0) >= threshold;
}

export function reportAsyncThreshold(db, tenantId) {
  return getNumericConfig(db, tenantId, "async_row_threshold") || ASYNC_ROW_THRESHOLD;
}

export function reportingCacheEnabled(db, tenantId) {
  const value = getConfig(db, tenantId, "enable_cache");
  return value !== false;
}
