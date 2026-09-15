import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import * as tenants from "../tenants.js";
import { findObjectRow, briefObject } from "./repository.js";
import { REFERENCE_TYPES } from "./validation.js";

// Reference, dependency and impact service. Strong references block deletion,
// weak references become orphans when their target is removed, external
// references point outside Helix. Dependency edges power impact analysis and
// cycle detection across the whole object graph.

export const REFERENCE_STATUSES = ["active", "inactive"];

const REF_SELECT = `
  SELECT ref.*,
    s.code AS source_code, s.name AS source_name, s.status AS source_status, s.deleted_at AS source_deleted_at,
    st.code AS source_type_code, st.name AS source_type_name,
    tgt.code AS target_code, tgt.name AS target_name, tgt.status AS target_status, tgt.deleted_at AS target_deleted_at,
    tt.code AS target_type_code, tt.name AS target_type_name
  FROM object_references ref
  JOIN objects s ON s.id = ref.source_object_id
  LEFT JOIN metadata_types st ON st.id = s.object_type_id
  LEFT JOIN objects tgt ON tgt.id = ref.target_object_id
  LEFT JOIN metadata_types tt ON tt.id = tgt.object_type_id
`;

function publicReference(row) {
  if (!row) return null;
  return {
    id: row.id,
    source_object_id: row.source_object_id,
    source: {
      id: row.source_object_id,
      code: row.source_code,
      name: row.source_name,
      status: row.source_status,
      type: { code: row.source_type_code, name: row.source_type_name },
    },
    target_object_id: row.target_object_id ?? null,
    target: row.target_object_id
      ? {
          id: row.target_object_id,
          code: row.target_code,
          name: row.target_name,
          status: row.target_status,
          type: { code: row.target_type_code, name: row.target_type_name },
          deleted: Boolean(row.target_deleted_at),
        }
      : null,
    reference_type: row.reference_type,
    dependency: row.dependency === 1,
    context: row.context || "",
    external_ref: row.external_ref || "",
    external_system: row.external_system || "",
    status: row.status,
    tenant_id: row.tenant_id,
    deleted: Boolean(row.deleted_at),
    deleted_at: row.deleted_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getReference(db, id, tenantId) {
  const row = queryOne(db, `${REF_SELECT} WHERE ref.id = ?`, [Number(id)]);
  if (!row || Number(row.tenant_id) !== Number(tenantId)) throw new HttpError(404, "Reference not found");
  return publicReference(row);
}

export function listReferences(db, query = {}, tenantId) {
  if (!tenantId) throw new HttpError(400, "Tenant context is required");
  const { page, pageSize, offset } = pagination(query);
  const where = ["ref.tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.source || query.source_object_id) {
    where.push("ref.source_object_id = ?");
    params.push(Number(query.source || query.source_object_id));
  }
  if (query.target || query.target_object_id) {
    where.push("ref.target_object_id = ?");
    params.push(Number(query.target || query.target_object_id));
  }
  if (query.reference_type || query.referenceType) {
    where.push("ref.reference_type = ?");
    params.push(String(query.reference_type || query.referenceType));
  }
  if (query.dependency !== undefined && query.dependency !== "") {
    where.push("ref.dependency = ?");
    params.push(query.dependency === "true" || query.dependency === true || query.dependency === 1 ? 1 : 0);
  }
  if (query.context) {
    where.push("ref.context = ?");
    params.push(String(query.context));
  }
  const includeDeleted = query.includeDeleted === true || query.include_deleted === true;
  if (!includeDeleted) where.push("ref.deleted_at IS NULL");
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM object_references ref ${clause}`, params).c;
  const items = queryAll(
    db,
    `${REF_SELECT} ${clause} ORDER BY ref.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicReference);
  return { items, total, page, pageSize };
}

export function createReference(db, body, actor, tenantId, ip) {
  if (!tenantId) throw new HttpError(400, "Tenant context is required for references");
  tenants.assertTenantScope(db, actor, tenantId);
  const sourceRef = body.source ?? body.source_object_id ?? body.sourceObjectId;
  if (sourceRef === undefined || sourceRef === null || sourceRef === "") {
    throw new HttpError(400, "source_object_id is required");
  }
  const referenceType = body.reference_type ?? body.referenceType ?? "weak";
  if (!REFERENCE_TYPES.includes(referenceType)) {
    throw new HttpError(400, `reference_type must be one of: ${REFERENCE_TYPES.join(", ")}`);
  }
  const sourceRow = findObjectRow(db, sourceRef, tenantId);
  if (sourceRow.deleted_at) throw new HttpError(409, "Source object is deleted");

  let targetRow = null;
  let externalRef = body.external_ref ?? body.externalRef ?? "";
  let externalSystem = body.external_system ?? body.externalSystem ?? "";
  if (referenceType === "external") {
    if (!externalRef) throw new HttpError(400, "external_ref is required for external references");
  } else {
    const targetRef = body.target ?? body.target_object_id ?? body.targetObjectId;
    if (targetRef === undefined || targetRef === null || targetRef === "") {
      throw new HttpError(400, "target_object_id is required for strong and weak references");
    }
    targetRow = findObjectRow(db, targetRef, tenantId);
    if (targetRow.id === sourceRow.id) throw new HttpError(400, "An object cannot reference itself");
    if (targetRow.deleted_at) throw new HttpError(409, "Target object is deleted");
    externalRef = "";
    externalSystem = "";
  }
  const context = body.context || "";
  const duplicate = queryOne(
    db,
    `SELECT id FROM object_references
     WHERE source_object_id = ? AND COALESCE(target_object_id, 0) = ? AND reference_type = ?
       AND context = ? AND deleted_at IS NULL`,
    [sourceRow.id, targetRow?.id ?? 0, referenceType, context]
  );
  if (duplicate) throw new HttpError(409, "This reference already exists");

  const result = run(
    db,
    `INSERT INTO object_references
      (source_object_id, target_object_id, reference_type, dependency, context, external_ref,
       external_system, status, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    [
      sourceRow.id,
      targetRow?.id ?? null,
      referenceType,
      body.dependency ? 1 : 0,
      context,
      externalRef,
      externalSystem,
      Number(sourceRow.tenant_id),
      actor?.id ?? null,
      nowIso(),
      nowIso(),
    ]
  );
  writeAudit(db, {
    actor,
    action: "reference.create",
    resourceType: "object_reference",
    resourceId: result.lastInsertRowid,
    details: {
      source: sourceRow.code,
      target: targetRow?.code ?? externalRef,
      reference_type: referenceType,
      dependency: Boolean(body.dependency),
    },
    ip,
  });
  return getReference(db, result.lastInsertRowid, tenantId);
}

export function updateReference(db, id, body, actor, tenantId, ip) {
  const row = queryOne(db, `SELECT * FROM object_references WHERE id = ?`, [Number(id)]);
  if (!row || Number(row.tenant_id) !== Number(tenantId)) throw new HttpError(404, "Reference not found");
  if (row.deleted_at) throw new HttpError(409, "Cannot update a deleted reference");
  tenants.assertTenantScope(db, actor, tenantId);
  run(
    db,
    "UPDATE object_references SET dependency = ?, context = ?, status = ?, updated_at = ? WHERE id = ?",
    [
      body.dependency === undefined ? row.dependency : body.dependency ? 1 : 0,
      body.context ?? row.context,
      body.status && REFERENCE_STATUSES.includes(body.status) ? body.status : row.status,
      nowIso(),
      row.id,
    ]
  );
  writeAudit(db, {
    actor,
    action: "reference.update",
    resourceType: "object_reference",
    resourceId: row.id,
    ip,
  });
  return getReference(db, row.id, tenantId);
}

export function deleteReference(db, id, actor, tenantId, ip) {
  const row = queryOne(db, `SELECT * FROM object_references WHERE id = ?`, [Number(id)]);
  if (!row || Number(row.tenant_id) !== Number(tenantId)) throw new HttpError(404, "Reference not found");
  if (row.deleted_at) throw new HttpError(409, "Reference is already deleted");
  tenants.assertTenantScope(db, actor, tenantId);
  run(db, "UPDATE object_references SET deleted_at = ?, status = 'inactive', updated_at = ? WHERE id = ?", [
    nowIso(),
    nowIso(),
    row.id,
  ]);
  writeAudit(db, {
    actor,
    action: "reference.delete",
    resourceType: "object_reference",
    resourceId: row.id,
    ip,
  });
  return { deleted: true, id: row.id };
}

// Weak references whose target was soft-deleted or is missing. External
// references are excluded because they intentionally have no local target.
export function orphanReferences(db, tenantId, query = {}) {
  if (!tenantId) throw new HttpError(400, "Tenant context is required");
  const { page, pageSize, offset } = pagination({ ...query, pageSize: query.pageSize || 100 });
  const clause = `WHERE ref.tenant_id = ? AND ref.deleted_at IS NULL AND ref.reference_type = 'weak'
    AND (ref.target_object_id IS NULL OR tgt.id IS NULL OR tgt.deleted_at IS NOT NULL)`;
  const params = [Number(tenantId)];
  const total = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM object_references ref LEFT JOIN objects tgt ON tgt.id = ref.target_object_id ${clause}`,
    params
  ).c;
  const items = queryAll(
    db,
    `${REF_SELECT} ${clause} ORDER BY ref.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map((row) => ({ ...publicReference(row), orphan: true, reason: row.target_object_id === null ? "missing_target" : "deleted_target" }));
  return { items, total, page, pageSize };
}

// Dependency edges are normalized to `dependent -> dependency`: a reference with
// dependency=1 means source depends on target; a composition/aggregation means
// the child (target) depends on the owner (source).
function dependencyEdges(db, tenantId) {
  const references = queryAll(
    db,
    `SELECT source_object_id AS dependent, target_object_id AS dependency, 'reference' AS kind, id AS edge_id
     FROM object_references
     WHERE tenant_id = ? AND dependency = 1 AND target_object_id IS NOT NULL
       AND status = 'active' AND deleted_at IS NULL`,
    [Number(tenantId)]
  );
  const compositions = queryAll(
    db,
    `SELECT r.target_object_id AS dependent, r.source_object_id AS dependency,
            rt.semantic AS kind, r.id AS edge_id
     FROM object_relationships r
     JOIN relationship_types rt ON rt.id = r.relationship_type_id
     WHERE r.tenant_id = ? AND rt.semantic IN ('composition', 'aggregation')
       AND r.status = 'active' AND r.deleted_at IS NULL`,
    [Number(tenantId)]
  );
  return [...references, ...compositions];
}

function adjacency(edges, key) {
  const map = new Map();
  for (const edge of edges) {
    const from = edge[key];
    if (!map.has(from)) map.set(from, []);
    map.get(from).push(edge);
  }
  return map;
}

export function directDependencies(db, objectId, tenantId) {
  const row = findObjectRow(db, objectId, tenantId);
  const edges = dependencyEdges(db, tenantId);
  const outgoing = edges.filter((e) => e.dependent === row.id);
  const incoming = edges.filter((e) => e.dependency === row.id);
  return {
    object: briefObject(db, row.id, tenantId),
    depends_on: outgoing.map((edge) => ({
      kind: edge.kind,
      edge_id: edge.edge_id,
      object: briefObject(db, edge.dependency, tenantId),
    })),
    depended_on_by: incoming.map((edge) => ({
      kind: edge.kind,
      edge_id: edge.edge_id,
      object: briefObject(db, edge.dependent, tenantId),
    })),
  };
}

// Impact analysis: `impacted` are the transitive dependents (things that break
// or change if this object changes), `depends_on` are its transitive upstreams.
export function impactOf(db, objectId, tenantId, { depth = 10 } = {}) {
  const row = findObjectRow(db, objectId, tenantId);
  const cap = Math.min(20, Math.max(1, Number(depth) || 10));
  const edges = dependencyEdges(db, tenantId);
  const forward = adjacency(edges, "dependent"); // follow dependencies
  const reverse = adjacency(edges, "dependency"); // find dependents

  const walk = (map, start, nextOf) => {
    const seen = new Set([start]);
    const result = [];
    const queue = [{ id: start, depth: 0, path: [start] }];
    while (queue.length) {
      const { id, depth, path } = queue.shift();
      if (depth >= cap) continue;
      for (const edge of map.get(id) || []) {
        const next = nextOf(edge);
        if (seen.has(next)) continue;
        seen.add(next);
        const brief = briefObject(db, next, tenantId);
        if (!brief) continue;
        result.push({ ...brief, depth: depth + 1, via_kind: edge.kind, via_edge_id: edge.edge_id, path: [...path, next] });
        queue.push({ id: next, depth: depth + 1, path: [...path, next] });
      }
    }
    return result;
  };

  const dependsOn = walk(forward, row.id, (edge) => edge.dependency);
  const impacted = walk(reverse, row.id, (edge) => edge.dependent);
  return {
    object: briefObject(db, row.id, tenantId),
    depends_on: dependsOn,
    impacted,
    depends_on_count: dependsOn.length,
    impacted_count: impacted.length,
  };
}

export function detectCycles(db, tenantId, { limit = 50 } = {}) {
  if (!tenantId) throw new HttpError(400, "Tenant context is required");
  const edges = dependencyEdges(db, tenantId);
  const graph = adjacency(edges, "dependent");
  const color = new Map();
  const stack = [];
  const cycles = [];
  const seenKeys = new Set();

  const visit = (nodeId) => {
    color.set(nodeId, "gray");
    stack.push(nodeId);
    for (const edge of graph.get(nodeId) || []) {
      const next = edge.dependency;
      const state = color.get(next);
      if (state === "gray") {
        const start = stack.indexOf(next);
        const cycle = stack.slice(start).concat(next);
        const key = [...new Set(cycle)].sort((a, b) => a - b).join("-");
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          cycles.push({
            object_ids: cycle.slice(0, -1),
            objects: cycle.slice(0, -1).map((id) => briefObject(db, id, tenantId)).filter(Boolean),
          });
        }
      } else if (state !== "black") {
        visit(next);
      }
      if (cycles.length >= limit) return;
    }
    stack.pop();
    color.set(nodeId, "black");
  };

  for (const nodeId of graph.keys()) {
    if (!color.has(nodeId)) visit(nodeId);
    if (cycles.length >= limit) break;
  }
  return { cycles, count: cycles.length };
}

// Reports everything that blocks a hard delete plus what would cascade/orphan.
export function safeDeleteReport(db, objectId, tenantId) {
  const row = findObjectRow(db, objectId, tenantId);
  const strongReferences = queryAll(
    db,
    `${REF_SELECT} WHERE ref.target_object_id = ? AND ref.reference_type = 'strong'
      AND ref.deleted_at IS NULL AND ref.status = 'active'`,
    [row.id]
  ).map(publicReference);
  const weakReferences = queryAll(
    db,
    `${REF_SELECT} WHERE ref.target_object_id = ? AND ref.reference_type = 'weak'
      AND ref.deleted_at IS NULL AND ref.status = 'active'`,
    [row.id]
  ).map(publicReference);
  const relationships = queryAll(
    db,
    `SELECT r.id, r.source_object_id, r.target_object_id, rt.semantic, rt.code AS type_code,
            rt.cascade_delete, rt.required, rt.min_occurrences
     FROM object_relationships r
     JOIN relationship_types rt ON rt.id = r.relationship_type_id
     WHERE (r.source_object_id = ? OR r.target_object_id = ?)
       AND r.deleted_at IS NULL AND r.status = 'active'`,
    [row.id, row.id]
  );
  const cascade = relationships
    .filter((rel) => Number(rel.source_object_id) === row.id && rel.semantic === "composition")
    .map((rel) => ({ ...(briefObject(db, rel.target_object_id, tenantId) || {}), relationship_id: rel.id, type: rel.type_code }));
  const blockers = [];
  for (const reference of strongReferences) {
    blockers.push({ kind: "strong_reference", reference_id: reference.id, source: reference.source });
  }
  for (const rel of relationships) {
    if (Number(rel.source_object_id) === row.id && rel.semantic === "composition") continue;
    blockers.push({
      kind: "relationship",
      relationship_id: rel.id,
      type: rel.type_code,
      semantic: rel.semantic,
      counterpart_id: Number(rel.source_object_id) === row.id ? rel.target_object_id : rel.source_object_id,
    });
  }
  const orphans = weakReferences.map((reference) => ({
    reference_id: reference.id,
    source: reference.source,
    context: reference.context,
  }));
  return {
    object: briefObject(db, row.id, tenantId),
    safe: blockers.length === 0,
    blockers,
    cascade,
    orphaned_on_delete: orphans,
    counts: {
      strong_references: strongReferences.length,
      weak_references: weakReferences.length,
      relationships: relationships.length,
      cascade_children: cascade.length,
    },
  };
}
