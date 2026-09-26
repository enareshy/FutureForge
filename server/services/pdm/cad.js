// PDM CAD association service.
//
// A CAD association relates an item revision (or source object) to a CAD dataset
// with an explicit association type (MASTER, DRAWING, DERIVED, REFERENCE,
// VISUALIZATION, SIMPLIFIED), a CAD type and a primary/secondary indicator. It is
// vendor-neutral: integrations live in the Integration & API Framework, not here.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow, assertVersion, bumpVersion } from "./sql.js";
import { publicCadAssociation } from "./repository.js";
import { cadAssociationRef } from "./refs.js";
import { bumpEpoch, invalidate } from "./cache.js";
import { recordChange } from "./history.js";
import { publishPdmEvent, pdmEventCode } from "./events.js";
import { getConfig } from "./configuration.js";
import { requireItemRow } from "./items.js";
import { requireRevisionRow } from "./revisions.js";
import { requireDatasetRow } from "./datasets.js";
import { recordReference, removeReference } from "./references.js";
import { normalizeCadAssociationInput, normalizeText, paginate } from "./validation.js";
import { cadAssociationNotFound, cadAssociationConflict, invalidCadAssociation, pdmConflict } from "./errors.js";
import { SOURCE_MODULE } from "./constants.js";

const UPDATE_COLUMNS = [
  "item_id",
  "source_revision_id",
  "source_object_id",
  "dataset_id",
  "cad_type",
  "association_type",
  "is_primary",
  "status",
  "application",
  "metadata_json",
  "version",
  "updated_by",
];

export function getCadAssociationRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM pdm_cad_associations WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(db, "SELECT * FROM pdm_cad_associations WHERE tenant_id = ? AND association_ref = ?", [Number(tenantId), String(ref)]);
}

export function requireCadAssociationRow(db, tenantId, ref) {
  const row = getCadAssociationRow(db, tenantId, ref);
  if (!row) throw cadAssociationNotFound(ref);
  return row;
}

export function getCadAssociation(db, tenantId, ref) {
  return publicCadAssociation(requireCadAssociationRow(db, tenantId, ref));
}

