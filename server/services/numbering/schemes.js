// Numbering scheme administration: CRUD, immutable versioning, activation
// checks and the public projection used by the API and UI.
import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { checkPatternTokens } from "./tokens.js";
import { getSchemeRow, isEffective, toSqlDate } from "./scopes.js";
import { emitSchemeEvent } from "./events.js";
import { NumberingError, NUMBERING_ERROR_CODES, schemeNotFound } from "./errors.js";
import { normalizeSchemeInput, normalizedObjectTypeCode, pick } from "./validation.js";

const VERSIONED_FIELDS = [
  "object_type_code",
  "pattern",
  "prefix",
  "suffix",
  "scope_type",
  "number_reuse_policy",
  "numbering_mode",
  "manual_policy",
  "manual_pattern",
  "manual_allowed_chars",
  "manual_min_length",
  "manual_max_length",
  "min_length",
  "max_length",
  "start_value",
  "min_value",
  "max_value",
  "increment",
  "padding",
  "reset_policy",
  "sequence_scope",
  "reservation_timeout_seconds",
  "priority",
  "effective_from",
  "effective_to",
  "organization_id",
  "plant_id",
  "site_id",
  "classification",
  "is_default",
];

export const SCHEME_DEFAULTS = Object.freeze({
  description: "",
  status: "draft",
  current_version: 1,
  pattern: "{TYPE}-{YYYY}-{SEQ}",
  prefix: "",
  suffix: "",
  scope_type: "global",
  number_reuse_policy: "never_reuse",
  numbering_mode: "automatic",
  manual_policy: "disabled",
  manual_pattern: "",
  manual_allowed_chars: "",
  manual_min_length: 0,
  manual_max_length: 0,
  min_length: 0,
  max_length: 64,
  start_value: 1,
  min_value: 1,
  max_value: 999999999999,
  increment: 1,
  padding: 6,
  reset_policy: "never",
  sequence_scope: "scheme",
  reservation_timeout_seconds: 0,
  priority: 100,
  is_default: 0,
  effective_from: null,
  effective_to: null,
  organization_id: null,
  plant_id: null,
  site_id: null,
  classification: "",
});

function configSnapshot(scheme) {
  const config = {};
  for (const field of VERSIONED_FIELDS) config[field] = scheme[field];
  return config;
}

