// Tenant-scoped configuration for the governance service. Every threshold and
// weight is data an administrator can change without a deployment: scoring
// strategy, status bands, dimension weights, exception severity floor,
// duplicate threshold and history retention.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { invalidConfiguration } from "./errors.js";
import { CONFIG_DEFAULTS } from "./constants.js";
import { parseJson, validateConfigurationValue } from "./validation.js";

export function getConfigRow(db, tenantId, key) {
  return queryOne(db, "SELECT * FROM dg_configuration WHERE tenant_id = ? AND key = ?", [Number(tenantId), String(key)]);
}

export async function getConfigRowAsync(db, tenantId, key) {
  return await queryOneAsync(db, "SELECT * FROM dg_configuration WHERE tenant_id = ? AND key = ?", [Number(tenantId), String(key)]);
}

export function getConfig(db, tenantId, key) {
  const row = getConfigRow(db, tenantId, key);
  if (!row) return CONFIG_DEFAULTS[key] ?? null;
  const value = parseJson(row.value_json, null);
  return value === null || value === undefined ? CONFIG_DEFAULTS[key] ?? null : value;
}

export async function getConfigAsync(db, tenantId, key) {
  const row = await getConfigRowAsync(db, tenantId, key);
  if (!row) return CONFIG_DEFAULTS[key] ?? null;
  const value = parseJson(row.value_json, null);
  return value === null || value === undefined ? CONFIG_DEFAULTS[key] ?? null : value;
}

export function listConfig(db, tenantId) {
  const rows = queryAll(db, "SELECT * FROM dg_configuration WHERE tenant_id = ? ORDER BY key", [Number(tenantId)]);
  const config = { ...CONFIG_DEFAULTS };
  for (const row of rows) {
    config[row.key] = parseJson(row.value_json, CONFIG_DEFAULTS[row.key] ?? null);
  }
  return config;
}

export async function listConfigAsync(db, tenantId) {
  const rows = await queryAllAsync(db, "SELECT * FROM dg_configuration WHERE tenant_id = ? ORDER BY key", [Number(tenantId)]);
  const config = { ...CONFIG_DEFAULTS };
  for (const row of rows) {
    config[row.key] = parseJson(row.value_json, CONFIG_DEFAULTS[row.key] ?? null);
  }
  return config;
}

export function setConfig(db, tenantId, key, value, actor = null, ip = null) {
  if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)) {
    throw invalidConfiguration(`Unknown configuration key: ${key}`, { key, allowed: Object.keys(CONFIG_DEFAULTS) });
  }
  validateConfigurationValue(key, value);
  const ts = nowIso();
  const existing = getConfigRow(db, tenantId, key);
  if (existing) {
    run(db, "UPDATE dg_configuration SET value_json = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(value ?? null),
      actor?.id ?? null,
      ts,
      existing.id,
    ]);
  } else {
    run(
      db,
      "INSERT INTO dg_configuration (tenant_id, key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)",
      [Number(tenantId), key, JSON.stringify(value ?? null), actor?.id ?? null, ts]
    );
  }
  writeAudit(db, {
    actor,
    action: "data_governance.configuration.set",
    resourceType: "dg_configuration",
    resourceId: key,
    details: { key, value },
    ip,
  });
  return value;
}

export async function setConfigAsync(db, tenantId, key, value, actor = null, ip = null) {
  if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)) {
    throw invalidConfiguration(`Unknown configuration key: ${key}`, { key, allowed: Object.keys(CONFIG_DEFAULTS) });
  }
  validateConfigurationValue(key, value);
  const ts = nowIso();
  const existing = await getConfigRowAsync(db, tenantId, key);
  if (existing) {
    await runAsync(db, "UPDATE dg_configuration SET value_json = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(value ?? null),
      actor?.id ?? null,
      ts,
      existing.id,
    ]);
  } else {
    await runAsync(
      db,
      "INSERT INTO dg_configuration (tenant_id, key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)",
      [Number(tenantId), key, JSON.stringify(value ?? null), actor?.id ?? null, ts]
    );
  }
  await writeAuditAsync(db, {
    actor,
    action: "data_governance.configuration.set",
    resourceType: "dg_configuration",
    resourceId: key,
    details: { key, value },
    ip,
  });
  return value;
}

export function scoringConfig(db, tenantId) {
  return {
    strategy: getConfig(db, tenantId, "scoring_strategy"),
    thresholds: getConfig(db, tenantId, "status_thresholds"),
    weights: getConfig(db, tenantId, "dimension_weights"),
  };
}

export async function scoringConfigAsync(db, tenantId) {
  return {
    strategy: await getConfigAsync(db, tenantId, "scoring_strategy"),
    thresholds: await getConfigAsync(db, tenantId, "status_thresholds"),
    weights: await getConfigAsync(db, tenantId, "dimension_weights"),
  };
}
