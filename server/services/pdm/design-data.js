// PDM design data service.
//
// Design data is the reusable engineering-information abstraction associated
// with an item revision (CAD model, drawing, specification, visualization and
// other). It links a revision to a dataset and/or representation and is
// extensible through metadata and the shared Object & Relationship Framework.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow, assertVersion, bumpVersion } from "./sql.js";
import { publicDesignData } from "./repository.js";
import { designDataRef } from "./refs.js";
import { bumpEpoch, invalidate } from "./cache.js";
import { recordChange } from "./history.js";
import { publishPdmEvent, pdmEventCode } from "./events.js";
import { requireItemRow } from "./items.js";
import { requireRevisionRow } from "./revisions.js";
import { requireDatasetRow } from "./datasets.js";
import { requireRepresentationRow } from "./representations.js";
import { normalizeDesignDataInput, normalizeText, paginate } from "./validation.js";
import { designDataNotFound, invalidDesignData, pdmConflict } from "./errors.js";
import { SOURCE_MODULE } from "./constants.js";

const UPDATE_COLUMNS = [
  "code",
  "name",
  "description",
  "data_type",
  "status",
  "category",
  "external_reference",
  "item_id",
  "revision_id",
  "dataset_id",
  "representation_id",
  "object_id",
  "metadata_json",
  "version",
  "updated_by",
];

export function getDesignDataRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM pdm_design_data WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(db, "SELECT * FROM pdm_design_data WHERE tenant_id = ? AND (design_data_ref = ? OR code = ? COLLATE NOCASE)", [Number(tenantId), String(ref), String(ref)]);
}

export function requireDesignDataRow(db, tenantId, ref) {
  const row = getDesignDataRow(db, tenantId, ref);
  if (!row) throw designDataNotFound(ref);
  return row;
}

export function getDesignData(db, tenantId, ref) {
  return publicDesignData(requireDesignDataRow(db, tenantId, ref));
}

export function listDesignData(db, { tenantId, itemId, revisionId, datasetId, dataType, status, q, page, pageSize } = {}) {
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
  if (datasetId != null) {
    clauses.push("dataset_id = ?");
    params.push(Number(datasetId));
  }
  if (dataType) {
    clauses.push("data_type = ?");
    params.push(String(dataType).toUpperCase());
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status).toUpperCase());
  }
  if (q) {
    clauses.push("(code LIKE ? OR name LIKE ? OR description LIKE ? OR external_reference LIKE ?)");
    const like = `%${normalizeText(q, { max: 120 })}%`;
    params.push(like, like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pdm_design_data ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pdm_design_data ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicDesignData), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

function resolveContext(db, tenantId, normalized) {
  const item = normalized.item_id != null ? requireItemRow(db, tenantId, normalized.item_id) : null;
  let revision = normalized.revision_id != null ? requireRevisionRow(db, tenantId, normalized.revision_id) : null;
  if (!revision && item?.current_revision_id) revision = requireRevisionRow(db, tenantId, item.current_revision_id);
  if (revision && item && Number(revision.item_id) !== Number(item.id)) throw invalidDesignData("The revision does not belong to the item");
  return { item, revision, itemId: item?.id ?? revision?.item_id ?? null };
}

export function createDesignData(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeDesignDataInput(body, {});
  const { item, revision, itemId } = resolveContext(db, tenant, normalized);
  if (normalized.dataset_id != null) requireDatasetRow(db, tenant, normalized.dataset_id);
  if (normalized.representation_id != null) requireRepresentationRow(db, tenant, normalized.representation_id);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO pdm_design_data
       (design_data_ref, tenant_id, organization_id, item_id, revision_id, dataset_id, representation_id, code, name, description,
        data_type, status, category, external_reference, object_id, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1, ?, ?, ?, ?)`,
    [
      designDataRef(normalized.code || revision?.revision_ref || item?.item_number || ""),
      tenant,
      item?.organization_id ?? revision?.organization_id ?? null,
      itemId,
      revision?.id ?? null,
      normalized.dataset_id,
      normalized.representation_id,
      normalized.code,
      normalized.name,
      normalized.description,
      normalized.data_type,
      normalized.status,
      normalized.category,
      normalized.external_reference,
      JSON.stringify(normalized.metadata || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM pdm_design_data WHERE id = ?", [Number(result.lastInsertRowid)]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "DESIGN_DATA", entityId: row.id, entityRef: row.design_data_ref, action: "LINKED", version: 1, status: row.status, after: publicDesignData(row), actor, ip, details: { revision_id: row.revision_id, dataset_id: row.dataset_id } });
  publishPdmEvent(db, { eventType: pdmEventCode("DESIGN_DATA_LINKED"), objectType: "pdm_design_data", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { design_data_ref: row.design_data_ref, data_type: row.data_type } }, actor);
  return publicDesignData(row);
}

export function updateDesignData(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireDesignDataRow(db, tenant, ref);
  assertVersion(row, body.version ?? body.expected_version ?? body.expectedVersion, (details) =>
    pdmConflict(`PDM design data ${row.design_data_ref} was modified by another user`, details));
  const before = publicDesignData(row);
  const normalized = normalizeDesignDataInput(body, row);
  if (normalized.dataset_id != null) requireDatasetRow(db, tenant, normalized.dataset_id);
  if (normalized.representation_id != null) requireRepresentationRow(db, tenant, normalized.representation_id);
  updateRow(
    db,
    "pdm_design_data",
    row.id,
    {
      code: normalized.code,
      name: normalized.name,
      description: normalized.description,
      data_type: normalized.data_type,
      status: normalized.status,
      category: normalized.category,
      external_reference: normalized.external_reference,
      item_id: normalized.item_id,
      revision_id: normalized.revision_id,
      dataset_id: normalized.dataset_id,
      representation_id: normalized.representation_id,
      metadata_json: JSON.stringify(normalized.metadata || {}),
      version: bumpVersion(row),
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM pdm_design_data WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "DESIGN_DATA", entityId: row.id, entityRef: row.design_data_ref, action: "UPDATED", version: updated.version, status: updated.status, before, after: publicDesignData(updated), actor, ip });
  return publicDesignData(updated);
}

export function deleteDesignData(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireDesignDataRow(db, tenant, ref);
  const before = publicDesignData(row);
  run(db, "DELETE FROM pdm_design_data WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "DESIGN_DATA", entityId: row.id, entityRef: row.design_data_ref, action: "UNLINKED", version: row.version, status: row.status, before, actor, ip });
  publishPdmEvent(db, { eventType: pdmEventCode("DESIGN_DATA_UNLINKED"), objectType: "pdm_design_data", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { design_data_ref: row.design_data_ref } }, actor);
  return { deleted: true, id: row.id, design_data_ref: row.design_data_ref };
}

export function designDataForRevision(db, tenantId, revisionId) {
  return queryAll(db, "SELECT * FROM pdm_design_data WHERE tenant_id = ? AND revision_id = ? ORDER BY id", [Number(tenantId), Number(revisionId)]).map(publicDesignData);
}
