// Cross-domain reference relationships (Country -> Currency, Plant -> Plant
// Type, Material -> Material Type). Generic by design: new relationship types
// need no schema change.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { invalidRelationship, itemNotFound, relationshipConflict, relationshipNotFound } from "./errors.js";
import { normalizeText, parseObject } from "./validation.js";
import { relationshipRef } from "./refs.js";
import { bumpCacheEpoch } from "./cache.js";
import { emitItemEvent } from "./events.js";

export function publicRelationship(row) {
  if (!row) return null;
  return {
    id: row.id,
    relationship_ref: row.relationship_ref,
    source_item_id: row.source_item_id,
    target_item_id: row.target_item_id,
    source_domain_id: row.source_domain_id,
    target_domain_id: row.target_domain_id,
    relationship_type: row.relationship_type,
    scope_key: row.scope_key,
    status: row.status,
    effective_from: row.effective_from,
    effective_to: row.effective_to,
    sequence: row.sequence,
    attributes: parseObject(row.attributes_json, {}),
    tenant_id: row.tenant_id,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listRelationships(db, { sourceItemId, targetItemId, sourceDomainId, targetDomainId, relationshipType, status, limit = 500 } = {}) {
  const clauses = [];
  const params = [];
  const add = (column, value) => {
    if (value === undefined || value === null) return;
    clauses.push(`${column} = ?`);
    params.push(Number(value));
  };
  add("source_item_id", sourceItemId);
  add("target_item_id", targetItemId);
  add("source_domain_id", sourceDomainId);
  add("target_domain_id", targetDomainId);
  if (relationshipType) {
    clauses.push("relationship_type = ?");
    params.push(String(relationshipType));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = queryAll(db, `SELECT * FROM reference_relationships ${where} ORDER BY sequence, id LIMIT ?`, [...params, Math.min(2000, Number(limit) || 500)]);
  return { items: rows.map(publicRelationship), total: rows.length };
}

export function getRelationshipRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM reference_relationships WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM reference_relationships WHERE relationship_ref = ?", [String(ref)]) || null;
}

export function createRelationship(db, input = {}, actor = null, tenantId = null, ip = null) {
  const sourceItemId = Number(input.sourceItemId ?? input.source_item_id);
  const targetItemId = Number(input.targetItemId ?? input.target_item_id);
  const relationshipType = normalizeText(input.relationship_type || input.relationshipType);
  if (!sourceItemId || !targetItemId) throw invalidRelationship("sourceItemId and targetItemId are required");
  if (!relationshipType) throw invalidRelationship("relationship_type is required");
  if (sourceItemId === targetItemId) throw invalidRelationship("A relationship cannot reference the same item");
  const source = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [sourceItemId]);
  const target = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [targetItemId]);
  if (!source) throw itemNotFound(sourceItemId);
  if (!target) throw itemNotFound(targetItemId);
  const existing = queryOne(
    db,
    "SELECT id FROM reference_relationships WHERE source_item_id = ? AND target_item_id = ? AND relationship_type = ?",
    [sourceItemId, targetItemId, relationshipType]
  );
  if (existing) throw relationshipConflict({ source_item_id: sourceItemId, target_item_id: targetItemId, relationship_type: relationshipType });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reference_relationships
      (relationship_ref, source_item_id, target_item_id, source_domain_id, target_domain_id, relationship_type, scope_key,
       status, effective_from, effective_to, sequence, metadata_json, attributes_json, tenant_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      relationshipRef(),
      sourceItemId,
      targetItemId,
      Number(source.domain_id),
      Number(target.domain_id),
      relationshipType,
      normalizeText(input.scope_key, source.scope_key || "GLOBAL"),
      input.status === "inactive" ? "inactive" : "active",
      input.effective_from ?? null,
      input.effective_to ?? null,
      Number(input.sequence) || 0,
      JSON.stringify(input.metadata ?? {}),
      JSON.stringify(input.attributes ?? input.attributes_json ?? {}),
      tenantId ?? source.tenant_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM reference_relationships WHERE id = ?", [Number(result.lastInsertRowid)]);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.relationship.create",
    resourceType: "reference_relationship",
    resourceId: row.id,
    details: { source_item_id: sourceItemId, target_item_id: targetItemId, relationship_type: relationshipType },
    ip,
  });
  emitItemEvent(db, "ReferenceRelationshipChanged", source, { action: "create", target_item_id: targetItemId, relationship_type: relationshipType }, actor);
  return publicRelationship(row);
}

export function updateRelationship(db, ref, patch = {}, actor = null, ip = null) {
  const row = getRelationshipRow(db, ref);
  if (!row) throw relationshipNotFound(ref);
  const clauses = [];
  const params = [];
  const set = (column, value) => {
    clauses.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.status !== undefined) set("status", patch.status === "inactive" ? "inactive" : "active");
  if (patch.effective_from !== undefined) set("effective_from", patch.effective_from ?? null);
  if (patch.effective_to !== undefined) set("effective_to", patch.effective_to ?? null);
  if (patch.sequence !== undefined) set("sequence", Number(patch.sequence) || 0);
  if (patch.attributes !== undefined) set("attributes_json", JSON.stringify(patch.attributes ?? {}));
  if (!clauses.length) return publicRelationship(row);
  set("updated_at", nowIso());
  params.push(row.id);
  run(db, `UPDATE reference_relationships SET ${clauses.join(", ")} WHERE id = ?`, params);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.relationship.update",
    resourceType: "reference_relationship",
    resourceId: row.id,
    details: { source_item_id: row.source_item_id, target_item_id: row.target_item_id },
    ip,
  });
  return publicRelationship(queryOne(db, "SELECT * FROM reference_relationships WHERE id = ?", [row.id]));
}

export function deleteRelationship(db, ref, actor = null, ip = null) {
  const row = getRelationshipRow(db, ref);
  if (!row) throw relationshipNotFound(ref);
  const source = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [row.source_item_id]);
  run(db, "DELETE FROM reference_relationships WHERE id = ?", [row.id]);
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.relationship.delete",
    resourceType: "reference_relationship",
    resourceId: row.id,
    details: { source_item_id: row.source_item_id, target_item_id: row.target_item_id },
    ip,
  });
  if (source) emitItemEvent(db, "ReferenceRelationshipChanged", source, { action: "delete", target_item_id: row.target_item_id }, actor);
  return { deleted: true, id: row.id };
}

export function relatedItems(db, itemId, { relationshipType, direction = "out" } = {}) {
  const clauses = [];
  const params = [];
  if (direction === "in" || direction === "both") {
    clauses.push("r.target_item_id = ?");
    params.push(Number(itemId));
  } else {
    clauses.push("r.source_item_id = ?");
    params.push(Number(itemId));
  }
  if (relationshipType) {
    clauses.push("r.relationship_type = ?");
    params.push(String(relationshipType));
  }
  const rows = queryAll(
    db,
    `SELECT r.*, i.item_ref AS related_item_ref, i.code AS related_code, i.name AS related_name, i.status AS related_status
     FROM reference_relationships r
     JOIN reference_data_items i ON i.id = ${direction === "in" ? "r.source_item_id" : "r.target_item_id"}
     WHERE ${clauses.join(" AND ")} AND r.status = 'active'`,
    params
  );
  return rows.map((row) => ({ ...publicRelationship(row), related: { item_ref: row.related_item_ref, code: row.related_code, name: row.related_name, status: row.related_status } }));
}
