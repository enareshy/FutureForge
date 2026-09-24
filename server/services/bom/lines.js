// BOM line service.
//
// Lines are the edges of a BOM revision: child object, quantity/UOM, find number,
// sequence, reference designators, usage, optional flag, variant/effectivity and
// per-line attributes. Writes enforce the unit, cycle, depth and duplicate rules
// configured for the tenant and optionally materialize a platform relationship.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { updateRow } from "./sql.js";
import { publicLine, publicLineAttribute } from "./repository.js";
import { lineRef } from "./refs.js";
import { bumpEpoch, invalidate } from "./cache.js";
import { recordChange } from "./history.js";
import { publishBomEvent, bomEventCode } from "./events.js";
import { createRelationship } from "../objects.js";
import { getConfig } from "./configuration.js";
import { requireRevisionRow, assertRevisionOpenForLines } from "./revisions.js";
import { assertNoCycle } from "./structure.js";
import { normalizeQuantityValue, requireUnit } from "./units.js";
import {
  assertUsage,
  assertLineStatus,
  normalizeLineInput,
  normalizeReferenceDesignators,
  toBool,
  toInt,
  paginate,
} from "./validation.js";
import { lineNotFound, lineConflict, invalidLine, quantityInvalid, invalidUnit } from "./errors.js";
import { MAX_LINES_PER_REVISION, SOURCE_MODULE } from "./constants.js";

const UPDATE_COLUMNS = [
  "parent_object_id", "parent_object_type", "child_object_id", "child_object_type", "child_revision", "quantity", "uom",
  "normalized_quantity", "normalized_uom", "find_number", "sequence", "reference_designator", "usage", "optional",
  "substitute", "substitute_group_id", "effectivity_json", "variant_id", "variant_code", "configuration_context",
  "attributes_json", "notes", "line_status", "relationship_id", "version", "updated_by",
];

export function getLineRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM bom_lines WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(db, "SELECT * FROM bom_lines WHERE tenant_id = ? AND line_ref = ?", [Number(tenantId), String(ref)]);
}

export function requireLineRow(db, tenantId, ref) {
  const row = getLineRow(db, tenantId, ref);
  if (!row) throw lineNotFound(ref);
  return row;
}

export function getLine(db, tenantId, ref) {
  const row = requireLineRow(db, tenantId, ref);
  const attributes = queryAll(db, "SELECT * FROM bom_line_attributes WHERE line_id = ? ORDER BY sequence, id", [row.id]).map(publicLineAttribute);
  return { ...publicLine(row), attribute_list: attributes };
}

