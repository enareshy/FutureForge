// Data quality rules. A rule is a declarative predicate over one governed
// object type. Rules are validated (compiled) before activation, so an active
// rule can always be evaluated. A new version is snapshotted on every change.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { invalidRule, invalidStatusTransition, ruleConflict, ruleNotFound } from "./errors.js";
import {
  assertDimension,
  assertExecutionMode,
  assertRuleStatus,
  assertRuleType,
  assertSeverity,
  normalizeText,
  paginate,
  parseObject,
  requireCode,
} from "./validation.js";
import { compileExpression, defaultDimensionFor, describeExpression } from "./expressions.js";
import { ruleRef } from "./refs.js";
import { RULE_TRANSITIONS } from "./constants.js";
import { publicRule, publicRuleVersion } from "./repository.js";
import { publishGovernanceEvent } from "./events.js";

export { publicRule, publicRuleVersion };

export function getRuleRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM dg_rules WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return (
    queryOne(db, "SELECT * FROM dg_rules WHERE rule_ref = ?", [String(ref)]) ||
    queryOne(db, "SELECT * FROM dg_rules WHERE code = ?", [String(ref).toUpperCase()]) ||
    null
  );
}

export function requireRule(db, ref) {
  const row = getRuleRow(db, ref);
  if (!row) throw ruleNotFound(ref);
  return row;
}

function snapshotOf(row) {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    object_type: row.object_type,
    attribute_name: row.attribute_name,
    rule_type: row.rule_type,
    dimension: row.dimension,
    expression: parseObject(row.expression_json, {}),
    severity: row.severity,
    weight: row.weight,
    threshold: parseObject(row.threshold_json, {}),
    execution_mode: row.execution_mode,
    status: row.status,
  };
}

function compileRuleExpression(ruleType, expression) {
  return compileExpression(ruleType, expression);
}

export function validateRuleInput(input = {}) {
  const ruleType = assertRuleType(normalizeText(input.rule_type || input.type).toUpperCase());
  const dimension = input.dimension ? assertDimension(normalizeText(input.dimension).toLowerCase()) : defaultDimensionFor(ruleType);
  const severity = assertSeverity(normalizeText(input.severity || "warning").toLowerCase());
  const executionMode = assertExecutionMode(normalizeText(input.execution_mode || "SYNC").toUpperCase());
  const expression = compileRuleExpression(ruleType, input.expression || input);
  const weight = input.weight === undefined ? 1 : Number(input.weight);
  if (!Number.isFinite(weight) || weight < 0) throw invalidRule("Rule weight must be a non-negative number");
  const objectType = normalizeText(input.object_type || input.objectType).toLowerCase();
  const attributeName = normalizeText(input.attribute_name || input.attribute);
  if (!objectType && ruleType !== "CUSTOM") throw invalidRule("A rule requires object_type");
  return {
    rule_type: ruleType,
    dimension,
    severity,
    execution_mode: executionMode,
    expression,
    weight,
    object_type: objectType,
    attribute_name: attributeName,
    description: describeExpression(expression),
  };
}

export function listRules(db, { tenantId, domainId, policyId, objectType, dimension, severity, status, executionMode, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (domainId) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  if (policyId) {
    clauses.push("policy_id = ?");
    params.push(Number(policyId));
  }
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(String(objectType).toLowerCase());
  }
  if (dimension) {
    clauses.push("dimension = ?");
    params.push(assertDimension(normalizeText(dimension).toLowerCase()));
  }
  if (severity) {
    clauses.push("severity = ?");
    params.push(assertSeverity(normalizeText(severity).toLowerCase()));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(assertRuleStatus(normalizeText(status).toLowerCase()));
  }
  if (executionMode) {
    clauses.push("execution_mode = ?");
    params.push(assertExecutionMode(normalizeText(executionMode).toUpperCase()));
  }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ? OR LOWER(description) LIKE ?)");
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dg_rules ${where}`, params)?.c ?? 0);
  const rows = queryAll(db, `SELECT * FROM dg_rules ${where} ORDER BY code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map((row) => publicRule(row)), total, page: currentPage, page_size: limit };
}

