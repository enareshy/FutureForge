// Tenant-scoped Change Management configuration (mirrors
// server/services/pdm/configuration.js).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { CONFIG_DEFAULTS } from "./constants.js";
import { assertConfigurationValue } from "./validation.js";

export function getConfigRow(db, tenantId, key) {
  return queryOne(db, "SELECT * FROM change_configuration WHERE tenant_id = ? AND key = ?", [Number(tenantId), String(key)]);
}

export async function getConfigRowAsync(db, tenantId, key) {
  return queryOneAsync(db, "SELECT * FROM change_configuration WHERE tenant_id = ? AND key = ?", [Number(tenantId), String(key)]);
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

export async function getConfigAsync(db, tenantId, key) {
  const value = parseValue(await getConfigRowAsync(db, tenantId, key));
  return value === undefined || value === null ? CONFIG_DEFAULTS[key] ?? null : value;
}

function mergeConfig(rows) {
  const config = { ...CONFIG_DEFAULTS };
  for (const row of rows) {
    const value = parseValue(row);
    if (value !== undefined && value !== null) config[row.key] = value;
  }
  return config;
}

export function listConfig(db, tenantId) {
  const rows = queryAll(db, "SELECT * FROM change_configuration WHERE tenant_id = ? ORDER BY key", [Number(tenantId)]);
  return mergeConfig(rows);
}

export async function listConfigAsync(db, tenantId) {
  const rows = await queryAllAsync(db, "SELECT * FROM change_configuration WHERE tenant_id = ? ORDER BY key", [Number(tenantId)]);
  return mergeConfig(rows);
}

export function setConfig(db, tenantId, key, value, actor = null, ip = null) {
  const normalized = assertConfigurationValue(key, value);
  const ts = nowIso();
  const existing = getConfigRow(db, tenantId, key);
  if (existing) {
    run(db, "UPDATE change_configuration SET value_json = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(normalized ?? null),
      actor?.id ?? null,
      ts,
      existing.id,
    ]);
  } else {
    run(db, "INSERT INTO change_configuration (tenant_id, key, value_json, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
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
    action: "change.configuration.set",
    resourceType: "change_configuration",
    resourceId: key,
    details: { key, value: normalized },
    ip,
  });
  return normalized;
}

export async function setConfigAsync(db, tenantId, key, value, actor = null, ip = null) {
  const normalized = assertConfigurationValue(key, value);
  const ts = nowIso();
  const existing = await getConfigRowAsync(db, tenantId, key);
  if (existing) {
    await runAsync(db, "UPDATE change_configuration SET value_json = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(normalized ?? null),
      actor?.id ?? null,
      ts,
      existing.id,
    ]);
  } else {
    await runAsync(db, "INSERT INTO change_configuration (tenant_id, key, value_json, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
      Number(tenantId),
      key,
      JSON.stringify(normalized ?? null),
      actor?.id ?? null,
      ts,
      ts,
    ]);
  }
  await writeAuditAsync(db, {
    actor,
    action: "change.configuration.set",
    resourceType: "change_configuration",
    resourceId: key,
    details: { key, value: normalized },
    ip,
  });
  return normalized;
}

export function ensureChangeConfig(db, tenantId) {
  let created = 0;
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
    if (getConfigRow(db, tenantId, key)) continue;
    setConfig(db, tenantId, key, value, null, null);
    created += 1;
  }
  return { created };
}

export async function ensureChangeConfigAsync(db, tenantId) {
  let created = 0;
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
    if (await getConfigRowAsync(db, tenantId, key)) continue;
    await setConfigAsync(db, tenantId, key, value, null, null);
    created += 1;
  }
  return { created };
}
