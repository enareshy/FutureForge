// Configurable catalog relationship types and relationship instances.
//
// Relationship types are data, not code: an administrator registers the kinds
// of relationship the organization recognises (IMPLEMENTS, REPLACES,
// SUPPORTS...) and their allowed endpoint types. Instances link two catalog
// entries. Lineage is a specialised relationship; the two are intentionally
// separate because lineage is traversed as a graph.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { assertEntryType, normalizeLower, normalizeText, normalizeUpper, paginate, parseObject } from "./validation.js";
import { publicRelationshipType, publicRelationship } from "./repository.js";
import { relationshipNotFound, relationshipConflict, invalidRelationship, entryNotFound } from "./errors.js";
import { getEntryRow } from "./entries.js";
import { publishCatalogEvent } from "./events.js";

export { publicRelationshipType, publicRelationship };

export const DEFAULT_RELATIONSHIP_TYPES = [
  { code: "CONTAINS", name: "Contains", source_entry_type: "OBJECT", target_entry_type: "ATTRIBUTE" },
  { code: "REFERENCES", name: "References", source_entry_type: "", target_entry_type: "" },
  { code: "IMPLEMENTS", name: "Implements", source_entry_type: "", target_entry_type: "" },
  { code: "REPLACES", name: "Replaces", source_entry_type: "", target_entry_type: "" },
  { code: "REPRESENTS", name: "Represents", source_entry_type: "BUSINESS_TERM", target_entry_type: "OBJECT" },
  { code: "GOVERNED_BY", name: "Governed by", source_entry_type: "", target_entry_type: "DOMAIN" },
];

export function ensureDefaultRelationshipTypes(db, tenantId) {
  let created = 0;
  for (const type of DEFAULT_RELATIONSHIP_TYPES) {
    const existing = queryOne(db, "SELECT id FROM dc_relationship_types WHERE tenant_id = ? AND code = ?", [Number(tenantId), type.code]);
    if (existing) continue;
    run(
      db,
      "INSERT INTO dc_relationship_types (tenant_id, code, name, description, source_entry_type, target_entry_type, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', '{}', ?, ?)",
      [Number(tenantId), type.code, type.name, "", type.source_entry_type, type.target_entry_type, nowIso(), nowIso()]
    );
    created += 1;
  }
  return { created };
}

export function getRelationshipTypeRow(db, ref, tenantId = null) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    return tenantId
      ? queryOne(db, "SELECT * FROM dc_relationship_types WHERE id = ? AND tenant_id = ?", [numeric, Number(tenantId)])
      : queryOne(db, "SELECT * FROM dc_relationship_types WHERE id = ?", [numeric]);
  }
  const scoped = tenantId ? " AND tenant_id = ?" : "";
  return queryOne(db, `SELECT * FROM dc_relationship_types WHERE code = ?${scoped}`, [
    normalizeUpper(ref),
    ...(tenantId ? [Number(tenantId)] : []),
  ]);
}

export function requireRelationshipType(db, ref, tenantId = null) {
  const row = getRelationshipTypeRow(db, ref, tenantId);
  if (!row) throw relationshipNotFound(ref);
  return row;
}

export function listRelationshipTypes(db, { tenantId, status, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeLower(status));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dc_relationship_types ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM dc_relationship_types ${where} ORDER BY code LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicRelationshipType), total, page: currentPage, page_size: limit };
}

