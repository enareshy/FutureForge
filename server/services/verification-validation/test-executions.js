// Test execution service: the record of running a test case (optionally pinned to
// a procedure revision) against a product/configuration context.
//
// An execution pins the exact definition revisions it was run against, records who
// tested and reviewed it, and carries a retest chain via `previous_execution_id`.
// Requirement scope is snapshotted into `requirement_ids_json` so an execution
// remains meaningful even if the test case is later re-linked. Definition
// identity, lifecycle, evidence and quality stay in their own engines; this file
// owns only execution state (mirrors requirements/requirements.js).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { nextNumber, nextNumberAsync } from "../numbering.js";
import { updateRow, updateRowAsync, assertVersion, bumpVersion } from "../requirements/sql.js";
import { normalizeText, normalizeUpper, paginate, parseObject, parseArray, toIntOrNull } from "../data-lifecycle/validation.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { Requirements as RequirementService } from "../requirements/index.js";
import { publishVvEvent, publishVvEventAsync } from "./events.js";
import { requireTestCaseRow, requireTestCaseRowAsync } from "./test-cases.js";
import { requireProcedureRow, requireProcedureRowAsync } from "./test-procedures.js";
import { getConfig, getConfigAsync } from "./configuration.js";
import { executionRef } from "./refs.js";
import {
  SOURCE_MODULE,
  NUMBERING_OBJECT_TYPES,
  EXECUTION_STATUSES,
  DEFAULT_EXECUTION_TRANSITIONS,
  RESULT_OUTCOMES,
} from "./constants.js";
import { executionNotFound, invalidVv, invalidTransition, immutableRecord, incompleteExecution, requirementNotFound } from "./errors.js";

const EDITABLE_EXECUTION_STATUSES = ["PLANNED", "READY", "IN_PROGRESS", "BLOCKED"];
const RETESTABLE_EXECUTION_STATUSES = ["COMPLETED", "EVALUATED", "REVIEWED", "FAILED", "REQUIRES_RETEST"];

