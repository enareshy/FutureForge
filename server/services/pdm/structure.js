// PDM structure resolution.
//
// Resolves a product/assembly structure by walking typed PRODUCT_HAS_PART
// relationships and applying revision rules at every level. Traversal is
// depth-limited, cycle-safe and node-capped so a malformed graph can never
// exhaust the process. Shared by product structure endpoints, baselines and
// where-used.
import { queryAll, queryOne } from "../../db.js";
import { publicItem } from "./repository.js";
import { getItemRow, requireItemRow } from "./items.js";
import { resolveRevisionRule } from "./revision-rules.js";
import { normalizeText, normalizeUpper } from "./validation.js";
import { itemNotFound, invalidStructure } from "./errors.js";
import { SOURCE_MODULE, MAX_STRUCTURE_DEPTH, MAX_TRAVERSAL_NODES } from "./constants.js";
import { getConfig } from "./configuration.js";

function findChildLinks(db, tenantId, itemId) {
  return queryAll(
    db,
    `SELECT * FROM pdm_relationships
      WHERE tenant_id = ? AND relationship_type = 'PRODUCT_HAS_PART' AND status = 'ACTIVE'
        AND source_type = 'ITEM' AND source_id = ?
      ORDER BY id ASC`,
    [Number(tenantId), String(itemId)]
  );
}

// Resolves a single item node: item row + the revision selected by the rule.
export function resolveNode(db, tenantId, itemId, { revisionRuleId = null, ruleCode = null, context = {} } = {}) {
  const itemRow = getItemRow(db, tenantId, itemId);
  if (!itemRow) return null;
  let revision = null;
  try {
    const resolved = resolveRevisionRule(db, tenantId, { itemId: itemRow.id, ruleId: revisionRuleId, ruleCode, context });
    revision = resolved.revision;
  } catch {
    revision = null;
  }
  return { item: itemRow, revision };
}

export function resolveStructure(db, tenantId, { itemId = null, itemRef = null, revisionRuleId = null, ruleCode = null, context = {}, maxDepth = null, includeItems = true } = {}) {
  const tenant = Number(tenantId);
  const rootRow = itemId != null ? requireItemRow(db, tenant, itemId) : itemRef ? requireItemRow(db, tenant, itemRef) : null;
  if (!rootRow) throw itemNotFound(itemRef || itemId || "");
  const limit = clampDepth(maxDepth, getConfig(db, tenant, "max_structure_depth"));
  const nodeCap = Number(getConfig(db, tenant, "max_traversal_nodes") || MAX_TRAVERSAL_NODES);
  const rootNode = resolveNode(db, tenant, rootRow.id, { revisionRuleId, ruleCode, context });
  const nodes = [toNode(rootNode, 0, "0", null)];
  const edges = [];
  const seen = new Set([rootRow.id]);
  const queue = [{ itemId: rootRow.id, level: 0, path: "0" }];
  let truncated = false;
  let visited = 1;

  while (queue.length) {
    const current = queue.shift();
    if (current.level >= limit) {
      if (findChildLinks(db, tenant, current.itemId).length) truncated = true;
      continue;
    }
    const links = findChildLinks(db, tenant, current.itemId);
    for (const link of links) {
      const childId = Number(link.target_id);
      if (!Number.isInteger(childId)) continue;
      if (seen.has(childId)) {
        edges.push({ source_item_id: current.itemId, target_item_id: childId, relationship_id: link.id, relationship_ref: link.relationship_ref, cycle: true, level: current.level + 1 });
        continue;
      }
      const childRow = getItemRow(db, tenant, childId);
      if (!childRow) continue;
      const childNode = resolveNode(db, tenant, childId, { revisionRuleId, ruleCode, context });
      const attributes = parseAttributes(link.attributes_json);
      const childPath = `${current.path}.${nodes.filter((n) => n.parent_item_id === current.itemId && n.level === current.level + 1).length}`;
      nodes.push(toNode(childNode, current.level + 1, childPath, current.itemId, attributes.quantity));
      edges.push({ source_item_id: current.itemId, target_item_id: childId, relationship_id: link.id, relationship_ref: link.relationship_ref, quantity: attributes.quantity ?? 1, level: current.level + 1 });
      seen.add(childId);
      visited += 1;
      if (visited >= nodeCap) {
        truncated = true;
        break;
      }
      queue.push({ itemId: childId, level: current.level + 1, path: childPath });
    }
    if (visited >= nodeCap) break;
  }

  return {
    source_module: SOURCE_MODULE,
    root: includeItems ? publicItem(rootRow) : { id: rootRow.id, item_number: rootRow.item_number, item_ref: rootRow.item_ref },
    revision_rule_id: revisionRuleId ?? null,
    rule_code: ruleCode ?? null,
    context: context || {},
    nodes,
    edges,
    node_count: nodes.length,
    edge_count: edges.length,
    max_depth: limit,
    truncated,
    resolved_at: new Date().toISOString(),
  };
}

export function structureForItem(db, tenantId, itemId) {
  return resolveStructure(db, tenantId, { itemId });
}

export function validateStructureGraph(db, tenantId, itemId) {
  const resolved = resolveStructure(db, tenantId, { itemId });
  const cycles = resolved.edges.filter((edge) => edge.cycle);
  return {
    source_module: SOURCE_MODULE,
    root_item_id: Number(itemId),
    node_count: resolved.node_count,
    edge_count: resolved.edge_count,
    has_cycle: cycles.length > 0,
    cycles,
    truncated: resolved.truncated,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function clampDepth(requested, configured) {
  const fallback = Number(MAX_STRUCTURE_DEPTH);
  const configuredValue = Number(configured) || fallback;
  const bound = Math.min(Math.max(configuredValue, 1), fallback);
  const requestedValue = Number(requested);
  if (!Number.isFinite(requestedValue) || requestedValue <= 0) return bound;
  return Math.min(requestedValue, bound);
}

function toNode(resolved, level, path, parentItemId, quantity = null) {
  const item = resolved.item;
  const revision = resolved.revision;
  return {
    item_id: item.id,
    item_number: item.item_number,
    item_ref: item.item_ref,
    name: item.name,
    item_type: item.item_type,
    status: item.status,
    revision_id: revision?.id ?? null,
    revision_number: revision?.revision_number ?? null,
    revision_ref: revision?.revision_ref ?? null,
    revision_status: revision?.status ?? null,
    parent_item_id: parentItemId,
    level,
    path,
    quantity: quantity ?? 1,
  };
}

function parseAttributes(json) {
  try {
    return JSON.parse(json || "{}") || {};
  } catch {
    return {};
  }
}
