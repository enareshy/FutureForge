// Requirement <-> Manufacturing change impact analysis.
//
// Impact is not a second engine: it reuses the Digital Thread impact traversal
// (`thread/impact.js`), which is itself security-, revision-, effectivity- and
// configuration-aware, then classifies the affected nodes with the manufacturing
// vocabulary. Forward analysis starts from a requirement and walks the whole
// Product/EBOM/MBOM/BOP/Operation/Work-center/Characteristic/CTQ/Document/Change
// chain; reverse analysis starts from a manufacturing node and finds the
// requirements linked to it through their allocations. Change Management remains
// the system of record for formal impact processing; this module only reports.
import { Impact as ThreadImpact } from "../thread/index.js";
import { Requirements } from "../requirements/index.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { getConfig } from "./configuration.js";
import { listTargetRequirements, listTargetRequirementsAsync } from "./allocations.js";
import {
  MANUFACTURING_IMPACT_CATEGORIES,
  MANUFACTURING_IMPACT_PRECEDENCE,
  MANUFACTURING_NODE_TYPES,
  CHANGE_NODE_TYPES,
  REQUIREMENT_MANUFACTURING_EVENT_MAP,
} from "./constants.js";
import { publishRequirementManufacturingEvent, publishRequirementManufacturingEventAsync } from "./events.js";

const CHANGE_TYPES = new Set(CHANGE_NODE_TYPES);
const RELEASED_STATES = new Set(["RELEASED", "APPROVED", "ISSUED", "PRODUCTION"]);
const PROCESS_TYPES = new Set(["operation", "manufacturing-order", "bop"]);

function upper(value) {
  return String(value || "").toUpperCase();
}

function lower(value) {
  return String(value || "").toLowerCase();
}

