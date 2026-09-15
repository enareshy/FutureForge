import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { jsonText, publicGraph, safeParse, slugifyKey, assertNodeType, normalizeNodeConfig } from "./validation.js";

// Persistence helpers shared by the template and designer services. All graph
// writes are scoped to a single version so published snapshots stay immutable.

export function readNodes(db, versionId) {
  return queryAll(db, "SELECT * FROM workflow_nodes WHERE version_id = ? ORDER BY display_order, id", [Number(versionId)]);
}

export function readTransitions(db, versionId) {
  return queryAll(db, "SELECT * FROM workflow_transitions WHERE version_id = ? ORDER BY display_order, id", [Number(versionId)]);
}

export function readGraph(db, versionId) {
  return publicGraph(readNodes(db, versionId), readTransitions(db, versionId));
}

export function getNodeRow(db, id) {
  return queryOne(db, "SELECT * FROM workflow_nodes WHERE id = ?", [Number(id)]);
}

export function getTransitionRow(db, id) {
  return queryOne(db, "SELECT * FROM workflow_transitions WHERE id = ?", [Number(id)]);
}

export function findNodeByKey(db, versionId, key) {
  return queryOne(db, "SELECT * FROM workflow_nodes WHERE version_id = ? AND node_key = ?", [Number(versionId), String(key)]);
}

export function nextNodeOrder(db, versionId) {
  const row = queryOne(db, "SELECT COALESCE(MAX(display_order), -1) AS m FROM workflow_nodes WHERE version_id = ?", [Number(versionId)]);
  return (row?.m ?? -1) + 1;
}

export function insertNode(db, versionId, node) {
  assertNodeType(node.type);
  const ts = nowIso();
  const nodeKey = node.node_key || node.key || slugifyKey(node.type, node.name, `node-${Date.now()}`);
  const result = run(
    db,
    `INSERT INTO workflow_nodes
      (version_id, node_key, type, name, description, config_json, position_x, position_y, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(versionId),
      nodeKey,
      node.type,
      node.name || nodeKey,
      node.description || "",
      jsonText(normalizeNodeConfig(node.type, node.config)),
      Number(node.position_x ?? node.x ?? 0) || 0,
      Number(node.position_y ?? node.y ?? 0) || 0,
      Number(node.display_order ?? nextNodeOrder(db, versionId)) || 0,
      ts,
      ts,
    ]
  );
  return getNodeRow(db, result.lastInsertRowid);
}

export function updateNode(db, id, patch) {
  const row = getNodeRow(db, id);
  if (!row) throw new HttpError(404, "Workflow node not found");
  const type = patch.type ?? row.type;
  assertNodeType(type);
  run(
    db,
    `UPDATE workflow_nodes SET
       node_key = ?, type = ?, name = ?, description = ?, config_json = ?,
       position_x = ?, position_y = ?, display_order = ?, updated_at = ?
     WHERE id = ?`,
    [
      patch.node_key ?? patch.key ?? row.node_key,
      type,
      patch.name ?? row.name,
      patch.description ?? row.description,
      patch.config === undefined ? row.config_json : jsonText(normalizeNodeConfig(type, patch.config)),
      patch.position_x === undefined && patch.x === undefined ? row.position_x : Number(patch.position_x ?? patch.x) || 0,
      patch.position_y === undefined && patch.y === undefined ? row.position_y : Number(patch.position_y ?? patch.y) || 0,
      patch.display_order === undefined ? row.display_order : Number(patch.display_order) || 0,
      nowIso(),
      row.id,
    ]
  );
  return getNodeRow(db, row.id);
}

export function deleteNode(db, id) {
  const row = getNodeRow(db, id);
  if (!row) throw new HttpError(404, "Workflow node not found");
  run(db, "DELETE FROM workflow_transitions WHERE from_node_id = ? OR to_node_id = ?", [row.id, row.id]);
  run(db, "DELETE FROM workflow_nodes WHERE id = ?", [row.id]);
  return row;
}

export function insertTransition(db, versionId, edge) {
  const from = edge.from_node_id ?? edge.fromNodeId ?? edge.from;
  const to = edge.to_node_id ?? edge.toNodeId ?? edge.to;
  const fromRow = getNodeRow(db, from);
  const toRow = getNodeRow(db, to);
  if (!fromRow || Number(fromRow.version_id) !== Number(versionId)) throw new HttpError(400, "Transition source node not found in this version");
  if (!toRow || Number(toRow.version_id) !== Number(versionId)) throw new HttpError(400, "Transition target node not found in this version");
  const ts = nowIso();
  const key = edge.transition_key || edge.key || `edge-${fromRow.node_key}-${toRow.node_key}`;
  const orderRow = queryOne(db, "SELECT COALESCE(MAX(display_order), -1) AS m FROM workflow_transitions WHERE version_id = ?", [Number(versionId)]);
  const result = run(
    db,
    `INSERT INTO workflow_transitions
      (version_id, transition_key, from_node_id, to_node_id, name, condition_json, is_default, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      Number(versionId),
      key,
      fromRow.id,
      toRow.id,
      edge.name || "",
      jsonText(edge.condition, {}),
      edge.is_default || edge.default ? 1 : 0,
      Number(edge.display_order ?? (orderRow?.m ?? -1) + 1) || 0,
      ts,
      ts,
    ]
  );
  return getTransitionRow(db, result.lastInsertRowid);
}

