// Reference data hierarchy. Edges are authoritative; each item also carries a
// materialized parent_id / hierarchy_path / hierarchy_level projection so reads
// do not need a recursive walk. Cycles are rejected at write time.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { hierarchyConflict, hierarchyCycle, hierarchyNotFound, invalidRelationship, itemNotFound } from "./errors.js";
import { RELATIONSHIP_TYPES, normalizeText } from "./validation.js";
import { edgeRef } from "./refs.js";
import { bumpCacheEpoch } from "./cache.js";
import { emitItemEvent } from "./events.js";

export function publicEdge(row) {
  if (!row) return null;
  return {
    id: row.id,
    edge_ref: row.edge_ref,
    domain_id: row.domain_id,
    parent_id: row.parent_id,
    child_id: row.child_id,
    relationship_type: row.relationship_type,
    sequence: row.sequence,
    status: row.status,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listEdges(db, { domainId, parentId, childId, status, limit = 500 } = {}) {
  const clauses = [];
  const params = [];
  if (domainId !== undefined && domainId !== null) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  if (parentId !== undefined && parentId !== null) {
    clauses.push("parent_id = ?");
    params.push(Number(parentId));
  }
  if (childId !== undefined && childId !== null) {
    clauses.push("child_id = ?");
    params.push(Number(childId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = queryAll(db, `SELECT * FROM reference_hierarchy ${where} ORDER BY sequence, id LIMIT ?`, [...params, Math.min(2000, Number(limit) || 500)]);
  return { items: rows.map(publicEdge), total: rows.length };
}

export function getEdgeRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM reference_hierarchy WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM reference_hierarchy WHERE edge_ref = ?", [String(ref)]) || null;
}

function ancestorsOf(db, itemId) {
  const chain = [];
  const seen = new Set();
  let current = Number(itemId);
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    const parentEdge = queryOne(db, "SELECT parent_id FROM reference_hierarchy WHERE child_id = ? AND status = 'active' LIMIT 1", [current]);
    current = parentEdge?.parent_id ?? null;
  }
  return chain;
}

export function createEdge(db, input = {}, actor = null, tenantId = null, ip = null) {
  const parentId = Number(input.parentId ?? input.parent_id);
  const childId = Number(input.childId ?? input.child_id);
  if (!parentId || !childId) throw invalidRelationship("parentId and childId are required");
  if (parentId === childId) throw hierarchyCycle({ parent_id: parentId, child_id: childId, reason: "self_reference" });
  const parent = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [parentId]);
  const child = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [childId]);
  if (!parent) throw itemNotFound(parentId);
  if (!child) throw itemNotFound(childId);
  if (Number(parent.domain_id) !== Number(child.domain_id)) {
    throw invalidRelationship("Hierarchy edges must connect items in the same domain", { parent_id: parentId, child_id: childId });
  }
  const relationshipType = RELATIONSHIP_TYPES.includes(input.relationship_type) ? input.relationship_type : "parent_child";
  if (ancestorsOf(db, parentId).includes(childId)) {
    throw hierarchyCycle({ parent_id: parentId, child_id: childId, ancestors: ancestorsOf(db, parentId) });
  }
  const existing = queryOne(
    db,
    "SELECT id FROM reference_hierarchy WHERE parent_id = ? AND child_id = ? AND relationship_type = ?",
    [parentId, childId, relationshipType]
  );
  if (existing) throw hierarchyConflict({ parent_id: parentId, child_id: childId, relationship_type: relationshipType });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reference_hierarchy
      (edge_ref, domain_id, parent_id, child_id, relationship_type, sequence, status, effective_from, effective_to, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      edgeRef(),
      Number(parent.domain_id),
      parentId,
      childId,
      relationshipType,
      Number(input.sequence) || 0,
      input.status === "inactive" ? "inactive" : "active",
      input.effective_from ?? null,
      input.effective_to ?? null,
      tenantId ?? child.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM reference_hierarchy WHERE id = ?", [Number(result.lastInsertRowid)]);
  rebuildItemPath(db, childId);
  rebuildDescendantPaths(db, childId);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.hierarchy.create",
    resourceType: "reference_hierarchy",
    resourceId: row.id,
    details: { parent_id: parentId, child_id: childId, relationship_type: relationshipType },
    ip,
  });
  emitItemEvent(db, "ReferenceHierarchyChanged", child, { action: "link", parent_id: parentId }, actor);
  return publicEdge(row);
}