export function listLines(db, { tenantId, revisionId, usage, optional, variantId, variantCode, findNumber, lineStatus, includeInactive = true, q, page, pageSize, sort, order } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (revisionId != null) {
    clauses.push("bom_revision_id = ?");
    params.push(Number(revisionId));
  }
  if (usage) {
    clauses.push("usage = ?");
    params.push(assertUsage(usage));
  }
  if (optional !== undefined && optional !== null) {
    clauses.push("optional = ?");
    params.push(toBool(optional, false) ? 1 : 0);
  }
  if (variantId != null) {
    clauses.push("variant_id = ?");
    params.push(Number(variantId));
  }
  if (variantCode) {
    clauses.push("variant_code = ?");
    params.push(String(variantCode).toUpperCase());
  }
  if (findNumber) {
    clauses.push("find_number = ?");
    params.push(String(findNumber).toUpperCase());
  }
  if (lineStatus) {
    clauses.push("line_status = ?");
    params.push(assertLineStatus(lineStatus));
  } else if (!includeInactive) {
    clauses.push("line_status = 'ACTIVE'");
  }
  if (q) {
    clauses.push("(child_object_id LIKE ? OR find_number LIKE ? OR reference_designator LIKE ?)");
    const like = `%${String(q).slice(0, 120)}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 100, maxPageSize: 1000 });
  const allowedSort = ["id", "sequence", "find_number", "child_object_id", "quantity", "created_at"];
  const column = allowedSort.includes(String(sort)) ? String(sort) : "sequence";
  const direction = String(order || "asc").toLowerCase() === "desc" ? "DESC" : "ASC";
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM bom_lines ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM bom_lines ${where} ORDER BY ${column} ${direction}, id ASC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicLine), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

function normalizeForStorage(tenantId, normalized, db) {
  const enforceUom = toBool(getConfig(db, tenantId, "enforce_uom"), true);
  if (enforceUom && !normalized.uom) throw invalidUnit("A unit of measure is required", { field: "uom" });
  if (enforceUom && normalized.uom) {
    try {
      requireUnit(db, normalized.uom);
    } catch {
      throw invalidUnit(`Unknown unit of measure: ${normalized.uom}`, { uom: normalized.uom });
    }
  }
  const baseUom = String(getConfig(db, tenantId, "default_uom") || normalized.uom || "EA").toUpperCase();
  const quantity = Number(normalized.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) throw quantityInvalid("Quantity must be greater than zero", { value: normalized.quantity });
  let normalizedQuantity = quantity;
  let normalizedUom = normalized.uom || baseUom;
  if (toBool(getConfig(db, tenantId, "auto_normalize_units"), false) && normalized.uom && normalized.uom !== baseUom) {
    try {
      const result = normalizeQuantityValue(db, { value: quantity, uom: normalized.uom, baseUom });
      if (result.compatible) {
        normalizedQuantity = result.normalized_quantity;
        normalizedUom = result.normalized_uom;
      }
    } catch {
      // Leave the original quantity when the unit cannot be normalized.
    }
  }
  return { quantity, normalizedQuantity, normalizedUom, baseUom };
}

function assertDuplicateAllowed(db, tenantId, revisionId, childObjectId, parentObjectId, excludeId = null) {
  const allow = toBool(getConfig(db, tenantId, "allow_duplicate_children"), false);
  if (allow) return;
  const clauses = ["bom_revision_id = ?", "child_object_id = ?"];
  const params = [Number(revisionId), String(childObjectId)];
  if (parentObjectId === null || parentObjectId === undefined || parentObjectId === "") {
    clauses.push("(parent_object_id IS NULL OR parent_object_id = '')");
  } else {
    clauses.push("parent_object_id = ?");
    params.push(String(parentObjectId));
  }
  if (excludeId != null) {
    clauses.push("id <> ?");
    params.push(Number(excludeId));
  }
  const existing = queryOne(db, `SELECT id FROM bom_lines WHERE ${clauses.join(" AND ")}`, params);
  if (existing) throw lineConflict({ child_object_id: childObjectId, parent_object_id: parentObjectId ?? null });
}

function assertLineCapacity(db, tenantId, revisionId) {
  const max = Number(getConfig(db, tenantId, "max_lines_per_revision") || MAX_LINES_PER_REVISION);
  const count = Number(queryOne(db, "SELECT COUNT(*) AS c FROM bom_lines WHERE bom_revision_id = ?", [Number(revisionId)])?.c || 0);
  if (count >= max) throw invalidLine(`Revision already has the maximum of ${max} lines`, { max_lines: max });
}

function maybeLinkRelationship(db, tenantId, revisionRow, line, body, actor, ip) {
  if (!toBool(body.create_relationship, false)) return null;
  const childId = Number(line.child_object_id);
  const parentRef = line.parent_object_id ?? revisionRow.object_id ?? null;
  const parentId = parentRef != null ? Number(parentRef) : null;
  if (!Number.isInteger(childId) || !Number.isInteger(parentId)) return null;
  try {
    const created = createRelationship(
      db,
      { type: body.relationship_type ?? "BOM_CHILD", source: parentId, target: childId, attributes: { quantity: line.quantity, uom: line.uom, find_number: line.find_number } },
      actor,
      Number(tenantId),
      ip ?? null
    );
    return created?.id ?? null;
  } catch {
    return null;
  }
}

export function addLine(db, tenantId, revisionId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const revision = requireRevisionRow(db, tenant, revisionId);
  assertRevisionOpenForLines(revision);
  assertLineCapacity(db, tenant, revision.id);
  const normalized = normalizeLineInput(body, {}, {
    enforceChild: toBool(getConfig(db, tenant, "require_child_object"), true),
    enforceUom: toBool(getConfig(db, tenant, "enforce_uom"), true),
  });
  const parentObjectId = normalized.parent_object_id ?? (revision.object_id != null ? String(revision.object_id) : null);
  assertDuplicateAllowed(db, tenant, revision.id, normalized.child_object_id, parentObjectId);
  if (toBool(getConfig(db, tenant, "block_cycle"), true)) {
    assertNoCycle(db, { revisionId: revision.id, parentObjectId, childObjectId: normalized.child_object_id });
  }
  const storage = normalizeForStorage(tenant, normalized, db);
  const ts = nowIso();
  const line = {
    ...normalized,
    parent_object_id: parentObjectId,
    quantity: storage.quantity,
    normalized_quantity: storage.normalizedQuantity,
    normalized_uom: storage.normalizedUom,
  };
  const relationshipId = maybeLinkRelationship(db, tenant, revision, line, body, actor, ip);
  const result = run(
    db,
    `INSERT INTO bom_lines
       (line_ref, tenant_id, organization_id, bom_revision_id, parent_object_id, parent_object_type, child_object_id, child_object_type,
        child_revision, quantity, uom, normalized_quantity, normalized_uom, find_number, sequence, reference_designator, usage,
        optional, substitute, substitute_group_id, effectivity_json, variant_id, variant_code, configuration_context,
        attributes_json, notes, line_status, relationship_id, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      lineRef(line.child_object_id), tenant, revision.organization_id, revision.id, line.parent_object_id, line.parent_object_type,
      line.child_object_id, line.child_object_type, line.child_revision, line.quantity, line.uom, line.normalized_quantity,
      line.normalized_uom, line.find_number, resolveSequence(db, revision.id, line.sequence), line.reference_designator, line.usage,
      line.optional ? 1 : 0, line.substitute ? 1 : 0, line.substitute_group_id, JSON.stringify(line.effectivity || {}),
      line.variant_id, line.variant_code, line.configuration_context, JSON.stringify(line.attributes || {}), line.notes,
      line.line_status, relationshipId, actor?.id ?? null, actor?.id ?? null, ts, ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM bom_lines WHERE id = ?", [Number(result.lastInsertRowid)]);
  if (Array.isArray(body.attributes_list)) setLineAttributes(db, tenant, row.id, body.attributes_list);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "LINE", entityId: row.id, entityRef: row.line_ref, action: "CREATED", version: 1, status: row.line_status, after: publicLine(row), actor, ip, details: { revision_id: revision.id } });
  publishBomEvent(db, { eventType: bomEventCode("LINE_ADDED"), objectType: "bom_line", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { revision_id: revision.id, line_ref: row.line_ref, child_object_id: row.child_object_id } }, actor);
  return publicLine(row);
}

