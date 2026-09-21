// Data policies. A policy is a versioned, scoped declaration of intent (for
// example "every Material must have a valid Material Group"). Activating a
// policy publishes an immutable version snapshot so an audit can always show
// what was in force at a point in time.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { invalidPolicy, invalidStatusTransition, policyConflict, policyNotFound } from "./errors.js";
import {
  assertPolicyStatus,
  assertSeverity,
  normalizeText,
  paginate,
  parseArray,
  parseObject,
  requireCode,
} from "./validation.js";
import { policyRef, ruleRef } from "./refs.js";
import { publicPolicy, publicPolicyVersion } from "./repository.js";
import { POLICY_TRANSITIONS } from "./constants.js";
import { compileExpression } from "./expressions.js";
import { publishGovernanceEvent } from "./events.js";

export { publicPolicy, publicPolicyVersion };

export function getPolicyRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM dg_policies WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return (
    queryOne(db, "SELECT * FROM dg_policies WHERE policy_ref = ?", [String(ref)]) ||
    queryOne(db, "SELECT * FROM dg_policies WHERE code = ?", [String(ref).toUpperCase()]) ||
    null
  );
}

export function requirePolicy(db, ref) {
  const row = getPolicyRow(db, ref);
  if (!row) throw policyNotFound(ref);
  return row;
}

function snapshotOf(row) {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    object_type: row.object_type,
    domain_id: row.domain_id,
    severity: row.severity,
    attributes: parseArray(row.attributes_json, []),
    rule_set: parseArray(row.rule_set_json, []),
    status: row.status,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
  };
}

// Validates the declarative rule set of a policy. Each entry must carry a valid
// rule type and a compilable expression so a malformed policy can never be
// activated and fail at evaluation time.
function normalizeRuleSet(ruleSet, severity, domainId) {
  if (!Array.isArray(ruleSet)) throw invalidPolicy("rule_set must be an array");
  return ruleSet.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw invalidPolicy(`rule_set[${index}] must be an object`);
    const rule_type = normalizeText(entry.rule_type || entry.type).toUpperCase();
    if (!rule_type) throw invalidPolicy(`rule_set[${index}] is missing rule_type`);
    let expression;
    try {
      expression = compileExpression(rule_type, entry.expression || entry);
    } catch (error) {
      throw invalidPolicy(`rule_set[${index}] has an invalid expression: ${error.message}`);
    }
    return {
      code: normalizeText(entry.code) || `rule_${index + 1}`,
      rule_type,
      attribute_name: normalizeText(entry.attribute_name || entry.attribute),
      dimension: normalizeText(entry.dimension) || undefined,
      severity: assertSeverity(normalizeText(entry.severity || severity).toLowerCase()),
      weight: Number.isFinite(Number(entry.weight)) ? Number(entry.weight) : 1,
      expression,
      ...(entry.object_type ? { object_type: normalizeText(entry.object_type) } : {}),
      ...(entry.domain_id ? { domain_id: Number(entry.domain_id) } : domainId ? { domain_id: Number(domainId) } : {}),
    };
  });
}

export function listPolicies(db, { tenantId, domainId, objectType, status, severity, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (domainId) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(String(objectType));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(assertPolicyStatus(normalizeText(status).toLowerCase()));
  }
  if (severity) {
    clauses.push("severity = ?");
    params.push(assertSeverity(normalizeText(severity).toLowerCase()));
  }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(description) LIKE ?)");
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dg_policies ${where}`, params)?.c ?? 0);
  const rows = queryAll(db, `SELECT * FROM dg_policies ${where} ORDER BY code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map((row) => publicPolicy(row)), total, page: currentPage, page_size: limit };
}

export function getPolicy(db, ref, { includeVersions = false } = {}) {
  const row = requirePolicy(db, ref);
  const versions = includeVersions
    ? queryAll(db, "SELECT * FROM dg_policy_versions WHERE policy_id = ? ORDER BY version DESC", [row.id]).map(publicPolicyVersion)
    : null;
  return publicPolicy(row, { versions });
}

export function listPolicyVersions(db, ref) {
  const row = requirePolicy(db, ref);
  return queryAll(db, "SELECT * FROM dg_policy_versions WHERE policy_id = ? ORDER BY version DESC", [row.id]).map(publicPolicyVersion);
}

