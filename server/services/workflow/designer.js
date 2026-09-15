import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { assertReadable, assertMutable } from "../metadata/scope.js";
import { publicGraph, validateGraph, assertValidGraph, autoLayout, slugifyKey, assertNodeType } from "./validation.js";
import {
  getNodeRow,
  getTransitionRow,
  insertNode,
  updateNode,
  deleteNode,
  insertTransition,
  updateTransition,
  deleteTransition,
  readGraph,
  readNodes,
  readTransitions,
  replaceGraph,
  findNodeByKey,
} from "./graph.js";
import { getDefinitionRow, publicDefinition, publicVersion } from "./templates.js";

// The designer works on a single *draft* version. Published versions are
// immutable snapshots, so every mutation rejects them.

function draftVersionRow(db, definitionId, versionRef) {
  if (versionRef !== undefined && versionRef !== null && versionRef !== "") {
    const row = /^\d+$/.test(String(versionRef))
      ? queryOne(db, "SELECT * FROM workflow_versions WHERE id = ? AND definition_id = ?", [Number(versionRef), Number(definitionId)]) ||
        queryOne(db, "SELECT * FROM workflow_versions WHERE definition_id = ? AND version = ?", [Number(definitionId), Number(versionRef)])
      : queryOne(db, "SELECT * FROM workflow_versions WHERE definition_id = ? AND status = ? ORDER BY version DESC LIMIT 1", [
          Number(definitionId),
          String(versionRef),
        ]);
    if (!row) throw new HttpError(404, "Workflow version not found");
    return row;
  }
  return (
    queryOne(db, "SELECT * FROM workflow_versions WHERE definition_id = ? AND status = 'draft' ORDER BY version DESC LIMIT 1", [
      Number(definitionId),
    ]) ||
    queryOne(db, "SELECT * FROM workflow_versions WHERE definition_id = ? ORDER BY version DESC LIMIT 1", [Number(definitionId)])
  );
}

function assertDraft(db, versionRow) {
  if (!versionRow) throw new HttpError(404, "Workflow version not found");
  if (versionRow.status !== "draft") {
    throw new HttpError(409, "Published workflow versions are immutable; create a new draft version to edit");
  }
  return versionRow;
}

export function designerContext(db, definitionId, tenantId, query = {}) {
  const definition = getDefinitionRow(db, definitionId);
  assertReadable(definition, tenantId, "Workflow template not found");
  const versionRow = draftVersionRow(db, definition.id, query.version ?? query.versionId);
  if (!versionRow) throw new HttpError(404, "Workflow version not found");
  const graph = readGraph(db, versionRow.id);
  return {
    definition: publicDefinition(definition),
    version: publicVersion(versionRow),
    editable: versionRow.status === "draft",
    graph,
    validation: validateGraph(graph),
  };
}

export function saveDesignerGraph(db, definitionId, body = {}, actor = null, ip = null, tenantId = null) {
  const definition = getDefinitionRow(db, definitionId);
  assertMutable(db, definition, tenantId, actor, "Workflow template not found");
  const versionRow = assertDraft(db, draftVersionRow(db, definition.id, body.version_id ?? body.versionId ?? body.version));
  const graph = body.graph || { nodes: body.nodes, transitions: body.transitions ?? body.edges };
  const validation = assertValidGraph(graph);
  transaction(db, () => {
    replaceGraph(db, versionRow.id, graph);
  });
  writeAudit(db, {
    actor,
    action: "workflow.designer.save",
    resourceType: "workflow_definition",
    resourceId: definition.id,
    details: { version: versionRow.version, nodes: validation.stats.nodes, transitions: validation.stats.transitions },
    ip,
  });
  return designerContext(db, definition.id, tenantId, { version: versionRow.version });
}

