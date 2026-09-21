// Data quality evaluation engine.
//
// This is the orchestration layer: it loads a governed object through its
// adapter, runs every active rule, aggregates the per-dimension pass rate into
// an overall score, persists the historical result and raises exceptions for
// failures at or above the configured severity floor. It never contains
// rule-type-specific business logic beyond the small built-in evaluator set;
// new behaviour is added by registering an evaluator or a rule type.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { evaluationFailed, invalidRule, objectNotFound } from "./errors.js";
import {
  DEFAULT_EVALUATION_LIMIT,
  MAX_BATCH_SIZE,
  SEVERITY_RANK,
} from "./constants.js";
import { evaluateExpression } from "./expressions.js";
import { readAttribute, isBlank, severityRank, valuePreview, parseObject, normalizeText } from "./validation.js";
import { activeRulesForObject } from "./rules.js";
import { findCatalogByType } from "./catalog.js";
import { computeScore } from "./dimensions.js";
import { getConfig, setConfig } from "./configuration.js";
import { loadGovernedObject, requireAdapter } from "./adapter.js";
import { publicResult, publicViolation } from "./repository.js";
import { resultRef } from "./refs.js";
import { createException } from "./exceptions.js";
import { publishGovernanceEvent } from "./events.js";
import { validateValue } from "../reference.js";

const EVALUATORS = new Map();

export function registerEvaluator(ruleType, evaluator) {
  const key = String(ruleType || "").toUpperCase();
  if (!key || typeof evaluator !== "function") throw invalidRule("An evaluator needs a rule type and a function");
  EVALUATORS.set(key, evaluator);
  return key;
}

export function listEvaluators() {
  return [...EVALUATORS.keys()];
}

function baseOutcome(rule, passed, { message, detected = "", expected = "" } = {}) {
  return {
    rule_id: rule.id,
    rule_code: rule.code,
    rule_type: rule.rule_type,
    dimension: rule.dimension,
    severity: rule.severity,
    attribute_name: rule.attribute_name,
    passed,
    message: message || (passed ? "Rule satisfied" : "Rule violated"),
    detected_value: valuePreview(detected),
    expected_value: valuePreview(expected),
  };
}

function evaluateRequired(rule, payload) {
  const attribute = rule.attribute_name || parseObject(rule.expression_json, {}).conditions?.[0]?.attribute;
  const actual = readAttribute(payload.attributes, attribute);
  const passed = !isBlank(actual);
  return baseOutcome(rule, passed, {
    message: passed ? `${attribute} is present` : `Required attribute "${attribute}" is missing`,
    detected: actual,
    expected: "non-empty",
  });
}

function evaluateUnique(db, { tenantId, objectType, objectId, adapterCode }, rule, payload) {
  const attribute = rule.attribute_name || parseObject(rule.expression_json, {}).conditions?.[0]?.attribute;
  const actual = readAttribute(payload.attributes, attribute);
  if (isBlank(actual)) {
    return baseOutcome(rule, true, { message: `${attribute} is empty; uniqueness not applicable`, expected: "unique" });
  }
  const adapter = requireAdapter(adapterCode);
  if (typeof adapter.findDuplicates !== "function") {
    return baseOutcome(rule, true, { message: "Adapter cannot evaluate uniqueness; skipped", expected: "unique" });
  }
  const duplicates = adapter.findDuplicates(db, { tenantId, objectType, attributeName: attribute, value: actual, excludeObjectId: objectId });
  const passed = duplicates.length === 0;
  return baseOutcome(rule, passed, {
    message: passed ? `${attribute} is unique` : `${attribute} duplicates ${duplicates.length} other object(s)`,
    detected: actual,
    expected: "unique",
  });
}

