// Digital thread comparison.
//
// Compares two frozen projections (snapshot or baseline) by node identity and
// relationship key, classifying every difference. This is the engine behind
// change-impact reporting and release-to-release review.
import { recordChange } from "./history.js";
import { publishThreadEvent, threadEventCode } from "./events.js";
import { requireSnapshotRow, snapshotNodes, snapshotEdges } from "./snapshots.js";
import { requireBaselineRow, baselineMembers } from "./baselines.js";
import { compareMismatch } from "./errors.js";
import { COMPARE_RESULT_TYPES, COMPARE_RESULT_TYPE } from "./constants.js";

function edgeKeyOf(edge) {
  return `${edge.source_node_ref}|${edge.relationship_type || ""}|${edge.target_node_ref}`;
}

function parseJsonSafe(raw, fallback) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function loadSide(db, tenantId, ref, kind) {
  if (kind === "BASELINE") {
    const row = requireBaselineRow(db, tenantId, ref);
    const members = baselineMembers(db, row.id);
    return {
      kind,
      ref: row.baseline_ref,
      id: row.id,
      name: row.name,
      definition_code: row.definition_code || "",
      status: row.status,
      nodes: members.map((member) => ({
        node_ref: member.node_ref,
        object_type: member.source_object_type || "",
        object_id: member.source_object_id || "",
        domain: member.domain || "",
        display_name: member.node_ref,
        revision: member.revision || "",
        lifecycle_state: member.lifecycle_state || "",
        metadata: member.metadata || {},
      })),
      edges: [],
    };
  }
  const row = requireSnapshotRow(db, tenantId, ref);
  return {
    kind: "SNAPSHOT",
    ref: row.snapshot_ref,
    id: row.id,
    name: row.name,
    definition_code: row.definition_code || "",
    status: row.status,
    nodes: snapshotNodes(db, row.id),
    edges: snapshotEdges(db, row.id),
  };
}

function nodeChanged(before, after) {
  const changes = [];
  if (String(before.revision || "") !== String(after.revision || "")) changes.push(COMPARE_RESULT_TYPE.CHANGED_REVISION);
  if (String(before.lifecycle_state || "") !== String(after.lifecycle_state || "")) changes.push(COMPARE_RESULT_TYPE.CHANGED_NODE);
  if (String(before.domain || "") !== String(after.domain || "")) changes.push(COMPARE_RESULT_TYPE.CHANGED_NODE);
  return changes;
}

function edgeChanged(before, after) {
  const changes = [];
  const beforeEffectivity = before.effectivity ?? parseJsonSafe(before.effectivity_json, {});
  const afterEffectivity = after.effectivity ?? parseJsonSafe(after.effectivity_json, {});
  const beforeConfiguration = before.configuration ?? parseJsonSafe(before.configuration_json, {});
  const afterConfiguration = after.configuration ?? parseJsonSafe(after.configuration_json, {});
  if (JSON.stringify(beforeEffectivity) !== JSON.stringify(afterEffectivity)) changes.push(COMPARE_RESULT_TYPE.CHANGED_EFFECTIVITY);
  if (JSON.stringify(beforeConfiguration) !== JSON.stringify(afterConfiguration)) changes.push(COMPARE_RESULT_TYPE.CHANGED_CONFIGURATION);
  return changes;
}

