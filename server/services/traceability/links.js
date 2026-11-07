// Trace-link CRUD.
//
// A trace link is exactly a typed edge in the shared Object & Relationship
// Framework, so this module delegates every write and read to
// `services/objects.js` rather than re-implementing persistence, validation,
// cardinality, tenant isolation, auditing or domain events. It only normalizes
// the traceability vocabulary (`sourceObject`/`targetObject`/`relationshipType`,
// `effectivity`) onto the framework's existing contract.
import * as objects from "../objects.js";

function first(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function objectRef(value) {
  if (value && typeof value === "object") return first(value.objectId, value.object_id, value.id, value.code);
  return value;
}

// Accepts both the platform shape (source/target/type/attributes/valid_from)
// and the generic traceability shape (sourceObject/targetObject/relationshipType
// /metadata/effectivity).
export function normalizeLinkInput(body = {}) {
  const effectivity = body.effectivity && typeof body.effectivity === "object" ? body.effectivity : {};
  return {
    ...body,
    type: first(body.type, body.relationship_type, body.relationshipType),
    source: first(
      objectRef(body.source),
      objectRef(body.source_object_id),
      objectRef(body.sourceObjectId),
      objectRef(body.sourceObject),
      objectRef(body.from)
    ),
    target: first(
      objectRef(body.target),
      objectRef(body.target_object_id),
      objectRef(body.targetObjectId),
      objectRef(body.targetObject),
      objectRef(body.to)
    ),
    attributes: first(body.attributes, body.metadata, body.link_metadata, {}),
    status: first(body.status, "active"),
    sequence: first(body.sequence, 0),
    valid_from: first(body.valid_from, body.validFrom, effectivity.start, effectivity.from),
    valid_to: first(body.valid_to, body.validTo, effectivity.end, effectivity.to),
  };
}

export function createLink(db, body, actor, tenantId, ip) {
  return objects.createRelationship(db, normalizeLinkInput(body), actor, tenantId, ip);
}
export async function createLinkAsync(db, body, actor, tenantId, ip) {
  return objects.createRelationshipAsync(db, normalizeLinkInput(body), actor, tenantId, ip);
}

export function getLink(db, id, tenantId) {
  return objects.getRelationship(db, id, tenantId);
}
export async function getLinkAsync(db, id, tenantId) {
  return objects.getRelationshipAsync(db, id, tenantId);
}

export function updateLink(db, id, body, actor, tenantId, ip) {
  return objects.updateRelationship(db, id, body, actor, tenantId, ip);
}
export async function updateLinkAsync(db, id, body, actor, tenantId, ip) {
  return objects.updateRelationshipAsync(db, id, body, actor, tenantId, ip);
}

export function deleteLink(db, id, options, actor, tenantId, ip) {
  return objects.deleteRelationship(db, id, options, actor, tenantId, ip);
}
export async function deleteLinkAsync(db, id, options, actor, tenantId, ip) {
  return objects.deleteRelationshipAsync(db, id, options, actor, tenantId, ip);
}

export function listLinks(db, query, tenantId) {
  return objects.listRelationships(db, query, tenantId);
}
export async function listLinksAsync(db, query, tenantId) {
  return objects.listRelationshipsAsync(db, query, tenantId);
}

// All links touching one object, split by direction so callers can render
// "incoming"/"outgoing" without a second request.
export function linksForObject(db, objectType, objectId, tenantId, query = {}) {
  const result = objects.relationshipsForObject(db, objectId, tenantId, query);
  return shapeObjectLinks(result, query);
}
export async function linksForObjectAsync(db, objectType, objectId, tenantId, query = {}) {
  const result = await objects.relationshipsForObjectAsync(db, objectId, tenantId, query);
  return shapeObjectLinks(result, query);
}

function shapeObjectLinks(result, query = {}) {
  const { object = null, outgoing = [], incoming = [] } = result || {};
  const direction = String(query.direction || "BOTH").toUpperCase();
  return {
    source_module: "traceability",
    object,
    direction,
    outgoing: direction === "IN" ? [] : outgoing,
    incoming: direction === "OUT" ? [] : incoming,
    total: outgoing.length + incoming.length,
  };
}
