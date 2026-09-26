// Exception management. A failed quality check can open an exception that is
// assigned, worked, resolved, verified and closed. Assignment, priority, SLA,
// due date and escalation are all recorded so nothing silently rots.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { exceptionConflict, exceptionNotFound, invalidExceptionTransition, invalidRule } from "./errors.js";
import {
  assertExceptionStatus,
  assertPriority,
  assertSeverity,
  normalizeText,
  paginate,
} from "./validation.js";
import {
  DEFAULT_SLA_HOURS,
  EXCEPTION_PRIORITIES,
  EXCEPTION_TERMINAL_STATUSES,
  EXCEPTION_TRANSITIONS,
} from "./constants.js";
import { exceptionRef } from "./refs.js";
import { publicException, publicExceptionComment } from "./repository.js";
import { publishGovernanceEvent } from "./events.js";
import { getConfig } from "./configuration.js";

export { publicException, publicExceptionComment };

function addHours(hours) {
  const date = new Date(Date.now() + Number(hours) * 3600000);
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function publicWithComments(db, row) {
  const comments = queryAll(db, "SELECT * FROM dg_exception_comments WHERE exception_id = ? ORDER BY created_at", [row.id]);
  return publicException(row, { comments });
}

export function getExceptionRow(db, ref) {
  if (ref === null || ref === undefined || ref === "") return null;
  const numeric = Number(ref);
  if (Number.isInteger(numeric) && String(numeric) === String(ref).trim()) {
    const byId = queryOne(db, "SELECT * FROM dg_quality_exceptions WHERE id = ?", [numeric]);
    if (byId) return byId;
  }
  return queryOne(db, "SELECT * FROM dg_quality_exceptions WHERE exception_ref = ?", [String(ref)]) || null;
}

export function requireException(db, ref) {
  const row = getExceptionRow(db, ref);
  if (!row) throw exceptionNotFound(ref);
  return row;
}

export function listExceptions(
  db,
  { tenantId, status, priority, severity, dimension, objectType, objectId, domainId, assigneeUserId, assigneeGroupId, ruleCode, overdue, q, page, pageSize } = {}
) {
  const clauses = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (status) {
    const statuses = Array.isArray(status) ? status : String(status).split(",").map((s) => s.trim()).filter(Boolean);
    clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses.map((s) => assertExceptionStatus(normalizeText(s).toUpperCase())));
  }
  if (priority) {
    clauses.push("priority = ?");
    params.push(assertPriority(normalizeText(priority).toLowerCase()));
  }
  if (severity) {
    clauses.push("severity = ?");
    params.push(assertSeverity(normalizeText(severity).toLowerCase()));
  }
  if (dimension) {
    clauses.push("dimension = ?");
    params.push(normalizeText(dimension).toLowerCase());
  }
  if (objectType) {
    clauses.push("object_type = ?");
    params.push(String(objectType).toLowerCase());
  }
  if (objectId) {
    clauses.push("object_id = ?");
    params.push(String(objectId));
  }
  if (domainId) {
    clauses.push("domain_id = ?");
    params.push(Number(domainId));
  }
  if (assigneeUserId) {
    clauses.push("assignee_user_id = ?");
    params.push(Number(assigneeUserId));
  }
  if (assigneeGroupId) {
    clauses.push("assignee_group_id = ?");
    params.push(Number(assigneeGroupId));
  }
  if (ruleCode) {
    clauses.push("rule_code = ?");
    params.push(String(ruleCode).toUpperCase());
  }
  if (overdue) {
    clauses.push(`due_date IS NOT NULL AND due_date < datetime('now') AND status NOT IN (${EXCEPTION_TERMINAL_STATUSES.map(() => "?").join(",")})`);
    params.push(...EXCEPTION_TERMINAL_STATUSES);
  }
  if (q) {
    const like = `%${String(q).toLowerCase()}%`;
    clauses.push("(LOWER(exception_ref) LIKE ? OR LOWER(object_id) LIKE ? OR LOWER(description) LIKE ? OR LOWER(rule_code) LIKE ?)");
    params.push(like, like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page: currentPage } = paginate({ page, pageSize }, { defaultPageSize: 50, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM dg_quality_exceptions ${where}`, params)?.c ?? 0);
  const rows = queryAll(db, `SELECT * FROM dg_quality_exceptions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map((row) => publicException(row)), total, page: currentPage, page_size: limit };
}

export function getException(db, ref, { includeComments = true } = {}) {
  const row = requireException(db, ref);
  return includeComments ? publicWithComments(db, row) : publicException(row);
}

export function createException(db, input = {}, actor = null, tenantId = null, ip = null) {
  const severity = assertSeverity(normalizeText(input.severity || "warning").toLowerCase());
  const priority = input.priority ? assertPriority(normalizeText(input.priority).toLowerCase()) : "normal";
  const slaHours = input.sla_hours !== undefined ? Number(input.sla_hours) : DEFAULT_SLA_HOURS[priority] ?? 72;
  if (!Number.isFinite(slaHours) || slaHours <= 0) throw invalidRule("sla_hours must be a positive number");

  const duplicate = queryOne(
    db,
    `SELECT id FROM dg_quality_exceptions
      WHERE tenant_id = ? AND object_type = ? AND object_id = ? AND rule_code = ?
        AND status NOT IN (${EXCEPTION_TERMINAL_STATUSES.map(() => "?").join(",")})`,
    [Number(tenantId), normalizeText(input.object_type), normalizeText(input.object_id), normalizeText(input.rule_code).toUpperCase(), ...EXCEPTION_TERMINAL_STATUSES]
  );
  if (duplicate) throw exceptionConflict(normalizeText(input.rule_code), { existing_id: duplicate.id });

  const ts = nowIso();
  const status = input.status ? assertExceptionStatus(normalizeText(input.status).toUpperCase()) : "OPEN";
  const result = run(
    db,
    `INSERT INTO dg_quality_exceptions
      (exception_ref, tenant_id, organization_id, plant_id, domain_id, object_type, object_id, attribute_name,
       rule_id, rule_code, dimension, severity, priority, description, detected_value, expected_value,
       owner_user_id, steward_user_id, assignee_user_id, assignee_group_id, assignee_organization_id,
       status, sla_hours, due_date, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      exceptionRef(),
      Number(tenantId),
      input.organization_id ?? null,
      input.plant_id ?? null,
      input.domain_id ? Number(input.domain_id) : null,
      normalizeText(input.object_type),
      normalizeText(input.object_id),
      normalizeText(input.attribute_name),
      input.rule_id ? Number(input.rule_id) : null,
      normalizeText(input.rule_code).toUpperCase(),
      normalizeText(input.dimension, "validity").toLowerCase(),
      severity,
      priority,
      normalizeText(input.description),
      normalizeText(input.detected_value),
      normalizeText(input.expected_value),
      input.owner_user_id ?? null,
      input.steward_user_id ?? null,
      input.assignee_user_id ?? null,
      input.assignee_group_id ?? null,
      input.assignee_organization_id ?? null,
      status,
      slaHours,
      input.due_date || addHours(slaHours),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = requireException(db, Number(result.lastInsertRowid));
  addComment(db, row, { comment: normalizeText(input.comment) || "Exception created", status_change: "OPEN" }, actor);
  writeAudit(db, {
    actor,
    action: "data_quality.exception.create",
    resourceType: "dg_quality_exception",
    resourceId: row.id,
    details: { exception_ref: row.exception_ref, rule_code: row.rule_code, severity, priority },
    ip,
  });
  publishGovernanceEvent(db, {
    eventType: "DataQualityExceptionCreated",
    tenantId: row.tenant_id,
    objectType: row.object_type,
    objectId: row.object_id,
    payload: { exception_ref: row.exception_ref, rule_code: row.rule_code, severity, priority },
  }, actor);
  return publicWithComments(db, row);
}

export function assignException(db, ref, input = {}, actor = null, ip = null) {
  const row = requireException(db, ref);
  if (EXCEPTION_TERMINAL_STATUSES.includes(row.status)) {
    throw invalidExceptionTransition(row.status, "ASSIGNED");
  }
  const priority = input.priority ? assertPriority(normalizeText(input.priority).toLowerCase()) : row.priority;
  const slaHours = input.sla_hours !== undefined ? Number(input.sla_hours) : DEFAULT_SLA_HOURS[priority] ?? row.sla_hours ?? 72;
  const changes = ["assignee_user_id = ?", "assignee_group_id = ?", "assignee_organization_id = ?", "priority = ?", "sla_hours = ?", "due_date = ?", "status = ?", "updated_at = ?"];
  const params = [
    input.assignee_user_id ?? null,
    input.assignee_group_id ?? null,
    input.assignee_organization_id ?? null,
    priority,
    slaHours,
    input.due_date || addHours(slaHours),
    row.status === "OPEN" ? "ASSIGNED" : row.status,
    nowIso(),
  ];
  run(db, `UPDATE dg_quality_exceptions SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  const updated = requireException(db, row.id);
  addComment(db, updated, { comment: normalizeText(input.comment) || "Exception assigned", status_change: updated.status }, actor);
  writeAudit(db, {
    actor,
    action: "data_quality.exception.assign",
    resourceType: "dg_quality_exception",
    resourceId: row.id,
    details: { assignee_user_id: input.assignee_user_id ?? null, assignee_group_id: input.assignee_group_id ?? null, priority },
    ip,
  });
  publishGovernanceEvent(db, {
    eventType: "DataQualityExceptionAssigned",
    tenantId: row.tenant_id,
    objectType: row.object_type,
    objectId: row.object_id,
    payload: { exception_ref: row.exception_ref, assignee_user_id: input.assignee_user_id ?? null, assignee_group_id: input.assignee_group_id ?? null },
  }, actor);
  return publicWithComments(db, updated);
}

export function updateException(db, ref, patch = {}, actor = null, ip = null) {
  const row = requireException(db, ref);
  if (EXCEPTION_TERMINAL_STATUSES.includes(row.status)) {
    throw invalidExceptionTransition(row.status, row.status);
  }
  const changes = [];
  const params = [];
  const assign = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (patch.description !== undefined) assign("description", normalizeText(patch.description));
  if (patch.priority !== undefined) assign("priority", assertPriority(normalizeText(patch.priority).toLowerCase()));
  if (patch.severity !== undefined) assign("severity", assertSeverity(normalizeText(patch.severity).toLowerCase()));
  if (patch.due_date !== undefined) assign("due_date", patch.due_date || null);
  if (patch.sla_hours !== undefined) assign("sla_hours", patch.sla_hours === null ? null : Number(patch.sla_hours));
  if (patch.owner_user_id !== undefined) assign("owner_user_id", patch.owner_user_id ?? null);
  if (patch.steward_user_id !== undefined) assign("steward_user_id", patch.steward_user_id ?? null);
  if (!changes.length) return publicWithComments(db, row);

  changes.push("updated_at = ?");
  params.push(nowIso());
  run(db, `UPDATE dg_quality_exceptions SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  const updated = requireException(db, row.id);
  addComment(db, updated, { comment: normalizeText(patch.comment) || "Exception updated", status_change: "" }, actor);
  writeAudit(db, {
    actor,
    action: "data_quality.exception.update",
    resourceType: "dg_quality_exception",
    resourceId: row.id,
    details: { exception_ref: row.exception_ref, fields: Object.keys(patch) },
    ip,
  });
  publishGovernanceEvent(db, {
    eventType: "DataQualityExceptionChanged",
    tenantId: row.tenant_id,
    objectType: row.object_type,
    objectId: row.object_id,
    payload: { exception_ref: row.exception_ref, fields: Object.keys(patch) },
  }, actor);
  return publicWithComments(db, updated);
}

export function transitionException(db, ref, status, input = {}, actor = null, ip = null) {
  const row = requireException(db, ref);
  const next = assertExceptionStatus(normalizeText(status).toUpperCase());
  if (next !== row.status) {
    const allowed = EXCEPTION_TRANSITIONS[row.status] || [];
    if (!allowed.includes(next)) throw invalidExceptionTransition(row.status, next);
  }
  const changes = ["status = ?", "updated_at = ?"];
  const params = [next, nowIso()];
  const push = (column, value) => {
    changes.push(`${column} = ?`);
    params.push(value);
  };
  if (next === "RESOLVED") {
    push("resolution", normalizeText(input.resolution));
    push("resolved_by", actor?.id ?? null);
    push("resolved_at", nowIso());
  }
  if (next === "VERIFIED") {
    push("verified_by", actor?.id ?? null);
    push("verified_at", nowIso());
  }
  if (next === "CLOSED") {
    push("closed_by", actor?.id ?? null);
    push("closed_at", nowIso());
  }
  if (next === "WAIVED") {
    push("waived_by", actor?.id ?? null);
    push("waived_at", nowIso());
    push("waiver_reason", normalizeText(input.waiver_reason || input.resolution));
  }
  if (next === "OPEN" || next === "REJECTED") {
    push("resolution", normalizeText(input.resolution, row.resolution));
  }
  run(db, `UPDATE dg_quality_exceptions SET ${changes.join(", ")} WHERE id = ?`, [...params, row.id]);
  const updated = requireException(db, row.id);
  addComment(db, updated, { comment: normalizeText(input.comment || input.resolution) || `Status changed to ${next}`, status_change: next }, actor);
  writeAudit(db, {
    actor,
    action: "data_quality.exception.transition",
    resourceType: "dg_quality_exception",
    resourceId: row.id,
    details: { from: row.status, to: next },
    ip,
  });
  const eventType = next === "RESOLVED" ? "DataQualityExceptionResolved" : next === "CLOSED" ? "DataQualityExceptionClosed" : "DataQualityExceptionCreated";
  publishGovernanceEvent(db, {
    eventType,
    tenantId: row.tenant_id,
    objectType: row.object_type,
    objectId: row.object_id,
    payload: { exception_ref: row.exception_ref, from: row.status, to: next },
  }, actor);
  return publicWithComments(db, updated);
}

export function addExceptionComment(db, ref, input = {}, actor = null) {
  const row = requireException(db, ref);
  return publicExceptionComment(addComment(db, row, input, actor));
}

function addComment(db, row, input = {}, actor = null) {
  const result = run(
    db,
    `INSERT INTO dg_exception_comments (tenant_id, exception_id, author_id, comment, status_change, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [row.tenant_id, row.id, actor?.id ?? null, normalizeText(input.comment), normalizeText(input.status_change), nowIso()]
  );
  return queryOne(db, "SELECT * FROM dg_exception_comments WHERE id = ?", [Number(result.lastInsertRowid)]);
}

export function listExceptionComments(db, ref) {
  const row = requireException(db, ref);
  return queryAll(db, "SELECT * FROM dg_exception_comments WHERE exception_id = ? ORDER BY created_at", [row.id]).map(publicExceptionComment);
}

// Sweeps open exceptions past their due date and raises the escalation level.
// Called by the background maintenance handler; never blocks a request.
export function escalateOverdueExceptions(db, { tenantId = null, limit = 500 } = {}) {
  const params = [];
  let where = `status IN ('OPEN', 'ASSIGNED', 'IN_PROGRESS') AND due_date IS NOT NULL AND due_date < datetime('now')`;
  if (tenantId) {
    where += " AND tenant_id = ?";
    params.push(Number(tenantId));
  }
  const rows = queryAll(db, `SELECT * FROM dg_quality_exceptions WHERE ${where} ORDER BY due_date LIMIT ?`, [...params, Number(limit) || 500]);
  let escalated = 0;
  for (const row of rows) {
    const level = Number(row.escalation_level || 0) + 1;
    run(db, "UPDATE dg_quality_exceptions SET escalation_level = ?, escalated_at = ?, updated_at = ? WHERE id = ?", [
      level,
      nowIso(),
      nowIso(),
      row.id,
    ]);
    escalateNotification(db, row, level);
    escalated += 1;
  }
  return { candidates: rows.length, escalated };
}

function escalateNotification(db, row, level) {
  publishGovernanceEvent(db, {
    eventType: "DataQualityExceptionCreated",
    tenantId: row.tenant_id,
    objectType: row.object_type,
    objectId: row.object_id,
    payload: { exception_ref: row.exception_ref, escalated: true, escalation_level: level, rule_code: row.rule_code },
  }, null);
}

export function exceptionSummary(db, { tenantId } = {}) {
  const rows = queryAll(
    db,
    `SELECT status, priority, COUNT(*) AS c FROM dg_quality_exceptions WHERE tenant_id = ? GROUP BY status, priority`,
    [Number(tenantId)]
  );
  const byStatus = {};
  const byPriority = {};
  let total = 0;
  for (const row of rows) {
    total += Number(row.c);
    byStatus[row.status] = (byStatus[row.status] || 0) + Number(row.c);
    byPriority[row.priority] = (byPriority[row.priority] || 0) + Number(row.c);
  }
  const overdue = Number(
    queryOne(
      db,
      `SELECT COUNT(*) AS c FROM dg_quality_exceptions
        WHERE tenant_id = ? AND due_date IS NOT NULL AND due_date < datetime('now')
          AND status NOT IN (${EXCEPTION_TERMINAL_STATUSES.map(() => "?").join(",")})`,
      [Number(tenantId), ...EXCEPTION_TERMINAL_STATUSES]
    )?.c ?? 0
  );
  return { total, by_status: byStatus, by_priority: byPriority, overdue };
}

export { getConfig, EXCEPTION_PRIORITIES };