export function getRule(db, ref, { includeVersions = false } = {}) {
  const row = requireRule(db, ref);
  const versions = includeVersions
    ? queryAll(db, "SELECT * FROM dg_rule_versions WHERE rule_id = ? ORDER BY version DESC", [row.id]).map(publicRuleVersion)
    : null;
  return publicRule(row, { versions });
}

export function listRuleVersions(db, ref) {
  const row = requireRule(db, ref);
  return queryAll(db, "SELECT * FROM dg_rule_versions WHERE rule_id = ? ORDER BY version DESC", [row.id]).map(publicRuleVersion);
}

export function createRule(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = requireCode(input.code, "Rule code");
  const existing = queryOne(db, "SELECT id FROM dg_rules WHERE tenant_id = ? AND code = ?", [Number(tenantId), code]);
  if (existing) throw ruleConflict(code);
  const normalized = validateRuleInput(input);
  const status = assertRuleStatus(normalizeText(input.status || "draft").toLowerCase());
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dg_rules
      (rule_ref, tenant_id, domain_id, policy_id, code, name, description, object_type, attribute_name, rule_type, dimension,
       expression_json, severity, weight, threshold_json, execution_mode, effective_from, effective_to, status,
       owner_user_id, steward_user_id, current_version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      ruleRef(code),
      Number(tenantId),
      input.domain_id ? Number(input.domain_id) : null,
      input.policy_id ? Number(input.policy_id) : null,
      code,
      normalizeText(input.name, code),
      normalizeText(input.description, normalized.description),
      normalized.object_type,
      normalized.attribute_name,
      normalized.rule_type,
      normalized.dimension,
      JSON.stringify(normalized.expression),
      normalized.severity,
      normalized.weight,
      JSON.stringify(input.threshold ?? {}),
      normalized.execution_mode,
      input.effective_from || null,
      input.effective_to || null,
      status,
      input.owner_user_id ?? null,
      input.steward_user_id ?? null,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const id = Number(result.lastInsertRowid);
  const row = queryOne(db, "SELECT * FROM dg_rules WHERE id = ?", [id]);
  run(
    db,
    `INSERT INTO dg_rule_versions (rule_id, tenant_id, version, status, snapshot_json, created_by, created_at)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
    [id, Number(tenantId), status, JSON.stringify(snapshotOf(row)), actor?.id ?? null, ts]
  );
  writeAudit(db, {
    actor,
    action: "data_quality.rule.create",
    resourceType: "dg_rule",
    resourceId: id,
    details: { code, rule_type: normalized.rule_type, object_type: normalized.object_type },
    ip,
  });
  publishGovernanceEvent(db, {
    eventType: "DataQualityRuleCreated",
    tenantId: Number(tenantId),
    objectType: normalized.object_type,
    objectId: id,
    payload: { id, code, rule_type: normalized.rule_type, status },
  }, actor);
  return publicRule(row);
}

export function updateRule(db, ref, patch = {}, actor = null, ip = null) {
  const row = requireRule(db, ref);
  const merged = {
    rule_type: patch.rule_type ?? row.rule_type,
    dimension: patch.dimension ?? row.dimension,
    severity: patch.severity ?? row.severity,
    execution_mode: patch.execution_mode ?? row.execution_mode,
    weight: patch.weight ?? row.weight,
    object_type: patch.object_type ?? row.object_type,
    attribute_name: patch.attribute_name ?? row.attribute_name,
    expression: patch.expression ?? parseObject(row.expression_json, {}),
    threshold: patch.threshold ?? parseObject(row.threshold_json, {}),
  };
  const normalized = validateRuleInput(merged);

  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) assign("name", normalizeText(patch.name, row.code));
  if (patch.description !== undefined) assign("description", normalizeText(patch.description, normalized.description));
  if (patch.domain_id !== undefined) assign("domain_id", patch.domain_id === null ? null : Number(patch.domain_id));
  if (patch.policy_id !== undefined) assign("policy_id", patch.policy_id === null ? null : Number(patch.policy_id));
  if (patch.object_type !== undefined) assign("object_type", normalized.object_type);
  if (patch.attribute_name !== undefined) assign("attribute_name", normalized.attribute_name);
  if (patch.rule_type !== undefined) assign("rule_type", normalized.rule_type);
  if (patch.dimension !== undefined) assign("dimension", normalized.dimension);
  if (patch.expression !== undefined) assign("expression_json", JSON.stringify(normalized.expression));
  if (patch.severity !== undefined) assign("severity", normalized.severity);
  if (patch.weight !== undefined) assign("weight", normalized.weight);
  if (patch.threshold !== undefined) assign("threshold_json", JSON.stringify(normalized.threshold));
  if (patch.execution_mode !== undefined) assign("execution_mode", normalized.execution_mode);
  if (patch.effective_from !== undefined) assign("effective_from", patch.effective_from || null);
  if (patch.effective_to !== undefined) assign("effective_to", patch.effective_to || null);
  if (patch.owner_user_id !== undefined) assign("owner_user_id", patch.owner_user_id ?? null);
  if (patch.steward_user_id !== undefined) assign("steward_user_id", patch.steward_user_id ?? null);
  if (!changes.length) return publicRule(row);

  const nextVersion = Number(row.current_version) + 1;
  assign("current_version", nextVersion);
  assign("updated_by", actor?.id ?? null);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dg_rules SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  const updated = queryOne(db, "SELECT * FROM dg_rules WHERE id = ?", [row.id]);
  run(
    db,
    `INSERT INTO dg_rule_versions (rule_id, tenant_id, version, status, snapshot_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.tenant_id, nextVersion, updated.status, JSON.stringify(snapshotOf(updated)), actor?.id ?? null, nowIso()]
  );
  writeAudit(db, {
    actor,
    action: "data_quality.rule.update",
    resourceType: "dg_rule",
    resourceId: row.id,
    details: { code: row.code, version: nextVersion, fields: Object.keys(patch) },
    ip,
  });
  publishGovernanceEvent(db, {
    eventType: "DataQualityRuleChanged",
    tenantId: row.tenant_id,
    objectType: updated.object_type,
    objectId: row.id,
    payload: { id: row.id, code: row.code, version: nextVersion },
  }, actor);
  return publicRule(updated);
}

export function setRuleStatus(db, ref, status, actor = null, ip = null) {
  const row = requireRule(db, ref);
  const next = assertRuleStatus(normalizeText(status).toLowerCase());
  if (next !== row.status) {
    const allowed = RULE_TRANSITIONS[row.status] || [];
    if (!allowed.includes(next)) throw invalidStatusTransition(row.status, next);
  }
  // Re-validate the expression on activation so a rule can never be activated
  // in a state the evaluator cannot run.
  if (next === "active") {
    compileExpression(row.rule_type, parseObject(row.expression_json, {}));
  }
  run(db, "UPDATE dg_rules SET status = ?, updated_by = ?, updated_at = ? WHERE id = ?", [next, actor?.id ?? null, nowIso(), row.id]);
  const updated = queryOne(db, "SELECT * FROM dg_rules WHERE id = ?", [row.id]);
  run(db, "UPDATE dg_rule_versions SET status = ? WHERE rule_id = ? AND version = ?", [next, row.id, updated.current_version]);
  writeAudit(db, {
    actor,
    action: "data_quality.rule.status",
    resourceType: "dg_rule",
    resourceId: row.id,
    details: { code: row.code, from: row.status, to: next },
    ip,
  });
  const eventType = next === "active" ? "DataQualityRuleActivated" : next === "inactive" ? "DataQualityRuleDeactivated" : "DataQualityRuleChanged";
  publishGovernanceEvent(db, {
    eventType,
    tenantId: row.tenant_id,
    objectType: updated.object_type,
    objectId: row.id,
    payload: { id: row.id, code: row.code, status: next },
  }, actor);
  return publicRule(updated);
}

// Returns the active, currently-effective rules for an object type. This is the
// single query the evaluation engine uses.
export function activeRulesForObject(db, tenantId, objectType) {
  return queryAll(
    db,
    `SELECT * FROM dg_rules
      WHERE tenant_id = ? AND object_type = ? AND status = 'active'
        AND (effective_from IS NULL OR effective_from <= datetime('now'))
        AND (effective_to IS NULL OR effective_to >= datetime('now'))
      ORDER BY code`,
    [Number(tenantId), String(objectType).toLowerCase()]
  );
}
