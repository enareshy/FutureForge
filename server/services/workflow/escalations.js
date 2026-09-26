import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { publish as publishNotificationEvent } from "../notifications.js";
import { readTenant, writeTenant, tenantClause, assertReadable, assertMutable } from "../metadata/scope.js";
import { ESCALATION_ACTIONS, TASK_PRIORITIES, safeParse } from "./validation.js";
import { recordEvent } from "./events.js";
import { usersForAssignee } from "./routing.js";
import { dispatch } from "./notifications.js";

// Escalation rules and the sweep that applies them. The platform is
// pull-based: an operator or cron calls `sweepEscalations`, which keeps the
// engine free of long-lived in-process timers.

export function publicEscalationRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    definition_id: row.definition_id ?? null,
    node_key: row.node_key || "",
    after_minutes: row.after_minutes,
    action: row.action,
    target_assignee_type: row.target_assignee_type || "",
    target_assignee_id: row.target_assignee_id ?? null,
    target_assignee_ref: row.target_assignee_ref || "",
    notify_user_id: row.notify_user_id ?? null,
    priority: row.priority || "high",
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getEscalationRuleRow(db, id) {
  return queryOne(db, "SELECT * FROM workflow_escalation_rules WHERE id = ?", [Number(id)]);
}

export function listEscalationRules(db, query = {}, tenantId) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause("r", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.status) {
    where.push("r.status = ?");
    params.push(query.status);
  }
  if (query.definitionId || query.definition_id) {
    where.push("(r.definition_id IS NULL OR r.definition_id = ?)");
    params.push(Number(query.definitionId || query.definition_id));
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM workflow_escalation_rules r ${clause}`, params).c;
  const items = queryAll(db, `SELECT r.* FROM workflow_escalation_rules r ${clause} ORDER BY r.code LIMIT ? OFFSET ?`, [
    ...params,
    pageSize,
    offset,
  ]).map(publicEscalationRule);
  return { items, total, page, pageSize };
}

export function createEscalationRule(db, body, actor = null, ip = null, reqTenantId = null) {
  requireFields(body, ["code", "name"]);
  validateCode(body.code, "Escalation rule code");
  const tenantId = writeTenant(db, actor, body, reqTenantId);
  const action = body.action || "notify";
  if (!ESCALATION_ACTIONS.includes(action)) {
    throw new HttpError(400, `action must be one of: ${ESCALATION_ACTIONS.join(", ")}`);
  }
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO workflow_escalation_rules
        (code, name, description, definition_id, node_key, after_minutes, action,
         target_assignee_type, target_assignee_id, target_assignee_ref, notify_user_id, priority, status, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.description || "",
        body.definition_id ?? body.definitionId ?? null,
        body.node_key ?? body.nodeKey ?? "",
        Number(body.after_minutes ?? body.afterMinutes ?? 60) || 60,
        action,
        body.target_assignee_type ?? body.targetAssigneeType ?? "",
        body.target_assignee_id ?? body.targetAssigneeId ?? null,
        body.target_assignee_ref ?? body.targetAssigneeRef ?? "",
        body.notify_user_id ?? body.notifyUserId ?? null,
        body.priority || "high",
        body.status || "active",
        tenantId ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Escalation rule code already exists in this scope");
    throw err;
  }
  writeAudit(db, { actor, action: "workflow.escalation_rule.create", resourceType: "workflow_escalation_rule", resourceId: result.lastInsertRowid, details: { code: body.code }, ip });
  return publicEscalationRule(getEscalationRuleRow(db, result.lastInsertRowid));
}

export function updateEscalationRule(db, id, body, actor = null, ip = null, tenantId = null) {
  const row = getEscalationRuleRow(db, id);
  assertMutable(db, row, tenantId, actor, "Escalation rule not found");
  if (body.code && body.code !== row.code) validateCode(body.code, "Escalation rule code");
  const action = body.action ?? row.action;
  if (!ESCALATION_ACTIONS.includes(action)) {
    throw new HttpError(400, `action must be one of: ${ESCALATION_ACTIONS.join(", ")}`);
  }
  try {
    run(
      db,
      `UPDATE workflow_escalation_rules SET
         code = ?, name = ?, description = ?, definition_id = ?, node_key = ?, after_minutes = ?, action = ?,
         target_assignee_type = ?, target_assignee_id = ?, target_assignee_ref = ?, notify_user_id = ?, priority = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.code ?? row.code,
        String(body.name ?? row.name).trim(),
        body.description ?? row.description,
        body.definition_id === undefined && body.definitionId === undefined ? row.definition_id : body.definition_id ?? body.definitionId,
        body.node_key === undefined && body.nodeKey === undefined ? row.node_key : body.node_key ?? body.nodeKey,
        body.after_minutes === undefined && body.afterMinutes === undefined ? row.after_minutes : Number(body.after_minutes ?? body.afterMinutes) || 60,
        action,
        body.target_assignee_type === undefined && body.targetAssigneeType === undefined ? row.target_assignee_type : body.target_assignee_type ?? body.targetAssigneeType,
        body.target_assignee_id === undefined && body.targetAssigneeId === undefined ? row.target_assignee_id : body.target_assignee_id ?? body.targetAssigneeId,
        body.target_assignee_ref === undefined && body.targetAssigneeRef === undefined ? row.target_assignee_ref : body.target_assignee_ref ?? body.targetAssigneeRef,
        body.notify_user_id === undefined && body.notifyUserId === undefined ? row.notify_user_id : body.notify_user_id ?? body.notifyUserId,
        body.priority ?? row.priority,
        body.status ?? row.status,
        nowIso(),
        row.id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Escalation rule code already exists in this scope");
    throw err;
  }
  writeAudit(db, { actor, action: "workflow.escalation_rule.update", resourceType: "workflow_escalation_rule", resourceId: row.id, details: { code: row.code }, ip });
  return publicEscalationRule(getEscalationRuleRow(db, row.id));
}

