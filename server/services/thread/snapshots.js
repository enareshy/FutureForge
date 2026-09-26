// Digital thread snapshots.
//
// A snapshot materialises a traversal at a point in time: the exact node set,
// revision/effectivity/configuration context and edges. Once frozen it is
// immutable and becomes the unit of comparison and baselining. Snapshots never
// duplicate source business objects; they store the projection only.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { publicSnapshot, publicSnapshotNode, publicSnapshotEdge, parseJson } from "./repository.js";
import { snapshotRef, threadId } from "./identifiers.js";
import { recordChange } from "./history.js";
import { publishThreadEvent, threadEventCode } from "./events.js";
import { executeTraversal } from "./engine.js";
import { snapshotNotFound, invalidSnapshot, snapshotImmutable } from "./errors.js";
import { normalizeText, normalizeList, paginate } from "./validation.js";
import { bumpEpoch } from "./cache.js";

export function getSnapshotRow(db, tenantId, ref) {
  const text = String(ref ?? "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return queryOne(db, "SELECT * FROM thread_snapshots WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(text)]);
  return queryOne(db, "SELECT * FROM thread_snapshots WHERE tenant_id = ? AND snapshot_ref = ?", [Number(tenantId), text]);
}

export function requireSnapshotRow(db, tenantId, ref) {
  const row = getSnapshotRow(db, tenantId, ref);
  if (!row) throw snapshotNotFound(ref);
  return row;
}

export function snapshotNodes(db, snapshotId) {
  return queryAll(db, "SELECT * FROM thread_snapshot_nodes WHERE snapshot_id = ? ORDER BY depth, id", [Number(snapshotId)]).map(publicSnapshotNode);
}

export function snapshotEdges(db, snapshotId) {
  return queryAll(db, "SELECT * FROM thread_snapshot_edges WHERE snapshot_id = ? ORDER BY id", [Number(snapshotId)]).map(publicSnapshotEdge);
}

export function getSnapshot(db, tenantId, ref, { includeNodes = false, includeEdges = false } = {}) {
  const row = requireSnapshotRow(db, tenantId, ref);
  const snapshot = publicSnapshot(row);
  if (includeNodes) snapshot.nodes = snapshotNodes(db, row.id);
  if (includeEdges) snapshot.edges = snapshotEdges(db, row.id);
  return snapshot;
}

export function listSnapshots(db, tenantId, query = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.definition_code || query.definitionCode) {
    clauses.push("definition_code = ?");
    params.push(normalizeText(query.definition_code || query.definitionCode, { max: 64 }));
  }
  if (query.status) {
    clauses.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.root_object_id || query.rootObjectId) {
    clauses.push("root_object_id = ?");
    params.push(String(query.root_object_id || query.rootObjectId));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page } = paginate(query, { defaultPageSize: 50, maxPageSize: 200 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM thread_snapshots ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM thread_snapshots ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicSnapshot), total, page, page_size: limit, source_module: "thread" };
}

// Persists an already-computed traversal as a frozen snapshot. Shared with the
// baseline and job handlers so materialisation logic lives in one place.
export function persistSnapshot(db, tenantId, { result, definition, body = {}, actor = null }) {
  const tenant = Number(tenantId);
  const ts = nowIso();
  const name = normalizeText(body.name, { max: 200 }) || `${result.root?.display_name || result.root?.node_ref} snapshot`;
  const insert = run(
    db,
    `INSERT INTO thread_snapshots
       (snapshot_ref, tenant_id, organization_id, thread_id, name, description, definition_code, root_object_type, root_object_id, root_revision,
        direction, query_context_json, revision_context_json, effectivity_context_json, configuration_context_json, status, immutable, node_count, edge_count,
        truncated, consistency, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'FROZEN', 1, ?, ?, ?, ?, ?, ?)`,
    [
      snapshotRef(name),
      tenant,
      body.organization_id != null ? Number(body.organization_id) : (result.root?.organization_id ?? null),
      normalizeText(body.thread_id, { max: 120 }) || threadId(),
      name,
      normalizeText(body.description, { max: 2000 }),
      definition?.code || normalizeText(body.definition_code, { max: 64 }),
      result.root?.object_type || "",
      String(result.root?.object_id || ""),
      result.root?.revision || "",
      result.direction || "DOWNSTREAM",
      JSON.stringify({ direction: result.direction, max_depth: result.max_depth, include_domains: normalizeList(body.includeDomains) }),
      JSON.stringify({ revision: body.revision || "" }),
      JSON.stringify({ as_of: body.asOf || "", serial_number: body.serialNumber || "" }),
      JSON.stringify({ variant: body.variant || "", configuration: body.configuration || "" }),
      result.node_count,
      result.edge_count,
      result.truncated ? 1 : 0,
      "CURRENT",
      actor?.id ?? null,
      ts,
    ]
  );
  const snapshotId = Number(insert.lastInsertRowid);
  for (const node of result.nodes) {
    run(
      db,
      `INSERT INTO thread_snapshot_nodes
         (snapshot_id, node_ref, source_object_type, source_object_id, source_object_revision_id, domain, display_name, number, revision, lifecycle_state, organization_id, site, node_type, depth, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshotId,
        node.node_ref,
        node.object_type,
        String(node.object_id),
        node.source_object_revision_id || "",
        node.domain || "",
        node.display_name || "",
        node.number || "",
        node.revision || "",
        node.lifecycle_state || "",
        node.organization_id ?? null,
        node.site || "",
        node.node_type || "",
        Number(node.depth || 0),
        JSON.stringify(node.metadata || {}),
      ]
    );
  }
  for (const edge of result.edges) {
    run(
      db,
      `INSERT INTO thread_snapshot_edges
         (snapshot_id, edge_ref, source_node_ref, target_node_ref, relationship_type, relationship_id, relationship_direction, source_revision, target_revision,
          effectivity_json, configuration_json, lifecycle_context, confidence, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        snapshotId,
        edge.edge_ref || `E-${snapshotId}-${Math.random().toString(36).slice(2, 10)}`,
        edge.source_node_ref,
        edge.target_node_ref,
        edge.relationship_type || "",
        String(edge.relationship_id || ""),
        edge.relationship_direction || "OUT",
        edge.source_revision || "",
        edge.target_revision || "",
        JSON.stringify(edge.effectivity || {}),
        JSON.stringify(edge.configuration || {}),
        edge.lifecycle_context || "",
        edge.confidence === null || edge.confidence === undefined ? null : Number(edge.confidence),
        JSON.stringify(edge.metadata || {}),
      ]
    );
  }
  bumpEpoch(tenant);
  return getSnapshot(db, tenant, snapshotId);
}