function evaluateReference(db, { tenantId }, rule, payload) {
  const expression = parseObject(rule.expression_json, {});
  const attribute = rule.attribute_name || expression.conditions?.[0]?.attribute;
  const actual = readAttribute(payload.attributes, attribute);
  if (isBlank(actual)) {
    return baseOutcome(rule, true, { message: `${attribute} is empty; reference not applicable`, expected: "valid reference" });
  }
  const domain = expression.params?.reference_domain || expression.reference_domain || rule.reference_domain || "";
  if (!domain) return baseOutcome(rule, true, { message: "No reference domain configured; skipped", expected: "valid reference" });
  const result = validateValue(db, { domain_code: domain, value: String(actual) }, { tenantId });
  return baseOutcome(rule, Boolean(result.valid), {
    message: result.valid ? `${attribute} resolves in ${domain}` : `${attribute} is not a valid ${domain} value (${result.reason})`,
    detected: actual,
    expected: domain,
  });
}

function evaluateGeneric(rule, payload) {
  const expression = parseObject(rule.expression_json, {});
  try {
    const outcome = evaluateExpression({ ...expression, type: rule.rule_type }, payload.attributes);
    return baseOutcome(rule, outcome.passed, {
      message: outcome.passed ? "Rule satisfied" : "Condition not met",
      detected: outcome.checks.map((check) => check.actual).join(", "),
      expected: outcome.checks.map((check) => `${check.operator} ${valuePreview(check.expected)}`).join(", "),
    });
  } catch (error) {
    throw evaluationFailed(`Rule ${rule.code} could not be evaluated: ${error.message}`, { rule_code: rule.code });
  }
}

export function evaluateRule(db, context, rule, payload) {
  const evaluator = EVALUATORS.get(String(rule.rule_type).toUpperCase());
  if (evaluator) return evaluator(db, context, rule, payload);
  switch (String(rule.rule_type).toUpperCase()) {
    case "REQUIRED":
    case "NOT_NULL":
      return evaluateRequired(rule, payload);
    case "UNIQUE":
      return evaluateUnique(db, context, rule, payload);
    case "REFERENCE":
      return evaluateReference(db, context, rule, payload);
    default:
      return evaluateGeneric(rule, payload);
  }
}

function exceptionFloor(db, tenantId) {
  const configured = getConfig(db, tenantId, "exception_min_severity");
  return severityRank(configured) || SEVERITY_RANK.warning;
}

