// Path analysis.
//
// Finds traceability paths between two objects through the provider graph,
// honouring direction, depth, effectivity/configuration context and security.
// Returns the shortest path plus, optionally, all simple paths up to the
// configured bounds.
import { allProviders, resolveRefs } from "./providers.js";
import { nodeRefValue, parseNodeRefValue } from "./refs.js";
import { normalizeNodeRef, normalizePathOptions } from "./validation.js";
import { nodeNotFound } from "./errors.js";
import { createNodeAuthorizer } from "./security.js";
import { resolveDefinition } from "./definitions.js";
import { getNumericConfig } from "./configuration.js";
import { ensureProviders } from "./traversal.js";

function neighborEdges(db, tenantId, refs, context) {
  const output = [];
  for (const provider of allProviders()) {
    if (typeof provider.accepts === "function" && !refs.some((ref) => provider.accepts(ref))) continue;
    for (const edge of provider.neighbors(db, tenantId, refs, context)) {
      if (edge?.source_node_ref && edge?.target_node_ref) output.push(edge);
    }
  }
  return output;
}

function incident(edge, ref) {
  if (edge.source_node_ref === ref) return { next: edge.target_node_ref, direction: "OUT" };
  if (edge.target_node_ref === ref) return { next: edge.source_node_ref, direction: "IN" };
  return null;
}

export function findPaths(db, tenantId, options = {}, actor = null) {
  ensureProviders();
  const tenant = Number(tenantId);
  const source = typeof options.source === "string" ? parseNodeRefValue(options.source) : normalizeNodeRef(options.source || options.from || {});
  const target = typeof options.target === "string" ? parseNodeRefValue(options.target) : normalizeNodeRef(options.target || options.to || {});
  const direction = String(options.direction || "DOWNSTREAM").toUpperCase();
  const definition = options.definition || resolveDefinition(db, tenant, { code: options.definitionCode });
  const pathOptions = normalizePathOptions(options);
  const maxDepth = Math.min(pathOptions.maxDepth, getNumericConfig(db, tenant, "max_path_depth"));
  const maxPaths = Math.min(pathOptions.maxPaths, getNumericConfig(db, tenant, "max_paths"));
  const timeoutMs = getNumericConfig(db, tenant, "query_timeout_ms");
  const started = Date.now();
  const deadline = started + timeoutMs;
  const authorizer = createNodeAuthorizer(db, actor, { tenantId: tenant, organizationId: options.organizationId, ip: options.ip, action: "read" });
  const context = {
    tenantId: tenant,
    organizationId: options.organizationId ?? null,
    direction,
    definition,
    includeInactive: options.includeInactive ?? false,
    edgeLimit: 20000,
    asOf: options.asOf || "",
    serialNumber: options.serialNumber || "",
    lot: options.lot || "",
    change: options.change || "",
    variant: options.variant || "",
    configuration: options.configuration || "",
    revision: options.revision || "",
  };

  const sourceKey = nodeRefValue(source);
  const targetKey = nodeRefValue(target);
  const endpoints = resolveRefs(db, tenant, [source, target], context);
  const sourceNode = endpoints.nodes.get(sourceKey);
  const targetNode = endpoints.nodes.get(targetKey);
  if (!sourceNode) throw nodeNotFound({ ref: sourceKey });
  if (!targetNode) throw nodeNotFound({ ref: targetKey });
  if (!authorizer.allowsNode(sourceNode) || !authorizer.allowsNode(targetNode)) throw nodeNotFound({ ref: sourceKey, reason: "security" });

  // Breadth-first shortest path with parent tracking.
  const parent = new Map([[sourceKey, null]]);
  const edgeTo = new Map();
  let frontier = [sourceKey];
  let found = sourceKey === targetKey;
  let depth = 0;
  while (frontier.length && !found && depth < maxDepth && Date.now() < deadline) {
    depth += 1;
    const edges = neighborEdges(db, tenant, frontier.map(parseNodeRefValue), context);
    const next = new Set();
    for (const edge of edges) {
      for (const current of frontier) {
        const move = incident(edge, current);
        if (!move) continue;
        if (move.direction === "OUT" && direction === "UPSTREAM") continue;
        if (move.direction === "IN" && direction === "DOWNSTREAM") continue;
        if (parent.has(move.next)) continue;
        const resolved = authored(move.next, authorizer);
        if (resolved === false) continue;
        parent.set(move.next, current);
        edgeTo.set(move.next, { edge, direction: move.direction });
        next.add(move.next);
      }
    }
    frontier = [...next];
    if (parent.has(targetKey)) found = true;
  }

  const reconstruct = (endKey) => {
    const nodes = [];
    const edges = [];
    let cursor = endKey;
    while (cursor) {
      nodes.push(cursor);
      const record = edgeTo.get(cursor);
      if (record) edges.push({ ...record.edge, traversal_direction: record.direction });
      cursor = parent.get(cursor);
    }
    return { nodes: nodes.reverse(), edges: edges.reverse() };
  };

  if (!found || !parent.has(targetKey)) {
    return { source: sourceNode, target: targetNode, found: false, path_count: 0, paths: [], shortest_path: null, duration_ms: Date.now() - started, max_depth: maxDepth, source_module: "thread" };
  }

  const shortest = reconstruct(targetKey);
  const paths = [{ nodes: shortest.nodes, edges: shortest.edges, length: shortest.nodes.length - 1 }];

  if (!pathOptions.shortestOnly && maxPaths > 1) {
    // Enumerate additional simple paths (depth-first, bounded).
    const enumerated = [];
    const seenSignatures = new Set([shortest.nodes.join(">")]);
    const walk = (current, nodePath, edgePath) => {
      if (enumerated.length + 1 >= maxPaths || Date.now() > deadline || nodePath.length > maxDepth + 1) return;
      if (current === targetKey) {
        const signature = nodePath.join(">");
        if (!seenSignatures.has(signature)) {
          seenSignatures.add(signature);
          enumerated.push({ nodes: [...nodePath], edges: [...edgePath], length: nodePath.length - 1 });
        }
        return;
      }
      const edges = neighborEdges(db, tenant, [parseNodeRefValue(current)], context);
      for (const edge of edges) {
        const move = incident(edge, current);
        if (!move || nodePath.includes(move.next)) continue;
        if (move.direction === "OUT" && direction === "UPSTREAM") continue;
        if (move.direction === "IN" && direction === "DOWNSTREAM") continue;
        if (authored(move.next, authorizer) === false) continue;
        nodePath.push(move.next);
        edgePath.push({ ...edge, traversal_direction: move.direction });
        walk(move.next, nodePath, edgePath);
        nodePath.pop();
        edgePath.pop();
      }
    };
    walk(sourceKey, [sourceKey], []);
    for (const path of enumerated) {
      paths.push(path);
      if (paths.length >= maxPaths) break;
    }
  }

  return {
    source: sourceNode,
    target: targetNode,
    found: true,
    path_count: paths.length,
    shortest_path: paths[0],
    paths,
    truncated: paths.length >= maxPaths || Date.now() > deadline,
    max_depth: maxDepth,
    duration_ms: Date.now() - started,
    source_module: "thread",
  };
}

function authored(ref, authorizer) {
  // The authorizer filters by object type; we only need the type here.
  const parsed = parseNodeRefValue(ref);
  return authorizer.allowsType(parsed.objectType, null) ? true : false;
}
