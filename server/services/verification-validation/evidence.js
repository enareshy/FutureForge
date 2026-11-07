// Evidence service: attach controlled content (documents, images, logs, data
// files) to a test execution or result.
//
// Evidence is not re-modelled: it reuses the File & Content Management Service's
// generic Object <-> Content association framework (`content_associations`). This
// file only resolves V&V targets to object ids, records the association with the
// ATTACHMENT content role (semantic role EVIDENCE in metadata) and maintains the
// denormalised evidence count used by the "pass requires evidence" rule.
import { queryOne } from "../../db.js";
import { queryOneAsync } from "../../db-async.js";
import {
  createAssociation,
  createAssociationAsync,
  listAssociations,
  listAssociationsAsync,
  getAssociation,
  getAssociationAsync,
  removeAssociation,
  removeAssociationAsync,
} from "../content/associations.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { publishVvEvent, publishVvEventAsync } from "./events.js";
import { updateRow, updateRowAsync } from "../requirements/sql.js";
import { normalizeText, parseObject } from "../data-lifecycle/validation.js";
import { SOURCE_MODULE, VV_NODE_TYPES } from "./constants.js";
import { invalidVv, executionNotFound, resultNotFound } from "./errors.js";

const EVIDENCE_ROLE = "EVIDENCE";
const CONTENT_ROLE = "ATTACHMENT";

function normalizeTarget(body = {}) {
  const resultRef = body.result_ref ?? body.resultRef ?? body.result_id ?? body.resultId ?? null;
  const executionRef = body.execution_ref ?? body.executionRef ?? body.execution_id ?? body.executionId ?? null;
  if ((resultRef === null || resultRef === "") && (executionRef === null || executionRef === "")) {
    throw invalidVv("An execution_ref or result_ref is required to attach evidence");
  }
  const contentRef = body.content_id ?? body.contentId ?? body.content_ref ?? body.contentRef ?? null;
  if (contentRef === null || contentRef === "" || contentRef === undefined) throw invalidVv("content_id is required");
  return { resultRef, executionRef, contentRef, role: normalizeText(body.role ?? body.evidence_role ?? EVIDENCE_ROLE, { max: 60 }) || EVIDENCE_ROLE, notes: normalizeText(body.notes ?? body.description ?? "", { max: 2000 }) };
}

function resolveResult(db, tenant, ref) {
  const id = Number(ref);
  const row = Number.isInteger(id) && String(id) === String(ref).trim()
    ? queryOne(db, "SELECT * FROM vv_results WHERE id = ? AND tenant_id = ?", [id, tenant])
    : queryOne(db, "SELECT * FROM vv_results WHERE tenant_id = ? AND result_ref = ?", [tenant, String(ref)]);
  if (!row) throw resultNotFound(ref);
  return row;
}

async function resolveResultAsync(db, tenant, ref) {
  const id = Number(ref);
  return Number.isInteger(id) && String(id) === String(ref).trim()
    ? await queryOneAsync(db, "SELECT * FROM vv_results WHERE id = ? AND tenant_id = ?", [id, tenant])
    : await queryOneAsync(db, "SELECT * FROM vv_results WHERE tenant_id = ? AND result_ref = ?", [tenant, String(ref)]);
}

function resolveExecution(db, tenant, ref) {
  const id = Number(ref);
  const row = Number.isInteger(id) && String(id) === String(ref).trim()
    ? queryOne(db, "SELECT * FROM vv_executions WHERE id = ? AND tenant_id = ?", [id, tenant])
    : queryOne(db, "SELECT * FROM vv_executions WHERE tenant_id = ? AND execution_ref = ?", [tenant, String(ref)]);
  if (!row) throw executionNotFound(ref);
  return row;
}

async function resolveExecutionAsync(db, tenant, ref) {
  const id = Number(ref);
  return Number.isInteger(id) && String(id) === String(ref).trim()
    ? await queryOneAsync(db, "SELECT * FROM vv_executions WHERE id = ? AND tenant_id = ?", [id, tenant])
    : await queryOneAsync(db, "SELECT * FROM vv_executions WHERE tenant_id = ? AND execution_ref = ?", [tenant, String(ref)]);
}

export function countEvidenceFor(db, tenant, objectType, objectId) {
  return Number(queryOne(db, "SELECT COUNT(*) AS c FROM content_associations WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND status = 'active'", [Number(tenant), objectType, String(objectId)])?.c || 0);
}

