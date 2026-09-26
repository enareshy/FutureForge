// Tenant-scoped Reporting & Analytics configuration (§30).
//
// Every operational bound (row limits, execution timeout, export size,
// concurrency, cache TTL, read-model and classification enforcement) is data an
// administrator can change without a deployment.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { CONFIG_DEFAULTS, CONFIG_BOUNDS } from "./constants.js";
import { invalidQuery } from "./errors.js";

const BOOLEAN_KEYS = new Set(["enable_cache", "read_model_enabled", "enforce_classification", "allow_external_bi"]);

export function getConfigRow(db, tenantId, key) {
  return queryOne(db, "SELECT * FROM reporting_configuration WHERE tenant_id = ? AND key = ?", [Number(tenantId), String(key)]);
}

function parseValue(row) {
  if (!row) return undefined;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
}

export function validateConfigValue(key, value) {
  if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)) {
    throw invalidQuery(`Unknown reporting configuration key: ${key}`);
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value !== "boolean") throw invalidQuery(`Configuration ${key} must be a boolean`);
    return value;
  }
  if (CONFIG_BOUNDS[key]) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw invalidQuery(`Configuration ${key} must be a number`);
    const { min, max } = CONFIG_BOUNDS[key];
    if (numeric < min || numeric > max) throw invalidQuery(`Configuration ${key} must be between ${min} and ${max}`);
    return numeric;
  }
  return value;
}

export function getConfig(db, tenantId, key) {
  const value = parseValue(getConfigRow(db, tenantId, key));
  return value === undefined || value === null ? CONFIG_DEFAULTS[key] ?? null : value;
}

export function getNumericConfig(db, tenantId, key) {
  const value = Number(getConfig(db, tenantId, key));
  return Number.isFinite(value) ? value : Number(CONFIG_DEFAULTS[key]);
}

export function listConfig(db, tenantId) {
  const rows = queryAll(db, "SELECT * FROM reporting_configuration WHERE tenant_id = ? ORDER BY key", [Number(tenantId)]);
  const config = { ...CONFIG_DEFAULTS };
  for (const row of rows) {
    const value = parseValue(row);
    if (value !== undefined && value !== null) config[row.key] = value;
  }
  return config;
}

export function setConfig(db, tenantId, key, value, actor = null, ip = null) {
  const normalized = validateConfigValue(key, value);
  const ts = nowIso();
  const existing = getConfigRow(db, tenantId, key);
  if (existing) {
    run(db, "UPDATE reporting_configuration SET value_json = ?, updated_by = ?, updated_at = ? WHERE id = ?", [JSON.stringify(normalized ?? null), actor?.id ?? null, ts, existing.id]);
  } else {
    run(db, "INSERT INTO reporting_configuration (tenant_id, key, value_json, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
      Number(tenantId),
      key,
      JSON.stringify(normalized ?? null),
      actor?.id ?? null,
      ts,
      ts,
    ]);
  }
  writeAudit(db, {
    actor,
    action: "reporting.configuration.set",
    resourceType: "reporting_configuration",
    resourceId: key,
    details: { key, value: normalized },
    sourceModule: "reporting",
    ip,
  });
  return normalized;
}

export function ensureReportingConfig(db, tenantId) {
  let created = 0;
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
    if (getConfigRow(db, tenantId, key)) continue;
    setConfig(db, tenantId, key, value, null, null);
    created += 1;
  }
  return { created };
}