export function createRelationshipType(db, input = {}, actor = null, tenantId = null, ip = null) {
  const code = normalizeUpper(normalizeText(input.code));
  if (!code) throw invalidRelationship("A relationship type code is required");
  if (getRelationshipTypeRow(db, code, tenantId)) throw relationshipConflict({ code });
  const sourceEntryType = input.source_entry_type ? assertEntryType(normalizeUpper(input.source_entry_type)) : "";
  const targetEntryType = input.target_entry_type ? assertEntryType(normalizeUpper(input.target_entry_type)) : "";
  const ts = nowIso();
  const result = run(
    db,
    "INSERT INTO dc_relationship_types (tenant_id, code, name, description, source_entry_type, target_entry_type, status, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      Number(tenantId),
      code,
      normalizeText(input.name) || code,
      normalizeText(input.description),
      sourceEntryType,
      targetEntryType,
      normalizeLower(input.status || "active") === "inactive" ? "inactive" : "active",
      JSON.stringify(parseObject(input.metadata, {})),
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM dc_relationship_types WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, {
    actor,
    action: "data_catalog.relationship_type.create",
    resourceType: "dc_relationship_type",
    resourceId: row.id,
    details: { code },
    ip,
  });
  return publicRelationshipType(row);
}

export function updateRelationshipType(db, ref, patch = {}, actor = null, tenantId = null, ip = null) {
  const row = requireRelationshipType(db, ref, tenantId);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.name !== undefined) assign("name", normalizeText(patch.name) || row.code);
  if (patch.description !== undefined) assign("description", normalizeText(patch.description));
  if (patch.source_entry_type !== undefined) assign("source_entry_type", patch.source_entry_type ? assertEntryType(normalizeUpper(patch.source_entry_type)) : "");
  if (patch.target_entry_type !== undefined) assign("target_entry_type", patch.target_entry_type ? assertEntryType(normalizeUpper(patch.target_entry_type)) : "");
  if (patch.status !== undefined) assign("status", normalizeLower(patch.status) === "inactive" ? "inactive" : "active");
  if (patch.metadata !== undefined) assign("metadata_json", JSON.stringify(parseObject(patch.metadata, {})));
  if (!changes.length) return publicRelationshipType(row);
  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dc_relationship_types SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  return publicRelationshipType(queryOne(db, "SELECT * FROM dc_relationship_types WHERE id = ?", [row.id]));
}

function relationshipSelect() {
  return `SELECT r.*, rt.code AS relationship_code FROM dc_relationships r JOIN dc_relationship_types rt ON rt.id = r.relationship_type_id`;
}

export function getRelationshipRow(db, id, tenantId = null) {
  return tenantId
    ? queryOne(db, `${relationshipSelect()} WHERE r.id = ? AND r.tenant_id = ?`, [Number(id), Number(tenantId)])
    : queryOne(db, `${relationshipSelect()} WHERE r.id = ?`, [Number(id)]);
}

export function requireRelationship(db, id, tenantId = null) {
  const row = getRelationshipRow(db, id, tenantId);
  if (!row) throw relationshipNotFound(id);
  return row;
}

export function listRelationships(db, { tenantId, entryId, relationshipType, status, direction = "both", page, pageSize } = {}) {
  const clauses = ["r.tenant_id = ?"];
  const params = [Number(tenantId)];
  if (entryId !== undefined && entryId !== null && entryId !== "") {
    const numeric = Number(entryId);
    if (direction === "out") {
      clauses.push("r.from_entry_id = ?");
      params.push(numeric);
    } else if (direction === "in") {
      clauses.push("r.to_entry_id = ?");
      params.push(numeric);
    } else {
      clauses.push("(r.from_entry_id = ? OR r.to_entry_id = ?)");
      params.push(numeric, numeric);
    }
  }
  if (relationshipType) {
    clauses.push("rt.code = ?");
    params.push(normalizeUpper(relationshipType));
  }
  if (status) {
    clauses.push("r.status = ?");
    params.push(normalizeLower(status));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dc_relationships r JOIN dc_relationship_types rt ON rt.id = r.relationship_type_id ${where}`, params)?.c || 0);
  const rows = queryAll(db, `${relationshipSelect()} ${where} ORDER BY r.id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicRelationship), total, page: currentPage, page_size: limit };
}

