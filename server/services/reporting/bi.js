// BI integration (§21).
//
// External BI tools (Power BI, Tableau, Qlik, OData/REST) consume curated
// datasets. A dataset is a named, reusable projection over the semantic layer;
// the platform publishes a materialized snapshot and exposes a governed
// read endpoint. Outbound pushes to a vendor tenant are extension points and
// are reported honestly as PLANNED rather than faked.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { BI_PROVIDERS, BI_CONNECTION_STATUSES, BI_PUBLISH_STATUSES } from "./constants.js";
import { biNotFound, invalidExport, reportingConflict } from "./errors.js";
import { biConnectionRef as makeConnectionRef, biDatasetRef as makeDatasetRef } from "./identifiers.js";
import { publicBiConnection, publicBiDataset, publicBiPublishJob, parseJson, stringifyJson, paged } from "./repository.js";
import { getEntity } from "./semantic.js";
import { executeQuery, normalizeQuery } from "./query-engine.js";
import { publishReportingEvent } from "./events.js";
import { recordHistory } from "./history.js";

// Providers whose outbound push is not implemented in this release. They are
// still registerable so configuration and governance are captured.
const PLANNED_PUSH_PROVIDERS = new Set(["POWER_BI", "TABLEAU", "QLIK"]);

function validateConnection(input = {}) {
  const provider = String(input.provider || "").toUpperCase();
  if (!BI_PROVIDERS.includes(provider)) throw invalidExport(`Unsupported BI provider: ${input.provider}`);
  if (!input.name || !String(input.name).trim()) throw invalidExport("BI connection name is required");
  const status = input.status ? String(input.status).toUpperCase() : PLANNED_PUSH_PROVIDERS.has(provider) ? "PLANNED" : "CONNECTED";
  if (!BI_CONNECTION_STATUSES.includes(status)) throw invalidExport(`Unsupported BI connection status: ${status}`);
  return { provider, name: String(input.name).trim(), description: input.description ? String(input.description) : "", config: input.config || {}, status };
}

export function createBiConnection(db, tenantId, input = {}, actor = null, ip = null) {
  const normalized = validateConnection(input);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reporting_bi_connections (bi_ref, tenant_id, provider, name, description, config_json, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [makeConnectionRef(normalized.provider), Number(tenantId), normalized.provider, normalized.name, normalized.description, stringifyJson(normalized.config), normalized.status, actor?.id ?? null, ts, ts]
  );
  writeAudit(db, { actor, action: "reporting.bi.connection.create", resourceType: "reporting_bi_connection", resourceId: normalized.name, details: { provider: normalized.provider }, sourceModule: "reporting", ip });
  return getBiConnectionById(db, Number(tenantId), Number(result.lastInsertRowid));
}

export function getBiConnectionById(db, tenantId, id) {
  return publicBiConnection(queryOne(db, "SELECT * FROM reporting_bi_connections WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)]));
}

export function getBiConnection(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM reporting_bi_connections WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM reporting_bi_connections WHERE tenant_id = ? AND bi_ref = ?", [Number(tenantId), raw]);
  if (!row) throw biNotFound(ref);
  return publicBiConnection(row);
}

export function listBiConnections(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.provider) {
    where.push("provider = ?");
    params.push(String(query.provider).toUpperCase());
  }
  return paged(db, "reporting_bi_connections", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicBiConnection });
}

export function updateBiConnection(db, tenantId, ref, input = {}, actor = null) {
  const existing = getBiConnection(db, tenantId, ref);
  const normalized = validateConnection({ ...existing, ...input, provider: existing.provider, name: input.name || existing.name });
  run(db, "UPDATE reporting_bi_connections SET name = ?, description = ?, config_json = ?, status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [
    normalized.name,
    normalized.description,
    stringifyJson(normalized.config),
    normalized.status,
    nowIso(),
    existing.id,
    Number(tenantId),
  ]);
  writeAudit(db, { actor, action: "reporting.bi.connection.update", resourceType: "reporting_bi_connection", resourceId: existing.bi_ref, sourceModule: "reporting" });
  return getBiConnectionById(db, Number(tenantId), existing.id);
}

