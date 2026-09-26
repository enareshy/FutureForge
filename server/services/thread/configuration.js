// Tenant-scoped Digital Thread configuration.
//
// Every bound (traversal depth/nodes, path limits, query timeout, cache TTL,
// default definition, projection toggle, cross-domain toggle, impact depth) is
// data an administrator can change without a deployment.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { CONFIG_DEFAULTS } from "./constants.js";
import { assertConfigurationValue } from "./validation.js";
import { invalidate } from "./cache.js";

export function getConfigRow(db, tenantId, key) {
  return queryOne(db, "SELECT * FROM thread_configuration WHERE tenant_id = ? AND key = ?", [Number(tenantId), String(key)]);
}

function parseValue(row) {
  if (!row) return undefined;
  try {
    return JSON.parse(row.value_json);
  } catch {
    return null;
  }
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
  const rows = queryAll(db, "SELECT * FROM thread_configuration WHERE tenant_id = ? ORDER BY key", [Number(tenantId)]);
  const config = { ...CONFIG_DEFAULTS };
  for (const row of rows) {
    const value = parseValue(row);
    if (value !== undefined && value !== null) config[row.key] = value;
  }
  return config;
}

export function setConfig(db, tenantId, key, value, actor = null, ip = null) {
  const normalized = assertConfigurationValue(key, value);
  const ts = nowIso();
  const existing = getConfigRow(db, tenantId, key);
  if (existing) {
    run(db, "UPDATE thread_configuration SET value_json = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(normalized ?? null),
      actor?.id ?? null,
      ts,
      existing.id,
    ]);
  } else {
    run(db, "INSERT INTO thread_configuration (tenant_id, key, value_json, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
      Number(tenantId),
      key,
      JSON.stringify(normalized ?? null),
      actor?.id ?? null,
      ts,
      ts,
    ]);
  }
  invalidate(tenantId);
  writeAudit(db, {
    actor,
    action: "thread.configuration.set",
    resourceType: "thread_configuration",
    resourceId: key,
    details: { key, value: normalized },
    ip,
  });
  return normalized;
}

export function ensureThreadConfig(db, tenantId) {
  let created = 0;
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
    if (getConfigRow(db, tenantId, key)) continue;
    setConfig(db, tenantId, key, value, null, null);
    created += 1;
  }
  return { created };
}
