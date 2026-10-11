// Test procedure service: the ordered, executable steps behind a test case.
//
// A procedure belongs to exactly one test case and owns its steps as rows (FK
// columns, not generic edges, because ordering/execution is high-volume and
// strictly local). Numbers come from the shared Numbering service; lifecycle
// transitions reuse the definition state model; every write is audited and emits
// a domain event (mirrors requirements/requirements.js).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { nextNumber, nextNumberAsync } from "../numbering.js";
import { updateRow, updateRowAsync, assertVersion, bumpVersion } from "../requirements/sql.js";
import { normalizeText, normalizeUpper, paginate, parseObject, parseArray, toIntOrNull, toBool } from "../data-lifecycle/validation.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { publishVvEvent, publishVvEventAsync } from "./events.js";
import { requireTestCaseRow, requireTestCaseRowAsync } from "./test-cases.js";
import { procedureRef } from "./refs.js";
import {
  SOURCE_MODULE,
  NUMBERING_OBJECT_TYPES,
  DEFINITION_STATUSES,
  DEFINITION_TRANSITIONS,
  IMMUTABLE_DEFINITION_STATUSES,
} from "./constants.js";
import { procedureNotFound, stepNotFound, invalidVv, immutableRecord, invalidTransition, procedureConflict } from "./errors.js";