export function compareProjections(db, tenantId, { left, right, leftKind = "SNAPSHOT", rightKind = "SNAPSHOT" } = {}, actor = null) {
  if (!left || !right) throw compareMismatch("Both left and right projections are required");
  const leftSide = loadSide(db, tenantId, left, leftKind);
  const rightSide = loadSide(db, tenantId, right, rightKind);

  const leftNodes = new Map(leftSide.nodes.map((node) => [node.node_ref, node]));
  const rightNodes = new Map(rightSide.nodes.map((node) => [node.node_ref, node]));
  const leftEdges = new Map(leftSide.edges.map((edge) => [edgeKeyOf(edge), edge]));
  const rightEdges = new Map(rightSide.edges.map((edge) => [edgeKeyOf(edge), edge]));

  const addedNodes = [];
  const removedNodes = [];
  const changedNodes = [];
  for (const [ref, node] of rightNodes) {
    if (!leftNodes.has(ref)) addedNodes.push(node);
  }
  for (const [ref, node] of leftNodes) {
    if (!rightNodes.has(ref)) {
      removedNodes.push(node);
      continue;
    }
    const after = rightNodes.get(ref);
    const changes = nodeChanged(node, after);
    if (changes.length) changedNodes.push({ node_ref: ref, before: node, after, change_types: [...new Set(changes)] });
  }

  const addedEdges = [];
  const removedEdges = [];
  const changedEdges = [];
  for (const [key, edge] of rightEdges) {
    if (!leftEdges.has(key)) addedEdges.push(edge);
  }
  for (const [key, edge] of leftEdges) {
    if (!rightEdges.has(key)) {
      removedEdges.push(edge);
      continue;
    }
    const after = rightEdges.get(key);
    const changes = edgeChanged(edge, after);
    if (changes.length) changedEdges.push({ key, before: edge, after, change_types: [...new Set(changes)] });
  }

  const summary = {};
  for (const type of COMPARE_RESULT_TYPES) summary[type] = 0;
  summary[COMPARE_RESULT_TYPE.ADDED_NODE] = addedNodes.length;
  summary[COMPARE_RESULT_TYPE.REMOVED_NODE] = removedNodes.length;
  for (const change of changedNodes) for (const type of change.change_types) summary[type] += 1;
  summary[COMPARE_RESULT_TYPE.ADDED_RELATIONSHIP] = addedEdges.length;
  summary[COMPARE_RESULT_TYPE.REMOVED_RELATIONSHIP] = removedEdges.length;
  for (const change of changedEdges) for (const type of change.change_types) summary[type] += 1;
  const total = Object.values(summary).reduce((sum, value) => sum + value, 0);

  recordChange(db, {
    tenantId: Number(tenantId),
    entityType: "COMPARISON",
    entityId: `${leftSide.id}:${rightSide.id}`,
    entityRef: `${leftSide.ref}..${rightSide.ref}`,
    action: "COMPARED",
    summary: `Compared ${leftSide.ref} with ${rightSide.ref}`,
    details: { summary },
    actor,
  });
  publishThreadEvent(
    db,
    { eventType: threadEventCode("COMPARE_RUN"), objectType: "thread_comparison", objectId: null, tenantId: Number(tenantId), payload: { left: leftSide.ref, right: rightSide.ref, changes: total } },
    actor
  );

  return {
    left: { kind: leftSide.kind, ref: leftSide.ref, id: leftSide.id, name: leftSide.name, status: leftSide.status, node_count: leftSide.nodes.length, edge_count: leftSide.edges.length },
    right: { kind: rightSide.kind, ref: rightSide.ref, id: rightSide.id, name: rightSide.name, status: rightSide.status, node_count: rightSide.nodes.length, edge_count: rightSide.edges.length },
    identical: total === 0,
    change_count: total,
    summary,
    added_nodes: addedNodes,
    removed_nodes: removedNodes,
    changed_nodes: changedNodes,
    added_relationships: addedEdges,
    removed_relationships: removedEdges,
    changed_relationships: changedEdges,
    source_module: "thread",
  };
}

export function compareSnapshots(db, tenantId, options = {}, actor = null) {
  return compareProjections(db, tenantId, { left: options.left ?? options.left_snapshot, right: options.right ?? options.right_snapshot, leftKind: "SNAPSHOT", rightKind: "SNAPSHOT" }, actor);
}

export function compareBaselines(db, tenantId, options = {}, actor = null) {
  return compareProjections(db, tenantId, { left: options.left ?? options.left_baseline, right: options.right ?? options.right_baseline, leftKind: "BASELINE", rightKind: "BASELINE" }, actor);
}
