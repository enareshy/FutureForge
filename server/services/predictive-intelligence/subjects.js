// Authoritative subject resolution for predictions.
//
// A prediction may reference product revisions, operations, MBOM revisions and
// change records. References are resolved against the OWNING module so a
// prediction can never describe an object that does not exist, is soft-deleted,
// or belongs to a different tenant. Derived predictions therefore never become
// an authorization bypass (prompt §3.3, acceptance §10.10).
import { queryOne } from "../../db.js";
import { queryOneAsync } from "../../db-async.js";
import { normalizeText } from "../data-lifecycle/validation.js";
import { SUBJECT_TYPES, SUBJECT_TYPE_VALUES } from "./constants.js";
import { invalidSubject, subjectNotFound } from "./errors.js";

function asId(value) {
  const n = Number(value);
  return Number.isInteger(n) && String(n) === String(value).trim() ? n : null;
}

export function normalizeSubjectType(value) {
  const type = normalizeText(value, { max: 40 }).toUpperCase();
  if (!type) return "";
  if (!SUBJECT_TYPE_VALUES.includes(type)) {
    throw invalidSubject(`Unknown subject_type: ${type}`, { allowed: [...SUBJECT_TYPE_VALUES] });
  }
  return type;
}

export function resolveObjectSubject(db, tenantId, objectId, label = "object") {
  const id = asId(objectId);
  if (id === null) return null;
  const row = queryOne(db, "SELECT id, code, name, object_type_id, status, tenant_id, organization_id, deleted_at FROM objects WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  if (!row || row.deleted_at) throw subjectNotFound(label, objectId);
  return row;
}

export async function resolveObjectSubjectAsync(db, tenantId, objectId, label = "object") {
  const id = asId(objectId);
  if (id === null) return null;
  const row = await queryOneAsync(db, "SELECT id, code, name, object_type_id, status, tenant_id, organization_id, deleted_at FROM objects WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  if (!row || row.deleted_at) throw subjectNotFound(label, objectId);
  return row;
}

export function resolveBomRevisionSubject(db, tenantId, revisionRef) {
  const id = asId(revisionRef);
  const row = id !== null
    ? queryOne(db, "SELECT * FROM bom_revisions WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)])
    : queryOne(db, "SELECT * FROM bom_revisions WHERE tenant_id = ? AND revision_ref = ?", [Number(tenantId), String(revisionRef)]);
  if (!row) throw subjectNotFound("MBOM_REVISION", revisionRef);
  return row;
}

export async function resolveBomRevisionSubjectAsync(db, tenantId, revisionRef) {
  const id = asId(revisionRef);
  const row = id !== null
    ? await queryOneAsync(db, "SELECT * FROM bom_revisions WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)])
    : await queryOneAsync(db, "SELECT * FROM bom_revisions WHERE tenant_id = ? AND revision_ref = ?", [Number(tenantId), String(revisionRef)]);
  if (!row) throw subjectNotFound("MBOM_REVISION", revisionRef);
  return row;
}

export function resolveChangeSubject(db, tenantId, changeRef) {
  const id = asId(changeRef);
  const row = id !== null
    ? queryOne(db, "SELECT * FROM change_requests WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)])
    : queryOne(db, "SELECT * FROM change_requests WHERE tenant_id = ? AND (request_ref = ? OR lower(request_number) = lower(?))", [Number(tenantId), String(changeRef), String(changeRef)]);
  if (!row) throw subjectNotFound("CHANGE", changeRef);
  return row;
}

export async function resolveChangeSubjectAsync(db, tenantId, changeRef) {
  const id = asId(changeRef);
  const row = id !== null
    ? await queryOneAsync(db, "SELECT * FROM change_requests WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)])
    : await queryOneAsync(db, "SELECT * FROM change_requests WHERE tenant_id = ? AND (request_ref = ? OR lower(request_number) = lower(?))", [Number(tenantId), String(changeRef), String(changeRef)]);
  if (!row) throw subjectNotFound("CHANGE", changeRef);
  return row;
}

export function resolveSubject(db, tenantId, subjectType, ref) {
  const type = normalizeSubjectType(subjectType);
  if (!type) throw invalidSubject("subject_type is required");
  if (ref === null || ref === undefined || ref === "") throw invalidSubject("subject reference is required");
  switch (type) {
    case SUBJECT_TYPES.PRODUCT_REVISION:
      return { subject_type: type, row: resolveObjectSubject(db, tenantId, ref, "PRODUCT_REVISION"), ref: String(ref) };
    case SUBJECT_TYPES.OPERATION:
      return { subject_type: type, row: resolveObjectSubject(db, tenantId, ref, "OPERATION"), ref: String(ref) };
    case SUBJECT_TYPES.MBOM_REVISION:
      return { subject_type: type, row: resolveBomRevisionSubject(db, tenantId, ref), ref: String(ref) };
    case SUBJECT_TYPES.CHANGE:
      return { subject_type: type, row: resolveChangeSubject(db, tenantId, ref), ref: String(ref) };
    default:
      throw invalidSubject(`Unsupported subject_type: ${type}`);
  }
}

export async function resolveSubjectAsync(db, tenantId, subjectType, ref) {
  const type = normalizeSubjectType(subjectType);
  if (!type) throw invalidSubject("subject_type is required");
  if (ref === null || ref === undefined || ref === "") throw invalidSubject("subject reference is required");
  switch (type) {
    case SUBJECT_TYPES.PRODUCT_REVISION:
      return { subject_type: type, row: await resolveObjectSubjectAsync(db, tenantId, ref, "PRODUCT_REVISION"), ref: String(ref) };
    case SUBJECT_TYPES.OPERATION:
      return { subject_type: type, row: await resolveObjectSubjectAsync(db, tenantId, ref, "OPERATION"), ref: String(ref) };
    case SUBJECT_TYPES.MBOM_REVISION:
      return { subject_type: type, row: await resolveBomRevisionSubjectAsync(db, tenantId, ref), ref: String(ref) };
    case SUBJECT_TYPES.CHANGE:
      return { subject_type: type, row: await resolveChangeSubjectAsync(db, tenantId, ref), ref: String(ref) };
    default:
      throw invalidSubject(`Unsupported subject_type: ${type}`);
  }
}
