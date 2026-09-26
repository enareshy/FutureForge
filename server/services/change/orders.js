// Change Order (ECO) service — the heart of Change Management.
//
// An ECO carries the actual affected-items list and drives implementation.
// Approval routes through the shared Workflow engine's CCB binding when one
// is registered (see foundation.js); release is the integration point that
// proves the platform composition: for every affected item it creates a
// real Effectivity & Versioning Kernel definition + assignment (there is no
// single-call shortcut — this mirrors exactly how an ECO release works
// today: create the rule, then bind it to the target), then snapshots the
// affected set as a frozen Versioning baseline, the change's immutable
// record of what was released and to what.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { nextNumber } from "../numbering.js";
import { createDefinition as createEffectivityDefinition, createAssignment as createEffectivityAssignment } from "../versioning/effectivities.js";
import { createBaseline, freezeBaseline } from "../versioning/baselines.js";
import { triggerEvent } from "../workflow/bindings.js";
import { updateRow, assertVersion, bumpVersion } from "./sql.js";
import { publicOrder } from "./repository.js";
import { orderRef } from "./refs.js";
import { recordChange, listHistory } from "./history.js";
import { publishChangeEvent } from "./events.js";
import { normalizeOrderInput, normalizeText, assertOrderTransition, paginate } from "./validation.js";
import { orderNotFound, orderConflict, invalidOrder, orderImmutable, noAffectedItems, changeConflict } from "./errors.js";
import { SOURCE_MODULE, NUMBERING_OBJECT_TYPES } from "./constants.js";
import { getAffectedItemRows, recordAffectedItemResult } from "./affected-items.js";

const UPDATE_COLUMNS = ["title", "description", "change_request_id", "effective_strategy", "effective_context_json", "organization_id", "status", "metadata_json", "version", "updated_by"];
const IMMUTABLE_STATUSES = ["RELEASED", "CANCELLED"];

export function getOrderRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM change_orders WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(
    db,
    "SELECT * FROM change_orders WHERE tenant_id = ? AND (order_ref = ? OR order_number = ? COLLATE NOCASE)",
    [Number(tenantId), String(ref), String(ref)]
  );
}

export function requireOrderRow(db, tenantId, ref) {
  const row = getOrderRow(db, tenantId, ref);
  if (!row) throw orderNotFound(ref);
  return row;
}

export function getOrder(db, tenantId, ref) {
  return publicOrder(requireOrderRow(db, tenantId, ref));
}

