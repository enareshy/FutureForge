// Retention, archive, cold-storage and purge policies, plus deterministic
// policy resolution.
//
// A policy declares the scope dimensions (organization, object type, subtype,
// classification, lifecycle state, plant) and what should happen at each stage.
// Resolution is explainable: callers receive the winning policy plus the
// candidates that were considered, so an operator can see why an object matched.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { MAX_POLICY_PRIORITY, POLICY_SCOPE_TYPES, SOURCE_MODULE } from "./constants.js";
import { policyRef } from "./refs.js";
import { publicPolicy, publicPolicyVersion } from "./repository.js";
import { invalidPolicy, policyConflict, policyNotFound } from "./errors.js";
import {
  addDays,
  assertPolicyAction,
  assertPolicyScope,
  assertPolicyStatus,
  assertPositiveDays,
  assertPriority,
  assertRetentionBasis,
  assertDataTier,
  normalizeText,
  normalizeUpper,
  paginate,
  parseDate,
  toIso,
} from "./validation.js";
import { listConfig } from "./configuration.js";

export { publicPolicy, publicPolicyVersion };

const SCOPE_RANK = Object.freeze({ OBJECT: 100, OBJECT_TYPE: 80, ORGANIZATION: 60, TENANT: 40, PLATFORM: 20 });

export function getPolicyRow(db, tenantId, ref) {
  return queryOne(db, "SELECT * FROM lc_policies WHERE tenant_id = ? AND (policy_ref = ? OR code = ? OR CAST(id AS TEXT) = ?)", [
    Number(tenantId),
    String(ref),
    normalizeUpper(ref),
    String(ref),
  ]);
}

export function requirePolicy(db, tenantId, ref) {
  const row = getPolicyRow(db, tenantId, ref);
  if (!row) throw policyNotFound(ref);
  return row;
}

export function getPolicy(db, tenantId, ref) {
  return publicPolicy(requirePolicy(db, tenantId, ref));
}

function normalizePolicyInput(input = {}, existing = null) {
  const scopeType = assertPolicyScope(input.scope_type || existing?.scope_type || "TENANT");
  const objectType = normalizeText(input.object_type ?? existing?.object_type ?? "").toUpperCase();
  const objectId = normalizeText(input.object_id ?? existing?.object_id ?? "");
  const organizationId = input.organization_id ?? existing?.organization_id ?? null;
  const plantId = input.plant_id ?? existing?.plant_id ?? null;

  if (scopeType === "OBJECT_TYPE" && !objectType) throw invalidPolicy("An OBJECT_TYPE policy requires object_type");
  if (scopeType === "OBJECT" && (!objectType || !objectId)) throw invalidPolicy("An OBJECT policy requires object_type and object_id");
  if (scopeType === "ORGANIZATION" && (organizationId === null || organizationId === undefined || organizationId === "")) {
    throw invalidPolicy("An ORGANIZATION policy requires organization_id");
  }

  const effectiveFrom = input.effective_from ?? existing?.effective_from ?? null;
  const effectiveTo = input.effective_to ?? existing?.effective_to ?? null;
  if (effectiveFrom && effectiveTo && parseDate(effectiveFrom) && parseDate(effectiveTo)) {
    if (parseDate(effectiveTo).getTime() < parseDate(effectiveFrom).getTime()) {
      throw invalidPolicy("effective_to cannot precede effective_from");
    }
  }

  return {
    scope_type: scopeType,
    organization_id: organizationId === "" ? null : organizationId,
    plant_id: plantId === "" ? null : plantId,
    object_type: objectType,
    subtype: normalizeText(input.subtype ?? existing?.subtype ?? "").toUpperCase(),
    classification: normalizeText(input.classification ?? existing?.classification ?? "").toUpperCase(),
    lifecycle_state: normalizeUpper(input.lifecycle_state ?? existing?.lifecycle_state ?? ""),
    object_id: objectId,
    retention_period_days: assertPositiveDays(input.retention_period_days ?? existing?.retention_period_days ?? 0, "retention_period_days"),
    retention_basis: assertRetentionBasis(input.retention_basis || existing?.retention_basis || "LAST_MODIFIED_DATE"),
    archive_action: assertPolicyAction(input.archive_action || existing?.archive_action || "MARK_ELIGIBLE"),
    cold_storage_action: assertPolicyAction(input.cold_storage_action || existing?.cold_storage_action || "MARK_ELIGIBLE"),
    purge_action: assertPolicyAction(input.purge_action || existing?.purge_action || "MARK_ELIGIBLE"),
    archive_after_days: assertPositiveDays(input.archive_after_days ?? existing?.archive_after_days ?? 0, "archive_after_days"),
    cold_storage_after_days: assertPositiveDays(input.cold_storage_after_days ?? existing?.cold_storage_after_days ?? 0, "cold_storage_after_days"),
    purge_after_days: assertPositiveDays(input.purge_after_days ?? existing?.purge_after_days ?? 0, "purge_after_days"),
    data_tier: assertDataTier(input.data_tier || existing?.data_tier || "HOT"),
    effective_from: effectiveFrom,
    effective_to: effectiveTo,
    priority: assertPriority(input.priority ?? existing?.priority ?? 100),
    owner_user_id: input.owner_user_id ?? existing?.owner_user_id ?? null,
  };
}

