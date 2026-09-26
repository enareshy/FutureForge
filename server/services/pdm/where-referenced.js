// PDM where-referenced analysis.
//
// Targets (items, revisions, datasets, representations) are indexed in the PDM
// reference table whenever another PDM object links to them. This service answers
// "what references this object?" by reading that reverse index and grouping the
// result by category. Reindexing rebuilds the index from the relationship graph.
import { queryAll } from "../../db.js";
import { publicReference } from "./repository.js";
import { listReferences, recordReference } from "./references.js";
import { publishPdmEvent, pdmEventCode } from "./events.js";
import { paginate, normalizeText, normalizeUpper } from "./validation.js";
import { SOURCE_MODULE, REFERENCE_CATEGORIES } from "./constants.js";

export function whereReferenced(db, tenantId, { targetType = null, targetId = null, target_type = null, target_id = null, category = null, page, pageSize, actor = null } = {}) {
  const tenant = Number(tenantId);
  const type = normalizeUpper(targetType ?? target_type ?? "ITEM", { max: 60 });
  const id = normalizeText(targetId ?? target_id ?? "", { max: 300 });
  const result = listReferences(db, { tenantId: tenant, targetType: type, targetId: id, category, page, pageSize });
  const grouped = groupByCategory(result.items);
  const payload = {
    source_module: SOURCE_MODULE,
    target: { target_type: type, target_id: id },
    items: result.items,
    total: result.total,
    page: result.page,
    page_size: result.page_size,
    groups: grouped,
    category_count: grouped.length,
    categories: REFERENCE_CATEGORIES,
  };
  publishPdmEvent(db, { eventType: pdmEventCode("WHERE_REFERENCED_RUN"), objectType: `pdm_${type.toLowerCase()}`, objectId: numericOrNull(id), tenantId: tenant, payload: { target_type: type, target_id: id, total: result.total } }, actor);
  return payload;
}

export function whereReferencedGroups(db, tenantId, { targetType, targetId } = {}) {
  const result = whereReferenced(db, tenantId, { targetType, targetId });
  return { source_module: SOURCE_MODULE, target: result.target, groups: result.groups, total: result.total };
}

export function referencesSummary(db, tenantId, targetType, targetId) {
  const rows = listReferences(db, { tenantId, targetType, targetId, page: 1, pageSize: 500 });
  const counts = {};
  for (const row of rows.items) counts[row.category] = (counts[row.category] || 0) + 1;
  return { source_module: SOURCE_MODULE, target_type: normalizeUpper(targetType, { max: 60 }), target_id: String(targetId), total: rows.total, counts };
}

// Rebuilds the reverse index for a tenant from the typed relationship graph.
// References already recorded by domain bridges are preserved; this only adds
// missing edges so the operation is idempotent.
export function rebuildReferences(db, tenantId, { actor = null } = {}) {
  const tenant = Number(tenantId);
  const relationships = queryAll(db, "SELECT * FROM pdm_relationships WHERE tenant_id = ?", [tenant]);
  let added = 0;
  for (const link of relationships) {
    const before = queryAll(
      db,
      "SELECT id FROM pdm_references WHERE tenant_id = ? AND source_type = 'RELATIONSHIP' AND source_id = ? AND target_type = ? AND target_id = ? AND category = 'RELATIONSHIP' LIMIT 1",
      [tenant, String(link.id), link.target_type, link.target_id]
    ).length;
    recordReference(db, tenant, {
      source_type: "RELATIONSHIP",
      source_id: String(link.id),
      source_ref: link.relationship_ref,
      target_type: link.target_type,
      target_id: link.target_id,
      target_ref: "",
      category: "RELATIONSHIP",
      relationship_type: link.relationship_type,
      organization_id: link.organization_id ?? null,
    });
    if (!before) added += 1;
  }
  void actor;
  return { source_module: SOURCE_MODULE, relationships: relationships.length, added, rebuilt_at: new Date().toISOString() };
}

export function listAllReferences(db, tenantId, { category, sourceType, targetType, page, pageSize } = {}) {
  return listReferences(db, { tenantId, category, sourceType, targetType, page, pageSize });
}

function groupByCategory(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.category)) map.set(item.category, []);
    map.get(item.category).push(item);
  }
  return [...map.entries()].map(([category, entries]) => ({ category, count: entries.length, items: entries }));
}

function numericOrNull(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

export { paginate, publicReference };
