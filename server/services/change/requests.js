// Change Request (ECR) service. An ECR captures the need for a change and is
// screened by the CCB; once approved it is promoted to a Change Order (ECO).
// Numbers come from the shared Numbering & Identifier Service — no literal
// numbers are hard-coded (unlike PDM's own demo seed).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { nextNumber } from "../numbering.js";
import { updateRow, assertVersion, bumpVersion } from "./sql.js";
import { publicRequest } from "./repository.js";
import { requestRef } from "./refs.js";
import { recordChange, listHistory } from "./history.js";
import { publishChangeEvent } from "./events.js";
import { normalizeRequestInput, normalizeText, assertRequestTransition, paginate } from "./validation.js";
import { requestNotFound, requestConflict, invalidRequest, requestImmutable, changeConflict } from "./errors.js";
import { SOURCE_MODULE, NUMBERING_OBJECT_TYPES } from "./constants.js";
import { createRelationship } from "./relationships.js";
import { createOrder } from "./orders.js";

const UPDATE_COLUMNS = ["title", "description", "category", "priority", "reason", "organization_id", "status", "metadata_json", "version", "updated_by"];
const IMMUTABLE_STATUSES = ["REJECTED", "WITHDRAWN", "PROMOTED"];

export function getRequestRow(db, tenantId, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    const row = queryOne(db, "SELECT * FROM change_requests WHERE id = ? AND tenant_id = ?", [id, Number(tenantId)]);
    if (row) return row;
  }
  return queryOne(
    db,
    "SELECT * FROM change_requests WHERE tenant_id = ? AND (request_ref = ? OR request_number = ? COLLATE NOCASE)",
    [Number(tenantId), String(ref), String(ref)]
  );
}

export function requireRequestRow(db, tenantId, ref) {
  const row = getRequestRow(db, tenantId, ref);
  if (!row) throw requestNotFound(ref);
  return row;
}

export function getRequest(db, tenantId, ref) {
  return publicRequest(requireRequestRow(db, tenantId, ref));
}

