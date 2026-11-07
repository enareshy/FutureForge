// Digital Thread projection for Change Management artifacts.
//
// Change requests/orders/notices are the platform's own system of record and
// are not projected by the built-in thread providers. This module resolves them
// as read-only thread nodes so a requirement -> change edge can be traversed
// without copying or duplicating any Change Management data (mirrors the
// dataset resolution in provider.js).
import { queryAll } from "../../db.js";
import { queryAllAsync } from "../../db-async.js";
import { nodeRef } from "../thread/providers.js";
import { CHANGE_TARGET_SOURCES, CHANGE_NODE_CODES, CHANGE_NODE_TYPES } from "./constants.js";

const CHANGE_TYPE_SET = new Set(CHANGE_NODE_CODES);

function marks(count) {
  return count.map(() => "?").join(",");
}

function isChangeNode(type) {
  return CHANGE_TYPE_SET.has(String(type || "").toLowerCase());
}

export function isChangeType(type) {
  return isChangeNode(type);
}

function groupChangeRefs(refs) {
  const byType = new Map();
  for (const ref of refs) {
    const type = String(ref?.objectType || "").toLowerCase();
    if (!isChangeNode(type) || !/^\d+$/.test(String(ref.objectId))) continue;
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type).add(Number(ref.objectId));
  }
  return byType;
}

export function changeNode(row, type) {
  const source = CHANGE_TARGET_SOURCES[type];
  const parentId = source?.parent_column ? row[source.parent_column] : null;
  return {
    node_ref: nodeRef(type, row.id),
    object_type: type,
    object_id: String(row.id),
    source_object_type: type,
    source_object_id: String(row.id),
    source_object_revision_id: "",
    domain: "CHANGE",
    display_name: row.title || row[source?.number_column] || "",
    number: row[source?.number_column] || "",
    revision: "",
    lifecycle_state: row[source?.status_column] || row.lifecycle_state || "",
    organization_id: row.organization_id ?? null,
    site: "",
    node_type: type,
    metadata: {
      change_type: type,
      ref: row[source?.ref_column] || "",
      status: row[source?.status_column] || "",
      parent_id: parentId ?? null,
      object_id: row.object_id ?? null,
    },
  };
}

export function resolveChangeNodes(db, tenantId, refs) {
  const byType = groupChangeRefs(refs);
  if (!byType.size) return [];
  const nodes = [];
  for (const [type, ids] of byType) {
    const source = CHANGE_TARGET_SOURCES[type];
    const list = [...ids];
    const rows = queryAll(db, `SELECT * FROM ${source.table} WHERE tenant_id = ? AND id IN (${marks(list)})`, [Number(tenantId), ...list]);
    for (const row of rows) nodes.push(changeNode(row, type));
  }
  return nodes;
}

export async function resolveChangeNodesAsync(db, tenantId, refs) {
  const byType = groupChangeRefs(refs);
  if (!byType.size) return [];
  const nodes = [];
  for (const [type, ids] of byType) {
    const source = CHANGE_TARGET_SOURCES[type];
    const list = [...ids];
    const rows = await queryAllAsync(db, `SELECT * FROM ${source.table} WHERE tenant_id = ? AND id IN (${marks(list)})`, [Number(tenantId), ...list]);
    for (const row of rows) nodes.push(changeNode(row, type));
  }
  return nodes;
}

// Maps change target ids to their semantic domain for edge classification.
export function changeDomains(db, tenantId, relationships) {
  const byType = new Map();
  for (const relationship of relationships) {
    const type = String(relationship.target_type || "").toLowerCase();
    if (!isChangeNode(type)) continue;
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type).add(Number(relationship.target_id));
  }
  const domains = new Map();
  for (const [type, ids] of byType) {
    for (const id of ids) domains.set(`${type}:${id}`, "CHANGE");
  }
  return domains;
}