// Evaluates one governed object. Returns the persisted result plus the rule
// level checks. Safe to call inside a transaction; all writes are local.
export function evaluateObject(
  db,
  { tenantId, objectType, objectId, actor = null, trigger = "manual", adapterCode = null, payload = null, policyId = null, persist = true, ip = null } = {}
) {
  const catalog = findCatalogByType(db, tenantId, objectType);
  const adapter = adapterCode || catalog?.source_adapter || "platform.objects";
  const domainId = catalog?.domain_id ?? null;
  const resolved =
    payload ||
    loadGovernedObject(db, { tenantId, objectType, objectId, adapterCode: adapter });
  if (!resolved) throw objectNotFound(objectType, objectId);

  let rules = activeRulesForObject(db, tenantId, objectType);
  if (policyId) rules = rules.filter((rule) => Number(rule.policy_id) === Number(policyId));

  const startedAt = Date.now();
  const checks = rules.map((rule) => evaluateRule(db, { tenantId, objectType, objectId, adapterCode: adapter, domainId }, rule, resolved));

  const dimensions = {};
  for (const check of checks) {
    const dimension = check.dimension || "validity";
    const entry = dimensions[dimension] || { total: 0, passed: 0 };
    entry.total += 1;
    if (check.passed) entry.passed += 1;
    dimensions[dimension] = entry;
  }

  const score = computeScore({ dimensions }, { db, tenantId });
  const failures = checks.filter((check) => !check.passed);
  const evaluationState = rules.length === 0 ? "NOT_EVALUATED" : failures.length ? "FAILED" : "PASSED";
  const state = {
    ...score,
    evaluation_state: evaluationState,
    object_type: resolved.object_type,
    object_id: resolved.object_id,
    object_name: resolved.object_name,
    domain_id: domainId,
    organization_id: resolved.organization_id,
    plant_id: resolved.plant_id,
    duration_ms: Date.now() - startedAt,
    checks,
    violations: failures,
  };
  if (!persist) return state;

  const persisted = persistResult(db, { tenantId, domainId, resolved, score: state, trigger, actor });
  const violations = failures.map((failure) => persistViolation(db, { tenantId, domainId, resultId: persisted.id, resolved, failure }));
  state.result = publicResult(persisted);
  state.violations = violations.map(publicViolation);

  // Exceptions are only raised when configured and the failure is at or above
  // the severity floor. Otherwise the violation is recorded without noise.
  let exceptions = [];
  if (getConfig(db, tenantId, "auto_raise_exceptions") !== false) {
    const floor = exceptionFloor(db, tenantId);
    exceptions = failures
      .filter((failure) => severityRank(failure.severity) >= floor)
      .map((failure) =>
        raiseExceptionForFailure(db, { tenantId, domainId, resolved, failure, actor, ip })
      )
      .filter(Boolean);
  }
  state.exceptions = exceptions;

  writeAudit(db, {
    actor,
    action: "data_quality.evaluate",
    resourceType: "dg_quality_result",
    resourceId: persisted.id,
    details: { object_type: resolved.object_type, object_id: resolved.object_id, score: state.overall_score, status: state.quality_status, violations: failures.length },
    ip,
  });
  publishGovernanceEvent(db, {
    eventType: "DataQualityEvaluated",
    tenantId,
    objectType: resolved.object_type,
    objectId: resolved.object_id,
    organizationId: resolved.organization_id,
    payload: {
      result_ref: persisted.result_ref,
      object_type: resolved.object_type,
      object_id: resolved.object_id,
      overall_score: state.overall_score,
      quality_status: state.quality_status,
      violation_count: failures.length,
      evaluation_state: evaluationState,
    },
  }, actor);
  for (const failure of failures) {
    publishGovernanceEvent(db, {
      eventType: "DataQualityViolationDetected",
      tenantId,
      objectType: resolved.object_type,
      objectId: resolved.object_id,
      payload: { rule_code: failure.rule_code, dimension: failure.dimension, severity: failure.severity, message: failure.message },
    }, actor);
  }
  return state;
}

function persistResult(db, { tenantId, domainId, resolved, score, trigger, actor }) {
  run(
    db,
    `UPDATE dg_quality_results SET is_current = 0, updated_at = ? WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND is_current = 1`,
    [nowIso(), Number(tenantId), resolved.object_type, String(resolved.object_id)]
  );
  const result = run(
    db,
    `INSERT INTO dg_quality_results
      (result_ref, tenant_id, organization_id, plant_id, domain_id, object_type, object_id, object_name, overall_score,
       quality_status, dimensions_json, evaluation_version, rule_count, violation_count, is_current, triggered_by, duration_ms,
       evaluated_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      resultRef(),
      Number(tenantId),
      resolved.organization_id ?? null,
      resolved.plant_id ?? null,
      domainId,
      resolved.object_type,
      String(resolved.object_id),
      resolved.object_name || "",
      score.overall_score,
      score.quality_status,
      JSON.stringify(score.dimensions || {}),
      score.rule_count,
      score.violation_count,
      normalizeText(trigger, "manual"),
      score.duration_ms,
      nowIso(),
      nowIso(),
      nowIso(),
    ]
  );
  return queryOne(db, "SELECT * FROM dg_quality_results WHERE id = ?", [Number(result.lastInsertRowid)]);
}

function persistViolation(db, { tenantId, domainId, resultId, resolved, failure }) {
  run(
    db,
    `UPDATE dg_quality_violations SET is_current = 0 WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND is_current = 1`,
    [Number(tenantId), resolved.object_type, String(resolved.object_id)]
  );
  const result = run(
    db,
    `INSERT INTO dg_quality_violations
      (tenant_id, result_id, domain_id, object_type, object_id, rule_id, rule_code, attribute_name, dimension, severity, message, detected_value, expected_value, is_current, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      Number(tenantId),
      resultId,
      domainId,
      resolved.object_type,
      String(resolved.object_id),
      failure.rule_id ?? null,
      failure.rule_code,
      failure.attribute_name || "",
      failure.dimension,
      failure.severity,
      failure.message,
      failure.detected_value,
      failure.expected_value,
      nowIso(),
    ]
  );
  return queryOne(db, "SELECT * FROM dg_quality_violations WHERE id = ?", [Number(result.lastInsertRowid)]);
}

