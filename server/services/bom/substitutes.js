// Substitute / alternate component service.
//
// A substitute records an approved replacement component for a BOM line (or an
// entire revision when line_id is null), with priority and consumption ratio.
// Substitutes are revision-scoped so released revisions remain reproducible.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow } from "./sql.js";
import { publicSubstitute } from "./repository.js";
import { bumpEpoch, invalidate } from "./cache.js";
import { recordChange } from "./history.js";
import { publishBomEvent, bomEventCode } from "./events.js";
import { requireRevisionRow, assertRevisionOpenForLines } from "./revisions.js";
import { requireLineRow } from "./lines.js";
import { normalizeText, normalizeUpper, toInt, toNumber, paginate } from "./validation.js";
import { substituteNotFound, substituteConflict, invalidSubstitute } from "./errors.js";
import { SOURCE_MODULE } from "./constants.js";

const UPDATE_COLUMNS = ["substitute_object_id", "substitute_object_type", "substitute_group", "priority", "ratio", "status", "notes", "metadata_json", "updated_by"];

export function getSubstituteRow(db, tenantId, ref) {
  return queryOne(db, "SELECT * FROM bom_substitutes WHERE id = ? AND tenant_id = ?", [Number(ref), Number(tenantId)]);
}

export function requireSubstituteRow(db, tenantId, ref) {
  const row = getSubstituteRow(db, tenantId, ref);
  if (!row) throw substituteNotFound(ref);
  return row;
}

export function listSubstitutes(db, { tenantId, revisionId, lineId, substituteObjectId, group, status, page, pageSize, sort, order } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (revisionId != null) {
    clauses.push("bom_revision_id = ?");
    params.push(Number(revisionId));
  }
  if (lineId != null) {
    clauses.push("line_id = ?");
    params.push(Number(lineId));
  }
  if (substituteObjectId) {
    clauses.push("substitute_object_id = ?");
    params.push(String(substituteObjectId));
  }
  if (group) {
    clauses.push("substitute_group = ?");
    params.push(normalizeUpper(group, { max: 120 }));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(normalizeUpper(status, { max: 40 }));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 1000 });
  const allowedSort = ["id", "priority", "created_at"];
  const column = allowedSort.includes(String(sort)) ? String(sort) : "priority";
  const direction = String(order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM bom_substitutes ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM bom_substitutes ${where} ORDER BY ${column} ${direction}, id ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicSubstitute), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

function normalizeSubstituteInput(body = {}, current = {}) {
  const substituteObjectId = normalizeText(body.substitute_object_id ?? body.substituteObjectId ?? current.substitute_object_id ?? "", { max: 300 });
  if (!substituteObjectId) throw invalidSubstitute("substitute_object_id is required");
  const primary = normalizeText(body.primary_object_id ?? body.primaryObjectId ?? current.primary_object_id ?? "", { max: 300 });
  if (primary && primary === substituteObjectId) throw invalidSubstitute("A component cannot substitute itself", { object_id: substituteObjectId });
  return {
    substitute_object_id: substituteObjectId,
    substitute_object_type: normalizeText(body.substitute_object_type ?? body.substituteObjectType ?? current.substitute_object_type ?? "part", { max: 120 }).toLowerCase() || "part",
    substitute_group: normalizeUpper(body.substitute_group ?? body.substituteGroup ?? current.substitute_group ?? "", { max: 120 }),
    priority: toInt(body.priority ?? current.priority ?? 1, 1),
    ratio: Math.max(0, toNumber(body.ratio ?? current.ratio ?? 1, 1)),
    status: normalizeUpper(body.status ?? current.status ?? "ACTIVE", { max: 40 }) || "ACTIVE",
    notes: normalizeText(body.notes ?? current.notes ?? "", { max: 2000 }),
    metadata: body.metadata ?? current.metadata_json ?? {},
  };
}

