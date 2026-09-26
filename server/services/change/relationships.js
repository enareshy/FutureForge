// Typed polymorphic edges between Change Management objects (ECR->ECO,
// ECO->ECN, ECO->affected object). Mirrors the source_type/source_id/
// target_type/target_id convention used by server/services/pdm/relationships.js.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { publicRelationship } from "./repository.js";
import { relationshipRef } from "./refs.js";
import { normalizeRelationshipInput } from "./validation.js";
import { relationshipNotFound } from "./errors.js";
import { SOURCE_MODULE } from "./constants.js";

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
  return publicRelationship(queryOne(db, "SELECT * FROM change_relationships WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function listRelationships(db, { tenantId, sourceType, sourceId, targetType, targetId, relationshipType } = {}) {
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
  const where = `WHERE ${clauses.join(" AND ")}`;
  const rows = queryAll(db, `SELECT * FROM change_relationships ${where} ORDER BY id DESC`, params);
  return { items: rows.map(publicRelationship), total: rows.length, source_module: SOURCE_MODULE };
}

export function getRelationship(db, tenantId, ref) {
  const id = Number(ref);
  const row = Number.isInteger(id)
    ? queryOne(db, "SELECT * FROM change_relationships WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)])
    : queryOne(db, "SELECT * FROM change_relationships WHERE relationship_ref = ? AND tenant_id = ?", [String(ref), Number(tenantId)]);
  if (!row) throw relationshipNotFound(ref);
  return publicRelationship(row);
}

export function deleteRelationship(db, tenantId, ref) {
  const id = Number(ref);
  const row = Number.isInteger(id)
    ? queryOne(db, "SELECT * FROM change_relationships WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)])
    : queryOne(db, "SELECT * FROM change_relationships WHERE relationship_ref = ? AND tenant_id = ?", [String(ref), Number(tenantId)]);
  if (!row) throw relationshipNotFound(ref);
  run(db, "DELETE FROM change_relationships WHERE id = ?", [row.id]);
  return { deleted: true, id: row.id };
}
