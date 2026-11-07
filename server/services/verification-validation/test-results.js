// Test result service: the recorded outcome (and supporting measurements) of a
// test execution against acceptance criteria.
//
// A result can be an overall outcome, a procedure-step outcome, a measurement or a
// per-requirement outcome. Objective criteria are evaluated by a small, declarative
// rule evaluator; a human may also set a manual outcome. Evaluation recomputes the
// parent execution's overall outcome so downstream coverage never has to re-derive
// it. Evidence lives in the content module; only a denormalised count is kept here.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { updateRow, updateRowAsync, assertVersion, bumpVersion } from "../requirements/sql.js";
import { normalizeText, normalizeUpper, paginate, parseObject, toIntOrNull } from "../data-lifecycle/validation.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { Requirements as RequirementService } from "../requirements/index.js";
import { publishVvEvent, publishVvEventAsync } from "./events.js";
import { requireExecutionRow, requireExecutionRowAsync, setExecutionOutcome, setExecutionOutcomeAsync } from "./test-executions.js";
import { countEvidenceFor, countEvidenceForAsync } from "./evidence.js";
import { getConfig, getConfigAsync } from "./configuration.js";
import { describeEvaluation, evaluateCriteria } from "./evaluation.js";
import { listUnits, listUnitsAsync } from "../classification/units.js";
import { resultRef } from "./refs.js";
import {
  SOURCE_MODULE,
  RESULT_OUTCOMES,
  RESULT_LEVELS,
  VV_NODE_TYPES,
  DEFAULT_EXECUTION_TRANSITIONS,
} from "./constants.js";
import { resultNotFound, invalidVv, evaluationFailed, evidenceRequired, requirementNotFound, immutableRecord } from "./errors.js";

const EVALUATED_OUTCOMES = ["PASS", "FAIL"];
const EDITABLE_RESULT_STATUSES = ["PLANNED", "READY", "IN_PROGRESS", "BLOCKED", "COMPLETED", "FAILED"];

function needsUnitConversion(criteria) {
  if (!criteria || typeof criteria !== "object") return false;
  return Boolean(criteria.unit || criteria.expected_unit || criteria.expectedUnit || criteria.actual_unit || criteria.actualUnit);
}

export function publicResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    result_ref: row.result_ref,
    tenant_id: row.tenant_id,
    execution_id: row.execution_id,
    procedure_step_id: row.procedure_step_id ?? null,
    requirement_id: row.requirement_id ?? null,
    requirement_revision: row.requirement_revision,
    result_level: row.result_level,
    expected_value: row.expected_value,
    actual_value: row.actual_value,
    unit: row.unit,
    acceptance_criteria: parseObject(row.acceptance_criteria_json, {}),
    evaluation_rule: parseObject(row.evaluation_rule_json, {}),
    evaluation_version: Number(row.evaluation_version || 1),
    outcome: row.outcome,
    failure_reason: row.failure_reason,
    comments: row.comments,
    manual: Boolean(row.manual),
    evaluated_at: row.evaluated_at ?? null,
    evaluated_by: row.evaluated_by ?? null,
    evidence_count: Number(row.evidence_count || 0),
    quality_exception_ref: row.quality_exception_ref || null,
    quality_exception_id: row.quality_exception_id ?? null,
    metadata: parseObject(row.metadata_json, {}),
    version: Number(row.version || 1),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// The acceptance-criteria evaluator lives in its own pure module (`evaluation.js`)
// so the same rules run in the API, jobs and tests; re-exported for callers that
// depend on the results service.
export { evaluateCriteria };

function resolveStep(db, execution, input) {
  const stepRef = input.procedure_step_id ?? input.procedureStepId ?? null;
  if (stepRef === null || stepRef === "") return null;
  const id = Number(stepRef);
  const row = Number.isInteger(id) ? queryOne(db, "SELECT * FROM vv_procedure_steps WHERE id = ?", [id]) : queryOne(db, "SELECT * FROM vv_procedure_steps WHERE procedure_id = ? AND step_ref = ?", [execution.procedure_id, String(stepRef)]);
  if (!row) throw invalidVv(`Procedure step not found: ${stepRef}`, { step: stepRef });
  if (String(row.procedure_id) !== String(execution.procedure_id)) throw invalidVv("The procedure step does not belong to the execution's procedure", { step_ref: row.step_ref });
  return row;
}

