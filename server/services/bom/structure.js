// BOM structure service.
//
// Builds the multi-level line tree for a revision, computes depth/rollup-safe
// paths and enforces structural invariants (single parent, no cycles, depth
// limit). It reads lines directly so line and structure services stay acyclic.
import { queryAll, queryOne } from "../../db.js";
import { publicLine } from "./repository.js";
import { getConfig } from "./configuration.js";
import { circularStructure, depthExceeded, revisionNotFound } from "./errors.js";
import { MAX_STRUCTURE_DEPTH } from "./constants.js";

export function linesForRevision(db, revisionId, { includeInactive = true } = {}) {
  const statuses = includeInactive ? "" : "AND line_status = 'ACTIVE'";
  return queryAll(db, `SELECT * FROM bom_lines WHERE bom_revision_id = ? ${statuses} ORDER BY COALESCE(NULLIF(sequence,0), 2147483647), id`, [Number(revisionId)]);
}

export function buildAdjacency(lines) {
  const byParent = new Map();
  const childIds = new Set();
  for (const line of lines) {
    const parent = line.parent_object_id || "";
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(line);
    if (line.child_object_id) childIds.add(String(line.child_object_id));
  }
  return { byParent, childIds };
}

// Roots are lines whose parent is empty, whose parent is outside the revision's
// own child set (i.e. the BOM's owning object), or whose parent has no incoming
// relationship from another line.
export function rootsFor(lines, { ownerObjectId = null } = {}) {
  const { childIds } = buildAdjacency(lines);
  const roots = [];
  for (const line of lines) {
    const parent = line.parent_object_id ? String(line.parent_object_id) : "";
    if (!parent) {
      roots.push(line);
      continue;
    }
    if (ownerObjectId != null && parent === String(ownerObjectId)) {
      roots.push(line);
      continue;
    }
    if (!childIds.has(parent)) roots.push(line);
  }
  return roots;
}

export function buildTree(db, tenantId, revisionId, options = {}) {
  const config = {
    max_depth: options.maxDepth ?? getConfig(db, tenantId, "max_structure_depth"),
    include_inactive: options.includeInactive ?? true,
  };
  const lines = linesForRevision(db, revisionId, { includeInactive: config.include_inactive });
  const owner = queryOne(db, "SELECT h.owner_object_id, h.bom_number FROM bom_headers h JOIN bom_revisions r ON r.bom_id = h.id WHERE r.id = ?", [Number(revisionId)]);
  if (owner === undefined) {
    // The revision join returned nothing: confirm the revision exists for a precise error.
    const exists = queryOne(db, "SELECT id FROM bom_revisions WHERE id = ?", [Number(revisionId)]);
    if (!exists) throw revisionNotFound(revisionId);
  }
  const { byParent } = buildAdjacency(lines);
  const ownerObjectId = owner?.owner_object_id != null ? String(owner.owner_object_id) : null;
  const rootLines = rootsFor(lines, { ownerObjectId });
  let maxDepth = 0;

  const build = (line, level, path, seen) => {
    maxDepth = Math.max(maxDepth, level);
    if (level > Number(config.max_depth || MAX_STRUCTURE_DEPTH)) throw depthExceeded(config.max_depth);
    const childKey = line.child_object_id ? String(line.child_object_id) : null;
    if (childKey && seen.has(childKey)) throw circularStructure({ child_object_id: childKey, path });
    const nextSeen = childKey ? new Set([...seen, childKey]) : seen;
    const nodePath = path ? `${path}/${line.child_object_id ?? line.id}` : String(line.child_object_id ?? line.id);
    const children = (childKey ? byParent.get(childKey) || [] : []).map((child) => build(child, level + 1, nodePath, nextSeen));
    return {
      line: publicLine(line),
      level,
      path: nodePath,
      child_count: children.length,
      children,
    };
  };

  const nodes = rootLines.map((line) => build(line, 1, "", new Set()));
  return {
    revision_id: Number(revisionId),
    bom_number: owner?.bom_number ?? null,
    line_count: lines.length,
    root_count: nodes.length,
    max_depth: maxDepth,
    roots: nodes,
  };
}

// Flattens a tree into a list of {line, level, path} entries (pre-order).
export function flattenTree(tree) {
  const output = [];
  const visit = (nodes) => {
    for (const node of nodes) {
      output.push({ line: node.line, level: node.level, path: node.path });
      if (node.children?.length) visit(node.children);
    }
  };
  visit(tree.roots || []);
  return output;
}

export function flatStructure(db, tenantId, revisionId, options = {}) {
  return flattenTree(buildTree(db, tenantId, revisionId, options));
}

// Detects whether adding child under parent would create a cycle. A line may not
// contain itself at any depth.
export function assertNoCycle(db, { revisionId, parentObjectId, childObjectId }) {
  const parent = parentObjectId != null ? String(parentObjectId) : "";
  const child = childObjectId != null ? String(childObjectId) : "";
  if (!child) return;
  if (child === parent) throw circularStructure({ parent_object_id: parent, child_object_id: child });
  const lines = linesForRevision(db, revisionId, { includeInactive: true });
  const { byParent } = buildAdjacency(lines);
  const stack = [child];
  const visited = new Set();
  while (stack.length) {
    const current = stack.pop();
    if (visited.has(current)) continue;
    visited.add(current);
    if (current === parent) throw circularStructure({ parent_object_id: parent, child_object_id: child });
    for (const next of byParent.get(current) || []) {
      const key = next.child_object_id ? String(next.child_object_id) : null;
      if (key) stack.push(key);
    }
  }
}

// Ancestor chain for a child within a revision (nearest parent first).
export function ancestorsOf(db, revisionId, childObjectId, { ownerObjectId = null } = {}) {
  const lines = linesForRevision(db, revisionId, { includeInactive: true });
  const byChild = new Map();
  for (const line of lines) {
    const key = line.child_object_id ? String(line.child_object_id) : null;
    if (key) byChild.set(key, line);
  }
  const chain = [];
  let current = childObjectId != null ? String(childObjectId) : "";
  const seen = new Set();
  while (current && byChild.has(current) && !seen.has(current)) {
    seen.add(current);
    const line = byChild.get(current);
    chain.push(publicLine(line));
    current = line.parent_object_id ? String(line.parent_object_id) : "";
  }
  void ownerObjectId;
  return chain;
}