export function addSubstitute(db, tenantId, revisionId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const revision = requireRevisionRow(db, tenant, revisionId);
  assertRevisionOpenForLines(revision);
  let lineRow = null;
  if (body.line_id != null || body.lineId != null) {
    lineRow = requireLineRow(db, tenant, body.line_id ?? body.lineId);
    if (Number(lineRow.bom_revision_id) !== Number(revision.id)) throw invalidSubstitute("The line does not belong to this revision");
  }
  const normalized = normalizeSubstituteInput(body, { primary_object_id: lineRow?.child_object_id ?? null });
  const duplicate = queryOne(
    db,
    `SELECT id FROM bom_substitutes WHERE bom_revision_id = ? AND COALESCE(line_id, 0) = COALESCE(?, 0)
       AND substitute_object_id = ? AND substitute_group = ?`,
    [revision.id, lineRow?.id ?? null, normalized.substitute_object_id, normalized.substitute_group]
  );
  if (duplicate) throw substituteConflict({ substitute_object_id: normalized.substitute_object_id, group: normalized.substitute_group });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO bom_substitutes
       (tenant_id, organization_id, bom_revision_id, line_id, primary_object_id, substitute_object_id, substitute_object_type,
        substitute_group, priority, ratio, status, notes, metadata_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenant, revision.organization_id, revision.id, lineRow?.id ?? null, lineRow?.child_object_id ?? normalized.primary_object_id ?? null,
      normalized.substitute_object_id, normalized.substitute_object_type, normalized.substitute_group, normalized.priority, normalized.ratio,
      normalized.status, normalized.notes, JSON.stringify(normalized.metadata || {}), actor?.id ?? null, ts, ts]
  );
  const row = queryOne(db, "SELECT * FROM bom_substitutes WHERE id = ?", [Number(result.lastInsertRowid)]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "SUBSTITUTE", entityId: row.id, entityRef: `SUB-${row.id}`, action: "CREATED", status: row.status, after: publicSubstitute(row), actor, ip, details: { revision_id: revision.id } });
  publishBomEvent(db, { eventType: bomEventCode("SUBSTITUTE_ADDED"), objectType: "bom_substitute", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { revision_id: revision.id, substitute_object_id: row.substitute_object_id } }, actor);
  return publicSubstitute(row);
}

export function updateSubstitute(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireSubstituteRow(db, tenant, ref);
  const before = publicSubstitute(row);
  const normalized = normalizeSubstituteInput(body, row);
  updateRow(
    db,
    "bom_substitutes",
    row.id,
    {
      substitute_object_id: normalized.substitute_object_id,
      substitute_object_type: normalized.substitute_object_type,
      substitute_group: normalized.substitute_group,
      priority: normalized.priority,
      ratio: normalized.ratio,
      status: normalized.status,
      notes: normalized.notes,
      metadata_json: JSON.stringify(normalized.metadata || {}),
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM bom_substitutes WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "SUBSTITUTE", entityId: row.id, entityRef: `SUB-${row.id}`, action: "UPDATED", status: updated.status, before, after: publicSubstitute(updated), actor, ip });
  return publicSubstitute(updated);
}

export function removeSubstitute(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireSubstituteRow(db, tenant, ref);
  const before = publicSubstitute(row);
  run(db, "DELETE FROM bom_substitutes WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "SUBSTITUTE", entityId: row.id, entityRef: `SUB-${row.id}`, action: "DELETED", status: row.status, before, actor, ip });
  publishBomEvent(db, { eventType: bomEventCode("SUBSTITUTE_REMOVED"), objectType: "bom_substitute", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { revision_id: row.bom_revision_id } }, actor);
  return { deleted: true, id: row.id };
}

// Ordered replacement candidates for a line (or revision when line_id is null),
// active substitutes only, highest priority first.
export function resolveSubstitutes(db, tenantId, { revisionId, lineId = null, substituteObjectId = null, includeInactive = false } = {}) {
  const result = listSubstitutes(db, { tenantId, revisionId, lineId, substituteObjectId, pageSize: 1000 });
  const items = includeInactive ? result.items : result.items.filter((item) => String(item.status).toUpperCase() === "ACTIVE");
  return items.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || (a.id - b.id));
}

export function substituteSummary(db, tenantId, revisionId) {
  const rows = queryAll(
    db,
    "SELECT status, COUNT(*) AS c FROM bom_substitutes WHERE tenant_id = ? AND bom_revision_id = ? GROUP BY status",
    [Number(tenantId), Number(revisionId)]
  );
  const total = rows.reduce((sum, row) => sum + Number(row.c), 0);
  return { revision_id: Number(revisionId), total, by_status: Object.fromEntries(rows.map((row) => [row.status, Number(row.c)])) };
}