async function resolveStepAsync(db, execution, input) {
  const stepRef = input.procedure_step_id ?? input.procedureStepId ?? null;
  if (stepRef === null || stepRef === "") return null;
  const id = Number(stepRef);
  const row = Number.isInteger(id)
    ? await queryOneAsync(db, "SELECT * FROM vv_procedure_steps WHERE id = ?", [id])
    : await queryOneAsync(db, "SELECT * FROM vv_procedure_steps WHERE procedure_id = ? AND step_ref = ?", [execution.procedure_id, String(stepRef)]);
  if (!row) throw invalidVv(`Procedure step not found: ${stepRef}`, { step: stepRef });
  if (String(row.procedure_id) !== String(execution.procedure_id)) throw invalidVv("The procedure step does not belong to the execution's procedure", { step_ref: row.step_ref });
  return row;
}

function resolveResultRequirement(db, tenant, input) {
  const ref = input.requirement_id ?? input.requirementId ?? input.requirement_ref ?? input.requirementRef ?? null;
  if (ref === null || ref === undefined || String(ref).trim() === "") return null;
  const row = RequirementService.getRequirementRow(db, tenant, ref);
  if (!row) throw requirementNotFound(ref);
  return row;
}

async function resolveResultRequirementAsync(db, tenant, input) {
  const ref = input.requirement_id ?? input.requirementId ?? input.requirement_ref ?? input.requirementRef ?? null;
  if (ref === null || ref === undefined || String(ref).trim() === "") return null;
  const row = await RequirementService.getRequirementRowAsync(db, tenant, ref);
  if (!row) throw requirementNotFound(ref);
  return row;
}

function normalizeResultInput(body = {}, current = {}) {
  const outcome = normalizeUpper(body.outcome ?? current.outcome ?? "PENDING");
  if (!RESULT_OUTCOMES.includes(outcome)) throw invalidVv(`Invalid result outcome: ${outcome}`, { allowed: [...RESULT_OUTCOMES] });
  const level = normalizeUpper(body.result_level ?? body.resultLevel ?? current.result_level ?? "OVERALL");
  if (!RESULT_LEVELS.includes(level)) throw invalidVv(`Invalid result level: ${level}`, { allowed: [...RESULT_LEVELS] });
  return {
    result_level: level,
    expected_value: normalizeText(body.expected_value ?? body.expectedValue ?? current.expected_value, { max: 2000 }),
    actual_value: normalizeText(body.actual_value ?? body.actualValue ?? current.actual_value, { max: 4000 }),
    unit: normalizeText(body.unit ?? current.unit, { max: 40 }),
    acceptance_criteria_json: JSON.stringify(body.acceptance_criteria !== undefined || body.acceptanceCriteria !== undefined ? parseObject(body.acceptance_criteria ?? body.acceptanceCriteria, {}) : current.acceptance_criteria || {}),
    evaluation_rule_json: JSON.stringify(body.evaluation_rule !== undefined || body.evaluationRule !== undefined ? parseObject(body.evaluation_rule ?? body.evaluationRule, {}) : current.evaluation_rule || {}),
    outcome,
    failure_reason: normalizeText(body.failure_reason ?? body.failureReason ?? current.failure_reason, { max: 2000 }),
    comments: normalizeText(body.comments ?? current.comments, { max: 4000 }),
    metadata_json: JSON.stringify(body.metadata !== undefined ? parseObject(body.metadata, {}) : current.metadata || {}),
  };
}