export function listOrders(db, { tenantId, status, changeRequestId, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(String(status).toUpperCase());
  }
  if (changeRequestId != null) {
    clauses.push("change_request_id = ?");
    params.push(Number(changeRequestId));
  }
  if (q) {
    clauses.push("(order_number LIKE ? OR title LIKE ? OR description LIKE ?)");
    const like = `%${normalizeText(q, { max: 120 })}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM change_orders ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM change_orders ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicOrder), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function createOrder(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeOrderInput(body, {});
  if (!normalized.title) throw invalidOrder("title is required");
  const orderNumber = normalizeText(body.order_number ?? body.orderNumber, { max: 60 }) || nextNumber(db, { objectType: NUMBERING_OBJECT_TYPES.ORDER }, actor, { tenantId: tenant });
  if (!orderNumber) throw invalidOrder("Unable to generate an order number; register an active ECO numbering scheme");
  const existing = queryOne(db, "SELECT id FROM change_orders WHERE tenant_id = ? AND order_number = ?", [tenant, orderNumber]);
  if (existing) throw orderConflict(orderNumber);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO change_orders
       (order_ref, tenant_id, organization_id, order_number, title, description, change_request_id, status,
        effective_strategy, effective_context_json, requested_by, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      orderRef(orderNumber),
      tenant,
      normalized.organization_id,
      orderNumber,
      normalized.title,
      normalized.description,
      normalized.change_request_id,
      normalized.effective_strategy,
      JSON.stringify(normalized.effective_context || {}),
      actor?.id ?? null,
      JSON.stringify(normalized.metadata || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM change_orders WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordChange(db, { tenantId: tenant, entityType: "ORDER", entityId: row.id, entityRef: row.order_ref, action: "CREATED", version: 1, status: row.status, after: publicOrder(row), actor, ip });
  publishChangeEvent(db, { eventType: "ChangeOrderCreated", objectType: "change_order", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { order_ref: row.order_ref, order_number: row.order_number } }, actor);
  return publicOrder(row);
}

export function updateOrder(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireOrderRow(db, tenant, ref);
  if (IMMUTABLE_STATUSES.includes(row.status)) throw orderImmutable(row.order_ref, row.status);
  assertVersion(row, body.version ?? body.expected_version, (details) => changeConflict(`Change order ${row.order_number} was modified by another user`, details));
  const before = publicOrder(row);
  const normalized = normalizeOrderInput(body, row);
  updateRow(
    db,
    "change_orders",
    row.id,
    {
      title: normalized.title,
      description: normalized.description,
      change_request_id: normalized.change_request_id,
      effective_strategy: normalized.effective_strategy,
      effective_context_json: JSON.stringify(normalized.effective_context || {}),
      organization_id: normalized.organization_id,
      metadata_json: JSON.stringify(normalized.metadata || {}),
      version: bumpVersion(row),
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM change_orders WHERE id = ?", [row.id]);
  recordChange(db, { tenantId: tenant, entityType: "ORDER", entityId: row.id, entityRef: row.order_ref, action: "UPDATED", version: updated.version, status: updated.status, before, after: publicOrder(updated), actor, ip });
  return publicOrder(updated);
}

function transitionOrder(db, tenant, row, nextStatus, actor, ip, eventType) {
  const target = assertOrderTransition(row.status, nextStatus);
  const before = publicOrder(row);
  updateRow(db, "change_orders", row.id, { status: target, version: bumpVersion(row), updated_by: actor?.id ?? null }, { columns: UPDATE_COLUMNS });
  const updated = queryOne(db, "SELECT * FROM change_orders WHERE id = ?", [row.id]);
  recordChange(db, { tenantId: tenant, entityType: "ORDER", entityId: row.id, entityRef: row.order_ref, action: "STATUS_CHANGED", version: updated.version, status: target, before, after: publicOrder(updated), actor, ip });
  publishChangeEvent(db, { eventType, objectType: "change_order", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { order_ref: updated.order_ref, from: row.status, to: target } }, actor);
  return updated;
}

export function submitOrder(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireOrderRow(db, tenant, ref);
  return publicOrder(transitionOrder(db, tenant, row, "IN_REVIEW", actor, ip, "ChangeOrderSubmitted"));
}

export function cancelOrder(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireOrderRow(db, tenant, ref);
  return publicOrder(transitionOrder(db, tenant, row, "CANCELLED", actor, ip, "ChangeOrderCancelled"));
}

// CCB decision. On approval, best-effort fires the generic
// `lifecycle.release.approved` event so any registered `workflow_bindings`
// row (see foundation.js) can auto-start a CCB workflow instance — the exact
// mechanism proven by server/tests/workflow.test.js's lifecycle-bridge test.
// This is additive: the ECO's own approval is authoritative regardless of
// whether a binding is registered or the trigger succeeds.
export function decideOrder(db, tenantId, ref, decision, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireOrderRow(db, tenant, ref);
  const approved = String(decision).toUpperCase() === "APPROVED";
  const updated = transitionOrder(db, tenant, row, approved ? "APPROVED" : "REJECTED", actor, ip, approved ? "ChangeOrderApproved" : "ChangeOrderRejected");
  if (approved) {
    try {
      triggerEvent(
        db,
        "lifecycle.release.approved",
        { object_type: "change_order", object_id: updated.id, object_code: updated.order_number, organization_id: updated.organization_id },
        { actor, tenantId: tenant, ip }
      );
    } catch {
      // Workflow binding is optional; the ECO approval stands regardless.
    }
  }
  return publicOrder(updated);
}

// Release: the integration point. For each affected item, create a real
// effectivity definition + assignment in the Versioning kernel, then freeze
// a baseline snapshot of the whole affected set as the change's immutable
// record.
export function releaseOrder(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireOrderRow(db, tenant, ref);
  if (row.status !== "APPROVED") throw invalidOrder(`Change order ${row.order_number} must be APPROVED before it can be released`, { status: row.status });
  const affectedItems = getAffectedItemRows(db, row.id);
  if (!affectedItems.length) throw noAffectedItems(row.order_ref);

  const effectiveFrom = nowIso().slice(0, 10);
  const effectivityResults = [];
  for (const item of affectedItems) {
    try {
      const definition = createEffectivityDefinition(
        db,
        {
          code: `${row.order_number}-${item.id}`,
          name: `${row.order_number} effectivity for ${item.object_type}:${item.object_id}`,
          typeCode: "DATE_EFFECTIVITY",
          dimension: "date",
          effectiveFrom,
        },
        actor,
        tenant,
        ip
      );
      const assignment = createEffectivityAssignment(
        db,
        definition.definition_ref || definition.code,
        { objectType: item.object_type, objectId: item.object_id, role: "primary" },
        actor,
        tenant,
        ip
      );
      recordAffectedItemResult(db, item.id, { effectivityDefinitionId: definition.id, effectivityAssignmentId: assignment.id });
      effectivityResults.push({ item_id: item.id, definition_id: definition.id, assignment_id: assignment.id });
    } catch (err) {
      // One affected item's effectivity failing must not silently corrupt the
      // release; record it in history and surface it to the caller.
      effectivityResults.push({ item_id: item.id, error: err?.message || String(err) });
    }
  }

  let baselineId = null;
  try {
    const baseline = createBaseline(
      db,
      {
        code: row.order_number,
        name: `${row.order_number} release baseline`,
        description: row.title,
        context: { effective_from: effectiveFrom, change_order_id: row.id },
        objects: affectedItems.map((item) => ({ objectType: item.object_type, objectId: item.object_id })),
      },
      actor,
      tenant,
      ip
    );
    freezeBaseline(db, baseline.baseline_ref || baseline.code, actor, ip);
    baselineId = baseline.id;
  } catch {
    // Baseline snapshot is a best-effort record of the release, not a gate.
  }

  const before = publicOrder(row);
  updateRow(
    db,
    "change_orders",
    row.id,
    { status: "RELEASED", released_at: nowIso(), released_by: actor?.id ?? null, baseline_id: baselineId, version: bumpVersion(row), updated_by: actor?.id ?? null },
    { columns: [...UPDATE_COLUMNS, "released_at", "released_by", "baseline_id"] }
  );
  const updated = queryOne(db, "SELECT * FROM change_orders WHERE id = ?", [row.id]);
  recordChange(db, {
    tenantId: tenant,
    entityType: "ORDER",
    entityId: row.id,
    entityRef: row.order_ref,
    action: "RELEASED",
    version: updated.version,
    status: "RELEASED",
    before,
    after: publicOrder(updated),
    details: { affected_items: effectivityResults, baseline_id: baselineId },
    actor,
    ip,
  });
  publishChangeEvent(db, { eventType: "ChangeOrderReleased", objectType: "change_order", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { order_ref: updated.order_ref, baseline_id: baselineId, affected_item_count: affectedItems.length } }, actor);
  return { order: publicOrder(updated), effectivity: effectivityResults, baseline_id: baselineId };
}

export function listOrderHistory(db, tenantId, ref) {
  const row = requireOrderRow(db, tenantId, ref);
  return listHistory(db, { tenantId, entityType: "ORDER", entityId: row.id });
}
