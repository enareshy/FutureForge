// Failure / deviation / quality integration.
//
// V&V never builds a parallel quality subsystem. When a failure needs formal
// investigation this module opens an exception in the existing Data Governance
// quality module (`dg_quality_exceptions`) and stores only the returned reference
// on the execution/result; the exception lifecycle, assignment, SLA, comments,
// remediation and workflow stay owned by that engine. It likewise records
// references to existing Change / deviation records instead of creating them.
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { updateRow, updateRowAsync, bumpVersion } from "../requirements/sql.js";
import { normalizeText, normalizeUpper, paginate, parseObject } from "../data-lifecycle/validation.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { createException, createExceptionAsync } from "../data-governance/exceptions.js";
import { publishVvEvent, publishVvEventAsync } from "./events.js";
import { getConfig, getConfigAsync } from "./configuration.js";
import { requireExecutionRow, requireExecutionRowAsync } from "./test-executions.js";
import { requireResultRow, requireResultRowAsync } from "./test-results.js";
import { requireWaiverRow, requireWaiverRowAsync } from "./waivers.js";
import { QUALITY_MODULE, SOURCE_MODULE } from "./constants.js";
import { invalidVv } from "./errors.js";

function targetRef(body = {}) {
  if (body.result_ref || body.resultRef || body.result_id || body.resultId) {
    return { kind: "result", ref: body.result_ref ?? body.resultRef ?? body.result_id ?? body.resultId };
  }
  if (body.execution_ref || body.executionRef || body.execution_id || body.executionId) {
    return { kind: "execution", ref: body.execution_ref ?? body.executionRef ?? body.execution_id ?? body.executionId };
  }
  throw invalidVv("A result or execution reference is required");
}

function resolveTarget(db, tenant, body) {
  const { kind, ref } = targetRef(body);
  return kind === "result" ? { kind, row: requireResultRow(db, tenant, ref) } : { kind, row: requireExecutionRow(db, tenant, ref) };
}

async function resolveTargetAsync(db, tenant, body) {
  const { kind, ref } = targetRef(body);
  return kind === "result" ? { kind, row: await requireResultRowAsync(db, tenant, ref) } : { kind, row: await requireExecutionRowAsync(db, tenant, ref) };
}

function detectFailure(db, tenant, target) {
  if (target.kind === "result") {
    if (target.row.outcome !== "FAIL") throw invalidVv("Only a failed result can raise a quality exception", { result_ref: target.row.result_ref, outcome: target.row.outcome });
    return { detected_value: target.row.actual_value, expected_value: target.row.expected_value, failure_reason: target.row.failure_reason };
  }
  const failedResults = queryAll(db, "SELECT * FROM vv_results WHERE tenant_id = ? AND execution_id = ? AND outcome = 'FAIL' ORDER BY id", [Number(tenant), Number(target.row.id)]);
  if (target.row.overall_outcome !== "FAIL" && target.row.status !== "FAILED" && failedResults.length === 0) {
    throw invalidVv("Only a failed execution can raise a quality exception", { execution_ref: target.row.execution_ref, overall_outcome: target.row.overall_outcome, status: target.row.status });
  }
  const first = failedResults[0] || null;
  return {
    detected_value: first?.actual_value ?? "",
    expected_value: first?.expected_value ?? "",
    failure_reason: first?.failure_reason ?? target.row.retest_reason ?? "",
    failed_result_refs: failedResults.map((r) => r.result_ref),
  };
}

async function detectFailureAsync(db, tenant, target) {
  if (target.kind === "result") {
    if (target.row.outcome !== "FAIL") throw invalidVv("Only a failed result can raise a quality exception", { result_ref: target.row.result_ref, outcome: target.row.outcome });
    return { detected_value: target.row.actual_value, expected_value: target.row.expected_value, failure_reason: target.row.failure_reason };
  }
  const failedResults = await queryAllAsync(db, "SELECT * FROM vv_results WHERE tenant_id = ? AND execution_id = ? AND outcome = 'FAIL' ORDER BY id", [Number(tenant), Number(target.row.id)]);
  if (target.row.overall_outcome !== "FAIL" && target.row.status !== "FAILED" && failedResults.length === 0) {
    throw invalidVv("Only a failed execution can raise a quality exception", { execution_ref: target.row.execution_ref, overall_outcome: target.row.overall_outcome, status: target.row.status });
  }
  const first = failedResults[0] || null;
  return {
    detected_value: first?.actual_value ?? "",
    expected_value: first?.expected_value ?? "",
    failure_reason: first?.failure_reason ?? target.row.retest_reason ?? "",
    failed_result_refs: failedResults.map((r) => r.result_ref),
  };
}