export function addNode(db, definitionId, body = {}, actor = null, ip = null, tenantId = null) {
  const definition = getDefinitionRow(db, definitionId);
  assertMutable(db, definition, tenantId, actor, "Workflow template not found");
  const versionRow = assertDraft(db, draftVersionRow(db, definition.id, body.version_id ?? body.versionId ?? body.version));
  assertNodeType(body.type);
  let nodeKey = body.node_key || body.key;
  if (!nodeKey) {
    nodeKey = slugifyKey(body.type, body.name, `node-${Date.now()}`);
    let suffix = 1;
    while (findNodeByKey(db, versionRow.id, nodeKey)) {
      nodeKey = `${slugifyKey(body.type, body.name, `node-${Date.now()}`)}-${suffix++}`;
    }
  }
  const node = insertNode(db, versionRow.id, { ...body, node_key: nodeKey });
  writeAudit(db, { actor, action: "workflow.designer.node.create", resourceType: "workflow_definition", resourceId: definition.id, details: { node_key: nodeKey }, ip });
  return node;
}

export function patchNode(db, definitionId, nodeId, body = {}, actor = null, ip = null, tenantId = null) {
  const definition = getDefinitionRow(db, definitionId);
  assertMutable(db, definition, tenantId, actor, "Workflow template not found");
  const row = getNodeRow(db, nodeId);
  if (!row) throw new HttpError(404, "Workflow node not found");
  const versionRow = assertDraft(db, draftVersionRow(db, definition.id, row.version_id));
  if (body.key || body.node_key) {
    const key = body.key || body.node_key;
    const existing = findNodeByKey(db, versionRow.id, key);
    if (existing && existing.id !== row.id) throw new HttpError(409, `Node key "${key}" already exists in this version`);
  }
  const node = updateNode(db, row.id, body);
  writeAudit(db, { actor, action: "workflow.designer.node.update", resourceType: "workflow_definition", resourceId: definition.id, details: { node_key: node.node_key }, ip });
  return node;
}

export function removeNode(db, definitionId, nodeId, actor = null, ip = null, tenantId = null) {
  const definition = getDefinitionRow(db, definitionId);
  assertMutable(db, definition, tenantId, actor, "Workflow template not found");
  const row = getNodeRow(db, nodeId);
  if (!row) throw new HttpError(404, "Workflow node not found");
  assertDraft(db, draftVersionRow(db, definition.id, row.version_id));
  deleteNode(db, row.id);
  writeAudit(db, { actor, action: "workflow.designer.node.delete", resourceType: "workflow_definition", resourceId: definition.id, details: { node_key: row.node_key }, ip });
  return { deleted: true, id: row.id };
}

export function addTransition(db, definitionId, body = {}, actor = null, ip = null, tenantId = null) {
  const definition = getDefinitionRow(db, definitionId);
  assertMutable(db, definition, tenantId, actor, "Workflow template not found");
  let versionRow;
  if (body.from_node_id || body.fromNodeId || body.from) {
    const fromRow = getNodeRow(db, body.from_node_id ?? body.fromNodeId ?? body.from);
    if (!fromRow) throw new HttpError(400, "Transition source node not found");
    versionRow = assertDraft(db, draftVersionRow(db, definition.id, fromRow.version_id));
  } else {
    versionRow = assertDraft(db, draftVersionRow(db, definition.id, body.version_id ?? body.versionId ?? body.version));
  }
  const edge = insertTransition(db, versionRow.id, body);
  writeAudit(db, { actor, action: "workflow.designer.transition.create", resourceType: "workflow_definition", resourceId: definition.id, details: { transition_key: edge.transition_key }, ip });
  return edge;
}

export function patchTransition(db, definitionId, transitionId, body = {}, actor = null, ip = null, tenantId = null) {
  const definition = getDefinitionRow(db, definitionId);
  assertMutable(db, definition, tenantId, actor, "Workflow template not found");
  const row = getTransitionRow(db, transitionId);
  if (!row) throw new HttpError(404, "Workflow transition not found");
  assertDraft(db, draftVersionRow(db, definition.id, row.version_id));
  const edge = updateTransition(db, row.id, body);
  writeAudit(db, { actor, action: "workflow.designer.transition.update", resourceType: "workflow_definition", resourceId: definition.id, details: { transition_key: edge.transition_key }, ip });
  return edge;
}

