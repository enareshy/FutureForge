// ResolutionPolicyService — configurable, deterministic resolution strategy.
//
// Precedence, boundary handling, ambiguity strategy, overlap and default
// fallback all live in policy rows so the engine never hard-codes a business
// rule. Exactly one default policy is allowed at a time.
import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { writeAudit } from "../audit.js";
import { publicPolicy, safeParse, normalizeText, validatePolicyInput, AMBIGUITY_STRATEGIES, CORE_PRECEDENCE } from "./validation.js";
import { invalidResolutionPolicy } from "./errors.js";

export function getPolicyRow(db, ref) {
  if (ref === undefined || ref === null || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref)) {
    return queryOne(db, "SELECT * FROM versioning_resolution_policies WHERE id = ?", [numeric]);
  }
  return queryOne(db, "SELECT * FROM versioning_resolution_policies WHERE code = ?", [String(ref)]);
}

export function getResolutionPolicy(db, ref) {
  const row = getPolicyRow(db, ref);
  if (!row) throw invalidResolutionPolicy(`Resolution policy not found: ${ref}`, { notFound: true });
  return publicPolicy(row);
}

export function listResolutionPolicies(db, { status, tenantId } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return queryAll(db, `SELECT * FROM versioning_resolution_policies ${where} ORDER BY is_default DESC, code`, params).map(publicPolicy);
}

export function defaultPolicyRow(db) {
  return queryOne(
    db,
    "SELECT * FROM versioning_resolution_policies WHERE is_default = 1 AND status = 'active' ORDER BY id LIMIT 1"
  );
}

export function resolvePolicy(db, ref) {
  if (ref) {
    const row = getPolicyRow(db, ref);
    if (!row) throw invalidResolutionPolicy(`Resolution policy not found: ${ref}`, { notFound: true });
    return row;
  }
  const fallback = defaultPolicyRow(db);
  if (fallback) return fallback;
  return {
    id: null,
    code: "builtin_default",
    precedence_json: JSON.stringify(CORE_PRECEDENCE),
    boundary: "inclusive",
    ambiguity_strategy: "error",
    allow_overlap: 0,
    fallback_to_default: 1,
    status: "active",
    is_default: 1,
    tenant_id: null,
  };
}

export function createResolutionPolicy(db, input = {}, actor = null, tenantId = null, ip = null) {
  validatePolicyInput(input);
  const code = normalizeText(input.code);
  if (!code) throw invalidResolutionPolicy("Resolution policy code is required");
  return transaction(db, () => {
    const existing = queryOne(db, "SELECT id FROM versioning_resolution_policies WHERE code = ?", [code]);
    if (existing) throw invalidResolutionPolicy(`Resolution policy ${code} already exists`);
    const precedence = input.precedence ?? input.precedence_json ?? CORE_PRECEDENCE;
    const makeDefault = input.isDefault === true || input.is_default === true;
    if (makeDefault) {
      run(db, "UPDATE versioning_resolution_policies SET is_default = 0, updated_at = ? WHERE is_default = 1", [nowIso()]);
    }
    const ts = nowIso();
    const result = run(
      db,
      `INSERT INTO versioning_resolution_policies
        (code, name, description, precedence_json, boundary, ambiguity_strategy, allow_overlap, fallback_to_default,
         status, is_default, tenant_id, version, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        code,
        normalizeText(input.name, code),
        normalizeText(input.description),
        JSON.stringify(Array.isArray(precedence) ? precedence : safeParse(precedence, CORE_PRECEDENCE)),
        input.boundary ?? "inclusive",
        input.ambiguityStrategy ?? input.ambiguity_strategy ?? "error",
        input.allowOverlap === true || input.allow_overlap === true ? 1 : 0,
        input.fallbackToDefault === false || input.fallback_to_default === false ? 0 : 1,
        input.status === "inactive" ? "inactive" : "active",
        makeDefault ? 1 : 0,
        input.tenantId ?? input.tenant_id ?? tenantId,
        actor?.id ?? null,
        actor?.id ?? null,
        ts,
        ts,
      ]
    );
    const id = Number(result.lastInsertRowid);
    const row = queryOne(db, "SELECT * FROM versioning_resolution_policies WHERE id = ?", [id]);
    writeAudit(db, {
      actor,
      action: "versioning.resolution_policy.create",
      resourceType: "versioning_resolution_policy",
      resourceId: id,
      details: { code, precedence: row.precedence_json },
      ip,
    });
    return publicPolicy(row);
  });
}

export function updateResolutionPolicy(db, ref, patch = {}, actor = null, ip = null) {
  const row = getPolicyRow(db, ref);
  if (!row) throw invalidResolutionPolicy(`Resolution policy not found: ${ref}`, { notFound: true });
  validatePolicyInput({ ...publicPolicy(row), ...patch }, { partial: true });
  const fields = [];
  const params = [];
  const set = (column, value) => {
    fields.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) set("name", normalizeText(patch.name));
  if (patch.description !== undefined) set("description", normalizeText(patch.description));
  if (patch.precedence !== undefined || patch.precedence_json !== undefined) {
    const precedence = patch.precedence ?? patch.precedence_json;
    set("precedence_json", JSON.stringify(Array.isArray(precedence) ? precedence : safeParse(precedence, CORE_PRECEDENCE)));
  }
  if (patch.boundary !== undefined) set("boundary", patch.boundary);
  if (patch.ambiguityStrategy !== undefined || patch.ambiguity_strategy !== undefined) {
    set("ambiguity_strategy", patch.ambiguityStrategy ?? patch.ambiguity_strategy);
  }
  if (patch.allowOverlap !== undefined || patch.allow_overlap !== undefined) {
    set("allow_overlap", patch.allowOverlap === true || patch.allow_overlap === true ? 1 : 0);
  }
  if (patch.fallbackToDefault !== undefined || patch.fallback_to_default !== undefined) {
    set("fallback_to_default", patch.fallbackToDefault === false || patch.fallback_to_default === false ? 0 : 1);
  }
  if (patch.status !== undefined) set("status", patch.status === "inactive" ? "inactive" : "active");
  if (patch.isDefault === true || patch.is_default === true) {
    run(db, "UPDATE versioning_resolution_policies SET is_default = 0, updated_at = ? WHERE is_default = 1", [nowIso()]);
    set("is_default", 1);
  } else if (patch.isDefault === false || patch.is_default === false) {
    set("is_default", 0);
  }
  if (fields.length) {
    set("updated_by", actor?.id ?? null);
    set("version", Number(row.version) + 1);
    set("updated_at", nowIso());
    run(db, `UPDATE versioning_resolution_policies SET ${fields.join(", ")} WHERE id = ?`, [...params, row.id]);
  }
  const updated = queryOne(db, "SELECT * FROM versioning_resolution_policies WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.resolution_policy.update",
    resourceType: "versioning_resolution_policy",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  return publicPolicy(updated);
}

export function deleteResolutionPolicy(db, ref, actor = null, ip = null) {
  const row = getPolicyRow(db, ref);
  if (!row) throw invalidResolutionPolicy(`Resolution policy not found: ${ref}`, { notFound: true });
  if (row.is_default) throw invalidResolutionPolicy("The default resolution policy cannot be deleted");
  run(db, "DELETE FROM versioning_resolution_policies WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "versioning.resolution_policy.delete",
    resourceType: "versioning_resolution_policy",
    resourceId: row.id,
    details: { code: row.code },
    ip,
  });
  return { deleted: true, id: row.id };
}

export { AMBIGUITY_STRATEGIES, CORE_PRECEDENCE };
