// Metadata-level lineage and bounded graph traversal.
//
// Lineage records relationships between typed endpoints (catalog entries or
// external references). The catalog stores metadata only: transformations are
// described by reference, never executed here. Traversal is always bounded by
// the tenant's configured depth and node limits so an unbounded graph walk is
// impossible.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import {
  assertLineageRelationship,
  normalizeLower,
  normalizeText,
  normalizeUpper,
  paginate,
  parseObject,
  toInt,
} from "./validation.js";
import { publicLineage } from "./repository.js";
import { lineageNotFound, lineageConflict, invalidLineage, lineageTooLarge } from "./errors.js";
import { publishCatalogEvent } from "./events.js";
import { getConfig } from "./configuration.js";
import { LINEAGE_DEFAULT_DEPTH, LINEAGE_MAX_DEPTH, LINEAGE_MAX_NODES } from "./constants.js";

export { publicLineage };

// Endpoint types the catalog understands. Anything else is still storable as an
// external reference, but only catalog entry types participate in title
// enrichment.
const ENTRY_ENDPOINT_TYPES = new Set(["DOMAIN", "OBJECT", "ATTRIBUTE", "BUSINESS_TERM", "SOURCE", "CONSUMER", "CLASSIFICATION", "LINEAGE"]);

export function getLineageRow(db, id, tenantId = null) {
  return tenantId
    ? queryOne(db, "SELECT * FROM dc_lineage WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)])
    : queryOne(db, "SELECT * FROM dc_lineage WHERE id = ?", [Number(id)]);
}

export function requireLineage(db, id, tenantId = null) {
  const row = getLineageRow(db, id, tenantId);
  if (!row) throw lineageNotFound(id);
  return row;
}

export function listLineage(db, { tenantId, fromType, fromId, toType, toId, relationshipType, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (fromType) {
    clauses.push("from_type = ?");
    params.push(normalizeUpper(fromType));
  }
  if (fromId !== undefined && fromId !== null && fromId !== "") {
    clauses.push("from_id = ?");
    params.push(String(fromId));
  }
  if (toType) {
    clauses.push("to_type = ?");
    params.push(normalizeUpper(toType));
  }
  if (toId !== undefined && toId !== null && toId !== "") {
    clauses.push("to_id = ?");
    params.push(String(toId));
  }
  if (relationshipType) {
    clauses.push("relationship_type = ?");
    params.push(assertLineageRelationship(normalizeUpper(relationshipType)));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeLower(status));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dc_lineage ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM dc_lineage ${where} ORDER BY id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicLineage), total, page: currentPage, page_size: limit };
}

export function getLineage(db, id, tenantId = null) {
  return publicLineage(requireLineage(db, id, tenantId));
}

