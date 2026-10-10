// Manufacturing object helpers: operations and work centers.
//
// These are NOT a new object model. They are thin, validating wrappers over the
// platform Object & Relationship Framework: an operation/work center is a
// generic `objects` row whose metadata type this layer registers, and their
// relationships (operation performed-at work center, operation precedes
// operation, BOP executed-in operation) are ordinary `object_relationships`.
// Reusing the framework means object numbering, lifecycle, audit, IAM and the
// Digital Thread all work with no extra code.
import {
  createObject,
  createObjectAsync,
  getObject,
  getObjectAsync,
  listObjects,
  listObjectsAsync,
  createRelationship,
  createRelationshipAsync,
} from "../objects.js";
import { OPERATION_OBJECT_TYPE, WORK_CENTER_OBJECT_TYPE, MANUFACTURING_OBJECT_TYPE_CODES } from "./constants.js";
import { invalidTarget } from "./errors.js";

const OBJECT_TYPE_SET = new Set(MANUFACTURING_OBJECT_TYPE_CODES);

function assertManufacturingType(type) {
  const code = String(type || "").toLowerCase();
  if (!OBJECT_TYPE_SET.has(code)) {
    throw invalidTarget(`Object type must be one of: ${MANUFACTURING_OBJECT_TYPE_CODES.join(", ")}`, { type });
  }
  return code;
}

export function createManufacturingObject(db, tenantId, body = {}, actor = null, ip = null) {
  const type = assertManufacturingType(body.object_type ?? body.objectType ?? body.type);
  return createObject(db, {
    ...body,
    type,
    code: body.code,
    name: body.name ?? body.code,
  }, actor, tenantId, ip);
}

export async function createManufacturingObjectAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const type = assertManufacturingType(body.object_type ?? body.objectType ?? body.type);
  return createObjectAsync(db, {
    ...body,
    type,
    code: body.code,
    name: body.name ?? body.code,
  }, actor, tenantId, ip);
}

export function getManufacturingObject(db, tenantId, ref) {
  return getObject(db, ref, tenantId);
}

export async function getManufacturingObjectAsync(db, tenantId, ref) {
  return getObjectAsync(db, ref, tenantId);
}

export function listManufacturingObjects(db, tenantId, { objectType, ...query } = {}) {
  const type = objectType ? assertManufacturingType(objectType) : undefined;
  return listObjects(db, { ...query, type }, tenantId);
}

export async function listManufacturingObjectsAsync(db, tenantId, { objectType, ...query } = {}) {
  const type = objectType ? assertManufacturingType(objectType) : undefined;
  return listObjectsAsync(db, { ...query, type }, tenantId);
}

// Creates an Object & Relationship edge between two manufacturing objects. The
// relationship type is registered by this layer's foundation (for example
// `operation.performed-at.work-center`). Endpoint type constraints are enforced
// by the Object framework through the registered `relationship_types` row.
export function linkManufacturingObjects(db, tenantId, body = {}, actor = null, ip = null) {
  const sequence = body.sequence ?? body.order;
  return createRelationship(db, {
    relationship_type: body.relationship_type ?? body.relationshipType,
    source: body.source ?? body.source_id ?? body.sourceId,
    target: body.target ?? body.target_id ?? body.targetId,
    attributes: body.attributes ?? {},
    valid_from: body.valid_from ?? body.validFrom,
    valid_to: body.valid_to ?? body.validTo,
    ...(sequence !== undefined && sequence !== null ? { sequence } : {}),
  }, actor, tenantId, ip);
}

export async function linkManufacturingObjectsAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const sequence = body.sequence ?? body.order;
  return createRelationshipAsync(db, {
    relationship_type: body.relationship_type ?? body.relationshipType,
    source: body.source ?? body.source_id ?? body.sourceId,
    target: body.target ?? body.target_id ?? body.targetId,
    attributes: body.attributes ?? {},
    valid_from: body.valid_from ?? body.validFrom,
    valid_to: body.valid_to ?? body.validTo,
    ...(sequence !== undefined && sequence !== null ? { sequence } : {}),
  }, actor, tenantId, ip);
}

export const OPERATION_TYPE = OPERATION_OBJECT_TYPE;
export const WORK_CENTER_TYPE = WORK_CENTER_OBJECT_TYPE;