function exceptionInput(kind, row, body, failure, severity) {
  const objectType = kind === "result" ? "vv_test_result" : "vv_test_execution";
  const objectId = kind === "result" ? row.result_ref : row.execution_ref;
  return {
    object_type: objectType,
    object_id: objectId,
    rule_code: normalizeUpper(body.rule_code ?? body.ruleCode ?? "VV_VERIFICATION_FAILED"),
    dimension: normalizeText(body.dimension ?? QUALITY_MODULE.default_dimension, { max: 60 }).toLowerCase(),
    severity: normalizeText(body.severity ?? severity, { max: 30 }).toLowerCase(),
    priority: body.priority ? normalizeText(body.priority, { max: 30 }).toLowerCase() : undefined,
    description: normalizeText(body.description ?? `${failure.failure_reason || "Verification failure"} (${objectId})`, { max: 4000 }),
    detected_value: normalizeText(body.detected_value ?? body.detectedValue ?? failure.detected_value, { max: 400 }),
    expected_value: normalizeText(body.expected_value ?? body.expectedValue ?? failure.expected_value, { max: 400 }),
    organization_id: body.organization_id ?? row.organization_id ?? null,
    owner_user_id: body.owner_user_id ?? body.ownerUserId ?? null,
    comment: normalizeText(body.comment, { max: 2000 }) || "Raised from a V&V failure",
  };
}

export function raiseQualityException(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const target = resolveTarget(db, tenant, body);
  const failure = detectFailure(db, tenant, target);
  const severity = getConfig(db, tenant, "quality_exception_severity") || QUALITY_MODULE.default_severity;
  const exception = createException(db, exceptionInput(target.kind, target.row, body, failure, severity), actor, tenant, ip);
  if (target.kind === "result") {
    updateRow(db, "vv_results", target.row.id, { quality_exception_ref: exception.exception_ref, quality_exception_id: exception.id, version: bumpVersion(target.row), updated_by: actor?.id ?? null }, { columns: ["quality_exception_ref", "quality_exception_id", "version", "updated_by"] });
  }
  if (target.kind === "execution") {
    updateRow(db, "vv_executions", target.row.id, { quality_exception_ref: exception.exception_ref, quality_exception_id: exception.id, version: bumpVersion(target.row), updated_by: actor?.id ?? null }, { columns: ["quality_exception_ref", "quality_exception_id", "version", "updated_by"] });
  }
  const targetRefValue = target.kind === "result" ? target.row.result_ref : target.row.execution_ref;
  writeAudit(db, { actor, action: "verification-validation.failure.raise-quality-exception", resourceType: target.kind === "result" ? "vv_test_result" : "vv_test_execution", resourceId: targetRefValue, details: { exception_ref: exception.exception_ref, rule_code: exception.rule_code, severity }, ip });
  publishVvEvent(db, { eventType: "QualityExceptionRaised", objectType: target.kind === "result" ? "test_result" : "test_execution", objectId: String(target.row.id), tenantId: tenant, organizationId: target.row.organization_id, payload: { object_ref: targetRefValue, exception_ref: exception.exception_ref, severity, failure_reason: failure.failure_reason } }, actor);
  return { target: { kind: target.kind, ref: targetRefValue }, exception };
}

export async function raiseQualityExceptionAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const target = await resolveTargetAsync(db, tenant, body);
  const failure = await detectFailureAsync(db, tenant, target);
  const severity = (await getConfigAsync(db, tenant, "quality_exception_severity")) || QUALITY_MODULE.default_severity;
  const exception = await createExceptionAsync(db, exceptionInput(target.kind, target.row, body, failure, severity), actor, tenant, ip);
  if (target.kind === "result") {
    await updateRowAsync(db, "vv_results", target.row.id, { quality_exception_ref: exception.exception_ref, quality_exception_id: exception.id, version: bumpVersion(target.row), updated_by: actor?.id ?? null }, { columns: ["quality_exception_ref", "quality_exception_id", "version", "updated_by"] });
  }
  if (target.kind === "execution") {
    await updateRowAsync(db, "vv_executions", target.row.id, { quality_exception_ref: exception.exception_ref, quality_exception_id: exception.id, version: bumpVersion(target.row), updated_by: actor?.id ?? null }, { columns: ["quality_exception_ref", "quality_exception_id", "version", "updated_by"] });
  }
  const targetRefValue = target.kind === "result" ? target.row.result_ref : target.row.execution_ref;
  await writeAuditAsync(db, { actor, action: "verification-validation.failure.raise-quality-exception", resourceType: target.kind === "result" ? "vv_test_result" : "vv_test_execution", resourceId: targetRefValue, details: { exception_ref: exception.exception_ref, rule_code: exception.rule_code, severity }, ip });
  await publishVvEventAsync(db, { eventType: "QualityExceptionRaised", objectType: target.kind === "result" ? "test_result" : "test_execution", objectId: String(target.row.id), tenantId: tenant, organizationId: target.row.organization_id, payload: { object_ref: targetRefValue, exception_ref: exception.exception_ref, severity, failure_reason: failure.failure_reason } }, actor);
  return { target: { kind: target.kind, ref: targetRefValue }, exception };
}