export function listCadAssociations(db, { tenantId, itemId, sourceRevisionId, datasetId, associationType, cadType, status, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (itemId != null) {
    clauses.push("item_id = ?");
    params.push(Number(itemId));
  }
  if (sourceRevisionId != null) {
    clauses.push("source_revision_id = ?");
    params.push(Number(sourceRevisionId));
  }
  if (datasetId != null) {
    clauses.push("dataset_id = ?");
    params.push(Number(datasetId));
  }
  if (associationType) {
    clauses.push("association_type = ?");
    params.push(String(associationType).toUpperCase());
  }
  if (cadType) {
    clauses.push("cad_type = ?");
    params.push(String(cadType).toUpperCase());
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status).toUpperCase());
  }
  if (q) {
    clauses.push("(application LIKE ? OR source_object_id LIKE ? OR association_ref LIKE ?)");
    const like = `%${normalizeText(q, { max: 120 })}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pdm_cad_associations ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pdm_cad_associations ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicCadAssociation), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function createCadAssociation(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeCadAssociationInput(body, {});
  if (normalized.dataset_id == null) throw invalidCadAssociation("dataset_id is required");
  const dataset = requireDatasetRow(db, tenant, normalized.dataset_id);
  let item = normalized.item_id != null ? requireItemRow(db, tenant, normalized.item_id) : null;
  let revision = normalized.source_revision_id != null ? requireRevisionRow(db, tenant, normalized.source_revision_id) : null;
  if (revision && !item) item = requireItemRow(db, tenant, revision.item_id);
  if (revision && item && Number(revision.item_id) !== Number(item.id)) throw invalidCadAssociation("The source revision does not belong to the item");
  if (!item && !revision) throw invalidCadAssociation("A CAD association requires an item_id or source_revision_id");

  const allowDuplicate = getConfig(db, tenant, "allow_duplicate_cad_associations") === true;
  if (!allowDuplicate) {
    const duplicate = queryOne(
      db,
      "SELECT id FROM pdm_cad_associations WHERE tenant_id = ? AND dataset_id = ? AND association_type = ? AND (source_revision_id IS ? OR source_revision_id = ?)",
      [tenant, normalized.dataset_id, normalized.association_type, revision?.id ?? null, revision?.id ?? null]
    );
    if (duplicate) throw cadAssociationConflict({ dataset_id: normalized.dataset_id, association_type: normalized.association_type });
  }
  if (normalized.is_primary && revision) {
    const existingPrimary = queryOne(
      db,
      "SELECT id FROM pdm_cad_associations WHERE tenant_id = ? AND source_revision_id = ? AND association_type = ? AND is_primary = 1 AND status = 'ACTIVE'",
      [tenant, revision.id, normalized.association_type]
    );
    if (existingPrimary) {
      updateRow(db, "pdm_cad_associations", existingPrimary.id, { is_primary: 0, version: 1 }, { columns: ["is_primary", "version"] });
    }
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO pdm_cad_associations
       (association_ref, tenant_id, organization_id, item_id, source_revision_id, source_object_id, dataset_id, cad_type, association_type,
        is_primary, status, application, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      cadAssociationRef(revision?.id ?? item?.item_number ?? ""),
      tenant,
      item?.organization_id ?? revision?.organization_id ?? null,
      item?.id ?? null,
      revision?.id ?? null,
      normalized.source_object_id,
      dataset.id,
      normalized.cad_type,
      normalized.association_type,
      normalized.is_primary ? 1 : 0,
      normalized.status,
      normalized.application,
      JSON.stringify(normalized.metadata || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM pdm_cad_associations WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordReference(db, tenant, {
    source_type: "CAD_ASSOCIATION",
    source_id: String(row.id),
    source_ref: row.association_ref,
    target_type: "DATASET",
    target_id: String(row.dataset_id),
    target_ref: dataset.dataset_ref,
    category: "CAD",
    relationship_type: row.association_type,
    organization_id: row.organization_id,
  });
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "CAD_ASSOCIATION", entityId: row.id, entityRef: row.association_ref, action: "CREATED", version: 1, status: row.status, after: publicCadAssociation(row), actor, ip, details: { dataset_id: row.dataset_id, revision_id: row.source_revision_id } });
  publishPdmEvent(db, { eventType: pdmEventCode("CAD_CREATED"), objectType: "pdm_cad_association", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { association_ref: row.association_ref, association_type: row.association_type, dataset_id: row.dataset_id } }, actor);
  return publicCadAssociation(row);
}

export function updateCadAssociation(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireCadAssociationRow(db, tenant, ref);
  assertVersion(row, body.version ?? body.expected_version ?? body.expectedVersion, (details) =>
    pdmConflict(`PDM CAD association ${row.association_ref} was modified by another user`, details));
  const before = publicCadAssociation(row);
  const normalized = normalizeCadAssociationInput(body, row);
  if (normalized.dataset_id != null) requireDatasetRow(db, tenant, normalized.dataset_id);
  if (normalized.is_primary && row.source_revision_id) {
    run(
      db,
      "UPDATE pdm_cad_associations SET is_primary = 0, updated_at = ? WHERE tenant_id = ? AND source_revision_id = ? AND association_type = ? AND id <> ?",
      [nowIso(), tenant, row.source_revision_id, normalized.association_type, row.id]
    );
  }
  updateRow(
    db,
    "pdm_cad_associations",
    row.id,
    {
      item_id: normalized.item_id,
      source_revision_id: normalized.source_revision_id,
      source_object_id: normalized.source_object_id,
      dataset_id: normalized.dataset_id,
      cad_type: normalized.cad_type,
      association_type: normalized.association_type,
      is_primary: normalized.is_primary ? 1 : 0,
      status: normalized.status,
      application: normalized.application,
      metadata_json: JSON.stringify(normalized.metadata || {}),
      version: bumpVersion(row),
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM pdm_cad_associations WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "CAD_ASSOCIATION", entityId: row.id, entityRef: row.association_ref, action: "UPDATED", version: updated.version, status: updated.status, before, after: publicCadAssociation(updated), actor, ip });
  return publicCadAssociation(updated);
}

export function deleteCadAssociation(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireCadAssociationRow(db, tenant, ref);
  const before = publicCadAssociation(row);
  removeReference(db, tenant, { source_type: "CAD_ASSOCIATION", source_id: String(row.id), target_type: "DATASET", target_id: String(row.dataset_id), category: "CAD" });
  run(db, "DELETE FROM pdm_cad_associations WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "CAD_ASSOCIATION", entityId: row.id, entityRef: row.association_ref, action: "REMOVED", version: row.version, status: row.status, before, actor, ip });
  publishPdmEvent(db, { eventType: pdmEventCode("CAD_REMOVED"), objectType: "pdm_cad_association", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { association_ref: row.association_ref } }, actor);
  return { deleted: true, id: row.id, association_ref: row.association_ref };
}

export function cadAssociationsForRevision(db, tenantId, revisionId) {
  return queryAll(db, "SELECT * FROM pdm_cad_associations WHERE tenant_id = ? AND source_revision_id = ? ORDER BY id", [Number(tenantId), Number(revisionId)]).map(publicCadAssociation);
}

export function primaryCadForRevision(db, tenantId, revisionId, associationType = null) {
  const clauses = ["tenant_id = ?", "source_revision_id = ?", "status = 'ACTIVE'"];
  const params = [Number(tenantId), Number(revisionId)];
  if (associationType) {
    clauses.push("association_type = ?");
    params.push(String(associationType).toUpperCase());
  }
  const row = queryOne(db, `SELECT * FROM pdm_cad_associations WHERE ${clauses.join(" AND ")} ORDER BY is_primary DESC, id ASC LIMIT 1`, params);
  return publicCadAssociation(row);
}