export function createSnapshot(db, tenantId, body = {}, actor = null, ip = null) {
  if (!body.root) throw invalidSnapshot("A snapshot needs a root object");
  const { result, definition } = executeTraversal(
    db,
    tenantId,
    {
      ...body,
      root: body.root,
      direction: body.direction,
      maxDepth: body.max_depth ?? body.maxDepth,
      maxNodes: body.max_nodes ?? body.maxNodes,
      includeDomains: body.include_domains || body.includeDomains,
      excludeDomains: body.exclude_domains || body.excludeDomains,
      includeInactive: body.include_inactive ?? body.includeInactive,
      allowCrossDomain: body.allow_cross_domain ?? body.allowCrossDomain,
      definitionCode: body.definition_code ?? body.definitionCode,
      definitionId: body.definition_id ?? body.definitionId,
      revision: body.revision,
      asOf: body.as_of ?? body.asOf,
      serialNumber: body.serial_number ?? body.serialNumber,
      variant: body.variant,
      configuration: body.configuration,
      organizationId: body.organization_id ?? body.organizationId ?? null,
      ip,
    },
    actor,
    { action: "SNAPSHOT", record: false, publish: false }
  );
  const snapshot = persistSnapshot(db, tenantId, { result, definition, body, actor });
  recordChange(db, {
    tenantId: Number(tenantId),
    entityType: "SNAPSHOT",
    entityId: snapshot.id,
    entityRef: snapshot.snapshot_ref,
    action: "CREATED",
    status: snapshot.status,
    after: { snapshot_ref: snapshot.snapshot_ref, node_count: snapshot.node_count, edge_count: snapshot.edge_count },
    summary: `Snapshot ${snapshot.snapshot_ref} frozen (${snapshot.node_count} nodes)`,
    actor,
    ip,
  });
  publishThreadEvent(
    db,
    { eventType: threadEventCode("SNAPSHOT_CREATED"), objectType: "thread_snapshot", objectId: snapshot.id, tenantId: Number(tenantId), payload: { snapshot_ref: snapshot.snapshot_ref, node_count: snapshot.node_count } },
    actor
  );
  return { ...snapshot, nodes: snapshotNodes(db, snapshot.id), edges: snapshotEdges(db, snapshot.id) };
}

export function snapshotGraph(db, tenantId, ref) {
  const row = requireSnapshotRow(db, tenantId, ref);
  return {
    snapshot: publicSnapshot(row),
    nodes: snapshotNodes(db, row.id),
    edges: snapshotEdges(db, row.id),
    source_module: "thread",
  };
}

export function setSnapshotStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const row = requireSnapshotRow(db, tenantId, ref);
  const normalized = String(status || "").toUpperCase();
  if (!["DRAFT", "FROZEN", "ARCHIVED"].includes(normalized)) throw invalidSnapshot(`Unknown snapshot status: ${status}`);
  if (row.immutable === 1 && !["FROZEN", "ARCHIVED"].includes(normalized)) throw snapshotImmutable(row.snapshot_ref);
  run(db, "UPDATE thread_snapshots SET status = ? WHERE id = ?", [normalized, row.id]);
  bumpEpoch(Number(tenantId));
  recordChange(db, { tenantId: Number(tenantId), entityType: "SNAPSHOT", entityId: row.id, entityRef: row.snapshot_ref, action: "STATUS_CHANGED", status: normalized, summary: `Snapshot ${row.snapshot_ref} ${normalized}`, actor, ip });
  return getSnapshot(db, tenantId, row.id);
}

export function deleteSnapshot(db, tenantId, ref, actor = null, ip = null) {
  const row = requireSnapshotRow(db, tenantId, ref);
  if (row.immutable === 1) {
    setSnapshotStatus(db, tenantId, row.id, "ARCHIVED", actor, ip);
    return { archived: true, id: row.id, snapshot_ref: row.snapshot_ref };
  }
  run(db, "DELETE FROM thread_snapshots WHERE id = ?", [row.id]);
  bumpEpoch(Number(tenantId));
  return { deleted: true, id: row.id, snapshot_ref: row.snapshot_ref };
}

export function snapshotSummary(db, tenantId) {
  const rows = queryAll(db, "SELECT status, COUNT(*) AS c, COALESCE(SUM(node_count),0) AS nodes FROM thread_snapshots WHERE tenant_id = ? GROUP BY status", [Number(tenantId)]);
  return {
    total: rows.reduce((sum, row) => sum + Number(row.c), 0),
    total_nodes: rows.reduce((sum, row) => sum + Number(row.nodes), 0),
    by_status: Object.fromEntries(rows.map((row) => [row.status, Number(row.c)])),
  };
}

export { parseJson };
