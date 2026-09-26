// Data-asset freshness.
//
// A DataAsset describes a store the platform depends on (object model, search
// index, event stream, ...). A FreshnessDefinition binds an asset to its
// provider and age limits. The freshness evaluator reports an age in seconds
// and a status band; it never writes into the owning module.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { ASSET_TYPES, FRESHNESS_STATUSES } from "./constants.js";
import { assetRef, freshnessRef } from "./identifiers.js";
import { parseJson, stringifyJson, paged, toNumber, tableExists } from "./repository.js";
import { getProvider, measureFreshness } from "./providers.js";
import { assetNotFound, assetConflict, freshnessNotFound, freshnessConflict, invalidFreshness } from "./errors.js";
import { recordHistory } from "./history.js";

export function publicAsset(row) {
  if (!row) return null;
  return {
    id: row.id,
    asset_ref: row.asset_ref,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description,
    asset_type: row.asset_type,
    provider_code: row.provider_code,
    entity_code: row.entity_code,
    source_table: row.source_table,
    refresh_interval_seconds: row.refresh_interval_seconds,
    warn_age_seconds: row.warn_age_seconds,
    critical_age_seconds: row.critical_age_seconds,
    owner_user_id: row.owner_user_id,
    status: row.status,
    metadata: parseJson(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicFreshness(row) {
  if (!row) return null;
  return {
    id: row.id,
    freshness_ref: row.freshness_ref,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description,
    asset_code: row.asset_code,
    provider_code: row.provider_code,
    source_table: row.source_table,
    entity_code: row.entity_code,
    max_age_seconds: row.max_age_seconds,
    warn_age_seconds: row.warn_age_seconds,
    critical_age_seconds: row.critical_age_seconds,
    status: row.status,
    metadata: parseJson(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Assets ──────────────────────────────────────────────────────────────────
export function createAsset(db, tenantId, input = {}, actor = null) {
  const code = String(input.code || "").trim().toUpperCase();
  if (!code) throw invalidFreshness("Asset code is required");
  if (queryOne(db, "SELECT id FROM observability_data_assets WHERE tenant_id = ? AND code = ?", [Number(tenantId), code])) throw assetConflict(code);
  if (input.provider_code && !getProvider(input.provider_code)) throw invalidFreshness(`Unknown provider: ${input.provider_code}`);
  const assetType = String(input.asset_type || "TABLE").toUpperCase();
  if (!ASSET_TYPES.includes(assetType)) throw invalidFreshness(`Unsupported asset type: ${input.asset_type}`);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO observability_data_assets (asset_ref, tenant_id, code, name, description, asset_type, provider_code, entity_code, source_table, refresh_interval_seconds, warn_age_seconds, critical_age_seconds, owner_user_id, status, metadata_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.asset_ref || assetRef(code),
      Number(tenantId),
      code,
      String(input.name || code),
      String(input.description || ""),
      assetType,
      String(input.provider_code || "PLATFORM").toUpperCase(),
      input.entity_code ?? null,
      input.source_table ?? null,
      Math.max(30, Number(input.refresh_interval_seconds) || 3600),
      toNumber(input.warn_age_seconds, 86400),
      toNumber(input.critical_age_seconds, 604800),
      input.owner_user_id ?? actor?.id ?? null,
      String(input.status || "ACTIVE").toUpperCase(),
      stringifyJson(input.metadata || {}),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM observability_data_assets WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordHistory(db, { tenantId, action: "ASSET_CREATED", entityType: "asset", entityId: row.id, entityRef: row.asset_ref, actor, summary: `Data asset ${code} created` });
  writeAudit(db, { actor_id: actor?.id ?? null, actor_username: actor?.username ?? null, action: "observability.asset.create", resource_type: "observability_asset", resource_id: row.asset_ref, details: { code } });
  return publicAsset(row);
}

export function listAssets(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  return paged(db, "observability_data_assets", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicAsset });
}

export function getAssetRow(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) return queryOne(db, "SELECT * FROM observability_data_assets WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
  return queryOne(db, "SELECT * FROM observability_data_assets WHERE tenant_id = ? AND (asset_ref = ? OR code = ?)", [Number(tenantId), raw, raw]);
}

export function getAsset(db, tenantId, ref) {
  const row = getAssetRow(db, tenantId, ref);
  if (!row) throw assetNotFound(ref);
  return publicAsset(row);
}

// ── Freshness definitions ───────────────────────────────────────────────────
export function createFreshness(db, tenantId, input = {}, actor = null) {
  const code = String(input.code || "").trim().toUpperCase();
  if (!code) throw invalidFreshness("Freshness code is required");
  if (!input.asset_code) throw invalidFreshness("asset_code is required");
  if (queryOne(db, "SELECT id FROM observability_freshness_definitions WHERE tenant_id = ? AND code = ?", [Number(tenantId), code])) throw freshnessConflict(code);
  if (input.provider_code && !getProvider(input.provider_code)) throw invalidFreshness(`Unknown provider: ${input.provider_code}`);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO observability_freshness_definitions (freshness_ref, tenant_id, code, name, description, asset_code, provider_code, source_table, entity_code, max_age_seconds, warn_age_seconds, critical_age_seconds, status, metadata_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.freshness_ref || freshnessRef(code),
      Number(tenantId),
      code,
      String(input.name || code),
      String(input.description || ""),
      String(input.asset_code).toUpperCase(),
      String(input.provider_code || "PLATFORM").toUpperCase(),
      input.source_table ?? null,
      input.entity_code ?? null,
      Math.max(30, Number(input.max_age_seconds) || 86400),
      toNumber(input.warn_age_seconds, Math.max(30, Number(input.max_age_seconds) || 86400)),
      toNumber(input.critical_age_seconds, Math.max(30, Number(input.max_age_seconds) || 86400) * 4),
      String(input.status || "ACTIVE").toUpperCase(),
      stringifyJson(input.metadata || {}),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM observability_freshness_definitions WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordHistory(db, { tenantId, action: "FRESHNESS_CREATED", entityType: "freshness", entityId: row.id, entityRef: row.freshness_ref, actor, summary: `Freshness ${code} created` });
  writeAudit(db, { actor_id: actor?.id ?? null, actor_username: actor?.username ?? null, action: "observability.freshness.create", resource_type: "observability_freshness", resource_id: row.freshness_ref, details: { code } });
  return publicFreshness(row);
}

export function getFreshnessRow(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) return queryOne(db, "SELECT * FROM observability_freshness_definitions WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
  return queryOne(db, "SELECT * FROM observability_freshness_definitions WHERE tenant_id = ? AND (freshness_ref = ? OR code = ?)", [Number(tenantId), raw, raw]);
}

export function getFreshness(db, tenantId, ref) {
  const row = getFreshnessRow(db, tenantId, ref);
  if (!row) throw freshnessNotFound(ref);
  return publicFreshness(row);
}

export function updateFreshness(db, tenantId, ref, input = {}, actor = null) {
  const row = getFreshnessRow(db, tenantId, ref);
  if (!row) throw freshnessNotFound(ref);
  run(
    db,
    `UPDATE observability_freshness_definitions SET name = ?, description = ?, asset_code = ?, provider_code = ?, source_table = ?, entity_code = ?, max_age_seconds = ?, warn_age_seconds = ?, critical_age_seconds = ?, status = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
    [
      input.name ?? row.name,
      input.description ?? row.description,
      input.asset_code ? String(input.asset_code).toUpperCase() : row.asset_code,
      input.provider_code ? String(input.provider_code).toUpperCase() : row.provider_code,
      input.source_table !== undefined ? input.source_table : row.source_table,
      input.entity_code !== undefined ? input.entity_code : row.entity_code,
      input.max_age_seconds !== undefined ? Math.max(30, Number(input.max_age_seconds)) : row.max_age_seconds,
      input.warn_age_seconds !== undefined ? toNumber(input.warn_age_seconds) : row.warn_age_seconds,
      input.critical_age_seconds !== undefined ? toNumber(input.critical_age_seconds) : row.critical_age_seconds,
      input.status ? String(input.status).toUpperCase() : row.status,
      input.metadata !== undefined ? stringifyJson(input.metadata) : row.metadata_json,
      nowIso(),
      row.id,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM observability_freshness_definitions WHERE id = ?", [row.id]);
  recordHistory(db, { tenantId, action: "FRESHNESS_UPDATED", entityType: "freshness", entityId: row.id, entityRef: row.freshness_ref, actor, summary: `Freshness ${row.code} updated` });
  return publicFreshness(updated);
}

export function deleteFreshness(db, tenantId, ref, actor = null) {
  const row = getFreshnessRow(db, tenantId, ref);
  if (!row) throw freshnessNotFound(ref);
  run(db, "UPDATE observability_freshness_definitions SET status = 'ARCHIVED', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  recordHistory(db, { tenantId, action: "FRESHNESS_ARCHIVED", entityType: "freshness", entityId: row.id, entityRef: row.freshness_ref, actor, summary: `Freshness ${row.code} archived` });
  return { archived: true, freshness_ref: row.freshness_ref };
}

export function listFreshness(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.asset_code || query.assetCode) {
    where.push("asset_code = ?");
    params.push(String(query.asset_code || query.assetCode).toUpperCase());
  }
  return paged(db, "observability_freshness_definitions", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicFreshness });
}

// ── Evaluation ──────────────────────────────────────────────────────────────
export function freshnessStatus(ageSeconds, definition) {
  if (ageSeconds === null || ageSeconds === undefined) return "UNKNOWN";
  const critical = definition.critical_age_seconds ?? definition.max_age_seconds * 4;
  const warn = definition.warn_age_seconds ?? definition.max_age_seconds;
  if (ageSeconds >= critical) return "CRITICAL";
  if (ageSeconds >= warn) return "WARNING";
  return "FRESH";
}

export function evaluateFreshness(db, tenantId) {
  const definitions = queryAll(db, "SELECT * FROM observability_freshness_definitions WHERE tenant_id = ? AND status = 'ACTIVE' ORDER BY code", [Number(tenantId)]);
  return definitions.map((definition) => {
    const publicDef = publicFreshness(definition);
    const result = measureFreshness(db, tenantId, publicDef);
    const status = result.age_seconds === null ? "UNKNOWN" : freshnessStatus(result.age_seconds, publicDef);
    return {
      freshness_ref: definition.freshness_ref,
      code: definition.code,
      name: definition.name,
      asset_code: definition.asset_code,
      provider_code: definition.provider_code,
      source_table: definition.source_table || null,
      age_seconds: result.age_seconds,
      max_age_seconds: definition.max_age_seconds,
      warn_age_seconds: definition.warn_age_seconds,
      critical_age_seconds: definition.critical_age_seconds,
      status,
      error: result.error,
    };
  });
}

export function freshnessSummary(db, tenantId) {
  const items = evaluateFreshness(db, tenantId).filter((entry) => entry.status !== "UNKNOWN");
  const buckets = { FRESH: 0, WARNING: 0, STALE: 0, CRITICAL: 0, UNKNOWN: 0 };
  for (const item of items) buckets[item.status] = (buckets[item.status] || 0) + 1;
  return { total: items.length, buckets, items };
}

// Seeds a data asset for a freshness definition that references a table but has
// no corresponding asset yet. Used by the seed and by admin onboarding.
export function ensureAssetForTable(db, tenantId, { code, name, providerCode, table, assetType = "TABLE" }, actor = null) {
  if (!tableExists(db, table)) return null;
  const existing = getAssetRow(db, tenantId, code);
  if (existing) return publicAsset(existing);
  return createAsset(db, tenantId, { code, name, provider_code: providerCode, source_table: table, asset_type: assetType }, actor);
}

export { FRESHNESS_STATUSES };
