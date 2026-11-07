// Requirement change -> PLM impact analysis.
//
// Impact is not a second engine: it reuses the Digital Thread impact traversal
// (`thread/impact.js`) which is itself security-, revision-, effectivity- and
// configuration-aware, then classifies the affected nodes using the shared PLM
// vocabulary (Prompt 4, sections 10-11). Change Management remains responsible
// for formal impact processing; this module only reports what a requirement
// change reaches across the product/EBOM/MBOM/BOP/document/change chain.
import { Impact as ThreadImpact } from "../thread/index.js";
import { Requirements } from "../requirements/index.js";
import { IMPACT_CATEGORIES, CHANGE_NODE_CODES, PDM_NODE_TYPES } from "./constants.js";
import { getConfig } from "./configuration.js";
import { publishRequirementPdmEvent, publishRequirementPdmEventAsync } from "./events.js";
import { REQUIREMENT_PDM_EVENT_MAP } from "./constants.js";

const CHANGE_TYPES = new Set(CHANGE_NODE_CODES);
const RELEASED_STATES = new Set(["RELEASED", "APPROVED", "ISSUED", "PRODUCTION"]);

// Category precedence: the most specific classification wins when a node could
// belong to several (Prompt 4 section 11 ordering).
const CATEGORY_PRECEDENCE = ["CHANGE", "DOCUMENT", "PROCESS", "CONFIGURATION", "EFFECTIVITY", "DIRECT", "INDIRECT"];

function upper(value) {
  return String(value || "").toUpperCase();
}

function isProcessNode(type, domain) {
  if (domain === "BOP" || domain === "MANUFACTURING") return true;
  return type === "operation" || type === "manufacturing-order" || type === "bop";
}

function edgeInto(edges, nodeRef) {
  return (edges || []).find((edge) => edge.target_node_ref === nodeRef || edge.target === nodeRef);
}

function hasConfiguration(edge) {
  const configuration = edge?.configuration || {};
  return Boolean(configuration.variant || configuration.context);
}

function effectivityExpired(edge, asOf) {
  const end = edge?.effectivity?.end;
  if (!end) return false;
  const reference = Date.parse(String(asOf || new Date().toISOString()));
  const endTime = Date.parse(String(end));
  if (!Number.isFinite(reference) || !Number.isFinite(endTime)) return false;
  return endTime < reference;
}

function classifyNode(node, edge, asOf) {
  const type = String(node.object_type || node.node_type || "").toLowerCase();
  const domain = upper(node.domain);
  const depth = Number(node.depth || 0);
  const categories = [];
  if (CHANGE_TYPES.has(type)) categories.push("CHANGE");
  if (type === PDM_NODE_TYPES.DATASET) categories.push("DOCUMENT");
  if (isProcessNode(type, domain)) categories.push("PROCESS");
  if (hasConfiguration(edge)) categories.push("CONFIGURATION");
  if (effectivityExpired(edge, asOf)) categories.push("EFFECTIVITY");
  if (!categories.length) categories.push(depth <= 1 ? "DIRECT" : "INDIRECT");
  const primary = CATEGORY_PRECEDENCE.find((code) => categories.includes(code)) || "INDIRECT";
  return { primary, categories: [...new Set([primary, ...categories])] };
}

function permissiveAuthorizer() {
  return {
    allowsNode: () => true,
    filter: (nodes) => nodes,
    allowsNodeAsync: async () => true,
    filterAsync: async (nodes) => nodes,
  };
}

function buildOptions(db, tenant, options) {
  const maxDepth = Number(options.maxDepth ?? options.max_depth ?? getConfig(db, tenant, "impact_max_depth")) || 10;
  const authorizer = options.authorizer || permissiveAuthorizer();
  return { maxDepth, authorizer, includeInactive: options.includeInactive ?? true, asOf: options.asOf || null, variant: options.variant || null, configuration: options.configuration || null };
}

