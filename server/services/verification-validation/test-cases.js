// Test case service: the V&V definition a requirement is verified/validated by.
//
// A Test Case is a revision-controlled definition that names a method and a
// verification kind, carries acceptance criteria and links to the requirements it
// covers. Requirement links are stored as Requirements Manager edges
// (`requirement_relationships`, VERIFIED_BY/VALIDATED_BY) so V&V does not create a
// second requirement-to-test mapping model. Numbers come from the shared Numbering
// service; lifecycle transitions are data-driven; every write is audited and emits
// a domain event (mirrors requirements/requirements.js).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { nextNumber, nextNumberAsync } from "../numbering.js";
import { updateRow, updateRowAsync, assertVersion, bumpVersion } from "../requirements/sql.js";
import { normalizeText, normalizeUpper, paginate, parseObject, parseArray, toIntOrNull } from "../data-lifecycle/validation.js";
import { nextRevision } from "../requirements/validation.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import {
  Relationships as RequirementRelationships,
  Requirements as RequirementService,
} from "../requirements/index.js";
import { publishVvEvent, publishVvEventAsync } from "./events.js";
import { getMethodRow, getMethodRowAsync, requireMethodRow, requireMethodRowAsync } from "./methods.js";
import { testCaseRef } from "./refs.js";
import {
  SOURCE_MODULE,
  NUMBERING_OBJECT_TYPES,
  VERIFICATION_KINDS,
  DEFINITION_STATUSES,
  DEFINITION_TRANSITIONS,
  IMMUTABLE_DEFINITION_STATUSES,
  REQUIREMENT_VNV_RELATIONSHIPS,
  RELATIONSHIP_TYPE_FOR_KIND,
} from "./constants.js";
import { testCaseNotFound, testCaseConflict, invalidVv, immutableRecord, invalidTransition, requirementNotFound } from "./errors.js";

const EDITABLE_DEFINITION_STATUSES = ["DRAFT", "IN_REVIEW"];

const UPDATE_COLUMNS = ["name", "description", "objective", "verification_kind", "method_id", "method_code", "preconditions", "inputs_json", "acceptance_criteria_json", "equipment_json", "environment_json", "configuration_json", "owner_user_id", "reviewer_user_id", "approver_user_id", "organization_id", "metadata_json"];

