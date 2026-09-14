import { queryAll, queryOne, run, nowIso } from "../db.js";
import { HttpError } from "../validation.js";
import { writeAudit } from "./audit.js";
import { getSetting, getSettings } from "./hierarchy.js";

export const SCOPES = ["system", "tenant", "organization"];
export const VALUE_TYPES = ["boolean", "number", "string", "json"];

export const DEFAULT_DEFINITIONS = [
  {
    key: "org.allow_multi_site",
    value_type: "boolean",
    default_value: "1",
    scopes: ["system", "tenant", "organization"],
    system_only: 0,
    feature: "organizations",
    description: "Allow a user to belong to more than one site",
  },
  {
    key: "identity.session_hours",
    value_type: "number",
    default_value: "12",
    min_value: "1",
    max_value: "168",
    scopes: ["system", "tenant"],
    system_only: 0,
    feature: "identity",
    description: "Console session lifetime in hours",
  },
  {
    key: "auth.mfa_required",
    value_type: "boolean",
    default_value: "0",
    scopes: ["system", "tenant"],
    system_only: 0,
    feature: "authentication",
    description: "Require TOTP after password or SSO for every user",
  },
  {
    key: "auth.jit_provision",
    value_type: "boolean",
    default_value: "0",
    scopes: ["system", "tenant"],
    system_only: 0,
    feature: "authentication",
    description: "Create a local user when an SSO subject is unknown",
  },
  {
    key: "auth.rate_limit_max",
    value_type: "number",
    default_value: "10",
    min_value: "3",
    max_value: "100",
    scopes: ["system"],
    system_only: 1,
    feature: "authentication",
    description: "Max login/MFA/reset attempts per window",
  },
  {
    key: "auth.rate_limit_window_seconds",
    value_type: "number",
    default_value: "60",
    min_value: "10",
    max_value: "3600",
    scopes: ["system"],
    system_only: 1,
    feature: "authentication",
    description: "Rate-limit window in seconds",
  },
  {
    key: "auth.reset_token_minutes",
    value_type: "number",
    default_value: "30",
    min_value: "5",
    max_value: "1440",
    scopes: ["system", "tenant"],
    system_only: 0,
    feature: "authentication",
    description: "Password-reset token lifetime in minutes",
  },
  {
    key: "auth.revoke_sessions_on_reset",
    value_type: "boolean",
    default_value: "1",
    scopes: ["system", "tenant"],
    system_only: 0,
    feature: "authentication",
    description: "Revoke other sessions after password reset",
  },
];

