// BOM revision service.
//
// A revision is a versioned, effectivity-scoped snapshot container for lines.
// Lifecycle is data-driven (DEFAULT_REVISION_TRANSITIONS) and every status change
// emits an event and is recorded in history and the central audit engine.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow } from "./sql.js";
import { publicRevision } from "./repository.js";
import { revisionRef, lineRef } from "./refs.js";
import { bumpEpoch } from "./cache.js";
import { invalidate } from "./cache.js";
import { recordChange } from "./history.js";
import { publishBomEvent, bomEventCode } from "./events.js";
import { getConfig } from "./configuration.js";
import { getBomRow, requireBomRow } from "./definitions.js";
import {
  assertRevisionStatus,
  assertRevisionTransition,
  allowedRevisionTransitions,
  normalizeRevisionInput,
  normalizeText,
  normalizeUpper,
  paginate,
} from "./validation.js";
import { revisionNotFound, revisionConflict, revisionImmutable, lineImmutable } from "./errors.js";
import { SOURCE_MODULE, DEFAULT_REVISION_TRANSITIONS } from "./constants.js";

const UPDATE_COLUMNS = ["valid_from", "valid_to", "effectivity_json", "configuration_context", "variant_id", "variant_code", "baseline_id", "owner_user_id", "metadata_json", "version", "updated_by", "status", "lifecycle_state"];

