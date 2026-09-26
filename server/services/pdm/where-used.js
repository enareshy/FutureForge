// PDM where-used analysis.
//
// Given an item (optionally a specific revision) this walks the typed
// relationship graph upwards to answer "who uses this part / where does this
// revision appear". It is revision-rule aware and also surfaces external
// consumers recorded in the PDM reference index (BOM lines, CAD, documents).
// Traversal is bounded by depth and node caps.
import { queryAll } from "../../db.js";
import { publicItem, publicRevision } from "./repository.js";
import { getItemRow, requireItemRow } from "./items.js";
import { getRevisionRow } from "./revisions.js";
import { resolveRevisionRule } from "./revision-rules.js";
import { publishPdmEvent, pdmEventCode } from "./events.js";
import { SOURCE_MODULE, MAX_TRAVERSAL_NODES } from "./constants.js";
import { getConfig } from "./configuration.js";
import { objectNotFound } from "./errors.js";

const PARENT_RELATIONSHIP_TYPES = ["PRODUCT_HAS_PART", "ITEM_DERIVED_FROM", "PART_SUBSTITUTE"];

function findParentLinks(db, tenantId, itemId) {
  const placeholders = PARENT_RELATIONSHIP_TYPES.map(() => "?").join(",");
  return queryAll(
    db,
    `SELECT * FROM pdm_relationships
      WHERE tenant_id = ? AND status = 'ACTIVE' AND relationship_type IN (${placeholders})
        AND target_type = 'ITEM' AND target_id = ?
      ORDER BY id ASC`,
    [Number(tenantId), ...PARENT_RELATIONSHIP_TYPES, String(itemId)]
  );
}

export function whereUsed(db, tenantId, ref, { revisionId = null, revisionRuleId = null, ruleCode = null, context = {}, recursive = true, maxDepth = null, includeExternal = true, actor = null } = {}) {
  const tenant = Number(tenantId);
  const itemRow = requireItemRow(db, tenant, ref);
  const limit = clampDepth(maxDepth, 25);
  const nodeCap = Number(getConfig(db, tenant, "max_traversal_nodes") || MAX_TRAVERSAL_NODES);

  let targetRevision = null;
  if (revisionId != null) {
    const row = getRevisionRow(db, tenant, revisionId, { itemId: itemRow.id });
    if (!row) throw objectNotFound({ revision_id: revisionId, item_id: itemRow.id });
    targetRevision = row;
  } else {
    try {
      targetRevision = resolveRevisionRule(db, tenant, { itemId: itemRow.id, ruleId: revisionRuleId, ruleCode, context }).revision;
    } catch {
      targetRevision = null;
    }
  }

  const nodes = [nodeFor(itemRow, targetRevision, 0, "0", null, null)];
  const edges = [];
  const topLevel = [];
  const queue = [{ itemId: itemRow.id, level: 0, path: "0" }];
  let visited = 1;
  let truncated = false;

  while (queue.length) {
    const current = queue.shift();
    if (recursive && current.level >= limit) {
      if (findParentLinks(db, tenant, current.itemId).length) truncated = true;
      continue;
    }
    const parents = findParentLinks(db, tenant, current.itemId);
    if (!parents.length) {
      const currentItem = getItemRow(db, tenant, current.itemId);
      if (currentItem) topLevel.push({ item_id: currentItem.id, item_number: currentItem.item_number, item_ref: currentItem.item_ref, name: currentItem.name, level: current.level });
      continue;
    }
    for (const link of parents) {
      const parentId = Number(link.source_id);
      if (!Number.isInteger(parentId)) continue;
      const parentRow = getItemRow(db, tenant, parentId);
      if (!parentRow) continue;
      const parentRevision = safeResolveRevision(db, tenant, parentId, { revisionRuleId, ruleCode, context });
      const already = nodes.some((node) => node.item_id === parentId);
      const childPath = `${current.path}<${link.id}`;
      if (!already) {
        nodes.push(nodeFor(parentRow, parentRevision, current.level + 1, childPath, current.itemId, link));
      }
      edges.push({ relationship_id: link.id, relationship_ref: link.relationship_ref, relationship_type: link.relationship_type, parent_item_id: parentId, child_item_id: current.itemId, level: current.level + 1, quantity: parseQuantity(link.attributes_json) });
      visited += 1;
      if (!recursive) continue;
      if (visited >= nodeCap) {
        truncated = true;
        break;
      }
      if (!queue.some((entry) => entry.itemId === parentId && entry.level === current.level + 1)) queue.push({ itemId: parentId, level: current.level + 1, path: childPath });
    }
    if (visited >= nodeCap) break;
  }

  const external = includeExternal ? externalConsumers(db, tenant, itemRow.id, targetRevision?.id ?? null) : [];
  const result = {
    source_module: SOURCE_MODULE,
    target: { item: publicItem(itemRow), revision: targetRevision ? publicRevision(targetRevision) : null },
    immediate_parent_count: edges.filter((edge) => edge.level === 1).length,
    nodes,
    edges,
    top_level: dedupeTopLevel(topLevel),
    external_consumers: external,
    node_count: nodes.length,
    edge_count: edges.length,
    truncated,
    max_depth: limit,
    recursive: Boolean(recursive),
    analyzed_at: new Date().toISOString(),
  };
  publishPdmEvent(db, { eventType: pdmEventCode("WHERE_USED_RUN"), objectType: "pdm_item", objectId: itemRow.id, tenantId: tenant, organizationId: itemRow.organization_id, payload: { item_ref: itemRow.item_ref, node_count: nodes.length } }, actor);
  return result;
}