export function deleteEdge(db, ref, actor = null, ip = null) {
  const row = getEdgeRow(db, ref);
  if (!row) throw hierarchyNotFound(ref);
  const child = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [row.child_id]);
  run(db, "DELETE FROM reference_hierarchy WHERE id = ?", [row.id]);
  rebuildItemPath(db, row.child_id);
  rebuildDescendantPaths(db, row.child_id);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.hierarchy.delete",
    resourceType: "reference_hierarchy",
    resourceId: row.id,
    details: { parent_id: row.parent_id, child_id: row.child_id },
    ip,
  });
  if (child) emitItemEvent(db, "ReferenceHierarchyChanged", child, { action: "unlink" }, actor);
  return { deleted: true, id: row.id };
}

export function rebuildItemPath(db, itemId) {
  const item = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [Number(itemId)]);
  if (!item) return null;
  const chain = ancestorsOfIncludeSelf(db, item.id);
  const path = `/${chain.map((id) => Number(id)).join("/")}`;
  run(db, "UPDATE reference_data_items SET parent_id = ?, hierarchy_path = ?, hierarchy_level = ?, updated_at = ? WHERE id = ?", [
    chain.length > 1 ? chain[chain.length - 2] : null,
    path,
    chain.length - 1,
    nowIso(),
    Number(item.id),
  ]);
  return { id: Number(item.id), path, level: chain.length - 1 };
}

// Walks from an item up to its root, returning leaf -> root. Used to build the
// path; the immediate parent is the second element.
function ancestorsOfIncludeSelf(db, itemId) {
  const chain = [];
  const seen = new Set();
  let current = Number(itemId);
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    const parentEdge = queryOne(db, "SELECT parent_id FROM reference_hierarchy WHERE child_id = ? AND status = 'active' LIMIT 1", [current]);
    current = parentEdge?.parent_id ?? null;
  }
  return chain;
}

function rebuildDescendantPaths(db, itemId) {
  const children = queryAll(db, "SELECT child_id FROM reference_hierarchy WHERE parent_id = ? AND status = 'active'", [Number(itemId)]);
  for (const child of children) {
    rebuildItemPath(db, child.child_id);
    rebuildDescendantPaths(db, child.child_id);
  }
}

export function descendants(db, itemId, { maxDepth = 20 } = {}) {
  const result = [];
  const walk = (parentId, depth) => {
    if (depth > maxDepth) return;
    const edges = queryAll(db, "SELECT * FROM reference_hierarchy WHERE parent_id = ? AND status = 'active' ORDER BY sequence, id", [Number(parentId)]);
    for (const edge of edges) {
      result.push({ ...publicEdge(edge), depth });
      walk(edge.child_id, depth + 1);
    }
  };
  walk(itemId, 1);
  return result;
}

export function tree(db, domainId, { rootId = null } = {}) {
  const build = (item) => {
    const edges = queryAll(
      db,
      "SELECT child_id FROM reference_hierarchy WHERE parent_id = ? AND status = 'active' ORDER BY sequence, id",
      [Number(item.id)]
    );
    const nodes = [];
    const seen = new Set();
    for (const edge of edges) {
      if (seen.has(Number(edge.child_id))) continue;
      seen.add(Number(edge.child_id));
      const child = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [Number(edge.child_id)]);
      if (child) nodes.push(build(child));
    }
    return { id: item.id, item_ref: item.item_ref, code: item.code, name: item.name, status: item.status, children: nodes };
  };
  let roots;
  if (rootId !== null) {
    const root = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ? AND domain_id = ?", [Number(rootId), Number(domainId)]);
    roots = root ? [root] : [];
  } else {
    roots = queryAll(
      db,
      `SELECT * FROM reference_data_items
       WHERE domain_id = ? AND status <> 'retired'
         AND (parent_id IS NULL OR parent_id NOT IN (SELECT child_id FROM reference_hierarchy WHERE status = 'active'))
       ORDER BY sequence, code`,
      [Number(domainId)]
    );
  }
  return roots.map(build);
}

export { queryAll, normalizeText };
