// Waiver / exception service.
//
// A waiver is a controlled, authorized exception for a requirement (and/or a
// specific test case, execution or failed result) that cannot be satisfied
// through the normal process. Waivers are approved through authorized lifecycle
// transitions (the same authorization model used to approve test cases and
// requirements); when a workflow instance id is supplied it is stored for linkage
// rather than building a parallel approval engine. Expired, revoked and rejected
// waivers never count as a valid exception and are never represented as a passed
// verification. Coverage/status always stays owned by the coverage engine: a valid
// waiver yields the distinct `WAIVED` state (mirrors requirements/requirements.js).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { nextNumber, nextNumberAsync } from "../numbering.js";
import { updateRow, updateRowAsync, bumpVersion } from "../requirements/sql.js";
import { normalizeText, normalizeUpper, paginate, parseObject, toIntOrNull } from "../data-lifecycle/validation.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { Requirements as RequirementService } from "../requirements/index.js";
import { publishVvEvent, publishVvEventAsync } from "./events.js";
import { getConfig, getConfigAsync } from "./configuration.js";
import { recalculateRequirement, recalculateRequirementAsync } from "./coverage.js";
import { requireTestCaseRow, requireTestCaseRowAsync } from "./test-cases.js";
import { requireExecutionRow, requireExecutionRowAsync } from "./test-executions.js";
import { requireResultRow, requireResultRowAsync } from "./test-results.js";
import { waiverRef } from "./refs.js";
import {
  SOURCE_MODULE,
  NUMBERING_OBJECT_TYPES,
  WAIVER_STATUSES,
  DEFAULT_WAIVER_TRANSITIONS,
  ACTIVE_WAIVER_STATUSES,
} from "./constants.js";
import { waiverNotFound, invalidVv, invalidTransition, waiverInvalid, requirementNotFound } from "./errors.js";

const EDITABLE_WAIVER_STATUSES = ["REQUESTED"];

const UPDATE_COLUMNS = ["organization_id", "justification", "risk_assessment", "scope", "applicability_json", "requested_from", "expires_at", "approver_user_id", "conditions", "related_change_ref", "related_deviation_ref", "quality_exception_ref", "quality_exception_id", "workflow_instance_id", "metadata_json"];

