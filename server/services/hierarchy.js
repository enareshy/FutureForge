import { queryAll, queryOne, run, nowIso } from "../db.js";
import { HttpError, validateCode } from "../validation.js";
import { writeAudit } from "./audit.js";

export const ROOT_PARENT = "__root__";

export const DEFAULT_LEVELS = [
  { code: "tenant", name: "Tenant", sort_order: 5, allow_root: 1, collection: "tenants", system: 1 },
  { code: "enterprise", name: "Enterprise", sort_order: 10, allow_root: 0, collection: "", system: 1 },
  { code: "company", name: "Company", sort_order: 20, allow_root: 0, collection: "companies", system: 1 },
  { code: "business_unit", name: "Business unit", sort_order: 30, allow_root: 0, collection: "business-units", system: 1 },
  { code: "plant", name: "Plant", sort_order: 40, allow_root: 0, collection: "plants", system: 1 },
  { code: "site", name: "Site", sort_order: 50, allow_root: 0, collection: "sites", system: 1 },
  { code: "department", name: "Department", sort_order: 60, allow_root: 0, collection: "departments", system: 1 },
  { code: "organization", name: "Organization (legacy)", sort_order: 70, allow_root: 1, collection: "", system: 1 },
];

export const DEFAULT_PARENT_RULES = {
  tenant: [ROOT_PARENT],
  enterprise: ["tenant", ROOT_PARENT],
  company: ["enterprise", "tenant", "organization"],
  business_unit: ["company", "organization"],
  plant: ["business_unit", "company", "organization"],
  site: ["plant", "business_unit", "company", "organization"],
  department: ["site", "plant", "organization"],
  organization: [ROOT_PARENT, "tenant", "enterprise", "organization", "company", "business_unit", "plant"],
};

export const DEFAULT_SETTINGS = [
  {
    key: "org.allow_multi_site",
    value: "1",
    feature: "organizations",
    description: "Allow a user to belong to more than one site",
  },
  {
    key: "identity.session_hours",
    value: "12",
    feature: "identity",
    description: "Console session lifetime in hours",
  },
  {
    key: "auth.mfa_required",
    value: "0",
    feature: "authentication",
    description: "Require TOTP after password or SSO for every user",
  },
  {
    key: "auth.jit_provision",
    value: "0",
    feature: "authentication",
    description: "Create a local user when an SSO subject is unknown",
  },
  {
    key: "auth.rate_limit_max",
    value: "10",
    feature: "authentication",
    description: "Max login/MFA/reset attempts per window",
  },
  {
    key: "auth.rate_limit_window_seconds",
    value: "60",
    feature: "authentication",
    description: "Rate-limit window in seconds",
  },
  {
    key: "auth.reset_token_minutes",
    value: "30",
    feature: "authentication",
    description: "Password-reset token lifetime in minutes",
  },
  {
    key: "auth.revoke_sessions_on_reset",
    value: "1",
    feature: "authentication",
    description: "Revoke other sessions after password reset",
  },
];

function ensureTenantLevel(db) {
  const existing = queryOne(db, "SELECT * FROM hierarchy_levels WHERE code = ?", ["tenant"]);
  if (existing) return;
  const ts = nowIso();
  run(
    db,
    `INSERT INTO hierarchy_levels (code, name, sort_order, allow_root, collection, active, system, description, created_at, updated_at)
     VALUES ('tenant', 'Tenant', 5, 1, 'tenants', 1, 1, '', ?, ?)`,
    [ts, ts]
  );
  run(db, "INSERT OR IGNORE INTO hierarchy_parent_rules (child_code, parent_code) VALUES ('tenant', ?)", [ROOT_PARENT]);
  run(db, "INSERT OR IGNORE INTO hierarchy_parent_rules (child_code, parent_code) VALUES ('enterprise', 'tenant')");
  run(db, "INSERT OR IGNORE INTO hierarchy_parent_rules (child_code, parent_code) VALUES ('company', 'tenant')");
  run(db, "INSERT OR IGNORE INTO hierarchy_parent_rules (child_code, parent_code) VALUES ('organization', 'tenant')");
  const enterprise = queryOne(db, "SELECT allow_root FROM hierarchy_levels WHERE code = ?", ["enterprise"]);
  if (enterprise && enterprise.allow_root) {
    run(db, "UPDATE hierarchy_levels SET allow_root = 0, updated_at = ? WHERE code = 'enterprise'", [ts]);
  }
}

