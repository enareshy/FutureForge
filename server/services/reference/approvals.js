// Reference data approvals and change requests. Domains with
// `approval_required` governance cannot move an item to active until an
// approval record has been approved; the workflow engine can be attached via
// workflow_definition_code for multi-step routing.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { approvalNotFound, conflict, invalidApprovalTransition, invalidItem, itemNotFound } from "./errors.js";
import { APPROVAL_STATUSES, CHANGE_TYPES, normalizeText, pagination } from "./validation.js";
import { approvalRef, changeRef } from "./refs.js";
import { bumpCacheEpoch } from "./cache.js";
import { emitItemEvent } from "./events.js";
import { getActiveGovernancePolicy } from "./governance.js";
import { requireItem, setItemStatus } from "./items.js";

export function publicApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    approval_ref: row.approval_ref,
    item_id: row.item_id,
    domain_id: row.domain_id,
    version_id: row.version_id,
    status: row.status,
    required_approvals: row.required_approvals,
    approval_count: row.approval_count,
    submitted_by: row.submitted_by,
    submitted_at: row.submitted_at,
    decided_by: row.decided_by,
    decided_at: row.decided_at,
    decision_reason: row.decision_reason,
    workflow_instance_id: row.workflow_instance_id,
    workflow_definition_code: row.workflow_definition_code,
    tenant_id: row.tenant_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listApprovals(db, { itemId, domainId, status, assigneeId, page, pageSize } = {}) {
  const clauses = [];
  const params = [];
  if (itemId !== undefined && itemId !== null) {
    clauses.push("a.item_id = ?");
    params.push(Number(itemId));
  }
  if (domainId !== undefined && domainId !== null) {
    clauses.push("a.domain_id = ?");
    params.push(Number(domainId));
  }
  if (status) {
    const statuses = Array.isArray(status) ? status : String(status).split(",").map((s) => s.trim()).filter(Boolean);
    clauses.push(`a.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (assigneeId !== undefined && assigneeId !== null) {
    clauses.push("a.decided_by = ?");
    params.push(Number(assigneeId));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { limit, offset, page: pageNum } = pagination({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 200 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM reference_approvals a ${where}`, params)?.c ?? 0);
  const rows = queryAll(db, `SELECT a.*, i.code AS item_code FROM reference_approvals a LEFT JOIN reference_data_items i ON i.id = a.item_id ${where} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map((row) => ({ ...publicApproval(row), item_code: row.item_code })), total, page: pageNum, page_size: limit };
}

export function getApprovalRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM reference_approvals WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM reference_approvals WHERE approval_ref = ?", [String(ref)]) || null;
}

export function getApproval(db, ref) {
  const row = getApprovalRow(db, ref);
  if (!row) throw approvalNotFound(ref);
  return publicApproval(row);
}

export function submitForApproval(db, itemRefValue, input = {}, actor = null, tenantId = null, ip = null) {
  const item = requireItem(db, itemRefValue);
  if (["retired", "inactive"].includes(item.status)) throw conflict("The item is not in a submittable state", { status: item.status });
  const governance = getActiveGovernancePolicy(db, item.domain_id);
  const existing = queryOne(db, "SELECT * FROM reference_approvals WHERE item_id = ? AND status IN ('submitted','under_review')", [item.id]);
  if (existing) throw conflict("An approval is already open for this item", { approval_ref: existing.approval_ref });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reference_approvals
      (approval_ref, item_id, domain_id, version_id, status, required_approvals, approval_count, submitted_by, submitted_at,
       workflow_definition_code, metadata_json, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'submitted', ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    [
      approvalRef(),
      Number(item.id),
      Number(item.domain_id),
      input.version_id ?? null,
      Math.max(1, Number(input.required_approvals) || 1),
      actor?.id ?? null,
      ts,
      normalizeText(input.workflow_definition_code, governance.workflow_definition_code),
      JSON.stringify(input.metadata ?? {}),
      tenantId ?? item.tenant_id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM reference_approvals WHERE id = ?", [Number(result.lastInsertRowid)]);
  if (item.status !== "submitted") {
    try {
      setItemStatus(db, item.item_ref, "submitted", actor, ip, { reason: normalizeText(input.reason, "Submitted for approval") });
    } catch {
      /* the approval record is the source of truth; lifecycle convergence is best effort */
    }
  }
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.approval.submit",
    resourceType: "reference_approval",
    resourceId: row.id,
    details: { item_id: item.id, item_ref: item.item_ref },
    ip,
  });
  return publicApproval(row);
}

export function decideApproval(db, ref, input = {}, actor = null, ip = null) {
  const row = getApprovalRow(db, ref);
  if (!row) throw approvalNotFound(ref);
  const decision = String(input.decision || input.status || "").toLowerCase();
  if (!["approve", "approved", "reject", "rejected", "return", "returned", "cancel", "cancelled", "review", "under_review"].includes(decision)) {
    throw invalidApprovalTransition(row.status, decision);
  }
  const item = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [row.item_id]);
  if (!item) throw itemNotFound(row.item_id);
  const ts = nowIso();
  const reason = normalizeText(input.reason ?? input.decision_reason);
  let nextStatus = row.status;
  let itemStatus = null;
  if (["approve", "approved"].includes(decision)) {
    const count = Number(row.approval_count) + 1;
    const required = Number(row.required_approvals) || 1;
    if (count >= required) {
      nextStatus = "approved";
      itemStatus = "approved";
    } else {
      nextStatus = "under_review";
    }
    run(
      db,
      "UPDATE reference_approvals SET status = ?, approval_count = ?, decided_by = ?, decided_at = ?, decision_reason = ?, updated_at = ? WHERE id = ?",
      [nextStatus, count, actor?.id ?? null, ts, reason, ts, row.id]
    );
  } else if (["reject", "rejected"].includes(decision)) {
    nextStatus = "rejected";
    itemStatus = "rejected";
  } else if (["return", "returned"].includes(decision)) {
    nextStatus = "returned";
    itemStatus = "returned";
  } else if (["cancel", "cancelled"].includes(decision)) {
    nextStatus = "cancelled";
  } else {
    nextStatus = "under_review";
  }
  if (nextStatus !== row.status && !["under_review"].includes(nextStatus)) {
    run(
      db,
      "UPDATE reference_approvals SET status = ?, decided_by = ?, decided_at = ?, decision_reason = ?, updated_at = ? WHERE id = ?",
      [nextStatus, actor?.id ?? null, ts, reason, ts, row.id]
    );
  } else if (nextStatus === "under_review") {
    run(db, "UPDATE reference_approvals SET status = ?, updated_at = ? WHERE id = ?", [nextStatus, ts, row.id]);
  }
  if (itemStatus) {
    try {
      setItemStatus(db, item.item_ref, itemStatus, actor, ip, { reason });
    } catch {
      /* lifecycle hooks must not fail the approval decision */
    }
  }
  bumpCacheEpoch(db);
  writeAudit(db, {
    actor,
    action: "reference.approval.decide",
    resourceType: "reference_approval",
    resourceId: row.id,
    details: { item_id: item.id, decision, status: nextStatus, reason },
    ip,
  });
  emitItemEvent(db, itemStatus ? "ReferenceItemApproved" : "ReferenceItemChanged", item, { approval_ref: row.approval_ref, decision, reason }, actor);
  return publicApproval(queryOne(db, "SELECT * FROM reference_approvals WHERE id = ?", [row.id]));
}

// ── Change requests ─────────────────────────────────────────────────────────

export function publicChangeRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    change_ref: row.change_ref,
    domain_id: row.domain_id,
    item_id: row.item_id,
    title: row.title,
    description: row.description,
    change_type: row.change_type,
    status: row.status,
    requested_by: row.requested_by,
    assigned_to: row.assigned_to,
    approval_id: row.approval_id,
    payload: (() => {
      try {
        return JSON.parse(row.payload_json || "{}");
      } catch {
        return {};
      }
    })(),
    requested_at: row.requested_at,
    decided_at: row.decided_at || null,
    decision_reason: row.decision_reason,
    tenant_id: row.tenant_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listChangeRequests(db, { domainId, itemId, status, page, pageSize } = {}) {
  const clauses = [];
  const params = [];
  if (domainId !== undefined && domainId !== null) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  if (itemId !== undefined && itemId !== null) {
    clauses.push("item_id = ?");
    params.push(Number(itemId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const { limit, offset, page: pageNum } = pagination({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 200 });
  const rows = queryAll(db, `SELECT * FROM reference_change_requests ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicChangeRequest), total: rows.length, page: pageNum, page_size: limit };
}