export function deleteBiConnection(db, tenantId, ref) {
  const existing = getBiConnection(db, tenantId, ref);
  run(db, "DELETE FROM reporting_bi_datasets WHERE connection_id = ? AND tenant_id = ?", [existing.id, Number(tenantId)]);
  run(db, "DELETE FROM reporting_bi_connections WHERE id = ? AND tenant_id = ?", [existing.id, Number(tenantId)]);
  return { deleted: true, bi_ref: existing.bi_ref };
}

// ── Datasets ─────────────────────────────────────────────────────────────────

function validateDataset(db, tenantId, input = {}) {
  if (!input.name || !String(input.name).trim()) throw invalidExport("Dataset name is required");
  const entity = getEntity((input.definition || {}).entity || input.entity);
  const relation = (input.definition || {}).relation;
  const definition = relation ? { ...(input.definition || {}), entity: entity.code } : normalizeQuery({ ...(input.definition || {}), entity: entity.code });
  return { name: String(input.name).trim(), entity: entity.code, definition, status: input.status ? String(input.status).toUpperCase() : "ACTIVE" };
}

export function createBiDataset(db, tenantId, input = {}, actor = null, ip = null) {
  const connection = getBiConnection(db, tenantId, input.connection_id || input.connectionId);
  const normalized = validateDataset(db, tenantId, input);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reporting_bi_datasets (dataset_ref, connection_id, tenant_id, name, entity, definition_json, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [makeDatasetRef(normalized.name), connection.id, Number(tenantId), normalized.name, normalized.entity, stringifyJson(normalized.definition), normalized.status, ts, ts]
  );
  writeAudit(db, { actor, action: "reporting.bi.dataset.create", resourceType: "reporting_bi_dataset", resourceId: normalized.name, details: { entity: normalized.entity }, sourceModule: "reporting", ip });
  return getBiDatasetById(db, Number(tenantId), Number(result.lastInsertRowid));
}

export function getBiDatasetById(db, tenantId, id) {
  return publicBiDataset(queryOne(db, "SELECT * FROM reporting_bi_datasets WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)]));
}

export function getBiDataset(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM reporting_bi_datasets WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM reporting_bi_datasets WHERE tenant_id = ? AND dataset_ref = ?", [Number(tenantId), raw]);
  if (!row) throw biNotFound(ref);
  return publicBiDataset(row);
}

export function listBiDatasets(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.connection_id || query.connectionId) {
    where.push("connection_id = ?");
    params.push(Number(query.connection_id || query.connectionId));
  }
  return paged(db, "reporting_bi_datasets", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicBiDataset });
}

export function updateBiDataset(db, tenantId, ref, input = {}, actor = null) {
  const existing = getBiDataset(db, tenantId, ref);
  const normalized = validateDataset(db, tenantId, { ...existing, ...input, name: input.name || existing.name });
  run(db, "UPDATE reporting_bi_datasets SET name = ?, entity = ?, definition_json = ?, status = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [
    normalized.name,
    normalized.entity,
    stringifyJson(normalized.definition),
    normalized.status,
    nowIso(),
    existing.id,
    Number(tenantId),
  ]);
  writeAudit(db, { actor, action: "reporting.bi.dataset.update", resourceType: "reporting_bi_dataset", resourceId: existing.dataset_ref, sourceModule: "reporting" });
  return getBiDatasetById(db, Number(tenantId), existing.id);
}

export function deleteBiDataset(db, tenantId, ref) {
  const existing = getBiDataset(db, tenantId, ref);
  run(db, "DELETE FROM reporting_bi_datasets WHERE id = ? AND tenant_id = ?", [existing.id, Number(tenantId)]);
  return { deleted: true, dataset_ref: existing.dataset_ref };
}

