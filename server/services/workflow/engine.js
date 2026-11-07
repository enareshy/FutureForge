import { queryAll, queryOne, run, nowIso, transaction } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync, transactionAsync } from "../../db-async.js";
import { HttpError, requireFields, pagination } from "../../validation.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { assertReadable } from "../metadata/scope.js";
import { INSTANCE_STATUSES, TASK_OPEN_STATUSES, safeParse, evaluateCondition, slugifyKey } from "./validation.js";
import { readGraph, getNodeRow, getNodeRowAsync, readNodes, readTransitions } from "./graph.js";
import {
  publicDefinition,
  publishedVersionRow,
  publishedVersionRowAsync,
  getVersionRow,
  getVersionRowAsync,
  getDefinitionRowAsync,
  findDefinition,
  findDefinitionAsync,
  getDefinitionRow,
} from "./templates.js";
import { recordEvent, recordEventAsync, listEvents, listEventsAsync } from "./events.js";
import { resolveAssignee, resolveAssigneeAsync } from "./routing.js";
import { createTask, createTaskAsync, publicTask } from "./tasks.js";
import { createApprovalsForNode, createApprovalsForNodeAsync, publicApproval } from "./approvals.js";
import { dispatch, dispatchAsync } from "./notifications.js";
import { emitDomainEvent, emitDomainEventAsync } from "../events/emit.js";

// ---------------------------------------------------------------------------
// Runtime engine
// ---------------------------------------------------------------------------
// A workflow instance is a set of tokens (rows in workflow_instance_nodes).
// `advance()` drives every token as far as it can, blocking on human work,
// approvals, timers, joins and subprocesses. It is idempotent and safe to call
// repeatedly from task/approval completion and from the API.

const MAX_STEPS = 500;
const serviceHandlers = new Map();

export function registerServiceHandler(name, handler) {
  if (!name) throw new HttpError(400, "A handler name is required");
  serviceHandlers.set(String(name), handler);
  return handler;
}

export function serviceHandler(name) {
  return serviceHandlers.get(String(name)) || null;
}