export function publicExecution(row) {
  if (!row) return null;
  return {
    id: row.id,
    execution_ref: row.execution_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    test_case_id: row.test_case_id ?? null,
    test_case_revision: row.test_case_revision,
    procedure_id: row.procedure_id ?? null,
    procedure_revision: row.procedure_revision,
    requirement_ids: parseArray(row.requirement_ids_json, []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0),
    product: row.product_object_type ? { object_type: row.product_object_type, object_id: row.product_object_id } : null,
    configuration_context: row.configuration_context,
    effectivity: row.effectivity,
    status: row.status,
    lifecycle_state: row.lifecycle_state,
    tester_user_id: row.tester_user_id ?? null,
    reviewer_user_id: row.reviewer_user_id ?? null,
    planned_start_at: row.planned_start_at ?? null,
    planned_end_at: row.planned_end_at ?? null,
    actual_start_at: row.actual_start_at ?? null,
    actual_end_at: row.actual_end_at ?? null,
    environment: parseObject(row.environment_json, {}),
    equipment: parseObject(row.equipment_json, []),
    input_parameters: parseObject(row.input_parameters_json, {}),
    notes: row.notes,
    previous_execution_id: row.previous_execution_id ?? null,
    retest_reason: row.retest_reason,
    overall_outcome: row.overall_outcome ?? null,
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

function objField(value, fallback) {
  return value === undefined ? fallback : parseObject(value, fallback);
}

function arrField(value, fallback) {
  return value === undefined ? fallback : parseArray(value, fallback);
}

function normalizeRequirementIds(value, fallback = []) {
  if (value === undefined) return fallback.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  return parseArray(value, []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
}

function normalizeExecutionInput(body = {}, current = {}) {
  const product = body.product && typeof body.product === "object" ? body.product : {};
  return {
    organization_id: body.organization_id !== undefined ? toIntOrNull(body.organization_id) : current.organization_id ?? null,
    tester_user_id: body.tester_user_id !== undefined || body.testerUserId !== undefined ? toIntOrNull(body.tester_user_id ?? body.testerUserId) : current.tester_user_id ?? null,
    reviewer_user_id: body.reviewer_user_id !== undefined || body.reviewerUserId !== undefined ? toIntOrNull(body.reviewer_user_id ?? body.reviewerUserId) : current.reviewer_user_id ?? null,
    planned_start_at: normalizeText(body.planned_start_at ?? body.plannedStartAt ?? current.planned_start_at, { max: 40 }) || null,
    planned_end_at: normalizeText(body.planned_end_at ?? body.plannedEndAt ?? current.planned_end_at, { max: 40 }) || null,
    environment_json: JSON.stringify(objField(body.environment, current.environment || {})),
    equipment_json: JSON.stringify(arrField(body.equipment, current.equipment || [])),
    input_parameters_json: JSON.stringify(objField(body.input_parameters ?? body.inputParameters, current.input_parameters || {})),
    product_object_type: normalizeText(body.product_object_type ?? body.productObjectType ?? product.object_type ?? product.objectType ?? current.product?.object_type, { max: 80 }),
    product_object_id: normalizeText(body.product_object_id ?? body.productObjectId ?? product.object_id ?? product.objectId ?? current.product?.object_id, { max: 120 }),
    configuration_context: normalizeText(body.configuration_context ?? body.configurationContext ?? current.configuration_context, { max: 200 }),
    effectivity: normalizeText(body.effectivity ?? current.effectivity, { max: 200 }),
    notes: normalizeText(body.notes ?? current.notes, { max: 4000 }),
    metadata_json: JSON.stringify(objField(body.metadata, current.metadata || {})),
  };
}

export function executionFilters({ tenantId, status, overall_outcome, test_case_id, procedure_id, previously_of, q } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (overall_outcome) {
    clauses.push("overall_outcome = ?");
    params.push(normalizeUpper(overall_outcome));
  }
  if (test_case_id) {
    clauses.push("test_case_id = ?");
    params.push(Number(test_case_id));
  }
  if (procedure_id) {
    clauses.push("procedure_id = ?");
    params.push(Number(procedure_id));
  }
  if (previously_of) {
    clauses.push("previous_execution_id = ?");
    params.push(Number(previously_of));
  }
  if (q) {
    const like = `%${normalizeText(q, { max: 120 })}%`;
    clauses.push("(execution_ref ILIKE ? OR notes ILIKE ?)");
    params.push(like, like);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listExecutions(db, opts = {}) {
  const { where, params } = executionFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM vv_executions ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM vv_executions ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicExecution), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listExecutionsAsync(db, opts = {}) {
  const { where, params } = executionFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM vv_executions ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM vv_executions ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicExecution), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export function getExecutionRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM vv_executions WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOne(db, "SELECT * FROM vv_executions WHERE tenant_id = ? AND execution_ref = ?", [Number(tenantId), String(ref)]);
}

export async function getExecutionRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM vv_executions WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOneAsync(db, "SELECT * FROM vv_executions WHERE tenant_id = ? AND execution_ref = ?", [Number(tenantId), String(ref)]);
}

export function getExecution(db, tenantId, ref) {
  return publicExecution(getExecutionRow(db, tenantId, ref));
}

export async function getExecutionAsync(db, tenantId, ref) {
  return publicExecution(await getExecutionRowAsync(db, tenantId, ref));
}

export function requireExecutionRow(db, tenantId, ref) {
  const row = getExecutionRow(db, tenantId, ref);
  if (!row) throw executionNotFound(ref);
  return row;
}

export async function requireExecutionRowAsync(db, tenantId, ref) {
  const row = await getExecutionRowAsync(db, tenantId, ref);
  if (!row) throw executionNotFound(ref);
  return row;
}

function assertDefinitionApproval(testCase, procedure, { requireApprovedTestCase, requireApprovedProcedure }) {
  if (requireApprovedTestCase && !["APPROVED", "RELEASED"].includes(testCase.status)) {
    throw invalidVv(`Test case ${testCase.test_case_ref} is ${testCase.status}; it must be approved before execution`, { test_case_ref: testCase.test_case_ref, status: testCase.status });
  }
  if (procedure && requireApprovedProcedure && !["APPROVED", "RELEASED"].includes(procedure.status)) {
    throw invalidVv(`Test procedure ${procedure.procedure_ref} is ${procedure.status}; it must be approved before execution`, { procedure_ref: procedure.procedure_ref, status: procedure.status });
  }
}

function insertExecution(db, values) {
  const result = run(
    db,
    `INSERT INTO vv_executions
       (execution_ref, tenant_id, organization_id, test_case_id, test_case_revision, procedure_id, procedure_revision, requirement_ids_json,
        product_object_type, product_object_id, configuration_context, effectivity, status, lifecycle_state,
        tester_user_id, reviewer_user_id, planned_start_at, planned_end_at, environment_json, equipment_json, input_parameters_json,
        notes, previous_execution_id, retest_reason, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PLANNED', 'PLANNED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      values.execution_ref,
      values.tenant_id,
      values.organization_id,
      values.test_case_id,
      values.test_case_revision,
      values.procedure_id,
      values.procedure_revision,
      values.requirement_ids_json,
      values.product_object_type,
      values.product_object_id,
      values.configuration_context,
      values.effectivity,
      values.tester_user_id,
      values.reviewer_user_id,
      values.planned_start_at,
      values.planned_end_at,
      values.environment_json,
      values.equipment_json,
      values.input_parameters_json,
      values.notes,
      values.previous_execution_id,
      values.retest_reason,
      values.metadata_json,
      values.actor_id,
      values.actor_id,
      values.ts,
      values.ts,
    ]
  );
  return queryOne(db, "SELECT * FROM vv_executions WHERE id = ?", [Number(result.lastInsertId)]);
}

export function createExecution(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const testCaseRow = requireTestCaseRow(db, tenant, body.test_case_id ?? body.testCaseId ?? body.test_case ?? body.testCase ?? body.test_case_ref ?? body.testCaseRef);
  const procedureRow = body.procedure_id || body.procedureId || body.procedure || body.procedure_ref || body.procedureRef ? requireProcedureRow(db, tenant, body.procedure_id ?? body.procedureId ?? body.procedure ?? body.procedure_ref ?? body.procedureRef) : null;
  if (procedureRow && String(procedureRow.test_case_id) !== String(testCaseRow.id)) {
    throw invalidVv("The procedure does not belong to the selected test case", { procedure_ref: procedureRow.procedure_ref, test_case_ref: testCaseRow.test_case_ref });
  }
  assertDefinitionApproval(testCaseRow, procedureRow, {
    requireApprovedTestCase: getConfig(db, tenant, "require_approved_test_case"),
    requireApprovedProcedure: getConfig(db, tenant, "require_approved_procedure"),
  });
  const input = normalizeExecutionInput(body, {});
  const number = normalizeText(body.execution_number ?? body.executionNumber ?? "", { max: 60 }) || nextNumber(db, { objectType: NUMBERING_OBJECT_TYPES.EXECUTION }, actor, { tenantId: tenant });
  const ref = normalizeText(body.execution_ref ?? body.executionRef ?? "", { max: 80 }) || executionRef(number);
  if (queryOne(db, "SELECT id FROM vv_executions WHERE tenant_id = ? AND execution_ref = ?", [tenant, ref])) {
    throw invalidVv(`Execution reference already exists: ${ref}`, { execution_ref: ref });
  }
  const validatedRequirementIds = [];
  for (const requirementId of normalizeRequirementIds(body.requirement_ids ?? body.requirementIds ?? body.requirements, [])) {
    if (!RequirementService.getRequirementRow(db, tenant, requirementId)) throw requirementNotFound(requirementId);
    validatedRequirementIds.push(requirementId);
  }
  const row = insertExecution(db, {
    ...input,
    execution_ref: ref,
    tenant_id: tenant,
    test_case_id: testCaseRow.id,
    test_case_revision: testCaseRow.revision,
    procedure_id: procedureRow?.id ?? null,
    procedure_revision: procedureRow?.revision ?? "",
    requirement_ids_json: JSON.stringify(validatedRequirementIds),
    previous_execution_id: null,
    retest_reason: "",
    actor_id: actor?.id ?? null,
    ts: nowIso(),
  });
  writeAudit(db, { actor, action: "verification-validation.execution.create", resourceType: "vv_test_execution", resourceId: row.execution_ref, details: { test_case_ref: testCaseRow.test_case_ref }, ip });
  return publicExecution(row);
}

export async function createExecutionAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const testCaseRow = await requireTestCaseRowAsync(db, tenant, body.test_case_id ?? body.testCaseId ?? body.test_case ?? body.testCase ?? body.test_case_ref ?? body.testCaseRef);
  const procedureRow = body.procedure_id || body.procedureId || body.procedure || body.procedure_ref || body.procedureRef ? await requireProcedureRowAsync(db, tenant, body.procedure_id ?? body.procedureId ?? body.procedure ?? body.procedure_ref ?? body.procedureRef) : null;
  if (procedureRow && String(procedureRow.test_case_id) !== String(testCaseRow.id)) {
    throw invalidVv("The procedure does not belong to the selected test case", { procedure_ref: procedureRow.procedure_ref, test_case_ref: testCaseRow.test_case_ref });
  }
  assertDefinitionApproval(testCaseRow, procedureRow, {
    requireApprovedTestCase: await getConfigAsync(db, tenant, "require_approved_test_case"),
    requireApprovedProcedure: await getConfigAsync(db, tenant, "require_approved_procedure"),
  });
  const input = normalizeExecutionInput(body, {});
  const number = normalizeText(body.execution_number ?? body.executionNumber ?? "", { max: 60 }) || (await nextNumberAsync(db, { objectType: NUMBERING_OBJECT_TYPES.EXECUTION }, actor, { tenantId: tenant }));
  const ref = normalizeText(body.execution_ref ?? body.executionRef ?? "", { max: 80 }) || executionRef(number);
  if (await queryOneAsync(db, "SELECT id FROM vv_executions WHERE tenant_id = ? AND execution_ref = ?", [tenant, ref])) {
    throw invalidVv(`Execution reference already exists: ${ref}`, { execution_ref: ref });
  }
  const validatedRequirementIds = [];
  for (const requirementId of normalizeRequirementIds(body.requirement_ids ?? body.requirementIds ?? body.requirements, [])) {
    if (!(await RequirementService.getRequirementRowAsync(db, tenant, requirementId))) throw requirementNotFound(requirementId);
    validatedRequirementIds.push(requirementId);
  }
  const values = {
    ...input,
    execution_ref: ref,
    tenant_id: tenant,
    test_case_id: testCaseRow.id,
    test_case_revision: testCaseRow.revision,
    procedure_id: procedureRow?.id ?? null,
    procedure_revision: procedureRow?.revision ?? "",
    requirement_ids_json: JSON.stringify(validatedRequirementIds),
    previous_execution_id: null,
    retest_reason: "",
    actor_id: actor?.id ?? null,
    ts: nowIso(),
  };
  const result = await runAsync(
    db,
    `INSERT INTO vv_executions
       (execution_ref, tenant_id, organization_id, test_case_id, test_case_revision, procedure_id, procedure_revision, requirement_ids_json,
        product_object_type, product_object_id, configuration_context, effectivity, status, lifecycle_state,
        tester_user_id, reviewer_user_id, planned_start_at, planned_end_at, environment_json, equipment_json, input_parameters_json,
        notes, previous_execution_id, retest_reason, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PLANNED', 'PLANNED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      values.execution_ref, values.tenant_id, values.organization_id, values.test_case_id, values.test_case_revision, values.procedure_id, values.procedure_revision, values.requirement_ids_json,
      values.product_object_type, values.product_object_id, values.configuration_context, values.effectivity,
      values.tester_user_id, values.reviewer_user_id, values.planned_start_at, values.planned_end_at, values.environment_json, values.equipment_json, values.input_parameters_json,
      values.notes, values.previous_execution_id, values.retest_reason, values.metadata_json, values.actor_id, values.actor_id, values.ts, values.ts,
    ]
  );
  const row = await queryOneAsync(db, "SELECT * FROM vv_executions WHERE id = ?", [Number(result.lastInsertId)]);
  await writeAuditAsync(db, { actor, action: "verification-validation.execution.create", resourceType: "vv_test_execution", resourceId: row.execution_ref, details: { test_case_ref: testCaseRow.test_case_ref }, ip });
  return publicExecution(row);
}

export function updateExecution(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireExecutionRow(db, tenant, ref);
  if (!EDITABLE_EXECUTION_STATUSES.includes(row.status)) throw immutableRecord(`Cannot edit a ${row.status} execution`, { ref: row.execution_ref, status: row.status });
  assertVersion(row, body.version ?? body.expected_version, invalidVv);
  const input = normalizeExecutionInput(body, publicExecution(row));
  updateRow(db, "vv_executions", row.id, { ...input, version: bumpVersion(row), updated_by: actor?.id ?? null });
  writeAudit(db, { actor, action: "verification-validation.execution.update", resourceType: "vv_test_execution", resourceId: row.execution_ref, details: {}, ip });
  return publicExecution(queryOne(db, "SELECT * FROM vv_executions WHERE id = ?", [row.id]));
}

export async function updateExecutionAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireExecutionRowAsync(db, tenant, ref);
  if (!EDITABLE_EXECUTION_STATUSES.includes(row.status)) throw immutableRecord(`Cannot edit a ${row.status} execution`, { ref: row.execution_ref, status: row.status });
  assertVersion(row, body.version ?? body.expected_version, invalidVv);
  const input = normalizeExecutionInput(body, publicExecution(row));
  await updateRowAsync(db, "vv_executions", row.id, { ...input, version: bumpVersion(row), updated_by: actor?.id ?? null });
  await writeAuditAsync(db, { actor, action: "verification-validation.execution.update", resourceType: "vv_test_execution", resourceId: row.execution_ref, details: {}, ip });
  return publicExecution(await queryOneAsync(db, "SELECT * FROM vv_executions WHERE id = ?", [row.id]));
}

function executionTransitionPatch(target, actor, ts, { current, reason }) {
  const patch = { status: target, lifecycle_state: target, updated_by: actor?.id ?? null };
  if (target === "IN_PROGRESS" && !current.actual_start_at) patch.actual_start_at = ts;
  if (target === "COMPLETED") patch.actual_end_at = ts;
  if (target === "REQUIRES_RETEST") patch.retest_reason = normalizeText(reason, { max: 500 });
  return patch;
}

function assertExecutionTransition(row, to) {
  if (!EXECUTION_STATUSES.includes(to)) throw invalidVv(`Invalid execution status: ${to}`, { allowed: [...EXECUTION_STATUSES] });
  const allowed = DEFAULT_EXECUTION_TRANSITIONS[row.status] || [];
  if (!allowed.includes(to)) throw invalidTransition(row.status, to);
}

export function transitionExecution(db, tenantId, ref, target, { actor = null, ip = null, reason = "" } = {}) {
  const tenant = Number(tenantId);
  const row = requireExecutionRow(db, tenant, ref);
  const to = normalizeUpper(target);
  assertExecutionTransition(row, to);
  if (to === "COMPLETED") {
    const resultCount = Number(queryOne(db, "SELECT COUNT(*) AS c FROM vv_results WHERE execution_id = ?", [row.id])?.c || 0);
    if (resultCount === 0) throw incompleteExecution("An execution cannot complete without at least one recorded result", { execution_ref: row.execution_ref });
  }
  updateRow(db, "vv_executions", row.id, executionTransitionPatch(to, actor, nowIso(), { current: row, reason }));
  const updated = queryOne(db, "SELECT * FROM vv_executions WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "verification-validation.execution.transition", resourceType: "vv_test_execution", resourceId: row.execution_ref, details: { from: row.status, to, reason }, ip });
  if (to === "IN_PROGRESS") publishVvEvent(db, { eventType: "TestExecutionStarted", objectType: "test_execution", objectId: String(row.id), tenantId: tenant, payload: { execution_ref: row.execution_ref, test_case_id: row.test_case_id } }, actor);
  if (to === "COMPLETED") publishVvEvent(db, { eventType: "TestExecutionCompleted", objectType: "test_execution", objectId: String(row.id), tenantId: tenant, payload: { execution_ref: row.execution_ref, test_case_id: row.test_case_id } }, actor);
  return publicExecution(updated);
}

export async function transitionExecutionAsync(db, tenantId, ref, target, { actor = null, ip = null, reason = "" } = {}) {
  const tenant = Number(tenantId);
  const row = await requireExecutionRowAsync(db, tenant, ref);
  const to = normalizeUpper(target);
  assertExecutionTransition(row, to);
  if (to === "COMPLETED") {
    const resultCount = Number((await queryOneAsync(db, "SELECT COUNT(*) AS c FROM vv_results WHERE execution_id = ?", [row.id]))?.c || 0);
    if (resultCount === 0) throw incompleteExecution("An execution cannot complete without at least one recorded result", { execution_ref: row.execution_ref });
  }
  await updateRowAsync(db, "vv_executions", row.id, executionTransitionPatch(to, actor, nowIso(), { current: row, reason }));
  const updated = await queryOneAsync(db, "SELECT * FROM vv_executions WHERE id = ?", [row.id]);
  await writeAuditAsync(db, { actor, action: "verification-validation.execution.transition", resourceType: "vv_test_execution", resourceId: row.execution_ref, details: { from: row.status, to, reason }, ip });
  if (to === "IN_PROGRESS") await publishVvEventAsync(db, { eventType: "TestExecutionStarted", objectType: "test_execution", objectId: String(row.id), tenantId: tenant, payload: { execution_ref: row.execution_ref, test_case_id: row.test_case_id } }, actor);
  if (to === "COMPLETED") await publishVvEventAsync(db, { eventType: "TestExecutionCompleted", objectType: "test_execution", objectId: String(row.id), tenantId: tenant, payload: { execution_ref: row.execution_ref, test_case_id: row.test_case_id } }, actor);
  return publicExecution(updated);
}

export function startExecution(db, tenantId, ref, opts = {}) {
  const row = requireExecutionRow(db, Number(tenantId), ref);
  if (row.status === "PLANNED") transitionExecution(db, tenantId, ref, "READY", opts);
  return transitionExecution(db, tenantId, ref, "IN_PROGRESS", opts);
}

export async function startExecutionAsync(db, tenantId, ref, opts = {}) {
  const row = await requireExecutionRowAsync(db, Number(tenantId), ref);
  if (row.status === "PLANNED") await transitionExecutionAsync(db, tenantId, ref, "READY", opts);
  return transitionExecutionAsync(db, tenantId, ref, "IN_PROGRESS", opts);
}

export function completeExecution(db, tenantId, ref, opts = {}) {
  return transitionExecution(db, tenantId, ref, "COMPLETED", opts);
}

export async function completeExecutionAsync(db, tenantId, ref, opts = {}) {
  return transitionExecutionAsync(db, tenantId, ref, "COMPLETED", opts);
}

function retestSeeds(row) {
  return {
    organization_id: row.organization_id,
    test_case_id: row.test_case_id,
    test_case_revision: row.test_case_revision,
    procedure_id: row.procedure_id,
    procedure_revision: row.procedure_revision,
    requirement_ids_json: row.requirement_ids_json,
    product_object_type: row.product_object_type,
    product_object_id: row.product_object_id,
    configuration_context: row.configuration_context,
    effectivity: row.effectivity,
    tester_user_id: row.tester_user_id,
    reviewer_user_id: row.reviewer_user_id,
    planned_start_at: row.planned_start_at,
    planned_end_at: row.planned_end_at,
    environment_json: row.environment_json,
    equipment_json: row.equipment_json,
    input_parameters_json: row.input_parameters_json,
    notes: row.notes,
    previous_execution_id: row.id,
  };
}

export function requestRetest(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireExecutionRow(db, tenant, ref);
  if (!RETESTABLE_EXECUTION_STATUSES.includes(row.status)) {
    throw invalidVv(`A ${row.status} execution cannot be retested`, { execution_ref: row.execution_ref, status: row.status });
  }
  const number = normalizeText(body.execution_number ?? body.executionNumber ?? "", { max: 60 }) || nextNumber(db, { objectType: NUMBERING_OBJECT_TYPES.EXECUTION }, actor, { tenantId: tenant });
  const newRef = normalizeText(body.execution_ref ?? body.executionRef ?? "", { max: 80 }) || executionRef(number);
  const rt = retestSeeds(row);
  const created = insertExecution(db, {
    ...rt,
    execution_ref: newRef,
    tenant_id: tenant,
    retest_reason: normalizeText(body.reason ?? body.retest_reason ?? "", { max: 500 }),
    metadata_json: JSON.stringify({ retest_of: row.execution_ref }),
    actor_id: actor?.id ?? null,
    ts: nowIso(),
  });
  if (DEFAULT_EXECUTION_TRANSITIONS[row.status]?.includes("REQUIRES_RETEST")) {
    updateRow(db, "vv_executions", row.id, { status: "REQUIRES_RETEST", lifecycle_state: "REQUIRES_RETEST", retest_reason: normalizeText(body.reason ?? "", { max: 500 }), updated_by: actor?.id ?? null });
  }
  writeAudit(db, { actor, action: "verification-validation.execution.retest", resourceType: "vv_test_execution", resourceId: newRef, details: { previous_execution_ref: row.execution_ref }, ip });
  publishVvEvent(db, { eventType: "RetestRequested", objectType: "test_execution", objectId: String(created.id), tenantId: tenant, payload: { execution_ref: newRef, previous_execution_ref: row.execution_ref, reason: normalizeText(body.reason ?? "", { max: 500 }) } }, actor);
  return publicExecution(created);
}

export async function requestRetestAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireExecutionRowAsync(db, tenant, ref);
  if (!RETESTABLE_EXECUTION_STATUSES.includes(row.status)) {
    throw invalidVv(`A ${row.status} execution cannot be retested`, { execution_ref: row.execution_ref, status: row.status });
  }
  const number = normalizeText(body.execution_number ?? body.executionNumber ?? "", { max: 60 }) || (await nextNumberAsync(db, { objectType: NUMBERING_OBJECT_TYPES.EXECUTION }, actor, { tenantId: tenant }));
  const newRef = normalizeText(body.execution_ref ?? body.executionRef ?? "", { max: 80 }) || executionRef(number);
  const rt = retestSeeds(row);
  const values = {
    ...rt,
    execution_ref: newRef,
    tenant_id: tenant,
    retest_reason: normalizeText(body.reason ?? body.retest_reason ?? "", { max: 500 }),
    metadata_json: JSON.stringify({ retest_of: row.execution_ref }),
    actor_id: actor?.id ?? null,
    ts: nowIso(),
  };
  const result = await runAsync(
    db,
    `INSERT INTO vv_executions
       (execution_ref, tenant_id, organization_id, test_case_id, test_case_revision, procedure_id, procedure_revision, requirement_ids_json,
        product_object_type, product_object_id, configuration_context, effectivity, status, lifecycle_state,
        tester_user_id, reviewer_user_id, planned_start_at, planned_end_at, environment_json, equipment_json, input_parameters_json,
        notes, previous_execution_id, retest_reason, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PLANNED', 'PLANNED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      values.execution_ref, values.tenant_id, values.organization_id, values.test_case_id, values.test_case_revision, values.procedure_id, values.procedure_revision, values.requirement_ids_json,
      values.product_object_type, values.product_object_id, values.configuration_context, values.effectivity,
      values.tester_user_id, values.reviewer_user_id, values.planned_start_at, values.planned_end_at, values.environment_json, values.equipment_json, values.input_parameters_json,
      values.notes, values.previous_execution_id, values.retest_reason, values.metadata_json, values.actor_id, values.actor_id, values.ts, values.ts,
    ]
  );
  const created = await queryOneAsync(db, "SELECT * FROM vv_executions WHERE id = ?", [Number(result.lastInsertId)]);
  if (DEFAULT_EXECUTION_TRANSITIONS[row.status]?.includes("REQUIRES_RETEST")) {
    await updateRowAsync(db, "vv_executions", row.id, { status: "REQUIRES_RETEST", lifecycle_state: "REQUIRES_RETEST", retest_reason: normalizeText(body.reason ?? "", { max: 500 }), updated_by: actor?.id ?? null });
  }
  await writeAuditAsync(db, { actor, action: "verification-validation.execution.retest", resourceType: "vv_test_execution", resourceId: newRef, details: { previous_execution_ref: row.execution_ref }, ip });
  await publishVvEventAsync(db, { eventType: "RetestRequested", objectType: "test_execution", objectId: String(created.id), tenantId: tenant, payload: { execution_ref: newRef, previous_execution_ref: row.execution_ref, reason: normalizeText(body.reason ?? "", { max: 500 }) } }, actor);
  return publicExecution(created);
}

export function listExecutionRequirements(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const row = requireExecutionRow(db, tenant, ref);
  const ids = parseArray(row.requirement_ids_json, []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  const items = [];
  for (const id of ids) {
    const requirement = RequirementService.getRequirementRow(db, tenant, id);
    if (requirement) items.push({ id: requirement.id, requirement_ref: requirement.requirement_ref, title: requirement.title, status: requirement.status });
  }
  return { items, total: items.length, source_module: SOURCE_MODULE };
}

export async function listExecutionRequirementsAsync(db, tenantId, ref) {
  const tenant = Number(tenantId);
  const row = await requireExecutionRowAsync(db, tenant, ref);
  const ids = parseArray(row.requirement_ids_json, []).map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  const items = [];
  for (const id of ids) {
    const requirement = await RequirementService.getRequirementRowAsync(db, tenant, id);
    if (requirement) items.push({ id: requirement.id, requirement_ref: requirement.requirement_ref, title: requirement.title, status: requirement.status });
  }
  return { items, total: items.length, source_module: SOURCE_MODULE };
}

// Shared by the results service when it rolls execution outcome up after a result
// is evaluated; kept here so execution state has a single owner.
export function setExecutionOutcome(db, executionId, outcome) {
  const normalized = outcome && RESULT_OUTCOMES.includes(outcome) ? outcome : null;
  updateRow(db, "vv_executions", Number(executionId), { overall_outcome: normalized });
  return queryOne(db, "SELECT * FROM vv_executions WHERE id = ?", [Number(executionId)]);
}

export async function setExecutionOutcomeAsync(db, executionId, outcome) {
  const normalized = outcome && RESULT_OUTCOMES.includes(outcome) ? outcome : null;
  await updateRowAsync(db, "vv_executions", Number(executionId), { overall_outcome: normalized });
  return queryOneAsync(db, "SELECT * FROM vv_executions WHERE id = ?", [Number(executionId)]);
}
