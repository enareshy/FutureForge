// PDM representation service.
//
// A representation describes a view of an item/revision/dataset (3D, 2D drawing,
// visualization, thumbnail, lightweight, derived). It references a dataset (and
// therefore shared File/Content Storage) rather than duplicating file storage.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow, assertVersion, bumpVersion } from "./sql.js";
import { publicRepresentation } from "./repository.js";
import { representationRef } from "./refs.js";
import { bumpEpoch, invalidate } from "./cache.js";
import { recordChange } from "./history.js";
import { publishPdmEvent, pdmEventCode } from "./events.js";
import { getConfig } from "./configuration.js";
import { requireItemRow } from "./items.js";
import { requireRevisionRow } from "./revisions.js";
import { requireDatasetRow } from "./datasets.js";
import { normalizeRepresentationInput, normalizeText, paginate } from "./validation.js";
import { representationNotFound, invalidRepresentation, pdmConflict } from "./errors.js";
import { SOURCE_MODULE } from "./constants.js";

const UPDATE_COLUMNS = [
  "name",
  "description",
  "representation_type",
  "status",
  "item_id",
  "revision_id",
  "source_object_id",
  "dataset_id",
  "generated",
  "derived_from_id",
  "content_id",
  "metadata_json",
  "version",
  "updated_by",
];

export function getRepresentationRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM pdm_representations WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(db, "SELECT * FROM pdm_representations WHERE tenant_id = ? AND representation_ref = ?", [Number(tenantId), String(ref)]);
}

export function requireRepresentationRow(db, tenantId, ref) {
  const row = getRepresentationRow(db, tenantId, ref);
  if (!row) throw representationNotFound(ref);
  return row;
}

export function getRepresentation(db, tenantId, ref) {
  return publicRepresentation(requireRepresentationRow(db, tenantId, ref));
}

export function listRepresentations(db, { tenantId, itemId, revisionId, datasetId, representationType, status, q, page, pageSize } = {}) {
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
  if (representationType) {
    clauses.push("representation_type = ?");
    params.push(String(representationType).toUpperCase());
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status).toUpperCase());
  }
  if (q) {
    clauses.push("(name LIKE ? OR description LIKE ?)");
    const like = `%${normalizeText(q, { max: 120 })}%`;
    params.push(like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pdm_representations ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pdm_representations ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicRepresentation), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function createRepresentation(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeRepresentationInput(body, {});
  const item = normalized.item_id != null ? requireItemRow(db, tenant, normalized.item_id) : null;
  let revision = normalized.revision_id != null ? requireRevisionRow(db, tenant, normalized.revision_id) : null;
  if (!revision && item?.current_revision_id) revision = requireRevisionRow(db, tenant, item.current_revision_id);
  if (!item && !revision) throw invalidRepresentation("A representation requires an item_id or revision_id");
  if (revision && item && Number(revision.item_id) !== Number(item.id)) throw invalidRepresentation("The revision does not belong to the item");
  if (normalized.dataset_id != null) requireDatasetRow(db, tenant, normalized.dataset_id);
  const itemId = item?.id ?? revision?.item_id ?? null;
  const defaultType = String(getConfig(db, tenant, "default_representation_type") || "3D").toUpperCase();
  const representationType = body.representation_type || body.representationType || body.type ? normalized.representation_type : defaultType;
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO pdm_representations
       (representation_ref, tenant_id, organization_id, item_id, revision_id, source_object_id, dataset_id, name, description,
        representation_type, status, generated, derived_from_id, content_id, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      representationRef(revision?.revision_number ?? item?.item_number ?? ""),
      tenant,
      item?.organization_id ?? revision?.organization_id ?? null,
      itemId,
      revision?.id ?? null,
      normalized.source_object_id,
      normalized.dataset_id,
      normalized.name,
      normalized.description,
      representationType,
      normalized.status,
      normalized.generated ? 1 : 0,
      normalized.derived_from_id,
      normalized.content_id,
      JSON.stringify(normalized.metadata || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM pdm_representations WHERE id = ?", [Number(result.lastInsertRowid)]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REPRESENTATION", entityId: row.id, entityRef: row.representation_ref, action: "CREATED", version: 1, status: row.status, after: publicRepresentation(row), actor, ip, details: { revision_id: row.revision_id, dataset_id: row.dataset_id } });
  publishPdmEvent(db, { eventType: pdmEventCode("REPRESENTATION_CREATED"), objectType: "pdm_representation", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { representation_ref: row.representation_ref, representation_type: row.representation_type } }, actor);
  return publicRepresentation(row);
}

export function updateRepresentation(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRepresentationRow(db, tenant, ref);
  assertVersion(row, body.version ?? body.expected_version ?? body.expectedVersion, (details) =>
    pdmConflict(`PDM representation ${row.representation_ref} was modified by another user`, details));
  const before = publicRepresentation(row);
  const normalized = normalizeRepresentationInput(body, row);
  if (normalized.dataset_id != null) requireDatasetRow(db, tenant, normalized.dataset_id);
  updateRow(
    db,
    "pdm_representations",
    row.id,
    {
      name: normalized.name,
      description: normalized.description,
      representation_type: normalized.representation_type,
      status: normalized.status,
      item_id: normalized.item_id,
      revision_id: normalized.revision_id,
      source_object_id: normalized.source_object_id,
      dataset_id: normalized.dataset_id,
      generated: normalized.generated ? 1 : 0,
      derived_from_id: normalized.derived_from_id,
      content_id: normalized.content_id,
      metadata_json: JSON.stringify(normalized.metadata || {}),
      version: bumpVersion(row),
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM pdm_representations WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REPRESENTATION", entityId: row.id, entityRef: row.representation_ref, action: "UPDATED", version: updated.version, status: updated.status, before, after: publicRepresentation(updated), actor, ip });
  return publicRepresentation(updated);
}

export function deleteRepresentation(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRepresentationRow(db, tenant, ref);
  const before = publicRepresentation(row);
  run(db, "DELETE FROM pdm_representations WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REPRESENTATION", entityId: row.id, entityRef: row.representation_ref, action: "DELETED", version: row.version, status: row.status, before, actor, ip });
  publishPdmEvent(db, { eventType: pdmEventCode("REPRESENTATION_DELETED"), objectType: "pdm_representation", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { representation_ref: row.representation_ref } }, actor);
  return { deleted: true, id: row.id, representation_ref: row.representation_ref };
}

export function representationsForRevision(db, tenantId, revisionId) {
  return queryAll(db, "SELECT * FROM pdm_representations WHERE tenant_id = ? AND revision_id = ? ORDER BY id", [Number(tenantId), Number(revisionId)]).map(publicRepresentation);
}