export function ensureHierarchy(db) {
  const count = queryOne(db, "SELECT COUNT(*) AS c FROM hierarchy_levels").c;
  if (count === 0) {
    const ts = nowIso();
    for (const level of DEFAULT_LEVELS) {
      run(
        db,
        `INSERT INTO hierarchy_levels (code, name, sort_order, allow_root, collection, active, system, description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, '', ?, ?)`,
        [level.code, level.name, level.sort_order, level.allow_root, level.collection, level.system, ts, ts]
      );
      for (const parent of DEFAULT_PARENT_RULES[level.code] || []) {
        run(
          db,
          "INSERT INTO hierarchy_parent_rules (child_code, parent_code) VALUES (?, ?)",
          [level.code, parent]
        );
      }
    }
  } else {
    ensureTenantLevel(db);
  }
  for (const setting of DEFAULT_SETTINGS) {
    run(
      db,
      `INSERT OR IGNORE INTO platform_settings (key, value, feature, description, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [setting.key, setting.value, setting.feature, setting.description, nowIso()]
    );
  }
}

function loadLevels(db, { includeInactive = false } = {}) {
  const clause = includeInactive ? "" : "WHERE active = 1";
  return queryAll(db, `SELECT * FROM hierarchy_levels ${clause} ORDER BY sort_order, name`);
}

function loadRules(db) {
  return queryAll(db, "SELECT child_code, parent_code FROM hierarchy_parent_rules ORDER BY child_code, parent_code");
}

export function getHierarchy(db, { includeInactive = false } = {}) {
  ensureHierarchy(db);
  const levels = loadLevels(db, { includeInactive });
  const rules = loadRules(db);
  const allowedParents = {};
  for (const level of levels) allowedParents[level.code] = [];
  for (const rule of rules) {
    if (!allowedParents[rule.child_code]) allowedParents[rule.child_code] = [];
    allowedParents[rule.child_code].push(rule.parent_code === ROOT_PARENT ? null : rule.parent_code);
  }
  return {
    levels,
    allowedParents,
    path: levels
      .filter((l) => l.active && l.code !== "organization")
      .map((l) => l.name)
      .join(" → "),
  };
}

export function kindCodes(db, { includeInactive = false } = {}) {
  return getHierarchy(db, { includeInactive }).levels.map((l) => l.code);
}

export function allowedParentsFor(db, kind) {
  const hierarchy = getHierarchy(db, { includeInactive: true });
  return hierarchy.allowedParents[kind] || [];
}

export function levelByCode(db, code) {
  ensureHierarchy(db);
  return queryOne(db, "SELECT * FROM hierarchy_levels WHERE code = ?", [code]);
}

export function getSettings(db) {
  ensureHierarchy(db);
  const items = queryAll(db, "SELECT * FROM platform_settings ORDER BY feature, key");
  const values = {};
  for (const item of items) values[item.key] = parseSetting(item.value);
  return { items, values };
}

export function getSetting(db, key, fallback) {
  ensureHierarchy(db);
  const row = queryOne(db, "SELECT value FROM platform_settings WHERE key = ?", [key]);
  if (!row) return fallback;
  return parseSetting(row.value);
}

function parseSetting(value) {
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  if (value !== "" && !Number.isNaN(Number(value))) return Number(value);
  return value;
}

export function updateSettings(db, body, actor, ip) {
  ensureHierarchy(db);
  const patch = body?.values || body || {};
  const keys = Object.keys(patch);
  if (!keys.length) throw new HttpError(400, "No settings provided");
  for (const key of keys) {
    const existing = queryOne(db, "SELECT * FROM platform_settings WHERE key = ?", [key]);
    if (!existing) throw new HttpError(400, `Unknown setting: ${key}`);
    const raw = stringifySetting(patch[key]);
    if (key === "identity.session_hours") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 168) {
        throw new HttpError(400, "identity.session_hours must be between 1 and 168");
      }
    }
    if (key === "auth.rate_limit_max") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 3 || n > 100) {
        throw new HttpError(400, "auth.rate_limit_max must be between 3 and 100");
      }
    }
    if (key === "auth.rate_limit_window_seconds") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 10 || n > 3600) {
        throw new HttpError(400, "auth.rate_limit_window_seconds must be between 10 and 3600");
      }
    }
    if (key === "auth.reset_token_minutes") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 5 || n > 1440) {
        throw new HttpError(400, "auth.reset_token_minutes must be between 5 and 1440");
      }
    }
    run(db, "UPDATE platform_settings SET value = ?, updated_at = ? WHERE key = ?", [raw, nowIso(), key]);
  }
  const next = getSettings(db);
  writeAudit(db, {
    actor,
    action: "platform.settings.update",
    resourceType: "platform_setting",
    resourceId: keys.join(","),
    details: patch,
    ip,
  });
  return next;
}

function stringifySetting(value) {
  if (value === true || value === 1) return "1";
  if (value === false || value === 0) return "0";
  return String(value);
}

function normalizeLevel(raw, index, seen) {
  requireCode(raw.code);
  validateCode(raw.code, "Level code");
  if (seen.has(raw.code)) throw new HttpError(400, `Duplicate level code: ${raw.code}`);
  seen.add(raw.code);
  if (!raw.name || !String(raw.name).trim()) throw new HttpError(400, "Level name is required");
  return {
    code: raw.code,
    name: String(raw.name).trim(),
    sort_order: Number(raw.sort_order ?? (index + 1) * 10),
    allow_root: raw.allow_root ? 1 : 0,
    collection: raw.collection || "",
    active: raw.active === 0 || raw.active === false ? 0 : 1,
    system: raw.system ? 1 : 0,
    description: raw.description || "",
  };
}

function requireCode(code) {
  if (!code) throw new HttpError(400, "Level code is required");
}

function normalizeRules(levels, allowedParents) {
  const codes = new Set(levels.map((l) => l.code));
  const rules = [];
  for (const level of levels) {
    const raw = allowedParents?.[level.code];
    const list = Array.isArray(raw) ? raw : [];
    const unique = [];
    for (const parent of list) {
      const token = parent === null || parent === "" || parent === ROOT_PARENT ? ROOT_PARENT : parent;
      if (token !== ROOT_PARENT && !codes.has(token)) {
        throw new HttpError(400, `Unknown parent level ${token} for ${level.code}`);
      }
      if (!unique.includes(token)) unique.push(token);
    }
    if (level.allow_root && !unique.includes(ROOT_PARENT)) unique.unshift(ROOT_PARENT);
    if (!unique.length) {
      throw new HttpError(400, `Level ${level.code} needs at least one allowed parent (use root for top level)`);
    }
    for (const parent of unique) rules.push({ child_code: level.code, parent_code: parent });
  }
  return rules;
}

function assertDefinitionSafe(db, levels) {
  const nextCodes = new Set(levels.filter((l) => l.active).map((l) => l.code));
  const used = queryAll(db, "SELECT kind, COUNT(*) AS c FROM organizations GROUP BY kind");
  for (const row of used) {
    if (!nextCodes.has(row.kind)) {
      throw new HttpError(
        409,
        `Cannot remove or deactivate level ${row.kind}: ${row.c} organization(s) still use it`
      );
    }
  }
}

export function replaceHierarchy(db, body, actor, ip) {
  ensureHierarchy(db);
  const incoming = body?.levels;
  if (!Array.isArray(incoming) || incoming.length === 0) {
    throw new HttpError(400, "levels must be a non-empty array");
  }
  const seen = new Set();
  const levels = incoming.map((item, i) => normalizeLevel(item, i, seen));
  if (!levels.some((l) => l.active && l.allow_root)) {
    throw new HttpError(400, "At least one active level must allow root");
  }
  const rules = normalizeRules(levels, body.allowedParents || {});
  assertDefinitionSafe(db, levels);
  const ts = nowIso();
  run(db, "DELETE FROM hierarchy_parent_rules");
  run(db, "DELETE FROM hierarchy_levels");
  for (const level of levels) {
    run(
      db,
      `INSERT INTO hierarchy_levels (code, name, sort_order, allow_root, collection, active, system, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        level.code,
        level.name,
        level.sort_order,
        level.allow_root,
        level.collection,
        level.active,
        level.system,
        level.description,
        ts,
        ts,
      ]
    );
  }
  for (const rule of rules) {
    run(
      db,
      "INSERT INTO hierarchy_parent_rules (child_code, parent_code) VALUES (?, ?)",
      [rule.child_code, rule.parent_code]
    );
  }
  const next = getHierarchy(db, { includeInactive: true });
  writeAudit(db, {
    actor,
    action: "platform.hierarchy.update",
    resourceType: "hierarchy",
    resourceId: "org-structure",
    details: { levels: levels.map((l) => l.code) },
    ip,
  });
  return next;
}
