// Affected-item linkage for a Change Order: which objects (PDM items, BOM
// assemblies, etc.) does this change touch, and what happens to each on
// release. Generic object_type/object_id pair, no hard FK — mirrors the
// versioning kernel's own effectivity/baseline linkage convention so release
// can hang an effectivity assignment off any object type without a new
// linking table.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { publicAffectedItem } from "./repository.js";
import { normalizeAffectedItemInput } from "./validation.js";
import { publishChangeEvent } from "./events.js";
import { affectedItemNotFound, affectedItemConflict } from "./errors.js";
import { requireOrderRow } from "./orders.js";
import { SOURCE_MODULE } from "./constants.js";
import { multiLevelWhereUsed } from "../bom/where-used.js";

export function listAffectedItems(db, tenantId, orderRef) {
  const order = requireOrderRow(db, tenantId, orderRef);
  const rows = queryAll(db, "SELECT * FROM change_affected_items WHERE change_order_id = ? ORDER BY id", [order.id]);
  return { items: rows.map(publicAffectedItem), total: rows.length, source_module: SOURCE_MODULE, order_id: order.id };
}

export function addAffectedItem(db, tenantId, orderRef, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const order = requireOrderRow(db, tenant, orderRef);
  const normalized = normalizeAffectedItemInput(body);
  const existing = queryOne(
    db,
    "SELECT id FROM change_affected_items WHERE change_order_id = ? AND object_type = ? AND object_id = ?",
    [order.id, normalized.object_type, normalized.object_id]
  );
  if (existing) throw affectedItemConflict({ object_type: normalized.object_type, object_id: normalized.object_id });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO change_affected_items
       (tenant_id, change_order_id, object_type, object_id, object_label, disposition, notes, metadata_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [tenant, order.id, normalized.object_type, normalized.object_id, normalized.object_label, normalized.disposition, normalized.notes, JSON.stringify(normalized.metadata || {}), actor?.id ?? null, ts, ts]
  );
  const row = queryOne(db, "SELECT * FROM change_affected_items WHERE id = ?", [Number(result.lastInsertRowid)]);
  publishChangeEvent(db, { eventType: "ChangeAffectedItemAdded", objectType: "change_order", objectId: order.id, tenantId: tenant, organizationId: order.organization_id, payload: { object_type: row.object_type, object_id: row.object_id } }, actor);
  return publicAffectedItem(row);
}

export function removeAffectedItem(db, tenantId, orderRef, itemRef, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const order = requireOrderRow(db, tenant, orderRef);
  const id = Number(itemRef);
  const row = queryOne(db, "SELECT * FROM change_affected_items WHERE id = ? AND change_order_id = ?", [id, order.id]);
  if (!row) throw affectedItemNotFound(itemRef);
  run(db, "DELETE FROM change_affected_items WHERE id = ?", [row.id]);
  publishChangeEvent(db, { eventType: "ChangeAffectedItemRemoved", objectType: "change_order", objectId: order.id, tenantId: tenant, organizationId: order.organization_id, payload: { object_type: row.object_type, object_id: row.object_id } }, actor);
  return { deleted: true, id: row.id };
}

export function getAffectedItemRows(db, orderId) {
  return queryAll(db, "SELECT * FROM change_affected_items WHERE change_order_id = ?", [Number(orderId)]);
}

export function recordAffectedItemResult(db, id, { resultingObjectType = null, resultingObjectId = null, effectivityDefinitionId = null, effectivityAssignmentId = null } = {}) {
  run(
    db,
    `UPDATE change_affected_items
     SET resulting_object_type = ?, resulting_object_id = ?, effectivity_definition_id = ?, effectivity_assignment_id = ?, updated_at = ?
     WHERE id = ?`,
    [resultingObjectType, resultingObjectId, effectivityDefinitionId, effectivityAssignmentId, nowIso(), Number(id)]
  );
}

// Impact discovery: reuses BOM's multi-level where-used to suggest assemblies
// that consume a given object, so an ECO author can quickly find what else
// might need to be an affected item. Best-effort — BOM may have no data for
// an arbitrary object type, which is not an error here.
export function listImpact(db, tenantId, { objectType, objectId, maxDepth = 5 } = {}) {
  try {
    return multiLevelWhereUsed(db, Number(tenantId), objectId, { objectType, maxDepth });
  } catch {
    return { items: [], total: 0, note: "Impact analysis unavailable for this object type" };
  }
}