export function updateTransition(db, id, patch) {
  const row = getTransitionRow(db, id);
  if (!row) throw new HttpError(404, "Workflow transition not found");
  run(
    db,
    `UPDATE workflow_transitions SET
       transition_key = ?, name = ?, condition_json = ?, is_default = ?, display_order = ?, updated_at = ?
     WHERE id = ?`,
    [
      patch.transition_key ?? patch.key ?? row.transition_key,
      patch.name ?? row.name,
      patch.condition === undefined ? row.condition_json : jsonText(patch.condition, {}),
      patch.is_default === undefined && patch.default === undefined ? row.is_default : patch.is_default || patch.default ? 1 : 0,
      patch.display_order === undefined ? row.display_order : Number(patch.display_order) || 0,
      nowIso(),
      row.id,
    ]
  );
  return getTransitionRow(db, row.id);
}

export function deleteTransition(db, id) {
  const row = getTransitionRow(db, id);
  if (!row) throw new HttpError(404, "Workflow transition not found");
  run(db, "DELETE FROM workflow_transitions WHERE id = ?", [row.id]);
  return row;
}

// Replaces the entire graph of a draft version transactionally.
export function replaceGraph(db, versionId, graph = {}) {
  run(db, "DELETE FROM workflow_transitions WHERE version_id = ?", [Number(versionId)]);
  run(db, "DELETE FROM workflow_nodes WHERE version_id = ?", [Number(versionId)]);
  const keyToId = new Map();
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  for (const node of nodes) {
    const row = insertNode(db, versionId, node);
    if (node.node_key) keyToId.set(node.node_key, row.id);
    if (node.key) keyToId.set(node.key, row.id);
    if (node.id !== undefined && node.id !== null) keyToId.set(`#${node.id}`, row.id);
  }
  const transitions = Array.isArray(graph.transitions) ? graph.transitions : Array.isArray(graph.edges) ? graph.edges : [];
  for (const edge of transitions) {
    const fromKey = edge.from_node_id !== undefined ? `#${edge.from_node_id}` : edge.from_node_key ?? edge.from;
    const toKey = edge.to_node_id !== undefined ? `#${edge.to_node_id}` : edge.to_node_key ?? edge.to;
    const fromId = keyToId.get(fromKey) ?? keyToId.get(String(fromKey));
    const toId = keyToId.get(toKey) ?? keyToId.get(String(toKey));
    if (!fromId || !toId) throw new HttpError(400, `Transition references an unknown node (${edge.transition_key || edge.key || "unnamed"})`);
    insertTransition(db, versionId, { ...edge, from_node_id: fromId, to_node_id: toId });
  }
  return readGraph(db, versionId);
}

export function snapshotGraph(db, versionId) {
  const graph = readGraph(db, versionId);
  return {
    nodes: graph.nodes.map((node) => ({
      node_key: node.node_key,
      type: node.type,
      name: node.name,
      description: node.description,
      config: node.config,
      position_x: node.position_x,
      position_y: node.position_y,
      display_order: node.display_order,
    })),
    transitions: graph.transitions.map((edge) => {
      const from = graph.nodes.find((n) => n.id === edge.from_node_id);
      const to = graph.nodes.find((n) => n.id === edge.to_node_id);
      return {
        transition_key: edge.transition_key,
        from_node_key: from?.node_key ?? null,
        to_node_key: to?.node_key ?? null,
        name: edge.name,
        condition: edge.condition,
        is_default: edge.is_default,
        display_order: edge.display_order,
      };
    }),
  };
}

export function restoreSnapshot(db, versionId, snapshot) {
  const parsed = safeParse(snapshot, {});
  return replaceGraph(db, versionId, parsed);
}
