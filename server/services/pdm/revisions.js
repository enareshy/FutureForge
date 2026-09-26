// PDM item revision service.
//
// A revision is a versioned, effectivity-scoped representation of an item.
// Lifecycle is data-driven (DEFAULT_REVISION_TRANSITIONS) and every status
// change emits an event and is recorded in history and the central audit engine.
// Released revisions are immutable: a new revision must be created.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow, assertVersion, bumpVersion } from "./sql.js";
import { publicRevision } from "./repository.js";
import { revisionRef } from "./refs.js";
import { bumpEpoch, invalidate } from "./cache.js";
import { recordChange } from "./history.js";
import { publishPdmEvent, pdmEventCode } from "./events.js";
import { getConfig } from "./configuration.js";
import { getItemRow, requireItemRow } from "./items.js";
import {
  assertRevisionStatus,
  assertRevisionTransition,
  allowedRevisionTransitions,
  normalizeRevisionInput,
  normalizeText,
  normalizeUpper,
  paginate,
} from "./validation.js";
import { revisionNotFound, revisionConflict, revisionImmutable, invalidRevision, pdmConflict } from "./errors.js";
import { SOURCE_MODULE, DEFAULT_REVISION_TRANSITIONS, IMMUTABLE_REVISION_STATUSES } from "./constants.js";
import { bridgeCreateObject } from "./bridge.js";

const UPDATE_COLUMNS = [
  "description",
  "valid_from",
  "valid_to",
  "effectivity_json",
  "configuration_context",
  "variant_id",
  "variant_code",
  "baseline_id",
  "owner_user_id",
  "metadata_json",
  "attributes_json",
  "object_id",
  "status",
  "lifecycle_state",
  "version",
  "updated_by",
];

export function getRevisionRow(db, tenantId, ref, { itemId = null } = {}) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM pdm_item_revisions WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  if (itemId != null) {
    const byNumber = queryOne(
      db,
      "SELECT * FROM pdm_item_revisions WHERE tenant_id = ? AND item_id = ? AND revision_number = ? COLLATE NOCASE",
      [Number(tenantId), Number(itemId), String(ref)]
    );
    if (byNumber) return byNumber;
  }
  return queryOne(
    db,
    "SELECT * FROM pdm_item_revisions WHERE tenant_id = ? AND (revision_ref = ? OR revision_number = ? COLLATE NOCASE) ORDER BY revision_sequence DESC LIMIT 1",
    [Number(tenantId), String(ref), String(ref)]
  );
}

export function requireRevisionRow(db, tenantId, ref, options = {}) {
  const row = getRevisionRow(db, tenantId, ref, options);
  if (!row) throw revisionNotFound(ref);
  return row;
}

export function getRevision(db, tenantId, ref, options = {}) {
  return publicRevision(requireRevisionRow(db, tenantId, ref, options));
}

