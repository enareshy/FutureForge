import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import * as metadata from "../metadata.js";
import * as tenants from "../tenants.js";
import { findObjectRow, briefObject } from "./repository.js";
import { findRelationshipType, publicRelationshipType } from "./relationship-types.js";
import { RELATIONSHIP_STATUSES, assertValidEdgeValues } from "./validation.js";

// Relationship engine. Creates, validates and traverses typed edges while
// enforcing type compatibility, cardinality, tenant isolation and referential
// integrity. Edges are soft-deleted so the graph keeps an auditable history.

export const MAX_TRAVERSAL_DEPTH = 10;

const REL_SELECT = `
  SELECT r.*,
    rt.code AS type_code, rt.name AS type_name, rt.cardinality, rt.semantic, rt.directed,
    rt.bidirectional, rt.inverse_code, rt.cascade_delete, rt.attributes_json AS type_attributes_json,
    s.code AS source_code, s.name AS source_name, s.status AS source_status, s.deleted_at AS source_deleted_at,
    st.code AS source_type_code, st.name AS source_type_name,
    tgt.code AS target_code, tgt.name AS target_name, tgt.status AS target_status, tgt.deleted_at AS target_deleted_at,
    tt.code AS target_type_code, tt.name AS target_type_name
  FROM object_relationships r
  JOIN relationship_types rt ON rt.id = r.relationship_type_id
  JOIN objects s ON s.id = r.source_object_id
  JOIN objects tgt ON tgt.id = r.target_object_id
  LEFT JOIN metadata_types st ON st.id = s.object_type_id
  LEFT JOIN metadata_types tt ON tt.id = tgt.object_type_id
`;

