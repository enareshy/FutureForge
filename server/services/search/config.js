// Per-tenant search configuration.
import { queryOne, run, nowIso } from "../../db.js";
import { runAsync } from "../../db-async.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { publicConfiguration, configRow, configRowAsync, defaultConfiguration } from "./repository.js";
import { SEARCH_SCOPES, SEARCH_SORTS } from "./validation.js";
import { HttpError } from "../../validation.js";

export function ensureConfiguration(db, tenantId) {
  const existing = configRow(db, tenantId);
  if (existing) return existing;
  const ts = nowIso();
  run(
    db,
    `INSERT INTO search_configuration (tenant_id, created_at, updated_at) VALUES (?, ?, ?)`,
    [Number(tenantId), ts, ts]
  );
  return configRow(db, tenantId);
}

export function getConfiguration(db, tenantId) {
  const row = configRow(db, tenantId) || ensureConfiguration(db, tenantId);
  return publicConfiguration(row);
}

function configurationUpdate(patch) {
  const fields = [];
  const params = [];
  const set = (column, value) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.enabled !== undefined) set("enabled", patch.enabled ? 1 : 0);
  if (patch.default_scope !== undefined) {
    if (!SEARCH_SCOPES.includes(patch.default_scope)) {
      throw new HttpError(400, `default_scope must be one of ${SEARCH_SCOPES.join(", ")}`);
    }
    set("default_scope", patch.default_scope);
  }
  if (patch.default_sort !== undefined) {
    if (!SEARCH_SORTS.includes(patch.default_sort)) {
      throw new HttpError(400, `default_sort must be one of ${SEARCH_SORTS.join(", ")}`);
    }
    set("default_sort", patch.default_sort);
  }
  if (patch.page_size !== undefined) set("page_size", Math.max(1, Math.min(100, Number(patch.page_size) || 20)));
  if (patch.max_results !== undefined) set("max_results", Math.max(1, Math.min(5000, Number(patch.max_results) || 500)));
  if (patch.min_query_length !== undefined) set("min_query_length", Math.max(0, Math.min(50, Number(patch.min_query_length) || 0)));
  if (patch.max_query_length !== undefined) set("max_query_length", Math.max(10, Math.min(2000, Number(patch.max_query_length) || 400)));
  if (patch.highlight !== undefined) set("highlight", patch.highlight ? 1 : 0);
  if (patch.fuzzy !== undefined) set("fuzzy", patch.fuzzy ? 1 : 0);
  if (patch.history_retention_days !== undefined) set("history_retention_days", Math.max(1, Math.min(3650, Number(patch.history_retention_days) || 90)));
  if (patch.index_files !== undefined) set("index_files", patch.index_files ? 1 : 0);
  if (patch.excluded_types !== undefined) {
    const list = Array.isArray(patch.excluded_types) ? patch.excluded_types : [];
    set("excluded_types_json", JSON.stringify(list.map((item) => String(item))));
  }
  if (patch.settings !== undefined) set("settings_json", JSON.stringify(patch.settings || {}));
  return { fields, params };
}

export function updateConfiguration(db, tenantId, patch = {}, actor, ip) {
  ensureConfiguration(db, tenantId);
  const { fields, params } = configurationUpdate(patch);
  if (!fields.length) return getConfiguration(db, tenantId);
  fields.push("updated_by = ?");
  params.push(actor?.id ?? null);
  fields.push("updated_at = ?");
  params.push(nowIso());
  params.push(Number(tenantId));
  run(db, `UPDATE search_configuration SET ${fields.join(", ")} WHERE tenant_id = ?`, params);
  writeAudit(db, {
    actor,
    action: "search.configuration.update",
    resourceType: "search_configuration",
    resourceId: String(tenantId),
    details: { fields: Object.keys(patch) },
    ip,
  });
  return getConfiguration(db, tenantId);
}

export async function updateConfigurationAsync(db, tenantId, patch = {}, actor, ip) {
  await ensureConfigurationAsync(db, tenantId);
  const { fields, params } = configurationUpdate(patch);
  if (!fields.length) return getConfigurationAsync(db, tenantId);
  fields.push("updated_by = ?");
  params.push(actor?.id ?? null);
  fields.push("updated_at = ?");
  params.push(nowIso());
  params.push(Number(tenantId));
  await runAsync(db, `UPDATE search_configuration SET ${fields.join(", ")} WHERE tenant_id = ?`, params);
  await writeAuditAsync(db, {
    actor,
    action: "search.configuration.update",
    resourceType: "search_configuration",
    resourceId: String(tenantId),
    details: { fields: Object.keys(patch) },
    ip,
  });
  return getConfigurationAsync(db, tenantId);
}

export { defaultConfiguration };

// ── Async twins (configuration reads) ───────────────────────────────────────

export async function ensureConfigurationAsync(db, tenantId) {
  const existing = await configRowAsync(db, tenantId);
  if (existing) return existing;
  const ts = nowIso();
  await runAsync(db, `INSERT INTO search_configuration (tenant_id, created_at, updated_at) VALUES (?, ?, ?)`, [
    Number(tenantId),
    ts,
    ts,
  ]);
  return configRowAsync(db, tenantId);
}

export async function getConfigurationAsync(db, tenantId) {
  const row = (await configRowAsync(db, tenantId)) || (await ensureConfigurationAsync(db, tenantId));
  return publicConfiguration(row);
}