export function resultFilters({ tenantId, execution_id, result_level, outcome, requirement_id } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (execution_id) {
    clauses.push("execution_id = ?");
    params.push(Number(execution_id));
  }
  if (result_level) {
    clauses.push("result_level = ?");
    params.push(normalizeUpper(result_level));
  }
  if (outcome) {
    clauses.push("outcome = ?");
    params.push(normalizeUpper(outcome));
  }
  if (requirement_id) {
    clauses.push("requirement_id = ?");
    params.push(Number(requirement_id));
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listResults(db, tenantId, opts = {}) {
  const { where, params } = resultFilters({ ...opts, tenantId });
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM vv_results ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM vv_results ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicResult), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listResultsAsync(db, tenantId, opts = {}) {
  const { where, params } = resultFilters({ ...opts, tenantId });
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM vv_results ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM vv_results ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicResult), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export function getResultRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM vv_results WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOne(db, "SELECT * FROM vv_results WHERE tenant_id = ? AND result_ref = ?", [Number(tenantId), String(ref)]);
}

export async function getResultRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM vv_results WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOneAsync(db, "SELECT * FROM vv_results WHERE tenant_id = ? AND result_ref = ?", [Number(tenantId), String(ref)]);
}

export function getResult(db, tenantId, ref) {
  return publicResult(getResultRow(db, tenantId, ref));
}

export async function getResultAsync(db, tenantId, ref) {
  return publicResult(await getResultRowAsync(db, tenantId, ref));
}

export function requireResultRow(db, tenantId, ref) {
  const row = getResultRow(db, tenantId, ref);
  if (!row) throw resultNotFound(ref);
  return row;
}

export async function requireResultRowAsync(db, tenantId, ref) {
  const row = await getResultRowAsync(db, tenantId, ref);
  if (!row) throw resultNotFound(ref);
  return row;
}

