// Typed polymorphic edges between Change Management objects (ECR->ECO,
// ECO->ECN, ECO->affected object). Mirrors the source_type/source_id/
// target_type/target_id convention used by server/services/pdm/relationships.js.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { publicRelationship } from "./repository.js";
import { relationshipRef } from "./refs.js";
import { normalizeRelationshipInput } from "./validation.js";
import { relationshipNotFound } from "./errors.js";
import { SOURCE_MODULE } from "./constants.js";

function relationshipLookupValue(ref) {
  const id = Number(ref);
  return Number.isInteger(id) ? { column: "id", value: id } : { column: "relationship_ref", value: String(ref) };
}

function relationshipFilters({ tenantId, sourceType, sourceId, targetType, targetId, relationshipType } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (sourceType) {
    clauses.push("source_type = ?");
    params.push(String(sourceType));
  }
  if (sourceId) {
    clauses.push("source_id = ?");
    params.push(String(sourceId));
  }
  if (targetType) {
    clauses.push("target_type = ?");
    params.push(String(targetType));
  }
  if (targetId) {
    clauses.push("target_id = ?");
    params.push(String(targetId));
  }
  if (relationshipType) {
    clauses.push("relationship_type = ?");
    params.push(String(relationshipType).toUpperCase());
  }
  return { where: `WHERE ${clauses.join(" AND ")}`, params };
}

export function createRelationship(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeRelationshipInput(body);
  const existing = queryOne(
    db,
    `SELECT id FROM change_relationships
     WHERE tenant_id = ? AND relationship_type = ? AND source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?`,
    [tenant, normalized.relationship_type, normalized.source_type, normalized.source_id, normalized.target_type, normalized.target_id]
  );
  if (existing) return publicRelationship(queryOne(db, "SELECT * FROM change_relationships WHERE id = ?", [existing.id]));
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO change_relationships (relationship_ref, tenant_id, relationship_type, source_type, source_id, target_type, target_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [relationshipRef(), tenant, normalized.relationship_type, normalized.source_type, normalized.source_id, normalized.target_type, normalized.target_id, actor?.id ?? null, ts]
  );
  return publicRelationship(queryOne(db, "SELECT * FROM change_relationships WHERE id = ?", [Number(result.lastInsertId)]));
}

export async function createRelationshipAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeRelationshipInput(body);
  const existing = await queryOneAsync(
    db,
    `SELECT id FROM change_relationships
     WHERE tenant_id = ? AND relationship_type = ? AND source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?`,
    [tenant, normalized.relationship_type, normalized.source_type, normalized.source_id, normalized.target_type, normalized.target_id]
  );
  if (existing) return publicRelationship(await queryOneAsync(db, "SELECT * FROM change_relationships WHERE id = ?", [existing.id]));
  const ts = nowIso();
  const result = await runAsync(
    db,
    `INSERT INTO change_relationships (relationship_ref, tenant_id, relationship_type, source_type, source_id, target_type, target_id, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [relationshipRef(), tenant, normalized.relationship_type, normalized.source_type, normalized.source_id, normalized.target_type, normalized.target_id, actor?.id ?? null, ts]
  );
  return publicRelationship(await queryOneAsync(db, "SELECT * FROM change_relationships WHERE id = ?", [Number(result.lastInsertId)]));
}

export function listRelationships(db, { tenantId, sourceType, sourceId, targetType, targetId, relationshipType } = {}) {
  const { where, params } = relationshipFilters({ tenantId, sourceType, sourceId, targetType, targetId, relationshipType });
  const rows = queryAll(db, `SELECT * FROM change_relationships ${where} ORDER BY id DESC`, params);
  return { items: rows.map(publicRelationship), total: rows.length, source_module: SOURCE_MODULE };
}

export async function listRelationshipsAsync(db, { tenantId, sourceType, sourceId, targetType, targetId, relationshipType } = {}) {
  const { where, params } = relationshipFilters({ tenantId, sourceType, sourceId, targetType, targetId, relationshipType });
  const rows = await queryAllAsync(db, `SELECT * FROM change_relationships ${where} ORDER BY id DESC`, params);
  return { items: rows.map(publicRelationship), total: rows.length, source_module: SOURCE_MODULE };
}

export function getRelationship(db, tenantId, ref) {
  const lookup = relationshipLookupValue(ref);
  const row = queryOne(db, `SELECT * FROM change_relationships WHERE ${lookup.column} = ? AND tenant_id = ?`, [lookup.value, Number(tenantId)]);
  if (!row) throw relationshipNotFound(ref);
  return publicRelationship(row);
}

export async function getRelationshipAsync(db, tenantId, ref) {
  const lookup = relationshipLookupValue(ref);
  const row = await queryOneAsync(db, `SELECT * FROM change_relationships WHERE ${lookup.column} = ? AND tenant_id = ?`, [lookup.value, Number(tenantId)]);
  if (!row) throw relationshipNotFound(ref);
  return publicRelationship(row);
}

export function deleteRelationship(db, tenantId, ref) {
  const lookup = relationshipLookupValue(ref);
  const row = queryOne(db, `SELECT * FROM change_relationships WHERE ${lookup.column} = ? AND tenant_id = ?`, [lookup.value, Number(tenantId)]);
  if (!row) throw relationshipNotFound(ref);
  run(db, "DELETE FROM change_relationships WHERE id = ?", [row.id]);
  return { deleted: true, id: row.id };
}

export async function deleteRelationshipAsync(db, tenantId, ref) {
  const lookup = relationshipLookupValue(ref);
  const row = await queryOneAsync(db, `SELECT * FROM change_relationships WHERE ${lookup.column} = ? AND tenant_id = ?`, [lookup.value, Number(tenantId)]);
  if (!row) throw relationshipNotFound(ref);
  await runAsync(db, "DELETE FROM change_relationships WHERE id = ?", [row.id]);
  return { deleted: true, id: row.id };
}