export function getRevisionRow(db, tenantId, ref, { bomId = null } = {}) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM bom_revisions WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  if (bomId != null) {
    const byNumber = queryOne(
      db,
      "SELECT * FROM bom_revisions WHERE tenant_id = ? AND bom_id = ? AND revision_number = ? COLLATE NOCASE",
      [Number(tenantId), Number(bomId), String(ref)]
    );
    if (byNumber) return byNumber;
  }
  return queryOne(
    db,
    "SELECT * FROM bom_revisions WHERE tenant_id = ? AND (revision_ref = ? OR revision_number = ? COLLATE NOCASE) ORDER BY revision_sequence DESC LIMIT 1",
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

export function listRevisions(db, { tenantId, bomId, bomRef, status, variantId, variantCode, q, page, pageSize, sort, order } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  let resolvedBomId = bomId != null ? Number(bomId) : null;
  if (resolvedBomId == null && bomRef) {
    const header = getBomRow(db, tenantId, bomRef);
    if (!header) return { items: [], total: 0, page: 1, page_size: 50, source_module: SOURCE_MODULE };
    resolvedBomId = header.id;
  }
  if (resolvedBomId != null) {
    clauses.push("bom_id = ?");
    params.push(resolvedBomId);
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
    clauses.push("(revision_number LIKE ? OR configuration_context LIKE ?)");
    const like = `%${normalizeText(q, { max: 120 })}%`;
    params.push(like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const allowedSort = ["id", "revision_number", "revision_sequence", "status", "created_at", "updated_at"];
  const column = allowedSort.includes(String(sort)) ? String(sort) : "revision_sequence";
  const direction = String(order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM bom_revisions ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM bom_revisions ${where} ORDER BY ${column} ${direction} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicRevision), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

function nextSequence(db, bomId) {
  return Number(queryOne(db, "SELECT COALESCE(MAX(revision_sequence), 0) AS s FROM bom_revisions WHERE bom_id = ?", [Number(bomId)])?.s || 0) + 1;
}

export function createRevision(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const header = requireBomRow(db, tenant, ref);
  const normalized = normalizeRevisionInput(body, {});
  const existing = queryOne(db, "SELECT id FROM bom_revisions WHERE bom_id = ? AND revision_number = ?", [header.id, normalized.revision_number]);
  if (existing) throw revisionConflict(header.id, normalized.revision_number);
  const ts = nowIso();
  const sequence = nextSequence(db, header.id);
  const config = { default_revision_status: getConfig(db, tenant, "default_revision_status") };
  const status = normalized.status || normalizeUpper(config.default_revision_status) || "DRAFT";
  const result = run(
    db,
    `INSERT INTO bom_revisions
       (revision_ref, tenant_id, organization_id, bom_id, revision_number, revision_sequence, status, lifecycle_state,
        valid_from, valid_to, effectivity_json, configuration_context, variant_id, variant_code, baseline_id,
        owner_user_id, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      revisionRef(header.bom_number, normalized.revision_number),
      tenant,
      header.organization_id,
      header.id,
      normalized.revision_number,
      sequence,
      status,
      status,
      normalized.valid_from,
      normalized.valid_to,
      JSON.stringify(normalized.effectivity || {}),
      normalized.configuration_context,
      normalized.variant_id,
      normalized.variant_code,
      normalized.baseline_id,
      normalized.owner_user_id ?? header.owner_user_id ?? null,
      JSON.stringify(normalized.metadata || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM bom_revisions WHERE id = ?", [Number(result.lastInsertRowid)]);
  setCurrentRevisionIfUnset(db, header, row, actor);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REVISION", entityId: row.id, entityRef: row.revision_ref, action: "CREATED", version: 1, status: row.status, after: publicRevision(row), actor, ip, details: { bom_id: header.id, bom_ref: header.bom_ref } });
  publishBomEvent(db, { eventType: bomEventCode("REVISION_CREATED"), objectType: "bom_revision", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { bom_ref: header.bom_ref, revision_ref: row.revision_ref, revision_number: row.revision_number } }, actor);
  return publicRevision(row);
}

function setCurrentRevisionIfUnset(db, header, revisionRow, actor) {
  if (header.current_revision_id) return;
  updateRow(db, "bom_headers", header.id, { current_revision_id: revisionRow.id, updated_by: actor?.id ?? null }, { columns: ["current_revision_id", "updated_by"] });
}

export function updateRevision(db, tenantId, ref, body = {}, actor = null, ip = null, options = {}) {
  const tenant = Number(tenantId);
  const row = requireRevisionRow(db, tenant, ref, options);
  assertRevisionEditable(row);
  const before = publicRevision(row);
  const normalized = normalizeRevisionInput(body, row);
  updateRow(
    db,
    "bom_revisions",
    row.id,
    {
      valid_from: normalized.valid_from,
      valid_to: normalized.valid_to,
      effectivity_json: JSON.stringify(normalized.effectivity || {}),
      configuration_context: normalized.configuration_context,
      variant_id: normalized.variant_id,
      variant_code: normalized.variant_code,
      baseline_id: normalized.baseline_id,
      owner_user_id: normalized.owner_user_id,
      metadata_json: JSON.stringify(normalized.metadata || {}),
      version: Number(row.version) + 1,
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM bom_revisions WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REVISION", entityId: row.id, entityRef: row.revision_ref, action: "UPDATED", version: updated.version, status: updated.status, before, after: publicRevision(updated), actor, ip });
  publishBomEvent(db, { eventType: bomEventCode("REVISION_REVISED"), objectType: "bom_revision", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { revision_ref: updated.revision_ref } }, actor);
  return publicRevision(updated);
}

export function setRevisionStatus(db, tenantId, ref, status, actor = null, ip = null, options = {}) {
  const tenant = Number(tenantId);
  const row = requireRevisionRow(db, tenant, ref, options);
  const target = assertRevisionStatus(status);
  const config = { transitions: DEFAULT_REVISION_TRANSITIONS };
  assertRevisionTransition(row.status, target, config.transitions);
  const before = publicRevision(row);
  updateRow(db, "bom_revisions", row.id, { status: target, lifecycle_state: target, version: Number(row.version) + 1, updated_by: actor?.id ?? null }, { columns: UPDATE_COLUMNS });
  const updated = queryOne(db, "SELECT * FROM bom_revisions WHERE id = ?", [row.id]);
  if (target === "RELEASED") {
    run(db, "UPDATE bom_headers SET status = 'RELEASED', lifecycle_state = 'RELEASED', current_revision_id = ?, version = version + 1, updated_at = ? WHERE id = ?", [row.id, nowIso(), row.bom_id]);
  }
  bumpEpoch(tenant);
  invalidate(tenant);
  const action = target === "RELEASED" ? "RELEASED" : "STATUS_CHANGED";
  recordChange(db, { tenantId: tenant, entityType: "REVISION", entityId: row.id, entityRef: row.revision_ref, action, version: updated.version, status: target, before, after: publicRevision(updated), actor, ip, details: { from: row.status, to: target, allowed: allowedRevisionTransitions(row.status) } });
  publishBomEvent(db, { eventType: target === "RELEASED" ? bomEventCode("REVISION_RELEASED") : bomEventCode("REVISION_STATUS_CHANGED"), objectType: "bom_revision", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { revision_ref: updated.revision_ref, from: row.status, to: target } }, actor);
  return publicRevision(updated);
}

// Creates the next revision by cloning the current one (lines, substitutes and
// attributes). This is the "revise" operation used after a revision is released.
export function reviseRevision(db, tenantId, ref, body = {}, actor = null, ip = null, options = {}) {
  const tenant = Number(tenantId);
  const source = requireRevisionRow(db, tenant, ref, options);
  const header = queryOne(db, "SELECT * FROM bom_headers WHERE id = ?", [source.bom_id]);
  const nextNumber = normalizeText(body.revision_number ?? body.revisionNumber ?? `${source.revision_number}.NEXT`, { max: 60 }) || `${source.revision_number}.NEXT`;
  const created = createRevision(db, tenant, header.id, {
    revision_number: nextNumber,
    status: body.status || "DRAFT",
    valid_from: body.valid_from ?? source.valid_from,
    valid_to: body.valid_to ?? source.valid_to,
    effectivity: body.effectivity ?? JSON.parse(source.effectivity_json || "{}"),
    configuration_context: body.configuration_context ?? source.configuration_context,
    variant_id: body.variant_id ?? source.variant_id,
    variant_code: body.variant_code ?? source.variant_code,
    metadata: body.metadata ?? JSON.parse(source.metadata_json || "{}"),
  }, actor, ip);
  const target = getRevisionRow(db, tenant, created.id, { bomId: header.id });
  const lines = queryAll(db, "SELECT * FROM bom_lines WHERE bom_revision_id = ? ORDER BY sequence, id", [source.id]);
  const now = nowIso();
  const idMap = new Map();
  for (const line of lines) {
    const result = run(
      db,
      `INSERT INTO bom_lines
         (line_ref, tenant_id, organization_id, bom_revision_id, parent_object_id, parent_object_type, child_object_id, child_object_type,
          child_revision, quantity, uom, normalized_quantity, normalized_uom, find_number, sequence, reference_designator, usage,
          optional, substitute, substitute_group_id, effectivity_json, variant_id, variant_code, configuration_context,
          attributes_json, notes, line_status, version, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        lineRef(line.child_object_id), line.tenant_id, line.organization_id, target.id, line.parent_object_id, line.parent_object_type,
        line.child_object_id, line.child_object_type, line.child_revision, line.quantity, line.uom, line.normalized_quantity,
        line.normalized_uom, line.find_number, line.sequence, line.reference_designator, line.usage, line.optional, line.substitute,
        line.substitute_group_id, line.effectivity_json, line.variant_id, line.variant_code, line.configuration_context,
        line.attributes_json, line.notes, line.line_status, actor?.id ?? null, actor?.id ?? null, now, now,
      ]
    );
    idMap.set(line.id, Number(result.lastInsertRowid));
  }
  const substitutes = queryAll(db, "SELECT * FROM bom_substitutes WHERE bom_revision_id = ?", [source.id]);
  for (const sub of substitutes) {
    run(
      db,
      `INSERT INTO bom_substitutes
         (tenant_id, organization_id, bom_revision_id, line_id, primary_object_id, substitute_object_id, substitute_object_type,
          substitute_group, priority, ratio, status, notes, metadata_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sub.tenant_id, sub.organization_id, target.id, sub.line_id != null ? idMap.get(sub.line_id) ?? null : null, sub.primary_object_id,
        sub.substitute_object_id, sub.substitute_object_type, sub.substitute_group, sub.priority, sub.ratio, sub.status, sub.notes,
        sub.metadata_json, actor?.id ?? null, now, now]
    );
  }
  const attributes = queryAll(db, "SELECT * FROM bom_line_attributes WHERE line_id IN (SELECT id FROM bom_lines WHERE bom_revision_id = ?)", [source.id]);
  for (const attr of attributes) {
    const mapped = idMap.get(attr.line_id);
    if (!mapped) continue;
    run(
      db,
      "INSERT INTO bom_line_attributes (tenant_id, line_id, attribute_code, data_type, attribute_value, sequence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [attr.tenant_id, mapped, attr.attribute_code, attr.data_type, attr.attribute_value, attr.sequence, now, now]
    );
  }
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REVISION", entityId: target.id, entityRef: target.revision_ref, action: "REVISED_FROM", version: target.version, status: target.status, after: { source_revision_id: source.id, lines_copied: lines.length }, actor, ip });
  return { revision: publicRevision(target), copied: { lines: lines.length, substitutes: substitutes.length, attributes: attributes.length }, source_revision_id: source.id };
}

export function deleteRevision(db, tenantId, ref, actor = null, ip = null, options = {}) {
  const tenant = Number(tenantId);
  const row = requireRevisionRow(db, tenant, ref, options);
  const before = publicRevision(row);
  run(db, "DELETE FROM bom_lines WHERE bom_revision_id = ?", [row.id]);
  run(db, "DELETE FROM bom_substitutes WHERE bom_revision_id = ?", [row.id]);
  run(db, "DELETE FROM bom_baselines WHERE revision_id = ?", [row.id]);
  run(db, "DELETE FROM bom_revisions WHERE id = ?", [row.id]);
  const header = queryOne(db, "SELECT * FROM bom_headers WHERE id = ?", [row.bom_id]);
  if (header && header.current_revision_id === row.id) {
    const next = queryOne(db, "SELECT id FROM bom_revisions WHERE bom_id = ? ORDER BY revision_sequence DESC LIMIT 1", [row.bom_id]);
    updateRow(db, "bom_headers", header.id, { current_revision_id: next?.id ?? null, updated_by: actor?.id ?? null }, { columns: ["current_revision_id", "updated_by"] });
  }
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REVISION", entityId: row.id, entityRef: row.revision_ref, action: "DELETED", version: row.version, status: row.status, before, actor, ip });
  return { deleted: true, id: row.id, revision_ref: row.revision_ref };
}

export function assertRevisionEditable(row) {
  if (["RELEASED", "SUPERSEDED", "OBSOLETE"].includes(String(row.status).toUpperCase())) {
    throw revisionImmutable(row.revision_ref, row.status);
  }
}

export function assertRevisionOpenForLines(row) {
  if (["SUPERSEDED", "OBSOLETE"].includes(String(row.status).toUpperCase())) {
    throw lineImmutable(row.revision_ref);
  }
}