export function createLineage(db, input = {}, actor = null, tenantId = null, ip = null) {
  const fromType = assertEndpointType(input.from_type ?? input.fromType, "from");
  const toType = assertEndpointType(input.to_type ?? input.toType, "to");
  const fromId = normalizeText(input.from_id ?? input.fromId, { max: 200 });
  const toId = normalizeText(input.to_id ?? input.toId, { max: 200 });
  if (!fromId || !toId) throw invalidLineage("Lineage requires both a from and a to endpoint id");
  if (fromType === toType && fromId === toId) throw invalidLineage("Lineage cannot connect an endpoint to itself");
  const relationshipType = assertLineageRelationship(normalizeUpper(input.relationship_type || input.relationshipType || "DERIVED_FROM"));
  const existing = queryOne(
    db,
    "SELECT * FROM dc_lineage WHERE tenant_id = ? AND from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND relationship_type = ?",
    [Number(tenantId), fromType, fromId, toType, toId, relationshipType]
  );
  if (existing) {
    if (existing.status === "inactive") {
      run(db, "UPDATE dc_lineage SET status = 'active', updated_at = ? WHERE id = ?", [nowIso(), existing.id]);
      return publicLineage(queryOne(db, "SELECT * FROM dc_lineage WHERE id = ?", [existing.id]));
    }
    throw lineageConflict({ from_type: fromType, from_id: fromId, to_type: toType, to_id: toId, relationship_type: relationshipType });
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO dc_lineage
      (tenant_id, from_type, from_id, from_ref, to_type, to_id, to_ref, relationship_type,
       transformation_reference, job_ref, status, effective_from, effective_to, metadata_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(tenantId),
      fromType,
      fromId,
      normalizeText(input.from_ref),
      toType,
      toId,
      normalizeText(input.to_ref),
      relationshipType,
      normalizeText(input.transformation_reference),
      normalizeText(input.job_ref),
      normalizeLower(input.status || "active") === "inactive" ? "inactive" : "active",
      normalizeText(input.effective_from) || null,
      normalizeText(input.effective_to) || null,
      JSON.stringify(input.metadata ?? {}),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM dc_lineage WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, {
    actor,
    action: "data_catalog.lineage.create",
    resourceType: "dc_lineage",
    resourceId: row.id,
    details: { from: `${fromType}:${fromId}`, to: `${toType}:${toId}`, relationship_type: relationshipType },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "LineageCreated",
    tenantId: Number(tenantId),
    objectType: "data_lineage",
    objectId: row.id,
    payload: { id: row.id, from: `${fromType}:${fromId}`, to: `${toType}:${toId}`, relationship_type: relationshipType },
  }, actor);
  return publicLineage(row);
}

function assertEndpointType(value, side) {
  const type = normalizeUpper(value);
  if (!type) throw invalidLineage(`Lineage ${side} endpoint type is required`);
  return type;
}

export function updateLineage(db, id, patch = {}, actor = null, tenantId = null, ip = null) {
  const row = requireLineage(db, id, tenantId);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.relationship_type !== undefined) assign("relationship_type", assertLineageRelationship(normalizeUpper(patch.relationship_type)));
  if (patch.transformation_reference !== undefined) assign("transformation_reference", normalizeText(patch.transformation_reference));
  if (patch.job_ref !== undefined) assign("job_ref", normalizeText(patch.job_ref));
  if (patch.status !== undefined) assign("status", normalizeLower(patch.status) === "inactive" ? "inactive" : "active");
  if (patch.effective_from !== undefined) assign("effective_from", normalizeText(patch.effective_from) || null);
  if (patch.effective_to !== undefined) assign("effective_to", normalizeText(patch.effective_to) || null);
  if (patch.metadata !== undefined) assign("metadata_json", JSON.stringify(parseObject(patch.metadata, {})));
  if (!changes.length) return publicLineage(row);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dc_lineage SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  const updated = queryOne(db, "SELECT * FROM dc_lineage WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "data_catalog.lineage.update",
    resourceType: "dc_lineage",
    resourceId: row.id,
    details: { fields: Object.keys(patch) },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "LineageChanged",
    tenantId: row.tenant_id,
    objectType: "data_lineage",
    objectId: row.id,
    payload: { id: row.id, fields: Object.keys(patch) },
  }, actor);
  return publicLineage(updated);
}

export function removeLineage(db, id, actor = null, tenantId = null, ip = null) {
  const row = requireLineage(db, id, tenantId);
  run(db, "DELETE FROM dc_lineage WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "data_catalog.lineage.remove",
    resourceType: "dc_lineage",
    resourceId: row.id,
    details: { from: `${row.from_type}:${row.from_id}`, to: `${row.to_type}:${row.to_id}` },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "LineageChanged",
    tenantId: row.tenant_id,
    objectType: "data_lineage",
    objectId: row.id,
    payload: { id: row.id, removed: true },
  }, actor);
  return { deleted: true, id: row.id };
}