export function publicStep(row) {
  if (!row) return null;
  return {
    id: row.id,
    procedure_id: row.procedure_id,
    sequence: Number(row.sequence || 0),
    code: row.code,
    instruction: row.instruction,
    expected_result: row.expected_result,
    acceptance_criteria: parseObject(row.acceptance_criteria_json, {}),
    inputs: parseArray(row.inputs_json, []),
    equipment: parseArray(row.equipment_json, []),
    safety_notes: row.safety_notes,
    required: Boolean(row.required),
    metadata: parseObject(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicProcedure(row, steps = null) {
  if (!row) return null;
  const base = {
    id: row.id,
    procedure_ref: row.procedure_ref,
    tenant_id: row.tenant_id,
    organization_id: row.organization_id ?? null,
    test_case_id: row.test_case_id ?? null,
    code: row.code,
    name: row.name,
    description: row.description,
    revision: row.revision,
    status: row.status,
    lifecycle_state: row.lifecycle_state,
    document_content_id: row.document_content_id ?? null,
    owner_user_id: row.owner_user_id ?? null,
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
  if (steps !== null) base.steps = steps.map(publicStep);
  return base;
}

function normalizeProcedureInput(body = {}, current = {}) {
  return {
    name: normalizeText(body.name ?? current.name, { max: 200 }),
    description: normalizeText(body.description ?? current.description, { max: 4000 }),
    document_content_id: body.document_content_id !== undefined ? toIntOrNull(body.document_content_id) : current.document_content_id ?? null,
    owner_user_id: body.owner_user_id !== undefined ? toIntOrNull(body.owner_user_id) : current.owner_user_id ?? null,
    approver_user_id: body.approver_user_id !== undefined ? toIntOrNull(body.approver_user_id) : current.approver_user_id ?? null,
    organization_id: body.organization_id !== undefined ? toIntOrNull(body.organization_id) : current.organization_id ?? null,
    metadata_json: JSON.stringify(body.metadata === undefined ? current.metadata || {} : parseObject(body.metadata, {})),
  };
}

function normalizeStepInput(body = {}, current = {}) {
  const objField = (value, fallback) => (value === undefined ? fallback : parseObject(value, fallback));
  const arrField = (value, fallback) => (value === undefined ? fallback : parseArray(value, fallback));
  return {
    code: normalizeText(body.code ?? current.code, { max: 120 }),
    instruction: normalizeText(body.instruction ?? current.instruction, { max: 4000 }),
    expected_result: normalizeText(body.expected_result ?? body.expectedResult ?? current.expected_result, { max: 4000 }),
    acceptance_criteria_json: JSON.stringify(objField(body.acceptance_criteria ?? body.acceptanceCriteria, current.acceptance_criteria || {})),
    inputs_json: JSON.stringify(arrField(body.inputs, current.inputs || [])),
    equipment_json: JSON.stringify(arrField(body.equipment, current.equipment || [])),
    safety_notes: normalizeText(body.safety_notes ?? body.safetyNotes ?? current.safety_notes, { max: 4000 }),
    required: body.required === undefined ? (current.required === undefined ? true : current.required) : toBool(body.required, true) ? 1 : 0,
    metadata_json: JSON.stringify(objField(body.metadata, current.metadata || {})),
  };
}

function procedureFilters({ tenantId, test_case_id, status, q } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (test_case_id) {
    clauses.push("test_case_id = ?");
    params.push(Number(test_case_id));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status));
  }
  if (q) {
    const like = `%${normalizeText(q, { max: 120 })}%`;
    clauses.push("(code ILIKE ? OR name ILIKE ?)");
    params.push(like, like);
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listProcedures(db, tenantId, opts = {}) {
  const { where, params } = procedureFilters({ ...opts, tenantId });
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM vv_test_procedures ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM vv_test_procedures ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const includeSteps = opts.includeSteps !== false;
  const stepsByProcedure = includeSteps ? loadStepsForProcedures(db, rows.map((row) => row.id)) : new Map();
  return { items: rows.map((row) => publicProcedure(row, includeSteps ? stepsByProcedure.get(Number(row.id)) || [] : null)), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listProceduresAsync(db, tenantId, opts = {}) {
  const { where, params } = procedureFilters({ ...opts, tenantId });
  const { limit, offset, page } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM vv_test_procedures ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM vv_test_procedures ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const includeSteps = opts.includeSteps !== false;
  const stepsByProcedure = includeSteps ? await loadStepsForProceduresAsync(db, rows.map((row) => row.id)) : new Map();
  return { items: rows.map((row) => publicProcedure(row, includeSteps ? stepsByProcedure.get(Number(row.id)) || [] : null)), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

// Batch-loads steps for a page of procedures in one query to avoid N+1 reads.
export function loadStepsForProcedures(db, procedureIds) {
  const map = new Map();
  const ids = (procedureIds || []).map(Number).filter((id) => Number.isInteger(id));
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = queryAll(db, `SELECT * FROM vv_procedure_steps WHERE procedure_id IN (${placeholders}) ORDER BY procedure_id, sequence, id`, ids);
  for (const row of rows) {
    const key = Number(row.procedure_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

export async function loadStepsForProceduresAsync(db, procedureIds) {
  const map = new Map();
  const ids = (procedureIds || []).map(Number).filter((id) => Number.isInteger(id));
  if (!ids.length) return map;
  const placeholders = ids.map(() => "?").join(", ");
  const rows = await queryAllAsync(db, `SELECT * FROM vv_procedure_steps WHERE procedure_id IN (${placeholders}) ORDER BY procedure_id, sequence, id`, ids);
  for (const row of rows) {
    const key = Number(row.procedure_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

export function loadSteps(db, procedureId) {
  return queryAll(db, "SELECT * FROM vv_procedure_steps WHERE procedure_id = ? ORDER BY sequence, id", [Number(procedureId)]);
}

export async function loadStepsAsync(db, procedureId) {
  return queryAllAsync(db, "SELECT * FROM vv_procedure_steps WHERE procedure_id = ? ORDER BY sequence, id", [Number(procedureId)]);
}

export function getProcedureRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM vv_test_procedures WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOne(db, "SELECT * FROM vv_test_procedures WHERE tenant_id = ? AND (procedure_ref = ? OR lower(code) = lower(?))", [Number(tenantId), String(ref), String(ref)]);
}

export async function getProcedureRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM vv_test_procedures WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOneAsync(db, "SELECT * FROM vv_test_procedures WHERE tenant_id = ? AND (procedure_ref = ? OR lower(code) = lower(?))", [Number(tenantId), String(ref), String(ref)]);
}

export function getProcedure(db, tenantId, ref) {
  const row = getProcedureRow(db, tenantId, ref);
  return row ? publicProcedure(row, loadSteps(db, row.id)) : null;
}

export async function getProcedureAsync(db, tenantId, ref) {
  const row = await getProcedureRowAsync(db, tenantId, ref);
  return row ? publicProcedure(row, await loadStepsAsync(db, row.id)) : null;
}

export function requireProcedureRow(db, tenantId, ref) {
  const row = getProcedureRow(db, tenantId, ref);
  if (!row) throw procedureNotFound(ref);
  return row;
}

export async function requireProcedureRowAsync(db, tenantId, ref) {
  const row = await getProcedureRowAsync(db, tenantId, ref);
  if (!row) throw procedureNotFound(ref);
  return row;
}

export function createProcedure(db, tenantId, testCaseRefValue, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const testCase = requireTestCaseRow(db, tenant, testCaseRefValue);
  const input = normalizeProcedureInput(body);
  if (!input.name) throw invalidVv("name is required");
  const providedCode = normalizeUpper(body.code ?? "", { max: 64 });
  const number =
    normalizeText(body.procedure_number ?? body.procedureNumber ?? "", { max: 60 }) ||
    nextNumber(db, { objectType: NUMBERING_OBJECT_TYPES.PROCEDURE }, actor, { tenantId: tenant });
  const code = providedCode || number;
  if (!code) throw invalidVv("code is required, or register an active VV_TEST_PROCEDURE numbering scheme");
  if (queryOne(db, "SELECT id FROM vv_test_procedures WHERE tenant_id = ? AND (lower(code) = lower(?) OR procedure_ref = ?)", [tenant, code, procedureRef(code)])) {
    throw invalidVv(`Procedure already exists: ${code}`);
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO vv_test_procedures
       (procedure_ref, tenant_id, organization_id, test_case_id, code, name, description, revision, status, lifecycle_state,
        document_content_id, owner_user_id, approver_user_id, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'A', 'DRAFT', 'DRAFT', ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [procedureRef(code), tenant, input.organization_id, testCase.id, code, input.name, input.description, input.document_content_id, input.owner_user_id, input.approver_user_id, input.metadata_json, actor?.id ?? null, actor?.id ?? null, ts, ts]
  );
  const row = queryOne(db, "SELECT * FROM vv_test_procedures WHERE id = ?", [Number(result.lastInsertId)]);
  writeAudit(db, { actor, action: "verification-validation.procedure.create", resourceType: "vv_test_procedure", resourceId: row.procedure_ref, details: { test_case_id: testCase.id }, ip });
  publishVvEvent(db, { eventType: "TestProcedureCreated", objectType: "test_procedure", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { procedure_ref: row.procedure_ref, test_case_ref: testCase.test_case_ref } }, actor);
  return publicProcedure(row, []);
}

export async function createProcedureAsync(db, tenantId, testCaseRefValue, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const testCase = await requireTestCaseRowAsync(db, tenant, testCaseRefValue);
  const input = normalizeProcedureInput(body);
  if (!input.name) throw invalidVv("name is required");
  const providedCode = normalizeUpper(body.code ?? "", { max: 64 });
  const number =
    normalizeText(body.procedure_number ?? body.procedureNumber ?? "", { max: 60 }) ||
    (await nextNumberAsync(db, { objectType: NUMBERING_OBJECT_TYPES.PROCEDURE }, actor, { tenantId: tenant }));
  const code = providedCode || number;
  if (!code) throw invalidVv("code is required, or register an active VV_TEST_PROCEDURE numbering scheme");
  if (await queryOneAsync(db, "SELECT id FROM vv_test_procedures WHERE tenant_id = ? AND (lower(code) = lower(?) OR procedure_ref = ?)", [tenant, code, procedureRef(code)])) {
    throw invalidVv(`Procedure already exists: ${code}`);
  }
  const ts = nowIso();
  const result = await runAsync(
    db,
    `INSERT INTO vv_test_procedures
       (procedure_ref, tenant_id, organization_id, test_case_id, code, name, description, revision, status, lifecycle_state,
        document_content_id, owner_user_id, approver_user_id, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'A', 'DRAFT', 'DRAFT', ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [procedureRef(code), tenant, input.organization_id, testCase.id, code, input.name, input.description, input.document_content_id, input.owner_user_id, input.approver_user_id, input.metadata_json, actor?.id ?? null, actor?.id ?? null, ts, ts]
  );
  const row = await queryOneAsync(db, "SELECT * FROM vv_test_procedures WHERE id = ?", [Number(result.lastInsertId)]);
  await writeAuditAsync(db, { actor, action: "verification-validation.procedure.create", resourceType: "vv_test_procedure", resourceId: row.procedure_ref, details: { test_case_id: testCase.id }, ip });
  await publishVvEventAsync(db, { eventType: "TestProcedureCreated", objectType: "test_procedure", objectId: String(row.id), tenantId: tenant, organizationId: row.organization_id, payload: { procedure_ref: row.procedure_ref, test_case_ref: testCase.test_case_ref } }, actor);
  return publicProcedure(row, []);
}

export function updateProcedure(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireProcedureRow(db, tenant, ref);
  if (IMMUTABLE_DEFINITION_STATUSES.includes(row.status)) throw immutableRecord(`Cannot edit a ${row.status} procedure; revise it instead`, { ref: row.procedure_ref, status: row.status });
  assertVersion(row, body.version ?? body.expected_version, procedureConflict);
  const input = normalizeProcedureInput(body, publicProcedure(row));
  updateRow(db, "vv_test_procedures", row.id, { ...input, version: bumpVersion(row), updated_by: actor?.id ?? null });
  writeAudit(db, { actor, action: "verification-validation.procedure.update", resourceType: "vv_test_procedure", resourceId: row.procedure_ref, details: {}, ip });
  return publicProcedure(queryOne(db, "SELECT * FROM vv_test_procedures WHERE id = ?", [row.id]), loadSteps(db, row.id));
}

export async function updateProcedureAsync(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await requireProcedureRowAsync(db, tenant, ref);
  if (IMMUTABLE_DEFINITION_STATUSES.includes(row.status)) throw immutableRecord(`Cannot edit a ${row.status} procedure; revise it instead`, { ref: row.procedure_ref, status: row.status });
  assertVersion(row, body.version ?? body.expected_version, procedureConflict);
  const input = normalizeProcedureInput(body, publicProcedure(row));
  await updateRowAsync(db, "vv_test_procedures", row.id, { ...input, version: bumpVersion(row), updated_by: actor?.id ?? null });
  await writeAuditAsync(db, { actor, action: "verification-validation.procedure.update", resourceType: "vv_test_procedure", resourceId: row.procedure_ref, details: {}, ip });
  return publicProcedure(await queryOneAsync(db, "SELECT * FROM vv_test_procedures WHERE id = ?", [row.id]), await loadStepsAsync(db, row.id));
}

function procedureTransitionPatch(target, actor, ts) {
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

export function transitionProcedure(db, tenantId, ref, target, { actor = null, ip = null, reason = "" } = {}) {
  const tenant = Number(tenantId);
  const row = requireProcedureRow(db, tenant, ref);
  const to = normalizeUpper(target);
  if (!DEFINITION_STATUSES.includes(to)) throw invalidVv(`Invalid procedure status: ${to}`, { allowed: [...DEFINITION_STATUSES] });
  if (!(DEFINITION_TRANSITIONS[row.status] || []).includes(to)) throw invalidTransition(row.status, to);
  updateRow(db, "vv_test_procedures", row.id, procedureTransitionPatch(to, actor, nowIso()));
  writeAudit(db, { actor, action: "verification-validation.procedure.transition", resourceType: "vv_test_procedure", resourceId: row.procedure_ref, details: { from: row.status, to, reason }, ip });
  return publicProcedure(queryOne(db, "SELECT * FROM vv_test_procedures WHERE id = ?", [row.id]), loadSteps(db, row.id));
}

export async function transitionProcedureAsync(db, tenantId, ref, target, { actor = null, ip = null, reason = "" } = {}) {
  const tenant = Number(tenantId);
  const row = await requireProcedureRowAsync(db, tenant, ref);
  const to = normalizeUpper(target);
  if (!DEFINITION_STATUSES.includes(to)) throw invalidVv(`Invalid procedure status: ${to}`, { allowed: [...DEFINITION_STATUSES] });
  if (!(DEFINITION_TRANSITIONS[row.status] || []).includes(to)) throw invalidTransition(row.status, to);
  await updateRowAsync(db, "vv_test_procedures", row.id, procedureTransitionPatch(to, actor, nowIso()));
  await writeAuditAsync(db, { actor, action: "verification-validation.procedure.transition", resourceType: "vv_test_procedure", resourceId: row.procedure_ref, details: { from: row.status, to, reason }, ip });
  return publicProcedure(await queryOneAsync(db, "SELECT * FROM vv_test_procedures WHERE id = ?", [row.id]), await loadStepsAsync(db, row.id));
}

function nextSequence(db, procedureId, requested) {
  const explicit = toIntOrNull(requested);
  if (explicit !== null) return explicit;
  const row = queryOne(db, "SELECT COALESCE(MAX(sequence), 0) AS m FROM vv_procedure_steps WHERE procedure_id = ?", [Number(procedureId)]);
  return Number(row?.m || 0) + 10;
}

async function nextSequenceAsync(db, procedureId, requested) {
  const explicit = toIntOrNull(requested);
  if (explicit !== null) return explicit;
  const row = await queryOneAsync(db, "SELECT COALESCE(MAX(sequence), 0) AS m FROM vv_procedure_steps WHERE procedure_id = ?", [Number(procedureId)]);
  return Number(row?.m || 0) + 10;
}

export function addStep(db, tenantId, procedureRefValue, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const procedure = requireProcedureRow(db, tenant, procedureRefValue);
  if (IMMUTABLE_DEFINITION_STATUSES.includes(procedure.status)) throw immutableRecord(`Cannot edit a ${procedure.status} procedure; revise it instead`, { ref: procedure.procedure_ref, status: procedure.status });
  const input = normalizeStepInput(body);
  if (!input.instruction && !input.expected_result) throw invalidVv("A step requires an instruction or an expected result");
  const sequence = nextSequence(db, procedure.id, body.sequence);
  const existing = queryOne(db, "SELECT id FROM vv_procedure_steps WHERE procedure_id = ? AND sequence = ?", [procedure.id, sequence]);
  if (existing) throw invalidVv(`A step already exists at sequence ${sequence}`, { sequence });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO vv_procedure_steps
       (tenant_id, procedure_id, sequence, code, instruction, expected_result, acceptance_criteria_json, inputs_json, equipment_json, safety_notes, required, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenant, procedure.id, sequence, input.code, input.instruction, input.expected_result, input.acceptance_criteria_json, input.inputs_json, input.equipment_json, input.safety_notes, input.required, input.metadata_json, actor?.id ?? null, actor?.id ?? null, ts, ts]
  );
  const row = queryOne(db, "SELECT * FROM vv_procedure_steps WHERE id = ?", [Number(result.lastInsertId)]);
  writeAudit(db, { actor, action: "verification-validation.procedure.step.add", resourceType: "vv_procedure_step", resourceId: String(row.id), details: { procedure_ref: procedure.procedure_ref, sequence }, ip });
  return publicStep(row);
}

export async function addStepAsync(db, tenantId, procedureRefValue, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const procedure = await requireProcedureRowAsync(db, tenant, procedureRefValue);
  if (IMMUTABLE_DEFINITION_STATUSES.includes(procedure.status)) throw immutableRecord(`Cannot edit a ${procedure.status} procedure; revise it instead`, { ref: procedure.procedure_ref, status: procedure.status });
  const input = normalizeStepInput(body);
  if (!input.instruction && !input.expected_result) throw invalidVv("A step requires an instruction or an expected result");
  const sequence = await nextSequenceAsync(db, procedure.id, body.sequence);
  const existing = await queryOneAsync(db, "SELECT id FROM vv_procedure_steps WHERE procedure_id = ? AND sequence = ?", [procedure.id, sequence]);
  if (existing) throw invalidVv(`A step already exists at sequence ${sequence}`, { sequence });
  const ts = nowIso();
  const result = await runAsync(
    db,
    `INSERT INTO vv_procedure_steps
       (tenant_id, procedure_id, sequence, code, instruction, expected_result, acceptance_criteria_json, inputs_json, equipment_json, safety_notes, required, metadata_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenant, procedure.id, sequence, input.code, input.instruction, input.expected_result, input.acceptance_criteria_json, input.inputs_json, input.equipment_json, input.safety_notes, input.required, input.metadata_json, actor?.id ?? null, actor?.id ?? null, ts, ts]
  );
  const row = await queryOneAsync(db, "SELECT * FROM vv_procedure_steps WHERE id = ?", [Number(result.lastInsertId)]);
  await writeAuditAsync(db, { actor, action: "verification-validation.procedure.step.add", resourceType: "vv_procedure_step", resourceId: String(row.id), details: { procedure_ref: procedure.procedure_ref, sequence }, ip });
  return publicStep(row);
}

export function getStepRow(db, tenantId, procedureId, stepRef) {
  const id = Number(stepRef);
  if (Number.isInteger(id) && String(id) === String(stepRef).trim()) {
    return queryOne(db, "SELECT * FROM vv_procedure_steps WHERE id = ? AND tenant_id = ? AND procedure_id = ?", [id, Number(tenantId), Number(procedureId)]);
  }
  return queryOne(db, "SELECT * FROM vv_procedure_steps WHERE tenant_id = ? AND procedure_id = ? AND lower(code) = lower(?)", [Number(tenantId), Number(procedureId), String(stepRef)]);
}

export async function getStepRowAsync(db, tenantId, procedureId, stepRef) {
  const id = Number(stepRef);
  if (Number.isInteger(id) && String(id) === String(stepRef).trim()) {
    return queryOneAsync(db, "SELECT * FROM vv_procedure_steps WHERE id = ? AND tenant_id = ? AND procedure_id = ?", [id, Number(tenantId), Number(procedureId)]);
  }
  return queryOneAsync(db, "SELECT * FROM vv_procedure_steps WHERE tenant_id = ? AND procedure_id = ? AND lower(code) = lower(?)", [Number(tenantId), Number(procedureId), String(stepRef)]);
}

export function updateStep(db, tenantId, procedureRefValue, stepRef, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const procedure = requireProcedureRow(db, tenant, procedureRefValue);
  if (IMMUTABLE_DEFINITION_STATUSES.includes(procedure.status)) throw immutableRecord(`Cannot edit a ${procedure.status} procedure; revise it instead`, { ref: procedure.procedure_ref, status: procedure.status });
  const row = getStepRow(db, tenant, procedure.id, stepRef);
  if (!row) throw stepNotFound(stepRef);
  const input = normalizeStepInput(body, publicStep(row));
  const patch = { ...input };
  if (body.sequence !== undefined) {
    const sequence = toIntOrNull(body.sequence);
    if (sequence === null) throw invalidVv("Invalid step sequence");
    const clash = queryOne(db, "SELECT id FROM vv_procedure_steps WHERE procedure_id = ? AND sequence = ? AND id <> ?", [procedure.id, sequence, row.id]);
    if (clash) throw invalidVv(`A step already exists at sequence ${sequence}`, { sequence });
    patch.sequence = sequence;
  }
  updateRow(db, "vv_procedure_steps", row.id, { ...patch, updated_by: actor?.id ?? null });
  writeAudit(db, { actor, action: "verification-validation.procedure.step.update", resourceType: "vv_procedure_step", resourceId: String(row.id), details: { procedure_ref: procedure.procedure_ref }, ip });
  return publicStep(queryOne(db, "SELECT * FROM vv_procedure_steps WHERE id = ?", [row.id]));
}

export async function updateStepAsync(db, tenantId, procedureRefValue, stepRef, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const procedure = await requireProcedureRowAsync(db, tenant, procedureRefValue);
  if (IMMUTABLE_DEFINITION_STATUSES.includes(procedure.status)) throw immutableRecord(`Cannot edit a ${procedure.status} procedure; revise it instead`, { ref: procedure.procedure_ref, status: procedure.status });
  const row = await getStepRowAsync(db, tenant, procedure.id, stepRef);
  if (!row) throw stepNotFound(stepRef);
  const input = normalizeStepInput(body, publicStep(row));
  const patch = { ...input };
  if (body.sequence !== undefined) {
    const sequence = toIntOrNull(body.sequence);
    if (sequence === null) throw invalidVv("Invalid step sequence");
    const clash = await queryOneAsync(db, "SELECT id FROM vv_procedure_steps WHERE procedure_id = ? AND sequence = ? AND id <> ?", [procedure.id, sequence, row.id]);
    if (clash) throw invalidVv(`A step already exists at sequence ${sequence}`, { sequence });
    patch.sequence = sequence;
  }
  await updateRowAsync(db, "vv_procedure_steps", row.id, { ...patch, updated_by: actor?.id ?? null });
  await writeAuditAsync(db, { actor, action: "verification-validation.procedure.step.update", resourceType: "vv_procedure_step", resourceId: String(row.id), details: { procedure_ref: procedure.procedure_ref }, ip });
  return publicStep(await queryOneAsync(db, "SELECT * FROM vv_procedure_steps WHERE id = ?", [row.id]));
}

export function removeStep(db, tenantId, procedureRefValue, stepRef, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const procedure = requireProcedureRow(db, tenant, procedureRefValue);
  if (IMMUTABLE_DEFINITION_STATUSES.includes(procedure.status)) throw immutableRecord(`Cannot edit a ${procedure.status} procedure; revise it instead`, { ref: procedure.procedure_ref, status: procedure.status });
  const row = getStepRow(db, tenant, procedure.id, stepRef);
  if (!row) throw stepNotFound(stepRef);
  run(db, "DELETE FROM vv_procedure_steps WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "verification-validation.procedure.step.remove", resourceType: "vv_procedure_step", resourceId: String(row.id), details: { procedure_ref: procedure.procedure_ref, sequence: row.sequence }, ip });
  return { removed: true, id: row.id };
}

export async function removeStepAsync(db, tenantId, procedureRefValue, stepRef, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const procedure = await requireProcedureRowAsync(db, tenant, procedureRefValue);
  if (IMMUTABLE_DEFINITION_STATUSES.includes(procedure.status)) throw immutableRecord(`Cannot edit a ${procedure.status} procedure; revise it instead`, { ref: procedure.procedure_ref, status: procedure.status });
  const row = await getStepRowAsync(db, tenant, procedure.id, stepRef);
  if (!row) throw stepNotFound(stepRef);
  await runAsync(db, "DELETE FROM vv_procedure_steps WHERE id = ?", [row.id]);
  await writeAuditAsync(db, { actor, action: "verification-validation.procedure.step.remove", resourceType: "vv_procedure_step", resourceId: String(row.id), details: { procedure_ref: procedure.procedure_ref, sequence: row.sequence }, ip });
  return { removed: true, id: row.id };
}
