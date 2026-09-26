// Change Notice (ECN) service. An ECN is issued off a released Change Order
// to notify stakeholders that a change has taken effect.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { nextNumber } from "../numbering.js";
import { updateRow, assertVersion, bumpVersion } from "./sql.js";
import { publicNotice } from "./repository.js";
import { noticeRef } from "./refs.js";
import { recordChange, listHistory } from "./history.js";
import { publishChangeEvent } from "./events.js";
import { normalizeNoticeInput, normalizeText, assertNoticeTransition, paginate } from "./validation.js";
import { noticeNotFound, noticeConflict, invalidNotice, changeConflict } from "./errors.js";
import { SOURCE_MODULE, NUMBERING_OBJECT_TYPES } from "./constants.js";
import { requireOrderRow } from "./orders.js";
import { createRelationship } from "./relationships.js";

const UPDATE_COLUMNS = ["title", "description", "organization_id", "status", "distribution_json", "metadata_json", "version", "updated_by"];

export function getNoticeRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM change_notices WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(
    db,
    "SELECT * FROM change_notices WHERE tenant_id = ? AND (notice_ref = ? OR notice_number = ? COLLATE NOCASE)",
    [Number(tenantId), String(ref), String(ref)]
  );
}

export function requireNoticeRow(db, tenantId, ref) {
  const row = getNoticeRow(db, tenantId, ref);
  if (!row) throw noticeNotFound(ref);
  return row;
}

export function getNotice(db, tenantId, ref) {
  return publicNotice(requireNoticeRow(db, tenantId, ref));
}

export function listNotices(db, { tenantId, status, changeOrderId, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(String(status).toUpperCase());
  }
  if (changeOrderId != null) {
    clauses.push("change_order_id = ?");
    params.push(Number(changeOrderId));
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM change_notices ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM change_notices ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicNotice), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function createNotice(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeNoticeInput(body, {});
  const order = requireOrderRow(db, tenant, normalized.change_order_id);
  if (order.status !== "RELEASED") throw invalidNotice(`Change order ${order.order_number} must be RELEASED before a notice can be issued`, { status: order.status });
  const noticeNumber = normalizeText(body.notice_number ?? body.noticeNumber, { max: 60 }) || nextNumber(db, { objectType: NUMBERING_OBJECT_TYPES.NOTICE }, actor, { tenantId: tenant });
  if (!noticeNumber) throw invalidNotice("Unable to generate a notice number; register an active ECN numbering scheme");
  const existing = queryOne(db, "SELECT id FROM change_notices WHERE tenant_id = ? AND notice_number = ?", [tenant, noticeNumber]);
  if (existing) throw noticeConflict(noticeNumber);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO change_notices
       (notice_ref, tenant_id, organization_id, notice_number, title, description, change_order_id, status,
        distribution_json, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, 1, ?, ?, ?, ?)`,
    [
      noticeRef(noticeNumber),
      tenant,
      normalized.organization_id ?? order.organization_id,
      noticeNumber,
      normalized.title || `Notice for ${order.order_number}`,
      normalized.description || order.title,
      order.id,
      JSON.stringify(normalized.distribution || []),
      JSON.stringify(normalized.metadata || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM change_notices WHERE id = ?", [Number(result.lastInsertRowid)]);
  createRelationship(db, tenant, { relationship_type: "PRODUCES_NOTICE", source_type: "change_order", source_id: String(order.id), target_type: "change_notice", target_id: String(row.id) }, actor, ip);
  recordChange(db, { tenantId: tenant, entityType: "NOTICE", entityId: row.id, entityRef: row.notice_ref, action: "CREATED", version: 1, status: row.status, after: publicNotice(row), actor, ip });
  publishChangeEvent(db, { eventType: "ChangeNoticeCreated", objectType: "change_notice", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { notice_ref: row.notice_ref, notice_number: row.notice_number } }, actor);
  return publicNotice(row);
}

function transitionNotice(db, tenant, row, nextStatus, actor, ip, eventType, extra = {}) {
  const target = assertNoticeTransition(row.status, nextStatus);
  const before = publicNotice(row);
  updateRow(db, "change_notices", row.id, { status: target, version: bumpVersion(row), updated_by: actor?.id ?? null, ...extra }, { columns: [...UPDATE_COLUMNS, "issued_at", "issued_by", "acknowledged_at"] });
  const updated = queryOne(db, "SELECT * FROM change_notices WHERE id = ?", [row.id]);
  recordChange(db, { tenantId: tenant, entityType: "NOTICE", entityId: row.id, entityRef: row.notice_ref, action: "STATUS_CHANGED", version: updated.version, status: target, before, after: publicNotice(updated), actor, ip });
  publishChangeEvent(db, { eventType, objectType: "change_notice", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { notice_ref: updated.notice_ref, from: row.status, to: target } }, actor);
  return updated;
}

export function issueNotice(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireNoticeRow(db, tenant, ref);
  return publicNotice(transitionNotice(db, tenant, row, "ISSUED", actor, ip, "ChangeNoticeIssued", { issued_at: nowIso(), issued_by: actor?.id ?? null }));
}

export function acknowledgeNotice(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireNoticeRow(db, tenant, ref);
  return publicNotice(transitionNotice(db, tenant, row, "ACKNOWLEDGED", actor, ip, "ChangeNoticeAcknowledged", { acknowledged_at: nowIso() }));
}

export function listNoticeHistory(db, tenantId, ref) {
  const row = requireNoticeRow(db, tenantId, ref);
  return listHistory(db, { tenantId, entityType: "NOTICE", entityId: row.id });
}