export function recordResult(db, tenantId, executionRefValue, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const execution = requireExecutionRow(db, tenant, executionRefValue);
  if (!EDITABLE_RESULT_STATUSES.includes(execution.status)) throw immutableRecord(`Cannot record results on a ${execution.status} execution`, { execution_ref: execution.execution_ref, status: execution.status });
  const input = normalizeResultInput(body, {});
  const step = resolveStep(db, execution, body);
  const requirement = resolveResultRequirement(db, tenant, body);
  const ref = normalizeText(body.result_ref ?? body.resultRef ?? "", { max: 80 }) || resultRef();
  if (queryOne(db, "SELECT id FROM vv_results WHERE tenant_id = ? AND result_ref = ?", [tenant, ref])) throw invalidVv(`Result reference already exists: ${ref}`, { result_ref: ref });
  const ts = nowIso();
  const evaluated = EVALUATED_OUTCOMES.includes(input.outcome);
  const result = run(
    db,
    `INSERT INTO vv_results
       (result_ref, tenant_id, execution_id, procedure_step_id, requirement_id, requirement_revision, result_level,
        expected_value, actual_value, unit, acceptance_criteria_json, evaluation_rule_json, evaluation_version, outcome,
        failure_reason, comments, manual, evaluated_at, evaluated_by, evidence_count, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?)`,
    [
      ref, tenant, execution.id, step?.id ?? null, requirement?.id ?? null, requirement?.revision ?? "", input.result_level,
      input.expected_value, input.actual_value, input.unit, input.acceptance_criteria_json, input.evaluation_rule_json, input.outcome,
      input.failure_reason, input.comments, evaluated ? 1 : 0, evaluated ? ts : null, evaluated ? actor?.id ?? null : null, input.metadata_json,
      actor?.id ?? null, actor?.id ?? null, ts, ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM vv_results WHERE id = ?", [Number(result.lastInsertId)]);
  writeAudit(db, { actor, action: "verification-validation.result.record", resourceType: "vv_test_result", resourceId: row.result_ref, details: { execution_ref: execution.execution_ref, level: row.result_level }, ip });
  publishVvEvent(db, { eventType: "TestResultRecorded", objectType: "test_result", objectId: String(row.id), tenantId: tenant, payload: { result_ref: row.result_ref, execution_ref: execution.execution_ref, outcome: row.outcome, level: row.result_level } }, actor);
  return publicResult(row);
}

export async function recordResultAsync(db, tenantId, executionRefValue, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const execution = await requireExecutionRowAsync(db, tenant, executionRefValue);
  if (!EDITABLE_RESULT_STATUSES.includes(execution.status)) throw immutableRecord(`Cannot record results on a ${execution.status} execution`, { execution_ref: execution.execution_ref, status: execution.status });
  const input = normalizeResultInput(body, {});
  const step = await resolveStepAsync(db, execution, body);
  const requirement = await resolveResultRequirementAsync(db, tenant, body);
  const ref = normalizeText(body.result_ref ?? body.resultRef ?? "", { max: 80 }) || resultRef();
  if (await queryOneAsync(db, "SELECT id FROM vv_results WHERE tenant_id = ? AND result_ref = ?", [tenant, ref])) throw invalidVv(`Result reference already exists: ${ref}`, { result_ref: ref });
  const ts = nowIso();
  const evaluated = EVALUATED_OUTCOMES.includes(input.outcome);
  const result = await runAsync(
    db,
    `INSERT INTO vv_results
       (result_ref, tenant_id, execution_id, procedure_step_id, requirement_id, requirement_revision, result_level,
        expected_value, actual_value, unit, acceptance_criteria_json, evaluation_rule_json, evaluation_version, outcome,
        failure_reason, comments, manual, evaluated_at, evaluated_by, evidence_count, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?)`,
    [
      ref, tenant, execution.id, step?.id ?? null, requirement?.id ?? null, requirement?.revision ?? "", input.result_level,
      input.expected_value, input.actual_value, input.unit, input.acceptance_criteria_json, input.evaluation_rule_json, input.outcome,
      input.failure_reason, input.comments, evaluated ? 1 : 0, evaluated ? ts : null, evaluated ? actor?.id ?? null : null, input.metadata_json,
      actor?.id ?? null, actor?.id ?? null, ts, ts,
    ]
  );
  const row = await queryOneAsync(db, "SELECT * FROM vv_results WHERE id = ?", [Number(result.lastInsertId)]);
  await writeAuditAsync(db, { actor, action: "verification-validation.result.record", resourceType: "vv_test_result", resourceId: row.result_ref, details: { execution_ref: execution.execution_ref, level: row.result_level }, ip });
  await publishVvEventAsync(db, { eventType: "TestResultRecorded", objectType: "test_result", objectId: String(row.id), tenantId: tenant, payload: { result_ref: row.result_ref, execution_ref: execution.execution_ref, outcome: row.outcome, level: row.result_level } }, actor);
  return publicResult(row);
}

export function updateResult(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireResultRow(db, tenant, ref);
  assertVersion(row, body.version ?? body.expected_version, invalidVv);
  const changedMeasurement = body.actual_value !== undefined || body.actualValue !== undefined || body.expected_value !== undefined || body.expectedValue !== undefined || body.acceptance_criteria !== undefined;
  const input = normalizeResultInput(body, publicResult(row));
  const patch = { ...input, version: bumpVersion(row), updated_by: actor?.id ?? null };
  if (changedMeasurement) {
    patch.outcome = "PENDING";
    patch.evaluated_at = null;
    patch.evaluated_by = null;
    patch.manual = 0;
  }
  updateRow(db, "vv_results", row.id, patch);
  writeAudit(db, { actor, action: "verification-validation.result.update", resourceType: "vv_test_result", resourceId: row.result_ref, details: {}, ip });
  return publicResult(queryOne(db, "SELECT * FROM vv_results WHERE id = ?", [row.id]));
}

export async function updateResultAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireResultRowAsync(db, tenant, ref);
  assertVersion(row, body.version ?? body.expected_version, invalidVv);
  const changedMeasurement = body.actual_value !== undefined || body.actualValue !== undefined || body.expected_value !== undefined || body.expectedValue !== undefined || body.acceptance_criteria !== undefined;
  const input = normalizeResultInput(body, publicResult(row));
  const patch = { ...input, version: bumpVersion(row), updated_by: actor?.id ?? null };
  if (changedMeasurement) {
    patch.outcome = "PENDING";
    patch.evaluated_at = null;
    patch.evaluated_by = null;
    patch.manual = 0;
  }
  await updateRowAsync(db, "vv_results", row.id, patch);
  await writeAuditAsync(db, { actor, action: "verification-validation.result.update", resourceType: "vv_test_result", resourceId: row.result_ref, details: {}, ip });
  return publicResult(await queryOneAsync(db, "SELECT * FROM vv_results WHERE id = ?", [row.id]));
}

// Aggregate a set of result outcomes into the parent execution outcome. FAIL and
// BLOCKED dominate; PENDING blocks a PASS; otherwise all-PASS is a PASS.
export function rollupOutcome(outcomes = []) {
  if (!outcomes.length) return null;
  if (outcomes.includes("FAIL")) return "FAIL";
  if (outcomes.includes("BLOCKED")) return "BLOCKED";
  if (outcomes.includes("PENDING")) return "PENDING";
  if (outcomes.every((o) => o === "PASS")) return "PASS";
  return "NOT_EVALUABLE";
}

function loadExecutionResults(db, executionId) {
  return queryAll(db, "SELECT * FROM vv_results WHERE execution_id = ?", [executionId]);
}

async function loadExecutionResultsAsync(db, executionId) {
  return queryAllAsync(db, "SELECT * FROM vv_results WHERE execution_id = ?", [executionId]);
}

function emitOutcomeEvents(db, execution, outcome, actor, tenant) {
  if (outcome === "FAIL") {
    publishVvEvent(db, { eventType: "VerificationFailed", objectType: "test_execution", objectId: String(execution.id), tenantId: tenant, payload: { execution_ref: execution.execution_ref, test_case_id: execution.test_case_id } }, actor);
  }
}

async function emitOutcomeEventsAsync(db, execution, outcome, actor, tenant) {
  if (outcome === "FAIL") {
    await publishVvEventAsync(db, { eventType: "VerificationFailed", objectType: "test_execution", objectId: String(execution.id), tenantId: tenant, payload: { execution_ref: execution.execution_ref, test_case_id: execution.test_case_id } }, actor);
  }
}

export function evaluateResult(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireResultRow(db, tenant, ref);
  const execution = requireExecutionRowById(db, tenant, row.execution_id);
  const evidenceCount = countEvidenceFor(db, tenant, VV_NODE_TYPES.TEST_RESULT, row.id);
  let outcome = row.outcome;
  let reason = row.failure_reason;
  let manual = 0;
  let rule;
  if (body.outcome) {
    outcome = normalizeUpper(body.outcome);
    if (!RESULT_OUTCOMES.includes(outcome)) throw invalidVv(`Invalid result outcome: ${outcome}`, { allowed: [...RESULT_OUTCOMES] });
    manual = 1;
    reason = normalizeText(body.failure_reason ?? body.failureReason ?? reason, { max: 2000 });
    rule = describeEvaluation({}, { outcome, reason }, { evidenceCount });
  } else {
    const criteria = parseObject(body.acceptance_criteria ?? body.acceptanceCriteria ?? row.acceptance_criteria_json, {});
    const actual = body.actual_value ?? body.actualValue ?? row.actual_value;
    const actualUnit = body.unit ?? row.unit;
    const units = needsUnitConversion(criteria) ? listUnits(db, { tenantId: tenant, limit: 2000 }) : null;
    const evaluation = evaluateCriteria(criteria, actual, body.expected_value ?? body.expectedValue, { actualUnit, units });
    outcome = evaluation.outcome;
    reason = evaluation.outcome === "FAIL" ? normalizeText(body.failure_reason ?? evaluation.reason, { max: 2000 }) : "";
    rule = describeEvaluation(criteria, evaluation, { actualUnit, evidenceCount });
  }
  if (outcome === "PASS" && getConfig(db, tenant, "require_evidence_for_pass") && evidenceCount === 0) {
    throw evidenceRequired(`Result ${row.result_ref} cannot pass without supporting evidence`, { result_ref: row.result_ref, evidence_count: 0 });
  }
  const ts = nowIso();
  updateRow(db, "vv_results", row.id, {
    outcome,
    failure_reason: reason,
    evaluated_at: ts,
    evaluated_by: actor?.id ?? null,
    evaluation_version: Number(row.evaluation_version || 1) + 1,
    evaluation_rule_json: JSON.stringify(rule),
    evidence_count: evidenceCount,
    manual,
    updated_by: actor?.id ?? null,
  });
  const updated = queryOne(db, "SELECT * FROM vv_results WHERE id = ?", [row.id]);
  const rolled = rollupOutcome(loadExecutionResults(db, execution.id).map((r) => r.outcome));
  setExecutionOutcome(db, execution.id, rolled);
  writeAudit(db, { actor, action: "verification-validation.result.evaluate", resourceType: "vv_test_result", resourceId: row.result_ref, details: { outcome, manual: Boolean(manual) }, ip });
  publishVvEvent(db, { eventType: "TestResultEvaluated", objectType: "test_result", objectId: String(row.id), tenantId: tenant, payload: { result_ref: row.result_ref, execution_ref: execution.execution_ref, outcome } }, actor);
  emitOutcomeEvents(db, execution, outcome, actor, tenant);
  return { result: publicResult(updated), execution_outcome: rolled };
}

export async function evaluateResultAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireResultRowAsync(db, tenant, ref);
  const execution = await requireExecutionRowByIdAsync(db, tenant, row.execution_id);
  const evidenceCount = await countEvidenceForAsync(db, tenant, VV_NODE_TYPES.TEST_RESULT, row.id);
  let outcome = row.outcome;
  let reason = row.failure_reason;
  let manual = 0;
  let rule;
  if (body.outcome) {
    outcome = normalizeUpper(body.outcome);
    if (!RESULT_OUTCOMES.includes(outcome)) throw invalidVv(`Invalid result outcome: ${outcome}`, { allowed: [...RESULT_OUTCOMES] });
    manual = 1;
    reason = normalizeText(body.failure_reason ?? body.failureReason ?? reason, { max: 2000 });
    rule = describeEvaluation({}, { outcome, reason }, { evidenceCount });
  } else {
    const criteria = parseObject(body.acceptance_criteria ?? body.acceptanceCriteria ?? row.acceptance_criteria_json, {});
    const actual = body.actual_value ?? body.actualValue ?? row.actual_value;
    const actualUnit = body.unit ?? row.unit;
    const units = needsUnitConversion(criteria) ? await listUnitsAsync(db, { tenantId: tenant, limit: 2000 }) : null;
    const evaluation = evaluateCriteria(criteria, actual, body.expected_value ?? body.expectedValue, { actualUnit, units });
    outcome = evaluation.outcome;
    reason = evaluation.outcome === "FAIL" ? normalizeText(body.failure_reason ?? evaluation.reason, { max: 2000 }) : "";
    rule = describeEvaluation(criteria, evaluation, { actualUnit, evidenceCount });
  }
  if (outcome === "PASS" && (await getConfigAsync(db, tenant, "require_evidence_for_pass")) && evidenceCount === 0) {
    throw evidenceRequired(`Result ${row.result_ref} cannot pass without supporting evidence`, { result_ref: row.result_ref, evidence_count: 0 });
  }
  const ts = nowIso();
  await updateRowAsync(db, "vv_results", row.id, {
    outcome,
    failure_reason: reason,
    evaluated_at: ts,
    evaluated_by: actor?.id ?? null,
    evaluation_version: Number(row.evaluation_version || 1) + 1,
    evaluation_rule_json: JSON.stringify(rule),
    evidence_count: evidenceCount,
    manual,
    updated_by: actor?.id ?? null,
  });
  const updated = await queryOneAsync(db, "SELECT * FROM vv_results WHERE id = ?", [row.id]);
  const rolled = rollupOutcome((await loadExecutionResultsAsync(db, execution.id)).map((r) => r.outcome));
  await setExecutionOutcomeAsync(db, execution.id, rolled);
  await writeAuditAsync(db, { actor, action: "verification-validation.result.evaluate", resourceType: "vv_test_result", resourceId: row.result_ref, details: { outcome, manual: Boolean(manual) }, ip });
  await publishVvEventAsync(db, { eventType: "TestResultEvaluated", objectType: "test_result", objectId: String(row.id), tenantId: tenant, payload: { result_ref: row.result_ref, execution_ref: execution.execution_ref, outcome } }, actor);
  await emitOutcomeEventsAsync(db, execution, outcome, actor, tenant);
  return { result: publicResult(updated), execution_outcome: rolled };
}