export function createPolicy(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = requireCode(input.code, "Policy code");
  const existing = queryOne(db, "SELECT id FROM dg_policies WHERE tenant_id = ? AND code = ?", [Number(tenantId), code]);
  if (existing) throw policyConflict(code);

  const severity = assertSeverity(normalizeText(input.severity || "warning").toLowerCase());
  const domainId = input.domain_id ? Number(input.domain_id) : null;
  const ruleSet = normalizeRuleSet(input.rule_set || [], severity, domainId);
  const attributes = parseArray(input.attributes, []);
  const status = assertPolicyStatus(normalizeText(input.status || "draft").toLowerCase());
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dg_policies
      (policy_ref, tenant_id, domain_id, code, name, description, object_type, severity, status,
       effective_from, effective_to, owner_user_id, steward_user_id, current_version, attributes_json, rule_set_json,
       created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
    [
      policyRef(code),
      Number(tenantId),
      domainId,
      code,
      normalizeText(input.name, code),
      normalizeText(input.description),
      normalizeText(input.object_type),
      severity,
      status,
      input.effective_from || null,
      input.effective_to || null,
      input.owner_user_id ?? null,
      input.steward_user_id ?? null,
      JSON.stringify(attributes),
      JSON.stringify(ruleSet),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const id = Number(result.lastInsertRowid);
  const row = queryOne(db, "SELECT * FROM dg_policies WHERE id = ?", [id]);
  run(
    db,
    `INSERT INTO dg_policy_versions (policy_id, tenant_id, version, status, snapshot_json, change_summary, created_by, created_at)
     VALUES (?, ?, 1, ?, ?, 'Initial version', ?, ?)`,
    [id, Number(tenantId), status, JSON.stringify(snapshotOf(row)), actor?.id ?? null, ts]
  );

  // Materialize executable rules so the quality engine has one source of truth.
  materializeRules(db, row, actor);
  writeAudit(db, {
    actor,
    action: "data_governance.policy.create",
    resourceType: "dg_policy",
    resourceId: id,
    details: { code, object_type: row.object_type, rules: ruleSet.length },
    ip,
  });
  publishGovernanceEvent(db, {
    eventType: "DataPolicyCreated",
    tenantId: Number(tenantId),
    objectType: "data_policy",
    objectId: id,
    payload: { id, code, status, rules: ruleSet.length },
  }, actor);
  return publicPolicy(row);
}

// Creates/refreshes the dg_rules rows backing a policy version so policy rules
// participate in evaluation exactly like standalone rules.
function materializeRules(db, policy, actor) {
  const ruleSet = parseArray(policy.rule_set_json, []);
  const ts = nowIso();
  ruleSet.forEach((entry, index) => {
    const code = `${policy.code}.${entry.code || index + 1}`.toUpperCase();
    const existing = queryOne(db, "SELECT id FROM dg_rules WHERE tenant_id = ? AND code = ?", [policy.tenant_id, code]);
    const payload = [
      policy.domain_id,
      policy.id,
      normalizeText(entry.name, entry.code || code),
      normalizeText(entry.description),
      normalizeText(entry.object_type || policy.object_type),
      normalizeText(entry.attribute_name),
      String(entry.rule_type).toUpperCase(),
      normalizeText(entry.dimension) || null,
      JSON.stringify(entry.expression || {}),
      entry.severity || policy.severity,
      Number.isFinite(Number(entry.weight)) ? Number(entry.weight) : 1,
      JSON.stringify(entry.threshold || {}),
      normalizeText(entry.execution_mode, "SYNC").toUpperCase(),
      ts,
    ];
    if (existing) {
      run(
        db,
        `UPDATE dg_rules SET domain_id = ?, policy_id = ?, name = ?, description = ?, object_type = ?, attribute_name = ?,
           rule_type = ?, dimension = COALESCE(?, dimension), expression_json = ?, severity = ?, weight = ?, threshold_json = ?,
           execution_mode = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
        [payload[0], payload[1], payload[2], payload[3], payload[4], payload[5], payload[6], payload[7], payload[8], payload[9], payload[10], payload[11], payload[12], actor?.id ?? null, ts, existing.id]
      );
    } else {
      run(
        db,
        `INSERT INTO dg_rules
          (rule_ref, tenant_id, domain_id, policy_id, code, name, description, object_type, attribute_name, rule_type, dimension,
           expression_json, severity, weight, threshold_json, execution_mode, status, current_version, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'validity'), ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
        [
          ruleRef(code),
          policy.tenant_id,
          payload[0],
          payload[1],
          code,
          payload[2],
          payload[3],
          payload[4],
          payload[5],
          payload[6],
          payload[7],
          payload[8],
          payload[9],
          payload[10],
          payload[11],
          payload[12],
          actor?.id ?? null,
          actor?.id ?? null,
          ts,
          ts,
        ]
      );
    }
  });
}

export function updatePolicy(db, ref, patch = {}, actor = null, ip = null) {
  const row = requirePolicy(db, ref);
  const severity = patch.severity !== undefined ? assertSeverity(normalizeText(patch.severity).toLowerCase()) : row.severity;
  const domainId = patch.domain_id !== undefined ? (patch.domain_id ? Number(patch.domain_id) : null) : row.domain_id;
  const ruleSet = patch.rule_set !== undefined ? normalizeRuleSet(patch.rule_set, severity, domainId) : parseArray(row.rule_set_json, []);
  const attributes = patch.attributes !== undefined ? parseArray(patch.attributes, []) : parseArray(row.attributes_json, []);

  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) assign("name", normalizeText(patch.name, row.code));
  if (patch.description !== undefined) assign("description", normalizeText(patch.description));
  if (patch.object_type !== undefined) assign("object_type", normalizeText(patch.object_type));
  if (patch.severity !== undefined) assign("severity", severity);
  if (patch.domain_id !== undefined) assign("domain_id", domainId);
  if (patch.effective_from !== undefined) assign("effective_from", patch.effective_from || null);
  if (patch.effective_to !== undefined) assign("effective_to", patch.effective_to || null);
  if (patch.owner_user_id !== undefined) assign("owner_user_id", patch.owner_user_id ?? null);
  if (patch.steward_user_id !== undefined) assign("steward_user_id", patch.steward_user_id ?? null);
  if (patch.rule_set !== undefined) assign("rule_set_json", JSON.stringify(ruleSet));
  if (patch.attributes !== undefined) assign("attributes_json", JSON.stringify(attributes));
  if (!changes.length) return publicPolicy(row);

  const nextVersion = Number(row.current_version) + 1;
  assign("current_version", nextVersion);
  assign("updated_by", actor?.id ?? null);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dg_policies SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  const updated = queryOne(db, "SELECT * FROM dg_policies WHERE id = ?", [row.id]);
  run(
    db,
    `INSERT INTO dg_policy_versions (policy_id, tenant_id, version, status, snapshot_json, change_summary, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.tenant_id,
      nextVersion,
      updated.status,
      JSON.stringify(snapshotOf(updated)),
      normalizeText(patch.change_summary, `Version ${nextVersion}`),
      actor?.id ?? null,
      nowIso(),
    ]
  );
  materializeRules(db, updated, actor);
  writeAudit(db, {
    actor,
    action: "data_governance.policy.update",
    resourceType: "dg_policy",
    resourceId: row.id,
    details: { code: row.code, version: nextVersion },
    ip,
  });
  publishGovernanceEvent(db, {
    eventType: "DataPolicyChanged",
    tenantId: row.tenant_id,
    objectType: "data_policy",
    objectId: row.id,
    payload: { id: row.id, code: row.code, version: nextVersion },
  }, actor);
  return publicPolicy(updated);
}

export function setPolicyStatus(db, ref, status, actor = null, ip = null) {
  const row = requirePolicy(db, ref);
  const next = assertPolicyStatus(normalizeText(status).toLowerCase());
  if (next !== row.status) {
    const allowed = POLICY_TRANSITIONS[row.status] || [];
    if (!allowed.includes(next)) throw invalidStatusTransition(row.status, next);
  }
  run(db, "UPDATE dg_policies SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [next, actor?.id ?? null, nowIso(), row.id]);
  const updated = queryOne(db, "SELECT * FROM dg_policies WHERE id = ?", [row.id]);
  run(
    db,
    `UPDATE dg_policy_versions SET status = ? WHERE policy_id = ? AND version = ?`,
    [next, row.id, updated.current_version]
  );
  // Activation/inactivation cascades to the policy's materialized rules.
  if (["active", "suspended", "retired"].includes(next)) {
    const ruleStatus = next === "active" ? "active" : next === "retired" ? "retired" : "inactive";
    run(db, "UPDATE dg_rules SET status = ?, updated_at = ? WHERE policy_id = ? AND status <> 'retired'", [ruleStatus, nowIso(), row.id]);
  }
  writeAudit(db, {
    actor,
    action: "data_governance.policy.status",
    resourceType: "dg_policy",
    resourceId: row.id,
    details: { from: row.status, to: next },
    ip,
  });
  const eventType = next === "active" ? "DataPolicyActivated" : next === "retired" ? "DataPolicyRetired" : "DataPolicyChanged";
  publishGovernanceEvent(db, {
    eventType,
    tenantId: row.tenant_id,
    objectType: "data_policy",
    objectId: row.id,
    payload: { id: row.id, code: row.code, status: next },
  }, actor);
  return publicPolicy(updated);
}

export function parsePolicyRuleSet(row) {
  return parseArray(row?.rule_set_json, []);
}

export { parseObject };
