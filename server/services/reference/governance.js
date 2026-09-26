// Governance policies for Enterprise Reference Data Management. Governance is
// configuration, not code: approval, translation, alias, hierarchy, effective
// dating, versioning and lifecycle rules are all versioned per domain so an
// existing domain can change policy without breaking historical behaviour.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { governanceNotFound, invalidDomain } from "./errors.js";
import { CONFLICT_STRATEGIES, normalizeLanguage, normalizeText, parseObject, toBool } from "./validation.js";
import { bumpCacheEpoch } from "./cache.js";
import { emitReferenceEvent } from "./events.js";

export const DEFAULT_LIFECYCLE = ["draft", "submitted", "under_review", "approved", "active", "inactive", "retired"];
const CODE_REUSE_POLICIES = ["never_reuse", "reuse_after_retirement", "always_reuse"];

export function publicGovernance(row) {
  if (!row) return null;
  return {
    id: row.id,
    domain_id: row.domain_id,
    version: row.version,
    status: row.status,
    approval_required: Boolean(row.approval_required),
    translation_required: Boolean(row.translation_required),
    alias_enabled: Boolean(row.alias_enabled),
    hierarchy_enabled: Boolean(row.hierarchy_enabled),
    effective_dating_enabled: Boolean(row.effective_dating_enabled),
    versioning_enabled: Boolean(row.versioning_enabled),
    code_reuse_policy: row.code_reuse_policy,
    code_case_sensitive: Boolean(row.code_case_sensitive),
    code_pattern: row.code_pattern,
    default_language: row.default_language,
    lifecycle: parseObject(row.lifecycle_json, DEFAULT_LIFECYCLE),
    approval_policy: parseObject(row.approval_policy_json, {}),
    versioning_policy: parseObject(row.versioning_policy_json, {}),
    effective_date_policy: parseObject(row.effective_date_policy_json, {}),
    workflow_definition_code: row.workflow_definition_code,
    change_summary: row.change_summary,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export function defaultGovernanceShape() {
  return {
    id: null,
    domain_id: null,
    version: 0,
    status: "active",
    approval_required: false,
    translation_required: false,
    alias_enabled: true,
    hierarchy_enabled: false,
    effective_dating_enabled: true,
    versioning_enabled: true,
    code_reuse_policy: "never_reuse",
    code_case_sensitive: true,
    code_pattern: "",
    default_language: "en",
    lifecycle: [...DEFAULT_LIFECYCLE],
    approval_policy: {},
    versioning_policy: {},
    effective_date_policy: {},
    workflow_definition_code: "",
    change_summary: "",
    created_by: null,
    created_at: null,
  };
}

export function getActiveGovernancePolicy(db, domainId) {
  const row = queryOne(
    db,
    "SELECT * FROM reference_governance_policies WHERE domain_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1",
    [Number(domainId)]
  );
  return row ? publicGovernance(row) : defaultGovernanceShape();
}

export function getGovernanceVersion(db, domainId, version) {
  const row = queryOne(db, "SELECT * FROM reference_governance_policies WHERE domain_id = ? AND version = ?", [
    Number(domainId),
    Number(version),
  ]);
  return row ? publicGovernance(row) : null;
}

export function listGovernanceVersions(db, domainId) {
  return queryAll(db, "SELECT * FROM reference_governance_policies WHERE domain_id = ? ORDER BY version DESC", [Number(domainId)]).map(
    publicGovernance
  );
}

export function validateGovernanceInput(input = {}) {
  if (input.code_reuse_policy && !CODE_REUSE_POLICIES.includes(input.code_reuse_policy)) {
    throw invalidDomain(`code_reuse_policy must be one of: ${CODE_REUSE_POLICIES.join(", ")}`);
  }
  if (input.conflict_strategy && !CONFLICT_STRATEGIES.includes(input.conflict_strategy)) {
    throw invalidDomain(`Unknown conflict strategy: ${input.conflict_strategy}`);
  }
  if (input.default_language) normalizeLanguage(input.default_language);
}

export function ensureDefaultGovernance(db, domain) {
  const existing = queryOne(db, "SELECT id FROM reference_governance_policies WHERE domain_id = ? AND version = 1", [Number(domain.id)]);
  if (existing) return 0;
  const ts = nowIso();
  run(
    db,
    `INSERT INTO reference_governance_policies
      (domain_id, version, status, approval_required, translation_required, alias_enabled, hierarchy_enabled,
       effective_dating_enabled, versioning_enabled, code_reuse_policy, code_case_sensitive, code_pattern,
       default_language, lifecycle_json, approval_policy_json, versioning_policy_json, effective_date_policy_json,
       workflow_definition_code, change_summary, created_at)
     VALUES (?, 1, 'active', 0, 0, 1, ?, 1, 1, 'never_reuse', 1, '', ?, ?, '{}', '{}', '{}', '', 'Initial governance policy', ?)`,
    [Number(domain.id), 0, domain.default_language || "en", JSON.stringify(DEFAULT_LIFECYCLE), ts]
  );
  run(db, "UPDATE reference_domains SET current_governance_version = 1, updated_at = ? WHERE id = ?", [ts, Number(domain.id)]);
  return 1;
}

// Publishes a new immutable governance version. The previous active version is
// marked superseded; high-impact changes are audit-logged with before/after.
export function publishGovernanceVersion(db, domain, input = {}, actor = null, ip = null) {
  if (!domain) throw governanceNotFound(input.domainId ?? "unknown");
  validateGovernanceInput(input);
  const active = queryOne(
    db,
    "SELECT * FROM reference_governance_policies WHERE domain_id = ? AND status = 'active' ORDER BY version DESC LIMIT 1",
    [Number(domain.id)]
  );
  const current = active ? publicGovernance(active) : defaultGovernanceShape();
  const nextVersion = Number(active?.version ?? 0) + 1;
  const ts = nowIso();
  const lifecycle = Array.isArray(input.lifecycle) && input.lifecycle.length ? input.lifecycle : current.lifecycle;
  const approvalRequired = toBool(input.approval_required, current.approval_required);
  const hierarchyEnabled = toBool(input.hierarchy_enabled, current.hierarchy_enabled);
  run(
    db,
    "UPDATE reference_governance_policies SET status = 'superseded' WHERE domain_id = ? AND status = 'active'",
    [Number(domain.id)]
  );
  const result = run(
    db,
    `INSERT INTO reference_governance_policies
      (domain_id, version, status, approval_required, translation_required, alias_enabled, hierarchy_enabled,
       effective_dating_enabled, versioning_enabled, code_reuse_policy, code_case_sensitive, code_pattern,
       default_language, lifecycle_json, approval_policy_json, versioning_policy_json, effective_date_policy_json,
       workflow_definition_code, change_summary, created_by, created_at)
     VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(domain.id),
      nextVersion,
      approvalRequired ? 1 : 0,
      toBool(input.translation_required, current.translation_required) ? 1 : 0,
      toBool(input.alias_enabled, current.alias_enabled) ? 1 : 0,
      hierarchyEnabled ? 1 : 0,
      toBool(input.effective_dating_enabled, current.effective_dating_enabled) ? 1 : 0,
      toBool(input.versioning_enabled, current.versioning_enabled) ? 1 : 0,
      CODE_REUSE_POLICIES.includes(input.code_reuse_policy) ? input.code_reuse_policy : current.code_reuse_policy,
      toBool(input.code_case_sensitive, current.code_case_sensitive) ? 1 : 0,
      input.code_pattern !== undefined ? normalizeText(input.code_pattern) : current.code_pattern,
      input.default_language ? normalizeLanguage(input.default_language) : current.default_language,
      JSON.stringify(lifecycle),
      JSON.stringify(input.approval_policy ?? current.approval_policy ?? {}),
      JSON.stringify(input.versioning_policy ?? current.versioning_policy ?? {}),
      JSON.stringify(input.effective_date_policy ?? current.effective_date_policy ?? {}),
      input.workflow_definition_code !== undefined ? normalizeText(input.workflow_definition_code) : current.workflow_definition_code,
      normalizeText(input.change_summary, `Governance version ${nextVersion}`),
      actor?.id ?? null,
      ts,
    ]
  );
  run(db, "UPDATE reference_domains SET current_governance_version = ?, updated_at = ? WHERE id = ?", [
    nextVersion,
    ts,
    Number(domain.id),
  ]);
  const created = publicGovernance(queryOne(db, "SELECT * FROM reference_governance_policies WHERE id = ?", [Number(result.lastInsertRowid)]));
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.governance.publish",
    resourceType: "reference_governance_policy",
    resourceId: created.id,
    details: { domain_id: domain.id, domain_code: domain.code, version: nextVersion, change_summary: created.change_summary },
    ip,
  });
  emitReferenceEvent(
    db,
    {
      eventType: "ReferenceGovernanceChanged",
      domainId: domain.id,
      tenantId: domain.tenant_id ?? null,
      payload: { domain_code: domain.code, version: nextVersion, approval_required: created.approval_required, hierarchy_enabled: created.hierarchy_enabled },
    },
    actor
  );
  return created;
}
