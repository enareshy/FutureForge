// Traceability views.
//
// A traceability view is a traversal plus an aggregated domain-to-domain matrix
// and link inventory. It is the read model behind the traceability workspace
// and reporting; it never persists anything.
import { executeTraversal, publicGraph } from "./engine.js";

function domainOf(nodeByRef, ref) {
  const node = nodeByRef.get(ref);
  return String(node?.domain || "UNMAPPED");
}

export function traceabilityGraph(db, tenantId, options = {}, actor = null) {
  const { result, definition } = executeTraversal(db, tenantId, { ...options, direction: options.direction || "DOWNSTREAM" }, actor, { action: "TRACEABILITY" });
  return publicGraph(result, definition);
}

export function buildMatrix(result) {
  const nodeByRef = new Map(result.nodes.map((node) => [node.node_ref, node]));
  const cells = new Map();
  const relationships = new Map();
  for (const edge of result.edges) {
    const from = domainOf(nodeByRef, edge.source_node_ref);
    const to = domainOf(nodeByRef, edge.target_node_ref);
    const key = `${from}->${to}`;
    if (!cells.has(key)) cells.set(key, { from_domain: from, to_domain: to, count: 0, relationship_types: new Set() });
    const cell = cells.get(key);
    cell.count += 1;
    if (edge.relationship_type) cell.relationship_types.add(edge.relationship_type);
    const rkey = edge.relationship_type || "unknown";
    relationships.set(rkey, (relationships.get(rkey) || 0) + 1);
  }
  return {
    cells: [...cells.values()].map((cell) => ({ ...cell, relationship_types: [...cell.relationship_types] })),
    relationship_inventory: [...relationships.entries()].map(([relationship_type, count]) => ({ relationship_type, count })).sort((a, b) => b.count - a.count),
  };
}

export function traceabilityMatrix(db, tenantId, options = {}, actor = null) {
  const { result, definition } = executeTraversal(db, tenantId, { ...options, direction: options.direction || "DOWNSTREAM" }, actor, { action: "TRACEABILITY" });
  const matrix = buildMatrix(result);
  return {
    root: result.root,
    definition: { code: definition.code, name: definition.name },
    direction: result.direction,
    node_count: result.node_count,
    edge_count: result.edge_count,
    domains: result.domains,
    matrix: matrix.cells,
    relationship_inventory: matrix.relationship_inventory,
    truncated: result.truncated,
    duration_ms: result.duration_ms,
    source_module: "thread",
  };
}
