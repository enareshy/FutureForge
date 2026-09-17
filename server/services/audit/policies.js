import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { validatePolicyInput, normalizeVisibility } from "./validation.js";

// Audit policy administration. A policy scopes audit behaviour by tenant and
// object type; lookups fall back from a tenant + object_type override, to a
// tenant wildcard, to the system wildcard, and finally to safe defaults so the
// framework always records events even before an administrator configures it.

const DEFAULT_POLICY = {
  id: null,
  tenant_id: null,
  object_type: "*",
  name: "Default",
  status: "active",
  record_success: 1,
  record_failure: 1,
  capture_reads: 0,
  capture_views: 0,
  capture_downloads: 1,
  actions: [],
  categories: [],
  track_attributes: [],
  masked_attributes: [],
  ignored_attributes: [],
  retention_days: 2555,
  visibility: "admin",
  export_allowed: 1,
  system_mandatory: 0,
};

function parseArray(raw) {
  if (raw === null || raw === undefined || raw === "") return [];
  if (Array.isArray(raw)) return raw;
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

export function publicPolicy(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id ?? null,
    object_type: row.object_type,
    name: row.name || "",
    description: row.description || "",
    status: row.status,
    record_success: !!row.record_success,
    record_failure: !!row.record_failure,
    capture_reads: !!row.capture_reads,
    capture_views: !!row.capture_views,
    capture_downloads: !!row.capture_downloads,
    actions: parseArray(row.actions_json),
    categories: parseArray(row.categories_json),
    track_attributes: parseArray(row.track_attributes_json),
    masked_attributes: parseArray(row.masked_attributes_json),
    ignored_attributes: parseArray(row.ignored_attributes_json),
    retention_days: Number(row.retention_days),
    visibility: row.visibility,
    export_allowed: row.export_allowed === undefined ? true : row.export_allowed === 1,
    system_mandatory: row.system_mandatory === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function effectiveFromRow(row) {
  const policy = publicPolicy(row);
  return {
    id: policy.id,
    tenant_id: policy.tenant_id,
    object_type: policy.object_type,
    enabled: policy.status === "active",
    record_success: policy.record_success,
    record_failure: policy.record_failure,
    capture_reads: policy.capture_reads,
    capture_views: policy.capture_views,
    capture_downloads: policy.capture_downloads,
    actions: policy.actions,
    categories: policy.categories,
    track_attributes: policy.track_attributes,
    masked_attributes: policy.masked_attributes,
    ignored_attributes: policy.ignored_attributes,
    retention_days: policy.retention_days,
    visibility: policy.visibility,
    export_allowed: policy.export_allowed,
    system_mandatory: policy.system_mandatory,
  };
}

export function defaultEffectivePolicy() {
  return {
    ...DEFAULT_POLICY,
    enabled: true,
    actions: [],
    categories: [],
    track_attributes: [],
    masked_attributes: [],
    ignored_attributes: [],
  };
}

// Resolves the effective policy for a tenant/object type. Returns the policy
// together with the scope that matched so callers can surface provenance.
export function resolvePolicy(db, tenantId, objectType) {
  const tenant = tenantId ? Number(tenantId) : null;
  const type = objectType ? String(objectType) : "*";
  const candidates = [];
  if (tenant) {
    candidates.push({ sql: "tenant_id = ? AND object_type = ?", params: [tenant, type] });
    candidates.push({ sql: "tenant_id = ? AND object_type = '*'", params: [tenant] });
  }
  candidates.push({ sql: "tenant_id IS NULL AND object_type = ?", params: [type] });
  candidates.push({ sql: "tenant_id IS NULL AND object_type = '*'", params: [] });
  for (const candidate of candidates) {
    const row = queryOne(db, `SELECT * FROM audit_policies WHERE ${candidate.sql} LIMIT 1`, candidate.params);
    if (row) return { policy: effectiveFromRow(row), scope: row.tenant_id ? "tenant" : "system", row };
  }
  return { policy: defaultEffectivePolicy(), scope: "default", row: null };
}

export function getPolicy(db, id, tenantId) {
  const row = queryOne(db, "SELECT * FROM audit_policies WHERE id = ?", [id]);
  if (!row) throw new HttpError(404, "Audit policy not found");
  if (tenantId != null && row.tenant_id != null && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Audit policy not found");
  }
  return publicPolicy(row);
}

export function getPolicyRow(db, id) {
  return queryOne(db, "SELECT * FROM audit_policies WHERE id = ?", [id]);
}

export function listPolicies(db, { tenantId, objectType, status, includeSystem = true } = {}) {
  const where = [];
  const params = [];
  if (tenantId) {
    if (includeSystem) {
      where.push("(tenant_id = ? OR tenant_id IS NULL)");
      params.push(Number(tenantId));
    } else {
      where.push("tenant_id = ?");
      params.push(Number(tenantId));
    }
  }
  if (objectType) {
    where.push("object_type = ?");
    params.push(objectType);
  }
  if (status) {
    where.push("status = ?");
    params.push(status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = queryAll(
    db,
    `SELECT * FROM audit_policies ${clause} ORDER BY COALESCE(tenant_id, 0) DESC, object_type ASC, id ASC`,
    params
  ).map(publicPolicy);
  return { items, total: items.length };
}

export function createPolicy(db, body, actor = null, tenantId = null) {
  const input = validatePolicyInput(body, { partial: false });
  const effectiveTenant =
    body.tenant_id === null || body.tenantId === null
      ? null
      : (() => {
          const raw = body.tenant_id ?? body.tenantId ?? tenantId;
          return raw === null || raw === undefined || raw === "" ? null : Number(raw);
        })();
  const existing = queryOne(
    db,
    `SELECT id FROM audit_policies WHERE COALESCE(tenant_id, 0) = COALESCE(?, 0) AND object_type = ?`,
    [effectiveTenant, input.object_type]
  );
  if (existing) throw new HttpError(409, "An audit policy already exists for this scope");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO audit_policies
      (tenant_id, object_type, name, description, status, record_success, record_failure,
       capture_reads, capture_views, capture_downloads, actions_json, categories_json,
       track_attributes_json, masked_attributes_json, ignored_attributes_json, retention_days,
       visibility, export_allowed, system_mandatory, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      effectiveTenant,
      input.object_type,
      input.name,
      input.description || "",
      input.status || "active",
      input.record_success === false ? 0 : 1,
      input.record_failure === false ? 0 : 1,
      input.capture_reads ? 1 : 0,
      input.capture_views ? 1 : 0,
      input.capture_downloads === false ? 0 : 1,
      JSON.stringify(input.actions || []),
      JSON.stringify(input.categories || []),
      JSON.stringify(input.track_attributes || []),
      JSON.stringify(input.masked_attributes || []),
      JSON.stringify(input.ignored_attributes || []),
      input.retention_days ?? 2555,
      normalizeVisibility(input.visibility || "admin"),
      input.export_allowed === false ? 0 : 1,
      body.system_mandatory ? 1 : 0,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  return getPolicy(db, result.lastInsertRowid, null);
}

export function updatePolicy(db, id, body, tenantId = null) {
  const row = getPolicyRow(db, id);
  if (!row) throw new HttpError(404, "Audit policy not found");
  if (tenantId != null && row.tenant_id != null && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Audit policy not found");
  }
  const input = validatePolicyInput(body, { partial: true });
  const next = {
    object_type: input.object_type ?? row.object_type,
    name: input.name ?? row.name,
    description: input.description ?? row.description,
    status: input.status ?? row.status,
    record_success: input.record_success === undefined ? row.record_success : input.record_success ? 1 : 0,
    record_failure: input.record_failure === undefined ? row.record_failure : input.record_failure ? 1 : 0,
    capture_reads: input.capture_reads === undefined ? row.capture_reads : input.capture_reads ? 1 : 0,
    capture_views: input.capture_views === undefined ? row.capture_views : input.capture_views ? 1 : 0,
    capture_downloads:
      input.capture_downloads === undefined ? row.capture_downloads : input.capture_downloads ? 1 : 0,
    actions_json: input.actions === undefined ? row.actions_json : JSON.stringify(input.actions),
    categories_json: input.categories === undefined ? row.categories_json : JSON.stringify(input.categories),
    track_attributes_json:
      input.track_attributes === undefined ? row.track_attributes_json : JSON.stringify(input.track_attributes),
    masked_attributes_json:
      input.masked_attributes === undefined ? row.masked_attributes_json : JSON.stringify(input.masked_attributes),
    ignored_attributes_json:
      input.ignored_attributes === undefined ? row.ignored_attributes_json : JSON.stringify(input.ignored_attributes),
    retention_days: input.retention_days ?? row.retention_days,
    visibility: input.visibility ?? row.visibility,
    export_allowed: input.export_allowed === undefined ? row.export_allowed : input.export_allowed ? 1 : 0,
  };
  if (row.system_mandatory === 1 && next.status !== "active") {
    throw new HttpError(409, "System-mandatory audit policies cannot be disabled");
  }
  if (next.object_type !== row.object_type) {
    const clash = queryOne(
      db,
      "SELECT id FROM audit_policies WHERE COALESCE(tenant_id, 0) = COALESCE(?, 0) AND object_type = ? AND id != ?",
      [row.tenant_id, next.object_type, id]
    );
    if (clash) throw new HttpError(409, "An audit policy already exists for this scope");
  }
  run(
    db,
    `UPDATE audit_policies SET
       object_type = ?, name = ?, description = ?, status = ?, record_success = ?, record_failure = ?,
       capture_reads = ?, capture_views = ?, capture_downloads = ?, actions_json = ?, categories_json = ?,
       track_attributes_json = ?, masked_attributes_json = ?, ignored_attributes_json = ?,
       retention_days = ?, visibility = ?, export_allowed = ?, updated_at = ?
     WHERE id = ?`,
    [
      next.object_type,
      next.name,
      next.description,
      next.status,
      next.record_success,
      next.record_failure,
      next.capture_reads,
      next.capture_views,
      next.capture_downloads,
      next.actions_json,
      next.categories_json,
      next.track_attributes_json,
      next.masked_attributes_json,
      next.ignored_attributes_json,
      next.retention_days,
      next.visibility,
      next.export_allowed,
      nowIso(),
      id,
    ]
  );
  return getPolicy(db, id, null);
}

export function deletePolicy(db, id, tenantId = null) {
  const row = getPolicyRow(db, id);
  if (!row) throw new HttpError(404, "Audit policy not found");
  if (tenantId != null && row.tenant_id != null && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Audit policy not found");
  }
  if (row.system_mandatory === 1) {
    throw new HttpError(409, "System-mandatory audit policies cannot be deleted");
  }
  run(db, "DELETE FROM audit_policies WHERE id = ?", [id]);
  return { ok: true, id: Number(id) };
}

// Validates a policy payload without persisting it. Returns the normalized
// policy, any warnings, and a sample of how many recent events it would match.
export function validatePolicy(db, body = {}, { id = null } = {}) {
  const input = validatePolicyInput(body, { partial: id != null });
  const warnings = [];
  if (input.capture_views === true && input.capture_reads === false) {
    warnings.push("capture_views is enabled without capture_reads; view events are recorded but read events are not.");
  }
  if (input.actions && input.actions.length && input.categories && input.categories.length) {
    warnings.push("Both actions and categories are restricted; events must satisfy both filters to be captured.");
  }
  if (input.retention_days !== undefined && Number(input.retention_days) > 3650) {
    warnings.push("retention_days exceeds 10 years; consider a dedicated retention policy instead.");
  }
  let sampleMatches = null;
  try {
    const clauses = [];
    const params = [];
    if (input.actions && input.actions.length) {
      clauses.push(`action IN (${input.actions.map(() => "?").join(", ")})`);
      params.push(...input.actions);
    }
    if (input.categories && input.categories.length) {
      clauses.push(`category IN (${input.categories.map(() => "?").join(", ")})`);
      params.push(...input.categories);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    sampleMatches = queryOne(db, `SELECT COUNT(*) AS c FROM audit_logs ${where}`, params).c;
  } catch {
    sampleMatches = null;
  }
  return { valid: true, policy: input, warnings, sample_matches: sampleMatches };
}

// Idempotently creates the system wildcard policy. Called from the seeder so
// every installation has a visible baseline configuration.
export function ensureDefaultPolicies(db) {
  const existing = queryOne(
    db,
    "SELECT id FROM audit_policies WHERE tenant_id IS NULL AND object_type = '*'"
  );
  const baseline = existing
    ? publicPolicy(getPolicyRow(db, existing.id))
    : createPolicy(
        db,
        {
          name: "System default",
          description: "Baseline policy applied to every object type unless overridden.",
          object_type: "*",
          visibility: "admin",
          capture_views: false,
          capture_downloads: true,
          retention_days: 2555,
          track_attributes: [],
          system_mandatory: true,
        },
        null,
        null
      );
  const objectPolicy = queryOne(
    db,
    "SELECT id FROM audit_policies WHERE tenant_id IS NULL AND object_type = 'object'"
  );
  if (!objectPolicy) {
    createPolicy(
      db,
      {
        name: "Business object history",
        description: "Baseline history for business objects; visible to any user who may read history.",
        object_type: "object",
        visibility: "user",
        capture_views: false,
        capture_downloads: true,
        retention_days: 2555,
        track_attributes: [],
        system_mandatory: true,
      },
      null,
      null
    );
  }
  for (const row of queryAll(db, "SELECT id FROM audit_policies WHERE tenant_id IS NULL")) {
    run(db, "UPDATE audit_policies SET system_mandatory = 1 WHERE id = ?", [row.id]);
  }
  return baseline;
}