export function publicInstance(row, { withDefinition = false, db = null } = {}) {
  if (!row) return null;
  const instance = {
    id: row.id,
    code: row.code,
    definition_id: row.definition_id,
    version_id: row.version_id,
    definition_code: row.definition_code ?? null,
    definition_name: row.definition_name ?? null,
    version: row.version ?? null,
    object_id: row.object_id ?? null,
    parent_instance_id: row.parent_instance_id ?? null,
    parent_node_id: row.parent_node_id ?? null,
    title: row.title,
    status: row.status,
    context: safeParse(row.context_json, {}),
    current_node_id: row.current_node_id ?? null,
    started_by: row.started_by ?? null,
    started_username: row.started_username ?? null,
    started_at: row.started_at,
    ended_at: row.ended_at || null,
    organization_id: row.organization_id ?? null,
    tenant_id: row.tenant_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (withDefinition && row.definition_id) {
    const definition = db ? getDefinitionRow(db, row.definition_id) : null;
    instance.definition = publicDefinition(definition);
  }
  return instance;
}

export function publicInstanceNode(row) {
  if (!row) return null;
  return {
    id: row.id,
    instance_id: row.instance_id,
    node_id: row.node_id,
    node_key: row.node_key,
    node_type: row.node_type,
    status: row.status,
    outcome: row.outcome || "",
    data: safeParse(row.data_json, {}),
    entered_at: row.entered_at || null,
    completed_at: row.completed_at || null,
    created_at: row.created_at,
  };
}

const INSTANCE_SELECT = `
  SELECT i.*, d.code AS definition_code, d.name AS definition_name,
    v.version AS version, u.username AS started_username
  FROM workflow_instances i
  LEFT JOIN workflow_definitions d ON d.id = i.definition_id
  LEFT JOIN workflow_versions v ON v.id = i.version_id
  LEFT JOIN users u ON u.id = i.started_by
`;

export function getInstanceRow(db, id) {
  return queryOne(db, `${INSTANCE_SELECT} WHERE i.id = ?`, [Number(id)]);
}

export function listInstances(db, query = {}, tenantId) {
  const { page, pageSize, offset } = pagination(query);
  const where = ["i.tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    const statuses = String(query.status)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    where.push(`i.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (query.definitionId || query.definition_id) {
    where.push("i.definition_id = ?");
    params.push(Number(query.definitionId || query.definition_id));
  }
  if (query.objectId || query.object_id) {
    where.push("i.object_id = ?");
    params.push(Number(query.objectId || query.object_id));
  }
  if (query.parentInstanceId || query.parent_instance_id) {
    where.push("i.parent_instance_id = ?");
    params.push(Number(query.parentInstanceId || query.parent_instance_id));
  }
  if (query.q) {
    where.push("(i.code ILIKE ? OR i.title ILIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM workflow_instances i ${clause}`, params).c;
  const items = queryAll(db, `${INSTANCE_SELECT} ${clause} ORDER BY i.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]).map((row) =>
    publicInstance(row)
  );
  return { items, total, page, pageSize };
}

export function getInstance(db, id, tenantId, { includeDetail = true } = {}) {
  const row = getInstanceRow(db, id);
  assertReadable(row, tenantId, "Workflow instance not found");
  const instance = publicInstance(row, { withDefinition: true, db });
  if (includeDetail) {
    instance.nodes = queryAll(db, "SELECT * FROM workflow_instance_nodes WHERE instance_id = ? ORDER BY id", [row.id]).map(publicInstanceNode);
    instance.tasks = queryAll(db, "SELECT * FROM workflow_tasks WHERE instance_id = ? ORDER BY id", [row.id]).map(publicTask);
    instance.approvals = queryAll(db, "SELECT * FROM workflow_approvals WHERE instance_id = ? ORDER BY id", [row.id]).map(publicApproval);
    instance.events = listEvents(db, row.id, { pageSize: 100 }).items;
    instance.children = queryAll(db, `${INSTANCE_SELECT} WHERE i.parent_instance_id = ? ORDER BY i.id`, [row.id]).map((child) =>
      publicInstance(child)
    );
  }
  return instance;
}

function nextInstanceCode(db) {
  return `WF-${Date.now().toString(36).toUpperCase()}-${Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Start / lifecycle
// ---------------------------------------------------------------------------

export function startInstance(db, body = {}, actor = null, tenantId = null, ip = null) {
  requireFields(body, ["title"]);
  if (!tenantId) throw new HttpError(400, "A tenant context is required to start a workflow");
  const definition = body.definition_id || body.definitionId
    ? getDefinitionRow(db, Number(body.definition_id ?? body.definitionId))
    : findDefinition(db, body.workflow_code ?? body.workflowCode, tenantId);
  if (!definition) throw new HttpError(404, "Workflow template not found");
  assertReadable(definition, tenantId, "Workflow template not found");
  let versionRow = null;
  const versionRef = body.version_id ?? body.versionId ?? body.version;
  if (versionRef !== undefined && versionRef !== null && versionRef !== "") {
    versionRow = /^\d+$/.test(String(versionRef))
      ? getVersionRow(db, Number(versionRef))
      : queryOne(db, "SELECT * FROM workflow_versions WHERE definition_id = ? AND status = ? ORDER BY version DESC LIMIT 1", [
          definition.id,
          String(versionRef),
        ]);
    if (!versionRow || Number(versionRow.definition_id) !== Number(definition.id)) throw new HttpError(404, "Workflow version not found");
  } else {
    versionRow = publishedVersionRow(db, definition.id);
  }
  if (!versionRow) throw new HttpError(409, "Workflow has no published version to run");
  if (versionRow.status !== "published" && !body.allow_draft && !body.allowDraft) {
    throw new HttpError(409, "Only published workflow versions can be started");
  }
  const objectId = body.object_id ?? body.objectId ?? null;
  const context = body.context && typeof body.context === "object" ? { ...body.context } : {};
  if (objectId && context.object_id === undefined) context.object_id = objectId;
  const ts = nowIso();
  let instanceId;
  transaction(db, () => {
    const result = run(
      db,
      `INSERT INTO workflow_instances
        (code, definition_id, version_id, object_id, parent_instance_id, parent_node_id, title, status, context_json,
         started_by, organization_id, tenant_id, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.code || nextInstanceCode(db),
        definition.id,
        versionRow.id,
        objectId,
        body.parent_instance_id ?? body.parentInstanceId ?? null,
        body.parent_node_id ?? body.parentNodeId ?? null,
        String(body.title).trim(),
        JSON.stringify(context),
        actor?.id ?? null,
        body.organization_id ?? body.organizationId ?? actor?.organization_id ?? null,
        Number(tenantId),
        ts,
        ts,
        ts,
      ]
    );
    instanceId = result.lastInsertId;
    recordEvent(db, {
      instanceId,
      eventType: "workflow.started",
      actorId: actor?.id ?? null,
      message: `Workflow "${body.title}" started`,
      details: { definition_id: definition.id, version_id: versionRow.id },
      tenantId: Number(tenantId),
    });
  });
  const instance = getInstanceRow(db, instanceId);
  emitDomainEvent(
    db,
    {
      event_type_code: "WorkflowStarted",
      source_module: "workflow",
      source_object_type: "workflow_instance",
      source_object_id: String(instance.id),
      source_object_revision: instance.version_id ?? null,
      tenant_id: Number(tenantId),
      organization_id: instance.organization_id ?? null,
      correlation_id: body.correlation_id ?? null,
      payload: {
        instance_id: instance.id,
        instance_code: instance.code,
        definition_id: definition.id,
        definition_code: definition.code,
        version_id: versionRow.id,
        object_id: objectId ?? null,
        title: instance.title,
        status: instance.status,
      },
      idempotency_key: `workflow:started:${instance.id}`,
    },
    actor
  );
  const startNode = queryOne(db, "SELECT * FROM workflow_nodes WHERE version_id = ? AND type = 'start' ORDER BY id LIMIT 1", [versionRow.id]);
  if (!startNode) throw new HttpError(422, "Workflow version has no start node");
  activateNode(db, instance, startNode, { fromNodeId: null, actor });
  writeAudit(db, {
    actor,
    action: "workflow.instance.start",
    resourceType: "workflow_instance",
    resourceId: instanceId,
    details: { code: body.code || null, definition: definition.code, version: versionRow.version },
    ip,
  });
  advance(db, instanceId, { actor, ip });
  return getInstance(db, instanceId, tenantId);
}

function activateNode(db, instance, node, { fromNodeId = null, actor = null } = {}) {
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO workflow_instance_nodes
      (instance_id, node_id, node_key, node_type, status, data_json, entered_at, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    [
      instance.id,
      node.id,
      node.node_key,
      node.type,
      JSON.stringify({ from_node_id: fromNodeId, entered_at: ts }),
      ts,
      instance.tenant_id,
      ts,
      ts,
    ]
  );
  run(db, "UPDATE workflow_instances SET current_node_id = ?, updated_at = ? WHERE id = ?", [node.id, ts, instance.id]);
  return queryOne(db, "SELECT * FROM workflow_instance_nodes WHERE id = ?", [result.lastInsertId]);
}

function completeToken(db, token, outcome, extraData = {}) {
  const ts = nowIso();
  const data = { ...safeParse(token.data_json, {}), ...extraData };
  run(
    db,
    `UPDATE workflow_instance_nodes SET status = 'completed', outcome = ?, data_json = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
    [outcome || "", JSON.stringify(data), ts, ts, token.id]
  );
  return queryOne(db, "SELECT * FROM workflow_instance_nodes WHERE id = ?", [token.id]);
}

function blockToken(db, token, outcome, extraData = {}) {
  const ts = nowIso();
  const data = { ...safeParse(token.data_json, {}), ...extraData };
  run(db, `UPDATE workflow_instance_nodes SET status = 'blocked', outcome = ?, data_json = ?, updated_at = ? WHERE id = ?`, [
    outcome || "",
    JSON.stringify(data),
    ts,
    token.id,
  ]);
  return queryOne(db, "SELECT * FROM workflow_instance_nodes WHERE id = ?", [token.id]);
}

export function instanceContext(db, instance, token = null) {
  const base = safeParse(instance.context_json, {});
  const instanceNodeData = token ? safeParse(token.data_json, {}) : {};
  return { ...base, ...instanceNodeData, instance_id: instance.id, instance_code: instance.code, object_id: instance.object_id ?? null };
}

function outgoingTransitions(db, node) {
  return queryAll(db, "SELECT * FROM workflow_transitions WHERE from_node_id = ? ORDER BY display_order, id", [node.id]);
}

function chooseTransition(db, node, context) {
  const edges = outgoingTransitions(db, node);
  if (!edges.length) return null;
  let fallback = null;
  for (const edge of edges) {
    if (edge.is_default === 1) {
      if (!fallback) fallback = edge;
      continue;
    }
    const condition = safeParse(edge.condition_json, {});
    if (!condition || Object.keys(condition).length === 0) {
      if (!fallback) fallback = edge;
      continue;
    }
    if (evaluateCondition(condition, context)) return edge;
  }
  return fallback || edges[0];
}

// A task (or other auto/blocking node) is treated as a conditional fork when it
// has more than one outgoing branch and at least one branch carries a condition
// or is marked as the default. That lets "conditional tasks" route to exactly
// one next step while leaving plain multi-branch fan-out untouched.
function hasConditionalBranches(db, node) {
  const edges = outgoingTransitions(db, node);
  if (edges.length <= 1) return false;
  return edges.some((edge) => {
    if (edge.is_default === 1) return true;
    const condition = safeParse(edge.condition_json, {});
    return Boolean(condition && Object.keys(condition).length);
  });
}

// Approvals declare which branch is followed on approval and which on
// rejection via the node config. Without an explicitly configured reject path
// the engine keeps the legacy behaviour of failing the token.
function approvalTransition(db, node, decision) {
  const config = safeParse(node?.config_json, {});
  const edges = outgoingTransitions(db, node);
  if (!edges.length) return null;
  const wanted = decision === "reject" ? config.reject_transition_key : config.approve_transition_key;
  if (wanted) {
    const match = edges.find((edge) => String(edge.transition_key) === String(wanted));
    if (match) return match;
  }
  if (decision === "reject") return null;
  const rejectKey = config.reject_transition_key;
  const candidates = edges.filter((edge) => !rejectKey || String(edge.transition_key) !== String(rejectKey));
  if (!candidates.length) return null;
  return candidates.find((edge) => edge.is_default === 1) || candidates[0];
}

function activateOutgoing(db, instance, node, { actor = null, onlyTransition = null } = {}) {
  const edges = onlyTransition ? [onlyTransition] : outgoingTransitions(db, node);
  for (const edge of edges) {
    const target = getNodeRow(db, edge.to_node_id);
    if (target) activateNode(db, instance, target, { fromNodeId: node.id, actor });
  }
  return edges.length;
}

function resolveDueAt(config, context) {
  const ts = nowIso();
  const base = Date.now();
  const minutes = Number(config.duration_minutes ?? config.due_minutes ?? config.minutes ?? 0);
  const hours = Number(config.duration_hours ?? config.hours ?? 0);
  const days = Number(config.duration_days ?? config.days ?? 0);
  const dueBase = config.due_at ?? config.dueAt;
  if (dueBase) return String(dueBase);
  const totalMs = (minutes + hours * 60 + days * 1440) * 60000;
  if (!totalMs) return ts;
  return new Date(base + totalMs).toISOString().replace("T", " ").slice(0, 19);
}

function startSubprocess(db, instance, node, context, actor) {
  const config = safeParse(node.config_json, {});
  const targetDefinition = config.definition_id
    ? getDefinitionRow(db, Number(config.definition_id))
    : findDefinition(db, config.workflow_code ?? config.workflowCode, instance.tenant_id);
  if (!targetDefinition) throw new HttpError(422, `Subprocess node "${node.node_key}" references an unknown workflow`);
  const child = startInstance(
    db,
    {
      definition_id: targetDefinition.id,
      version_id: config.version_id ?? config.versionId ?? undefined,
      title: config.title || `${instance.title} / ${node.name}`,
      object_id: instance.object_id,
      organization_id: instance.organization_id,
      context: { ...context, parent_instance_id: instance.id, parent_node_key: node.node_key },
      parent_instance_id: instance.id,
      parent_node_id: node.id,
      allow_draft: config.allow_draft ?? config.allowDraft ?? false,
    },
    actor,
    instance.tenant_id,
    null
  );
  return child;
}

function processActiveToken(db, instance, token, { actor = null, ip = null } = {}) {
  const node = getNodeRow(db, token.node_id);
  if (!node) {
    run(db, "UPDATE workflow_instance_nodes SET status = 'failed', outcome = 'missing_node', updated_at = ? WHERE id = ?", [nowIso(), token.id]);
    return true;
  }
  const config = safeParse(node.config_json, {});
  const context = instanceContext(db, instance, token);
  switch (node.type) {
    case "start": {
      completeToken(db, token, "started");
      activateOutgoing(db, instance, node, { actor });
      return true;
    }
    case "end": {
      completeToken(db, token, "ended");
      maybeCompleteInstance(db, instance, { actor });
      return true;
    }
    case "task": {
      const assignee = resolveAssignee(db, {
        definitionId: instance.definition_id,
        nodeType: node.type,
        nodeConfig: config,
        context,
        tenantId: instance.tenant_id,
        organizationId: instance.organization_id,
        nodeKey: node.node_key,
      });
      const dueAt = config.due_at || config.dueAt || (config.due_minutes || config.dueMinutes ? resolveDueAt({ due_minutes: config.due_minutes ?? config.dueMinutes }, context) : null);
      const escalationAt = config.escalation_minutes ?? config.escalationMinutes ? resolveDueAt({ due_minutes: config.escalation_minutes ?? config.escalationMinutes }, context) : null;
      const task = createTask(db, {
        instance,
        instanceNode: token,
        node,
        code: `${instance.code}-${node.node_key}`,
        title: config.title || node.name,
        description: config.description || node.description || "",
        assignee,
        priority: config.priority || "normal",
        dueAt,
        escalationAt,
        form: config.form || {},
        data: context,
        createdBy: actor?.id ?? null,
        organizationId: instance.organization_id,
      });
      blockToken(db, token, "waiting_task", { task_id: task.id, assignee_type: assignee.assignee_type });
      return true;
    }
    case "approval": {
      const result = createApprovalsForNode(db, { instance, instanceNode: token, node, actor });
      if (result.auto) {
        completeToken(db, token, "auto_approved");
        activateOutgoing(db, instance, node, { actor });
      } else {
        blockToken(db, token, "waiting_approval", { approval_rule_id: result.rule?.id ?? null, approvals: result.approvals.length });
      }
      return true;
    }
    case "decision": {
      const edge = chooseTransition(db, node, context);
      completeToken(db, token, "decision", { chosen_transition_id: edge?.id ?? null, chosen_to: edge?.to_node_id ?? null });
      if (edge) activateOutgoing(db, instance, node, { actor, onlyTransition: edge });
      return true;
    }
    case "parallel": {
      completeToken(db, token, "split");
      activateOutgoing(db, instance, node, { actor });
      return true;
    }
    case "join": {
      blockToken(db, token, "waiting_join");
      return true;
    }
    case "notification": {
      const recipients = Array.isArray(config.recipients) ? config.recipients : [];
      for (const recipient of recipients) {
        dispatch(db, {
          instance,
          channel: config.channel || "in_app",
          recipientType: recipient.recipient_type || "user",
          recipientId: recipient.recipient_id ?? null,
          recipientRef: recipient.recipient_ref || recipient.username || "",
          subject: config.subject || node.name,
          body: config.body || config.message || "",
          payload: context,
          tenantId: instance.tenant_id,
        });
      }
      recordEvent(db, {
        instanceId: instance.id,
        nodeKey: node.node_key,
        eventType: "notification.sent",
        actorId: actor?.id ?? null,
        message: `Notification node "${node.name}" processed`,
        details: { recipients: recipients.length },
        tenantId: instance.tenant_id,
      });
      completeToken(db, token, "notified");
      activateOutgoing(db, instance, node, { actor });
      return true;
    }
    case "service": {
      const handlerName = config.handler;
      const handler = handlerName ? serviceHandler(handlerName) : null;
      let output = { handled: false, handler: handlerName || null };
      if (handler) {
        output = handler({ db, instance, node, config, context, actor }) || { handled: true };
      } else if (handlerName) {
        output = { handled: false, handler: handlerName, warning: "No service handler registered" };
      }
      recordEvent(db, {
        instanceId: instance.id,
        nodeKey: node.node_key,
        eventType: "service.executed",
        actorId: actor?.id ?? null,
        message: `Service node "${node.name}" executed`,
        details: output,
        tenantId: instance.tenant_id,
      });
      completeToken(db, token, "serviced", { output });
      activateOutgoing(db, instance, node, { actor });
      return true;
    }
    case "timer": {
      const dueAt = resolveDueAt(config, context);
      blockToken(db, token, "waiting_timer", { due_at: dueAt });
      return true;
    }
    case "subprocess": {
      const child = startSubprocess(db, instance, node, context, actor);
      blockToken(db, token, "waiting_subprocess", { child_instance_id: child.id });
      return true;
    }
    case "terminate": {
      cancelInstance(db, instance.id, { reason: `Terminated at node ${node.node_key}`, actor, ip, skipAdvance: true });
      return true;
    }
    default: {
      completeToken(db, token, "skipped");
      activateOutgoing(db, instance, node, { actor });
      return true;
    }
  }
}

function taskCompleted(db, taskId) {
  const row = queryOne(db, "SELECT status FROM workflow_tasks WHERE id = ?", [Number(taskId)]);
  return row && row.status === "completed";
}

function joinReady(db, instance, token) {
  const node = getNodeRow(db, token.node_id);
  if (!node) return true;
  const incoming = queryAll(db, "SELECT * FROM workflow_transitions WHERE to_node_id = ?", [node.id]);
  if (!incoming.length) return true;
  const sources = incoming.map((edge) => edge.from_node_id);
  const completed = new Set(
    queryAll(db, "SELECT DISTINCT node_id FROM workflow_instance_nodes WHERE instance_id = ? AND status = 'completed'", [instance.id]).map(
      (row) => row.node_id
    )
  );
  const allArrived = sources.every((sourceId) => completed.has(sourceId));
  if (allArrived) return true;
  // Deadlock breaker: if nothing else is in flight and at least one branch
  // arrived, let the join proceed rather than hanging forever on a branch an
  // exclusive decision never activated.
  const inFlight = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM workflow_instance_nodes WHERE instance_id = ? AND status IN ('active','blocked') AND id <> ?",
    [instance.id, token.id]
  ).c;
  const openWork = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM workflow_tasks WHERE instance_id = ? AND status IN ('unassigned','assigned','in_progress','blocked','awaiting_approval')",
    [instance.id]
  ).c;
  const arrived = sources.filter((sourceId) => completed.has(sourceId)).length;
  if (inFlight === 0 && openWork === 0 && arrived > 0) return true;
  return false;
}

function waitingApprovalResolved(db, instance, token) {
  const counts = queryAll(
    db,
    "SELECT status, COUNT(*) AS c FROM workflow_approvals WHERE instance_id = ? AND node_id = ? GROUP BY status",
    [instance.id, token.node_id]
  );
  const byStatus = Object.fromEntries(counts.map((row) => [row.status, row.c]));
  const pending = byStatus.pending || 0;
  const approved = byStatus.approved || 0;
  const rejected = byStatus.rejected || 0;
  const changes = byStatus.changes_requested || 0;
  if (pending > 0) return null;
  if (rejected > 0) return "rejected";
  if (approved > 0) return "approved";
  if (changes > 0) return "changes_requested";
  return null;
}

function processBlockedToken(db, instance, token, { actor = null, ip = null } = {}) {
  const data = safeParse(token.data_json, {});
  const outcome = token.outcome;
  if (outcome === "waiting_task") {
    if (data.task_id && taskCompleted(db, data.task_id)) {
      const node = getNodeRow(db, token.node_id);
      if (hasConditionalBranches(db, node)) {
        const edge = chooseTransition(db, node, instanceContext(db, instance, token));
        completeToken(db, token, "task_completed", { task_id: data.task_id, chosen_transition_id: edge?.id ?? null });
        if (edge) activateOutgoing(db, instance, node, { actor, onlyTransition: edge });
      } else {
        completeToken(db, token, "task_completed", { task_id: data.task_id });
        activateOutgoing(db, instance, node, { actor });
      }
      return true;
    }
    return false;
  }
  if (outcome === "waiting_approval") {
    const state = waitingApprovalResolved(db, instance, token);
    if (state === "approved") {
      const node = getNodeRow(db, token.node_id);
      const edge = approvalTransition(db, node, "approve");
      completeToken(db, token, "approved", { chosen_transition_id: edge?.id ?? null });
      if (edge) activateOutgoing(db, instance, node, { actor, onlyTransition: edge });
      else activateOutgoing(db, instance, node, { actor });
      return true;
    }
    if (state === "rejected") {
      const node = getNodeRow(db, token.node_id);
      const edge = approvalTransition(db, node, "reject");
      if (edge) {
        completeToken(db, token, "rejected", { chosen_transition_id: edge.id });
        activateOutgoing(db, instance, node, { actor, onlyTransition: edge });
        return true;
      }
    }
    return false;
  }
  if (outcome === "waiting_timer") {
    const dueAt = data.due_at ? String(data.due_at) : null;
    if (dueAt && dueAt <= nowIso()) {
      completeToken(db, token, "timer_elapsed");
      const node = getNodeRow(db, token.node_id);
      activateOutgoing(db, instance, node, { actor });
      return true;
    }
    return false;
  }
  if (outcome === "waiting_subprocess") {
    const child = data.child_instance_id
      ? queryOne(db, "SELECT status FROM workflow_instances WHERE id = ?", [Number(data.child_instance_id)])
      : null;
    if (child && ["completed", "cancelled", "failed"].includes(child.status)) {
      completeToken(db, token, `subprocess_${child.status}`);
      const node = getNodeRow(db, token.node_id);
      activateOutgoing(db, instance, node, { actor });
      return true;
    }
    return false;
  }
  if (outcome === "waiting_join") {
    if (joinReady(db, instance, token)) {
      completeToken(db, token, "joined");
      const node = getNodeRow(db, token.node_id);
      activateOutgoing(db, instance, node, { actor });
      return true;
    }
    return false;
  }
  // Unknown blocked state: reactivate so the engine can make progress.
  run(db, "UPDATE workflow_instance_nodes SET status = 'active', updated_at = ? WHERE id = ?", [nowIso(), token.id]);
  return true;
}

function maybeCompleteInstance(db, instance, { actor = null } = {}) {
  const fresh = queryOne(db, "SELECT * FROM workflow_instances WHERE id = ?", [instance.id]);
  if (!fresh || ["completed", "cancelled", "failed"].includes(fresh.status)) return fresh;
  const open = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM workflow_instance_nodes WHERE instance_id = ? AND status IN ('active','blocked')",
    [instance.id]
  ).c;
  const openTasks = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM workflow_tasks WHERE instance_id = ? AND status IN ('unassigned','assigned','in_progress','blocked','awaiting_approval')",
    [instance.id]
  ).c;
  const openApprovals = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM workflow_approvals WHERE instance_id = ? AND status = 'pending'",
    [instance.id]
  ).c;
  if (open === 0 && openTasks === 0 && openApprovals === 0) {
    const ts = nowIso();
    run(db, "UPDATE workflow_instances SET status = 'completed', ended_at = ?, updated_at = ? WHERE id = ?", [ts, ts, instance.id]);
    recordEvent(db, {
      instanceId: instance.id,
      eventType: "workflow.completed",
      actorId: actor?.id ?? null,
      message: "Workflow completed",
      tenantId: instance.tenant_id,
    });
    emitDomainEvent(
      db,
      {
        event_type_code: "WorkflowCompleted",
        source_module: "workflow",
        source_object_type: "workflow_instance",
        source_object_id: String(instance.id),
        tenant_id: Number(instance.tenant_id),
        organization_id: fresh.organization_id ?? null,
        payload: {
          instance_id: instance.id,
          instance_code: fresh.code,
          definition_id: fresh.definition_id,
          object_id: fresh.object_id ?? null,
          title: fresh.title,
          status: "completed",
        },
        idempotency_key: `workflow:completed:${instance.id}`,
      },
      actor
    );
    notifyParent(db, instance.id, "completed", actor);
    return queryOne(db, "SELECT * FROM workflow_instances WHERE id = ?", [instance.id]);
  }
  return fresh;
}

function notifyParent(db, childId, outcome, actor) {
  const child = queryOne(db, "SELECT * FROM workflow_instances WHERE id = ?", [childId]);
  if (child?.parent_instance_id) {
    advance(db, child.parent_instance_id, { actor, outcome });
  }
}

export function advance(db, instanceId, { actor = null, ip = null, taskId = null, outcome = null } = {}) {
  const instance = queryOne(db, "SELECT * FROM workflow_instances WHERE id = ?", [Number(instanceId)]);
  if (!instance) throw new HttpError(404, "Workflow instance not found");
  if (["completed", "cancelled", "failed"].includes(instance.status)) return getInstance(db, instance.id, instance.tenant_id, { includeDetail: false });
  if (instance.status === "paused") return getInstance(db, instance.id, instance.tenant_id, { includeDetail: false });
  if (instance.status === "pending") {
    run(db, "UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?", [nowIso(), instance.id]);
  }
  let progressed = true;
  let steps = 0;
  while (progressed && steps < MAX_STEPS) {
    progressed = false;
    steps += 1;
    const tokens = queryAll(
      db,
      "SELECT * FROM workflow_instance_nodes WHERE instance_id = ? AND status IN ('active','blocked') ORDER BY id",
      [instance.id]
    );
    for (const token of tokens) {
      let changed = false;
      if (token.status === "active") changed = processActiveToken(db, instance, token, { actor, ip });
      else changed = processBlockedToken(db, instance, token, { actor, ip });
      if (changed) progressed = true;
    }
  }
  maybeCompleteInstance(db, instance, { actor });
  return getInstance(db, instance.id, instance.tenant_id, { includeDetail: false });
}

export function pauseInstance(db, id, body = {}, actor = null, tenantId = null, ip = null) {
  const instance = getInstanceRow(db, id);
  assertReadable(instance, tenantId, "Workflow instance not found");
  if (!["running", "pending"].includes(instance.status)) throw new HttpError(409, `Cannot pause a ${instance.status} workflow`);
  run(db, "UPDATE workflow_instances SET status = 'paused', updated_at = ? WHERE id = ?", [nowIso(), instance.id]);
  recordEvent(db, { instanceId: instance.id, eventType: "workflow.paused", actorId: actor?.id ?? null, message: body.reason || "Workflow paused", tenantId: instance.tenant_id });
  writeAudit(db, { actor, action: "workflow.instance.pause", resourceType: "workflow_instance", resourceId: instance.id, ip });
  return getInstance(db, instance.id, tenantId);
}

export function resumeInstance(db, id, body = {}, actor = null, tenantId = null, ip = null) {
  const instance = getInstanceRow(db, id);
  assertReadable(instance, tenantId, "Workflow instance not found");
  if (instance.status !== "paused") throw new HttpError(409, "Only a paused workflow can be resumed");
  run(db, "UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?", [nowIso(), instance.id]);
  recordEvent(db, { instanceId: instance.id, eventType: "workflow.resumed", actorId: actor?.id ?? null, message: body.reason || "Workflow resumed", tenantId: instance.tenant_id });
  writeAudit(db, { actor, action: "workflow.instance.resume", resourceType: "workflow_instance", resourceId: instance.id, ip });
  advance(db, instance.id, { actor, ip });
  return getInstance(db, instance.id, tenantId);
}

export function cancelInstance(db, id, { reason = "", actor = null, ip = null, skipAdvance = false } = {}) {
  const instance = queryOne(db, "SELECT * FROM workflow_instances WHERE id = ?", [Number(id)]);
  if (!instance) throw new HttpError(404, "Workflow instance not found");
  if (["completed", "cancelled"].includes(instance.status)) return getInstance(db, instance.id, instance.tenant_id);
  const ts = nowIso();
  transaction(db, () => {
    run(db, "UPDATE workflow_instances SET status = 'cancelled', ended_at = ?, updated_at = ? WHERE id = ?", [ts, ts, instance.id]);
    run(db, "UPDATE workflow_instance_nodes SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE instance_id = ? AND status IN ('active','blocked')", [
      ts,
      ts,
      instance.id,
    ]);
    run(db, "UPDATE workflow_tasks SET status = 'cancelled', updated_at = ? WHERE instance_id = ? AND status IN ('unassigned','assigned','in_progress','blocked','awaiting_approval')", [
      ts,
      instance.id,
    ]);
    run(db, "UPDATE workflow_approvals SET status = 'cancelled', updated_at = ? WHERE instance_id = ? AND status = 'pending'", [ts, instance.id]);
  });
  recordEvent(db, { instanceId: instance.id, eventType: "workflow.cancelled", actorId: actor?.id ?? null, message: reason || "Workflow cancelled", tenantId: instance.tenant_id });
  writeAudit(db, { actor, action: "workflow.instance.cancel", resourceType: "workflow_instance", resourceId: instance.id, details: { reason }, ip });
  if (!skipAdvance) notifyParent(db, instance.id, "cancelled", actor);
  return getInstance(db, instance.id, instance.tenant_id);
}

export function retryInstance(db, id, body = {}, actor = null, tenantId = null, ip = null) {
  const instance = getInstanceRow(db, id);
  assertReadable(instance, tenantId, "Workflow instance not found");
  if (!["failed", "paused"].includes(instance.status)) throw new HttpError(409, "Only a failed or paused workflow can be retried");
  const ts = nowIso();
  transaction(db, () => {
    run(db, "UPDATE workflow_instances SET status = 'running', ended_at = NULL, updated_at = ? WHERE id = ?", [ts, instance.id]);
    run(
      db,
      "UPDATE workflow_instance_nodes SET status = 'active', completed_at = NULL, updated_at = ? WHERE instance_id = ? AND status IN ('failed','blocked')",
      [ts, instance.id]
    );
    run(db, "UPDATE workflow_approvals SET status = 'pending', updated_at = ? WHERE instance_id = ? AND status = 'changes_requested'", [ts, instance.id]);
  });
  recordEvent(db, { instanceId: instance.id, eventType: "workflow.retried", actorId: actor?.id ?? null, message: body.reason || "Workflow retried", tenantId: instance.tenant_id });
  writeAudit(db, { actor, action: "workflow.instance.retry", resourceType: "workflow_instance", resourceId: instance.id, ip });
  advance(db, instance.id, { actor, ip });
  return getInstance(db, instance.id, tenantId);
}

export function instanceNodes(db, id, tenantId) {
  const instance = getInstanceRow(db, id);
  assertReadable(instance, tenantId, "Workflow instance not found");
  return queryAll(db, "SELECT * FROM workflow_instance_nodes WHERE instance_id = ? ORDER BY id", [instance.id]).map(publicInstanceNode);
}

export function instanceHistory(db, id, tenantId, query = {}) {
  const instance = getInstanceRow(db, id);
  assertReadable(instance, tenantId, "Workflow instance not found");
  return { instance: publicInstance(instance), ...listEvents(db, instance.id, query) };
}

export { publicTask, publicApproval, INSTANCE_STATUSES, TASK_OPEN_STATUSES };

// ── Async twins (read-only) ─────────────────────────────────────────────────

export async function getInstanceRowAsync(db, id) {
  return queryOneAsync(db, `${INSTANCE_SELECT} WHERE i.id = ?`, [Number(id)]);
}

export async function listInstancesAsync(db, query = {}, tenantId) {
  const { page, pageSize, offset } = pagination(query);
  const where = ["i.tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    const statuses = String(query.status)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    where.push(`i.status IN (${statuses.map(() => "?").join(", ")})`);
    params.push(...statuses);
  }
  if (query.definitionId || query.definition_id) {
    where.push("i.definition_id = ?");
    params.push(Number(query.definitionId || query.definition_id));
  }
  if (query.objectId || query.object_id) {
    where.push("i.object_id = ?");
    params.push(Number(query.objectId || query.object_id));
  }
  if (query.parentInstanceId || query.parent_instance_id) {
    where.push("i.parent_instance_id = ?");
    params.push(Number(query.parentInstanceId || query.parent_instance_id));
  }
  if (query.q) {
    where.push("(i.code ILIKE ? OR i.title ILIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = (await queryOneAsync(db, `SELECT COUNT(*) AS c FROM workflow_instances i ${clause}`, params)).c;
  const items = (
    await queryAllAsync(db, `${INSTANCE_SELECT} ${clause} ORDER BY i.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset])
  ).map((row) => publicInstance(row));
  return { items, total, page, pageSize };
}

export async function getInstanceAsync(db, id, tenantId, { includeDetail = true } = {}) {
  const row = await getInstanceRowAsync(db, id);
  assertReadable(row, tenantId, "Workflow instance not found");
  const instance = publicInstance(row);
  if (row.definition_id) instance.definition = publicDefinition(await getDefinitionRowAsync(db, row.definition_id));
  if (includeDetail) {
    instance.nodes = (
      await queryAllAsync(db, "SELECT * FROM workflow_instance_nodes WHERE instance_id = ? ORDER BY id", [row.id])
    ).map(publicInstanceNode);
    instance.tasks = (await queryAllAsync(db, "SELECT * FROM workflow_tasks WHERE instance_id = ? ORDER BY id", [row.id])).map(publicTask);
    instance.approvals = (
      await queryAllAsync(db, "SELECT * FROM workflow_approvals WHERE instance_id = ? ORDER BY id", [row.id])
    ).map(publicApproval);
    instance.events = (await listEventsAsync(db, row.id, { pageSize: 100 })).items;
    instance.children = (
      await queryAllAsync(db, `${INSTANCE_SELECT} WHERE i.parent_instance_id = ? ORDER BY i.id`, [row.id])
    ).map((child) => publicInstance(child));
  }
  return instance;
}

export async function instanceNodesAsync(db, id, tenantId) {
  const instance = await getInstanceRowAsync(db, id);
  assertReadable(instance, tenantId, "Workflow instance not found");
  return (
    await queryAllAsync(db, "SELECT * FROM workflow_instance_nodes WHERE instance_id = ? ORDER BY id", [instance.id])
  ).map(publicInstanceNode);
}

export async function instanceHistoryAsync(db, id, tenantId, query = {}) {
  const instance = await getInstanceRowAsync(db, id);
  assertReadable(instance, tenantId, "Workflow instance not found");
  return { instance: publicInstance(instance), ...(await listEventsAsync(db, instance.id, query)) };
}

// ── Async twins (runtime engine + lifecycle writes) ─────────────────────────

async function activateNodeAsync(db, instance, node, { fromNodeId = null, actor = null } = {}) {
  const ts = nowIso();
  const result = await runAsync(
    db,
    `INSERT INTO workflow_instance_nodes
      (instance_id, node_id, node_key, node_type, status, data_json, entered_at, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    [
      instance.id,
      node.id,
      node.node_key,
      node.type,
      JSON.stringify({ from_node_id: fromNodeId, entered_at: ts }),
      ts,
      instance.tenant_id,
      ts,
      ts,
    ]
  );
  await runAsync(db, "UPDATE workflow_instances SET current_node_id = ?, updated_at = ? WHERE id = ?", [node.id, ts, instance.id]);
  return queryOneAsync(db, "SELECT * FROM workflow_instance_nodes WHERE id = ?", [result.lastInsertId]);
}

async function completeTokenAsync(db, token, outcome, extraData = {}) {
  const ts = nowIso();
  const data = { ...safeParse(token.data_json, {}), ...extraData };
  await runAsync(
    db,
    `UPDATE workflow_instance_nodes SET status = 'completed', outcome = ?, data_json = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
    [outcome || "", JSON.stringify(data), ts, ts, token.id]
  );
  return queryOneAsync(db, "SELECT * FROM workflow_instance_nodes WHERE id = ?", [token.id]);
}

async function blockTokenAsync(db, token, outcome, extraData = {}) {
  const ts = nowIso();
  const data = { ...safeParse(token.data_json, {}), ...extraData };
  await runAsync(db, `UPDATE workflow_instance_nodes SET status = 'blocked', outcome = ?, data_json = ?, updated_at = ? WHERE id = ?`, [
    outcome || "",
    JSON.stringify(data),
    ts,
    token.id,
  ]);
  return queryOneAsync(db, "SELECT * FROM workflow_instance_nodes WHERE id = ?", [token.id]);
}

async function outgoingTransitionsAsync(db, node) {
  return queryAllAsync(db, "SELECT * FROM workflow_transitions WHERE from_node_id = ? ORDER BY display_order, id", [node.id]);
}

async function chooseTransitionAsync(db, node, context) {
  const edges = await outgoingTransitionsAsync(db, node);
  if (!edges.length) return null;
  let fallback = null;
  for (const edge of edges) {
    if (edge.is_default === 1) {
      if (!fallback) fallback = edge;
      continue;
    }
    const condition = safeParse(edge.condition_json, {});
    if (!condition || Object.keys(condition).length === 0) {
      if (!fallback) fallback = edge;
      continue;
    }
    if (evaluateCondition(condition, context)) return edge;
  }
  return fallback || edges[0];
}

async function hasConditionalBranchesAsync(db, node) {
  const edges = await outgoingTransitionsAsync(db, node);
  if (edges.length <= 1) return false;
  return edges.some((edge) => {
    if (edge.is_default === 1) return true;
    const condition = safeParse(edge.condition_json, {});
    return Boolean(condition && Object.keys(condition).length);
  });
}

async function approvalTransitionAsync(db, node, decision) {
  const config = safeParse(node?.config_json, {});
  const edges = await outgoingTransitionsAsync(db, node);
  if (!edges.length) return null;
  const wanted = decision === "reject" ? config.reject_transition_key : config.approve_transition_key;
  if (wanted) {
    const match = edges.find((edge) => String(edge.transition_key) === String(wanted));
    if (match) return match;
  }
  if (decision === "reject") return null;
  const rejectKey = config.reject_transition_key;
  const candidates = edges.filter((edge) => !rejectKey || String(edge.transition_key) !== String(rejectKey));
  if (!candidates.length) return null;
  return candidates.find((edge) => edge.is_default === 1) || candidates[0];
}

async function activateOutgoingAsync(db, instance, node, { actor = null, onlyTransition = null } = {}) {
  const edges = onlyTransition ? [onlyTransition] : await outgoingTransitionsAsync(db, node);
  for (const edge of edges) {
    const target = await getNodeRowAsync(db, edge.to_node_id);
    if (target) await activateNodeAsync(db, instance, target, { fromNodeId: node.id, actor });
  }
  return edges.length;
}

async function startSubprocessAsync(db, instance, node, context, actor) {
  const config = safeParse(node.config_json, {});
  const targetDefinition = config.definition_id
    ? await getDefinitionRowAsync(db, Number(config.definition_id))
    : await findDefinitionAsync(db, config.workflow_code ?? config.workflowCode, instance.tenant_id);
  if (!targetDefinition) throw new HttpError(422, `Subprocess node "${node.node_key}" references an unknown workflow`);
  const child = await startInstanceAsync(
    db,
    {
      definition_id: targetDefinition.id,
      version_id: config.version_id ?? config.versionId ?? undefined,
      title: config.title || `${instance.title} / ${node.name}`,
      object_id: instance.object_id,
      organization_id: instance.organization_id,
      context: { ...context, parent_instance_id: instance.id, parent_node_key: node.node_key },
      parent_instance_id: instance.id,
      parent_node_id: node.id,
      allow_draft: config.allow_draft ?? config.allowDraft ?? false,
    },
    actor,
    instance.tenant_id,
    null
  );
  return child;
}

export async function startInstanceAsync(db, body = {}, actor = null, tenantId = null, ip = null) {
  requireFields(body, ["title"]);
  if (!tenantId) throw new HttpError(400, "A tenant context is required to start a workflow");
  const definition = body.definition_id || body.definitionId
    ? await getDefinitionRowAsync(db, Number(body.definition_id ?? body.definitionId))
    : await findDefinitionAsync(db, body.workflow_code ?? body.workflowCode, tenantId);
  if (!definition) throw new HttpError(404, "Workflow template not found");
  assertReadable(definition, tenantId, "Workflow template not found");
  let versionRow = null;
  const versionRef = body.version_id ?? body.versionId ?? body.version;
  if (versionRef !== undefined && versionRef !== null && versionRef !== "") {
    versionRow = /^\d+$/.test(String(versionRef))
      ? await getVersionRowAsync(db, Number(versionRef))
      : await queryOneAsync(db, "SELECT * FROM workflow_versions WHERE definition_id = ? AND status = ? ORDER BY version DESC LIMIT 1", [
          definition.id,
          String(versionRef),
        ]);
    if (!versionRow || Number(versionRow.definition_id) !== Number(definition.id)) throw new HttpError(404, "Workflow version not found");
  } else {
    versionRow = await publishedVersionRowAsync(db, definition.id);
  }
  if (!versionRow) throw new HttpError(409, "Workflow has no published version to run");
  if (versionRow.status !== "published" && !body.allow_draft && !body.allowDraft) {
    throw new HttpError(409, "Only published workflow versions can be started");
  }
  const objectId = body.object_id ?? body.objectId ?? null;
  const context = body.context && typeof body.context === "object" ? { ...body.context } : {};
  if (objectId && context.object_id === undefined) context.object_id = objectId;
  const ts = nowIso();
  let instanceId;
  await transactionAsync(db, async () => {
    const result = await runAsync(
      db,
      `INSERT INTO workflow_instances
        (code, definition_id, version_id, object_id, parent_instance_id, parent_node_id, title, status, context_json,
         started_by, organization_id, tenant_id, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.code || nextInstanceCode(db),
        definition.id,
        versionRow.id,
        objectId,
        body.parent_instance_id ?? body.parentInstanceId ?? null,
        body.parent_node_id ?? body.parentNodeId ?? null,
        String(body.title).trim(),
        JSON.stringify(context),
        actor?.id ?? null,
        body.organization_id ?? body.organizationId ?? actor?.organization_id ?? null,
        Number(tenantId),
        ts,
        ts,
        ts,
      ]
    );
    instanceId = result.lastInsertId;
    await recordEventAsync(db, {
      instanceId,
      eventType: "workflow.started",
      actorId: actor?.id ?? null,
      message: `Workflow "${body.title}" started`,
      details: { definition_id: definition.id, version_id: versionRow.id },
      tenantId: Number(tenantId),
    });
  });
  const instance = await getInstanceRowAsync(db, instanceId);
  await emitDomainEventAsync(
    db,
    {
      event_type_code: "WorkflowStarted",
      source_module: "workflow",
      source_object_type: "workflow_instance",
      source_object_id: String(instance.id),
      source_object_revision: instance.version_id ?? null,
      tenant_id: Number(tenantId),
      organization_id: instance.organization_id ?? null,
      correlation_id: body.correlation_id ?? null,
      payload: {
        instance_id: instance.id,
        instance_code: instance.code,
        definition_id: definition.id,
        definition_code: definition.code,
        version_id: versionRow.id,
        object_id: objectId ?? null,
        title: instance.title,
        status: instance.status,
      },
      idempotency_key: `workflow:started:${instance.id}`,
    },
    actor
  );
  const startNode = await queryOneAsync(db, "SELECT * FROM workflow_nodes WHERE version_id = ? AND type = 'start' ORDER BY id LIMIT 1", [versionRow.id]);
  if (!startNode) throw new HttpError(422, "Workflow version has no start node");
  await activateNodeAsync(db, instance, startNode, { fromNodeId: null, actor });
  await writeAuditAsync(db, {
    actor,
    action: "workflow.instance.start",
    resourceType: "workflow_instance",
    resourceId: instanceId,
    details: { code: body.code || null, definition: definition.code, version: versionRow.version },
    ip,
  });
  await advanceAsync(db, instanceId, { actor, ip });
  return getInstanceAsync(db, instanceId, tenantId);
}

async function processActiveTokenAsync(db, instance, token, { actor = null, ip = null } = {}) {
  const node = await getNodeRowAsync(db, token.node_id);
  if (!node) {
    await runAsync(db, "UPDATE workflow_instance_nodes SET status = 'failed', outcome = 'missing_node', updated_at = ? WHERE id = ?", [nowIso(), token.id]);
    return true;
  }
  const config = safeParse(node.config_json, {});
  const context = instanceContext(db, instance, token);
  switch (node.type) {
    case "start": {
      await completeTokenAsync(db, token, "started");
      await activateOutgoingAsync(db, instance, node, { actor });
      return true;
    }
    case "end": {
      await completeTokenAsync(db, token, "ended");
      await maybeCompleteInstanceAsync(db, instance, { actor });
      return true;
    }
    case "task": {
      const assignee = await resolveAssigneeAsync(db, {
        definitionId: instance.definition_id,
        nodeType: node.type,
        nodeConfig: config,
        context,
        tenantId: instance.tenant_id,
        organizationId: instance.organization_id,
        nodeKey: node.node_key,
      });
      const dueAt = config.due_at || config.dueAt || (config.due_minutes || config.dueMinutes ? resolveDueAt({ due_minutes: config.due_minutes ?? config.dueMinutes }, context) : null);
      const escalationAt = config.escalation_minutes ?? config.escalationMinutes ? resolveDueAt({ due_minutes: config.escalation_minutes ?? config.escalationMinutes }, context) : null;
      const task = await createTaskAsync(db, {
        instance,
        instanceNode: token,
        node,
        code: `${instance.code}-${node.node_key}`,
        title: config.title || node.name,
        description: config.description || node.description || "",
        assignee,
        priority: config.priority || "normal",
        dueAt,
        escalationAt,
        form: config.form || {},
        data: context,
        createdBy: actor?.id ?? null,
        organizationId: instance.organization_id,
      });
      await blockTokenAsync(db, token, "waiting_task", { task_id: task.id, assignee_type: assignee.assignee_type });
      return true;
    }
    case "approval": {
      const result = await createApprovalsForNodeAsync(db, { instance, instanceNode: token, node, actor });
      if (result.auto) {
        await completeTokenAsync(db, token, "auto_approved");
        await activateOutgoingAsync(db, instance, node, { actor });
      } else {
        await blockTokenAsync(db, token, "waiting_approval", { approval_rule_id: result.rule?.id ?? null, approvals: result.approvals.length });
      }
      return true;
    }
    case "decision": {
      const edge = await chooseTransitionAsync(db, node, context);
      await completeTokenAsync(db, token, "decision", { chosen_transition_id: edge?.id ?? null, chosen_to: edge?.to_node_id ?? null });
      if (edge) await activateOutgoingAsync(db, instance, node, { actor, onlyTransition: edge });
      return true;
    }
    case "parallel": {
      await completeTokenAsync(db, token, "split");
      await activateOutgoingAsync(db, instance, node, { actor });
      return true;
    }
    case "join": {
      await blockTokenAsync(db, token, "waiting_join");
      return true;
    }
    case "notification": {
      const recipients = Array.isArray(config.recipients) ? config.recipients : [];
      for (const recipient of recipients) {
        await dispatchAsync(db, {
          instance,
          channel: config.channel || "in_app",
          recipientType: recipient.recipient_type || "user",
          recipientId: recipient.recipient_id ?? null,
          recipientRef: recipient.recipient_ref || recipient.username || "",
          subject: config.subject || node.name,
          body: config.body || config.message || "",
          payload: context,
          tenantId: instance.tenant_id,
        });
      }
      await recordEventAsync(db, {
        instanceId: instance.id,
        nodeKey: node.node_key,
        eventType: "notification.sent",
        actorId: actor?.id ?? null,
        message: `Notification node "${node.name}" processed`,
        details: { recipients: recipients.length },
        tenantId: instance.tenant_id,
      });
      await completeTokenAsync(db, token, "notified");
      await activateOutgoingAsync(db, instance, node, { actor });
      return true;
    }
    case "service": {
      const handlerName = config.handler;
      const handler = handlerName ? serviceHandler(handlerName) : null;
      let output = { handled: false, handler: handlerName || null };
      if (handler) {
        output = handler({ db, instance, node, config, context, actor }) || { handled: true };
      } else if (handlerName) {
        output = { handled: false, handler: handlerName, warning: "No service handler registered" };
      }
      await recordEventAsync(db, {
        instanceId: instance.id,
        nodeKey: node.node_key,
        eventType: "service.executed",
        actorId: actor?.id ?? null,
        message: `Service node "${node.name}" executed`,
        details: output,
        tenantId: instance.tenant_id,
      });
      await completeTokenAsync(db, token, "serviced", { output });
      await activateOutgoingAsync(db, instance, node, { actor });
      return true;
    }
    case "timer": {
      const dueAt = resolveDueAt(config, context);
      await blockTokenAsync(db, token, "waiting_timer", { due_at: dueAt });
      return true;
    }
    case "subprocess": {
      const child = await startSubprocessAsync(db, instance, node, context, actor);
      await blockTokenAsync(db, token, "waiting_subprocess", { child_instance_id: child.id });
      return true;
    }
    case "terminate": {
      await cancelInstanceAsync(db, instance.id, { reason: `Terminated at node ${node.node_key}`, actor, ip, skipAdvance: true });
      return true;
    }
    default: {
      await completeTokenAsync(db, token, "skipped");
      await activateOutgoingAsync(db, instance, node, { actor });
      return true;
    }
  }
}

async function taskCompletedAsync(db, taskId) {
  const row = await queryOneAsync(db, "SELECT status FROM workflow_tasks WHERE id = ?", [Number(taskId)]);
  return row && row.status === "completed";
}

async function joinReadyAsync(db, instance, token) {
  const node = await getNodeRowAsync(db, token.node_id);
  if (!node) return true;
  const incoming = await queryAllAsync(db, "SELECT * FROM workflow_transitions WHERE to_node_id = ?", [node.id]);
  if (!incoming.length) return true;
  const sources = incoming.map((edge) => edge.from_node_id);
  const completed = new Set(
    (
      await queryAllAsync(db, "SELECT DISTINCT node_id FROM workflow_instance_nodes WHERE instance_id = ? AND status = 'completed'", [instance.id])
    ).map((row) => row.node_id)
  );
  const allArrived = sources.every((sourceId) => completed.has(sourceId));
  if (allArrived) return true;
  const inFlight = (
    await queryOneAsync(
      db,
      "SELECT COUNT(*) AS c FROM workflow_instance_nodes WHERE instance_id = ? AND status IN ('active','blocked') AND id <> ?",
      [instance.id, token.id]
    )
  ).c;
  const openWork = (
    await queryOneAsync(
      db,
      "SELECT COUNT(*) AS c FROM workflow_tasks WHERE instance_id = ? AND status IN ('unassigned','assigned','in_progress','blocked','awaiting_approval')",
      [instance.id]
    )
  ).c;
  const arrived = sources.filter((sourceId) => completed.has(sourceId)).length;
  if (inFlight === 0 && openWork === 0 && arrived > 0) return true;
  return false;
}

async function waitingApprovalResolvedAsync(db, instance, token) {
  const counts = await queryAllAsync(
    db,
    "SELECT status, COUNT(*) AS c FROM workflow_approvals WHERE instance_id = ? AND node_id = ? GROUP BY status",
    [instance.id, token.node_id]
  );
  const byStatus = Object.fromEntries(counts.map((row) => [row.status, row.c]));
  const pending = byStatus.pending || 0;
  const approved = byStatus.approved || 0;
  const rejected = byStatus.rejected || 0;
  const changes = byStatus.changes_requested || 0;
  if (pending > 0) return null;
  if (rejected > 0) return "rejected";
  if (approved > 0) return "approved";
  if (changes > 0) return "changes_requested";
  return null;
}

async function processBlockedTokenAsync(db, instance, token, { actor = null, ip = null } = {}) {
  const data = safeParse(token.data_json, {});
  const outcome = token.outcome;
  if (outcome === "waiting_task") {
    if (data.task_id && (await taskCompletedAsync(db, data.task_id))) {
      const node = await getNodeRowAsync(db, token.node_id);
      if (await hasConditionalBranchesAsync(db, node)) {
        const edge = await chooseTransitionAsync(db, node, instanceContext(db, instance, token));
        await completeTokenAsync(db, token, "task_completed", { task_id: data.task_id, chosen_transition_id: edge?.id ?? null });
        if (edge) await activateOutgoingAsync(db, instance, node, { actor, onlyTransition: edge });
      } else {
        await completeTokenAsync(db, token, "task_completed", { task_id: data.task_id });
        await activateOutgoingAsync(db, instance, node, { actor });
      }
      return true;
    }
    return false;
  }
  if (outcome === "waiting_approval") {
    const state = await waitingApprovalResolvedAsync(db, instance, token);
    if (state === "approved") {
      const node = await getNodeRowAsync(db, token.node_id);
      const edge = await approvalTransitionAsync(db, node, "approve");
      await completeTokenAsync(db, token, "approved", { chosen_transition_id: edge?.id ?? null });
      if (edge) await activateOutgoingAsync(db, instance, node, { actor, onlyTransition: edge });
      else await activateOutgoingAsync(db, instance, node, { actor });
      return true;
    }
    if (state === "rejected") {
      const node = await getNodeRowAsync(db, token.node_id);
      const edge = await approvalTransitionAsync(db, node, "reject");
      if (edge) {
        await completeTokenAsync(db, token, "rejected", { chosen_transition_id: edge.id });
        await activateOutgoingAsync(db, instance, node, { actor, onlyTransition: edge });
        return true;
      }
    }
    return false;
  }
  if (outcome === "waiting_timer") {
    const dueAt = data.due_at ? String(data.due_at) : null;
    if (dueAt && dueAt <= nowIso()) {
      await completeTokenAsync(db, token, "timer_elapsed");
      const node = await getNodeRowAsync(db, token.node_id);
      await activateOutgoingAsync(db, instance, node, { actor });
      return true;
    }
    return false;
  }
  if (outcome === "waiting_subprocess") {
    const child = data.child_instance_id
      ? await queryOneAsync(db, "SELECT status FROM workflow_instances WHERE id = ?", [Number(data.child_instance_id)])
      : null;
    if (child && ["completed", "cancelled", "failed"].includes(child.status)) {
      await completeTokenAsync(db, token, `subprocess_${child.status}`);
      const node = await getNodeRowAsync(db, token.node_id);
      await activateOutgoingAsync(db, instance, node, { actor });
      return true;
    }
    return false;
  }
  if (outcome === "waiting_join") {
    if (await joinReadyAsync(db, instance, token)) {
      await completeTokenAsync(db, token, "joined");
      const node = await getNodeRowAsync(db, token.node_id);
      await activateOutgoingAsync(db, instance, node, { actor });
      return true;
    }
    return false;
  }
  await runAsync(db, "UPDATE workflow_instance_nodes SET status = 'active', updated_at = ? WHERE id = ?", [nowIso(), token.id]);
  return true;
}

async function maybeCompleteInstanceAsync(db, instance, { actor = null } = {}) {
  const fresh = await queryOneAsync(db, "SELECT * FROM workflow_instances WHERE id = ?", [instance.id]);
  if (!fresh || ["completed", "cancelled", "failed"].includes(fresh.status)) return fresh;
  const open = (
    await queryOneAsync(
      db,
      "SELECT COUNT(*) AS c FROM workflow_instance_nodes WHERE instance_id = ? AND status IN ('active','blocked')",
      [instance.id]
    )
  ).c;
  const openTasks = (
    await queryOneAsync(
      db,
      "SELECT COUNT(*) AS c FROM workflow_tasks WHERE instance_id = ? AND status IN ('unassigned','assigned','in_progress','blocked','awaiting_approval')",
      [instance.id]
    )
  ).c;
  const openApprovals = (
    await queryOneAsync(db, "SELECT COUNT(*) AS c FROM workflow_approvals WHERE instance_id = ? AND status = 'pending'", [instance.id])
  ).c;
  if (open === 0 && openTasks === 0 && openApprovals === 0) {
    const ts = nowIso();
    await runAsync(db, "UPDATE workflow_instances SET status = 'completed', ended_at = ?, updated_at = ? WHERE id = ?", [ts, ts, instance.id]);
    await recordEventAsync(db, {
      instanceId: instance.id,
      eventType: "workflow.completed",
      actorId: actor?.id ?? null,
      message: "Workflow completed",
      tenantId: instance.tenant_id,
    });
    await emitDomainEventAsync(
      db,
      {
        event_type_code: "WorkflowCompleted",
        source_module: "workflow",
        source_object_type: "workflow_instance",
        source_object_id: String(instance.id),
        tenant_id: Number(instance.tenant_id),
        organization_id: fresh.organization_id ?? null,
        payload: {
          instance_id: instance.id,
          instance_code: fresh.code,
          definition_id: fresh.definition_id,
          object_id: fresh.object_id ?? null,
          title: fresh.title,
          status: "completed",
        },
        idempotency_key: `workflow:completed:${instance.id}`,
      },
      actor
    );
    await notifyParentAsync(db, instance.id, "completed", actor);
    return queryOneAsync(db, "SELECT * FROM workflow_instances WHERE id = ?", [instance.id]);
  }
  return fresh;
}

async function notifyParentAsync(db, childId, outcome, actor) {
  const child = await queryOneAsync(db, "SELECT * FROM workflow_instances WHERE id = ?", [childId]);
  if (child?.parent_instance_id) {
    await advanceAsync(db, child.parent_instance_id, { actor, outcome });
  }
}

export async function advanceAsync(db, instanceId, { actor = null, ip = null, taskId = null, outcome = null } = {}) {
  const instance = await queryOneAsync(db, "SELECT * FROM workflow_instances WHERE id = ?", [Number(instanceId)]);
  if (!instance) throw new HttpError(404, "Workflow instance not found");
  if (["completed", "cancelled", "failed"].includes(instance.status)) return getInstanceAsync(db, instance.id, instance.tenant_id, { includeDetail: false });
  if (instance.status === "paused") return getInstanceAsync(db, instance.id, instance.tenant_id, { includeDetail: false });
  if (instance.status === "pending") {
    await runAsync(db, "UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?", [nowIso(), instance.id]);
  }
  let progressed = true;
  let steps = 0;
  while (progressed && steps < MAX_STEPS) {
    progressed = false;
    steps += 1;
    const tokens = await queryAllAsync(
      db,
      "SELECT * FROM workflow_instance_nodes WHERE instance_id = ? AND status IN ('active','blocked') ORDER BY id",
      [instance.id]
    );
    for (const token of tokens) {
      let changed = false;
      if (token.status === "active") changed = await processActiveTokenAsync(db, instance, token, { actor, ip });
      else changed = await processBlockedTokenAsync(db, instance, token, { actor, ip });
      if (changed) progressed = true;
    }
  }
  await maybeCompleteInstanceAsync(db, instance, { actor });
  return getInstanceAsync(db, instance.id, instance.tenant_id, { includeDetail: false });
}

export async function pauseInstanceAsync(db, id, body = {}, actor = null, tenantId = null, ip = null) {
  const instance = await getInstanceRowAsync(db, id);
  assertReadable(instance, tenantId, "Workflow instance not found");
  if (!["running", "pending"].includes(instance.status)) throw new HttpError(409, `Cannot pause a ${instance.status} workflow`);
  await runAsync(db, "UPDATE workflow_instances SET status = 'paused', updated_at = ? WHERE id = ?", [nowIso(), instance.id]);
  await recordEventAsync(db, { instanceId: instance.id, eventType: "workflow.paused", actorId: actor?.id ?? null, message: body.reason || "Workflow paused", tenantId: instance.tenant_id });
  await writeAuditAsync(db, { actor, action: "workflow.instance.pause", resourceType: "workflow_instance", resourceId: instance.id, ip });
  return getInstanceAsync(db, instance.id, tenantId);
}

export async function resumeInstanceAsync(db, id, body = {}, actor = null, tenantId = null, ip = null) {
  const instance = await getInstanceRowAsync(db, id);
  assertReadable(instance, tenantId, "Workflow instance not found");
  if (instance.status !== "paused") throw new HttpError(409, "Only a paused workflow can be resumed");
  await runAsync(db, "UPDATE workflow_instances SET status = 'running', updated_at = ? WHERE id = ?", [nowIso(), instance.id]);
  await recordEventAsync(db, { instanceId: instance.id, eventType: "workflow.resumed", actorId: actor?.id ?? null, message: body.reason || "Workflow resumed", tenantId: instance.tenant_id });
  await writeAuditAsync(db, { actor, action: "workflow.instance.resume", resourceType: "workflow_instance", resourceId: instance.id, ip });
  await advanceAsync(db, instance.id, { actor, ip });
  return getInstanceAsync(db, instance.id, tenantId);
}

export async function cancelInstanceAsync(db, id, { reason = "", actor = null, ip = null, skipAdvance = false } = {}) {
  const instance = await queryOneAsync(db, "SELECT * FROM workflow_instances WHERE id = ?", [Number(id)]);
  if (!instance) throw new HttpError(404, "Workflow instance not found");
  if (["completed", "cancelled"].includes(instance.status)) return getInstanceAsync(db, instance.id, instance.tenant_id);
  const ts = nowIso();
  await transactionAsync(db, async () => {
    await runAsync(db, "UPDATE workflow_instances SET status = 'cancelled', ended_at = ?, updated_at = ? WHERE id = ?", [ts, ts, instance.id]);
    await runAsync(db, "UPDATE workflow_instance_nodes SET status = 'cancelled', completed_at = ?, updated_at = ? WHERE instance_id = ? AND status IN ('active','blocked')", [
      ts,
      ts,
      instance.id,
    ]);
    await runAsync(db, "UPDATE workflow_tasks SET status = 'cancelled', updated_at = ? WHERE instance_id = ? AND status IN ('unassigned','assigned','in_progress','blocked','awaiting_approval')", [
      ts,
      instance.id,
    ]);
    await runAsync(db, "UPDATE workflow_approvals SET status = 'cancelled', updated_at = ? WHERE instance_id = ? AND status = 'pending'", [ts, instance.id]);
  });
  await recordEventAsync(db, { instanceId: instance.id, eventType: "workflow.cancelled", actorId: actor?.id ?? null, message: reason || "Workflow cancelled", tenantId: instance.tenant_id });
  await writeAuditAsync(db, { actor, action: "workflow.instance.cancel", resourceType: "workflow_instance", resourceId: instance.id, details: { reason }, ip });
  if (!skipAdvance) await notifyParentAsync(db, instance.id, "cancelled", actor);
  return getInstanceAsync(db, instance.id, instance.tenant_id);
}

export async function retryInstanceAsync(db, id, body = {}, actor = null, tenantId = null, ip = null) {
  const instance = await getInstanceRowAsync(db, id);
  assertReadable(instance, tenantId, "Workflow instance not found");
  if (!["failed", "paused"].includes(instance.status)) throw new HttpError(409, "Only a failed or paused workflow can be retried");
  const ts = nowIso();
  await transactionAsync(db, async () => {
    await runAsync(db, "UPDATE workflow_instances SET status = 'running', ended_at = NULL, updated_at = ? WHERE id = ?", [ts, instance.id]);
    await runAsync(
      db,
      "UPDATE workflow_instance_nodes SET status = 'active', completed_at = NULL, updated_at = ? WHERE instance_id = ? AND status IN ('failed','blocked')",
      [ts, instance.id]
    );
    await runAsync(db, "UPDATE workflow_approvals SET status = 'pending', updated_at = ? WHERE instance_id = ? AND status = 'changes_requested'", [ts, instance.id]);
  });
  await recordEventAsync(db, { instanceId: instance.id, eventType: "workflow.retried", actorId: actor?.id ?? null, message: body.reason || "Workflow retried", tenantId: instance.tenant_id });
  await writeAuditAsync(db, { actor, action: "workflow.instance.retry", resourceType: "workflow_instance", resourceId: instance.id, ip });
  await advanceAsync(db, instance.id, { actor, ip });
  return getInstanceAsync(db, instance.id, tenantId);
}