function requireExecutionRowById(db, tenant, id) {
  const row = queryOne(db, "SELECT * FROM vv_executions WHERE id = ? AND tenant_id = ?", [Number(id), tenant]);
  if (!row) throw invalidVv(`Execution ${id} not found`, { execution_id: id });
  return row;
}

async function requireExecutionRowByIdAsync(db, tenant, id) {
  const row = await queryOneAsync(db, "SELECT * FROM vv_executions WHERE id = ? AND tenant_id = ?", [Number(id), tenant]);
  if (!row) throw invalidVv(`Execution ${id} not found`, { execution_id: id });
  return row;
}

export function evaluateExecution(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const execution = requireExecutionRow(db, tenant, ref);
  const results = loadExecutionResults(db, execution.id);
  if (!results.length) throw evaluationFailed("An execution has no results to evaluate", { execution_ref: execution.execution_ref });
  if (results.some((r) => r.outcome === "PENDING")) throw evaluationFailed("All results must be evaluated before the execution can be evaluated", { execution_ref: execution.execution_ref });
  const rolled = rollupOutcome(results.map((r) => r.outcome));
  setExecutionOutcome(db, execution.id, rolled);
  let updated = queryOne(db, "SELECT * FROM vv_executions WHERE id = ?", [execution.id]);
  if ((DEFAULT_EXECUTION_TRANSITIONS[execution.status] || []).includes("EVALUATED")) {
    updateRow(db, "vv_executions", execution.id, { status: "EVALUATED", lifecycle_state: "EVALUATED", updated_by: actor?.id ?? null });
    updated = queryOne(db, "SELECT * FROM vv_executions WHERE id = ?", [execution.id]);
  }
  const testCase = queryOne(db, "SELECT verification_kind FROM vv_test_cases WHERE id = ?", [execution.test_case_id]);
  writeAudit(db, { actor, action: "verification-validation.execution.evaluate", resourceType: "vv_test_execution", resourceId: execution.execution_ref, details: { outcome: rolled }, ip });
  if (rolled === "PASS") {
    publishVvEvent(db, { eventType: testCase?.verification_kind === "VALIDATION" ? "ValidationCompleted" : "VerificationCompleted", objectType: "test_execution", objectId: String(execution.id), tenantId: tenant, payload: { execution_ref: execution.execution_ref, test_case_id: execution.test_case_id } }, actor);
  }
  return { execution: publicExecutionLite(updated), execution_outcome: rolled, result_count: results.length };
}