function resolveSequence(db, revisionId, requested) {
  const value = toInt(requested, 0);
  if (value > 0) return value;
  const max = Number(queryOne(db, "SELECT COALESCE(MAX(sequence), 0) AS s FROM bom_lines WHERE bom_revision_id = ?", [Number(revisionId)])?.s || 0);
  return max + 10;
}

export function updateLine(db, tenantId, revisionId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const revision = requireRevisionRow(db, tenant, revisionId);
  assertRevisionOpenForLines(revision);
  const row = requireLineRow(db, tenant, ref);
  if (Number(row.bom_revision_id) !== Number(revision.id)) throw lineNotFound(ref);
  const before = publicLine(row);
  const normalized = normalizeLineInput(body, row, {
    enforceChild: toBool(getConfig(db, tenant, "require_child_object"), true),
    enforceUom: toBool(getConfig(db, tenant, "enforce_uom"), true),
  });
  const parentObjectId = normalized.parent_object_id ?? row.parent_object_id ?? null;
  assertDuplicateAllowed(db, tenant, revision.id, normalized.child_object_id, parentObjectId, row.id);
  if (toBool(getConfig(db, tenant, "block_cycle"), true)) {
    assertNoCycle(db, { revisionId: revision.id, parentObjectId, childObjectId: normalized.child_object_id });
  }
  const storage = normalizeForStorage(tenant, normalized, db);
  updateRow(
    db,
    "bom_lines",
    row.id,
    {
      parent_object_id: parentObjectId,
      parent_object_type: normalized.parent_object_type,
      child_object_id: normalized.child_object_id,
      child_object_type: normalized.child_object_type,
      child_revision: normalized.child_revision,
      quantity: storage.quantity,
      uom: normalized.uom,
      normalized_quantity: storage.normalizedQuantity,
      normalized_uom: storage.normalizedUom,
      find_number: normalized.find_number,
      sequence: normalized.sequence,
      reference_designator: normalizeReferenceDesignators(normalized.reference_designator),
      usage: normalized.usage,
      optional: normalized.optional ? 1 : 0,
      substitute: normalized.substitute ? 1 : 0,
      substitute_group_id: normalized.substitute_group_id,
      effectivity_json: JSON.stringify(normalized.effectivity || {}),
      variant_id: normalized.variant_id,
      variant_code: normalized.variant_code,
      configuration_context: normalized.configuration_context,
      attributes_json: JSON.stringify(normalized.attributes || {}),
      notes: normalized.notes,
      line_status: normalized.line_status,
      version: Number(row.version) + 1,
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM bom_lines WHERE id = ?", [row.id]);
  if (Array.isArray(body.attributes_list)) setLineAttributes(db, tenant, row.id, body.attributes_list);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "LINE", entityId: row.id, entityRef: row.line_ref, action: "UPDATED", version: updated.version, status: updated.line_status, before, after: publicLine(updated), actor, ip });
  publishBomEvent(db, { eventType: bomEventCode("LINE_UPDATED"), objectType: "bom_line", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { revision_id: revision.id, line_ref: updated.line_ref } }, actor);
  return publicLine(updated);
}

