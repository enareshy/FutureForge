// Requirement relationships service.
//
// Relationships are stored in the domain's own generic edge table with
// source_type/target_type, so a Requirement can link to any future enterprise
// object (PDM item, PLM change, MES operation, SLM asset) without a schema
// change. PARENT_OF / CHILD_OF edges are the requirement hierarchy and are
// kept consistent with the `requirements.parent_id` column, with cycle
// prevention on every write.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { publicRelationship } from "./repository.js";
import { relationshipRef } from "./refs.js";
import { normalizeRelationshipInput, paginate } from "./validation.js";
import { relationshipNotFound, relationshipConflict, invalidRelationship, hierarchyCycle } from "./errors.js";
import { SOURCE_MODULE, HIERARCHY_RELATIONSHIPS } from "./constants.js";
import { requireRequirementRow, requireRequirementRowAsync } from "./requirements.js";
import { recordRequirementHistory, recordRequirementHistoryAsync } from "./history.js";
import { publishRequirementEvent, publishRequirementEventAsync } from "./events.js";

function relationshipFilters({ tenantId, relationship_type, source_type, source_id, target_type, target_id } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (relationship_type) {
    clauses.push("relationship_type = ?");
    params.push(String(relationship_type).toUpperCase());
  }
  if (source_type) {
    clauses.push("source_type = ?");
    params.push(String(source_type));
  }
  if (source_id) {
    clauses.push("source_id = ?");
    params.push(String(source_id));
  }
  if (target_type) {
    clauses.push("target_type = ?");
    params.push(String(target_type));
  }
  if (target_id) {
    clauses.push("target_id = ?");
    params.push(String(target_id));
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listRelationships(db, opts = {}) {
  const { where, params } = relationshipFilters(opts);
  const { limit, offset, page: currentPage } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM requirement_relationships ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM requirement_relationships ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicRelationship), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export async function listRelationshipsAsync(db, opts = {}) {
  const { where, params } = relationshipFilters(opts);
  const { limit, offset, page: currentPage } = paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number((await queryOneAsync(db, `SELECT COUNT(*) AS c FROM requirement_relationships ${where}`, params))?.c || 0);
  const rows = await queryAllAsync(db, `SELECT * FROM requirement_relationships ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicRelationship), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function getRelationshipRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM requirement_relationships WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOne(db, "SELECT * FROM requirement_relationships WHERE tenant_id = ? AND relationship_ref = ?", [Number(tenantId), String(ref)]);
}

export async function getRelationshipRowAsync(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM requirement_relationships WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
  }
  return queryOneAsync(db, "SELECT * FROM requirement_relationships WHERE tenant_id = ? AND relationship_ref = ?", [Number(tenantId), String(ref)]);
}

export function getRelationship(db, tenantId, ref) {
  return publicRelationship(getRelationshipRow(db, tenantId, ref));
}

export async function getRelationshipAsync(db, tenantId, ref) {
  return publicRelationship(await getRelationshipRowAsync(db, tenantId, ref));
}

// Walks the parent_id chain upwards from `startId`; returns the set of ids.
function ancestorIds(db, tenantId, startId) {
  const seen = new Set();
  let cursor = startId;
  while (cursor) {
    if (seen.has(Number(cursor))) break;
    seen.add(Number(cursor));
    const parent = queryOne(db, "SELECT parent_id FROM requirements WHERE id = ? AND tenant_id = ?", [Number(cursor), Number(tenantId)]);
    cursor = parent?.parent_id ?? null;
  }
  return seen;
}

async function ancestorIdsAsync(db, tenantId, startId) {
  const seen = new Set();
  let cursor = startId;
  while (cursor) {
    if (seen.has(Number(cursor))) break;
    seen.add(Number(cursor));
    const parent = await queryOneAsync(db, "SELECT parent_id FROM requirements WHERE id = ? AND tenant_id = ?", [Number(cursor), Number(tenantId)]);
    cursor = parent?.parent_id ?? null;
  }
  return seen;
}

function hierarchyGuard(db, tenant, input) {
  const spec = HIERARCHY_RELATIONSHIPS[input.relationship_type];
  if (!spec) return null;
  const parentRef = input.relationship_type === "PARENT_OF" ? input.source_id : input.target_id;
  const childRef = input.relationship_type === "PARENT_OF" ? input.target_id : input.source_id;
  const parent = requireRequirementRow(db, tenant, parentRef);
  const child = requireRequirementRow(db, tenant, childRef);
  if (Number(parent.id) === Number(child.id)) throw hierarchyCycle({ reason: "self_parent" });
  const ancestors = ancestorIds(db, tenant, parent.id);
  if (ancestors.has(Number(child.id))) throw hierarchyCycle({ parent: parent.requirement_ref, child: child.requirement_ref });
  return { parent, child };
}

async function hierarchyGuardAsync(db, tenant, input) {
  const spec = HIERARCHY_RELATIONSHIPS[input.relationship_type];
  if (!spec) return null;
  const parentRef = input.relationship_type === "PARENT_OF" ? input.source_id : input.target_id;
  const childRef = input.relationship_type === "PARENT_OF" ? input.target_id : input.source_id;
  const parent = await requireRequirementRowAsync(db, tenant, parentRef);
  const child = await requireRequirementRowAsync(db, tenant, childRef);
  if (Number(parent.id) === Number(child.id)) throw hierarchyCycle({ reason: "self_parent" });
  const ancestors = await ancestorIdsAsync(db, tenant, parent.id);
  if (ancestors.has(Number(child.id))) throw hierarchyCycle({ parent: parent.requirement_ref, child: child.requirement_ref });
  return { parent, child };
}

export function createRelationship(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeRelationshipInput(body);
  const hierarchy = hierarchyGuard(db, tenant, input);
  const dup = queryOne(
    db,
    "SELECT id FROM requirement_relationships WHERE tenant_id = ? AND relationship_type = ? AND source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?",
    [tenant, input.relationship_type, input.source_type, input.source_id, input.target_type, input.target_id]
  );
  if (dup) throw relationshipConflict({ relationship_type: input.relationship_type });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO requirement_relationships
       (tenant_id, relationship_ref, relationship_type, source_type, source_id, target_type, target_id,
        status, effectivity_from, effectivity_to, attributes_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenant,
      relationshipRef(),
      input.relationship_type,
      input.source_type,
      input.source_id,
      input.target_type,
      input.target_id,
      input.status,
      input.effectivity_from,
      input.effectivity_to,
      JSON.stringify(input.attributes || {}),
      actor?.id ?? null,
      ts,
    ]
  );
  if (hierarchy) {
    run(db, "UPDATE requirements SET parent_id = ?, updated_by = ?, updated_at = ? WHERE id = ?", [hierarchy.parent.id, actor?.id ?? null, ts, hierarchy.child.id]);
  }
  const row = queryOne(db, "SELECT * FROM requirement_relationships WHERE id = ?", [Number(result.lastInsertId)]);
  recordRequirementHistory(db, { tenantId: tenant, entityType: "RELATIONSHIP", entityId: row.id, entityRef: row.relationship_ref, action: "RELATIONSHIP_CREATED", status: input.status, after: publicRelationship(row), details: { relationship_type: input.relationship_type }, actor, ip });
  publishRequirementEvent(db, { eventType: "RequirementRelationshipCreated", objectType: "requirement", objectId: input.source_type === "requirement" ? input.source_id : input.target_id, tenantId: tenant, payload: { relationship_type: input.relationship_type, relationship_ref: row.relationship_ref } }, actor);
  return publicRelationship(row);
}

export async function createRelationshipAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeRelationshipInput(body);
  const hierarchy = await hierarchyGuardAsync(db, tenant, input);
  const dup = await queryOneAsync(
    db,
    "SELECT id FROM requirement_relationships WHERE tenant_id = ? AND relationship_type = ? AND source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?",
    [tenant, input.relationship_type, input.source_type, input.source_id, input.target_type, input.target_id]
  );
  if (dup) throw relationshipConflict({ relationship_type: input.relationship_type });
  const ts = nowIso();
  const result = await runAsync(
    db,
    `INSERT INTO requirement_relationships
       (tenant_id, relationship_ref, relationship_type, source_type, source_id, target_type, target_id,
        status, effectivity_from, effectivity_to, attributes_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      tenant,
      relationshipRef(),
      input.relationship_type,
      input.source_type,
      input.source_id,
      input.target_type,
      input.target_id,
      input.status,
      input.effectivity_from,
      input.effectivity_to,
      JSON.stringify(input.attributes || {}),
      actor?.id ?? null,
      ts,
    ]
  );
  if (hierarchy) {
    await runAsync(db, "UPDATE requirements SET parent_id = ?, updated_by = ?, updated_at = ? WHERE id = ?", [hierarchy.parent.id, actor?.id ?? null, ts, hierarchy.child.id]);
  }
  const row = await queryOneAsync(db, "SELECT * FROM requirement_relationships WHERE id = ?", [Number(result.lastInsertId)]);
  await recordRequirementHistoryAsync(db, { tenantId: tenant, entityType: "RELATIONSHIP", entityId: row.id, entityRef: row.relationship_ref, action: "RELATIONSHIP_CREATED", status: input.status, after: publicRelationship(row), details: { relationship_type: input.relationship_type }, actor, ip });
  await publishRequirementEventAsync(db, { eventType: "RequirementRelationshipCreated", objectType: "requirement", objectId: input.source_type === "requirement" ? input.source_id : input.target_id, tenantId: tenant, payload: { relationship_type: input.relationship_type, relationship_ref: row.relationship_ref } }, actor);
  return publicRelationship(row);
}

export function deleteRelationship(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = getRelationshipRow(db, tenant, ref);
  if (!row) throw relationshipNotFound(ref);
  if (HIERARCHY_RELATIONSHIPS[row.relationship_type]) {
    const childId = row.relationship_type === "PARENT_OF" ? row.target_id : row.source_id;
    run(db, "UPDATE requirements SET parent_id = NULL, updated_by = ?, updated_at = ? WHERE tenant_id = ? AND id = ?", [actor?.id ?? null, nowIso(), tenant, Number(childId)]);
  }
  run(db, "DELETE FROM requirement_relationships WHERE id = ?", [row.id]);
  recordRequirementHistory(db, { tenantId: tenant, entityType: "RELATIONSHIP", entityId: row.id, entityRef: row.relationship_ref, action: "RELATIONSHIP_REMOVED", before: publicRelationship(row), actor, ip });
  publishRequirementEvent(db, { eventType: "RequirementRelationshipRemoved", tenantId: tenant, payload: { relationship_ref: row.relationship_ref } }, actor);
  return { deleted: true, relationship_ref: row.relationship_ref };
}

export async function deleteRelationshipAsync(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await getRelationshipRowAsync(db, tenant, ref);
  if (!row) throw relationshipNotFound(ref);
  if (HIERARCHY_RELATIONSHIPS[row.relationship_type]) {
    const childId = row.relationship_type === "PARENT_OF" ? row.target_id : row.source_id;
    await runAsync(db, "UPDATE requirements SET parent_id = NULL, updated_by = ?, updated_at = ? WHERE tenant_id = ? AND id = ?", [actor?.id ?? null, nowIso(), tenant, Number(childId)]);
  }
  await runAsync(db, "DELETE FROM requirement_relationships WHERE id = ?", [row.id]);
  await recordRequirementHistoryAsync(db, { tenantId: tenant, entityType: "RELATIONSHIP", entityId: row.id, entityRef: row.relationship_ref, action: "RELATIONSHIP_REMOVED", before: publicRelationship(row), actor, ip });
  await publishRequirementEventAsync(db, { eventType: "RequirementRelationshipRemoved", tenantId: tenant, payload: { relationship_ref: row.relationship_ref } }, actor);
  return { deleted: true, relationship_ref: row.relationship_ref };
}

// All relationships where this requirement is either endpoint.
export function relationshipsForRequirement(db, tenantId, ref) {
  const requirement = requireRequirementRow(db, tenantId, ref);
  const rows = queryAll(
    db,
    `SELECT * FROM requirement_relationships
      WHERE tenant_id = ? AND ((source_type = 'requirement' AND source_id = ?) OR (target_type = 'requirement' AND target_id = ?))
      ORDER BY id DESC`,
    [Number(tenantId), String(requirement.id), String(requirement.id)]
  );
  return { requirement_id: requirement.id, items: rows.map(publicRelationship), total: rows.length, source_module: SOURCE_MODULE };
}

export async function relationshipsForRequirementAsync(db, tenantId, ref) {
  const requirement = await requireRequirementRowAsync(db, tenantId, ref);
  const rows = await queryAllAsync(
    db,
    `SELECT * FROM requirement_relationships
      WHERE tenant_id = ? AND ((source_type = 'requirement' AND source_id = ?) OR (target_type = 'requirement' AND target_id = ?))
      ORDER BY id DESC`,
    [Number(tenantId), String(requirement.id), String(requirement.id)]
  );
  return { requirement_id: requirement.id, items: rows.map(publicRelationship), total: rows.length, source_module: SOURCE_MODULE };
}

// Breadth-first traversal of the requirement graph from a starting node.
export function traverse(db, tenantId, ref, { maxDepth = 5 } = {}) {
  const root = requireRequirementRow(db, tenantId, ref);
  const depth = Math.min(Math.max(Number(maxDepth) || 5, 1), 10);
  const visited = new Set([Number(root.id)]);
  let frontier = [String(root.id)];
  const edges = [];
  for (let level = 0; level < depth && frontier.length; level += 1) {
    const placeholders = frontier.map(() => "?").join(", ");
    const rows = queryAll(
      db,
      `SELECT * FROM requirement_relationships WHERE tenant_id = ? AND ((source_type = 'requirement' AND source_id IN (${placeholders})) OR (target_type = 'requirement' AND target_id IN (${placeholders})))`,
      [Number(tenantId), ...frontier, ...frontier]
    );
    const next = [];
    for (const row of rows) {
      edges.push({ ...publicRelationship(row), depth: level + 1 });
      const other = row.source_type === "requirement" && frontier.includes(String(row.source_id)) ? row.target_id : row.source_id;
      if (row.source_type === "requirement" && frontier.includes(String(row.source_id))) {
        if (!visited.has(Number(row.target_id))) {
          visited.add(Number(row.target_id));
          next.push(String(row.target_id));
        }
      } else if (!visited.has(Number(row.source_id))) {
        visited.add(Number(row.source_id));
        next.push(String(row.source_id));
      }
      void other;
    }
    frontier = next;
  }
  return { root: root.id, max_depth: depth, nodes: [...visited].map(Number), edges, source_module: SOURCE_MODULE };
}

export async function traverseAsync(db, tenantId, ref, { maxDepth = 5 } = {}) {
  const root = await requireRequirementRowAsync(db, tenantId, ref);
  const depth = Math.min(Math.max(Number(maxDepth) || 5, 1), 10);
  const visited = new Set([Number(root.id)]);
  let frontier = [String(root.id)];
  const edges = [];
  for (let level = 0; level < depth && frontier.length; level += 1) {
    const placeholders = frontier.map(() => "?").join(", ");
    const rows = await queryAllAsync(
      db,
      `SELECT * FROM requirement_relationships WHERE tenant_id = ? AND ((source_type = 'requirement' AND source_id IN (${placeholders})) OR (target_type = 'requirement' AND target_id IN (${placeholders})))`,
      [Number(tenantId), ...frontier, ...frontier]
    );
    const next = [];
    for (const row of rows) {
      edges.push({ ...publicRelationship(row), depth: level + 1 });
      if (row.source_type === "requirement" && frontier.includes(String(row.source_id))) {
        if (!visited.has(Number(row.target_id))) {
          visited.add(Number(row.target_id));
          next.push(String(row.target_id));
        }
      } else if (!visited.has(Number(row.source_id))) {
        visited.add(Number(row.source_id));
        next.push(String(row.source_id));
      }
    }
    frontier = next;
  }
  return { root: root.id, max_depth: depth, nodes: [...visited].map(Number), edges, source_module: SOURCE_MODULE };
}

export { invalidRelationship };
