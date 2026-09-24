// PDM dataset service.
//
// A dataset is a managed container for design-related digital content and its
// metadata. Binary content is never stored here: the dataset references the
// shared File/Content Storage through a content id/reference. Types are data.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow, assertVersion, bumpVersion } from "./sql.js";
import { publicDataset } from "./repository.js";
import { datasetRef } from "./refs.js";
import { bumpEpoch, invalidate } from "./cache.js";
import { recordChange } from "./history.js";
import { publishPdmEvent, pdmEventCode } from "./events.js";
import { getConfig } from "./configuration.js";
import { requireItemRow } from "./items.js";
import { requireRevisionRow } from "./revisions.js";
import { normalizeDatasetInput, normalizeText, assertDatasetStatus, paginate } from "./validation.js";
import { datasetNotFound, datasetConflict, invalidDataset, datasetImmutable, pdmConflict } from "./errors.js";
import { SOURCE_MODULE, DATASET_STATUSES } from "./constants.js";
import { bridgeCreateObject } from "./bridge.js";

const UPDATE_COLUMNS = [
  "name",
  "description",
  "dataset_type",
  "status",
  "lifecycle_state",
  "owner_user_id",
  "item_id",
  "revision_id",
  "content_id",
  "content_type",
  "content_reference",
  "checksum",
  "size_bytes",
  "metadata_json",
  "object_id",
  "version",
  "updated_by",
];

const IMMUTABLE = ["RELEASED", "OBSOLETE"];

export function getDatasetRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM pdm_datasets WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(
    db,
    "SELECT * FROM pdm_datasets WHERE tenant_id = ? AND (dataset_ref = ? OR dataset_number = ? COLLATE NOCASE)",
    [Number(tenantId), String(ref), String(ref)]
  );
}

export function requireDatasetRow(db, tenantId, ref) {
  const row = getDatasetRow(db, tenantId, ref);
  if (!row) throw datasetNotFound(ref);
  return row;
}

export function getDataset(db, tenantId, ref) {
  return publicDataset(requireDatasetRow(db, tenantId, ref));
}