export function removeLine(db, tenantId, revisionId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const revision = requireRevisionRow(db, tenant, revisionId);
  assertRevisionOpenForLines(revision);
  const row = requireLineRow(db, tenant, ref);
  if (Number(row.bom_revision_id) !== Number(revision.id)) throw lineNotFound(ref);
  const before = publicLine(row);
  run(db, "DELETE FROM bom_line_attributes WHERE line_id = ?", [row.id]);
  run(db, "DELETE FROM bom_substitutes WHERE line_id = ?", [row.id]);
  run(db, "DELETE FROM bom_lines WHERE id = ?", [row.id]);
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "LINE", entityId: row.id, entityRef: row.line_ref, action: "DELETED", version: row.version, status: row.line_status, before, actor, ip });
  publishBomEvent(db, { eventType: bomEventCode("LINE_REMOVED"), objectType: "bom_line", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { revision_id: revision.id, line_ref: row.line_ref } }, actor);
  return { deleted: true, id: row.id, line_ref: row.line_ref };
}

export function reorderLines(db, tenantId, revisionId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const revision = requireRevisionRow(db, tenant, revisionId);
  assertRevisionOpenForLines(revision);
  const order = Array.isArray(body) ? body : body.lines ?? body.order ?? [];
  if (!Array.isArray(order)) throw invalidLine("order must be an array of {id, sequence}");
  const ts = nowIso();
  let updated = 0;
  order.forEach((entry, index) => {
    const id = Number(entry?.id ?? entry?.line_id ?? entry);
    if (!Number.isInteger(id)) return;
    const sequence = toInt(entry?.sequence, (index + 1) * 10);
    const result = run(
      db,
      "UPDATE bom_lines SET sequence = ?, updated_at = ?, updated_by = ? WHERE id = ? AND bom_revision_id = ?",
      [sequence, ts, actor?.id ?? null, id, revision.id]
    );
    if (result.changes) updated += 1;
  });
  bumpEpoch(tenant);
  invalidate(tenant);
  recordChange(db, { tenantId: tenant, entityType: "REVISION", entityId: revision.id, entityRef: revision.revision_ref, action: "LINES_REORDERED", version: revision.version, status: revision.status, details: { updated }, actor, ip });
  return { updated };
}

// Replaces the per-line attribute set (bom_line_attributes).
export function setLineAttributes(db, tenantId, lineId, attributes = [], actor = null) {
  const tenant = Number(tenantId);
  const row = requireLineRow(db, tenant, lineId);
  if (!Array.isArray(attributes)) throw invalidLine("attributes_list must be an array");
  run(db, "DELETE FROM bom_line_attributes WHERE line_id = ?", [row.id]);
  const ts = nowIso();
  let count = 0;
  attributes.forEach((attr, index) => {
    const code = String(attr?.code ?? attr?.attribute_code ?? "").trim().toUpperCase();
    if (!code) return;
    run(
      db,
      "INSERT INTO bom_line_attributes (tenant_id, line_id, attribute_code, data_type, attribute_value, sequence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [tenant, row.id, code, String(attr?.data_type ?? attr?.dataType ?? "STRING").toUpperCase(), stringValue(attr?.value ?? attr?.attribute_value), toInt(attr?.sequence, index + 1), ts, ts]
    );
    count += 1;
  });
  return { line_id: row.id, count };
}

export function listLineAttributes(db, tenantId, lineId) {
  const row = requireLineRow(db, tenantId, lineId);
  return queryAll(db, "SELECT * FROM bom_line_attributes WHERE line_id = ? ORDER BY sequence, id", [row.id]).map(publicLineAttribute);
}

function stringValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
