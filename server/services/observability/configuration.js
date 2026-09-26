// Tenant-scoped Data Observability configuration.
//
// Every operational bound (collection interval, alert cooldown/dedup windows,
// incident creation policy, retention, notification) is data an administrator
// can change without a deployment.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { CONFIG_DEFAULTS, CONFIG_BOUNDS, DEFAULT_RETENTION_POLICIES } from "./constants.js";
import { invalidConfig } from "./errors.js";
import { stringifyJson } from "./repository.js";

const BOOLEAN_KEYS = new Set(["enabled", "auto_collect_on_seed", "auto_create_incidents", "notify_on_alerts"]);

export function getConfigRow(db, tenantId, key) {
  return queryOne(db, "SELECT * FROM observability_configuration WHERE tenant_id = ? AND key = ?", [Number(tenantId), String(key)]);
}

function parseValue(row) {
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.value_json);
    return parsed === null ? undefined : parsed;
  } catch {
    return undefined;
  }
}

export function validateConfigValue(key, value) {
  if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, key)) {
    throw invalidConfig(`Unknown observability configuration key: ${key}`);
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value !== "boolean") throw invalidConfig(`Configuration ${key} must be a boolean`);
    return value;
  }
  if (CONFIG_BOUNDS[key]) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw invalidConfig(`Configuration ${key} must be a number`);
    const { min, max } = CONFIG_BOUNDS[key];
    if (numeric < min || numeric > max) throw invalidConfig(`Configuration ${key} must be between ${min} and ${max}`);
    return numeric;
  }
  return value;
}

export function getConfig(db, tenantId, key) {
  const value = parseValue(getConfigRow(db, tenantId, key));
  return value === undefined ? CONFIG_DEFAULTS[key] ?? null : value;
}

export function getNumericConfig(db, tenantId, key) {
  const value = Number(getConfig(db, tenantId, key));
  return Number.isFinite(value) ? value : Number(CONFIG_DEFAULTS[key]);
}

export function listConfig(db, tenantId) {
  const rows = queryAll(db, "SELECT * FROM observability_configuration WHERE tenant_id = ? ORDER BY key", [Number(tenantId)]);
  const config = { ...CONFIG_DEFAULTS };
  for (const row of rows) {
    const value = parseValue(row);
    if (value !== undefined) config[row.key] = value;
  }
  return config;
}

export function setConfig(db, tenantId, key, value, actor = null, ip = null) {
  const normalized = validateConfigValue(key, value);
  const ts = nowIso();
  const existing = getConfigRow(db, tenantId, key);
  if (existing) {
    run(db, "UPDATE observability_configuration SET value_json = ?, updated_by = ?, updated_at = ? WHERE id = ?", [stringifyJson(normalized), actor?.id ?? null, ts, existing.id]);
  } else {
    run(db, "INSERT INTO observability_configuration (tenant_id, key, value_json, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
      Number(tenantId),
      key,
      stringifyJson(normalized),
      actor?.id ?? null,
      ts,
      ts,
    ]);
  }
  writeAudit(db, {
    actor_id: actor?.id ?? null,
    actor_username: actor?.username ?? null,
    action: "observability.config.update",
    resource_type: "observability_configuration",
    resource_id: key,
    details: { key, value: normalized },
    ip: ip || null,
  });
  return getConfig(db, tenantId, key);
}

export function ensureObservabilityConfig(db, tenantId) {
  let created = 0;
  for (const [key, value] of Object.entries(CONFIG_DEFAULTS)) {
    if (!getConfigRow(db, tenantId, key)) {
      run(db, "INSERT INTO observability_configuration (tenant_id, key, value_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", [
        Number(tenantId),
        key,
        stringifyJson(value),
        nowIso(),
        nowIso(),
      ]);
      created += 1;
    }
  }
  for (const policy of DEFAULT_RETENTION_POLICIES) {
    const existing = queryOne(db, "SELECT id FROM observability_retention_policies WHERE tenant_id = ? AND tier = ?", [Number(tenantId), policy.tier]);
    if (!existing) {
      run(db, "INSERT INTO observability_retention_policies (tenant_id, tier, retain_days, status, created_at, updated_at) VALUES (?, ?, ?, 'ACTIVE', ?, ?)", [
        Number(tenantId),
        policy.tier,
        policy.retain_days,
        nowIso(),
        nowIso(),
      ]);
      created += 1;
    }
  }
  return { created };
}

export function listRetentionPolicies(db, tenantId) {
  return queryAll(db, "SELECT * FROM observability_retention_policies WHERE tenant_id = ? ORDER BY tier", [Number(tenantId)]).map((row) => ({
    id: row.id,
    tier: row.tier,
    retain_days: row.retain_days,
    status: row.status,
    updated_at: row.updated_at,
  }));
}

export function setRetentionPolicy(db, tenantId, tier, retainDays, actor = null) {
  const days = Math.max(1, Math.min(3650, Number(retainDays) || 30));
  const existing = queryOne(db, "SELECT id FROM observability_retention_policies WHERE tenant_id = ? AND tier = ?", [Number(tenantId), String(tier)]);
  if (existing) {
    run(db, "UPDATE observability_retention_policies SET retain_days = ?, updated_by = ?, updated_at = ? WHERE id = ?", [days, actor?.id ?? null, nowIso(), existing.id]);
  } else {
    run(db, "INSERT INTO observability_retention_policies (tenant_id, tier, retain_days, status, updated_by, created_at, updated_at) VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)", [
      Number(tenantId),
      String(tier),
      days,
      actor?.id ?? null,
      nowIso(),
      nowIso(),
    ]);
  }
  return { tier: String(tier), retain_days: days };
}