export async function countEvidenceForAsync(db, tenant, objectType, objectId) {
  return Number((await queryOneAsync(db, "SELECT COUNT(*) AS c FROM content_associations WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND status = 'active'", [Number(tenant), objectType, String(objectId)]))?.c || 0);
}

function associationSummary(row) {
  const meta = row.metadata || parseObject(row.metadata_json, {});
  return {
    association_ref: row.association_ref,
    object_type: row.object_type,
    object_id: Number(row.object_id),
    content_id: Number(row.content_id),
    content_role: row.content_role,
    role: meta.role || EVIDENCE_ROLE,
    notes: meta.notes || "",
    is_primary: Boolean(row.is_primary),
    status: row.status,
    created_at: row.created_at,
  };
}

export function attachEvidence(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const target = normalizeTarget(body);
  let objectType;
  let objectId;
  let objectName;
  let resultRow = null;
  let executionRow = null;
  if (target.resultRef !== null && target.resultRef !== "") {
    resultRow = resolveResult(db, tenant, target.resultRef);
    objectType = VV_NODE_TYPES.TEST_RESULT;
    objectId = resultRow.id;
    objectName = resultRow.result_ref;
  } else {
    executionRow = resolveExecution(db, tenant, target.executionRef);
    objectType = VV_NODE_TYPES.TEST_EXECUTION;
    objectId = executionRow.id;
    objectName = executionRow.execution_ref;
  }
  const association = createAssociation(
    db,
    { objectType, objectId: String(objectId), objectName, contentId: target.contentRef, contentRole: CONTENT_ROLE, metadata: { role: target.role, notes: target.notes } },
    { actor, tenantId: tenant, ip }
  );
  let evidenceCount = null;
  if (resultRow) {
    evidenceCount = countEvidenceFor(db, tenant, VV_NODE_TYPES.TEST_RESULT, objectId);
    updateRow(db, "vv_results", resultRow.id, { evidence_count: evidenceCount, updated_by: actor?.id ?? null });
  }
  writeAudit(db, { actor, action: "verification-validation.evidence.attach", resourceType: objectType === VV_NODE_TYPES.TEST_RESULT ? "vv_test_result" : "vv_test_execution", resourceId: objectName, details: { content_id: target.contentRef, role: target.role }, ip });
  publishVvEvent(db, { eventType: "EvidenceAttached", objectType, objectId: String(objectId), tenantId: tenant, payload: { object_type: objectType, object_id: String(objectId), content_id: target.contentRef, role: target.role } }, actor);
  return { association: associationSummary(association), evidence_count: evidenceCount, target: { object_type: objectType, object_id: objectId, ref: objectName } };
}

export async function attachEvidenceAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const target = normalizeTarget(body);
  let objectType;
  let objectId;
  let objectName;
  let resultRow = null;
  if (target.resultRef !== null && target.resultRef !== "") {
    resultRow = await resolveResultAsync(db, tenant, target.resultRef);
    if (!resultRow) throw resultNotFound(target.resultRef);
    objectType = VV_NODE_TYPES.TEST_RESULT;
    objectId = resultRow.id;
    objectName = resultRow.result_ref;
  } else {
    const executionRow = await resolveExecutionAsync(db, tenant, target.executionRef);
    if (!executionRow) throw executionNotFound(target.executionRef);
    objectType = VV_NODE_TYPES.TEST_EXECUTION;
    objectId = executionRow.id;
    objectName = executionRow.execution_ref;
  }
  const association = await createAssociationAsync(
    db,
    { objectType, objectId: String(objectId), objectName, contentId: target.contentRef, contentRole: CONTENT_ROLE, metadata: { role: target.role, notes: target.notes } },
    { actor, tenantId: tenant, ip }
  );
  let evidenceCount = null;
  if (resultRow) {
    evidenceCount = await countEvidenceForAsync(db, tenant, VV_NODE_TYPES.TEST_RESULT, objectId);
    await updateRowAsync(db, "vv_results", resultRow.id, { evidence_count: evidenceCount, updated_by: actor?.id ?? null });
  }
  await writeAuditAsync(db, { actor, action: "verification-validation.evidence.attach", resourceType: objectType === VV_NODE_TYPES.TEST_RESULT ? "vv_test_result" : "vv_test_execution", resourceId: objectName, details: { content_id: target.contentRef, role: target.role }, ip });
  await publishVvEventAsync(db, { eventType: "EvidenceAttached", objectType, objectId: String(objectId), tenantId: tenant, payload: { object_type: objectType, object_id: String(objectId), content_id: target.contentRef, role: target.role } }, actor);
  return { association: associationSummary(association), evidence_count: evidenceCount, target: { object_type: objectType, object_id: objectId, ref: objectName } };
}