export function linkIndependentRecords(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const changeRef = normalizeText(body.change_ref ?? body.changeRef ?? body.related_change_ref ?? body.relatedChangeRef, { max: 120 });
  const deviationRef = normalizeText(body.deviation_ref ?? body.deviationRef ?? body.related_deviation_ref ?? body.relatedDeviationRef, { max: 120 });
  if (!changeRef && !deviationRef) throw invalidVv("A change_ref or deviation_ref is required");
  if (body.waiver_ref || body.waiverRef || body.waiver_id || body.waiverId) {
    const waiver = requireWaiverRow(db, tenant, body.waiver_ref ?? body.waiverRef ?? body.waiver_id ?? body.waiverId);
    const patch = { version: bumpVersion(waiver), updated_by: actor?.id ?? null };
    if (changeRef) patch.related_change_ref = changeRef;
    if (deviationRef) patch.related_deviation_ref = deviationRef;
    updateRow(db, "vv_waivers", waiver.id, patch, { columns: ["related_change_ref", "related_deviation_ref", "version", "updated_by"] });
    writeAudit(db, { actor, action: "verification-validation.waiver.link-records", resourceType: "vv_waiver", resourceId: waiver.waiver_ref, details: { change_ref: changeRef, deviation_ref: deviationRef }, ip });
    return { kind: "waiver", ref: waiver.waiver_ref, change_ref: changeRef, deviation_ref: deviationRef };
  }
  const target = resolveTarget(db, tenant, body);
  const metadata = parseObject(target.row.metadata_json, {});
  metadata.change_references = [...new Set([...(metadata.change_references || []), ...(changeRef ? [changeRef] : [])])];
  metadata.deviation_references = [...new Set([...(metadata.deviation_references || []), ...(deviationRef ? [deviationRef] : [])])];
  const table = target.kind === "result" ? "vv_results" : "vv_executions";
  updateRow(db, table, target.row.id, { metadata_json: JSON.stringify(metadata), version: bumpVersion(target.row), updated_by: actor?.id ?? null }, { columns: ["metadata_json", "version", "updated_by"] });
  const ref = target.kind === "result" ? target.row.result_ref : target.row.execution_ref;
  writeAudit(db, { actor, action: "verification-validation.failure.link-records", resourceType: target.kind === "result" ? "vv_test_result" : "vv_test_execution", resourceId: ref, details: { change_ref: changeRef, deviation_ref: deviationRef }, ip });
  return { kind: target.kind, ref, change_ref: changeRef, deviation_ref: deviationRef };
}

export async function linkIndependentRecordsAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const changeRef = normalizeText(body.change_ref ?? body.changeRef ?? body.related_change_ref ?? body.relatedChangeRef, { max: 120 });
  const deviationRef = normalizeText(body.deviation_ref ?? body.deviationRef ?? body.related_deviation_ref ?? body.relatedDeviationRef, { max: 120 });
  if (!changeRef && !deviationRef) throw invalidVv("A change_ref or deviation_ref is required");
  if (body.waiver_ref || body.waiverRef || body.waiver_id || body.waiverId) {
    const waiver = await requireWaiverRowAsync(db, tenant, body.waiver_ref ?? body.waiverRef ?? body.waiver_id ?? body.waiverId);
    const patch = { version: bumpVersion(waiver), updated_by: actor?.id ?? null };
    if (changeRef) patch.related_change_ref = changeRef;
    if (deviationRef) patch.related_deviation_ref = deviationRef;
    await updateRowAsync(db, "vv_waivers", waiver.id, patch, { columns: ["related_change_ref", "related_deviation_ref", "version", "updated_by"] });
    await writeAuditAsync(db, { actor, action: "verification-validation.waiver.link-records", resourceType: "vv_waiver", resourceId: waiver.waiver_ref, details: { change_ref: changeRef, deviation_ref: deviationRef }, ip });
    return { kind: "waiver", ref: waiver.waiver_ref, change_ref: changeRef, deviation_ref: deviationRef };
  }
  const target = await resolveTargetAsync(db, tenant, body);
  const metadata = parseObject(target.row.metadata_json, {});
  metadata.change_references = [...new Set([...(metadata.change_references || []), ...(changeRef ? [changeRef] : [])])];
  metadata.deviation_references = [...new Set([...(metadata.deviation_references || []), ...(deviationRef ? [deviationRef] : [])])];
  const table = target.kind === "result" ? "vv_results" : "vv_executions";
  await updateRowAsync(db, table, target.row.id, { metadata_json: JSON.stringify(metadata), version: bumpVersion(target.row), updated_by: actor?.id ?? null }, { columns: ["metadata_json", "version", "updated_by"] });
  const ref = target.kind === "result" ? target.row.result_ref : target.row.execution_ref;
  await writeAuditAsync(db, { actor, action: "verification-validation.failure.link-records", resourceType: target.kind === "result" ? "vv_test_result" : "vv_test_execution", resourceId: ref, details: { change_ref: changeRef, deviation_ref: deviationRef }, ip });
  return { kind: target.kind, ref, change_ref: changeRef, deviation_ref: deviationRef };
}