function summarize(requirement, graph, options) {
  const items = [];
  const categoryCounts = Object.fromEntries(IMPACT_CATEGORIES.map((code) => [code, 0]));
  const domainCounts = {};
  const typeCounts = {};
  let releasedCount = 0;
  let maxDepth = 0;
  for (const node of graph.nodes || []) {
    const depth = Number(node.depth || 0);
    if (depth === 0) continue;
    maxDepth = Math.max(maxDepth, depth);
    const edge = edgeInto(graph.edges, node.node_ref);
    const { primary, categories } = classifyNode(node, edge, options.asOf);
    const released = RELEASED_STATES.has(upper(node.lifecycle_state) || upper(node.status));
    if (released) releasedCount += 1;
    categoryCounts[primary] = (categoryCounts[primary] || 0) + 1;
    const domain = upper(node.domain) || "UNKNOWN";
    domainCounts[domain] = (domainCounts[domain] || 0) + 1;
    const type = String(node.object_type || node.node_type || "unknown").toLowerCase();
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    items.push({
      node_ref: node.node_ref,
      object_type: type,
      object_id: node.object_id,
      revision: node.revision || "",
      display_name: node.display_name || "",
      domain: upper(node.domain),
      lifecycle_state: node.lifecycle_state || "",
      depth,
      released,
      category: primary,
      categories,
    });
  }
  const impactedCount = items.length;
  const reasons = [];
  if (releasedCount > 0) reasons.push("released_object_impacted");
  if (categoryCounts.CHANGE > 0) reasons.push("change_object_impacted");
  if (categoryCounts.PROCESS > 0) reasons.push("process_impacted");
  return {
    requirement: {
      id: requirement.id,
      requirement_ref: requirement.requirement_ref,
      requirement_number: requirement.requirement_number,
      object_id: requirement.object_id ?? null,
      priority: requirement.priority || "",
      criticality: requirement.criticality || "",
      status: requirement.status || "",
    },
    root: `requirement:${requirement.object_id}`,
    impacted_count: impactedCount,
    node_count: Number(graph.node_count || impactedCount),
    edge_count: Number(graph.edge_count || 0),
    depth_reached: maxDepth,
    truncated: Boolean(graph.truncated),
    released_count: releasedCount,
    released_impacted: releasedCount > 0,
    category_totals: categoryCounts,
    domain_totals: domainCounts,
    object_type_totals: typeCounts,
    items,
    recommendation: { change_candidate: releasedCount > 0 || categoryCounts.CHANGE > 0, reasons },
    generated_at: new Date().toISOString(),
  };
}

export function analyzeRequirementImpact(db, tenantId, requirementRef, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const requirement = Requirements.requireRequirementRow(db, tenant, requirementRef);
  if (!requirement.object_id) {
    throw new Error("Requirement has no mirrored Object identity; run the requirement mirror first");
  }
  const resolved = buildOptions(db, tenant, options);
  const graph = ThreadImpact.impactAnalysis(db, tenant, { root: `requirement:${requirement.object_id}`, maxDepth: resolved.maxDepth, includeInactive: resolved.includeInactive, asOf: resolved.asOf, variant: resolved.variant, configuration: resolved.configuration, authorizer: resolved.authorizer }, actor);
  const summary = summarize(requirement, graph, resolved);
  publishRequirementPdmEvent(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.PLM_IMPACT_DETECTED, objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, payload: { impacted_count: summary.impacted_count, released_impacted: summary.released_impacted, categories: summary.category_totals } }, actor);
  return { source_module: "requirement-pdm", ...summary };
}

export async function analyzeRequirementImpactAsync(db, tenantId, requirementRef, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const requirement = await Requirements.requireRequirementRowAsync(db, tenant, requirementRef);
  if (!requirement.object_id) {
    throw new Error("Requirement has no mirrored Object identity; run the requirement mirror first");
  }
  const resolved = buildOptions(db, tenant, options);
  const graph = await ThreadImpact.impactAnalysisAsync(db, tenant, { root: `requirement:${requirement.object_id}`, maxDepth: resolved.maxDepth, includeInactive: resolved.includeInactive, asOf: resolved.asOf, variant: resolved.variant, configuration: resolved.configuration, authorizer: resolved.authorizer }, actor);
  const summary = summarize(requirement, graph, resolved);
  await publishRequirementPdmEventAsync(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.PLM_IMPACT_DETECTED, objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, payload: { impacted_count: summary.impacted_count, released_impacted: summary.released_impacted, categories: summary.category_totals } }, actor);
  return { source_module: "requirement-pdm", ...summary };
}
