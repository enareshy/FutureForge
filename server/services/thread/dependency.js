// Dependency analysis.
//
// Dependency answers "what does this object depend on?" using an upstream
// traversal. For object roots the platform dependency graph (references with
// dependency=1 plus composition/aggregation) is merged as a secondary view so
// engineering dependencies are not lost when no thread edge exists.
import { directDependencies } from "../objects.js";
import { executeTraversal, publicGraph } from "./engine.js";

function isObjectType(type) {
  const code = String(type || "").toLowerCase();
  return code && !code.startsWith("pdm_") && !code.startsWith("bom_");
}

export function dependencyAnalysis(db, tenantId, options = {}, actor = null) {
  const { result, definition } = executeTraversal(db, tenantId, { ...options, direction: "UPSTREAM" }, actor, { action: "DEPENDENCY" });
  const graph = publicGraph(result, definition);
  let referenceDependencies = null;
  if (isObjectType(result.root?.object_type)) {
    try {
      const direct = directDependencies(db, result.root.object_id, Number(tenantId));
      referenceDependencies = {
        depends_on: direct.depends_on,
        depended_on_by: direct.depended_on_by,
        depends_on_count: direct.depends_on.length,
        depended_on_by_count: direct.depended_on_by.length,
      };
    } catch {
      referenceDependencies = null;
    }
  }
  return {
    ...graph,
    dependency_summary: {
      dependency_count: Math.max(0, graph.node_count - 1),
      domain_totals: graph.domains,
    },
    reference_dependencies: referenceDependencies,
    reference_dependencies_available: Boolean(referenceDependencies),
  };
}

export function directDependencyAnalysis(db, tenantId, options = {}, actor = null) {
  const graph = dependencyAnalysis(db, tenantId, { ...options, maxDepth: 1 }, actor);
  return { ...graph, direct_dependencies: graph.nodes.filter((node) => (node.depth ?? 0) === 1) };
}