export function createRelationship(db, input = {}, actor = null, tenantId = null, ip = null) {
  const type = requireRelationshipType(db, input.relationship_type_id ?? input.relationship_type ?? input.type, tenantId);
  const fromEntry = getEntryRow(db, input.from_entry_id ?? input.from_entry_ref, { tenantId });
  const toEntry = getEntryRow(db, input.to_entry_id ?? input.to_entry_ref, { tenantId });
  if (!fromEntry || !toEntry) throw entryNotFound(!fromEntry ? input.from_entry_id ?? input.from_entry_ref : input.to_entry_id ?? input.to_entry_ref);
  if (Number(fromEntry.id) === Number(toEntry.id)) throw invalidRelationship("A relationship cannot connect an entry to itself");
  if (type.source_entry_type) assertRelationshipEndpoint(type.source_entry_type, fromEntry);
  if (type.target_entry_type) assertRelationshipEndpoint(type.target_entry_type, toEntry);
  const existing = queryOne(db, "SELECT id FROM dc_relationships WHERE tenant_id = ? AND relationship_type_id = ? AND from_entry_id = ? AND to_entry_id = ?", [
    Number(tenantId),
    type.id,
    fromEntry.id,
    toEntry.id,
  ]);
  if (existing) throw relationshipConflict({ relationship_type: type.code, from_entry_id: fromEntry.id, to_entry_id: toEntry.id });
  const ts = nowIso();
  const result = run(
    db,
    "INSERT INTO dc_relationships (tenant_id, relationship_type_id, from_entry_id, to_entry_id, attributes_json, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      Number(tenantId),
      type.id,
      fromEntry.id,
      toEntry.id,
      JSON.stringify(parseObject(input.attributes, {})),
      normalizeLower(input.status || "active") === "inactive" ? "inactive" : "active",
      actor?.id ?? null,
      ts,
    ]
  );
  const row = getRelationshipRow(db, Number(result.lastInsertRowid));
  writeAudit(db, {
    actor,
    action: "data_catalog.relationship.create",
    resourceType: "dc_relationship",
    resourceId: row.id,
    details: { relationship_type: type.code, from: fromEntry.entry_ref, to: toEntry.entry_ref },
    ip,
  });
  publishCatalogEvent(db, {
    eventType: "CatalogObjectUpdated",
    tenantId: Number(tenantId),
    objectType: "data_catalog_entry",
    objectId: fromEntry.id,
    payload: { relationship: type.code, from_entry_id: fromEntry.id, to_entry_id: toEntry.id },
  }, actor);
  return publicRelationship(row);
}

function assertRelationshipEndpoint(expectedType, entry) {
  if (expectedType && entry.entry_type !== expectedType) {
    throw invalidRelationship(`Relationship expects a ${expectedType} endpoint but received ${entry.entry_type}`, {
      expected: expectedType,
      actual: entry.entry_type,
    });
  }
  return true;
}

export function updateRelationship(db, id, patch = {}, actor = null, tenantId = null, ip = null) {
  const row = requireRelationship(db, id, tenantId);
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.attributes !== undefined) assign("attributes_json", JSON.stringify(parseObject(patch.attributes, {})));
  if (patch.status !== undefined) assign("status", normalizeLower(patch.status) === "inactive" ? "inactive" : "active");
  if (!changes.length) return publicRelationship(row);
  run(db, `UPDATE dc_relationships SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  return publicRelationship(requireRelationship(db, row.id));
}

export function removeRelationship(db, id, actor = null, tenantId = null, ip = null) {
  const row = requireRelationship(db, id, tenantId);
  run(db, "DELETE FROM dc_relationships WHERE id = ?", [row.id]);
  writeAudit(db, {
    actor,
    action: "data_catalog.relationship.remove",
    resourceType: "dc_relationship",
    resourceId: row.id,
    details: { relationship_type_id: row.relationship_type_id },
    ip,
  });
  return { deleted: true, id: row.id };
}

export { relationshipConflict, invalidRelationship };