// Governed read used by external BI connectors. Applies centralized security.
export function getBiDatasetData(db, tenantId, ref, context = {}, actor = null, ip = null) {
  const dataset = getBiDataset(db, tenantId, ref);
  const connection = getBiConnectionById(db, tenantId, dataset.connection_id);
  const result = executeQuery(db, tenantId, dataset.definition, { ...context, actor, ip, organizationId: context.organizationId ?? null });
  return { dataset: dataset.dataset_ref, connection: connection.bi_ref, provider: connection.provider, entity: dataset.entity, data: result, generated_at: nowIso() };
}

export function datasetODataMetadata(db, tenantId, ref) {
  const dataset = getBiDataset(db, tenantId, ref);
  const columns = (dataset.definition.columns || []).map((column) => ({ name: column.alias || column.attribute, type: "Edm.String" }));
  return { dataset: dataset.dataset_ref, entity: dataset.entity, columns };
}

// Materializes a dataset snapshot and records the publish job. Power BI/
// Tableau/Qlik outbound delivery remains PLANNED and is surfaced as such.
export function publishDataset(db, tenantId, ref, context = {}, actor = null, ip = null) {
  const dataset = getBiDataset(db, tenantId, ref);
  const connection = getBiConnectionById(db, tenantId, dataset.connection_id);
  const ts = nowIso();
  const jobResult = run(
    db,
    `INSERT INTO reporting_bi_publish_jobs (publish_ref, dataset_id, connection_id, tenant_id, operation, status, message, created_at)
     VALUES (?, ?, ?, ?, 'PUBLISH', 'RUNNING', '', ?)`,
    [`BID-PUB-${Date.now()}`, dataset.id, connection.id, Number(tenantId), ts]
  );
  const jobId = Number(jobResult.lastInsertRowid);
  let status = "PUBLISHED";
  let message = "Dataset snapshot materialized";
  try {
    const result = executeQuery(db, tenantId, dataset.definition, { ...context, actor, ip, maxRows: context.maxRows });
    run(db, "UPDATE reporting_bi_datasets SET definition_json = ?, last_published_at = ?, status = 'ACTIVE', updated_at = ? WHERE id = ? AND tenant_id = ?", [
      stringifyJson({ ...dataset.definition, snapshot: { generated_at: ts, total: result.total, rows: result.rows.slice(0, 1000) } }),
      ts,
      ts,
      dataset.id,
      Number(tenantId),
    ]);
    if (PLANNED_PUSH_PROVIDERS.has(connection.provider)) {
      status = "PUBLISHED";
      message = `Snapshot materialized; outbound push to ${connection.provider} is a planned extension point`;
    }
  } catch (error) {
    status = "FAILED";
    message = error.message;
  }
  run(db, "UPDATE reporting_bi_publish_jobs SET status = ?, message = ?, finished_at = ? WHERE id = ?", [status, message, nowIso(), jobId]);
  writeAudit(db, { actor, action: "reporting.bi.publish", resourceType: "reporting_bi_dataset", resourceId: dataset.dataset_ref, details: { provider: connection.provider, status }, sourceModule: "reporting", ip });
  publishReportingEvent(db, { eventType: "ReportExecuted", payload: { dataset: dataset.dataset_ref, provider: connection.provider, status }, objectType: "reporting_bi_dataset", tenantId }, actor);
  recordHistory(db, { tenantId, action: "BI_PUBLISH", entity_type: "bi_dataset", entity_id: dataset.id, entity_ref: dataset.dataset_ref, actor_id: actor?.id, summary: `Published dataset ${dataset.dataset_ref}`, detail: { provider: connection.provider, status } });
  return { ...publicBiPublishJob(queryOne(db, "SELECT * FROM reporting_bi_publish_jobs WHERE id = ?", [jobId])), dataset: dataset.dataset_ref };
}

export function listBiPublishJobs(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  return paged(db, "reporting_bi_publish_jobs", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicBiPublishJob });
}

export function biCapabilities() {
  return {
    providers: [...BI_PROVIDERS],
    push_supported: [...BI_PROVIDERS].filter((provider) => !PLANNED_PUSH_PROVIDERS.has(provider)),
    planned: [...PLANNED_PUSH_PROVIDERS],
    dataset_read_endpoint: true,
    odata_metadata: true,
  };
}
