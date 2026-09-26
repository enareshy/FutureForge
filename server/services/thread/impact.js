// Impact analysis.
//
// Impact answers "if this object changes, what is affected?" using the same
// security-, revision-, effectivity- and configuration-aware traversal as the
// thread explorer, plus the platform dependency graph for object roots. The
// result is a downstream graph with per-domain totals and the shortest impact
// depth of each affected node.
import { impactOf } from "../objects.js";
import { executeTraversal, publicGraph } from "./engine.js";

function isObjectType(type) {
  const code = String(type || "").toLowerCase();
  return code && !code.startsWith("pdm_") && !code.startsWith("bom_");
}

export function impactAnalysis(db, tenantId, options = {}, actor = null) {
  const { result, definition } = executeTraversal(db, tenantId, { ...options, direction: "DOWNSTREAM" }, actor, { action: "IMPACT" });
  const graph = publicGraph(result, definition);
  const byDepth = new Map();
  for (const node of graph.nodes) {
    if ((node.depth ?? 0) === 0) continue;
    const depth = Number(node.depth || 0);
    if (!byDepth.has(depth)) byDepth.set(depth, []);
    byDepth.get(depth).push({ node_ref: node.node_ref, object_type: node.object_type, object_id: node.object_id, display_name: node.display_name, domain: node.domain, revision: node.revision, lifecycle_state: node.lifecycle_state });
  }
  let referenceImpact = null;
  const rootType = result.root?.object_type;
  if (isObjectType(rootType)) {
    try {
      const analysis = impactOf(db, result.root.object_id, Number(tenantId), { depth: Number(options.maxDepth) || 10 });
      referenceImpact = {
        impacted_count: analysis.impacted_count,
        depends_on_count: analysis.depends_on_count,
        impacted: analysis.impacted.slice(0, Number(options.maxDepth ? Number(options.maxDepth) * 20 : 200)),
      };
    } catch {
      referenceImpact = null;
    }
  }
  return {
    ...graph,
    impact_summary: {
      impacted_count: Math.max(0, graph.node_count - 1),
      domain_totals: graph.domains,
      levels: [...byDepth.entries()].sort((a, b) => a[0] - b[0]).map(([depth, nodes]) => ({ depth, count: nodes.length, nodes })),
    },
    reference_impact: referenceImpact,
    reference_impact_available: Boolean(referenceImpact),
  };
}

export function directImpact(db, tenantId, options = {}, actor = null) {
  const graph = impactAnalysis(db, tenantId, { ...options, maxDepth: 1 }, actor);
  return { ...graph, direct_impacted: graph.nodes.filter((node) => (node.depth ?? 0) === 1) };
}
