// Configurable scope precedence for reference data. Resolution walks the
// precedence list and returns the most specific active value; the default
// is PLANT -> ORGANIZATION -> TENANT -> GLOBAL.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { conflict, invalidScope } from "./errors.js";
import { CONFLICT_STRATEGIES, SCOPE_TYPES, normalizeText, parseArray, toBool } from "./validation.js";
import { scopePolicyRef } from "./refs.js";
import { bumpCacheEpoch } from "./cache.js";

export const DEFAULT_PRECEDENCE = ["PLANT", "ORGANIZATION", "TENANT", "GLOBAL"];

export function publicScopePolicy(row) {
  if (!row) return null;
  return {
    id: row.id,
    policy_ref: row.policy_ref,
    code: row.code,
    name: row.name,
    description: row.description,
    precedence: parseArray(row.precedence_json, DEFAULT_PRECEDENCE),
    allow_global_fallback: Boolean(row.allow_global_fallback),
    conflict_strategy: row.conflict_strategy,
    status: row.status,
    is_default: Boolean(row.is_default),
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listScopePolicies(db, { tenantId, status } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(tenantId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = queryAll(db, `SELECT * FROM reference_scope_policies ${where} ORDER BY is_default DESC, code`, params);
  return { items: rows.map(publicScopePolicy), total: rows.length };
}

export function getScopePolicyRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM reference_scope_policies WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return (
    queryOne(db, "SELECT * FROM reference_scope_policies WHERE policy_ref = ?", [String(ref)]) ||
    queryOne(db, "SELECT * FROM reference_scope_policies WHERE code = ?", [String(ref)]) ||
    null
  );
}

export function getScopePolicy(db, ref) {
  const row = getScopePolicyRow(db, ref);
  if (!row) throw invalidScope(`Scope policy not found: ${ref}`);
  return publicScopePolicy(row);
}

function validatePrecedence(precedence) {
  const list = (precedence || []).map((entry) => String(entry).toUpperCase());
  if (!list.length) throw invalidScope("precedence must contain at least one scope type");
  for (const entry of list) {
    if (!SCOPE_TYPES.includes(entry)) throw invalidScope(`Unknown scope type in precedence: ${entry}`);
  }
  return [...new Set(list)];
}

export function createScopePolicy(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = normalizeText(input.code);
  if (!code) throw invalidScope("code is required");
  const existing = queryOne(db, "SELECT id FROM reference_scope_policies WHERE code = ? AND COALESCE(tenant_id, 0) = COALESCE(?, 0)", [code, tenantId]);
  if (existing) throw conflict(`Scope policy already exists: ${code}`, { code });
  const precedence = validatePrecedence(input.precedence);
  if (!precedence.includes("GLOBAL")) precedence.push("GLOBAL");
  const isDefault = toBool(input.is_default, false);
  if (isDefault) {
    run(db, "UPDATE reference_scope_policies SET is_default = 0 WHERE COALESCE(tenant_id, 0) = COALESCE(?, 0)", [tenantId]);
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reference_scope_policies
      (policy_ref, code, name, description, precedence_json, allow_global_fallback, conflict_strategy, status, is_default, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      scopePolicyRef(code),
      code,
      normalizeText(input.name, code),
      normalizeText(input.description),
      JSON.stringify(precedence),
      toBool(input.allow_global_fallback, true) ? 1 : 0,
      CONFLICT_STRATEGIES.includes(input.conflict_strategy) ? input.conflict_strategy : "error",
      input.status === "inactive" ? "inactive" : "active",
      isDefault ? 1 : 0,
      tenantId,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM reference_scope_policies WHERE id = ?", [Number(result.lastInsertRowid)]);
  bumpCacheEpoch(db);
  writeAudit(db, { actor, action: "reference.scope.create", resourceType: "reference_scope_policy", resourceId: row.id, details: { code }, ip });
  return publicScopePolicy(row);
}

export function updateScopePolicy(db, ref, patch = {}, actor = null, ip = null) {
  const row = getScopePolicyRow(db, ref);
  if (!row) throw invalidScope(`Scope policy not found: ${ref}`);
  const clauses = [];
  const params = [];
  const set = (column, value) => {
    clauses.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) set("name", normalizeText(patch.name, row.code));
  if (patch.description !== undefined) set("description", normalizeText(patch.description));
  if (patch.precedence !== undefined) {
    const precedence = validatePrecedence(patch.precedence);
    if (!precedence.includes("GLOBAL")) precedence.push("GLOBAL");
    set("precedence_json", JSON.stringify(precedence));
  }
  if (patch.allow_global_fallback !== undefined) set("allow_global_fallback", toBool(patch.allow_global_fallback, row.allow_global_fallback) ? 1 : 0);
  if (patch.conflict_strategy !== undefined && CONFLICT_STRATEGIES.includes(patch.conflict_strategy)) set("conflict_strategy", patch.conflict_strategy);
  if (patch.status !== undefined) set("status", patch.status === "inactive" ? "inactive" : "active");
  if (patch.is_default !== undefined) {
    const isDefault = toBool(patch.is_default, false);
    if (isDefault) run(db, "UPDATE reference_scope_policies SET is_default = 0 WHERE COALESCE(tenant_id, 0) = COALESCE(?, 0)", [row.tenant_id]);
    set("is_default", isDefault ? 1 : 0);
  }
  if (!clauses.length) return publicScopePolicy(row);
  set("updated_at", nowIso());
  params.push(row.id);
  run(db, `UPDATE reference_scope_policies SET ${clauses.join(", ")} WHERE id = ?`, params);
  bumpCacheEpoch(db);
  writeAudit(db, { actor, action: "reference.scope.update", resourceType: "reference_scope_policy", resourceId: row.id, details: { code: row.code }, ip });
  return publicScopePolicy(queryOne(db, "SELECT * FROM reference_scope_policies WHERE id = ?", [row.id]));
}

export function deleteScopePolicy(db, ref, actor = null, ip = null) {
  const row = getScopePolicyRow(db, ref);
  if (!row) throw invalidScope(`Scope policy not found: ${ref}`);
  if (row.is_default) throw conflict("The default scope policy cannot be deleted");
  run(db, "DELETE FROM reference_scope_policies WHERE id = ?", [row.id]);
  bumpCacheEpoch(db);
  writeAudit(db, { actor, action: "reference.scope.delete", resourceType: "reference_scope_policy", resourceId: row.id, details: { code: row.code }, ip });
  return { deleted: true, id: row.id };
}

export function resolvePrecedencePolicy(db, tenantId = null) {
  const row =
    queryOne(
      db,
      "SELECT * FROM reference_scope_policies WHERE status = 'active' AND COALESCE(tenant_id, 0) = COALESCE(?, 0) AND is_default = 1 ORDER BY id LIMIT 1",
      [tenantId]
    ) ||
    queryOne(db, "SELECT * FROM reference_scope_policies WHERE status = 'active' AND tenant_id IS NULL AND is_default = 1 ORDER BY id LIMIT 1", []);
  if (row) return publicScopePolicy(row);
  return {
    id: null,
    policy_ref: null,
    code: "default",
    name: "Default scope policy",
    precedence: [...DEFAULT_PRECEDENCE],
    allow_global_fallback: true,
    conflict_strategy: "highest_precedence",
    is_default: true,
  };
}