function safeParse(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function getRelationshipRow(db, id) {
  return queryOne(db, `${REL_SELECT} WHERE r.id = ?`, [Number(id)]);
}

export function publicRelationship(row) {
  if (!row) return null;
  return {
    id: row.id,
    relationship_type_id: row.relationship_type_id,
    relationship_type: {
      id: row.relationship_type_id,
      code: row.type_code,
      name: row.type_name,
      cardinality: row.cardinality,
      semantic: row.semantic,
      directed: row.directed === 1,
      bidirectional: row.bidirectional === 1,
      inverse_code: row.inverse_code || "",
      cascade_delete: row.cascade_delete === 1,
      attributes: safeParse(row.type_attributes_json, []),
    },
    source: {
      id: row.source_object_id,
      code: row.source_code,
      name: row.source_name,
      status: row.source_status,
      type: { code: row.source_type_code, name: row.source_type_name },
      deleted: Boolean(row.source_deleted_at),
    },
    target: {
      id: row.target_object_id,
      code: row.target_code,
      name: row.target_name,
      status: row.target_status,
      type: { code: row.target_type_code, name: row.target_type_name },
      deleted: Boolean(row.target_deleted_at),
    },
    direction: "forward",
    status: row.status,
    sequence: row.sequence,
    attributes: safeParse(row.attributes_json, {}),
    valid_from: row.valid_from || null,
    valid_to: row.valid_to || null,
    tenant_id: row.tenant_id,
    deleted: Boolean(row.deleted_at),
    deleted_at: row.deleted_at || null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// A type constraint is satisfied by the exact type or any descendant type.
function assertTypeCompatible(db, objectTypeId, expectedTypeId, label) {
  if (!expectedTypeId) return;
  if (Number(objectTypeId) === Number(expectedTypeId)) return;
  const chain = metadata.ancestorTypes(db, objectTypeId);
  if (chain.some((ancestor) => Number(ancestor.id) === Number(expectedTypeId))) return;
  throw new HttpError(409, `${label} object type is not compatible with this relationship type`);
}

function activeEdgeCount(db, typeId, where, params) {
  return queryOne(
    db,
    `SELECT COUNT(*) AS c FROM object_relationships
     WHERE relationship_type_id = ? AND status = 'active' AND deleted_at IS NULL AND ${where}`,
    [Number(typeId), ...params]
  ).c;
}

function assertCardinality(db, type, sourceId, targetId) {
  const sourceOut = activeEdgeCount(db, type.id, "source_object_id = ?", [sourceId]);
  const sourceIn = activeEdgeCount(db, type.id, "target_object_id = ?", [sourceId]);
  const targetOut = activeEdgeCount(db, type.id, "source_object_id = ?", [targetId]);
  const targetIn = activeEdgeCount(db, type.id, "target_object_id = ?", [targetId]);

  if (type.max_occurrences !== null && type.max_occurrences !== undefined && sourceOut >= type.max_occurrences) {
    throw new HttpError(409, `Source already has the maximum of ${type.max_occurrences} relationships of this type`);
  }
  switch (type.cardinality) {
    case "1:1":
      if (sourceOut || sourceIn) throw new HttpError(409, "Source already participates in a 1:1 relationship of this type");
      if (targetOut || targetIn) throw new HttpError(409, "Target already participates in a 1:1 relationship of this type");
      break;
    case "1:N":
      if (targetIn) throw new HttpError(409, "Target already has a source for this 1:N relationship type");
      break;
    case "N:1":
      if (sourceOut) throw new HttpError(409, "Source already has a target for this N:1 relationship type");
      break;
    default:
      break;
  }
}

function resolveObjectId(db, body, keys, label, tenantId) {
  for (const key of keys) {
    const value = body?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  throw new HttpError(400, `${label} object is required`);
}

// Builds and fully validates a relationship without persisting it. Used by both
// createRelationship and the dry-run validate endpoint so behaviour cannot drift.
export function planRelationship(db, body, tenantId, { excludeId = null } = {}) {
  if (!tenantId) throw new HttpError(400, "Tenant context is required for relationships");
  const typeRef = body.type ?? body.relationship_type ?? body.relationshipType ?? body.relationship_type_id;
  if (typeRef === undefined || typeRef === null || typeRef === "") {
    throw new HttpError(400, "Relationship type is required");
  }
  const type = findRelationshipType(db, typeRef, tenantId);
  if (type.status !== "active") {
    throw new HttpError(409, `Relationship type ${type.code} is not active`);
  }
  const sourceRef = resolveObjectId(
    db,
    body,
    ["source", "source_object_id", "sourceObjectId", "from", "from_object_id"],
    "Source",
    tenantId
  );
  const targetRef = resolveObjectId(
    db,
    body,
    ["target", "target_object_id", "targetObjectId", "to", "to_object_id"],
    "Target",
    tenantId
  );
  const sourceRow = findObjectRow(db, sourceRef, tenantId);
  const targetRow = findObjectRow(db, targetRef, tenantId);
  if (sourceRow.deleted_at) throw new HttpError(409, "Source object is deleted");
  if (targetRow.deleted_at) throw new HttpError(409, "Target object is deleted");
  if (sourceRow.id === targetRow.id && type.allow_self !== 1) {
    throw new HttpError(400, "Self-relationships are not allowed for this relationship type");
  }
  assertTypeCompatible(db, sourceRow.object_type_id, type.source_type_id, "Source");
  assertTypeCompatible(db, targetRow.object_type_id, type.target_type_id, "Target");

  if (excludeId) {
    const duplicate = queryOne(
      db,
      `SELECT id FROM object_relationships
       WHERE relationship_type_id = ? AND source_object_id = ? AND target_object_id = ?
         AND deleted_at IS NULL AND id != ?`,
      [type.id, sourceRow.id, targetRow.id, Number(excludeId)]
    );
    if (duplicate) throw new HttpError(409, "This relationship already exists");
  } else {
    const duplicate = queryOne(
      db,
      `SELECT id FROM object_relationships
       WHERE relationship_type_id = ? AND source_object_id = ? AND target_object_id = ? AND deleted_at IS NULL`,
      [type.id, sourceRow.id, targetRow.id]
    );
    if (duplicate) throw new HttpError(409, "This relationship already exists");
    assertCardinality(db, type, sourceRow.id, targetRow.id);
  }

  const definition = safeParse(type.attributes_json, []);
  const attributes = assertValidEdgeValues(definition, body.attributes || {});
  const status = body.status && RELATIONSHIP_STATUSES.includes(body.status) ? body.status : "active";
  const sequence = body.sequence === undefined ? 0 : Number(body.sequence) || 0;
  return {
    type,
    sourceRow,
    targetRow,
    attributes,
    status,
    sequence,
    validFrom: body.valid_from ?? body.validFrom ?? null,
    validTo: body.valid_to ?? body.validTo ?? null,
    tenantId: Number(sourceRow.tenant_id),
  };
}

export function createRelationship(db, body, actor, tenantId, ip) {
  tenants.assertTenantScope(db, actor, tenantId);
  const plan = planRelationship(db, body, tenantId);
  let result;
  try {
    result = run(
      db,
      `INSERT INTO object_relationships
        (relationship_type_id, source_object_id, target_object_id, status, sequence,
         attributes_json, valid_from, valid_to, tenant_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        plan.type.id,
        plan.sourceRow.id,
        plan.targetRow.id,
        plan.status,
        plan.sequence,
        JSON.stringify(plan.attributes),
        plan.validFrom,
        plan.validTo,
        plan.tenantId,
        actor?.id ?? null,
        nowIso(),
        nowIso(),
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "This relationship already exists");
    }
    throw err;
  }
  writeAudit(db, {
    actor,
    action: "relationship.create",
    resourceType: "object_relationship",
    resourceId: result.lastInsertRowid,
    details: {
      type: plan.type.code,
      source: plan.sourceRow.code,
      target: plan.targetRow.code,
      semantic: plan.type.semantic,
    },
    ip,
  });
  return publicRelationship(getRelationshipRow(db, result.lastInsertRowid));
}

export function validateRelationship(db, body, tenantId) {
  try {
    const plan = planRelationship(db, body, tenantId);
    return {
      valid: true,
      relationship_type: publicRelationshipType(plan.type),
      source: briefObject(db, plan.sourceRow.id, tenantId),
      target: briefObject(db, plan.targetRow.id, tenantId),
      attributes: plan.attributes,
      cardinality: plan.type.cardinality,
    };
  } catch (err) {
    if (err instanceof HttpError) {
      return { valid: false, error: err.message, details: err.details || null };
    }
    throw err;
  }
}

export function getRelationship(db, id, tenantId) {
  const row = getRelationshipRow(db, id);
  if (!row || Number(row.tenant_id) !== Number(tenantId)) throw new HttpError(404, "Relationship not found");
  return publicRelationship(row);
}

export function listRelationships(db, query = {}, tenantId) {
  if (!tenantId) throw new HttpError(400, "Tenant context is required");
  const { page, pageSize, offset } = pagination(query);
  const where = ["r.tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.source || query.source_object_id) {
    where.push("r.source_object_id = ?");
    params.push(Number(query.source || query.source_object_id));
  }
  if (query.target || query.target_object_id) {
    where.push("r.target_object_id = ?");
    params.push(Number(query.target || query.target_object_id));
  }
  if (query.type) {
    if (/^\d+$/.test(String(query.type))) {
      where.push("r.relationship_type_id = ?");
      params.push(Number(query.type));
    } else {
      where.push("rt.code = ?");
      params.push(String(query.type));
    }
  }
  if (query.semantic) {
    where.push("rt.semantic = ?");
    params.push(String(query.semantic));
  }
  if (query.status) {
    where.push("r.status = ?");
    params.push(String(query.status));
  }
  const includeDeleted = query.includeDeleted === true || query.include_deleted === true;
  if (!includeDeleted) where.push("r.deleted_at IS NULL");
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM object_relationships r JOIN relationship_types rt ON rt.id = r.relationship_type_id ${clause}`,
    params
  ).c;
  const items = queryAll(
    db,
    `${REL_SELECT} ${clause} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicRelationship);
  return { items, total, page, pageSize };
}

export function updateRelationship(db, id, body, actor, tenantId, ip) {
  const row = getRelationshipRow(db, id);
  if (!row || Number(row.tenant_id) !== Number(tenantId)) throw new HttpError(404, "Relationship not found");
  if (row.deleted_at) throw new HttpError(409, "Cannot update a deleted relationship");
  tenants.assertTenantScope(db, actor, tenantId);
  const definition = safeParse(row.type_attributes_json, []);
  const attributes = body.attributes === undefined
    ? row.attributes_json
    : JSON.stringify(assertValidEdgeValues(definition, body.attributes));
  const status = body.status ?? row.status;
  if (!RELATIONSHIP_STATUSES.includes(status)) {
    throw new HttpError(400, `status must be one of: ${RELATIONSHIP_STATUSES.join(", ")}`);
  }
  run(
    db,
    `UPDATE object_relationships SET status = ?, sequence = ?, attributes_json = ?,
      valid_from = ?, valid_to = ?, updated_at = ? WHERE id = ?`,
    [
      status,
      body.sequence === undefined ? row.sequence : Number(body.sequence) || 0,
      attributes,
      body.valid_from === undefined && body.validFrom === undefined ? row.valid_from : body.valid_from ?? body.validFrom ?? null,
      body.valid_to === undefined && body.validTo === undefined ? row.valid_to : body.valid_to ?? body.validTo ?? null,
      nowIso(),
      row.id,
    ]
  );
  writeAudit(db, {
    actor,
    action: "relationship.update",
    resourceType: "object_relationship",
    resourceId: row.id,
    details: { type: row.type_code, status },
    ip,
  });
  return publicRelationship(getRelationshipRow(db, row.id));
}

export function deleteRelationship(db, id, { force = false } = {}, actor, tenantId, ip) {
  const row = getRelationshipRow(db, id);
  if (!row || Number(row.tenant_id) !== Number(tenantId)) throw new HttpError(404, "Relationship not found");
  if (row.deleted_at) throw new HttpError(409, "Relationship is already deleted");
  tenants.assertTenantScope(db, actor, tenantId);
  const type = findRelationshipType(db, row.relationship_type_id, tenantId);
  if (!force && row.status === "active") {
    const remaining = activeEdgeCount(db, type.id, "source_object_id = ?", [row.source_object_id]);
    const minimum = type.required === 1 && type.min_occurrences < 1 ? 1 : type.min_occurrences;
    if (minimum && remaining <= minimum) {
      throw new HttpError(409, `At least ${minimum} relationship(s) of type ${type.code} are required for this source`);
    }
  }
  run(
    db,
    "UPDATE object_relationships SET status = 'inactive', deleted_at = ?, updated_at = ? WHERE id = ?",
    [nowIso(), nowIso(), row.id]
  );
  writeAudit(db, {
    actor,
    action: "relationship.delete",
    resourceType: "object_relationship",
    resourceId: row.id,
    details: { type: row.type_code, source: row.source_object_id, target: row.target_object_id, forced: force },
    ip,
  });
  return { deleted: true, id: row.id };
}

export function relationshipsForObject(db, reference, tenantId, query = {}) {
  const row = findObjectRow(db, reference, tenantId);
  const statusClause = query.status ? " AND r.status = ?" : "";
  const statusParams = query.status ? [query.status] : [];
  const includeDeleted = query.includeDeleted === true || query.include_deleted === true;
  const deletedClause = includeDeleted ? "" : " AND r.deleted_at IS NULL";
  const outgoing = queryAll(
    db,
    `${REL_SELECT} WHERE r.source_object_id = ?${deletedClause}${statusClause} ORDER BY r.id DESC`,
    [row.id, ...statusParams]
  ).map(publicRelationship);
  const incoming = queryAll(
    db,
    `${REL_SELECT} WHERE r.target_object_id = ?${deletedClause}${statusClause} ORDER BY r.id DESC`,
    [row.id, ...statusParams]
  ).map(publicRelationship);
  return { object: briefObject(db, row.id, tenantId), outgoing, incoming };
}

// Breadth-first traversal with a hard depth cap and visited set. Direction is
// `out`, `in` or `both`; optional relationship-type code narrows the walk.
export function traverse(db, reference, options = {}, tenantId) {
  const row = findObjectRow(db, reference, tenantId);
  const direction = ["out", "in", "both"].includes(options.direction) ? options.direction : "out";
  const depth = Math.min(MAX_TRAVERSAL_DEPTH, Math.max(1, Number(options.depth) || 1));
  const status = options.status === undefined ? "active" : options.status;
  const typeCode = options.type && !/^\d+$/.test(String(options.type)) ? String(options.type) : null;
  const typeId = options.type && /^\d+$/.test(String(options.type)) ? Number(options.type) : null;

  const visited = new Set([row.id]);
  const nodes = new Map([[row.id, briefObject(db, row.id, tenantId)]]);
  const edges = [];
  let frontier = [row.id];

  const loadEdges = (ids, dir) => {
    if (!ids.length) return [];
    const marks = ids.map(() => "?").join(",");
    const where = [];
    const params = [];
    if (dir === "out") where.push(`r.source_object_id IN (${marks})`), params.push(...ids);
    else where.push(`r.target_object_id IN (${marks})`), params.push(...ids);
    if (status) {
      where.push("r.status = ?");
      params.push(status);
    }
    where.push("r.deleted_at IS NULL");
    if (typeCode) {
      where.push("rt.code = ?");
      params.push(typeCode);
    }
    if (typeId) {
      where.push("r.relationship_type_id = ?");
      params.push(typeId);
    }
    return queryAll(db, `${REL_SELECT} WHERE ${where.join(" AND ")}`, params);
  };

  for (let level = 1; level <= depth; level += 1) {
    const found = new Map();
    if (direction === "out" || direction === "both") {
      for (const edge of loadEdges(frontier, "out")) found.set(edge.id, { edge, from: edge.source_object_id, to: edge.target_object_id });
    }
    if (direction === "in" || direction === "both") {
      for (const edge of loadEdges(frontier, "in")) {
        if (!found.has(edge.id)) found.set(edge.id, { edge, from: edge.target_object_id, to: edge.source_object_id });
      }
    }
    const nextFrontier = [];
    for (const { edge, from, to } of found.values()) {
      edges.push({
        ...publicRelationship(edge),
        depth: level,
        traversal_from: from,
        traversal_to: to,
      });
      if (!visited.has(to)) {
        visited.add(to);
        const brief = briefObject(db, to, tenantId);
        if (brief) nodes.set(to, brief);
        nextFrontier.push(to);
      }
    }
    if (!nextFrontier.length) break;
    frontier = nextFrontier;
  }
  return { root: briefObject(db, row.id, tenantId), nodes: [...nodes.values()], edges, depth };
}

export function graph(db, reference, tenantId, { depth = 2 } = {}) {
  const result = traverse(db, reference, { direction: "both", depth }, tenantId);
  return {
    root_id: result.root?.id ?? null,
    nodes: result.nodes,
    edges: result.edges,
    node_count: result.nodes.length,
    edge_count: result.edges.length,
  };
}