export function removeTransition(db, definitionId, transitionId, actor = null, ip = null, tenantId = null) {
  const definition = getDefinitionRow(db, definitionId);
  assertMutable(db, definition, tenantId, actor, "Workflow template not found");
  const row = getTransitionRow(db, transitionId);
  if (!row) throw new HttpError(404, "Workflow transition not found");
  assertDraft(db, draftVersionRow(db, definition.id, row.version_id));
  deleteTransition(db, row.id);
  writeAudit(db, { actor, action: "workflow.designer.transition.delete", resourceType: "workflow_definition", resourceId: definition.id, details: { transition_key: row.transition_key }, ip });
  return { deleted: true, id: row.id };
}

export function applyAutoLayout(db, definitionId, body = {}, actor = null, ip = null, tenantId = null) {
  const definition = getDefinitionRow(db, definitionId);
  assertMutable(db, definition, tenantId, actor, "Workflow template not found");
  const versionRow = assertDraft(db, draftVersionRow(db, definition.id, body.version_id ?? body.versionId ?? body.version));
  const nodes = readNodes(db, versionRow.id);
  const transitions = readTransitions(db, versionRow.id);
  const positions = autoLayout(nodes, transitions, body.options || {});
  transaction(db, () => {
    for (const position of positions) {
      run(db, "UPDATE workflow_nodes SET position_x = ?, position_y = ?, updated_at = ? WHERE id = ?", [
        position.position_x,
        position.position_y,
        nowIso(),
        position.id,
      ]);
    }
  });
  writeAudit(db, { actor, action: "workflow.designer.auto_layout", resourceType: "workflow_definition", resourceId: definition.id, details: { nodes: positions.length }, ip });
  return designerContext(db, definition.id, tenantId, { version: versionRow.version });
}

export function validateDesignerGraph(db, definitionId, body = {}, tenantId = null) {
  const definition = getDefinitionRow(db, definitionId);
  assertReadable(definition, tenantId, "Workflow template not found");
  let graph;
  if (body.graph || body.nodes) {
    graph = body.graph || { nodes: body.nodes, transitions: body.transitions ?? body.edges };
    // Validate the in-memory graph for live designer feedback.
    return { definition: publicDefinition(definition), validation: validateGraph(graph), graph: publicGraphFromInput(graph) };
  }
  const versionRow = draftVersionRow(db, definition.id, body.version_id ?? body.versionId ?? body.version);
  graph = readGraph(db, versionRow.id);
  return { definition: publicDefinition(definition), version: publicVersion(versionRow), graph, validation: validateGraph(graph) };
}

// Normalises an arbitrary client graph into the public shape without ids.
function publicGraphFromInput(graph) {
  const nodes = (graph.nodes || []).map((node, index) => ({
    id: node.id ?? `tmp-${index}`,
    node_key: node.node_key || node.key || `node-${index}`,
    type: node.type,
    name: node.name || "",
    description: node.description || "",
    config: node.config || {},
    position_x: node.position_x ?? node.x ?? 0,
    position_y: node.position_y ?? node.y ?? 0,
    display_order: node.display_order ?? index,
  }));
  const lookup = new Map();
  (graph.nodes || []).forEach((node, index) => {
    lookup.set(node.id, nodes[index].id);
    if (node.node_key) lookup.set(node.node_key, nodes[index].id);
    if (node.key) lookup.set(node.key, nodes[index].id);
  });
  const transitions = (graph.transitions || graph.edges || []).map((edge, index) => ({
    id: edge.id ?? `tmp-e-${index}`,
    transition_key: edge.transition_key || edge.key || `edge-${index}`,
    from_node_id: lookup.get(edge.from_node_id ?? edge.from ?? edge.from_node_key) ?? edge.from_node_id ?? null,
    to_node_id: lookup.get(edge.to_node_id ?? edge.to ?? edge.to_node_key) ?? edge.to_node_id ?? null,
    name: edge.name || "",
    condition: edge.condition || {},
    is_default: Boolean(edge.is_default ?? edge.default),
    display_order: edge.display_order ?? index,
  }));
  return { nodes, transitions };
}

export { readGraph, readNodes, readTransitions };