export function publicWaiver(row) {
  if (!row) return null;
  return {
    id: row.id,
    waiver_ref: row.waiver_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    requirement_id: row.requirement_id ?? null,
    requirement_revision: row.requirement_revision,
    test_case_id: row.test_case_id ?? null,
    execution_id: row.execution_id ?? null,
    result_id: row.result_id ?? null,
    justification: row.justification,
    risk_assessment: row.risk_assessment,
    scope: row.scope,
    applicability: parseObject(row.applicability_json, {}),
    requested_from: row.requested_from ?? null,
    expires_at: row.expires_at ?? null,
    requested_by: row.requested_by ?? null,
    approver_user_id: row.approver_user_id ?? null,
    decided_by: row.decided_by ?? null,
    decided_at: row.decided_at ?? null,
    decision_notes: row.decision_notes,
    conditions: row.conditions,
    related_change_ref: row.related_change_ref,
    related_deviation_ref: row.related_deviation_ref,
    quality_exception_ref: row.quality_exception_ref,
    quality_exception_id: row.quality_exception_id ?? null,
    status: row.status,
    workflow_instance_id: row.workflow_instance_id ?? null,
    metadata: parseObject(row.metadata_json, {}),
    version: Number(row.version || 1),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function isWaiverExpired(row, at = nowIso()) {
  if (!row || !row.expires_at) return false;
  const expiry = Date.parse(String(row.expires_at).replace(" ", "T"));
  if (Number.isNaN(expiry)) return false;
  return expiry < Date.parse(String(at).replace(" ", "T"));
}

export function isWaiverValid(row, at = nowIso()) {
  if (!row) return false;
  return ACTIVE_WAIVER_STATUSES.includes(row.status) && !isWaiverExpired(row, at);
}

export function waiverFilters({ tenantId, status, requirement_id, test_case_id, execution_id, result_id, valid_only } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (requirement_id !== undefined && requirement_id !== null && requirement_id !== "") {
    clauses.push("requirement_id = ?");
    params.push(Number(requirement_id));
  }
  if (test_case_id !== undefined && test_case_id !== null && test_case_id !== "") {
    clauses.push("test_case_id = ?");
    params.push(Number(test_case_id));
  }
  if (execution_id !== undefined && execution_id !== null && execution_id !== "") {
    clauses.push("execution_id = ?");
    params.push(Number(execution_id));
  }
  if (result_id !== undefined && result_id !== null && result_id !== "") {
    clauses.push("result_id = ?");
    params.push(Number(result_id));
  }
  if (valid_only) {
    clauses.push(`status IN (${ACTIVE_WAIVER_STATUSES.map(() => "?").join(", ")})`);
    params.push(...ACTIVE_WAIVER_STATUSES);
    clauses.push("(expires_at IS NULL OR expires_at = '' OR expires_at >= ?)");
    params.push(nowIso());
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function requireWaiverRow(db, tenantId, ref) {
  const row = queryOne(db, "SELECT * FROM vv_waivers WHERE tenant_id = ? AND (waiver_ref = ? OR id = ?)", [Number(tenantId), String(ref), Number(ref) || -1]);
  if (!row) throw waiverNotFound(ref);
  return row;
}

export async function requireWaiverRowAsync(db, tenantId, ref) {
  const row = await queryOneAsync(db, "SELECT * FROM vv_waivers WHERE tenant_id = ? AND (waiver_ref = ? OR id = ?)", [Number(tenantId), String(ref), Number(ref) || -1]);
  if (!row) throw waiverNotFound(ref);
  return row;
}

export function getWaiver(db, tenantId, ref) {
  return publicWaiver(requireWaiverRow(db, tenantId, ref));
}

export async function getWaiverAsync(db, tenantId, ref) {
  return publicWaiver(await requireWaiverRowAsync(db, tenantId, ref));
}

function resolveRequirement(db, tenant, body) {
  const ref = body.requirement_id ?? body.requirementId ?? body.requirement_ref ?? body.requirementRef ?? body.requirement ?? null;
  if (ref === undefined || ref === null || String(ref).trim() === "") throw waiverInvalid("A waiver must reference a requirement");
  const row = RequirementService.getRequirementRow(db, tenant, ref);
  if (!row) throw requirementNotFound(ref);
  return row;
}

async function resolveRequirementAsync(db, tenant, body) {
  const ref = body.requirement_id ?? body.requirementId ?? body.requirement_ref ?? body.requirementRef ?? body.requirement ?? null;
  if (ref === undefined || ref === null || String(ref).trim() === "") throw waiverInvalid("A waiver must reference a requirement");
  const row = await RequirementService.getRequirementRowAsync(db, tenant, ref);
  if (!row) throw requirementNotFound(ref);
  return row;
}

function optionalId(value) {
  if (value === undefined || value === null || value === "") return null;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function normalizeInput(body = {}) {
  return {
    justification: normalizeText(body.justification ?? body.reason, { max: 4000 }),
    risk_assessment: normalizeText(body.risk_assessment ?? body.riskAssessment, { max: 4000 }),
    scope: normalizeText(body.scope, { max: 400 }),
    applicability_json: JSON.stringify(parseObject(body.applicability, {})),
    requested_from: normalizeText(body.requested_from ?? body.requestedFrom, { max: 40 }) || null,
    expires_at: normalizeText(body.expires_at ?? body.expiresAt, { max: 40 }) || null,
    approver_user_id: toIntOrNull(body.approver_user_id ?? body.approverUserId),
    conditions: normalizeText(body.conditions, { max: 2000 }),
    related_change_ref: normalizeText(body.related_change_ref ?? body.relatedChangeRef, { max: 120 }),
    related_deviation_ref: normalizeText(body.related_deviation_ref ?? body.relatedDeviationRef, { max: 120 }),
    workflow_instance_id: optionalId(body.workflow_instance_id ?? body.workflowInstanceId),
    metadata_json: JSON.stringify(parseObject(body.metadata, {})),
    organization_id: toIntOrNull(body.organization_id ?? body.organizationId),
  };
}

function presentRef(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

export function createWaiver(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  if (!getConfig(db, tenant, "waivers_enabled")) throw invalidVv("Waivers are disabled for this tenant");
  const requirement = resolveRequirement(db, tenant, body);
  const testCase = presentRef(body.test_case_id ?? body.testCaseId) ? requireTestCaseRow(db, tenant, body.test_case_id ?? body.testCaseId) : null;
  const execution = presentRef(body.execution_id ?? body.executionId) ? requireExecutionRow(db, tenant, body.execution_id ?? body.executionId) : null;
  const result = presentRef(body.result_id ?? body.resultId) ? requireResultRow(db, tenant, body.result_id ?? body.resultId) : null;
  if (!normalizeText(body.justification ?? body.reason, { max: 4000 })) throw waiverInvalid("A waiver requires a justification");
  const expiresAt = normalizeText(body.expires_at ?? body.expiresAt, { max: 40 }) || null;
  if (expiresAt && Number.isNaN(Date.parse(expiresAt.replace(" ", "T")))) throw waiverInvalid("expires_at must be a valid date");

  const number = normalizeText(body.waiver_number ?? body.waiverNumber ?? "", { max: 60 }) || nextNumber(db, { objectType: NUMBERING_OBJECT_TYPES.WAIVER }, actor, { tenantId: tenant });
  const newRef = normalizeText(body.waiver_ref ?? body.waiverRef ?? "", { max: 80 }) || waiverRef(number);
  const input = normalizeInput(body);
  const requireApproval = Boolean(getConfig(db, tenant, "waiver_require_approval"));
  const status = requireApproval ? "REQUESTED" : "APPROVED";
  const ts = nowIso();
  const decided = requireApproval ? null : ts;
  const result2 = run(
    db,
    `INSERT INTO vv_waivers
       (waiver_ref, tenant_id, organization_id, requirement_id, requirement_revision, test_case_id, execution_id, result_id,
        justification, risk_assessment, scope, applicability_json, requested_from, expires_at, requested_by, approver_user_id,
        decided_by, decided_at, decision_notes, conditions, related_change_ref, related_deviation_ref, quality_exception_ref,
        quality_exception_id, status, workflow_instance_id, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, '', NULL, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      newRef, tenant, input.organization_id ?? requirement.organization_id ?? null, requirement.id, requirement.current_revision ?? requirement.revision ?? "", testCase?.id ?? null, execution?.id ?? null, result?.id ?? null,
      input.justification, input.risk_assessment, input.scope, input.applicability_json, input.requested_from, expiresAt, actor?.id ?? null, input.approver_user_id,
      decided ? actor?.id ?? null : null, decided, input.conditions, input.related_change_ref, input.related_deviation_ref,
      status, input.workflow_instance_id, input.metadata_json, actor?.id ?? null, actor?.id ?? null, ts, ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM vv_waivers WHERE id = ?", [Number(result2.lastInsertId)]);
  writeAudit(db, { actor, action: "verification-validation.waiver.create", resourceType: "vv_waiver", resourceId: newRef, details: { requirement_ref: requirement.requirement_ref, status }, ip });
  publishVvEvent(db, { eventType: "WaiverRequested", objectType: "waiver", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { waiver_ref: newRef, requirement_ref: requirement.requirement_ref, status } }, actor);
  if (status === "APPROVED") {
    publishVvEvent(db, { eventType: "WaiverApproved", objectType: "waiver", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { waiver_ref: newRef, requirement_ref: requirement.requirement_ref, auto_approved: true } }, actor);
  }
  recalculateRequirement(db, tenant, requirement.id, actor, ip);
  return publicWaiver(row);
}

export async function createWaiverAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  if (!(await getConfigAsync(db, tenant, "waivers_enabled"))) throw invalidVv("Waivers are disabled for this tenant");
  const requirement = await resolveRequirementAsync(db, tenant, body);
  const testCase = presentRef(body.test_case_id ?? body.testCaseId) ? await requireTestCaseRowAsync(db, tenant, body.test_case_id ?? body.testCaseId) : null;
  const execution = presentRef(body.execution_id ?? body.executionId) ? await requireExecutionRowAsync(db, tenant, body.execution_id ?? body.executionId) : null;
  const result = presentRef(body.result_id ?? body.resultId) ? await requireResultRowAsync(db, tenant, body.result_id ?? body.resultId) : null;
  if (!normalizeText(body.justification ?? body.reason, { max: 4000 })) throw waiverInvalid("A waiver requires a justification");
  const expiresAt = normalizeText(body.expires_at ?? body.expiresAt, { max: 40 }) || null;
  if (expiresAt && Number.isNaN(Date.parse(expiresAt.replace(" ", "T")))) throw waiverInvalid("expires_at must be a valid date");

  const number = normalizeText(body.waiver_number ?? body.waiverNumber ?? "", { max: 60 }) || (await nextNumberAsync(db, { objectType: NUMBERING_OBJECT_TYPES.WAIVER }, actor, { tenantId: tenant }));
  const newRef = normalizeText(body.waiver_ref ?? body.waiverRef ?? "", { max: 80 }) || waiverRef(number);
  const input = normalizeInput(body);
  const requireApproval = Boolean(await getConfigAsync(db, tenant, "waiver_require_approval"));
  const status = requireApproval ? "REQUESTED" : "APPROVED";
  const ts = nowIso();
  const decided = requireApproval ? null : ts;
  const insert = await runAsync(
    db,
    `INSERT INTO vv_waivers
       (waiver_ref, tenant_id, organization_id, requirement_id, requirement_revision, test_case_id, execution_id, result_id,
        justification, risk_assessment, scope, applicability_json, requested_from, expires_at, requested_by, approver_user_id,
        decided_by, decided_at, decision_notes, conditions, related_change_ref, related_deviation_ref, quality_exception_ref,
        quality_exception_id, status, workflow_instance_id, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, '', NULL, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      newRef, tenant, input.organization_id ?? requirement.organization_id ?? null, requirement.id, requirement.current_revision ?? requirement.revision ?? "", testCase?.id ?? null, execution?.id ?? null, result?.id ?? null,
      input.justification, input.risk_assessment, input.scope, input.applicability_json, input.requested_from, expiresAt, actor?.id ?? null, input.approver_user_id,
      decided ? actor?.id ?? null : null, decided, input.conditions, input.related_change_ref, input.related_deviation_ref,
      status, input.workflow_instance_id, input.metadata_json, actor?.id ?? null, actor?.id ?? null, ts, ts,
    ]
  );
  const row = await queryOneAsync(db, "SELECT * FROM vv_waivers WHERE id = ?", [Number(insert.lastInsertId)]);
  await writeAuditAsync(db, { actor, action: "verification-validation.waiver.create", resourceType: "vv_waiver", resourceId: newRef, details: { requirement_ref: requirement.requirement_ref, status }, ip });
  await publishVvEventAsync(db, { eventType: "WaiverRequested", objectType: "waiver", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { waiver_ref: newRef, requirement_ref: requirement.requirement_ref, status } }, actor);
  if (status === "APPROVED") {
    await publishVvEventAsync(db, { eventType: "WaiverApproved", objectType: "waiver", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { waiver_ref: newRef, requirement_ref: requirement.requirement_ref, auto_approved: true } }, actor);
  }
  await recalculateRequirementAsync(db, tenant, requirement.id, actor, ip);
  return publicWaiver(row);
}

export function updateWaiver(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireWaiverRow(db, tenant, ref);
  if (!EDITABLE_WAIVER_STATUSES.includes(row.status)) throw invalidVv(`A ${row.status} waiver cannot be edited`, { waiver_ref: row.waiver_ref, status: row.status });
  const patch = {};
  const input = normalizeInput(body);
  for (const [key, value] of Object.entries(input)) {
    if (key === "justification" && !value) continue;
    patch[key] = value;
  }
  if (patch.expires_at && Number.isNaN(Date.parse(patch.expires_at.replace(" ", "T")))) throw waiverInvalid("expires_at must be a valid date");
  patch.version = bumpVersion(row);
  patch.updated_by = actor?.id ?? null;
  updateRow(db, "vv_waivers", row.id, patch, { columns: UPDATE_COLUMNS.concat(["version", "updated_by"]) });
  writeAudit(db, { actor, action: "verification-validation.waiver.update", resourceType: "vv_waiver", resourceId: row.waiver_ref, details: {}, ip });
  return getWaiver(db, tenant, row.waiver_ref);
}

export async function updateWaiverAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireWaiverRowAsync(db, tenant, ref);
  if (!EDITABLE_WAIVER_STATUSES.includes(row.status)) throw invalidVv(`A ${row.status} waiver cannot be edited`, { waiver_ref: row.waiver_ref, status: row.status });
  const patch = {};
  const input = normalizeInput(body);
  for (const [key, value] of Object.entries(input)) {
    if (key === "justification" && !value) continue;
    patch[key] = value;
  }
  if (patch.expires_at && Number.isNaN(Date.parse(patch.expires_at.replace(" ", "T")))) throw waiverInvalid("expires_at must be a valid date");
  patch.version = bumpVersion(row);
  patch.updated_by = actor?.id ?? null;
  await updateRowAsync(db, "vv_waivers", row.id, patch, { columns: UPDATE_COLUMNS.concat(["version", "updated_by"]) });
  await writeAuditAsync(db, { actor, action: "verification-validation.waiver.update", resourceType: "vv_waiver", resourceId: row.waiver_ref, details: {}, ip });
  return getWaiverAsync(db, tenant, row.waiver_ref);
}

function transitionEvent(status) {
  if (status === "APPROVED") return "WaiverApproved";
  if (status === "REJECTED" || status === "REVOKED" || status === "EXPIRED") return "WaiverRevoked";
  return null;
}

export function transitionWaiver(db, tenantId, ref, target, { actor = null, ip = null, reason = "", conditions = "" } = {}) {
  const tenant = Number(tenantId);
  const row = requireWaiverRow(db, tenant, ref);
  const to = normalizeUpper(target);
  if (!WAIVER_STATUSES.includes(to)) throw invalidVv(`Invalid waiver status: ${to}`, { allowed: [...WAIVER_STATUSES] });
  if (!(DEFAULT_WAIVER_TRANSITIONS[row.status] || []).includes(to)) throw invalidTransition(row.status, to);
  const patch = { status: to, version: bumpVersion(row), updated_by: actor?.id ?? null };
  if (to === "APPROVED") {
    patch.decided_by = actor?.id ?? null;
    patch.decided_at = nowIso();
    patch.decision_notes = normalizeText(reason ?? "", { max: 2000 });
    if (conditions) patch.conditions = normalizeText(conditions, { max: 2000 });
  } else {
    patch.decision_notes = normalizeText(reason ?? "", { max: 2000 });
    if (!patch.decided_at) {
      patch.decided_by = actor?.id ?? null;
      patch.decided_at = nowIso();
    }
  }
  updateRow(db, "vv_waivers", row.id, patch, { columns: ["status", "decided_by", "decided_at", "decision_notes", "conditions", "version", "updated_by"] });
  writeAudit(db, { actor, action: `verification-validation.waiver.${to.toLowerCase()}`, resourceType: "vv_waiver", resourceId: row.waiver_ref, details: { from: row.status, to, reason: patch.decision_notes }, ip });
  const eventType = transitionEvent(to);
  if (eventType) publishVvEvent(db, { eventType, objectType: "waiver", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { waiver_ref: row.waiver_ref, from: row.status, to } }, actor);
  if (row.requirement_id) recalculateRequirement(db, tenant, row.requirement_id, actor, ip);
  return getWaiver(db, tenant, row.waiver_ref);
}

export async function transitionWaiverAsync(db, tenantId, ref, target, { actor = null, ip = null, reason = "", conditions = "" } = {}) {
  const tenant = Number(tenantId);
  const row = await requireWaiverRowAsync(db, tenant, ref);
  const to = normalizeUpper(target);
  if (!WAIVER_STATUSES.includes(to)) throw invalidVv(`Invalid waiver status: ${to}`, { allowed: [...WAIVER_STATUSES] });
  if (!(DEFAULT_WAIVER_TRANSITIONS[row.status] || []).includes(to)) throw invalidTransition(row.status, to);
  const patch = { status: to, version: bumpVersion(row), updated_by: actor?.id ?? null };
  if (to === "APPROVED") {
    patch.decided_by = actor?.id ?? null;
    patch.decided_at = nowIso();
    patch.decision_notes = normalizeText(reason ?? "", { max: 2000 });
    if (conditions) patch.conditions = normalizeText(conditions, { max: 2000 });
  } else {
    patch.decision_notes = normalizeText(reason ?? "", { max: 2000 });
    if (!patch.decided_at) {
      patch.decided_by = actor?.id ?? null;
      patch.decided_at = nowIso();
    }
  }
  await updateRowAsync(db, "vv_waivers", row.id, patch, { columns: ["status", "decided_by", "decided_at", "decision_notes", "conditions", "version", "updated_by"] });
  await writeAuditAsync(db, { actor, action: `verification-validation.waiver.${to.toLowerCase()}`, resourceType: "vv_waiver", resourceId: row.waiver_ref, details: { from: row.status, to, reason: patch.decision_notes }, ip });
  const eventType = transitionEvent(to);
  if (eventType) await publishVvEventAsync(db, { eventType, objectType: "waiver", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { waiver_ref: row.waiver_ref, from: row.status, to } }, actor);
  if (row.requirement_id) await recalculateRequirementAsync(db, tenant, row.requirement_id, actor, ip);
  return getWaiverAsync(db, tenant, row.waiver_ref);
}

export const approveWaiver = (db, tenantId, ref, opts = {}) => transitionWaiver(db, tenantId, ref, "APPROVED", opts);
export const approveWaiverAsync = (db, tenantId, ref, opts = {}) => transitionWaiverAsync(db, tenantId, ref, "APPROVED", opts);
export const rejectWaiver = (db, tenantId, ref, opts = {}) => transitionWaiver(db, tenantId, ref, "REJECTED", opts);
export const rejectWaiverAsync = (db, tenantId, ref, opts = {}) => transitionWaiverAsync(db, tenantId, ref, "REJECTED", opts);
export const revokeWaiver = (db, tenantId, ref, opts = {}) => transitionWaiver(db, tenantId, ref, "REVOKED", opts);
export const revokeWaiverAsync = (db, tenantId, ref, opts = {}) => transitionWaiverAsync(db, tenantId, ref, "REVOKED", opts);

export function expireOverdueWaivers(db, tenantId, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const now = nowIso();
  const rows = queryAll(db, `SELECT * FROM vv_waivers WHERE tenant_id = ? AND status = 'APPROVED' AND expires_at IS NOT NULL AND expires_at != '' AND expires_at < ?`, [tenant, now]);
  for (const row of rows) {
    updateRow(db, "vv_waivers", row.id, { status: "EXPIRED", version: bumpVersion(row), updated_by: actor?.id ?? null });
    writeAudit(db, { actor, action: "verification-validation.waiver.expired", resourceType: "vv_waiver", resourceId: row.waiver_ref, details: { expires_at: row.expires_at }, ip });
    publishVvEvent(db, { eventType: "WaiverRevoked", objectType: "waiver", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { waiver_ref: row.waiver_ref, from: "APPROVED", to: "EXPIRED" } }, actor);
    if (row.requirement_id) recalculateRequirement(db, tenant, row.requirement_id, actor, ip);
  }
  return { expired: rows.length, waivers: rows.map((row) => row.waiver_ref) };
}

export async function expireOverdueWaiversAsync(db, tenantId, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const now = nowIso();
  const rows = await queryAllAsync(db, `SELECT * FROM vv_waivers WHERE tenant_id = ? AND status = 'APPROVED' AND expires_at IS NOT NULL AND expires_at != '' AND expires_at < ?`, [tenant, now]);
  for (const row of rows) {
    await updateRowAsync(db, "vv_waivers", row.id, { status: "EXPIRED", version: bumpVersion(row), updated_by: actor?.id ?? null });
    await writeAuditAsync(db, { actor, action: "verification-validation.waiver.expired", resourceType: "vv_waiver", resourceId: row.waiver_ref, details: { expires_at: row.expires_at }, ip });
    await publishVvEventAsync(db, { eventType: "WaiverRevoked", objectType: "waiver", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { waiver_ref: row.waiver_ref, from: "APPROVED", to: "EXPIRED" } }, actor);
    if (row.requirement_id) await recalculateRequirementAsync(db, tenant, row.requirement_id, actor, ip);
  }
  return { expired: rows.length, waivers: rows.map((row) => row.waiver_ref) };
}

export function listWaivers(db, tenantId, opts = {}) {
  const { where, params } = waiverFilters({ tenantId, ...opts });
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM vv_waivers ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM vv_waivers ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicWaiver), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listWaiversAsync(db, tenantId, opts = {}) {
  const { where, params } = waiverFilters({ tenantId, ...opts });
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM vv_waivers ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM vv_waivers ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicWaiver), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export function listActiveWaiversForRequirement(db, tenantId, requirementId) {
  const rows = queryAll(db, `SELECT * FROM vv_waivers WHERE tenant_id = ? AND requirement_id = ? AND status = 'APPROVED' AND (expires_at IS NULL OR expires_at = '' OR expires_at >= ?) ORDER BY id DESC`, [Number(tenantId), Number(requirementId), nowIso()]);
  return rows.map(publicWaiver);
}

export async function listActiveWaiversForRequirementAsync(db, tenantId, requirementId) {
  const rows = await queryAllAsync(db, `SELECT * FROM vv_waivers WHERE tenant_id = ? AND requirement_id = ? AND status = 'APPROVED' AND (expires_at IS NULL OR expires_at = '' OR expires_at >= ?) ORDER BY id DESC`, [Number(tenantId), Number(requirementId), nowIso()]);
  return rows.map(publicWaiver);
}

export function waiverSummary(db, tenantId) {
  const rows = queryAll(db, "SELECT status, COUNT(*) AS c FROM vv_waivers WHERE tenant_id = ? GROUP BY status", [Number(tenantId)]);
  const byStatus = {};
  let total = 0;
  for (const row of rows) {
    byStatus[row.status] = Number(row.c);
    total += Number(row.c);
  }
  return { total, by_status: byStatus, active: byStatus.APPROVED || 0, source_module: SOURCE_MODULE };
}

export async function waiverSummaryAsync(db, tenantId) {
  const rows = await queryAllAsync(db, "SELECT status, COUNT(*) AS c FROM vv_waivers WHERE tenant_id = ? GROUP BY status", [Number(tenantId)]);
  const byStatus = {};
  let total = 0;
  for (const row of rows) {
    byStatus[row.status] = Number(row.c);
    total += Number(row.c);
  }
  return { total, by_status: byStatus, active: byStatus.APPROVED || 0, source_module: SOURCE_MODULE };
}