export function publicTestCase(row) {
  if (!row) return null;
  return {
    id: row.id,
    test_case_ref: row.test_case_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    code: row.code,
    name: row.name,
    description: row.description,
    objective: row.objective,
    verification_kind: row.verification_kind,
    method_id: row.method_id ?? null,
    method_code: row.method_code,
    revision: row.revision,
    status: row.status,
    lifecycle_state: row.lifecycle_state,
    preconditions: row.preconditions,
    inputs: parseObject(row.inputs_json, []),
    acceptance_criteria: parseObject(row.acceptance_criteria_json, {}),
    equipment: parseObject(row.equipment_json, []),
    environment: parseObject(row.environment_json, {}),
    configuration: parseObject(row.configuration_json, {}),
    owner_user_id: row.owner_user_id ?? null,
    reviewer_user_id: row.reviewer_user_id ?? null,
    approver_user_id: row.approver_user_id ?? null,
    approved_by: row.approved_by ?? null,
    approved_at: row.approved_at ?? null,
    released_by: row.released_by ?? null,
    released_at: row.released_at ?? null,
    obsolete_at: row.obsolete_at ?? null,
    metadata: parseObject(row.metadata_json, {}),
    version: Number(row.version || 1),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function normalizeKind(body, current) {
  const kind = normalizeUpper(body.verification_kind ?? body.verificationKind ?? current.verification_kind ?? "VERIFICATION");
  if (!VERIFICATION_KINDS.includes(kind)) throw invalidVv(`Invalid verification_kind: ${kind}`, { allowed: [...VERIFICATION_KINDS] });
  return kind;
}

function normalizeTestCaseInput(body = {}, current = {}) {
  const objField = (value, fallback) => (value === undefined ? fallback : parseObject(value, fallback));
  const arrField = (value, fallback) => (value === undefined ? fallback : parseArray(value, fallback));
  return {
    name: normalizeText(body.name ?? current.name, { max: 200 }),
    description: normalizeText(body.description ?? current.description, { max: 4000 }),
    objective: normalizeText(body.objective ?? current.objective, { max: 4000 }),
    verification_kind: normalizeKind(body, current),
    preconditions: normalizeText(body.preconditions ?? current.preconditions, { max: 4000 }),
    inputs_json: JSON.stringify(arrField(body.inputs, current.inputs || [])),
    acceptance_criteria_json: JSON.stringify(objField(body.acceptance_criteria ?? body.acceptanceCriteria, current.acceptance_criteria || {})),
    equipment_json: JSON.stringify(arrField(body.equipment, current.equipment || [])),
    environment_json: JSON.stringify(objField(body.environment, current.environment || {})),
    configuration_json: JSON.stringify(objField(body.configuration, current.configuration || {})),
    owner_user_id: body.owner_user_id !== undefined ? toIntOrNull(body.owner_user_id) : current.owner_user_id ?? null,
    reviewer_user_id: body.reviewer_user_id !== undefined ? toIntOrNull(body.reviewer_user_id) : current.reviewer_user_id ?? null,
    approver_user_id: body.approver_user_id !== undefined ? toIntOrNull(body.approver_user_id) : current.approver_user_id ?? null,
    organization_id: body.organization_id !== undefined ? toIntOrNull(body.organization_id) : current.organization_id ?? null,
    metadata_json: JSON.stringify(objField(body.metadata, current.metadata || {})),
  };
}

export function testCaseFilters({ tenantId, status, verification_kind, method_code, q, organization_id, owner_user_id } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (verification_kind) {
    clauses.push("verification_kind = ?");
    params.push(normalizeUpper(verification_kind));
  }
  if (method_code) {
    clauses.push("method_code = ?");
    params.push(normalizeUpper(method_code));
  }
  if (organization_id) {
    clauses.push("organization_id = ?");
    params.push(Number(organization_id));
  }
  if (owner_user_id) {
    clauses.push("owner_user_id = ?");
    params.push(Number(owner_user_id));
  }
  if (q) {
    const like = `%${normalizeText(q, { max: 120 })}%`;
    clauses.push("(code ILIKE ? OR name ILIKE ? OR description ILIKE ?)");
    params.push(like, like, like);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listTestCases(db, opts = {}) {
  const { where, params } = testCaseFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM vv_test_cases ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM vv_test_cases ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicTestCase), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listTestCasesAsync(db, opts = {}) {
  const { where, params } = testCaseFilters(opts);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM vv_test_cases ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM vv_test_cases ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicTestCase), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export function getTestCaseRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM vv_test_cases WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOne(db, "SELECT * FROM vv_test_cases WHERE tenant_id = ? AND (test_case_ref = ? OR lower(code) = lower(?))", [Number(tenantId), String(ref), String(ref)]);
}

export async function getTestCaseRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM vv_test_cases WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOneAsync(db, "SELECT * FROM vv_test_cases WHERE tenant_id = ? AND (test_case_ref = ? OR lower(code) = lower(?))", [Number(tenantId), String(ref), String(ref)]);
}

export function getTestCase(db, tenantId, ref) {
  return publicTestCase(getTestCaseRow(db, tenantId, ref));
}

export async function getTestCaseAsync(db, tenantId, ref) {
  return publicTestCase(await getTestCaseRowAsync(db, tenantId, ref));
}

export function requireTestCaseRow(db, tenantId, ref) {
  const row = getTestCaseRow(db, tenantId, ref);
  if (!row) throw testCaseNotFound(ref);
  return row;
}

export async function requireTestCaseRowAsync(db, tenantId, ref) {
  const row = await getTestCaseRowAsync(db, tenantId, ref);
  if (!row) throw testCaseNotFound(ref);
  return row;
}

function resolveMethod(db, tenant, body, actor) {
  const methodRef = body.method_code ?? body.methodCode ?? body.method_id ?? body.methodId ?? null;
  if (!methodRef) return { method_id: null, method_code: "" };
  const row = requireMethodRow(db, tenant, methodRef);
  return { method_id: row.id, method_code: row.code };
}

async function resolveMethodAsync(db, tenant, body) {
  const methodRef = body.method_code ?? body.methodCode ?? body.method_id ?? body.methodId ?? null;
  if (!methodRef) return { method_id: null, method_code: "" };
  const row = await requireMethodRowAsync(db, tenant, methodRef);
  return { method_id: row.id, method_code: row.code };
}

export function createTestCase(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeTestCaseInput(body);
  if (!input.name) throw invalidVv("name is required");
  const providedCode = normalizeUpper(body.code ?? body.testCaseCode ?? "", { max: 64 });
  const number =
    normalizeText(body.test_case_number ?? body.testCaseNumber ?? "", { max: 60 }) ||
    nextNumber(db, { objectType: NUMBERING_OBJECT_TYPES.TEST_CASE }, actor, { tenantId: tenant });
  const code = providedCode || number;
  if (!code) throw invalidVv("code is required, or register an active VV_TEST_CASE numbering scheme");
  if (queryOne(db, "SELECT id FROM vv_test_cases WHERE tenant_id = ? AND (lower(code) = lower(?) OR test_case_ref = ?)", [tenant, code, testCaseRef(code)])) {
    throw testCaseConflict({ code });
  }
  const method = resolveMethod(db, tenant, body, actor);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO vv_test_cases
       (test_case_ref, tenant_id, organization_id, code, name, description, objective, verification_kind, method_id, method_code, revision, status, lifecycle_state,
        preconditions, inputs_json, acceptance_criteria_json, equipment_json, environment_json, configuration_json,
        owner_user_id, reviewer_user_id, approver_user_id, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'A', 'DRAFT', 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      testCaseRef(code),
      tenant,
      input.organization_id,
      code,
      input.name,
      input.description,
      input.objective,
      input.verification_kind,
      method.method_id,
      method.method_code,
      input.preconditions,
      input.inputs_json,
      input.acceptance_criteria_json,
      input.equipment_json,
      input.environment_json,
      input.configuration_json,
      input.owner_user_id,
      input.reviewer_user_id,
      input.approver_user_id,
      input.metadata_json,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM vv_test_cases WHERE id = ?", [Number(result.lastInsertId)]);
  writeAudit(db, { actor, action: "verification-validation.test-case.create", resourceType: "vv_test_case", resourceId: row.test_case_ref, details: { code: row.code }, ip });
  publishVvEvent(db, { eventType: "TestCaseCreated", objectType: "test_case", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { test_case_ref: row.test_case_ref, code: row.code, verification_kind: row.verification_kind } }, actor);
  return publicTestCase(row);
}

export async function createTestCaseAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeTestCaseInput(body);
  if (!input.name) throw invalidVv("name is required");
  const providedCode = normalizeUpper(body.code ?? body.testCaseCode ?? "", { max: 64 });
  const number =
    normalizeText(body.test_case_number ?? body.testCaseNumber ?? "", { max: 60 }) ||
    (await nextNumberAsync(db, { objectType: NUMBERING_OBJECT_TYPES.TEST_CASE }, actor, { tenantId: tenant }));
  const code = providedCode || number;
  if (!code) throw invalidVv("code is required, or register an active VV_TEST_CASE numbering scheme");
  if (await queryOneAsync(db, "SELECT id FROM vv_test_cases WHERE tenant_id = ? AND (lower(code) = lower(?) OR test_case_ref = ?)", [tenant, code, testCaseRef(code)])) {
    throw testCaseConflict({ code });
  }
  const method = await resolveMethodAsync(db, tenant, body);
  const ts = nowIso();
  const result = await runAsync(
    db,
    `INSERT INTO vv_test_cases
       (test_case_ref, tenant_id, organization_id, code, name, description, objective, verification_kind, method_id, method_code, revision, status, lifecycle_state,
        preconditions, inputs_json, acceptance_criteria_json, equipment_json, environment_json, configuration_json,
        owner_user_id, reviewer_user_id, approver_user_id, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'A', 'DRAFT', 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      testCaseRef(code),
      tenant,
      input.organization_id,
      code,
      input.name,
      input.description,
      input.objective,
      input.verification_kind,
      method.method_id,
      method.method_code,
      input.preconditions,
      input.inputs_json,
      input.acceptance_criteria_json,
      input.equipment_json,
      input.environment_json,
      input.configuration_json,
      input.owner_user_id,
      input.reviewer_user_id,
      input.approver_user_id,
      input.metadata_json,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = await queryOneAsync(db, "SELECT * FROM vv_test_cases WHERE id = ?", [Number(result.lastInsertId)]);
  await writeAuditAsync(db, { actor, action: "verification-validation.test-case.create", resourceType: "vv_test_case", resourceId: row.test_case_ref, details: { code: row.code }, ip });
  await publishVvEventAsync(db, { eventType: "TestCaseCreated", objectType: "test_case", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { test_case_ref: row.test_case_ref, code: row.code, verification_kind: row.verification_kind } }, actor);
  return publicTestCase(row);
}

export function updateTestCase(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireTestCaseRow(db, tenant, ref);
  if (IMMUTABLE_DEFINITION_STATUSES.includes(row.status)) throw immutableRecord(`Cannot edit a ${row.status} test case; revise it instead`, { ref: row.test_case_ref, status: row.status });
  assertVersion(row, body.version ?? body.expected_version, testCaseConflict);
  const input = normalizeTestCaseInput(body, publicTestCase(row));
  const method = resolveMethod(db, tenant, body, actor);
  updateRow(db, "vv_test_cases", row.id, { ...input, method_id: method.method_id, method_code: method.method_code, version: bumpVersion(row), updated_by: actor?.id ?? null });
  writeAudit(db, { actor, action: "verification-validation.test-case.update", resourceType: "vv_test_case", resourceId: row.test_case_ref, details: {}, ip });
  return publicTestCase(queryOne(db, "SELECT * FROM vv_test_cases WHERE id = ?", [row.id]));
}

export async function updateTestCaseAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireTestCaseRowAsync(db, tenant, ref);
  if (IMMUTABLE_DEFINITION_STATUSES.includes(row.status)) throw immutableRecord(`Cannot edit a ${row.status} test case; revise it instead`, { ref: row.test_case_ref, status: row.status });
  assertVersion(row, body.version ?? body.expected_version, testCaseConflict);
  const input = normalizeTestCaseInput(body, publicTestCase(row));
  const method = await resolveMethodAsync(db, tenant, body);
  await updateRowAsync(db, "vv_test_cases", row.id, { ...input, method_id: method.method_id, method_code: method.method_code, version: bumpVersion(row), updated_by: actor?.id ?? null });
  await writeAuditAsync(db, { actor, action: "verification-validation.test-case.update", resourceType: "vv_test_case", resourceId: row.test_case_ref, details: {}, ip });
  return publicTestCase(await queryOneAsync(db, "SELECT * FROM vv_test_cases WHERE id = ?", [row.id]));
}

function transitionPatch(target, actor, ts) {
  const patch = { status: target, lifecycle_state: target, updated_by: actor?.id ?? null };
  if (target === "APPROVED") {
    patch.approved_by = actor?.id ?? null;
    patch.approved_at = ts;
  }
  if (target === "RELEASED") {
    patch.released_by = actor?.id ?? null;
    patch.released_at = ts;
  }
  if (target === "OBSOLETE") patch.obsolete_at = ts;
  return patch;
}

export function transitionTestCase(db, tenantId, ref, target, { actor = null, ip = null, reason = "" } = {}) {
  const tenant = Number(tenantId);
  const row = requireTestCaseRow(db, tenant, ref);
  const to = normalizeUpper(target);
  if (!DEFINITION_STATUSES.includes(to)) throw invalidVv(`Invalid test case status: ${to}`, { allowed: [...DEFINITION_STATUSES] });
  const allowed = DEFINITION_TRANSITIONS[row.status] || [];
  if (!allowed.includes(to)) throw invalidTransition(row.status, to);
  updateRow(db, "vv_test_cases", row.id, transitionPatch(to, actor, nowIso()));
  const updated = queryOne(db, "SELECT * FROM vv_test_cases WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "verification-validation.test-case.transition", resourceType: "vv_test_case", resourceId: row.test_case_ref, details: { from: row.status, to, reason }, ip });
  if (to === "APPROVED") publishVvEvent(db, { eventType: "TestCaseApproved", objectType: "test_case", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { test_case_ref: row.test_case_ref, reason } }, actor);
  return publicTestCase(updated);
}

export async function transitionTestCaseAsync(db, tenantId, ref, target, { actor = null, ip = null, reason = "" } = {}) {
  const tenant = Number(tenantId);
  const row = await requireTestCaseRowAsync(db, tenant, ref);
  const to = normalizeUpper(target);
  if (!DEFINITION_STATUSES.includes(to)) throw invalidVv(`Invalid test case status: ${to}`, { allowed: [...DEFINITION_STATUSES] });
  const allowed = DEFINITION_TRANSITIONS[row.status] || [];
  if (!allowed.includes(to)) throw invalidTransition(row.status, to);
  await updateRowAsync(db, "vv_test_cases", row.id, transitionPatch(to, actor, nowIso()));
  const updated = await queryOneAsync(db, "SELECT * FROM vv_test_cases WHERE id = ?", [row.id]);
  await writeAuditAsync(db, { actor, action: "verification-validation.test-case.transition", resourceType: "vv_test_case", resourceId: row.test_case_ref, details: { from: row.status, to, reason }, ip });
  if (to === "APPROVED") await publishVvEventAsync(db, { eventType: "TestCaseApproved", objectType: "test_case", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { test_case_ref: row.test_case_ref, reason } }, actor);
  return publicTestCase(updated);
}

function snapshotDefinition(row, actor, reason) {
  const meta = parseObject(row.metadata_json, {});
  const log = Array.isArray(meta.revisions) ? meta.revisions.slice() : [];
  log.push({ revision: row.revision, status: row.status, name: row.name, description: row.description, objective: row.objective, acceptance_criteria: parseObject(row.acceptance_criteria_json, {}), revised_by: actor?.id ?? null, revised_at: nowIso(), reason: normalizeText(reason, { max: 500 }) });
  meta.revisions = log;
  return JSON.stringify(meta);
}

export function reviseTestCase(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireTestCaseRow(db, tenant, ref);
  assertVersion(row, body.version ?? body.expected_version, testCaseConflict);
  const revision = nextRevision(row.revision);
  const input = normalizeTestCaseInput(body, publicTestCase(row));
  updateRow(db, "vv_test_cases", row.id, {
    ...input,
    revision,
    status: "DRAFT",
    lifecycle_state: "DRAFT",
    approved_by: null,
    approved_at: null,
    released_by: null,
    released_at: null,
    obsolete_at: null,
    metadata_json: snapshotDefinition(row, actor, body.reason),
    version: bumpVersion(row),
    updated_by: actor?.id ?? null,
  });
  writeAudit(db, { actor, action: "verification-validation.test-case.revise", resourceType: "vv_test_case", resourceId: row.test_case_ref, details: { from: row.revision, to: revision }, ip });
  return publicTestCase(queryOne(db, "SELECT * FROM vv_test_cases WHERE id = ?", [row.id]));
}

export async function reviseTestCaseAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireTestCaseRowAsync(db, tenant, ref);
  assertVersion(row, body.version ?? body.expected_version, testCaseConflict);
  const revision = nextRevision(row.revision);
  const input = normalizeTestCaseInput(body, publicTestCase(row));
  await updateRowAsync(db, "vv_test_cases", row.id, {
    ...input,
    revision,
    status: "DRAFT",
    lifecycle_state: "DRAFT",
    approved_by: null,
    approved_at: null,
    released_by: null,
    released_at: null,
    obsolete_at: null,
    metadata_json: snapshotDefinition(row, actor, body.reason),
    version: bumpVersion(row),
    updated_by: actor?.id ?? null,
  });
  await writeAuditAsync(db, { actor, action: "verification-validation.test-case.revise", resourceType: "vv_test_case", resourceId: row.test_case_ref, details: { from: row.revision, to: revision }, ip });
  return publicTestCase(await queryOneAsync(db, "SELECT * FROM vv_test_cases WHERE id = ?", [row.id]));
}

function resolveRequirement(db, tenant, body) {
  const ref = body.requirement_id ?? body.requirementId ?? body.requirement_ref ?? body.requirementRef ?? body.requirement ?? null;
  if (ref === undefined || ref === null || String(ref).trim() === "") throw invalidVv("requirement is required");
  const row = RequirementService.getRequirementRow(db, tenant, ref);
  if (!row) throw requirementNotFound(ref);
  return row;
}

async function resolveRequirementAsync(db, tenant, body) {
  const ref = body.requirement_id ?? body.requirementId ?? body.requirement_ref ?? body.requirementRef ?? body.requirement ?? null;
  if (ref === undefined || ref === null || String(ref).trim() === "") throw invalidVv("requirement is required");
  const row = await RequirementService.getRequirementRowAsync(db, tenant, ref);
  if (!row) throw requirementNotFound(ref);
  return row;
}

function edgeRelationshipType(body, testCase) {
  const requested = body.relationship_type ?? body.relationshipType;
  const type = requested ? normalizeUpper(requested) : RELATIONSHIP_TYPE_FOR_KIND[testCase.verification_kind] || "VERIFIED_BY";
  if (!REQUIREMENT_VNV_RELATIONSHIPS.includes(type)) throw invalidVv(`Invalid relationship_type: ${type}`, { allowed: [...REQUIREMENT_VNV_RELATIONSHIPS] });
  return type;
}

export function linkRequirement(db, tenantId, testCaseRefValue, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const testCase = requireTestCaseRow(db, tenant, testCaseRefValue);
  const requirement = resolveRequirement(db, tenant, body);
  const relationshipType = edgeRelationshipType(body, testCase);
  const edge = RequirementRelationships.createRelationship(
    db,
    tenant,
    {
      relationship_type: relationshipType,
      source_type: "requirement",
      source_id: String(requirement.id),
      target_type: "test_case",
      target_id: String(testCase.id),
      attributes: { method_code: testCase.method_code, revision: testCase.revision, requirement_ref: requirement.requirement_ref },
    },
    actor,
    ip
  );
  return { relationship: edge, test_case_ref: testCase.test_case_ref, requirement_ref: requirement.requirement_ref };
}

export async function linkRequirementAsync(db, tenantId, testCaseRefValue, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const testCase = await requireTestCaseRowAsync(db, tenant, testCaseRefValue);
  const requirement = await resolveRequirementAsync(db, tenant, body);
  const relationshipType = edgeRelationshipType(body, testCase);
  const edge = await RequirementRelationships.createRelationshipAsync(
    db,
    tenant,
    {
      relationship_type: relationshipType,
      source_type: "requirement",
      source_id: String(requirement.id),
      target_type: "test_case",
      target_id: String(testCase.id),
      attributes: { method_code: testCase.method_code, revision: testCase.revision, requirement_ref: requirement.requirement_ref },
    },
    actor,
    ip
  );
  return { relationship: edge, test_case_ref: testCase.test_case_ref, requirement_ref: requirement.requirement_ref };
}

export function listTestCaseRequirements(db, tenantId, ref, opts = {}) {
  const tenant = Number(tenantId);
  const testCase = requireTestCaseRow(db, tenant, ref);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const typePlaceholders = REQUIREMENT_VNV_RELATIONSHIPS.map(() => "?").join(", ");
  const total = Number(
    queryOne(db, `SELECT COUNT(*) AS c FROM requirement_relationships WHERE tenant_id = ? AND target_type = 'test_case' AND target_id = ? AND relationship_type IN (${typePlaceholders})`, [tenant, String(testCase.id), ...REQUIREMENT_VNV_RELATIONSHIPS])?.c || 0
  );
  const rows = queryAll(
    db,
    `SELECT * FROM requirement_relationships WHERE tenant_id = ? AND target_type = 'test_case' AND target_id = ? AND relationship_type IN (${typePlaceholders}) ORDER BY id DESC LIMIT ? OFFSET ?`,
    [tenant, String(testCase.id), ...REQUIREMENT_VNV_RELATIONSHIPS, limit, offset]
  );
  return { items: rows.map((row) => ({ id: row.id, relationship_ref: row.relationship_ref, relationship_type: row.relationship_type, requirement_id: Number(row.source_id), status: row.status, attributes: parseObject(row.attributes_json, {}) })), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listTestCaseRequirementsAsync(db, tenantId, ref, opts = {}) {
  const tenant = Number(tenantId);
  const testCase = await requireTestCaseRowAsync(db, tenant, ref);
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const typePlaceholders = REQUIREMENT_VNV_RELATIONSHIPS.map(() => "?").join(", ");
  const total = Number(
    (await queryOneAsync(db, `SELECT COUNT(*) AS c FROM requirement_relationships WHERE tenant_id = ? AND target_type = 'test_case' AND target_id = ? AND relationship_type IN (${typePlaceholders})`, [tenant, String(testCase.id), ...REQUIREMENT_VNV_RELATIONSHIPS]))?.c || 0
  );
  const rows = await queryAllAsync(
    db,
    `SELECT * FROM requirement_relationships WHERE tenant_id = ? AND target_type = 'test_case' AND target_id = ? AND relationship_type IN (${typePlaceholders}) ORDER BY id DESC LIMIT ? OFFSET ?`,
    [tenant, String(testCase.id), ...REQUIREMENT_VNV_RELATIONSHIPS, limit, offset]
  );
  return { items: rows.map((row) => ({ id: row.id, relationship_ref: row.relationship_ref, relationship_type: row.relationship_type, requirement_id: Number(row.source_id), status: row.status, attributes: parseObject(row.attributes_json, {}) })), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export function unlinkRequirement(db, tenantId, testCaseRefValue, relationshipRef, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const testCase = requireTestCaseRow(db, tenant, testCaseRefValue);
  const relationship = RequirementRelationships.getRelationshipRow(db, tenant, relationshipRef);
  if (!relationship || relationship.target_type !== "test_case" || String(relationship.target_id) !== String(testCase.id)) {
    throw invalidVv(`Relationship ${relationshipRef} is not linked to test case ${testCase.test_case_ref}`);
  }
  return RequirementRelationships.deleteRelationship(db, tenant, relationshipRef, actor, ip);
}

export async function unlinkRequirementAsync(db, tenantId, testCaseRefValue, relationshipRef, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const testCase = await requireTestCaseRowAsync(db, tenant, testCaseRefValue);
  const relationship = await RequirementRelationships.getRelationshipRowAsync(db, tenant, relationshipRef);
  if (!relationship || relationship.target_type !== "test_case" || String(relationship.target_id) !== String(testCase.id)) {
    throw invalidVv(`Relationship ${relationshipRef} is not linked to test case ${testCase.test_case_ref}`);
  }
  return RequirementRelationships.deleteRelationshipAsync(db, tenant, relationshipRef, actor, ip);
}
