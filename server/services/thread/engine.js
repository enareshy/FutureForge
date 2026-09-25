// Query orchestration for the Digital Thread.
//
// This is the single entry point the API, jobs and reporting services use. It
// resolves the definition and tenant configuration, runs the traversal engine
// with consistent bounds and security, records query history, publishes domain
// events and shapes a public graph payload.
import { traverseThread } from "./traversal.js";
import { resolveDefinition } from "./definitions.js";
import { getConfig, getNumericConfig, listConfig } from "./configuration.js";
import { createNodeAuthorizer } from "./security.js";
import { recordQuery } from "./history.js";
import { publishThreadEvent, threadEventCode } from "./events.js";

function effectiveMaxDepth(requested, definition, config) {
  const bound = Number(config.max_traversal_depth) || 25;
  const shown = requested != null ? Number(requested) : Number(definition?.max_depth);
  if (!Number.isFinite(shown) || shown <= 0) return bound;
  return Math.min(bound, Math.floor(shown));
}

function effectiveMaxNodes(requested, config) {
  const bound = Number(config.max_traversal_nodes) || 10000;
  const shown = requested != null ? Number(requested) : bound;
  if (!Number.isFinite(shown) || shown <= 0) return bound;
  return Math.min(bound, Math.floor(shown));
}

// Runs a traversal and returns the raw engine result plus the resolved
// definition. `options.root` is required.
export function executeTraversal(db, tenantId, options = {}, actor = null, { action = "TRAVERSAL", record = true, publish = true, includeLineage = false } = {}) {
  const tenant = Number(tenantId);
  const definition = options.definition || resolveDefinition(db, tenant, { code: options.definitionCode || options.definition_code, id: options.definitionId ?? options.definition_id });
  const config = listConfig(db, tenant);
  const authorizer = options.authorizer || createNodeAuthorizer(db, actor, { tenantId: tenant, organizationId: options.organizationId, ip: options.ip, action: "read" });
  const relationshipTypes = options.relationshipTypes || (options.enforceDefinition === true ? definition.relationships?.map((entry) => entry.relationship_type).filter(Boolean) : null);

  const result = traverseThread(
    db,
    tenant,
    {
      root: options.root,
      direction: options.direction || definition.direction || "DOWNSTREAM",
      maxDepth: effectiveMaxDepth(options.maxDepth ?? options.max_depth, definition, config),
      maxNodes: effectiveMaxNodes(options.maxNodes ?? options.max_nodes, config),
      configMaxDepth: Number(config.max_traversal_depth),
      configMaxNodes: Number(config.max_traversal_nodes),
      configTimeout: Number(config.query_timeout_ms),
      includeInactive: options.includeInactive ?? config.include_inactive_nodes,
      includeDomains: options.includeDomains || null,
      excludeDomains: options.excludeDomains || null,
      relationshipTypes: relationshipTypes || null,
      allowCrossDomain: options.allowCrossDomain !== undefined ? options.allowCrossDomain : config.allow_cross_domain,
      asOf: options.asOf || options.as_of || "",
      serialNumber: options.serialNumber || options.serial_number || "",
      lot: options.lot || "",
      change: options.change || "",
      variant: options.variant || "",
      configuration: options.configuration || "",
      revision: options.revision || options.revisionRule || "",
      organizationId: options.organizationId ?? null,
      ip: options.ip ?? null,
      definition,
      authorizer,
    },
    actor
  );

  if (record) {
    try {
      recordQuery(db, {
        tenantId: tenant,
        action,
        request: { root: options.root, direction: result.direction, definition_code: definition.code, max_depth: result.max_depth },
        summary: { node_count: result.node_count, edge_count: result.edge_count, truncated: result.truncated, domains: result.domains },
        durationMs: result.duration_ms,
        nodeCount: result.node_count,
        edgeCount: result.edge_count,
        truncated: result.truncated,
        actor,
      });
    } catch {
      // Query history must never fail a read.
    }
  }
  if (publish) {
    try {
      const eventKey = action === "IMPACT" ? "IMPACT_RUN" : action === "PATH" ? "PATH_RUN" : "TRAVERSAL_RUN";
      publishThreadEvent(
        db,
        {
          eventType: threadEventCode(eventKey),
          objectType: "thread_query",
          objectId: null,
          tenantId: tenant,
          payload: { action, root: result.root?.node_ref || null, node_count: result.node_count, edge_count: result.edge_count, truncated: result.truncated },
        },
        actor
      );
    } catch {
      // Events are best-effort.
    }
  }

  const payload = { result, definition, config, authorizer, tenant };
  if (includeLineage) payload.lineage = [];
  return payload;
}

// Shapes a public graph document from an engine result.
export function publicGraph(result, definition = null) {
  return {
    root: result.root,
    definition: definition ? { code: definition.code, name: definition.name, domains: definition.domains || [] } : null,
    direction: result.direction,
    max_depth: result.max_depth,
    max_nodes: result.max_nodes,
    nodes: result.nodes,
    edges: result.edges,
    node_count: result.node_count,
    edge_count: result.edge_count,
    depth_reached: result.depth_reached,
    truncated: result.truncated,
    truncation_reasons: result.truncation_reasons,
    unresolved_count: result.unresolved_count,
    domains: result.domains,
    duration_ms: result.duration_ms,
    source_module: "thread",
  };
}

export { getConfig, getNumericConfig, resolveDefinition };
