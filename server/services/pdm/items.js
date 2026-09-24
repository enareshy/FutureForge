// PDM item service.
//
// An item is the persistent identity of a managed PDM object (part, product,
// document, assembly). Revision, dataset, CAD and rule semantics live in their
// own services. All writes record history, emit domain events and bump the read
// cache. Numbering is delegated to the shared Numbering & Identifier Service
// when a scheme is available; uniqueness is always enforced by the domain.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow, assertVersion, bumpVersion } from "./sql.js";
import { publicItem } from "./repository.js";
import { itemRef } from "./refs.js";
import { bumpEpoch, invalidate } from "./cache.js";
import { recordChange, listHistory } from "./history.js";
import { publishPdmEvent, pdmEventCode } from "./events.js";
import { getConfig } from "./configuration.js";
import { normalizeItemInput, normalizeText, assertItemStatus, paginate } from "./validation.js";
import { itemNotFound, itemConflict, invalidItem, itemObsolete, pdmConflict } from "./errors.js";
import { SOURCE_MODULE, ITEM_STATUSES } from "./constants.js";
import { bridgeCreateObject } from "./bridge.js";

const UPDATE_COLUMNS = [
  "name",
  "description",
  "item_type",
  "owner_user_id",
  "owner_object_id",
  "organization_id",
  "plant_id",
  "site_id",
  "classification_code",
  "current_revision_id",
  "status",
  "lifecycle_state",
  "metadata_json",
  "attributes_json",
  "object_id",
  "version",
  "updated_by",
];

export function getItemRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM pdm_items WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(
    db,
    "SELECT * FROM pdm_items WHERE tenant_id = ? AND (item_ref = ? OR item_number = ? COLLATE NOCASE)",
    [Number(tenantId), String(ref), String(ref)]
  );
}

export function requireItemRow(db, tenantId, ref) {
  const row = getItemRow(db, tenantId, ref);
  if (!row) throw itemNotFound(ref);
  return row;
}

export function getItem(db, tenantId, ref) {
  return publicItem(requireItemRow(db, tenantId, ref));
}