export function createChangeRequest(db, input = {}, actor = null, tenantId = null, ip = null) {
  const title = normalizeText(input.title);
  if (!title) throw invalidItem("title is required");
  const changeType = CHANGE_TYPES.includes(input.change_type) ? input.change_type : "update";
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reference_change_requests
      (change_ref, domain_id, item_id, title, description, change_type, status, requested_by, assigned_to, payload_json, requested_at, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ?, ?, ?)`,
    [
      changeRef(),
      input.domain_id ?? null,
      input.item_id ?? null,
      title,
      normalizeText(input.description),
      changeType,
      actor?.id ?? null,
      input.assigned_to ?? null,
      JSON.stringify(input.payload ?? {}),
      ts,
      tenantId ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM reference_change_requests WHERE id = ?", [Number(result.lastInsertRowid)]);
  writeAudit(db, {
    actor,
    action: "reference.change_request.create",
    resourceType: "reference_change_request",
    resourceId: row.id,
    details: { change_ref: row.change_ref, change_type: changeType },
    ip,
  });
  return publicChangeRequest(row);
}

export function updateChangeRequest(db, ref, patch = {}, actor = null, ip = null) {
  const numeric = Number(ref);
  const row = queryOne(db, "SELECT * FROM reference_change_requests WHERE id = ? OR change_ref = ?", [Number.isInteger(numeric) ? numeric : 0, String(ref)]);
  if (!row) throw conflict(`Reference change request not found: ${ref}`, { ref });
  const clauses = [];
  const params = [];
  const set = (column, value) => {
    clauses.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.title !== undefined) set("title", normalizeText(patch.title, row.title));
  if (patch.description !== undefined) set("description", normalizeText(patch.description));
  if (patch.assigned_to !== undefined) set("assigned_to", patch.assigned_to ?? null);
  if (patch.status !== undefined && APPROVAL_STATUSES.includes(patch.status)) set("status", patch.status);
  if (["approved", "rejected", "applied", "cancelled"].includes(patch.status)) set("decided_at", nowIso());
  if (patch.decision_reason !== undefined) set("decision_reason", normalizeText(patch.decision_reason));
  if (!clauses.length) return publicChangeRequest(row);
  set("updated_at", nowIso());
  params.push(row.id);
  run(db, `UPDATE reference_change_requests SET ${clauses.join(", ")} WHERE id = ?`, params);
  writeAudit(db, {
    actor,
    action: "reference.change_request.update",
    resourceType: "reference_change_request",
    resourceId: row.id,
    details: { status: patch.status ?? row.status },
    ip,
  });
  return publicChangeRequest(queryOne(db, "SELECT * FROM reference_change_requests WHERE id = ?", [row.id]));
}