function insertVersion(db, scheme, version, status, changeSummary, actor) {
  const ts = nowIso();
  run(
    db,
    `INSERT INTO numbering_scheme_versions
       (scheme_id, version, status, config_json, change_summary, effective_from, effective_to, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scheme.id,
      version,
      status,
      JSON.stringify(configSnapshot(scheme)),
      changeSummary || "",
      scheme.effective_from ?? null,
      scheme.effective_to ?? null,
      actor?.id ?? null,
      ts,
    ]
  );
}

function assertObjectType(db, code) {
  const objectType = queryOne(db, "SELECT * FROM numbering_object_types WHERE code = ?", [String(code).toUpperCase()]);
  if (!objectType) {
    throw new HttpError(400, `Object type ${code} is not registered`);
  }
  if (objectType.status !== "active") {
    throw new HttpError(400, `Object type ${code} is inactive`);
  }
  return objectType;
}

function assertScopeRefs(db, input) {
  const resolve = (table, id, label) => {
    if (id === undefined || id === null || id === "") return null;
    const row = queryOne(db, `SELECT id FROM ${table} WHERE id = ?`, [Number(id)]);
    if (!row) throw new HttpError(400, `Unknown ${label}: ${id}`);
    return Number(id);
  };
  resolve("organizations", input.organization_id, "organization");
  resolve("organizations", input.plant_id, "plant");
  resolve("organizations", input.site_id, "site");
}

export function publicScheme(db, row, { includeVersions = false } = {}) {
  if (!row) return null;
  const sequenceStats = queryOne(
    db,
    `SELECT COUNT(*) AS sequence_count, COALESCE(SUM(allocated_count), 0) AS allocated_count,
            MAX(current_value) AS current_value
     FROM numbering_sequences WHERE scheme_id = ?`,
    [row.id]
  );
  const out = {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    object_type: row.object_type_code,
    status: row.status,
    version: row.current_version,
    pattern: row.pattern,
    full_pattern: `${row.prefix}${row.pattern}${row.suffix}`,
    prefix: row.prefix,
    suffix: row.suffix,
    scope_type: row.scope_type,
    number_reuse_policy: row.number_reuse_policy,
    numbering_mode: row.numbering_mode,
    manual_policy: row.manual_policy,
    manual_pattern: row.manual_pattern,
    manual_allowed_chars: row.manual_allowed_chars,
    manual_min_length: row.manual_min_length,
    manual_max_length: row.manual_max_length,
    min_length: row.min_length,
    max_length: row.max_length,
    start_value: row.start_value,
    current_sequence: sequenceStats?.current_value ?? null,
    min_value: row.min_value,
    max_value: row.max_value,
    increment: row.increment,
    padding: row.padding,
    reset_policy: row.reset_policy,
    sequence_scope: row.sequence_scope,
    reservation_timeout_seconds: row.reservation_timeout_seconds,
    priority: row.priority,
    is_default: Boolean(row.is_default),
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    organization_id: row.organization_id,
    plant_id: row.plant_id,
    site_id: row.site_id,
    classification: row.classification,
    tenant_id: row.tenant_id,
    sequence_count: sequenceStats?.sequence_count ?? 0,
    allocated_count: sequenceStats?.allocated_count ?? 0,
    created_by: row.created_by,
    updated_by: row.updated_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (includeVersions) out.versions = listVersions(db, row.id);
  return out;
}

export function listVersions(db, schemeId) {
  return queryAll(
    db,
    "SELECT * FROM numbering_scheme_versions WHERE scheme_id = ? ORDER BY version DESC",
    [Number(schemeId)]
  ).map((row) => {
    let config = {};
    try {
      config = JSON.parse(row.config_json || "{}");
    } catch {
      config = {};
    }
    return {
      id: row.id,
      scheme_id: row.scheme_id,
      version: row.version,
      status: row.status,
      config,
      change_summary: row.change_summary,
      effective_from: row.effective_from,
      effective_to: row.effective_to,
      created_by: row.created_by,
      created_at: row.created_at,
    };
  });
}

export function listSchemes(db, { tenantId, objectType, status, q, scopeType, page = 1, pageSize = 25 } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (objectType) {
    clauses.push("object_type_code = ?");
    params.push(String(objectType).toUpperCase());
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  if (scopeType) {
    clauses.push("scope_type = ?");
    params.push(String(scopeType));
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(description) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM numbering_schemes ${where}`, params).c;
  const rows = queryAll(
    db,
    `SELECT * FROM numbering_schemes ${where} ORDER BY object_type_code, priority, code LIMIT ? OFFSET ?`,
    [...params, Number(pageSize), (Number(page) - 1) * Number(pageSize)]
  );
  return { items: rows.map((row) => publicScheme(db, row)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getScheme(db, ref, { includeVersions = true } = {}) {
  const row = getSchemeRow(db, ref);
  if (!row) throw schemeNotFound(ref);
  return publicScheme(db, row, { includeVersions });
}

export function createScheme(db, body = {}, actor = null, tenantId = null, ip = null) {
  const input = normalizeSchemeInput(body, { partial: false });
  const merged = { ...SCHEME_DEFAULTS, ...input };
  assertObjectType(db, merged.object_type_code);
  assertScopeRefs(db, merged);
  const existing = queryOne(
    db,
    "SELECT id FROM numbering_schemes WHERE code = ? AND COALESCE(tenant_id, 0) = COALESCE(?, 0)",
    [merged.code, tenantId]
  );
  if (existing) throw new HttpError(409, `Numbering scheme ${merged.code} already exists`);
  const ts = nowIso();
  const columns = [
    "code", "name", "object_type_code", "status", "current_version", "pattern", "prefix", "suffix", "scope_type",
    "number_reuse_policy", "numbering_mode", "manual_policy", "manual_pattern", "manual_allowed_chars",
    "manual_min_length", "manual_max_length", "min_length", "max_length", "start_value", "min_value", "max_value",
    "increment", "padding", "reset_policy", "sequence_scope", "reservation_timeout_seconds", "priority", "is_default",
    "effective_from", "effective_to", "description", "organization_id", "plant_id", "site_id", "classification",
    "tenant_id", "created_by", "updated_by", "created_at", "updated_at",
  ];
  const values = [
    merged.code, merged.name, merged.object_type_code, merged.status, merged.current_version, merged.pattern,
    merged.prefix, merged.suffix, merged.scope_type, merged.number_reuse_policy, merged.numbering_mode,
    merged.manual_policy, merged.manual_pattern, merged.manual_allowed_chars, merged.manual_min_length,
    merged.manual_max_length, merged.min_length, merged.max_length, merged.start_value, merged.min_value,
    merged.max_value, merged.increment, merged.padding, merged.reset_policy, merged.sequence_scope,
    merged.reservation_timeout_seconds, merged.priority, merged.is_default ? 1 : 0, merged.effective_from ?? null,
    merged.effective_to ?? null, merged.description ?? "", merged.organization_id ?? null, merged.plant_id ?? null,
    merged.site_id ?? null, merged.classification ?? "", tenantId ?? null, actor?.id ?? null, actor?.id ?? null, ts, ts,
  ];
  const result = run(
    db,
    `INSERT INTO numbering_schemes (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    values
  );
  const scheme = queryOne(db, "SELECT * FROM numbering_schemes WHERE id = ?", [Number(result.lastInsertRowid)]);
  insertVersion(db, scheme, scheme.current_version, scheme.status === "active" ? "active" : "draft", "Initial version", actor);
  writeAudit(db, {
    actor,
    action: "numbering.scheme.create",
    resourceType: "numbering_scheme",
    resourceId: scheme.id,
    details: { code: scheme.code, object_type: scheme.object_type_code },
    ip,
  });
  emitSchemeEvent(db, "NumberingSchemeCreated", scheme, actor);
  return publicScheme(db, scheme, { includeVersions: true });
}

export function updateScheme(db, ref, body = {}, actor = null, ip = null) {
  const row = getSchemeRow(db, ref);
  if (!row) throw schemeNotFound(ref);
  const input = normalizeSchemeInput(body, { partial: true });
  if (input.code && input.code !== row.code) {
    const dup = queryOne(
      db,
      "SELECT id FROM numbering_schemes WHERE code = ? AND id <> ? AND COALESCE(tenant_id,0) = COALESCE(?,0)",
      [input.code, row.id, row.tenant_id]
    );
    if (dup) throw new HttpError(409, `Numbering scheme ${input.code} already exists`);
  }
  if (input.object_type_code) assertObjectType(db, input.object_type_code);
  assertScopeRefs(db, input);

  const next = { ...row };
  for (const key of Object.keys(input)) {
    if (key === "change_summary" || key === "is_default") continue;
    if (input[key] !== undefined) next[key] = input[key];
  }
  const configChanged = VERSIONED_FIELDS.some((field) => {
    if (input[field] === undefined) return false;
    return String(input[field] ?? "") !== String(row[field] ?? "");
  });
  let version = row.current_version;
  if (configChanged) version += 1;
  next.current_version = version;
  next.is_default = input.is_default !== undefined ? (input.is_default ? 1 : 0) : row.is_default;
  const ts = nowIso();
  run(
    db,
    `UPDATE numbering_schemes SET
       code = ?, name = ?, description = ?, object_type_code = ?, status = ?, current_version = ?, pattern = ?, prefix = ?,
       suffix = ?, scope_type = ?, number_reuse_policy = ?, numbering_mode = ?, manual_policy = ?, manual_pattern = ?,
       manual_allowed_chars = ?, manual_min_length = ?, manual_max_length = ?, min_length = ?, max_length = ?,
       start_value = ?, min_value = ?, max_value = ?, increment = ?, padding = ?, reset_policy = ?, sequence_scope = ?,
       reservation_timeout_seconds = ?, priority = ?, is_default = ?, effective_from = ?, effective_to = ?,
       organization_id = ?, plant_id = ?, site_id = ?, classification = ?, updated_by = ?, updated_at = ?
     WHERE id = ?`,
    [
      next.code,
      next.name,
      next.description ?? "",
      next.object_type_code,
      next.status,
      version,
      next.pattern,
      next.prefix ?? "",
      next.suffix ?? "",
      next.scope_type,
      next.number_reuse_policy,
      next.numbering_mode,
      next.manual_policy,
      next.manual_pattern ?? "",
      next.manual_allowed_chars ?? "",
      next.manual_min_length ?? 0,
      next.manual_max_length ?? 0,
      next.min_length ?? 0,
      next.max_length ?? 64,
      next.start_value,
      next.min_value,
      next.max_value,
      next.increment,
      next.padding,
      next.reset_policy,
      next.sequence_scope,
      next.reservation_timeout_seconds ?? 0,
      next.priority,
      next.is_default ? 1 : 0,
      next.effective_from ?? null,
      next.effective_to ?? null,
      next.organization_id ?? null,
      next.plant_id ?? null,
      next.site_id ?? null,
      next.classification ?? "",
      actor?.id ?? null,
      ts,
      row.id,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM numbering_schemes WHERE id = ?", [row.id]);
  if (configChanged) {
    run(db, "UPDATE numbering_scheme_versions SET status = 'superseded' WHERE scheme_id = ? AND status = 'active'", [
      row.id,
    ]);
    insertVersion(
      db,
      updated,
      version,
      updated.status === "active" ? "active" : "draft",
      input.change_summary || "Configuration changed",
      actor
    );
  } else {
    run(
      db,
      "UPDATE numbering_scheme_versions SET effective_from = ?, effective_to = ?, status = ? WHERE scheme_id = ? AND version = ?",
      [
        updated.effective_from ?? null,
        updated.effective_to ?? null,
        updated.status === "active" ? "active" : "draft",
        row.id,
        version,
      ]
    );
  }
  writeAudit(db, {
    actor,
    action: "numbering.scheme.update",
    resourceType: "numbering_scheme",
    resourceId: row.id,
    details: { code: updated.code, version, config_changed: configChanged },
    ip,
  });
  emitSchemeEvent(db, "NumberingSchemeChanged", updated, actor);
  return publicScheme(db, updated, { includeVersions: true });
}

export function scopeSignature(scheme) {
  return [
    scheme.tenant_id ?? "",
    scheme.organization_id ?? "",
    scheme.plant_id ?? "",
    scheme.site_id ?? "",
    scheme.classification ?? "",
    scheme.priority ?? 100,
  ].join("::");
}

export function validateScheme(db, ref) {
  const row = typeof ref === "object" && ref !== null && ref.id ? ref : getSchemeRow(db, ref);
  if (!row) throw schemeNotFound(ref);
  const errors = [];
  const warnings = [];

  const pattern = `${row.prefix ?? ""}${row.pattern ?? ""}${row.suffix ?? ""}`;
  const tokenCheck = checkPatternTokens(db, pattern);
  if (!tokenCheck.valid) errors.push(...tokenCheck.errors);

  if (Number(row.increment) <= 0) errors.push("increment must be greater than zero");
  if (Number(row.start_value) < Number(row.min_value)) errors.push("start value cannot be below the minimum value");
  if (Number(row.start_value) > Number(row.max_value)) errors.push("start value cannot exceed the maximum value");
  if (Number(row.min_value) > Number(row.max_value)) errors.push("minimum value cannot exceed the maximum value");
  if (Number(row.padding) < 0) errors.push("padding cannot be negative");
  if (row.max_length && row.min_length && Number(row.min_length) > Number(row.max_length)) {
    errors.push("minimum length cannot exceed maximum length");
  }
  if (row.effective_from && row.effective_to && toSqlDate(row.effective_from) > toSqlDate(row.effective_to)) {
    errors.push("effective-from must be before effective-to");
  }
  if (!isEffective(row)) warnings.push("scheme is outside its effective window and will not be selected");
  const objectType = queryOne(db, "SELECT * FROM numbering_object_types WHERE code = ?", [row.object_type_code]);
  if (!objectType) errors.push(`object type ${row.object_type_code} is not registered`);
  else if (objectType.status !== "active") warnings.push(`object type ${row.object_type_code} is inactive`);

  if (row.manual_policy !== "disabled" && !row.manual_pattern) {
    warnings.push("manual numbering is enabled without a validation pattern");
  }
  if (row.number_reuse_policy !== "never_reuse") {
    warnings.push(`number reuse policy "${row.number_reuse_policy}" may reissue identifiers; confirm this is intended`);
  }

  const conflicts = queryAll(
    db,
    "SELECT * FROM numbering_schemes WHERE object_type_code = ? AND status = 'active' AND id <> ?",
    [row.object_type_code, row.id]
  ).filter((other) => scopeSignature(other) === scopeSignature(row));
  if (conflicts.length && row.status === "active") {
    errors.push(`conflicting active scheme(s) with identical scope and priority: ${conflicts.map((c) => c.code).join(", ")}`);
  } else if (conflicts.length) {
    warnings.push(`scheme shares scope and priority with active scheme(s): ${conflicts.map((c) => c.code).join(", ")}`);
  }

  return { valid: errors.length === 0, errors, warnings, tokens: tokenCheck.tokens || [], object_type: row.object_type_code };
}

export function setSchemeStatus(db, ref, status, actor = null, ip = null) {
  const row = getSchemeRow(db, ref);
  if (!row) throw schemeNotFound(ref);
  if (!["active", "inactive", "retired", "draft"].includes(status)) {
    throw new HttpError(400, "status must be draft, active, inactive or retired");
  }
  if (status === "active") {
    const check = validateScheme(db, row);
    if (!check.valid) {
      throw new NumberingError(422, "Scheme cannot be activated", NUMBERING_ERROR_CODES.SCHEME_CONFLICT, {
        errors: check.errors,
      });
    }
  }
  const ts = nowIso();
  run(db, "UPDATE numbering_schemes SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    status,
    actor?.id ?? null,
    ts,
    row.id,
  ]);
  const updated = queryOne(db, "SELECT * FROM numbering_schemes WHERE id = ?", [row.id]);
  if (status === "active") {
    run(
      db,
      "UPDATE numbering_scheme_versions SET status = 'active' WHERE scheme_id = ? AND version = ?",
      [row.id, updated.current_version]
    );
  } else if (status === "retired") {
    run(db, "UPDATE numbering_scheme_versions SET status = 'retired' WHERE scheme_id = ? AND version = ?", [
      row.id,
      updated.current_version,
    ]);
  } else if (status === "inactive") {
    run(db, "UPDATE numbering_scheme_versions SET status = 'superseded' WHERE scheme_id = ? AND status = 'active'", [row.id]);
  }
  writeAudit(db, {
    actor,
    action: `numbering.scheme.${status === "active" ? "activate" : status === "retired" ? "retire" : "status"}`,
    resourceType: "numbering_scheme",
    resourceId: row.id,
    details: { code: updated.code, status },
    ip,
  });
  emitSchemeEvent(db, status === "active" ? "NumberingSchemeActivated" : "NumberingSchemeDeactivated", updated, actor);
  return publicScheme(db, updated, { includeVersions: true });
}

export function cloneScheme(db, ref, body = {}, actor = null, tenantId = null, ip = null) {
  const row = getSchemeRow(db, ref);
  if (!row) throw schemeNotFound(ref);
  const code = pick(body, "code") || `${row.code}_COPY`;
  const name = pick(body, "name") || `${row.name} (copy)`;
  const payload = {};
  for (const field of Object.keys(SCHEME_DEFAULTS)) payload[field] = row[field];
  payload.object_type_code = row.object_type_code;
  payload.code = code;
  payload.name = name;
  payload.status = "draft";
  payload.is_default = 0;
  return createScheme(db, payload, actor, tenantId ?? row.tenant_id, ip);
}

export function deleteScheme(db, ref, actor = null, ip = null) {
  const row = getSchemeRow(db, ref);
  if (!row) throw schemeNotFound(ref);
  const used = queryOne(db, "SELECT COUNT(*) AS n FROM numbering_allocations WHERE scheme_id = ?", [row.id]);
  if (used?.n) {
    throw new NumberingError(409, "Scheme has allocated numbers; retire it instead of deleting", NUMBERING_ERROR_CODES.SCHEME_CONFLICT, {
      allocations: used.n,
    });
  }
  if (row.status === "active") {
    throw new NumberingError(409, "Active schemes cannot be deleted; deactivate or retire first", NUMBERING_ERROR_CODES.SCHEME_CONFLICT);
  }
  transaction(db, () => {
    run(db, "DELETE FROM numbering_sequences WHERE scheme_id = ? AND current_value = 0", [row.id]);
    const remaining = queryOne(db, "SELECT COUNT(*) AS n FROM numbering_sequences WHERE scheme_id = ?", [row.id]);
    if (remaining?.n) {
      throw new NumberingError(409, "Scheme sequences have history; retire the scheme instead", NUMBERING_ERROR_CODES.SCHEME_CONFLICT);
    }
    run(db, "DELETE FROM numbering_scheme_versions WHERE scheme_id = ?", [row.id]);
    run(db, "DELETE FROM numbering_schemes WHERE id = ?", [row.id]);
  });
  writeAudit(db, {
    actor,
    action: "numbering.scheme.delete",
    resourceType: "numbering_scheme",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  return { deleted: true, id: row.id, code: row.code };
}

export { VERSIONED_FIELDS, normalizedObjectTypeCode };