export async function evaluateExecutionAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const execution = await requireExecutionRowAsync(db, tenant, ref);
  const results = await loadExecutionResultsAsync(db, execution.id);
  if (!results.length) throw evaluationFailed("An execution has no results to evaluate", { execution_ref: execution.execution_ref });
  if (results.some((r) => r.outcome === "PENDING")) throw evaluationFailed("All results must be evaluated before the execution can be evaluated", { execution_ref: execution.execution_ref });
  const rolled = rollupOutcome(results.map((r) => r.outcome));
  await setExecutionOutcomeAsync(db, execution.id, rolled);
  let updated = await queryOneAsync(db, "SELECT * FROM vv_executions WHERE id = ?", [execution.id]);
  if ((DEFAULT_EXECUTION_TRANSITIONS[execution.status] || []).includes("EVALUATED")) {
    await updateRowAsync(db, "vv_executions", execution.id, { status: "EVALUATED", lifecycle_state: "EVALUATED", updated_by: actor?.id ?? null });
    updated = await queryOneAsync(db, "SELECT * FROM vv_executions WHERE id = ?", [execution.id]);
  }
  const testCase = await queryOneAsync(db, "SELECT verification_kind FROM vv_test_cases WHERE id = ?", [execution.test_case_id]);
  await writeAuditAsync(db, { actor, action: "verification-validation.execution.evaluate", resourceType: "vv_test_execution", resourceId: execution.execution_ref, details: { outcome: rolled }, ip });
  if (rolled === "PASS") {
    await publishVvEventAsync(db, { eventType: testCase?.verification_kind === "VALIDATION" ? "ValidationCompleted" : "VerificationCompleted", objectType: "test_execution", objectId: String(execution.id), tenantId: tenant, payload: { execution_ref: execution.execution_ref, test_case_id: execution.test_case_id } }, actor);
  }
  return { execution: publicExecutionLite(updated), execution_outcome: rolled, result_count: results.length };
}

function publicExecutionLite(row) {
  if (!row) return null;
  return { id: row.id, execution_ref: row.execution_ref, status: row.status, overall_outcome: row.overall_outcome ?? null };
}
