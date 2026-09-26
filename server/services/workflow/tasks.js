import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, requireFields, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { publish as publishNotificationEvent } from "../notifications.js";
import { assertReadable } from "../metadata/scope.js";
import { TASK_STATUSES, TASK_OPEN_STATUSES, TASK_PRIORITIES, ASSIGNEE_TYPES, safeParse } from "./validation.js";
import { readGraph } from "./graph.js";
import { recordEvent } from "./events.js";
import { usersForAssignee } from "./routing.js";
import { dispatch } from "./notifications.js";
import { advance } from "./engine.js";

// Human work: tasks, subtasks, comments, attachments, assignment, claiming and
// delegation. The engine creates tasks for `task` nodes; everything here is the
// runtime surface for the people doing the work.

export function publicSubtask(row) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    title: row.title,
    status: row.status,
    display_order: row.display_order,
    completed_by: row.completed_by ?? null,
    completed_at: row.completed_at || null,
    created_at: row.created_at,
  };
}

export function publicComment(row) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    author_id: row.author_id ?? null,
    author_username: row.author_username ?? null,
    body: row.body,
    created_at: row.created_at,
  };
}

export function publicAttachment(row) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.task_id,
    filename: row.filename,
    url: row.url,
    content_type: row.content_type || "",
    size: row.size ?? 0,
    uploaded_by: row.uploaded_by ?? null,
    created_at: row.created_at,
  };
}