function parseScopes(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseValue(type, raw) {
  if (raw === undefined || raw === null) return null;
  const text = String(raw);
  if (type === "boolean") return text === "1" || text === "true";
  if (type === "number") {
    const n = Number(text);
    return Number.isNaN(n) ? null : n;
  }
  if (type === "json") {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  return text;
}

function stringifyValue(type, value) {
  if (type === "boolean") return value === true || value === 1 || value === "1" || value === "true" ? "1" : "0";
  if (type === "json") return typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (value === true) return "1";
  if (value === false) return "0";
  return String(value);
}

function publicDefinition(row) {
  if (!row) return null;
  return {
    ...row,
    scopes: parseScopes(row.scopes),
    default: parseValue(row.value_type, row.default_value),
  };
}

export function ensureDefinitions(db) {
  const ts = nowIso();
  for (const def of DEFAULT_DEFINITIONS) {
    run(
      db,
      `INSERT OR IGNORE INTO config_definitions
        (key, value_type, default_value, min_value, max_value, scopes, system_only, feature, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        def.key,
        def.value_type,
        def.default_value,
        def.min_value || "",
        def.max_value || "",
        JSON.stringify(def.scopes),
        def.system_only ? 1 : 0,
        def.feature,
        def.description,
        ts,
        ts,
      ]
    );
  }
}

export function listDefinitions(db) {
  ensureDefinitions(db);
  return queryAll(db, "SELECT * FROM config_definitions ORDER BY feature, key").map(publicDefinition);
}

export function getDefinition(db, key) {
  ensureDefinitions(db);
  const row = queryOne(db, "SELECT * FROM config_definitions WHERE key = ?", [key]);
  if (!row) throw new HttpError(400, `Unknown setting: ${key}`);
  return publicDefinition(row);
}

function validateRaw(def, raw) {
  const parsed = parseValue(def.value_type, raw);
  if (def.value_type === "number") {
    if (!Number.isFinite(parsed)) throw new HttpError(400, `${def.key} must be a number`);
    if (def.min_value !== "" && parsed < Number(def.min_value)) {
      throw new HttpError(400, `${def.key} must be at least ${def.min_value}`);
    }
    if (def.max_value !== "" && parsed > Number(def.max_value)) {
      throw new HttpError(400, `${def.key} must be at most ${def.max_value}`);
    }
    if (!Number.isInteger(parsed)) throw new HttpError(400, `${def.key} must be an integer`);
  }
  if (def.value_type === "json" && parsed === null && raw !== "null") {
    throw new HttpError(400, `${def.key} must be valid JSON`);
  }
  if (def.value_type === "boolean" && parsed === null) {
    throw new HttpError(400, `${def.key} must be boolean`);
  }
  return stringifyValue(def.value_type, parsed);
}

function readOverride(db, key, scope, scopeId) {
  return queryOne(
    db,
    "SELECT * FROM config_values WHERE key = ? AND scope = ? AND scope_id = ?",
    [key, scope, scopeId || 0]
  );
}

export function resolveConfig(db, key, context = {}) {
  const def = getDefinition(db, key);
  const layers = [];
  let value = parseValue(def.value_type, def.default_value);
  let source = "default";

  const systemSetting = getSetting(db, key, undefined);
  if (systemSetting !== undefined) {
    const parsed = typeof systemSetting === "string" ? parseValue(def.value_type, systemSetting) : systemSetting;
    if (parsed !== null && parsed !== undefined) {
      value = parsed;
      source = "system";
    }
  }
  layers.push({ scope: "system", scope_id: 0, value, source });

  const tenantId = Number(context.tenantId || context.tenant_id || 0) || 0;
  const orgId = Number(context.organizationId || context.organization_id || 0) || 0;

  if (tenantId && def.scopes.includes("tenant") && !def.system_only) {
    const row = readOverride(db, key, "tenant", tenantId);
    if (row) {
      const parsed = parseValue(def.value_type, row.value);
      if (parsed !== null && parsed !== undefined) {
        value = parsed;
        source = "tenant";
        layers.push({ scope: "tenant", scope_id: tenantId, value: parsed });
      }
    }
  }

  if (orgId && def.scopes.includes("organization") && !def.system_only) {
    const row = readOverride(db, key, "organization", orgId);
    if (row) {
      const parsed = parseValue(def.value_type, row.value);
      if (parsed !== null && parsed !== undefined) {
        value = parsed;
        source = "organization";
        layers.push({ scope: "organization", scope_id: orgId, value: parsed });
      }
    }
  }

  return {
    key,
    value,
    source,
    type: def.value_type,
    definition: def,
    layers,
  };
}

export function resolveAll(db, context = {}) {
  return listDefinitions(db).map((def) => {
    const resolved = resolveConfig(db, def.key, context);
    return {
      key: def.key,
      value: resolved.value,
      source: resolved.source,
      type: def.value_type,
      feature: def.feature,
      description: def.description,
      scopes: def.scopes,
      system_only: def.system_only,
    };
  });
}

export function listScopeValues(db, scope, scopeId) {
  if (!SCOPES.includes(scope)) throw new HttpError(400, "scope must be system, tenant or organization");
  const rows = queryAll(
    db,
    "SELECT * FROM config_values WHERE scope = ? AND scope_id = ? ORDER BY key",
    [scope, scopeId || 0]
  );
  return rows.map((row) => {
    const def = queryOne(db, "SELECT * FROM config_definitions WHERE key = ?", [row.key]);
    return {
      ...row,
      parsed: def ? parseValue(def.value_type, row.value) : row.value,
    };
  });
}

export function putValues(db, { scope, scopeId, values }, actor, ip) {
  ensureDefinitions(db);
  if (!SCOPES.includes(scope)) throw new HttpError(400, "scope must be system, tenant or organization");
  const patch = values || {};
  const keys = Object.keys(patch);
  if (!keys.length) throw new HttpError(400, "No settings provided");
  if (scope === "system") {
    throw new HttpError(400, "System settings use /api/platform/settings");
  }
  const ts = nowIso();
  for (const key of keys) {
    const def = getDefinition(db, key);
    if (def.system_only) throw new HttpError(400, `${key} is system-only`);
    if (!def.scopes.includes(scope)) {
      throw new HttpError(400, `${key} cannot be set at ${scope} scope`);
    }
    const raw = validateRaw(def, patch[key]);
    run(
      db,
      `INSERT INTO config_values (key, scope, scope_id, value, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key, scope, scope_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, scope, Number(scopeId) || 0, raw, ts]
    );
  }
  writeAudit(db, {
    actor,
    action: "config.update",
    resourceType: "config",
    resourceId: `${scope}:${scopeId || 0}`,
    details: { scope, scopeId: Number(scopeId) || 0, keys },
    ip,
  });
  return {
    scope,
    scope_id: Number(scopeId) || 0,
    items: listScopeValues(db, scope, scopeId),
    effective: resolveAll(db, {
      tenantId: scope === "tenant" ? scopeId : undefined,
      organizationId: scope === "organization" ? scopeId : undefined,
    }),
  };
}

export function catalogAndEffective(db, context = {}) {
  const settings = getSettings(db);
  return {
    definitions: listDefinitions(db),
    effective: resolveAll(db, context),
    system: settings.values,
  };
}
