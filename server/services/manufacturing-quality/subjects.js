// Authoritative subject resolution for quality records.
//
// A quality issue / inspection / readiness evaluation may reference product
// revisions, operations, MBOM/BOP revisions and change records. This module
// resolves such references against the OWNING module so a quality record can
// never point at an object that does not exist, is soft-deleted, or belongs to a
// different tenant. Derived quality data therefore never becomes an
// authorization bypass (prompt §3.3).
import { queryOne } from "../../db.js";
import { queryOneAsync } from "../../db-async.js";
import { normalizeText } from "../data-lifecycle/validation.js";
import { SUBJECT_TYPES } from "./constants.js";
import { invalidSubject, subjectNotFound } from "./errors.js";

function asId(value) {
  const n = Number(value);
  return Number.isInteger(n) && String(n) === String(value).trim() ? n : null;
}

export function normalizeSubjectType(value) {
  const type = normalizeText(value, { max: 40 }).toUpperCase();
  if (!type) return "";
  if (!Object.values(SUBJECT_TYPES).includes(type)) {
    throw invalidSubject(`Unknown subject_type: ${type}`, { allowed: Object.values(SUBJECT_TYPES) });
  }
  return type;
}

// Resolve a generic Object framework instance (product revision object,
// operation, supplier ...) scoped to the tenant and not soft-deleted.
export function resolveObjectSubject(db, tenantId, objectId, label = "object") {
  const id = asId(objectId);
  if (id === null) return null;
  const row = queryOne(db, "SELECT id, code, name, object_type_id, status, tenant_id, deleted_at FROM objects WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  if (!row || row.deleted_at) throw subjectNotFound(label, objectId);
  return row;
}

export async function resolveObjectSubjectAsync(db, tenantId, objectId, label = "object") {
  const id = asId(objectId);
  if (id === null) return null;
  const row = await queryOneAsync(db, "SELECT id, code, name, object_type_id, status, tenant_id, deleted_at FROM objects WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
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

// Resolve a readiness/quality subject tuple into its authoritative row.
// Returns { subject_type, row, revision, ref }. Throws when the subject cannot
// be found in the caller's tenant.
export function resolveSubject(db, tenantId, subjectType, ref) {
  const type = normalizeSubjectType(subjectType);
  if (!type) throw invalidSubject("subject_type is required");
  if (ref === null || ref === undefined || ref === "") throw invalidSubject("subject reference is required");
  switch (type) {
    case SUBJECT_TYPES.PRODUCT_REVISION: {
      const row = resolveObjectSubject(db, tenantId, ref, "PRODUCT_REVISION");
      return { subject_type: type, row, revision: normalizeText(row?.revision ?? "", { max: 60 }), ref: String(ref) };
    }
    case SUBJECT_TYPES.OPERATION: {
      const row = resolveObjectSubject(db, tenantId, ref, "OPERATION");
      return { subject_type: type, row, revision: "", ref: String(ref) };
    }
    case SUBJECT_TYPES.MBOM_REVISION: {
      const row = resolveBomRevisionSubject(db, tenantId, ref);
      return { subject_type: type, row, revision: normalizeText(row?.revision_number ?? "", { max: 60 }), ref: String(ref) };
    }
    case SUBJECT_TYPES.CHANGE: {
      const row = resolveChangeSubject(db, tenantId, ref);
      return { subject_type: type, row, revision: "", ref: String(ref) };
    }
    default:
      throw invalidSubject(`Unsupported subject_type: ${type}`);
  }
}

export async function resolveSubjectAsync(db, tenantId, subjectType, ref) {
  const type = normalizeSubjectType(subjectType);
  if (!type) throw invalidSubject("subject_type is required");
  if (ref === null || ref === undefined || ref === "") throw invalidSubject("subject reference is required");
  switch (type) {
    case SUBJECT_TYPES.PRODUCT_REVISION: {
      const row = await resolveObjectSubjectAsync(db, tenantId, ref, "PRODUCT_REVISION");
      return { subject_type: type, row, revision: "", ref: String(ref) };
    }
    case SUBJECT_TYPES.OPERATION: {
      const row = await resolveObjectSubjectAsync(db, tenantId, ref, "OPERATION");
      return { subject_type: type, row, revision: "", ref: String(ref) };
    }
    case SUBJECT_TYPES.MBOM_REVISION: {
      const row = await resolveBomRevisionSubjectAsync(db, tenantId, ref);
      return { subject_type: type, row, revision: normalizeText(row?.revision_number ?? "", { max: 60 }), ref: String(ref) };
    }
    case SUBJECT_TYPES.CHANGE: {
      const row = await resolveChangeSubjectAsync(db, tenantId, ref);
      return { subject_type: type, row, revision: "", ref: String(ref) };
    }
    default:
      throw invalidSubject(`Unsupported subject_type: ${type}`);
  }
}