export function deleteEscalationRule(db, id, actor = null, ip = null, tenantId = null) {
  const row = getEscalationRuleRow(db, id);
  assertMutable(db, row, tenantId, actor, "Escalation rule not found");
  run(db, "DELETE FROM workflow_escalation_rules WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "workflow.escalation_rule.delete", resourceType: "workflow_escalation_rule", resourceId: row.id, details: { code: row.code }, ip });
  return { deleted: true, id: row.id };
}

function matchRule(db, task, tenantId) {
  const nodeKey = task.node_id ? queryOne(db, "SELECT node_key FROM workflow_nodes WHERE id = ?", [task.node_id])?.node_key || "" : "";
  const rules = queryAll(
    db,
    `SELECT * FROM workflow_escalation_rules
      WHERE status = 'active'
        AND (definition_id IS NULL OR definition_id = ?)
        AND (node_key = '' OR node_key = ?)
        AND (tenant_id IS NULL OR tenant_id = ?)
      ORDER BY after_minutes LIMIT 1`,
    [task.definition_id ?? -1, nodeKey, Number(tenantId)]
  );
  return rules[0] || null;
}

export function applyEscalation(db, task, rule, { actor = null } = {}) {
  const ts = nowIso();
  const applied = { task_id: task.id, rule_id: rule.id, action: rule.action };
  if (rule.action === "reassign") {
    run(
      db,
      `UPDATE workflow_tasks SET assignee_type = ?, assignee_id = ?, assignee_ref = ?, status = CASE WHEN status = 'in_progress' THEN 'assigned' ELSE status END, escalated = 1, updated_at = ? WHERE id = ?`,
      [rule.target_assignee_type || "user", rule.target_assignee_id ?? null, rule.target_assignee_ref || "", ts, task.id]
    );
    applied.assignee_type = rule.target_assignee_type || "user";
    applied.assignee_id = rule.target_assignee_id ?? null;
  } else if (rule.action === "raise_priority" || rule.action === "escalate") {
    const priority = TASK_PRIORITIES.includes(rule.priority) ? rule.priority : "high";
    run(db, "UPDATE workflow_tasks SET priority = ?, escalated = 1, updated_at = ? WHERE id = ?", [priority, ts, task.id]);
    applied.priority = priority;
  } else {
    run(db, "UPDATE workflow_tasks SET escalated = 1, updated_at = ? WHERE id = ?", [ts, task.id]);
  }

  const instance = queryOne(db, "SELECT * FROM workflow_instances WHERE id = ?", [task.instance_id]);
  const recipients = [];
  if (rule.notify_user_id) {
    const user = queryOne(db, "SELECT id, username, display_name FROM users WHERE id = ?", [Number(rule.notify_user_id)]);
    if (user) recipients.push(user);
  } else if (rule.target_assignee_type) {
    recipients.push(
      ...usersForAssignee(
        db,
        { assignee_type: rule.target_assignee_type, assignee_id: rule.target_assignee_id, assignee_ref: rule.target_assignee_ref },
        task.tenant_id,
        task.organization_id || 0
      )
    );
  } else if (task.claimed_by) {
    const user = queryOne(db, "SELECT id, username, display_name FROM users WHERE id = ?", [task.claimed_by]);
    if (user) recipients.push(user);
  }
  for (const recipient of recipients) {
    dispatch(db, {
      instance,
      task,
      channel: "in_app",
      recipientType: "user",
      recipientId: recipient.id,
      recipientRef: recipient.username || "",
      subject: `Task escalated: ${task.title}`,
      body: `Task "${task.title}" was escalated by rule "${rule.code}" (${rule.action}).`,
      payload: { task_id: task.id, instance_id: task.instance_id, rule: rule.code, action: rule.action },
      tenantId: task.tenant_id,
    });
  }
  recordEvent(db, {
    instanceId: task.instance_id,
    taskId: task.id,
    eventType: "task.escalated",
    actorId: actor?.id ?? null,
    message: `Task escalated via rule ${rule.code}`,
    details: applied,
    tenantId: task.tenant_id,
  });
  const assigneeId = task.assignee_type === "user" ? task.assignee_id ?? task.claimed_by ?? null : task.claimed_by ?? null;
  if (assigneeId) {
    publishNotificationEvent(
      db,
      {
        event_type: "task.overdue",
        source_module: "workflow",
        tenant_id: task.tenant_id,
        object_type: "task",
        object_id: task.code || String(task.id),
        object_name: task.title,
        payload: {
          assignee_id: Number(assigneeId),
          rule: rule.code,
          action: rule.action,
          due_date: task.due_at || task.due_date || "",
          link: `/workflow/tasks/${task.id}`,
        },
        idempotency_key: `task-overdue:${task.id}:${rule.id}`,
      },
      { actor }
    );
  }
  return applied;
}

export function sweepEscalations(db, { tenantId = null, now = nowIso(), limit = 100 } = {}) {
  const where = [
    `status IN ('unassigned','assigned','in_progress','blocked','awaiting_approval')`,
    `escalated = 0`,
    `((escalation_at IS NOT NULL AND escalation_at <= ?) OR (due_at IS NOT NULL AND due_at <= ?))`,
  ];
  const params = [now, now];
  if (tenantId) {
    where.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  const tasks = queryAll(db, `SELECT * FROM workflow_tasks WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`, [...params, Number(limit)]);
  const results = [];
  for (const task of tasks) {
    const rule = matchRule(db, task, task.tenant_id);
    if (!rule) {
      run(db, "UPDATE workflow_tasks SET escalated = 1, updated_at = ? WHERE id = ?", [now, task.id]);
      results.push({ task_id: task.id, action: "none" });
      continue;
    }
    results.push(applyEscalation(db, task, rule, {}));
  }
  return { swept: tasks.length, results, now };
}

export function readEscalationTenant(db, actor, query, reqTenantId) {
  return readTenant(db, actor, query, reqTenantId);
}