export function listRequests(db, { tenantId, status, category, q, page, pageSize } = {}) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    clauses.push("status = ?");
    params.push(String(status).toUpperCase());
  }
  if (category) {
    clauses.push("category = ?");
    params.push(String(category).toUpperCase());
  }
  if (q) {
    clauses.push("(request_number LIKE ? OR title LIKE ? OR description LIKE ?)");
    const like = `%${normalizeText(q, { max: 120 })}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM change_requests ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM change_requests ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicRequest), total, page: currentPage, page_size: limit, source_module: SOURCE_MODULE };
}

export function createRequest(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const normalized = normalizeRequestInput(body, {});
  if (!normalized.title) throw invalidRequest("title is required");
  const requestNumber = normalizeText(body.request_number ?? body.requestNumber, { max: 60 }) || nextNumber(db, { objectType: NUMBERING_OBJECT_TYPES.REQUEST }, actor, { tenantId: tenant });
  if (!requestNumber) throw invalidRequest("Unable to generate a request number; register an active ECR numbering scheme");
  const existing = queryOne(db, "SELECT id FROM change_requests WHERE tenant_id = ? AND request_number = ?", [tenant, requestNumber]);
  if (existing) throw requestConflict(requestNumber);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO change_requests
       (request_ref, tenant_id, organization_id, request_number, title, description, category, priority, status,
        requested_by, reason, metadata_json, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      requestRef(requestNumber),
      tenant,
      normalized.organization_id,
      requestNumber,
      normalized.title,
      normalized.description,
      normalized.category,
      normalized.priority,
      actor?.id ?? null,
      normalized.reason,
      JSON.stringify(normalized.metadata || {}),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM change_requests WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordChange(db, { tenantId: tenant, entityType: "REQUEST", entityId: row.id, entityRef: row.request_ref, action: "CREATED", version: 1, status: row.status, after: publicRequest(row), actor, ip });
  publishChangeEvent(db, { eventType: "ChangeRequestCreated", objectType: "change_request", objectId: row.id, tenantId: tenant, organizationId: row.organization_id, payload: { request_ref: row.request_ref, request_number: row.request_number } }, actor);
  return publicRequest(row);
}

export function updateRequest(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRequestRow(db, tenant, ref);
  if (IMMUTABLE_STATUSES.includes(row.status)) throw requestImmutable(row.request_ref, row.status);
  assertVersion(row, body.version ?? body.expected_version, (details) => changeConflict(`Change request ${row.request_number} was modified by another user`, details));
  const before = publicRequest(row);
  const normalized = normalizeRequestInput(body, row);
  updateRow(
    db,
    "change_requests",
    row.id,
    {
      title: normalized.title,
      description: normalized.description,
      category: normalized.category,
      priority: normalized.priority,
      reason: normalized.reason,
      organization_id: normalized.organization_id,
      metadata_json: JSON.stringify(normalized.metadata || {}),
      version: bumpVersion(row),
      updated_by: actor?.id ?? null,
    },
    { columns: UPDATE_COLUMNS }
  );
  const updated = queryOne(db, "SELECT * FROM change_requests WHERE id = ?", [row.id]);
  recordChange(db, { tenantId: tenant, entityType: "REQUEST", entityId: row.id, entityRef: row.request_ref, action: "UPDATED", version: updated.version, status: updated.status, before, after: publicRequest(updated), actor, ip });
  return publicRequest(updated);
}

function transitionRequest(db, tenant, row, nextStatus, actor, ip, eventType) {
  const target = assertRequestTransition(row.status, nextStatus);
  const before = publicRequest(row);
  updateRow(db, "change_requests", row.id, { status: target, version: bumpVersion(row), updated_by: actor?.id ?? null }, { columns: UPDATE_COLUMNS });
  const updated = queryOne(db, "SELECT * FROM change_requests WHERE id = ?", [row.id]);
  recordChange(db, { tenantId: tenant, entityType: "REQUEST", entityId: row.id, entityRef: row.request_ref, action: "STATUS_CHANGED", version: updated.version, status: target, before, after: publicRequest(updated), actor, ip });
  publishChangeEvent(db, { eventType, objectType: "change_request", objectId: row.id, tenantId: tenant, organizationId: updated.organization_id, payload: { request_ref: updated.request_ref, from: row.status, to: target } }, actor);
  return updated;
}

export function submitRequest(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRequestRow(db, tenant, ref);
  const updated = transitionRequest(db, tenant, row, "SUBMITTED", actor, ip, "ChangeRequestSubmitted");
  return publicRequest(updated);
}

export function withdrawRequest(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRequestRow(db, tenant, ref);
  const updated = transitionRequest(db, tenant, row, "WITHDRAWN", actor, ip, "ChangeRequestScreened");
  return publicRequest(updated);
}

// CCB screening decision: "approved" or "rejected".
export function screenRequest(db, tenantId, ref, decision, notes, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRequestRow(db, tenant, ref);
  const inScreening = row.status === "SUBMITTED" ? transitionRequest(db, tenant, row, "SCREENING", actor, ip, "ChangeRequestScreened") : row;
  const target = String(decision).toUpperCase() === "APPROVED" ? "APPROVED" : "REJECTED";
  const updated = transitionRequest(db, tenant, inScreening, target, actor, ip, "ChangeRequestScreened");
  if (notes) updateRow(db, "change_requests", row.id, { reason: `${updated.reason ? `${updated.reason}\n` : ""}CCB: ${normalizeText(notes, { max: 2000 })}` }, { columns: ["reason"] });
  return publicRequest(queryOne(db, "SELECT * FROM change_requests WHERE id = ?", [row.id]));
}

// Promotes an approved ECR into a new ECO, linking the two via a
// PRODUCES_ORDER relationship and moving the ECR to PROMOTED.
export function promoteRequest(db, tenantId, ref, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = requireRequestRow(db, tenant, ref);
  if (row.status !== "APPROVED") throw invalidRequest(`Change request ${row.request_number} must be APPROVED before it can be promoted`, { status: row.status });
  const order = createOrder(
    db,
    tenant,
    {
      title: body.title || row.title,
      description: body.description || row.description,
      change_request_id: row.id,
      organization_id: body.organization_id ?? row.organization_id,
      effective_strategy: body.effective_strategy,
      metadata: body.metadata,
    },
    actor,
    ip
  );
  createRelationship(db, tenant, { relationship_type: "PRODUCES_ORDER", source_type: "change_request", source_id: String(row.id), target_type: "change_order", target_id: String(order.id) }, actor, ip);
  const updated = transitionRequest(db, tenant, row, "PROMOTED", actor, ip, "ChangeRequestPromoted");
  return { request: publicRequest(updated), order };
}

export function listRequestHistory(db, tenantId, ref) {
  const row = requireRequestRow(db, tenantId, ref);
  return listHistory(db, { tenantId, entityType: "REQUEST", entityId: row.id });
}