export function createPolicy(db, tenantId, input = {}, actor = null, ip = null) {
  const code = normalizeUpper(input.code || input.policy_code);
  if (!/^[A-Z][A-Z0-9_.-]{1,63}$/.test(code)) throw invalidPolicy("A policy code (2-64 uppercase characters) is required");
  if (queryOne(db, "SELECT id FROM lc_policies WHERE tenant_id = ? AND code = ?", [Number(tenantId), code])) throw policyConflict(code);
  const normalized = normalizePolicyInput(input);
  const status = assertPolicyStatus(input.status || "draft");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO lc_policies (policy_ref, tenant_id, code, name, description, scope_type, organization_id, plant_id, object_type, subtype, classification, lifecycle_state, object_id,
       retention_period_days, retention_basis, archive_action, cold_storage_action, purge_action, archive_after_days, cold_storage_after_days, purge_after_days, data_tier,
       status, effective_from, effective_to, priority, owner_user_id, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      policyRef(code),
      Number(tenantId),
      code,
      normalizeText(input.name) || code,
      normalizeText(input.description),
      normalized.scope_type,
      normalized.organization_id,
      normalized.plant_id,
      normalized.object_type,
      normalized.subtype,
      normalized.classification,
      normalized.lifecycle_state,
      normalized.object_id,
      normalized.retention_period_days,
      normalized.retention_basis,
      normalized.archive_action,
      normalized.cold_storage_action,
      normalized.purge_action,
      normalized.archive_after_days,
      normalized.cold_storage_after_days,
      normalized.purge_after_days,
      normalized.data_tier,
      status,
      normalized.effective_from,
      normalized.effective_to,
      normalized.priority,
      normalized.owner_user_id,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM lc_policies WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, { actor, action: "data_lifecycle.policy.create", resourceType: "lc_policies", resourceId: code, details: { code, scope_type: normalized.scope_type }, ip });
  return publicPolicy(row);
}