// Bounded BFS over the lineage graph. `direction` is upstream (what feeds the
// root), downstream (what the root feeds) or both. Depth and node counts are
// clamped to the tenant configuration and the hard platform caps.
export function lineageGraph(db, { tenantId, rootType, rootId, direction = "both", maxDepth, maxNodes } = {}) {
  const type = assertEndpointType(rootType, "root");
  const id = normalizeText(rootId, { max: 200 });
  if (!id) throw invalidLineage("A lineage root id is required");
  const configDepth = toInt(getConfig(db, tenantId, "lineage_max_depth"), LINEAGE_MAX_DEPTH) || LINEAGE_MAX_DEPTH;
  const configNodes = toInt(getConfig(db, tenantId, "lineage_max_nodes"), LINEAGE_MAX_NODES) || LINEAGE_MAX_NODES;
  const depthLimit = Math.min(Math.max(1, toInt(maxDepth, LINEAGE_DEFAULT_DEPTH) || LINEAGE_DEFAULT_DEPTH), Math.min(configDepth, LINEAGE_MAX_DEPTH));
  const nodeLimit = Math.min(Math.max(1, toInt(maxNodes, configNodes) || configNodes), Math.min(configNodes, LINEAGE_MAX_NODES));
  const dir = ["upstream", "downstream", "both"].includes(direction) ? direction : "both";

  const nodes = new Map();
  const edges = new Map();
  const rootKey = `${type}:${id}`;
  nodes.set(rootKey, { key: rootKey, type, id, depth: 0, ref: null, title: null });

  const queue = [{ key: rootKey, node: nodes.get(rootKey) }];
  let truncated = false;
  while (queue.length) {
    const { node } = queue.shift();
    if (node.depth >= depthLimit) continue;
    if (nodes.size >= nodeLimit) {
      truncated = true;
      break;
    }
    const related = [];
    if (dir === "upstream" || dir === "both") {
      const rows = queryAll(
        db,
        "SELECT * FROM dc_lineage WHERE tenant_id = ? AND status = 'active' AND to_type = ? AND to_id = ? ORDER BY id LIMIT ?",
        [Number(tenantId), node.type, node.id, nodeLimit]
      );
      for (const row of rows) related.push({ row, other: { type: row.from_type, id: row.from_id, ref: row.from_ref }, outgoing: false });
    }
    if (dir === "downstream" || dir === "both") {
      const rows = queryAll(
        db,
        "SELECT * FROM dc_lineage WHERE tenant_id = ? AND status = 'active' AND from_type = ? AND from_id = ? ORDER BY id LIMIT ?",
        [Number(tenantId), node.type, node.id, nodeLimit]
      );
      for (const row of rows) related.push({ row, other: { type: row.to_type, id: row.to_id, ref: row.to_ref }, outgoing: true });
    }
    for (const item of related) {
      const key = `${item.other.type}:${item.other.id}`;
      edges.set(item.row.id, publicLineage(item.row));
      if (!nodes.has(key)) {
        if (nodes.size >= nodeLimit) {
          truncated = true;
          continue;
        }
        const child = { key, type: item.other.type, id: item.other.id, depth: node.depth + 1, ref: item.other.ref || null, title: null };
        nodes.set(key, child);
        queue.push({ key, node: child });
      }
    }
  }

  const nodeList = [...nodes.values()].map((node) => ({ ...node, ...describeEndpoint(db, tenantId, node.type, node.id, node.ref) }));
  const edgeList = [...edges.values()];
  if (truncated) edgeList.push({ truncated: true, reason: "limit_reached", node_limit: nodeLimit, depth_limit: depthLimit });
  return {
    root: { type, id, key: rootKey, ...describeEndpoint(db, tenantId, type, id, null) },
    direction: dir,
    max_depth: depthLimit,
    node_limit: nodeLimit,
    truncated,
    nodes: nodeList,
    edges: edgeList,
  };
}

// Enriches a lineage endpoint with its catalog entry title when available.
function describeEndpoint(db, tenantId, type, id, ref) {
  if (!ENTRY_ENDPOINT_TYPES.has(type)) return {};
  const numeric = Number(id);
  const entryRow = Number.isInteger(numeric) && String(numeric) === String(id).trim()
    ? queryOne(db, "SELECT entry_ref, name, display_name, status FROM dc_entries WHERE id = ? AND tenant_id = ?", [numeric, Number(tenantId)])
    : queryOne(db, "SELECT entry_ref, name, display_name, status FROM dc_entries WHERE entry_ref = ? AND tenant_id = ?", [String(ref || id), Number(tenantId)]);
  if (!entryRow) return {};
  return { entry_ref: entryRow.entry_ref, title: entryRow.display_name || entryRow.name || entryRow.entry_ref, status: entryRow.status };
}

export function upstream(db, options) {
  return lineageGraph(db, { ...options, direction: "upstream" });
}

export function downstream(db, options) {
  return lineageGraph(db, { ...options, direction: "downstream" });
}

// Impact analysis: which consumers are reachable downstream from a root.
export function impact(db, options = {}) {
  const graph = lineageGraph(db, { ...options, direction: "downstream" });
  const consumers = graph.nodes.filter((node) => node.type === "CONSUMER");
  const objects = graph.nodes.filter((node) => node.type === "OBJECT" || node.type === "ATTRIBUTE");
  return { root: graph.root, truncated: graph.truncated, depth: graph.max_depth, consumer_count: consumers.length, object_count: objects.length, consumers, objects };
}

export function assertWithinLimits() {
  // Reserved for callers that need to validate limits before a write.
  return true;
}

export { lineageTooLarge };