export function listDatasets(db, { tenantId, itemId, revisionId, datasetType, status, q, page, pageSize, sort, order } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (itemId != null) {
    clauses.push("item_id = ?");
    params.push(Number(itemId));
  }
  if (revisionId != null) {
    clauses.push("revision_id = ?");
    params.push(Number(revisionId));
  }
  if (datasetType) {
    clauses.push("dataset_type = ?");
    params.push(String(datasetType).toUpperCase());
  }
  if (status) {
    clauses.push("status = ?");
    params.push(assertDatasetStatus(status));
  }
  if (q) {
    clauses.push("(dataset_number LIKE ? OR name LIKE ? OR description LIKE ? OR content_reference LIKE ?)");
    const like = `%${normalizeText(q, { max: 120 })}%`;
    params.push(like, like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const allowedSort = ["id", "dataset_number", "name", "dataset_type", "status", "updated_at", "created_at"];
  const column = allowedSort.includes(String(sort)) ? String(sort) : "updated_at";
  const direction = String(order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pdm_datasets ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pdm_datasets WHERE ${clauses.join(" AND ")} ORDER BY ${column} ${direction} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicDataset), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function createDataset(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeDatasetInput(body, {});
  const existing = queryOne(db, "SELECT id FROM pdm_datasets WHERE tenant_id = ? AND dataset_number = ?", [tenant, normalized.dataset_number]);
  if (existing) throw datasetConflict(normalized.dataset_number);
  const item = normalized.item_id != null ? requireItemRow(db, tenant, normalized.item_id) : null;
  const revision = normalized.revision_id != null ? requireRevisionRow(db, tenant, normalized.revision_id) : null;
  if (revision && item && Number(revision.item_id) !== Number(item.id)) throw invalidDataset("The revision does not belong to the item");
  const itemId = normalized.item_id ?? revision?.item_id ?? null;
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO pdm_datasets
       (dataset_ref, tenant_id, organization_id, item_id, revision_id, object_id, dataset_number, name, description, dataset_type, status,
        lifecycle_state, owner_user_id, content_id, content_type, content_reference, checksum, size_bytes, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      datasetRef(normalized.dataset_number),
      tenant,
      item?.organization_id ?? null,
      itemId,
      revision?.id ?? null,
      normalized.dataset_number,
      normalized.name,
      normalized.description,
      normalized.dataset_type,
      normalized.status,
      normalized.status,
      normalized.owner_user_id,
      normalized.content_id,
      normalized.content_type,
      normalized.content_reference,
      normalized.checksum,
      normalized.size_bytes,
      JSON.stringify(normalized.metadata || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM pdm_datasets WHERE id = ?", [Number(result.lastInsertRowid)]);
  const objectId = bridgeCreateObject(
    db,
    { type: "pdm_dataset", code: row.dataset_number, name: row.name || row.dataset_number, description: row.description, data: { dataset_type: row.dataset_type }, status: row.status, organizationId: row.organization_id },
    actor,
    tenant,
    ip
  );
  if (objectId) updateRow(db, "pdm_datasets", row.id, { object_id: objectId }, { columns: ["object_id"] });
  const finalRow = queryOne(db, "SELECT * FROM pdm_datasets WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "DATASET", entityId: row.id, entityRef: row.dataset_ref, action: "CREATED", version: 1, status: row.status, after: publicDataset(finalRow), actor, ip, details: { item_id: itemId, revision_id: revision?.id ?? null } });
  publishPdmEvent(db, { eventType: pdmEventCode("DATASET_CREATED"), objectType: "pdm_dataset", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { dataset_ref: row.dataset_ref, dataset_type: row.dataset_type } }, actor);
  return publicDataset(finalRow);
}

export function updateDataset(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireDatasetRow(db, tenant, ref);
  if (IMMUTABLE.includes(String(row.status).toUpperCase())) throw datasetImmutable(row.dataset_ref, row.status);
  assertVersion(row, body.version ?? body.expected_version ?? body.expectedVersion, (details) =>
    pdmConflict(`PDM dataset ${row.dataset_number} was modified by another user`, details));
  const before = publicDataset(row);
  const normalized = normalizeDatasetInput(body, row);
  let itemId = normalized.item_id;
  const revision = normalized.revision_id != null ? requireRevisionRow(db, tenant, normalized.revision_id) : null;
  if (revision) itemId = revision.item_id;
  updateRow(
    db,
    "pdm_datasets",
    row.id,
    {
      name: normalized.name,
      description: normalized.description,
      dataset_type: normalized.dataset_type,
      owner_user_id: normalized.owner_user_id,
      item_id: itemId,
      revision_id: revision?.id ?? null,
      content_id: normalized.content_id,
      content_type: normalized.content_type,
      content_reference: normalized.content_reference,
      checksum: normalized.checksum,
      size_bytes: normalized.size_bytes,
      metadata_json: JSON.stringify(normalized.metadata || {}),
      version: bumpVersion(row),
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM pdm_datasets WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "DATASET", entityId: row.id, entityRef: row.dataset_ref, action: "UPDATED", version: updated.version, status: updated.status, before, after: publicDataset(updated), actor, ip });
  publishPdmEvent(db, { eventType: pdmEventCode("DATASET_UPDATED"), objectType: "pdm_dataset", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { dataset_ref: updated.dataset_ref } }, actor);
  return publicDataset(updated);
}

// Links content stored in the shared File/Content Storage to a dataset. The
// domain stores only references and metadata, never the payload.
export function linkDatasetContent(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireDatasetRow(db, tenant, ref);
  const contentId = normalizeText(body.content_id ?? body.contentId ?? "", { max: 200 });
  if (!contentId) throw invalidDataset("content_id is required to link dataset content");
  updateRow(
    db,
    "pdm_datasets",
    row.id,
    {
      content_id: contentId,
      content_type: normalizeText(body.content_type ?? body.contentType ?? row.content_type ?? "", { max: 200 }),
      content_reference: normalizeText(body.content_reference ?? body.contentReference ?? row.content_reference ?? "", { max: 1000 }),
      checksum: normalizeText(body.checksum ?? row.checksum ?? "", { max: 200 }),
      size_bytes: body.size_bytes ?? body.sizeBytes ?? row.size_bytes ?? null,
      version: bumpVersion(row),
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM pdm_datasets WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "DATASET", entityId: row.id, entityRef: row.dataset_ref, action: "CONTENT_LINKED", version: updated.version, status: updated.status, before: publicDataset(row), after: publicDataset(updated), actor, ip });
  publishPdmEvent(db, { eventType: pdmEventCode("DATASET_CONTENT_LINKED"), objectType: "pdm_dataset", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { dataset_ref: updated.dataset_ref, content_id: contentId } }, actor);
  return publicDataset(updated);
}

export function setDatasetStatus(db, tenantId, ref, status, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireDatasetRow(db, tenant, ref);
  const next = assertDatasetStatus(status);
  if (!DATASET_STATUSES.includes(next)) throw invalidDataset(`Unsupported dataset status: ${next}`);
  const before = publicDataset(row);
  updateRow(db, "pdm_datasets", row.id, { status: next, lifecycle_state: next, version: bumpVersion(row), updated_by: actor?.id ?? null }, { columns: UPDATE_COLUMNS });
  const updated = queryOne(db, "SELECT * FROM pdm_datasets WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "DATASET", entityId: row.id, entityRef: row.dataset_ref, action: "STATUS_CHANGED", version: updated.version, status: next, before, after: publicDataset(updated), actor, ip });
  return publicDataset(updated);
}

export function deleteDataset(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireDatasetRow(db, tenant, ref);
  if (IMMUTABLE.includes(String(row.status).toUpperCase())) throw datasetImmutable(row.dataset_ref, row.status);
  const before = publicDataset(row);
  run(db, "DELETE FROM pdm_cad_associations WHERE dataset_id = ?", [row.id]);
  run(db, "DELETE FROM pdm_representations WHERE dataset_id = ?", [row.id]);
  run(db, "DELETE FROM pdm_design_data WHERE dataset_id = ?", [row.id]);
  run(db, "DELETE FROM pdm_datasets WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "DATASET", entityId: row.id, entityRef: row.dataset_ref, action: "DELETED", version: row.version, status: row.status, before, actor, ip });
  publishPdmEvent(db, { eventType: pdmEventCode("DATASET_DELETED"), objectType: "pdm_dataset", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { dataset_ref: row.dataset_ref } }, actor);
  return { deleted: true, id: row.id, dataset_ref: row.dataset_ref };
}

export function datasetsForRevision(db, tenantId, revisionId) {
  return queryAll(db, "SELECT * FROM pdm_datasets WHERE tenant_id = ? AND revision_id = ? ORDER BY id", [Number(tenantId), Number(revisionId)]).map(publicDataset);
}