function failureFilters({ tenantId, test_case_id, execution_id, requirement_id } = {}) {
  const clauses = ["tenant_id = ?", "(overall_outcome = 'FAIL' OR status = 'FAILED')"];
  const params = [Number(tenantId)];
  if (test_case_id !== undefined && test_case_id !== null && test_case_id !== "") {
    clauses.push("test_case_id = ?");
    params.push(Number(test_case_id));
  }
  if (execution_id !== undefined && execution_id !== null && execution_id !== "") {
    clauses.push("id = ?");
    params.push(Number(execution_id));
  }
  if (requirement_id !== undefined && requirement_id !== null && requirement_id !== "") {
    clauses.push("requirement_ids_json LIKE ?");
    params.push(`%${Number(requirement_id)}%`);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listFailures(db, tenantId, opts = {}) {
  const { where, params } = failureFilters({ tenantId, ...opts });
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM vv_executions ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM vv_executions ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      execution_ref: row.execution_ref,
      test_case_id: row.test_case_id ?? null,
      status: row.status,
      overall_outcome: row.overall_outcome ?? null,
      retest_reason: row.retest_reason,
      quality_exception_ref: row.quality_exception_ref || null,
      previous_execution_id: row.previous_execution_id ?? null,
      created_at: row.created_at,
    })),
    total,
    page,
    page_size: limit,
    source_module: SOURCE_MODULE,
  };
}

export async function listFailuresAsync(db, tenantId, opts = {}) {
  const { where, params } = failureFilters({ tenantId, ...opts });
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM vv_executions ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM vv_executions ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return {
    items: rows.map((row) => ({
      id: row.id,
      execution_ref: row.execution_ref,
      test_case_id: row.test_case_id ?? null,
      status: row.status,
      overall_outcome: row.overall_outcome ?? null,
      retest_reason: row.retest_reason,
      quality_exception_ref: row.quality_exception_ref || null,
      previous_execution_id: row.previous_execution_id ?? null,
      created_at: row.created_at,
    })),
    total,
    page,
    page_size: limit,
    source_module: SOURCE_MODULE,
  };
}

export function failureSummary(db, tenantId) {
  const tenant = Number(tenantId);
  const executions = Number(queryOne(db, "SELECT COUNT(*) AS c FROM vv_executions WHERE tenant_id = ? AND (overall_outcome = 'FAIL' OR status = 'FAILED')", [tenant])?.c || 0);
  const results = Number(queryOne(db, "SELECT COUNT(*) AS c FROM vv_results WHERE tenant_id = ? AND outcome = 'FAIL'", [tenant])?.c || 0);
  const withException = Number(queryOne(db, "SELECT COUNT(*) AS c FROM vv_executions WHERE tenant_id = ? AND quality_exception_ref != ''", [tenant])?.c || 0);
  const retests = Number(queryOne(db, "SELECT COUNT(*) AS c FROM vv_executions WHERE tenant_id = ? AND previous_execution_id IS NOT NULL", [tenant])?.c || 0);
  return { failed_executions: executions, failed_results: results, executions_with_quality_exception: withException, retest_executions: retests, source_module: SOURCE_MODULE };
}

export async function failureSummaryAsync(db, tenantId) {
  const tenant = Number(tenantId);
  const executions = Number((await queryOneAsync(db, "SELECT COUNT(*) AS c FROM vv_executions WHERE tenant_id = ? AND (overall_outcome = 'FAIL' OR status = 'FAILED')", [tenant]))?.c || 0);
  const results = Number((await queryOneAsync(db, "SELECT COUNT(*) AS c FROM vv_results WHERE tenant_id = ? AND outcome = 'FAIL'", [tenant]))?.c || 0);
  const withException = Number((await queryOneAsync(db, "SELECT COUNT(*) AS c FROM vv_executions WHERE tenant_id = ? AND quality_exception_ref != ''", [tenant]))?.c || 0);
  const retests = Number((await queryOneAsync(db, "SELECT COUNT(*) AS c FROM vv_executions WHERE tenant_id = ? AND previous_execution_id IS NOT NULL", [tenant]))?.c || 0);
  return { failed_executions: executions, failed_results: results, executions_with_quality_exception: withException, retest_executions: retests, source_module: SOURCE_MODULE };
}