function snapshotPolicyVersion(db, row, actor, changeSummary) {
  run(
    db,
    `INSERT OR REPLACE INTO lc_policy_versions (policy_id, tenant_id, version, snapshot_json, change_summary, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.tenant_id, row.version, JSON.stringify(publicPolicy(row)), normalizeText(changeSummary), actor?.id ?? null, nowIso()]
  );
}

export function updatePolicy(db, tenantId, ref, patch = {}, actor = null, ip = null) {
  const row = requirePolicy(db, tenantId, ref);
  if (patch.code !== undefined && normalizeUpper(patch.code) !== row.code) {
    throw invalidPolicy("A policy code is immutable; retire the policy and create a new one", { code: row.code });
  }
  const normalized = normalizePolicyInput(patch, row);
  snapshotPolicyVersion(db, row, actor, patch.change_summary || "policy updated");
  const nextStatus = patch.status !== undefined ? assertPolicyStatus(patch.status) : row.status;
  const ts = nowIso();
  run(
    db,
    `UPDATE lc_policies SET name = ?, description = ?, scope_type = ?, organization_id = ?, plant_id = ?, object_type = ?, subtype = ?, classification = ?, lifecycle_state = ?, object_id = ?,
       retention_period_days = ?, retention_basis = ?, archive_action = ?, cold_storage_action = ?, purge_action = ?, archive_after_days = ?, cold_storage_after_days = ?, purge_after_days = ?, data_tier = ?,
       status = ?, effective_from = ?, effective_to = ?, priority = ?, owner_user_id = ?, version = version + 1, updated_by = ?, updated_at = ?
     WHERE id = ?`,
    [
      normalizeText(patch.name ?? row.name) || row.code,
      normalizeText(patch.description ?? row.description),
      normalized.scope_type,
      normalized.organization_id,
      normalized.plant_id,
      normalized.object_type,
      normalized.subtype,
      normalized.classification,
      normalized.lifecycle_state,
      normalized.object_id,
      normalized.retention_period_days,
      normalized.retention_basis,
      normalized.archive_action,
      normalized.cold_storage_action,
      normalized.purge_action,
      normalized.archive_after_days,
      normalized.cold_storage_after_days,
      normalized.purge_after_days,
      normalized.data_tier,
      nextStatus,
      normalized.effective_from,
      normalized.effective_to,
      normalized.priority,
      normalized.owner_user_id,
      actor?.id ?? null,
      ts,
      row.id,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM lc_policies WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "data_lifecycle.policy.update",
    resourceType: "lc_policies",
    resourceId: row.code,
    details: { code: row.code, version: updated.version },
    ip,
  });
  return publicPolicy(updated);
}

export function setPolicyStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = requirePolicy(db, tenantId, ref);
  const next = assertPolicyStatus(status);
  snapshotPolicyVersion(db, row, actor, `status ${row.status} -> ${next}`);
  run(db, "UPDATE lc_policies SET status = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?", [
    next,
    actor?.id ?? null,
    nowIso(),
    row.id,
  ]);
  writeAudit(db, { actor, action: "data_lifecycle.policy.status", resourceType: "lc_policies", resourceId: row.code, details: { status: next }, ip });
  return publicPolicy(queryOne(db, "SELECT * FROM lc_policies WHERE id = ?", [row.id]));
}

export function listPolicyVersions(db, tenantId, ref) {
  const row = requirePolicy(db, tenantId, ref);
  const rows = queryAll(db, "SELECT * FROM lc_policy_versions WHERE policy_id = ? ORDER BY version DESC", [row.id]);
  return { items: rows.map(publicPolicyVersion), total: rows.length };
}

export function listPolicies(db, { tenantId, status, scopeType, objectType, lifecycleState, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(assertPolicyStatus(status));
  }
  if (scopeType) {
    clauses.push("scope_type = ?");
    params.push(assertPolicyScope(scopeType));
  }
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(normalizeUpper(objectType));
  }
  if (lifecycleState) {
    clauses.push("lifecycle_state = ?");
    params.push(normalizeUpper(lifecycleState));
  }
  const term = normalizeText(q);
  if (term) {
    clauses.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${term}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM lc_policies ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM lc_policies ${where} ORDER BY priority, code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicPolicy), total, page: currentPage, page_size: limit };
}

// ── Resolution ───────────────────────────────────────────────────────────────

function policyMatches(policy, target) {
  if (policy.object_id && String(policy.object_id) !== String(target.objectId ?? "")) return false;
  if (policy.object_type && normalizeUpper(policy.object_type) !== normalizeUpper(target.objectType ?? "")) return false;
  if (policy.subtype && normalizeUpper(policy.subtype) !== normalizeUpper(target.subtype ?? "")) return false;
  if (policy.classification && normalizeUpper(policy.classification) !== normalizeUpper(target.classification ?? "")) return false;
  if (policy.lifecycle_state && normalizeUpper(policy.lifecycle_state) !== normalizeUpper(target.lifecycleState ?? "")) return false;
  if (policy.organization_id && Number(policy.organization_id) !== Number(target.organizationId ?? 0)) return false;
  if (policy.plant_id && Number(policy.plant_id) !== Number(target.plantId ?? 0)) return false;
  return true;
}

function policySpecificity(policy, target) {
  let matched = 0;
  if (policy.object_id) matched += 1;
  if (policy.object_type) matched += 1;
  if (policy.subtype) matched += 1;
  if (policy.classification) matched += 1;
  if (policy.lifecycle_state) matched += 1;
  if (policy.organization_id) matched += 1;
  if (policy.plant_id) matched += 1;
  return { matched, score: (SCOPE_RANK[policy.scope_type] || 0) + matched };
}

function withinWindow(policy, reference) {
  const ref = parseDate(reference) || new Date();
  if (policy.effective_from && parseDate(policy.effective_from) && parseDate(policy.effective_from).getTime() > ref.getTime()) return false;
  if (policy.effective_to && parseDate(policy.effective_to) && parseDate(policy.effective_to).getTime() < ref.getTime()) return false;
  return true;
}

// Deterministic resolution: most specific scope wins, then the greatest number
// of matched dimensions, then the lowest numeric priority, then the newest row.
export function resolvePolicy(db, { tenantId, objectType, objectId = null, organizationId = null, plantId = null, subtype = "", classification = "", lifecycleState = "", reference = null } = {}) {
  const target = { objectType, objectId, organizationId, plantId, subtype, classification, lifecycleState };
  const rows = queryAll(db, "SELECT * FROM lc_policies WHERE tenant_id = ? AND status = 'active'", [Number(tenantId)]);
  const candidates = [];
  for (const row of rows) {
    if (!withinWindow(row, reference || nowIso())) continue;
    if (!policyMatches(row, target)) continue;
    const { matched, score } = policySpecificity(row, target);
    candidates.push({ policy: row, matched, score });
  }
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.matched !== a.matched) return b.matched - a.matched;
    if (a.policy.priority !== b.policy.priority) return a.policy.priority - b.policy.priority;
    return b.policy.id - a.policy.id;
  });
  const winner = candidates[0]?.policy || null;
  return {
    policy: publicPolicy(winner),
    policy_id: winner?.id ?? null,
    match_score: candidates[0]?.score ?? 0,
    matched_dimensions: candidates[0]?.matched ?? 0,
    candidates: candidates.slice(0, 10).map((c) => ({
      policy_ref: c.policy.policy_ref,
      code: c.policy.code,
      scope_type: c.policy.scope_type,
      priority: c.policy.priority,
      match_score: c.score,
    })),
    source_module: SOURCE_MODULE,
    scope_types: POLICY_SCOPE_TYPES,
    max_priority: MAX_POLICY_PRIORITY,
  };
}

// Pure schedule math. `anchor` is the resolved retention anchor (an ISO date).
export function computeRetentionSchedule(anchor, policy, config = {}) {
  const anchorIso = toIso(parseDate(anchor));
  if (!anchorIso) return { retention_anchor: null, archive_eligible_at: null, cold_storage_at: null, purge_eligible_at: null };
  const base = Number(policy?.retention_period_days) > 0 ? Number(policy.retention_period_days) : Number(config.default_retention_days) || 0;
  const archiveDays = Number(policy?.archive_after_days) > 0 ? Number(policy.archive_after_days) : base;
  const coldDays = Number(policy?.cold_storage_after_days) > 0 ? Number(policy.cold_storage_after_days) : archiveDays + (Number(config.cold_storage_after_days) || 0);
  const purgeDays = Number(policy?.purge_after_days) > 0 ? Number(policy.purge_after_days) : archiveDays + (Number(config.purge_after_days) || 0);
  return {
    retention_anchor: anchorIso,
    archive_eligible_at: addDays(anchorIso, archiveDays),
    cold_storage_at: addDays(anchorIso, coldDays),
    purge_eligible_at: addDays(anchorIso, purgeDays),
  };
}

export function defaultRetentionConfig(db, tenantId) {
  const config = listConfig(db, tenantId);
  return {
    default_retention_days: config.default_retention_days,
    cold_storage_after_days: config.cold_storage_after_days,
    purge_after_days: config.purge_after_days,
  };
}