export function listItems(db, { tenantId, status, itemType, classificationCode, organizationId, plantId, siteId, ownerUserId, q, page, pageSize, sort, order } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(assertItemStatus(status));
  }
  if (itemType) {
    clauses.push("item_type = ?");
    params.push(String(itemType).toUpperCase());
  }
  if (classificationCode) {
    clauses.push("classification_code = ?");
    params.push(normalizeText(classificationCode, { max: 200 }));
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
    clauses.push("(item_number LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${normalizeText(q, { max: 120 })}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const allowedSort = ["id", "item_number", "name", "status", "item_type", "updated_at", "created_at"];
  const column = allowedSort.includes(String(sort)) ? String(sort) : "updated_at";
  const direction = String(order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pdm_items ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pdm_items ${where} ORDER BY ${column} ${direction} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicItem), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function createItem(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeItemInput(body, {});
  const enforceUnique = getConfig(db, tenant, "enforce_unique_item_number") !== false;
  if (enforceUnique) {
    const existing = queryOne(db, "SELECT id FROM pdm_items WHERE tenant_id = ? AND item_number = ?", [tenant, normalized.item_number]);
    if (existing) throw itemConflict(normalized.item_number);
  }
  const defaultStatus = String(getConfig(db, tenant, "default_item_status") || "DRAFT").toUpperCase();
  const status = normalized.status || (ITEM_STATUSES.includes(defaultStatus) ? defaultStatus : "DRAFT");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO pdm_items
       (item_ref, tenant_id, organization_id, plant_id, site_id, item_number, name, description, item_type,
        owner_user_id, owner_object_id, object_id, classification_code, status, lifecycle_state,
        metadata_json, attributes_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      itemRef(normalized.item_number),
      tenant,
      normalized.organization_id,
      normalized.plant_id,
      normalized.site_id,
      normalized.item_number,
      normalized.name,
      normalized.description,
      normalized.item_type,
      normalized.owner_user_id,
      normalized.owner_object_id,
      null,
      normalized.classification_code,
      status,
      status,
      JSON.stringify(normalized.metadata || {}),
      JSON.stringify(normalized.attributes || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM pdm_items WHERE id = ?", [Number(result.lastInsertRowid)]);
  const objectId = bridgeCreateObject(
    db,
    {
      type: "pdm_item",
      code: row.item_number,
      name: row.name || row.item_number,
      description: row.description,
      data: { item_type: row.item_type, ...(normalized.metadata || {}) },
      status: row.status,
      organizationId: row.organization_id,
    },
    actor,
    tenant,
    ip
  );
  if (objectId) updateRow(db, "pdm_items", row.id, { object_id: objectId }, { columns: ["object_id"] });
  const finalRow = queryOne(db, "SELECT * FROM pdm_items WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "ITEM", entityId: row.id, entityRef: row.item_ref, action: "CREATED", version: 1, status, after: publicItem(finalRow), actor, ip });
  publishPdmEvent(db, { eventType: pdmEventCode("ITEM_CREATED"), objectType: "pdm_item", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { item_ref: row.item_ref, item_number: row.item_number, item_type: row.item_type } }, actor);
  return publicItem(finalRow);
}

export function updateItem(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireItemRow(db, tenant, ref);
  if (row.status === "OBSOLETE") throw itemObsolete(row.item_number);
  assertVersion(row, body.version ?? body.expected_version ?? body.expectedVersion, (details) =>
    pdmConflict(`PDM item ${row.item_number} was modified by another user`, details));
  const before = publicItem(row);
  const normalized = normalizeItemInput(body, row);
  const enforceUnique = getConfig(db, tenant, "enforce_unique_item_number") !== false;
  if (enforceUnique && normalized.item_number !== row.item_number) {
    const clash = queryOne(db, "SELECT id FROM pdm_items WHERE tenant_id = ? AND item_number = ? AND id <> ?", [tenant, normalized.item_number, row.id]);
    if (clash) throw itemConflict(normalized.item_number);
  }
  updateRow(
    db,
    "pdm_items",
    row.id,
    {
      name: normalized.name,
      description: normalized.description,
      item_type: normalized.item_type,
      owner_user_id: normalized.owner_user_id,
      owner_object_id: normalized.owner_object_id,
      organization_id: normalized.organization_id,
      plant_id: normalized.plant_id,
      site_id: normalized.site_id,
      classification_code: normalized.classification_code,
      metadata_json: JSON.stringify(normalized.metadata || {}),
      attributes_json: JSON.stringify(normalized.attributes || {}),
      version: bumpVersion(row),
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM pdm_items WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "ITEM", entityId: row.id, entityRef: row.item_ref, action: "UPDATED", version: updated.version, status: updated.status, before, after: publicItem(updated), actor, ip });
  publishPdmEvent(db, { eventType: pdmEventCode("ITEM_UPDATED"), objectType: "pdm_item", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { item_ref: updated.item_ref } }, actor);
  return publicItem(updated);
}

export function setItemStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireItemRow(db, tenant, ref);
  const next = assertItemStatus(status);
  if (!ITEM_STATUSES.includes(next)) throw invalidItem(`Unsupported item status: ${next}`);
  const before = publicItem(row);
  updateRow(db, "pdm_items", row.id, { status: next, lifecycle_state: next, version: bumpVersion(row), updated_by: actor?.id ?? null }, { columns: UPDATE_COLUMNS });
  const updated = queryOne(db, "SELECT * FROM pdm_items WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "ITEM", entityId: row.id, entityRef: row.item_ref, action: "STATUS_CHANGED", version: updated.version, status: next, before, after: publicItem(updated), actor, ip });
  publishPdmEvent(db, { eventType: pdmEventCode("ITEM_STATUS_CHANGED"), objectType: "pdm_item", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { item_ref: updated.item_ref, from: row.status, to: next } }, actor);
  return publicItem(updated);
}

export function deleteItem(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireItemRow(db, tenant, ref);
  const revisions = Number(queryOne(db, "SELECT COUNT(*) AS c FROM pdm_item_revisions WHERE item_id = ?", [row.id])?.c || 0);
  if (revisions > 0) throw invalidItem(`Item ${row.item_number} still has ${revisions} revision(s); delete them first or archive the item`, { revisions });
  const before = publicItem(row);
  run(db, "DELETE FROM pdm_relationships WHERE tenant_id = ? AND (source_id = ? OR target_id = ?)", [tenant, String(row.id), String(row.id)]);
  run(db, "DELETE FROM pdm_items WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "ITEM", entityId: row.id, entityRef: row.item_ref, action: "DELETED", version: row.version, status: row.status, before, actor, ip });
  publishPdmEvent(db, { eventType: pdmEventCode("ITEM_DELETED"), objectType: "pdm_item", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { item_ref: row.item_ref } }, actor);
  return { deleted: true, id: row.id, item_ref: row.item_ref };
}

export function listItemAudit(db, { tenantId, entityId = null, entityRef = null, action = null, from = null, to = null, page = null, pageSize = null } = {}) {
  return listHistory(db, { tenantId, entityId, entityRef, action, from, to, page, pageSize });
}

export function countItems(db, tenantId) {
  return Number(queryOne(db, "SELECT COUNT(*) AS c FROM pdm_items WHERE tenant_id = ?", [Number(tenantId)])?.c || 0);
}
