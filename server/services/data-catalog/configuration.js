// Tenant-scoped catalog configuration. Every bound (lineage depth, traversal
// node cap, import batch size, approval requirement) is data an administrator
// can change without a deployment.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { invalidConfiguration } from "./errors.js";
import { CONFIG_DEFAULTS } from "./constants.js";
import { assertConfigurationValue, parseJson } from "./validation.js";

export function getConfigRow(db, tenantId, key) {
  return queryOne(db, "SELECT * FROM dc_configuration WHERE tenant_id = ? AND key = ?", [Number(tenantId), String(key)]);
}

export function getConfig(db, tenantId, key) {
  const row = getConfigRow(db, tenantId, key);
  if (!row) return CONFIG_DEFAULTS[key] ?? null;
  const value = parseJson(row.value_json, null);
  return value === null || value === undefined ? CONFIG_DEFAULTS[key] ?? null : value;
}

export function listConfig(db, tenantId) {
  const rows = queryAll(db, "SELECT * FROM dc_configuration WHERE tenant_id = ? ORDER BY key", [Number(tenantId)]);
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
  assertConfigurationValue(key, value);
  const ts = nowIso();
  const existing = getConfigRow(db, tenantId, key);
  if (existing) {
    run(db, "UPDATE dc_configuration SET value_json = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(value ?? null),
      actor?.id ?? null,
      ts,
      existing.id,
    ]);
  } else {
    run(db, "INSERT INTO dc_configuration (tenant_id, key, value_json, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
      Number(tenantId),
      key,
      JSON.stringify(value ?? null),
      actor?.id ?? null,
      ts,
      ts,
    ]);
  }
  writeAudit(db, {
    actor,
    action: "data_catalog.configuration.set",
    resourceType: "dc_configuration",
    resourceId: key,
    details: { key, value },
    ip,
  });
  return value;
}