export function listEvidence(db, tenantId, body = {}) {
  const tenant = Number(tenantId);
  const target = normalizeTarget({ ...body, content_id: body.content_id ?? "__list__" });
  let objectType;
  let objectId;
  let ref;
  if (target.resultRef !== null && target.resultRef !== "") {
    const row = resolveResult(db, tenant, target.resultRef);
    objectType = VV_NODE_TYPES.TEST_RESULT;
    objectId = row.id;
    ref = row.result_ref;
  } else {
    const row = resolveExecution(db, tenant, target.executionRef);
    objectType = VV_NODE_TYPES.TEST_EXECUTION;
    objectId = row.id;
    ref = row.execution_ref;
  }
  const listed = listAssociations(db, { tenantId: tenant, objectType, objectId: String(objectId), page: body.page, pageSize: body.pageSize ?? body.page_size });
  return { target: { object_type: objectType, object_id: objectId, ref }, items: listed.items.map(associationSummary), total: listed.total, page: listed.page, page_size: listed.page_size, source_module: SOURCE_MODULE };
}

export async function listEvidenceAsync(db, tenantId, body = {}) {
  const tenant = Number(tenantId);
  const target = normalizeTarget({ ...body, content_id: body.content_id ?? "__list__" });
  let objectType;
  let objectId;
  let ref;
  if (target.resultRef !== null && target.resultRef !== "") {
    const row = await resolveResultAsync(db, tenant, target.resultRef);
    if (!row) throw resultNotFound(target.resultRef);
    objectType = VV_NODE_TYPES.TEST_RESULT;
    objectId = row.id;
    ref = row.result_ref;
  } else {
    const row = await resolveExecutionAsync(db, tenant, target.executionRef);
    if (!row) throw executionNotFound(target.executionRef);
    objectType = VV_NODE_TYPES.TEST_EXECUTION;
    objectId = row.id;
    ref = row.execution_ref;
  }
  const listed = await listAssociationsAsync(db, { tenantId: tenant, objectType, objectId: String(objectId), page: body.page, pageSize: body.pageSize ?? body.page_size });
  return { target: { object_type: objectType, object_id: objectId, ref }, items: listed.items.map(associationSummary), total: listed.total, page: listed.page, page_size: listed.page_size, source_module: SOURCE_MODULE };
}

function recountAfterRemoval(db, tenant, association, actor) {
  if (!association || association.object_type !== VV_NODE_TYPES.TEST_RESULT) return null;
  const count = countEvidenceFor(db, tenant, VV_NODE_TYPES.TEST_RESULT, association.object_id);
  updateRow(db, "vv_results", Number(association.object_id), { evidence_count: count, updated_by: actor?.id ?? null });
  return count;
}

export function detachEvidence(db, tenantId, associationRef, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const association = getAssociation(db, associationRef, tenant);
  if (!association) throw invalidVv(`Evidence association not found: ${associationRef}`);
  const removed = removeAssociation(db, associationRef, { actor, tenantId: tenant, ip });
  const evidenceCount = recountAfterRemoval(db, tenant, association, actor);
  writeAudit(db, { actor, action: "verification-validation.evidence.detach", resourceType: "content_association", resourceId: associationRef, details: {}, ip });
  return { removed: true, association: removed, evidence_count: evidenceCount };
}

export async function detachEvidenceAsync(db, tenantId, associationRef, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const association = await getAssociationAsync(db, associationRef, tenant);
  if (!association) throw invalidVv(`Evidence association not found: ${associationRef}`);
  const removed = await removeAssociationAsync(db, associationRef, { actor, tenantId: tenant, ip });
  let evidenceCount = null;
  if (association.object_type === VV_NODE_TYPES.TEST_RESULT) {
    evidenceCount = await countEvidenceForAsync(db, tenant, VV_NODE_TYPES.TEST_RESULT, association.object_id);
    await updateRowAsync(db, "vv_results", Number(association.object_id), { evidence_count: evidenceCount, updated_by: actor?.id ?? null });
  }
  await writeAuditAsync(db, { actor, action: "verification-validation.evidence.detach", resourceType: "content_association", resourceId: associationRef, details: {}, ip });
  return { removed: true, association: removed, evidence_count: evidenceCount };
}
