// Traceability completeness.
//
// Evaluates the tenant's active traceability rules against a real traversal:
// for every source-domain node reachable from the root, at least one path (or a
// relationship of the required type) must reach a target-domain node. Results
// are deterministic, security-trimmed and explain exactly which rule and node
// failed.
import { executeTraversal } from "./engine.js";
import { activeRules } from "./rules.js";
import { COMPLETENESS_STATE } from "./constants.js";

function adjacency(edges, direction) {
  const map = new Map();
  for (const edge of edges) {
    const from = direction === "UPSTREAM" ? edge.target_node_ref : edge.source_node_ref;
    const to = direction === "UPSTREAM" ? edge.source_node_ref : edge.target_node_ref;
    if (!map.has(from)) map.set(from, []);
    map.get(from).push({ to, edge });
  }
  return map;
}

function reachable(graph, start, accept, { maxDepth = 25 } = {}) {
  const queue = [{ ref: start, depth: 0 }];
  const seen = new Set([start]);
  const hits = [];
  while (queue.length) {
    const { ref, depth } = queue.shift();
    if (depth >= maxDepth) continue;
    for (const { to, edge } of graph.get(ref) || []) {
      if (seen.has(to)) continue;
      seen.add(to);
      if (accept(to, edge)) hits.push({ ref: to, depth: depth + 1, edge });
      queue.push({ ref: to, depth: depth + 1 });
    }
  }
  return hits;
}

export function evaluateCompleteness(db, tenantId, options = {}, actor = null) {
  const definitionCode = options.definitionCode || options.definition_code || "";
  const direction = String(options.direction || "DOWNSTREAM").toUpperCase();
  const { result, definition } = executeTraversal(db, tenantId, { ...options, direction }, actor, { action: "COMPLETENESS" });
  const nodesByDomain = new Map();
  const nodeByRef = new Map();
  for (const node of result.nodes) {
    nodeByRef.set(node.node_ref, node);
    const domain = String(node.domain || "").toUpperCase();
    if (!nodesByDomain.has(domain)) nodesByDomain.set(domain, []);
    nodesByDomain.get(domain).push(node);
  }
  const graph = adjacency(result.edges, direction);
  const rules = activeRules(db, Number(tenantId), definitionCode);
  const ruleResults = [];
  let satisfiedCount = 0;
  let violationCount = 0;

  for (const rule of rules) {
    const sourceDomain = String(rule.source_domain || "").toUpperCase();
    const targetDomain = String(rule.target_domain || "").toUpperCase();
    const sources = nodesByDomain.get(sourceDomain) || [];
    const targets = nodesByDomain.get(targetDomain) || [];
    const targetRefs = new Set(targets.map((node) => node.node_ref));
    const accept = rule.relationship_type
      ? (ref, edge) => targetRefs.has(ref) && String(edge.relationship_type) === String(rule.relationship_type)
      : (ref) => targetRefs.has(ref);
    const missing = [];
    const satisfied = [];
    for (const source of sources) {
      const hits = reachable(graph, source.node_ref, accept, { maxDepth: Number(options.maxDepth) || 25 });
      if (hits.length) {
        satisfied.push({ node_ref: source.node_ref, object_type: source.object_type, object_id: source.object_id, display_name: source.display_name, via: hits[0] });
      } else {
        missing.push({
          node_ref: source.node_ref,
          object_type: source.object_type,
          object_id: source.object_id,
          display_name: source.display_name,
          domain: source.domain,
          state: targets.length ? COMPLETENESS_STATE.MISSING_DOWNSTREAM : COMPLETENESS_STATE.MISSING_UPSTREAM,
        });
      }
    }
    const state = !rule.required
      ? (missing.length ? COMPLETENESS_STATE.INCOMPLETE : COMPLETENESS_STATE.COMPLETE)
      : missing.length
        ? COMPLETENESS_STATE.INCOMPLETE
        : COMPLETENESS_STATE.COMPLETE;
    if (missing.length) violationCount += 1;
    else satisfiedCount += 1;
    ruleResults.push({
      rule: { id: rule.id, code: rule.code, name: rule.name, severity: rule.severity, required: rule.required },
      source_domain: sourceDomain,
      target_domain: targetDomain,
      relationship_type: rule.relationship_type || "",
      state,
      source_count: sources.length,
      satisfied_count: satisfied.length,
      missing_count: missing.length,
      missing,
    });
  }

  const total = ruleResults.length;
  const score = total ? Math.round((satisfiedCount / total) * 100) : 100;
  return {
    root: result.root,
    definition: { code: definition.code, name: definition.name },
    direction,
    evaluated_rules: total,
    satisfied_rules: satisfiedCount,
    violated_rules: violationCount,
    completeness_score: score,
    states: ruleResults.map((entry) => ({ code: entry.rule.code, state: entry.state, missing_count: entry.missing_count, severity: entry.rule.severity })),
    rules: ruleResults,
    node_count: result.node_count,
    edge_count: result.edge_count,
    truncated: result.truncated,
    duration_ms: result.duration_ms,
    source_module: "thread",
  };
}
