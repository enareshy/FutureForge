// Digital thread traversal engine.
//
// Breadth-first walk over the provider graph. The engine owns direction,
// depth/node limits, domain and lifecycle filters, revision/effectivity/
// configuration context, cycle safety, timeouts and security trimming; the
// providers own what a node is and what edges it has. This keeps the
// Requirement -> Service sequence data-driven rather than hard-coded.
import { isEffectivityActive } from "../bom/effectivity.js";
import { clampDepth, normalizeDirection, normalizeNodeRef } from "./validation.js";
import { listProviders, registerProvider, resolveRefs, allProviders } from "./providers.js";
import { nodeRefKey, nodeRefValue, parseNodeRefValue } from "./refs.js";
import { registerBuiltinProviders } from "./provider-builtins.js";
import { createNodeAuthorizer } from "./security.js";
import { nodeNotFound } from "./errors.js";
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_NODES, DEFAULT_QUERY_TIMEOUT_MS, MAX_EDGES, MAX_NODES } from "./constants.js";

let bootstrapped = false;

export function ensureProviders() {
  if (!bootstrapped) {
    registerBuiltinProviders();
    bootstrapped = true;
  }
  return listProviders();
}

function edgeKey(edge) {
  const id = edge.relationship_id || "";
  return `${id}|${edge.source_node_ref}|${edge.target_node_ref}|${edge.relationship_type}`;
}

function passesEffectivity(edge, context) {
  if (!edge.effectivity || Object.keys(edge.effectivity).length === 0) return true;
  return isEffectivityActive(edge.effectivity, {
    at: context.asOf || null,
    serial: context.serialNumber || null,
    lot: context.lot || null,
    change: context.change || null,
  });
}

function passesConfiguration(edge, context) {
  const configuration = edge.configuration || {};
  if (context.variant && configuration.variant && String(configuration.variant).toUpperCase() !== String(context.variant).toUpperCase()) return false;
  if (context.configuration && configuration.context && String(configuration.context).toUpperCase() !== String(context.configuration).toUpperCase()) return false;
  return true;
}

function passesRevision(edge, context) {
  if (!context.revision) return true;
  const wanted = String(context.revision);
  if (edge.target_revision && String(edge.target_revision) !== wanted) return false;
  if (edge.source_revision && String(edge.source_revision) !== wanted) return false;
  return true;
}

function passesRelationshipTypes(edge, allowed) {
  if (!allowed || !allowed.size) return true;
  return allowed.has(String(edge.relationship_type || ""));
}

function passesCrossDomain(edge, allowed) {
  if (allowed !== false) return true;
  const source = edge.metadata?.definition_domain;
  const target = edge.metadata?.target_domain;
  if (!source || !target) return true;
  return source === target;
}

function domainFilter(nodes, includeDomains, excludeDomains) {
  const include = new Set((includeDomains || []).map((code) => String(code).toUpperCase()));
  const exclude = new Set((excludeDomains || []).map((code) => String(code).toUpperCase()));
  if (!include.size && !exclude.size) return nodes;
  return nodes.filter((node) => {
    const domain = String(node.domain || "").toUpperCase();
    if (include.size && !include.has(domain)) return false;
    if (exclude.size && exclude.has(domain)) return false;
    return true;
  });
}

function clampNodes(value, fallbackMax = DEFAULT_MAX_NODES, hardMax = MAX_NODES) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return Math.min(fallbackMax, hardMax);
  return Math.min(hardMax, Math.max(1, Math.floor(number)));
}