export function listRevisions(db, { tenantId, itemId, itemRef, status, variantId, variantCode, q, page, pageSize, sort, order } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  let resolvedItemId = itemId != null ? Number(itemId) : null;
  if (resolvedItemId == null && itemRef) {
    const item = getItemRow(db, tenantId, itemRef);
    if (!item) return { items: [], total: 0, page: 1, page_size: 50, source_module: SOURCE_MODULE };
    resolvedItemId = item.id;
  }
  if (resolvedItemId != null) {
    clauses.push("item_id = ?");
    params.push(resolvedItemId);
  }
  if (status) {
    clauses.push("status = ?");
    params.push(assertRevisionStatus(status));
  }
  if (variantId != null) {
    clauses.push("variant_id = ?");
    params.push(Number(variantId));
  }
  if (variantCode) {
    clauses.push("variant_code = ?");
    params.push(normalizeUpper(variantCode, { max: 120 }));
  }
  if (q) {
    clauses.push("(revision_number LIKE ? OR description LIKE ? OR configuration_context LIKE ?)");
    const like = `%${normalizeText(q, { max: 120 })}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const allowedSort = ["id", "revision_number", "revision_sequence", "status", "created_at", "updated_at"];
  const column = allowedSort.includes(String(sort)) ? String(sort) : "revision_sequence";
  const direction = String(order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM pdm_item_revisions ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM pdm_item_revisions ${where} ORDER BY ${column} ${direction} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicRevision), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

function nextSequence(db, itemId) {
  return Number(queryOne(db, "SELECT COALESCE(MAX(revision_sequence), 0) AS s FROM pdm_item_revisions WHERE item_id = ?", [Number(itemId)])?.s || 0) + 1;
}

export function createRevision(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const item = requireItemRow(db, tenant, ref);
  const normalized = normalizeRevisionInput(body, {});
  const enforceUnique = getConfig(db, tenant, "enforce_unique_revision_number") !== false;
  if (enforceUnique) {
    const existing = queryOne(db, "SELECT id FROM pdm_item_revisions WHERE item_id = ? AND revision_number = ?", [item.id, normalized.revision_number]);
    if (existing) throw revisionConflict(item.id, normalized.revision_number);
  }
  const ts = nowIso();
  const sequence = nextSequence(db, item.id);
  const defaultStatus = String(getConfig(db, tenant, "default_revision_status") || "DRAFT").toUpperCase();
  const status = normalized.status || (["DRAFT", "IN_WORK", "IN_REVIEW", "RELEASED", "OBSOLETE"].includes(defaultStatus) ? defaultStatus : "DRAFT");
  const result = run(
    db,
    `INSERT INTO pdm_item_revisions
       (revision_ref, tenant_id, organization_id, item_id, revision_number, revision_sequence, description, status, lifecycle_state,
        valid_from, valid_to, effectivity_json, configuration_context, variant_id, variant_code, baseline_id,
        owner_user_id, metadata_json, attributes_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      revisionRef(item.item_number, normalized.revision_number),
      tenant,
      item.organization_id,
      item.id,
      normalized.revision_number,
      sequence,
      normalized.description,
      status,
      status,
      normalized.valid_from,
      normalized.valid_to,
      JSON.stringify(normalized.effectivity || {}),
      normalized.configuration_context,
      normalized.variant_id,
      normalized.variant_code,
      normalized.baseline_id,
      normalized.owner_user_id ?? item.owner_user_id ?? null,
      JSON.stringify(normalized.metadata || {}),
      JSON.stringify(normalized.attributes || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM pdm_item_revisions WHERE id = ?", [Number(result.lastInsertRowid)]);
  const objectId = bridgeCreateObject(
    db,
    {
      type: "pdm_item_revision",
      code: row.revision_ref,
      name: `${item.item_number} ${row.revision_number}`,
      description: row.description,
      data: { item_id: item.id, revision_number: row.revision_number },
      status: row.status,
      organizationId: row.organization_id,
    },
    actor,
    tenant,
    ip
  );
  if (objectId) updateRow(db, "pdm_item_revisions", row.id, { object_id: objectId }, { columns: ["object_id"] });
  if (!item.current_revision_id) {
    updateRow(db, "pdm_items", item.id, { current_revision_id: row.id, updated_by: actor?.id ?? null }, { columns: ["current_revision_id", "updated_by"] });
  }
  const finalRow = queryOne(db, "SELECT * FROM pdm_item_revisions WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REVISION", entityId: row.id, entityRef: row.revision_ref, action: "CREATED", version: 1, status, after: publicRevision(finalRow), actor, ip, details: { item_id: item.id, item_ref: item.item_ref } });
  publishPdmEvent(db, { eventType: pdmEventCode("REVISION_CREATED"), objectType: "pdm_item_revision", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { item_ref: item.item_ref, revision_ref: row.revision_ref, revision_number: row.revision_number } }, actor);
  return publicRevision(finalRow);
}

export function updateRevision(db, tenantId, ref, body = {}, actor = null, ip = null, options = {}) {
  const tenant = Number(tenantId);
  const row = requireRevisionRow(db, tenant, ref, options);
  assertRevisionEditable(db, tenant, row);
  assertVersion(row, body.version ?? body.expected_version ?? body.expectedVersion, (details) =>
    pdmConflict(`PDM revision ${row.revision_ref} was modified by another user`, details));
  const before = publicRevision(row);
  const normalized = normalizeRevisionInput(body, row);
  updateRow(
    db,
    "pdm_item_revisions",
    row.id,
    {
      description: normalized.description,
      valid_from: normalized.valid_from,
      valid_to: normalized.valid_to,
      effectivity_json: JSON.stringify(normalized.effectivity || {}),
      configuration_context: normalized.configuration_context,
      variant_id: normalized.variant_id,
      variant_code: normalized.variant_code,
      baseline_id: normalized.baseline_id,
      owner_user_id: normalized.owner_user_id,
      metadata_json: JSON.stringify(normalized.metadata || {}),
      attributes_json: JSON.stringify(normalized.attributes || {}),
      version: bumpVersion(row),
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM pdm_item_revisions WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REVISION", entityId: row.id, entityRef: row.revision_ref, action: "UPDATED", version: updated.version, status: updated.status, before, after: publicRevision(updated), actor, ip });
  publishPdmEvent(db, { eventType: pdmEventCode("REVISION_REVISED"), objectType: "pdm_item_revision", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { revision_ref: updated.revision_ref } }, actor);
  return publicRevision(updated);
}

export function setRevisionStatus(db, tenantId, ref, status, actor = null, ip = null, options = {}) {
  const tenant = Number(tenantId);
  const row = requireRevisionRow(db, tenant, ref, options);
  const target = assertRevisionStatus(status);
  assertRevisionTransition(row.status, target, DEFAULT_REVISION_TRANSITIONS);
  const before = publicRevision(row);
  updateRow(db, "pdm_item_revisions", row.id, { status: target, lifecycle_state: target, version: bumpVersion(row), updated_by: actor?.id ?? null }, { columns: UPDATE_COLUMNS });
  const updated = queryOne(db, "SELECT * FROM pdm_item_revisions WHERE id = ?", [row.id]);
  if (target === "RELEASED") {
    run(db, "UPDATE pdm_items SET status = 'RELEASED', lifecycle_state = 'RELEASED', current_revision_id = ?, version = version + 1, updated_at = ? WHERE id = ?", [row.id, nowIso(), row.item_id]);
  }
  bumpEpoch(tenant);
  invalidate(tenant);
  const action = target === "RELEASED" ? "RELEASED" : "STATUS_CHANGED";
  recordChange(db, { tenantId: tenant, entityType: "REVISION", entityId: row.id, entityRef: row.revision_ref, action, version: updated.version, status: target, before, after: publicRevision(updated), actor, ip, details: { from: row.status, to: target, allowed: allowedRevisionTransitions(row.status) } });
  publishPdmEvent(db, { eventType: target === "RELEASED" ? pdmEventCode("REVISION_RELEASED") : pdmEventCode("REVISION_STATUS_CHANGED"), objectType: "pdm_item_revision", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { revision_ref: updated.revision_ref, from: row.status, to: target } }, actor);
  return publicRevision(updated);
}

// Creates the next revision by cloning the source revision's metadata and
// re-pointing the item's datasets and CAD links. This is the "revise" operation
// used after a revision is released.
export function reviseRevision(db, tenantId, ref, body = {}, actor = null, ip = null, options = {}) {
  const tenant = Number(tenantId);
  const source = requireRevisionRow(db, tenant, ref, options);
  const nextNumber =
    normalizeText(body.revision_number ?? body.revisionNumber ?? "", { max: 60 }) || suggestNextRevisionNumber(source.revision_number);
  const created = createRevision(
    db,
    tenant,
    source.item_id,
    {
      revision_number: nextNumber,
      description: body.description ?? source.description,
      status: body.status || "DRAFT",
      valid_from: body.valid_from ?? source.valid_from,
      valid_to: body.valid_to ?? source.valid_to,
      effectivity: body.effectivity ?? JSON.parse(source.effectivity_json || "{}"),
      configuration_context: body.configuration_context ?? source.configuration_context,
      variant_id: body.variant_id ?? source.variant_id,
      variant_code: body.variant_code ?? source.variant_code,
      metadata: body.metadata ?? JSON.parse(source.metadata_json || "{}"),
      attributes: body.attributes ?? JSON.parse(source.attributes_json || "{}"),
    },
    actor,
    ip
  );
  const target = requireRevisionRow(db, tenant, created.id);
  const copied = { datasets: 0, cad_associations: 0, design_data: 0, representations: 0 };
  const now = nowIso();
  const datasets = queryAll(db, "SELECT * FROM pdm_datasets WHERE tenant_id = ? AND revision_id = ?", [tenant, source.id]);
  for (const dataset of datasets) {
    run(
      db,
      `INSERT INTO pdm_datasets
         (dataset_ref, tenant_id, organization_id, item_id, revision_id, object_id, dataset_number, name, description, dataset_type, status,
          lifecycle_state, owner_user_id, content_id, content_type, content_reference, checksum, size_bytes, metadata_json, version, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [dataset.dataset_ref, dataset.tenant_id, dataset.organization_id, dataset.item_id, target.id, dataset.dataset_number, dataset.name,
        dataset.description, dataset.dataset_type, "DRAFT", "DRAFT", dataset.owner_user_id, dataset.content_id, dataset.content_type,
        dataset.content_reference, dataset.checksum, dataset.size_bytes, dataset.metadata_json, actor?.id ?? null, actor?.id ?? null, now, now]
    );
    copied.datasets += 1;
  }
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REVISION", entityId: target.id, entityRef: target.revision_ref, action: "REVISED_FROM", version: target.version, status: target.status, after: { source_revision_id: source.id, ...copied }, actor, ip });
  return { revision: publicRevision(target), copied, source_revision_id: source.id };
}

export function deleteRevision(db, tenantId, ref, actor = null, ip = null, options = {}) {
  const tenant = Number(tenantId);
  const row = requireRevisionRow(db, tenant, ref, options);
  const before = publicRevision(row);
  run(db, "DELETE FROM pdm_cad_associations WHERE source_revision_id = ?", [row.id]);
  run(db, "DELETE FROM pdm_representations WHERE revision_id = ?", [row.id]);
  run(db, "DELETE FROM pdm_design_data WHERE revision_id = ?", [row.id]);
  run(db, "DELETE FROM pdm_datasets WHERE revision_id = ?", [row.id]);
  run(db, "DELETE FROM pdm_item_revisions WHERE id = ?", [row.id]);
  const item = queryOne(db, "SELECT * FROM pdm_items WHERE id = ?", [row.item_id]);
  if (item && Number(item.current_revision_id) === Number(row.id)) {
    const next = queryOne(db, "SELECT id FROM pdm_item_revisions WHERE item_id = ? ORDER BY revision_sequence DESC LIMIT 1", [row.item_id]);
    updateRow(db, "pdm_items", item.id, { current_revision_id: next?.id ?? null, updated_by: actor?.id ?? null }, { columns: ["current_revision_id", "updated_by"] });
  }
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REVISION", entityId: row.id, entityRef: row.revision_ref, action: "DELETED", version: row.version, status: row.status, before, actor, ip });
  return { deleted: true, id: row.id, revision_ref: row.revision_ref };
}

// True when a revision may no longer be edited in place. Centralized so every
// write path (item, dataset, CAD, design data) applies the same rule.
export function isRevisionEditable(db, tenantId, row) {
  if (!row) return false;
  const immutable = getConfig(db, tenantId, "immutable_released_revisions") !== false;
  if (!immutable) return true;
  return !IMMUTABLE_REVISION_STATUSES.includes(String(row.status).toUpperCase());
}

export function assertRevisionEditable(db, tenantId, row) {
  if (!isRevisionEditable(db, tenantId, row)) throw revisionImmutable(row.revision_ref, row.status);
}

// Creates the first revision for an item when configured to auto-create.
export function ensureInitialRevision(db, tenantId, itemRow, actor = null, ip = null) {
  if (getConfig(db, tenantId, "auto_create_initial_revision") === false) return null;
  const existing = queryOne(db, "SELECT * FROM pdm_item_revisions WHERE item_id = ? ORDER BY revision_sequence LIMIT 1", [itemRow.id]);
  if (existing) return publicRevision(existing);
  return createRevision(db, tenantId, itemRow.id, { revision_number: "A" }, actor, ip);
}

function suggestNextRevisionNumber(current) {
  const text = String(current || "A").trim();
  if (/^[A-Z]$/.test(text)) {
    const code = text.charCodeAt(0);
    if (code < 90) return String.fromCharCode(code + 1);
    return `${text}1`;
  }
  const numeric = text.match(/^(.*?)(\d+)$/);
  if (numeric) return `${numeric[1]}${Number(numeric[2]) + 1}`;
  return `${text}.1`;
}