function isProcessNode(type, domain) {
  if (domain === "BOP" || domain === "MANUFACTURING") return true;
  return PROCESS_TYPES.has(type);
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

function isCtq(node) {
  const metadata = node?.metadata || node?.metadata_json || {};
  if (typeof metadata === "object" && metadata !== null && (metadata.ctq === true || metadata.ctq === "true" || metadata.critical === true)) return true;
  return node?.ctq === true || node?.ctq === "true";
}

function classifyNode(node, edge, asOf) {
  const type = lower(node.object_type || node.node_type);
  const domain = upper(node.domain);
  const depth = Number(node.depth || 0);
  const categories = [];
  if (CHANGE_TYPES.has(type)) categories.push("CHANGE");
  if (type === "content" || type === "dataset" || type === "document" || domain === "CONTENT") categories.push("DOCUMENT");
  if (isCtq(node)) categories.push("CTQ");
  if (type === "characteristic" || domain === "CLASSIFICATION") categories.push("CHARACTERISTIC");
  if (isProcessNode(type, domain)) categories.push("PROCESS");
  if (hasConfiguration(edge)) categories.push("CONFIGURATION");
  if (effectivityExpired(edge, asOf)) categories.push("EFFECTIVITY");
  if (!categories.length) categories.push(depth <= 1 ? "DIRECT" : "INDIRECT");
  const primary = MANUFACTURING_IMPACT_PRECEDENCE.find((code) => categories.includes(code)) || "INDIRECT";
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
  return {
    maxDepth,
    authorizer,
    includeInactive: options.includeInactive ?? true,
    asOf: options.asOf || null,
    variant: options.variant || null,
    configuration: options.configuration || null,
  };
}

function summarize(requirement, graph, options) {
  const items = [];
  const categoryCounts = Object.fromEntries(MANUFACTURING_IMPACT_CATEGORIES.map((code) => [code, 0]));
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
    const type = lower(node.object_type || node.node_type || "unknown");
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
  if (categoryCounts.CHARACTERISTIC > 0 || categoryCounts.CTQ > 0) reasons.push("characteristic_impacted");
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

function requireMirrored(db, tenant, requirementRef) {
  const requirement = Requirements.requireRequirementRow(db, tenant, requirementRef);
  if (!requirement.object_id) {
    throw new Error("Requirement has no mirrored Object identity; run the requirement mirror first");
  }
  return requirement;
}

async function requireMirroredAsync(db, tenant, requirementRef) {
  const requirement = await Requirements.requireRequirementRowAsync(db, tenant, requirementRef);
  if (!requirement.object_id) {
    throw new Error("Requirement has no mirrored Object identity; run the requirement mirror first");
  }
  return requirement;
}

function impactOptions(requirement, resolved) {
  return {
    root: `requirement:${requirement.object_id}`,
    maxDepth: resolved.maxDepth,
    includeInactive: resolved.includeInactive,
    asOf: resolved.asOf,
    variant: resolved.variant,
    configuration: resolved.configuration,
    authorizer: resolved.authorizer,
  };
}

function auditDetails(requirement, summary) {
  return {
    requirement_id: requirement.id,
    requirement_ref: requirement.requirement_ref,
    impacted_count: summary.impacted_count,
    released_impacted: summary.released_impacted,
    categories: summary.category_totals,
  };
}

// Forward: a requirement change -> what it reaches in the manufacturing chain.
export function analyzeRequirementImpact(db, tenantId, requirementRef, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const requirement = requireMirrored(db, tenant, requirementRef);
  const resolved = buildOptions(db, tenant, options);
  const graph = ThreadImpact.impactAnalysis(db, tenant, impactOptions(requirement, resolved), actor);
  const summary = summarize(requirement, graph, resolved);
  const details = auditDetails(requirement, summary);
  writeAudit(db, { actor, action: "requirement-manufacturing.impact.analyze", resourceType: "requirement_manufacturing_impact", resourceId: String(requirement.id), details, ip });
  publishRequirementManufacturingEvent(db, { eventType: REQUIREMENT_MANUFACTURING_EVENT_MAP.IMPACT_DETECTED, objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, payload: { ...details, scope: "requirement" } }, actor);
  return { source_module: "requirement-manufacturing", ...summary };
}

export async function analyzeRequirementImpactAsync(db, tenantId, requirementRef, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const requirement = await requireMirroredAsync(db, tenant, requirementRef);
  const resolved = buildOptions(db, tenant, options);
  const graph = await ThreadImpact.impactAnalysisAsync(db, tenant, impactOptions(requirement, resolved), actor);
  const summary = summarize(requirement, graph, resolved);
  const details = auditDetails(requirement, summary);
  await writeAuditAsync(db, { actor, action: "requirement-manufacturing.impact.analyze", resourceType: "requirement_manufacturing_impact", resourceId: String(requirement.id), details, ip });
  await publishRequirementManufacturingEventAsync(db, { eventType: REQUIREMENT_MANUFACTURING_EVENT_MAP.IMPACT_DETECTED, objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, payload: { ...details, scope: "requirement" } }, actor);
  return { source_module: "requirement-manufacturing", ...summary };
}

// Reverse: a manufacturing/PLM node change -> the requirements it reaches.
//
// The node's linked requirements are found through the existing allocation
// edges (reverse navigation) and each is classified with the same forward
// analysis. `analyze:false` returns just the affected requirement list.
function nodeChangeSummary(nodeType, target, items, results, options) {
  const categoryTotals = Object.fromEntries(MANUFACTURING_IMPACT_CATEGORIES.map((code) => [code, 0]));
  let releasedImpacted = 0;
  let impactedCount = 0;
  for (const result of results) {
    for (const [code, value] of Object.entries(result.category_totals || {})) categoryTotals[code] = (categoryTotals[code] || 0) + value;
    impactedCount += Number(result.impacted_count || 0);
    if (result.released_impacted) releasedImpacted += 1;
  }
  return {
    node_type: lower(nodeType),
    node_id: target?.target_id ?? null,
    node_ref: target?.ref ?? null,
    requirement_count: items.length,
    analyzed: options.analyze !== false,
    impacted_count: impactedCount,
    released_impacted: releasedImpacted > 0,
    category_totals: categoryTotals,
    requirements: results.map((result) => ({
      requirement_id: result.requirement.id,
      requirement_ref: result.requirement.requirement_ref,
      requirement_number: result.requirement.requirement_number,
      impacted_count: result.impacted_count,
      released_impacted: result.released_impacted,
      category_totals: result.category_totals,
    })),
    generated_at: new Date().toISOString(),
  };
}

function nodeAuditDetails(nodeType, target, summary) {
  return {
    node_type: summary.node_type,
    node_id: summary.node_id,
    requirement_count: summary.requirement_count,
    impacted_count: summary.impacted_count,
  };
}

export function analyzeNodeImpact(db, tenantId, params = {}, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const nodeType = params.nodeType ?? params.node_type ?? params.targetType ?? params.target_type;
  const nodeId = params.nodeId ?? params.node_id ?? params.targetId ?? params.target_id ?? params.ref;
  const linked = listTargetRequirements(db, tenant, nodeType, nodeId, { status: "ACTIVE" });
  const resolved = buildOptions(db, tenant, options);
  const results = [];
  if (options.analyze !== false) {
    for (const item of linked.items) {
      const requirement = requireMirrored(db, tenant, item.requirement_id);
      const graph = ThreadImpact.impactAnalysis(db, tenant, impactOptions(requirement, resolved), actor);
      results.push({ requirement, ...summarize(requirement, graph, resolved) });
    }
  } else {
    for (const item of linked.items) {
      const requirement = requireMirrored(db, tenant, item.requirement_id);
      results.push({ requirement, impacted_count: 0, released_impacted: false, category_totals: {} });
    }
  }
  const summary = nodeChangeSummary(nodeType, linked.target, linked.items, results, options);
  const details = nodeAuditDetails(nodeType, linked.target, summary);
  writeAudit(db, { actor, action: "requirement-manufacturing.impact.node", resourceType: "requirement_manufacturing_impact", resourceId: `${summary.node_type}:${summary.node_id}`, details, ip });
  publishRequirementManufacturingEvent(db, { eventType: REQUIREMENT_MANUFACTURING_EVENT_MAP.IMPACT_DETECTED, objectType: nodeType, objectId: nodeId != null ? String(nodeId) : null, tenantId: tenant, payload: { ...details, scope: "node" } }, actor);
  return { source_module: "requirement-manufacturing", ...summary };
}

export async function analyzeNodeImpactAsync(db, tenantId, params = {}, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const nodeType = params.nodeType ?? params.node_type ?? params.targetType ?? params.target_type;
  const nodeId = params.nodeId ?? params.node_id ?? params.targetId ?? params.target_id ?? params.ref;
  const linked = await listTargetRequirementsAsync(db, tenant, nodeType, nodeId, { status: "ACTIVE" });
  const resolved = buildOptions(db, tenant, options);
  const results = [];
  if (options.analyze !== false) {
    for (const item of linked.items) {
      const requirement = await requireMirroredAsync(db, tenant, item.requirement_id);
      const graph = await ThreadImpact.impactAnalysisAsync(db, tenant, impactOptions(requirement, resolved), actor);
      results.push({ requirement, ...summarize(requirement, graph, resolved) });
    }
  } else {
    for (const item of linked.items) {
      const requirement = await requireMirroredAsync(db, tenant, item.requirement_id);
      results.push({ requirement, impacted_count: 0, released_impacted: false, category_totals: {} });
    }
  }
  const summary = nodeChangeSummary(nodeType, linked.target, linked.items, results, options);
  const details = nodeAuditDetails(nodeType, linked.target, summary);
  await writeAuditAsync(db, { actor, action: "requirement-manufacturing.impact.node", resourceType: "requirement_manufacturing_impact", resourceId: `${summary.node_type}:${summary.node_id}`, details, ip });
  await publishRequirementManufacturingEventAsync(db, { eventType: REQUIREMENT_MANUFACTURING_EVENT_MAP.IMPACT_DETECTED, objectType: nodeType, objectId: nodeId != null ? String(nodeId) : null, tenantId: tenant, payload: { ...details, scope: "node" } }, actor);
  return { source_module: "requirement-manufacturing", ...summary };
}

// Manufacturing node type -> impact category, for clients that render impact
// summaries without inspecting each item.
export function impactCategoryForNodeType(nodeType) {
  const type = lower(nodeType);
  if (CHANGE_TYPES.has(type)) return "CHANGE";
  if (type === "content" || type === "dataset" || type === "document") return "DOCUMENT";
  if (type === "characteristic") return "CHARACTERISTIC";
  if (isProcessNode(type, "")) return "PROCESS";
  if (type === MANUFACTURING_NODE_TYPES.MBOM || type === MANUFACTURING_NODE_TYPES.EBOM || type === MANUFACTURING_NODE_TYPES.BOP) return "PROCESS";
  return type ? "DIRECT" : "INDIRECT";
}