function externalConsumers(db, tenantId, itemId, revisionId) {
  const clauses = ["tenant_id = ?", "target_type IN ('ITEM','REVISION')", "(target_id = ?" + (revisionId ? " OR target_id = ?" : "") + ")"];
  const params = [Number(tenantId), String(itemId)];
  if (revisionId) params.push(String(revisionId));
  const rows = queryAll(db, `SELECT * FROM pdm_references WHERE ${clauses.join(" AND ")} ORDER BY category, id`, params);
  return rows.map((row) => ({ category: row.category, source_type: row.source_type, source_id: row.source_id, source_ref: row.source_ref || "", relationship_type: row.relationship_type || "" }));
}

function dedupeTopLevel(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    if (seen.has(entry.item_id)) continue;
    seen.add(entry.item_id);
    out.push(entry);
  }
  return out;
}

function nodeFor(itemRow, revisionRow, level, path, childItemId, link) {
  return {
    item_id: itemRow.id,
    item_number: itemRow.item_number,
    item_ref: itemRow.item_ref,
    name: itemRow.name,
    item_type: itemRow.item_type,
    status: itemRow.status,
    revision_id: revisionRow?.id ?? null,
    revision_number: revisionRow?.revision_number ?? null,
    revision_status: revisionRow?.status ?? null,
    level,
    path,
    uses_item_id: childItemId,
    relationship_id: link?.id ?? null,
    relationship_type: link?.relationship_type ?? null,
    quantity: link ? parseQuantity(link.attributes_json) : 1,
  };
}

function safeResolveRevision(db, tenantId, itemId, options) {
  try {
    return resolveRevisionRule(db, tenantId, { itemId, ...options }).revision;
  } catch {
    return null;
  }
}

function parseQuantity(json) {
  try {
    const parsed = JSON.parse(json || "{}") || {};
    const q = Number(parsed.quantity);
    return Number.isFinite(q) ? q : 1;
  } catch {
    return 1;
  }
}

function clampDepth(requested, fallback) {
  const n = Number(requested);
  if (Number.isFinite(n) && n > 0) return Math.min(n, 200);
  return fallback;
}
