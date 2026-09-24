// PDM typed relationship service.
//
// PDM relationships are typed, directional edges between PDM objects
// (ITEM_HAS_REVISION, REVISION_HAS_DATASET, PRODUCT_HAS_PART, ...). They are
// indexed in the PDM relationship table for batched traversal and, where the
// endpoints expose a generic object id, mirrored into the shared Object &
// Relationship Framework. No service defines its own foreign-key traversal.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow, bumpVersion } from "./sql.js";
import { publicRelationship } from "./repository.js";
import { relationshipRef } from "./refs.js";
import { bumpEpoch, invalidate } from "./cache.js";
import { recordChange } from "./history.js";
import { recordReference, removeReference } from "./references.js";
import { normalizeRelationshipInput, paginate } from "./validation.js";
import { relationshipNotFound, relationshipConflict, invalidRelationship } from "./errors.js";
import { SOURCE_MODULE, RELATIONSHIP_TYPES } from "./constants.js";
import { bridgeCreateRelationship } from "./bridge.js";

export function relationshipDefinition(code) {
  return RELATIONSHIP_TYPES.find((entry) => entry.code === String(code || "").toUpperCase()) || null;
}

export function getRelationshipRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM pdm_relationships WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(db, "SELECT * FROM pdm_relationships WHERE tenant_id = ? AND relationship_ref = ?", [Number(tenantId), String(ref)]);
}

export function requireRelationshipRow(db, tenantId, ref) {
  const row = getRelationshipRow(db, tenantId, ref);
  if (!row) throw relationshipNotFound(ref);
  return row;
}

export function getRelationship(db, tenantId, ref) {
  return publicRelationship(requireRelationshipRow(db, tenantId, ref));
}

export function listRelationships(db, { tenantId, relationshipType, sourceType, sourceId, targetType, targetId, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (relationshipType) {
    clauses.push("relationship_type = ?");
    params.push(String(relationshipType).toUpperCase());
  }
  if (sourceType) {
    clauses.push("source_type = ?");
    params.push(String(sourceType).toUpperCase());
  }
  if (sourceId != null) {
    clauses.push("source_id = ?");
    params.push(String(sourceId));
  }
  if (targetType) {
    clauses.push("target_type = ?");
    params.push(String(targetType).toUpperCase());
  }
  if (targetId != null) {
    clauses.push("target_id = ?");
    params.push(String(targetId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status).toUpperCase());
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 1000 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pdm_relationships ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pdm_relationships ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicRelationship), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function createRelationship(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeRelationshipInput(body);
  if (!relationshipDefinition(normalized.relationship_type)) throw invalidRelationship(`Unknown relationship type: ${normalized.relationship_type}`);
  const duplicate = queryOne(
    db,
    "SELECT id FROM pdm_relationships WHERE tenant_id = ? AND relationship_type = ? AND source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?",
    [tenant, normalized.relationship_type, normalized.source_type, normalized.source_id, normalized.target_type, normalized.target_id]
  );
  if (duplicate) throw relationshipConflict({ relationship_type: normalized.relationship_type, source_id: normalized.source_id, target_id: normalized.target_id });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO pdm_relationships
       (relationship_ref, tenant_id, organization_id, relationship_type, source_type, source_id, target_type, target_id, direction,
        cardinality, status, valid_from, valid_to, object_relationship_id, attributes_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    [
      relationshipRef(),
      tenant,
      normalized.organization_id,
      normalized.relationship_type,
      normalized.source_type,
      normalized.source_id,
      normalized.target_type,
      normalized.target_id,
      normalized.direction,
      normalized.cardinality,
      normalized.status,
      normalized.valid_from,
      normalized.valid_to,
      JSON.stringify(normalized.attributes || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM pdm_relationships WHERE id = ?", [Number(result.lastInsertRowid)]);
  const genericId = bridgeCreateRelationship(
    db,
    { type: row.relationship_type, sourceId: row.source_id, targetId: row.target_id, attributes: normalized.attributes },
    actor,
    tenant,
    ip
  );
  if (genericId) updateRow(db, "pdm_relationships", row.id, { object_relationship_id: genericId }, { columns: ["object_relationship_id"] });
  recordReference(db, tenant, {
    source_type: "RELATIONSHIP",
    source_id: String(row.id),
    source_ref: row.relationship_ref,
    target_type: "OBJECT",
    target_id: row.target_id,
    target_ref: "",
    category: "RELATIONSHIP",
    relationship_type: row.relationship_type,
    organization_id: row.organization_id,
  });
  const finalRow = queryOne(db, "SELECT * FROM pdm_relationships WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "RELATIONSHIP", entityId: row.id, entityRef: row.relationship_ref, action: "CREATED", version: 1, status: row.status, after: publicRelationship(finalRow), actor, ip, details: { relationship_type: row.relationship_type } });
  return publicRelationship(finalRow);
}

export function updateRelationship(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRelationshipRow(db, tenant, ref);
  const before = publicRelationship(row);
  const normalized = normalizeRelationshipInput({ ...rowToInput(row), ...body });
  updateRow(
    db,
    "pdm_relationships",
    row.id,
    {
      direction: normalized.direction,
      cardinality: normalized.cardinality,
      status: normalized.status,
      valid_from: normalized.valid_from,
      valid_to: normalized.valid_to,
      attributes_json: JSON.stringify(normalized.attributes || {}),
      version: bumpVersion(row),
      updated_by: actor?.id ?? null,
    },
    { columns: ["direction", "cardinality", "status", "valid_from", "valid_to", "attributes_json", "version", "updated_by"] }
  );
  const updated = queryOne(db, "SELECT * FROM pdm_relationships WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "RELATIONSHIP", entityId: row.id, entityRef: row.relationship_ref, action: "UPDATED", version: updated.version, status: updated.status, before, after: publicRelationship(updated), actor, ip });
  return publicRelationship(updated);
}

export function deleteRelationship(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRelationshipRow(db, tenant, ref);
  const before = publicRelationship(row);
  removeReference(db, tenant, { source_type: "RELATIONSHIP", source_id: String(row.id), target_type: "OBJECT", target_id: row.target_id, category: "RELATIONSHIP" });
  run(db, "DELETE FROM pdm_relationships WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "RELATIONSHIP", entityId: row.id, entityRef: row.relationship_ref, action: "DELETED", version: row.version, status: row.status, before, actor, ip });
  return { deleted: true, id: row.id, relationship_ref: row.relationship_ref };
}

export function relationshipsFrom(db, tenantId, sourceType, sourceId, options = {}) {
  return listRelationships(db, { tenantId, sourceType, sourceId, ...options });
}

export function relationshipsTo(db, tenantId, targetType, targetId, options = {}) {
  return listRelationships(db, { tenantId, targetType, targetId, ...options });
}

function rowToInput(row) {
  return {
    relationship_type: row.relationship_type,
    source_type: row.source_type,
    source_id: row.source_id,
    target_type: row.target_type,
    target_id: row.target_id,
    direction: row.direction,
    cardinality: row.cardinality,
    status: row.status,
    valid_from: row.valid_from,
    valid_to: row.valid_to,
    attributes: row.attributes_json ? JSON.parse(row.attributes_json) : {},
    organization_id: row.organization_id,
  };
}
