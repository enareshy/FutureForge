// BOM quantity rollup.
//
// Computes extended quantities (parent quantity x child quantity) down the line
// tree and aggregates total component demand per object. The same traversal
// powers what-if analysis and manufacturing planning views.
import { buildTree } from "./structure.js";
import { isEffectivityActive } from "./effectivity.js";
import { isApplicable } from "./variants.js";
import { getConfig } from "./configuration.js";
import { normalizeQuantity } from "./validation.js";

function shouldInclude(line, { includeOptional, includeInactive, context }) {
  if (!includeInactive && String(line.line_status).toUpperCase() === "INACTIVE") return false;
  if (!includeOptional && line.optional) return false;
  if (context?.effectivity && !isEffectivityActive(line.effectivity, context.effectivity)) return false;
  if (context?.variant && !isApplicable(line, context.variant)) return false;
  return true;
}

export function rollup(db, tenantId, revisionId, options = {}) {
  const includeOptional = options.includeOptional ?? Boolean(getConfig(db, tenantId, "rollup_include_optional"));
  const includeInactive = options.includeInactive ?? false;
  const context = options.context || null;
  const tree = buildTree(db, tenantId, revisionId, { includeInactive: true, maxDepth: options.maxDepth });
  const byObject = new Map();
  const byUsage = new Map();
  let lineCount = 0;
  let leafCount = 0;

  const walk = (node, parentQuantity) => {
    const line = node.line;
    if (!shouldInclude(line, { includeOptional, includeInactive, context })) return null;
    const quantity = normalizeQuantity(line.quantity, { fallback: 1 });
    const extended = Number((parentQuantity * quantity).toFixed(6));
    lineCount += 1;
    const key = `${line.child_object_type}:${line.child_object_id}`;
    const aggregate = byObject.get(key) || { object_id: line.child_object_id, object_type: line.child_object_type, quantity: 0, occurrences: 0, uom: line.uom };
    aggregate.quantity = Number((aggregate.quantity + extended).toFixed(6));
    aggregate.occurrences += 1;
    byObject.set(key, aggregate);
    byUsage.set(line.usage, Number(((byUsage.get(line.usage) || 0) + extended).toFixed(6)));

    const children = (node.children || []).map((child) => walk(child, extended)).filter(Boolean);
    if (!children.length) leafCount += 1;
    return {
      line,
      level: node.level,
      path: node.path,
      unit_quantity: quantity,
      extended_quantity: extended,
      uom: line.uom,
      child_count: children.length,
      children,
    };
  };

  const roots = (tree.roots || []).map((node) => walk(node, 1)).filter(Boolean);
  const totals = [...byObject.values()].sort((a, b) => b.quantity - a.quantity);
  return {
    revision_id: Number(revisionId),
    mode: options.mode || getConfig(db, tenantId, "default_rollup_mode") || "QUANTITY",
    include_optional: includeOptional,
    line_count: lineCount,
    leaf_count: leafCount,
    max_depth: tree.max_depth,
    roots,
    totals: { objects: totals, by_usage: Object.fromEntries(byUsage) },
  };
}

export function rollupTotals(db, tenantId, revisionId, options = {}) {
  const result = rollup(db, tenantId, revisionId, options);
  return { revision_id: result.revision_id, mode: result.mode, line_count: result.line_count, objects: result.totals.objects, by_usage: result.totals.by_usage };
}
