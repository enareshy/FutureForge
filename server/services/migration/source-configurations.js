// Migration source configurations.
//
// A source configuration is a reusable, named connection to a legacy system
// (Teamcenter, PLM, PDM, ERP, MES, a database or a file repository). It binds an
// adapter type plus non-secret settings and an optional credential reference, and
// is reused across packages and definitions so connection details live in one
// place. Secret material is never stored here — only a credential reference.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SOURCE_MODULE } from "./constants.js";
import { sourceRef as makeSourceRef } from "./refs.js";
import { publicSourceConfiguration } from "./repository.js";
import { requireSourceAdapter, getSourceAdapter } from "./source-adapters/registry.js";
import { sourceNotFound, sourceConflict, invalidSource, adapterNotFound, adapterFailed } from "./errors.js";
import { normalizeText, normalizeUpper, parseObject, paginate, requireCode, assertAdapterType } from "./validation.js";

export function getSourceConfigurationRow(db, tenantId, ref) {
  return queryOne(
    db,
    "SELECT * FROM mig_source_configurations WHERE tenant_id = ? AND (source_ref = ? OR CAST(id AS TEXT) = ? OR code = ?)",
    [Number(tenantId), String(ref), String(ref), normalizeUpper(ref)]
  );
}

export function createSourceConfiguration(db, tenantId, input = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const code = requireCode(input.code || input.name, "Source code");
  if (queryOne(db, "SELECT id FROM mig_source_configurations WHERE tenant_id = ? AND code = ?", [tenant, code])) {
    throw sourceConflict(`Source configuration ${code} already exists`);
  }
  const adapterType = assertAdapterType(input.adapter_type ?? input.adapterType ?? "DATABASE");
  const settings = parseObject(input.settings, {});
  const ts = nowIso();
  const ref = makeSourceRef(code);
  const result = run(
    db,
    `INSERT INTO mig_source_configurations (source_ref, tenant_id, code, name, description, adapter_type, settings_json, credential_ref, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ref,
      tenant,
      code,
      normalizeText(input.name || code, { max: 200 }),
      normalizeText(input.description, { max: 2000 }),
      adapterType,
      JSON.stringify(settings),
      normalizeText(input.credential_ref ?? input.credentialRef, { max: 200 }),
      ["active", "inactive"].includes(String(input.status || "active").toLowerCase()) ? String(input.status || "active").toLowerCase() : "active",
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM mig_source_configurations WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, {
    actor,
    action: "migration.source.create",
    resourceType: "mig_source_configurations",
    resourceId: ref,
    details: { code, adapter_type: adapterType },
    ip,
  });
  return publicSourceConfiguration(row);
}

export function getSourceConfiguration(db, tenantId, ref) {
  const row = getSourceConfigurationRow(db, tenantId, ref);
  return row ? publicSourceConfiguration(row) : null;
}

export function listSourceConfigurations(db, { tenantId, adapterType, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (adapterType) {
    clauses.push("adapter_type = ?");
    params.push(assertAdapterType(adapterType));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status).toLowerCase());
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM mig_source_configurations ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM mig_source_configurations ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicSourceConfiguration), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function updateSourceConfiguration(db, tenantId, ref, patch = {}, actor = null, ip = null) {
  const row = getSourceConfigurationRow(db, tenantId, ref);
  if (!row) throw sourceNotFound(ref);
  const fields = [];
  const params = [];
  const set = (column, value) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) set("name", normalizeText(patch.name, { max: 200 }));
  if (patch.description !== undefined) set("description", normalizeText(patch.description, { max: 2000 }));
  if (patch.adapter_type !== undefined || patch.adapterType !== undefined) set("adapter_type", assertAdapterType(patch.adapter_type ?? patch.adapterType));
  if (patch.settings !== undefined) set("settings_json", JSON.stringify(parseObject(patch.settings, {})));
  if (patch.credential_ref !== undefined || patch.credentialRef !== undefined) set("credential_ref", normalizeText(patch.credential_ref ?? patch.credentialRef, { max: 200 }));
  if (!fields.length) return publicSourceConfiguration(row);
  run(db, `UPDATE mig_source_configurations SET ${fields.join(", ")}, updated_at = ? WHERE id = ?`, [...params, nowIso(), row.id]);
  writeAudit(db, { actor, action: "migration.source.update", resourceType: "mig_source_configurations", resourceId: row.source_ref, details: { fields: fields.length }, ip });
  return publicSourceConfiguration(queryOne(db, "SELECT * FROM mig_source_configurations WHERE id = ?", [row.id]));
}

export function setSourceConfigurationStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = getSourceConfigurationRow(db, tenantId, ref);
  if (!row) throw sourceNotFound(ref);
  const normalized = String(status || "").toLowerCase();
  if (!["active", "inactive"].includes(normalized)) throw invalidSource("Status must be active or inactive");
  run(db, "UPDATE mig_source_configurations SET status = ?, updated_at = ? WHERE id = ?", [normalized, nowIso(), row.id]);
  writeAudit(db, { actor, action: `migration.source.${normalized === "active" ? "activate" : "deactivate"}`, resourceType: "mig_source_configurations", resourceId: row.source_ref, details: {}, ip });
  return publicSourceConfiguration(queryOne(db, "SELECT * FROM mig_source_configurations WHERE id = ?", [row.id]));
}

// Tests connectivity through the adapter without moving business data.
export async function testSourceConfiguration(db, tenantId, ref, actor = null, ip = null) {
  const row = getSourceConfigurationRow(db, tenantId, ref);
  if (!row) throw sourceNotFound(ref);
  const publicRow = publicSourceConfiguration(row);
  if (!getSourceAdapter(publicRow.adapter_type)) throw adapterNotFound(publicRow.adapter_type);
  const adapter = requireSourceAdapter(publicRow.adapter_type);
  let result;
  try {
    result = await adapter.testConnection({ db, tenantId: Number(tenantId), adapterType: publicRow.adapter_type, settings: publicRow.settings });
  } catch (error) {
    writeAudit(db, { actor, action: "migration.source.test", resourceType: "mig_source_configurations", resourceId: row.source_ref, status: "FAILED", errorMessage: error.message, ip });
    throw adapterFailed(error.message, { code: row.code });
  }
  writeAudit(db, { actor, action: "migration.source.test", resourceType: "mig_source_configurations", resourceId: row.source_ref, details: { ok: Boolean(result?.ok) }, ip });
  return { code: row.code, adapter_type: publicRow.adapter_type, connected: Boolean(result?.ok), details: result || {} };
}

// Discovers the source schema (fields/tables) for mapping authoring.
export async function discoverSourceConfigurationSchema(db, tenantId, ref, params = {}, actor = null, ip = null) {
  const row = getSourceConfigurationRow(db, tenantId, ref);
  if (!row) throw sourceNotFound(ref);
  const publicRow = publicSourceConfiguration(row);
  const adapter = requireSourceAdapter(publicRow.adapter_type);
  const result = await adapter.discoverSchema({
    db,
    tenantId: Number(tenantId),
    adapterType: publicRow.adapter_type,
    settings: { ...publicRow.settings, ...(params.settings || {}) },
  });
  return { code: row.code, adapter_type: publicRow.adapter_type, ...(result || {}) };
}
