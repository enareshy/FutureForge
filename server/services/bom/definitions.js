// BOM header (definition) service.
//
// A BOM header is the logical structure (number, name, type, owner, plant/site,
// lifecycle). Revision, line and structure semantics live in their own services.
// All writes record history, emit domain events and bump the structure cache.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow } from "./sql.js";
import { publicBom, publicHistory } from "./repository.js";
import { bomRef } from "./refs.js";
import { bumpEpoch } from "./cache.js";
import { recordChange, listHistory } from "./history.js";
import { publishBomEvent, bomEventCode } from "./events.js";
import { invalidate } from "./cache.js";
import {
  assertBomStatus,
  assertBomType,
  normalizeBomInput,
  normalizeText,
  normalizeUpper,
  paginate,
} from "./validation.js";
import { bomNotFound, bomConflict, invalidBom, bomObsolete } from "./errors.js";
import { SOURCE_MODULE, BOM_STATUSES } from "./constants.js";

const UPDATE_COLUMNS = [
  "name",
  "description",
  "bom_type",
  "owner_user_id",
  "owner_object_id",
  "organization_id",
  "plant_id",
  "site_id",
  "status",
  "lifecycle_state",
  "current_revision_id",
  "metadata_json",
  "version",
  "updated_by",
];

export function getBomRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM bom_headers WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(
    db,
    "SELECT * FROM bom_headers WHERE tenant_id = ? AND (bom_ref = ? OR bom_number = ? COLLATE NOCASE)",
    [Number(tenantId), String(ref), String(ref)]
  );
}

export function requireBomRow(db, tenantId, ref) {
  const row = getBomRow(db, tenantId, ref);
  if (!row) throw bomNotFound(ref);
  return row;
}

export function getBom(db, tenantId, ref) {
  return publicBom(requireBomRow(db, tenantId, ref));
}

export function listBoms(db, { tenantId, status, bomType, organizationId, plantId, siteId, ownerUserId, q, page, pageSize, sort, order } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(assertBomStatus(status));
  }
  if (bomType) {
    clauses.push("bom_type = ?");
    params.push(assertBomType(bomType));
  }
  if (organizationId != null) {
    clauses.push("organization_id = ?");
    params.push(Number(organizationId));
  }
  if (plantId != null) {
    clauses.push("plant_id = ?");
    params.push(Number(plantId));
  }
  if (siteId != null) {
    clauses.push("site_id = ?");
    params.push(Number(siteId));
  }
  if (ownerUserId != null) {
    clauses.push("owner_user_id = ?");
    params.push(Number(ownerUserId));
  }
  if (q) {
    clauses.push("(bom_number LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${normalizeText(q, { max: 120 })}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const allowedSort = ["id", "bom_number", "name", "status", "bom_type", "updated_at", "created_at"];
  const column = allowedSort.includes(String(sort)) ? String(sort) : "updated_at";
  const direction = String(order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM bom_headers ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM bom_headers ${where} ORDER BY ${column} ${direction} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicBom), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function createBom(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeBomInput(body, {});
  const existing = queryOne(db, "SELECT id FROM bom_headers WHERE tenant_id = ? AND bom_number = ?", [tenant, normalized.bom_number]);
  if (existing) throw bomConflict(normalized.bom_number);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO bom_headers
       (bom_ref, tenant_id, organization_id, plant_id, site_id, bom_number, name, description, bom_type,
        owner_user_id, owner_object_id, status, lifecycle_state, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      bomRef(normalized.bom_number),
      tenant,
      normalized.organization_id,
      normalized.plant_id,
      normalized.site_id,
      normalized.bom_number,
      normalized.name,
      normalized.description,
      normalized.bom_type,
      normalized.owner_user_id,
      normalized.owner_object_id,
      normalized.status,
      normalized.status,
      JSON.stringify(normalized.metadata || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM bom_headers WHERE id = ?", [Number(result.lastInsertRowid)]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "BOM", entityId: row.id, entityRef: row.bom_ref, action: "CREATED", version: 1, status: row.status, after: publicBom(row), actor, ip });
  publishBomEvent(db, { eventType: bomEventCode("BOM_CREATED"), objectType: "bom", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { bom_ref: row.bom_ref, bom_number: row.bom_number, bom_type: row.bom_type } }, actor);
  return publicBom(row);
}

export function updateBom(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireBomRow(db, tenant, ref);
  if (row.status === "OBSOLETE") throw bomObsolete(row.bom_number);
  const before = publicBom(row);
  const normalized = normalizeBomInput(body, row);
  updateRow(
    db,
    "bom_headers",
    row.id,
    {
      name: normalized.name,
      description: normalized.description,
      bom_type: normalized.bom_type,
      owner_user_id: normalized.owner_user_id,
      owner_object_id: normalized.owner_object_id,
      organization_id: normalized.organization_id,
      plant_id: normalized.plant_id,
      site_id: normalized.site_id,
      metadata_json: JSON.stringify(normalized.metadata || {}),
      version: Number(row.version) + 1,
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM bom_headers WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "BOM", entityId: row.id, entityRef: row.bom_ref, action: "UPDATED", version: updated.version, status: updated.status, before, after: publicBom(updated), actor, ip });
  publishBomEvent(db, { eventType: bomEventCode("BOM_UPDATED"), objectType: "bom", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { bom_ref: updated.bom_ref } }, actor);
  return publicBom(updated);
}

export function setBomStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireBomRow(db, tenant, ref);
  const next = assertBomStatus(status);
  if (!BOM_STATUSES.includes(next)) throw invalidBom(`Unsupported BOM status: ${next}`);
  const before = publicBom(row);
  updateRow(db, "bom_headers", row.id, { status: next, lifecycle_state: next, version: Number(row.version) + 1, updated_by: actor?.id ?? null }, { columns: UPDATE_COLUMNS });
  const updated = queryOne(db, "SELECT * FROM bom_headers WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "BOM", entityId: row.id, entityRef: row.bom_ref, action: "STATUS_CHANGED", version: updated.version, status: next, before, after: publicBom(updated), actor, ip });
  return publicBom(updated);
}

export function deleteBom(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireBomRow(db, tenant, ref);
  const revisions = Number(queryOne(db, "SELECT COUNT(*) AS c FROM bom_revisions WHERE bom_id = ?", [row.id])?.c || 0);
  if (revisions > 0) throw invalidBom(`BOM ${row.bom_number} still has ${revisions} revision(s); delete them first or archive the BOM`, { revisions });
  const before = publicBom(row);
  run(db, "DELETE FROM bom_headers WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "BOM", entityId: row.id, entityRef: row.bom_ref, action: "DELETED", version: row.version, status: row.status, before, actor, ip });
  return { deleted: true, id: row.id, bom_ref: row.bom_ref };
}

export function listBomAudit(db, { tenantId, entityId = null, entityRef = null, action = null, from = null, to = null, page = null, pageSize = null } = {}) {
  return listHistory(db, { tenantId, entityId, entityRef, action, from, to, page, pageSize });
}