export function publicTask(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    instance_id: row.instance_id ?? null,
    instance_node_id: row.instance_node_id ?? null,
    definition_id: row.definition_id ?? null,
    node_id: row.node_id ?? null,
    node_key: row.node_key ?? null,
    parent_task_id: row.parent_task_id ?? null,
    title: row.title,
    description: row.description || "",
    status: row.status,
    priority: row.priority,
    assignee_type: row.assignee_type,
    assignee_id: row.assignee_id ?? null,
    assignee_ref: row.assignee_ref || "",
    assignee_username: row.assignee_username ?? null,
    claimed_by: row.claimed_by ?? null,
    claimed_username: row.claimed_username ?? null,
    due_at: row.due_at || null,
    escalation_at: row.escalation_at || null,
    escalated: row.escalated === 1,
    outcome: row.outcome || "",
    form: safeParse(row.form_json, {}),
    data: safeParse(row.data_json, {}),
    object_id: row.object_id ?? null,
    organization_id: row.organization_id ?? null,
    completed_by: row.completed_by ?? null,
    completed_at: row.completed_at || null,
    created_by: row.created_by ?? null,
    tenant_id: row.tenant_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const TASK_SELECT = `
  SELECT t.*, u.username AS assignee_username, cu.username AS claimed_username, n.node_key AS node_key
  FROM workflow_tasks t
  LEFT JOIN users u ON u.id = (CASE WHEN t.assignee_type = 'user' THEN t.assignee_id END)
  LEFT JOIN users cu ON cu.id = t.claimed_by
  LEFT JOIN workflow_nodes n ON n.id = t.node_id
`;

export function getTaskRow(db, id) {
  return queryOne(db, `${TASK_SELECT} WHERE t.id = ?`, [Number(id)]);
}

function nodeKeyFor(db, nodeId) {
  if (!nodeId) return null;
  return queryOne(db, "SELECT node_key FROM workflow_nodes WHERE id = ?", [Number(nodeId)])?.node_key ?? null;
}

export function taskDetail(db, row) {
  if (!row) return null;
  const task = publicTask(row);
  if (!task.node_key) task.node_key = nodeKeyFor(db, row.node_id);
  task.subtasks = queryAll(db, "SELECT * FROM workflow_task_subtasks WHERE task_id = ? ORDER BY display_order, id", [row.id]).map(publicSubtask);
  task.comments = queryAll(
    db,
    `SELECT c.*, u.username AS author_username FROM workflow_task_comments c
      LEFT JOIN users u ON u.id = c.author_id WHERE c.task_id = ? ORDER BY c.id`,
    [row.id]
  ).map(publicComment);
  task.attachments = queryAll(db, "SELECT * FROM workflow_task_attachments WHERE task_id = ? ORDER BY id", [row.id]).map(publicAttachment);
  const instance = queryOne(db, "SELECT * FROM workflow_instances WHERE id = ?", [row.instance_id]);
  if (instance) {
    task.instance = {
      id: instance.id,
      code: instance.code,
      title: instance.title,
      status: instance.status,
      definition_id: instance.definition_id,
      version_id: instance.version_id,
      object_id: instance.object_id ?? null,
    };
    task.workflow = instanceWorkflowGraph(db, instance);
  }
  return task;
}

// Read-only view of the running workflow so the task UI can plot progress: the
// version graph annotated with the instance node statuses (completed / current
// / pending) and the node this task belongs to.
function instanceWorkflowGraph(db, instance) {
  if (!instance.version_id) return null;
  const graph = readGraph(db, instance.version_id);
  const statusByNode = new Map();
  for (const node of queryAll(
    db,
    "SELECT node_id, status FROM workflow_instance_nodes WHERE instance_id = ?",
    [instance.id]
  )) {
    statusByNode.set(String(node.node_id), node.status);
  }
  return {
    nodes: graph.nodes.map((node) => ({ ...node, instance_status: statusByNode.get(String(node.id)) || "pending" })),
    transitions: graph.transitions,
    current_node_id: instance.current_node_id ?? null,
    status: instance.status,
  };
}

function actorContext(db, actor, tenantId) {
  const roles = queryAll(
    db,
    `SELECT DISTINCT r.id, r.code FROM roles r WHERE r.id IN (
        SELECT role_id FROM user_roles WHERE user_id = ? AND (organization_id = 0 OR organization_id = ?)
        UNION
        SELECT gr.role_id FROM group_members gm JOIN group_roles gr ON gr.group_id = gm.group_id
         WHERE gm.user_id = ? AND (gr.organization_id = 0 OR gr.organization_id = ?)
     )`,
    [actor?.id ?? 0, actor?.organization_id ?? 0, actor?.id ?? 0, actor?.organization_id ?? 0]
  );
  const groups = queryAll(
    db,
    `SELECT DISTINCT g.id, g.code FROM groups g
      WHERE g.id IN (SELECT group_id FROM group_members WHERE user_id = ?)
         OR g.id IN (SELECT group_id FROM group_roles WHERE role_id IN (
              SELECT role_id FROM user_roles WHERE user_id = ? AND (organization_id = 0 OR organization_id = ?)
            ))`,
    [actor?.id ?? 0, actor?.id ?? 0, actor?.organization_id ?? 0]
  );
  return {
    userId: actor?.id ?? null,
    organizationId: actor?.organization_id ?? null,
    roleIds: roles.map((r) => r.id),
    roleCodes: roles.map((r) => r.code),
    groupIds: groups.map((g) => g.id),
  };
}

function placeholders(list) {
  return list.length ? list.map(() => "?").join(", ") : "NULL";
}

export function listTasks(db, query = {}, tenantId, actor, { scope = "mine" } = {}) {
  const { page, pageSize, offset } = pagination(query);
  const where = ["t.tenant_id = ?"];
  const params = [Number(tenantId)];
  const ctx = actorContext(db, actor, tenantId);

  if (scope === "mine") {
    const clauses = [];
    if (ctx.userId) {
      clauses.push("(t.assignee_type = 'user' AND t.assignee_id = ?)");
      params.push(ctx.userId);
      clauses.push("t.claimed_by = ?");
      params.push(ctx.userId);
    }
    if (ctx.roleIds.length) {
      clauses.push(`(t.assignee_type IN ('role','queue') AND t.assignee_id IN (${placeholders(ctx.roleIds)}))`);
      params.push(...ctx.roleIds);
    }
    if (ctx.roleCodes.length) {
      clauses.push(`(t.assignee_type IN ('role','queue') AND t.assignee_ref IN (${placeholders(ctx.roleCodes)}))`);
      params.push(...ctx.roleCodes);
    }
    if (ctx.groupIds.length) {
      clauses.push(`(t.assignee_type = 'group' AND t.assignee_id IN (${placeholders(ctx.groupIds)}))`);
      params.push(...ctx.groupIds);
    }
    if (ctx.organizationId) {
      clauses.push("(t.assignee_type = 'organization' AND t.assignee_id = ?)");
      params.push(ctx.organizationId);
    }
    if (ctx.userId) {
      clauses.push(
        `(t.assignee_type = 'user' AND t.assignee_id IN (
            SELECT from_user_id FROM workflow_delegations
             WHERE to_user_id = ? AND status = 'active'
               AND (starts_at IS NULL OR starts_at <= datetime('now'))
               AND (ends_at IS NULL OR ends_at >= datetime('now'))))`
      );
      params.push(ctx.userId);
    }
    where.push(`(${clauses.length ? clauses.join(" OR ") : "0"})`);
  } else if (scope === "team") {
    const clauses = [];
    if (ctx.organizationId) {
      clauses.push("t.organization_id = ?");
      params.push(ctx.organizationId);
      clauses.push(`(t.assignee_type = 'user' AND t.assignee_id IN (SELECT id FROM users u WHERE u.organization_id = ?))`);
      params.push(ctx.organizationId);
    }
    if (ctx.roleIds.length) {
      clauses.push(`(t.assignee_type IN ('role','queue') AND t.assignee_id IN (${placeholders(ctx.roleIds)}))`);
      params.push(...ctx.roleIds);
    }
    if (ctx.groupIds.length) {
      clauses.push(`(t.assignee_type = 'group' AND t.assignee_id IN (${placeholders(ctx.groupIds)}))`);
      params.push(...ctx.groupIds);
    }
    where.push(`(${clauses.length ? clauses.join(" OR ") : "0"})`);
  }

  if (query.status) {
    const statuses = String(query.status)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    where.push(`t.status IN (${placeholders(statuses)})`);
    params.push(...statuses);
  } else if (scope === "mine" && query.includeCompleted !== "true" && query.include_completed !== true) {
    where.push(`t.status IN (${placeholders(TASK_OPEN_STATUSES)})`);
    params.push(...TASK_OPEN_STATUSES);
  }
  if (query.priority) {
    where.push("t.priority = ?");
    params.push(query.priority);
  }
  if (query.instanceId || query.instance_id) {
    where.push("t.instance_id = ?");
    params.push(Number(query.instanceId || query.instance_id));
  }
  if (query.definitionId || query.definition_id) {
    where.push("t.definition_id = ?");
    params.push(Number(query.definitionId || query.definition_id));
  }
  if (query.escalated === "true" || query.escalated === true) {
    where.push("t.escalated = 1");
  }
  if (query.q) {
    where.push("(t.title LIKE ? OR t.description LIKE ? OR t.code LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const sortable = {
    due_at: "t.due_at",
    priority: "t.priority",
    status: "t.status",
    created_at: "t.created_at",
    updated_at: "t.updated_at",
    title: "t.title",
  };
  const orderBy = sortable[query.sort] || "t.id";
  const direction = String(query.order || query.sortDir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM workflow_tasks t ${clause}`, params).c;
  const items = queryAll(db, `${TASK_SELECT} ${clause} ORDER BY t.escalated DESC, ${orderBy} ${direction} LIMIT ? OFFSET ?`, [
    ...params,
    pageSize,
    offset,
  ]).map(publicTask);
  return { items, total, page, pageSize, scope };
}

export function getTask(db, id, tenantId, actor) {
  const row = getTaskRow(db, id);
  assertReadable(row, tenantId, "Task not found");
  return taskDetail(db, row);
}

export function createTask(db, {
  instance,
  instanceNode = null,
  definitionId = null,
  node = null,
  parentTaskId = null,
  code,
  title,
  description = "",
  assignee = {},
  priority = "normal",
  dueAt = null,
  escalationAt = null,
  form = {},
  data = {},
  createdBy = null,
  organizationId = null,
}) {
  const ts = nowIso();
  const assigneeType = ASSIGNEE_TYPES.includes(assignee.assignee_type) ? assignee.assignee_type : "unassigned";
  const status = assigneeType === "unassigned" ? "unassigned" : "assigned";
  const result = run(
    db,
    `INSERT INTO workflow_tasks
      (instance_id, instance_node_id, definition_id, node_id, parent_task_id, code, title, description, status, priority,
       assignee_type, assignee_id, assignee_ref, due_at, escalation_at, form_json, data_json, object_id, organization_id,
       created_by, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      instance.id,
      instanceNode?.id ?? null,
      definitionId ?? instance.definition_id,
      node?.id ?? null,
      parentTaskId,
      code,
      title,
      description,
      status,
      TASK_PRIORITIES.includes(priority) ? priority : "normal",
      assigneeType,
      assignee.assignee_id ?? null,
      assignee.assignee_ref || "",
      dueAt,
      escalationAt,
      JSON.stringify(form || {}),
      JSON.stringify(data || {}),
      instance.object_id ?? null,
      organizationId ?? instance.organization_id ?? null,
      createdBy,
      instance.tenant_id,
      ts,
      ts,
    ]
  );
  const row = getTaskRow(db, result.lastInsertRowid);
  recordEvent(db, {
    instanceId: instance.id,
    taskId: row.id,
    eventType: "task.created",
    actorId: createdBy,
    message: `Task "${title}" created`,
    details: { assignee_type: assigneeType, assignee_id: assignee.assignee_id ?? null },
    tenantId: instance.tenant_id,
  });
  notifyAssignment(db, row, instance);
  return row;
}

export function notifyAssignment(db, task, instance = null) {
  const resolvedInstance = instance || queryOne(db, "SELECT * FROM workflow_instances WHERE id = ?", [task.instance_id]);
  const recipients = usersForAssignee(
    db,
    { assignee_type: task.assignee_type, assignee_id: task.assignee_id, assignee_ref: task.assignee_ref },
    task.tenant_id,
    task.organization_id || 0
  );
  for (const recipient of recipients) {
    dispatch(db, {
      instance: resolvedInstance,
      task,
      channel: "in_app",
      recipientType: "user",
      recipientId: recipient.id,
      recipientRef: recipient.username || "",
      subject: `New task: ${task.title}`,
      body: `You have been assigned "${task.title}".`,
      payload: { task_id: task.id, instance_id: task.instance_id, code: task.code },
      tenantId: task.tenant_id,
    });
    publishNotificationEvent(
      db,
      {
        event_type: "task.assigned",
        source_module: "workflow",
        tenant_id: task.tenant_id,
        object_type: "task",
        object_id: task.code || String(task.id),
        object_name: task.title,
        payload: {
          assignee_id: recipient.id,
          priority: task.priority,
          due_date: task.due_at || task.due_date || "",
          link: `/workflow/tasks/${task.id}`,
        },
        idempotency_key: `task-assigned:${task.id}:${recipient.id}`,
      },
      {}
    );
  }
  return recipients;
}

function assertOpen(task) {
  if (task.status === "completed") throw new HttpError(409, "Task is already completed");
  if (task.status === "cancelled") throw new HttpError(409, "Task is cancelled");
}

export function completeTask(db, id, body = {}, actor = null, tenantId = null, ip = null) {
  const row = getTaskRow(db, id);
  assertReadable(row, tenantId, "Task not found");
  assertOpen(row);
  const nodeType = row.node_id ? queryOne(db, "SELECT node_type FROM workflow_instance_nodes WHERE id = ?", [row.instance_node_id])?.node_type : null;
  if (nodeType === "approval") {
    throw new HttpError(400, "Approval tasks must be decided through the workflow approvals endpoint");
  }
  const ts = nowIso();
  const outcome = body.outcome ?? body.decision ?? "completed";
  const data = { ...safeParse(row.data_json, {}), ...(body.data && typeof body.data === "object" ? body.data : {}) };
  run(
    db,
    `UPDATE workflow_tasks SET status = 'completed', outcome = ?, data_json = ?, completed_by = ?, completed_at = ?, escalated = 0, updated_at = ?
     WHERE id = ?`,
    [String(outcome), JSON.stringify(data), actor?.id ?? null, ts, ts, row.id]
  );
  recordEvent(db, {
    instanceId: row.instance_id,
    taskId: row.id,
    eventType: "task.completed",
    actorId: actor?.id ?? null,
    message: `Task "${row.title}" completed`,
    details: { outcome, comments: body.comments || body.comment || "" },
    tenantId: row.tenant_id,
  });
  writeAudit(db, { actor, action: "workflow.task.complete", resourceType: "workflow_task", resourceId: row.id, details: { code: row.code, outcome }, ip });
  advance(db, row.instance_id, { actor, ip, taskId: row.id, outcome });
  return getTask(db, row.id, tenantId, actor);
}

export function assignTask(db, id, body = {}, actor = null, tenantId = null, ip = null) {
  const row = getTaskRow(db, id);
  assertReadable(row, tenantId, "Task not found");
  const assigneeType = body.assignee_type ?? body.assigneeType ?? "user";
  if (!ASSIGNEE_TYPES.includes(assigneeType)) {
    throw new HttpError(400, `assignee_type must be one of: ${ASSIGNEE_TYPES.join(", ")}`);
  }
  const assigneeId = body.assignee_id ?? body.assigneeId ?? body.user_id ?? body.userId ?? null;
  const assigneeRef = body.assignee_ref ?? body.assigneeRef ?? "";
  if (assigneeType !== "unassigned" && assigneeId === null && !assigneeRef) {
    throw new HttpError(400, "An assignee id or reference is required");
  }
  const status = assigneeType === "unassigned" ? "unassigned" : row.status === "in_progress" ? "in_progress" : "assigned";
  const ts = nowIso();
  run(
    db,
    "UPDATE workflow_tasks SET assignee_type = ?, assignee_id = ?, assignee_ref = ?, status = ?, claimed_by = NULL, escalated = 0, updated_at = ? WHERE id = ?",
    [assigneeType, assigneeId, assigneeRef, status, ts, row.id]
  );
  const updated = getTaskRow(db, row.id);
  recordEvent(db, {
    instanceId: row.instance_id,
    taskId: row.id,
    eventType: "task.assigned",
    actorId: actor?.id ?? null,
    message: `Task reassigned to ${assigneeType} ${assigneeRef || assigneeId}`,
    details: { assignee_type: assigneeType, assignee_id: assigneeId },
    tenantId: row.tenant_id,
  });
  notifyAssignment(db, updated);
  writeAudit(db, { actor, action: "workflow.task.assign", resourceType: "workflow_task", resourceId: row.id, details: { assignee_type: assigneeType, assignee_id: assigneeId }, ip });
  return getTask(db, row.id, tenantId, actor);
}

export function claimTask(db, id, actor = null, tenantId = null, ip = null) {
  const row = getTaskRow(db, id);
  assertReadable(row, tenantId, "Task not found");
  assertOpen(row);
  const ts = nowIso();
  run(
    db,
    `UPDATE workflow_tasks SET claimed_by = ?, assignee_type = 'user', assignee_id = ?, assignee_ref = ?, status = 'in_progress', updated_at = ? WHERE id = ?`,
    [actor?.id ?? null, actor?.id ?? null, actor?.username ?? "", ts, row.id]
  );
  recordEvent(db, {
    instanceId: row.instance_id,
    taskId: row.id,
    eventType: "task.claimed",
    actorId: actor?.id ?? null,
    message: "Task claimed",
    tenantId: row.tenant_id,
  });
  writeAudit(db, { actor, action: "workflow.task.claim", resourceType: "workflow_task", resourceId: row.id, ip });
  return getTask(db, row.id, tenantId, actor);
}

export function updateTaskStatus(db, id, status, actor = null, tenantId = null, ip = null) {
  const row = getTaskRow(db, id);
  assertReadable(row, tenantId, "Task not found");
  if (!TASK_STATUSES.includes(status)) {
    throw new HttpError(400, `status must be one of: ${TASK_STATUSES.join(", ")}`);
  }
  run(db, "UPDATE workflow_tasks SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), row.id]);
  writeAudit(db, { actor, action: "workflow.task.status", resourceType: "workflow_task", resourceId: row.id, details: { status }, ip });
  return getTask(db, row.id, tenantId, actor);
}

export function delegateTask(db, id, body = {}, actor = null, tenantId = null, ip = null) {
  const row = getTaskRow(db, id);
  assertReadable(row, tenantId, "Task not found");
  assertOpen(row);
  const toUserId = Number(body.to_user_id ?? body.toUserId ?? body.user_id ?? body.userId);
  if (!toUserId) throw new HttpError(400, "to_user_id is required");
  const target = queryOne(db, "SELECT id, username FROM users WHERE id = ? AND status = 'active'", [toUserId]);
  if (!target) throw new HttpError(400, "Delegate user not found");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO workflow_delegations (from_user_id, to_user_id, starts_at, ends_at, reason, status, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [
      actor?.id ?? null,
      target.id,
      body.starts_at ?? body.startsAt ?? ts,
      body.ends_at ?? body.endsAt ?? null,
      body.reason || "",
      Number(tenantId),
      ts,
      ts,
    ]
  );
  if (body.reassign !== false) {
    run(
      db,
      "UPDATE workflow_tasks SET assignee_type = 'user', assignee_id = ?, assignee_ref = ?, status = 'assigned', updated_at = ? WHERE id = ?",
      [target.id, target.username, ts, row.id]
    );
  }
  recordEvent(db, {
    instanceId: row.instance_id,
    taskId: row.id,
    eventType: "task.delegated",
    actorId: actor?.id ?? null,
    message: `Task delegated to ${target.username}`,
    details: { delegation_id: result.lastInsertRowid, to_user_id: target.id, reassign: body.reassign !== false },
    tenantId: row.tenant_id,
  });
  writeAudit(db, { actor, action: "workflow.task.delegate", resourceType: "workflow_task", resourceId: row.id, details: { to_user_id: target.id }, ip });
  return { delegation_id: result.lastInsertRowid, task: getTask(db, row.id, tenantId, actor) };
}

// ---------------------------------------------------------------------------
// Subtasks, comments, attachments
// ---------------------------------------------------------------------------

export function addSubtask(db, taskId, body = {}, actor = null, tenantId = null) {
  const row = getTaskRow(db, taskId);
  assertReadable(row, tenantId, "Task not found");
  requireFields(body, ["title"]);
  const order = queryOne(db, "SELECT COALESCE(MAX(display_order), -1) AS m FROM workflow_task_subtasks WHERE task_id = ?", [row.id]).m + 1;
  const result = run(
    db,
    "INSERT INTO workflow_task_subtasks (task_id, title, status, display_order, created_at, updated_at) VALUES (?, ?, 'todo', ?, ?, ?)",
    [row.id, String(body.title).trim(), Number(body.display_order ?? order) || order, nowIso(), nowIso()]
  );
  return publicSubtask(queryOne(db, "SELECT * FROM workflow_task_subtasks WHERE id = ?", [result.lastInsertRowid]));
}

export function updateSubtask(db, taskId, subtaskId, body = {}, actor = null, tenantId = null) {
  const row = getTaskRow(db, taskId);
  assertReadable(row, tenantId, "Task not found");
  const subtask = queryOne(db, "SELECT * FROM workflow_task_subtasks WHERE id = ? AND task_id = ?", [Number(subtaskId), row.id]);
  if (!subtask) throw new HttpError(404, "Subtask not found");
  const status = body.status ?? subtask.status;
  const ts = nowIso();
  run(
    db,
    "UPDATE workflow_task_subtasks SET title = ?, status = ?, display_order = ?, completed_by = ?, completed_at = ?, updated_at = ? WHERE id = ?",
    [
      body.title ?? subtask.title,
      status,
      body.display_order === undefined ? subtask.display_order : Number(body.display_order) || 0,
      status === "done" ? actor?.id ?? null : null,
      status === "done" ? ts : null,
      ts,
      subtask.id,
    ]
  );
  return publicSubtask(queryOne(db, "SELECT * FROM workflow_task_subtasks WHERE id = ?", [subtask.id]));
}

export function deleteSubtask(db, taskId, subtaskId, actor = null, tenantId = null) {
  const row = getTaskRow(db, taskId);
  assertReadable(row, tenantId, "Task not found");
  const subtask = queryOne(db, "SELECT * FROM workflow_task_subtasks WHERE id = ? AND task_id = ?", [Number(subtaskId), row.id]);
  if (!subtask) throw new HttpError(404, "Subtask not found");
  run(db, "DELETE FROM workflow_task_subtasks WHERE id = ?", [subtask.id]);
  return { deleted: true, id: subtask.id };
}

export function addComment(db, taskId, body = {}, actor = null, tenantId = null) {
  const row = getTaskRow(db, taskId);
  assertReadable(row, tenantId, "Task not found");
  const text = String(body.body ?? body.comment ?? "").trim();
  if (!text) throw new HttpError(400, "Comment body is required");
  const result = run(db, "INSERT INTO workflow_task_comments (task_id, author_id, body, created_at) VALUES (?, ?, ?, ?)", [
    row.id,
    actor?.id ?? null,
    text,
    nowIso(),
  ]);
  recordEvent(db, {
    instanceId: row.instance_id,
    taskId: row.id,
    eventType: "task.comment",
    actorId: actor?.id ?? null,
    message: "Comment added",
    details: { comment_id: result.lastInsertRowid },
    tenantId: row.tenant_id,
  });
  return publicComment(
    queryOne(
      db,
      `SELECT c.*, u.username AS author_username FROM workflow_task_comments c LEFT JOIN users u ON u.id = c.author_id WHERE c.id = ?`,
      [result.lastInsertRowid]
    )
  );
}

export function listComments(db, taskId, tenantId) {
  const row = getTaskRow(db, taskId);
  assertReadable(row, tenantId, "Task not found");
  return queryAll(
    db,
    `SELECT c.*, u.username AS author_username FROM workflow_task_comments c
      LEFT JOIN users u ON u.id = c.author_id WHERE c.task_id = ? ORDER BY c.id`,
    [row.id]
  ).map(publicComment);
}

export function addAttachment(db, taskId, body = {}, actor = null, tenantId = null) {
  const row = getTaskRow(db, taskId);
  assertReadable(row, tenantId, "Task not found");
  requireFields(body, ["filename", "url"]);
  const result = run(
    db,
    "INSERT INTO workflow_task_attachments (task_id, filename, url, content_type, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [row.id, body.filename, body.url, body.content_type || "", Number(body.size ?? 0) || 0, actor?.id ?? null, nowIso()]
  );
  return publicAttachment(queryOne(db, "SELECT * FROM workflow_task_attachments WHERE id = ?", [result.lastInsertRowid]));
}

export function listAttachments(db, taskId, tenantId) {
  const row = getTaskRow(db, taskId);
  assertReadable(row, tenantId, "Task not found");
  return queryAll(db, "SELECT * FROM workflow_task_attachments WHERE task_id = ? ORDER BY id", [row.id]).map(publicAttachment);
}

// ---------------------------------------------------------------------------
// Delegations
// ---------------------------------------------------------------------------

export function publicDelegation(row) {
  if (!row) return null;
  return {
    id: row.id,
    from_user_id: row.from_user_id,
    from_username: row.from_username ?? null,
    to_user_id: row.to_user_id,
    to_username: row.to_username ?? null,
    starts_at: row.starts_at || null,
    ends_at: row.ends_at || null,
    reason: row.reason || "",
    status: row.status,
    created_at: row.created_at,
  };
}

const DELEGATION_SELECT = `
  SELECT d.*, f.username AS from_username, t.username AS to_username
  FROM workflow_delegations d
  LEFT JOIN users f ON f.id = d.from_user_id
  LEFT JOIN users t ON t.id = d.to_user_id
`;

export function listDelegations(db, query = {}, tenantId, actor = null) {
  const { page, pageSize, offset } = pagination(query);
  const where = ["d.tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.direction === "to" && actor) {
    where.push("d.to_user_id = ?");
    params.push(actor.id);
  } else if (query.direction === "from" && actor) {
    where.push("d.from_user_id = ?");
    params.push(actor.id);
  }
  if (query.status) {
    where.push("d.status = ?");
    params.push(query.status);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM workflow_delegations d ${clause}`, params).c;
  const items = queryAll(db, `${DELEGATION_SELECT} ${clause} ORDER BY d.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]).map(
    publicDelegation
  );
  return { items, total, page, pageSize };
}

export function createDelegation(db, body = {}, actor = null, tenantId = null, ip = null) {
  const toUserId = Number(body.to_user_id ?? body.toUserId);
  if (!toUserId) throw new HttpError(400, "to_user_id is required");
  const target = queryOne(db, "SELECT id, username FROM users WHERE id = ? AND status = 'active'", [toUserId]);
  if (!target) throw new HttpError(400, "Delegate user not found");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO workflow_delegations (from_user_id, to_user_id, starts_at, ends_at, reason, status, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    [actor?.id ?? null, target.id, body.starts_at ?? ts, body.ends_at ?? null, body.reason || "", Number(tenantId), ts, ts]
  );
  writeAudit(db, { actor, action: "workflow.delegation.create", resourceType: "workflow_delegation", resourceId: result.lastInsertRowid, details: { to_user_id: target.id }, ip });
  return publicDelegation(queryOne(db, `${DELEGATION_SELECT} WHERE d.id = ?`, [result.lastInsertRowid]));
}

export function revokeDelegation(db, id, actor = null, tenantId = null, ip = null) {
  const row = queryOne(db, "SELECT * FROM workflow_delegations WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)]);
  if (!row) throw new HttpError(404, "Delegation not found");
  run(db, "UPDATE workflow_delegations SET status = 'revoked', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  writeAudit(db, { actor, action: "workflow.delegation.revoke", resourceType: "workflow_delegation", resourceId: row.id, ip });
  return publicDelegation(queryOne(db, `${DELEGATION_SELECT} WHERE d.id = ?`, [row.id]));
}