function raiseExceptionForFailure(db, { tenantId, domainId, resolved, failure, actor, ip }) {
  try {
    return createException(
      db,
      {
        tenant_id: tenantId,
        organization_id: resolved.organization_id,
        plant_id: resolved.plant_id,
        domain_id: domainId,
        object_type: resolved.object_type,
        object_id: resolved.object_id,
        attribute_name: failure.attribute_name,
        rule_id: failure.rule_id,
        rule_code: failure.rule_code,
        dimension: failure.dimension,
        severity: failure.severity,
        description: failure.message,
        detected_value: failure.detected_value,
        expected_value: failure.expected_value,
      },
      actor,
      tenantId,
      ip
    );
  } catch (error) {
    if (String(error.code || "").includes("EXCEPTION_CONFLICT")) return null;
    throw error;
  }
}

// Lists the governed objects of a type and evaluates each. Used for batch /
// scheduled runs; the caller decides whether to persist.
export function evaluateType(
  db,
  { tenantId, objectType, objectIds = null, actor = null, trigger = "batch", persist = true, limit = DEFAULT_EVALUATION_LIMIT, offset = 0, ip = null } = {}
) {
  if (Array.isArray(objectIds) && objectIds.length > MAX_BATCH_SIZE) {
    throw evaluationFailed(`Cannot evaluate more than ${MAX_BATCH_SIZE} objects in one batch`);
  }
  const catalog = findCatalogByType(db, tenantId, objectType);
  const adapter = requireAdapter(catalog?.source_adapter || "platform.objects");
  const targets = Array.isArray(objectIds)
    ? objectIds.map((id) => ({ object_id: String(id) }))
    : adapter.list(db, { tenantId, objectType, limit: Math.min(limit, MAX_BATCH_SIZE), offset });
  const results = [];
  for (const target of targets) {
    try {
      results.push(evaluateObject(db, { tenantId, objectType, objectId: target.object_id, actor, trigger, persist, ip }));
    } catch (error) {
      results.push({ object_type: objectType, object_id: target.object_id, error: error.message, code: error.code || null });
    }
  }
  const evaluated = results.filter((entry) => !entry.error);
  const failed = evaluated.filter((entry) => entry.evaluation_state === "FAILED");
  return {
    object_type: objectType,
    processed: results.length,
    evaluated: evaluated.length,
    failed_objects: failed.length,
    errors: results.length - evaluated.length,
    average_score: evaluated.length ? Math.round((evaluated.reduce((sum, entry) => sum + (entry.overall_score || 0), 0) / evaluated.length) * 100) / 100 : null,
    results,
  };
}

export function setEvaluatorConfig(db, tenantId, key, value, actor = null, ip = null) {
  return setConfig(db, tenantId, key, value, actor, ip);
}

export function listRuleResultsForObject(db, { tenantId, objectType, objectId }) {
  const violations = queryAll(
    db,
    `SELECT * FROM dg_quality_violations WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND is_current = 1 ORDER BY severity DESC, rule_code`,
    [Number(tenantId), String(objectType), String(objectId)]
  );
  return violations.map(publicViolation);
}

export { EVALUATORS };