// Core traversal. `options.root` accepts {objectType, objectId, revision} or a
// "type:id" string. `options.authorizer` may be supplied to reuse a per-query
// security decision cache.
export function traverseThread(db, tenantId, options = {}, actor = null) {
  ensureProviders();
  const rootRef = typeof options.root === "string" ? parseNodeRefValue(options.root) : normalizeNodeRef(options.root || {});
  const direction = normalizeDirection(options.direction, "DOWNSTREAM");
  const configMaxDepth = Number(options.configMaxDepth) || MAX_NODES;
  const configMaxNodes = Number(options.configMaxNodes) || DEFAULT_MAX_NODES;
  const maxDepth = clampDepth(options.maxDepth ?? options.max_depth, Math.min(configMaxDepth, DEFAULT_MAX_DEPTH), configMaxDepth);
  const maxNodes = clampNodes(options.maxNodes ?? options.max_nodes, configMaxNodes, MAX_NODES);
  const timeoutMs = Number(options.timeoutMs ?? options.timeout_ms ?? options.configTimeout ?? DEFAULT_QUERY_TIMEOUT_MS);
  const started = Date.now();
  const deadline = started + Math.max(1000, timeoutMs);
  const authorizer = options.authorizer || createNodeAuthorizer(db, actor, { tenantId, organizationId: options.organizationId, ip: options.ip, action: "read" });

  const baseContext = {
    tenantId: Number(tenantId),
    organizationId: options.organizationId ?? null,
    direction,
    definition: options.definition || null,
    includeInactive: options.includeInactive ?? false,
    edgeLimit: options.edgeLimit || MAX_EDGES,
    asOf: options.asOf || "",
    serialNumber: options.serialNumber || "",
    lot: options.lot || "",
    change: options.change || "",
    variant: options.variant || "",
    configuration: options.configuration || "",
    revision: options.revision || "",
  };

  const allowedRelationshipTypes = options.relationshipTypes ? new Set((Array.isArray(options.relationshipTypes) ? options.relationshipTypes : [options.relationshipTypes]).map((type) => String(type))) : null;
  const crossDomainAllowed = options.allowCrossDomain === undefined ? true : Boolean(options.allowCrossDomain);

  const rootResolution = resolveRefs(db, Number(tenantId), [rootRef], baseContext);
  const rootNode = rootResolution.nodes.get(nodeRefValue(rootRef));
  if (!rootNode) throw nodeNotFound({ ref: nodeRefValue(rootRef) });
  if (!authorizer.allowsNode(rootNode)) throw nodeNotFound({ ref: nodeRefValue(rootRef), reason: "security" });

  const nodes = new Map([[rootNode.node_ref, { ...rootNode, depth: 0 }]]);
  const edges = new Map();
  const visited = new Set([rootNode.node_ref]);
  const truncatedReasons = new Set();
  let frontier = [rootNode.node_ref];
  let depthReached = 0;
  let unresolvedCount = 0;

  for (let depth = 1; depth <= maxDepth && frontier.length; depth += 1) {
    if (Date.now() > deadline) {
      truncatedReasons.add("timeout");
      break;
    }
    depthReached = depth;
    const frontierRefs = frontier.map((ref) => parseNodeRefValue(ref));
    const candidates = [];
    for (const provider of allProviders()) {
      if (typeof provider.accepts === "function" && !frontierRefs.some((ref) => provider.accepts(ref))) continue;
      const produced = provider.neighbors(db, Number(tenantId), frontierRefs, { ...baseContext, direction });
      for (const edge of produced) {
        if (!edge?.source_node_ref || !edge?.target_node_ref) continue;
        if (!passesRelationshipTypes(edge, allowedRelationshipTypes)) continue;
        if (!passesCrossDomain(edge, crossDomainAllowed)) continue;
        if (!passesEffectivity(edge, baseContext) || !passesConfiguration(edge, baseContext) || !passesRevision(edge, baseContext)) continue;
        const key = edgeKey(edge);
        if (edges.has(key)) continue;
        edges.set(key, edge);
        candidates.push(edge);
      }
    }

    const nextRefs = new Map();
    for (const edge of candidates) {
      const from = edge.source_node_ref;
      const to = edge.target_node_ref;
      const fromIn = frontier.includes(from);
      const toIn = frontier.includes(to);
      if (direction !== "UPSTREAM" && fromIn) nextRefs.set(to, parseNodeRefValue(to));
      if (direction !== "DOWNSTREAM" && toIn) nextRefs.set(from, parseNodeRefValue(from));
    }

    const pending = [...nextRefs.values()].filter((ref) => !visited.has(nodeRefValue(ref)));
    if (!pending.length) {
      frontier = [];
      break;
    }
    const resolved = resolveRefs(db, Number(tenantId), pending, baseContext);
    unresolvedCount += resolved.unresolved.length;
    const allowed = domainFilter(authorizer.filter([...resolved.nodes.values()]), options.includeDomains, options.excludeDomains);
    for (const node of allowed) {
      if (nodes.size >= maxNodes) {
        truncatedReasons.add("node_limit");
        break;
      }
      if (!visited.has(node.node_ref)) {
        visited.add(node.node_ref);
        nodes.set(node.node_ref, { ...node, depth });
      }
    }
    frontier = allowed.map((node) => node.node_ref).filter((ref) => nodes.has(ref));
    if (nodes.size >= maxNodes) {
      truncatedReasons.add("node_limit");
      break;
    }
  }

  const finalNodes = new Map();
  for (const node of nodes.values()) {
    if (domainFilter([node], options.includeDomains, options.excludeDomains).length) finalNodes.set(node.node_ref, node);
  }
  const finalEdges = [...edges.values()].filter((edge) => finalNodes.has(edge.source_node_ref) && finalNodes.has(edge.target_node_ref));

  const domainCounts = new Map();
  for (const node of finalNodes.values()) {
    const domain = node.domain || "UNMAPPED";
    domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
  }

  const durationMs = Date.now() - started;
  if (durationMs > timeoutMs) truncatedReasons.add("timeout");

  return {
    root: rootNode,
    direction,
    max_depth: maxDepth,
    max_nodes: maxNodes,
    nodes: [...finalNodes.values()],
    edges: finalEdges,
    node_count: finalNodes.size,
    edge_count: finalEdges.length,
    depth_reached: depthReached,
    truncated: truncatedReasons.size > 0,
    truncation_reasons: [...truncatedReasons],
    unresolved_count: unresolvedCount,
    domains: [...domainCounts.entries()].map(([code, count]) => ({ code, count })),
    duration_ms: durationMs,
  };
}

export { registerProvider, resolveRefs, nodeRefKey };
