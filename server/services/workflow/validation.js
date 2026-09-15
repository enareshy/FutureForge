import { HttpError } from "../../validation.js";
import { evaluate as evaluateExpression } from "../metadata/expression.js";

// Vocabulary and graph validation for the Workflow & Process Engine. Kept
// deliberately declarative so the designer, API and engine all agree on the
// same rules without duplicating them.

export const NODE_TYPES = [
  "start",
  "end",
  "task",
  "approval",
  "decision",
  "parallel",
  "join",
  "notification",
  "timer",
  "subprocess",
  "service",
  "terminate",
];

export const NODE_TYPE_LABELS = {
  start: "Start",
  end: "End",
  task: "Task",
  approval: "Approval",
  decision: "Decision",
  parallel: "Parallel split",
  join: "Join",
  notification: "Notification",
  timer: "Timer",
  subprocess: "Subprocess",
  service: "Service",
  terminate: "Terminate",
};

export const WORKFLOW_STATUSES = ["draft", "published", "inactive", "archived"];
export const VERSION_STATUSES = ["draft", "published", "archived"];
export const INSTANCE_STATUSES = ["pending", "running", "paused", "completed", "cancelled", "failed"];
export const INSTANCE_NODE_STATUSES = ["pending", "active", "blocked", "completed", "skipped", "failed", "cancelled"];
export const TASK_STATUSES = ["unassigned", "assigned", "in_progress", "blocked", "awaiting_approval", "completed", "cancelled"];
export const TASK_OPEN_STATUSES = ["unassigned", "assigned", "in_progress", "blocked", "awaiting_approval"];
export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"];
export const ASSIGNEE_TYPES = ["unassigned", "user", "role", "organization", "group", "queue"];
export const ROUTING_ASSIGNEE_TYPES = ["user", "role", "organization", "group", "queue"];
export const ROUTING_STRATEGIES = ["first_match", "round_robin", "least_loaded"];
export const APPROVAL_STATUSES = ["pending", "approved", "rejected", "changes_requested", "cancelled", "skipped"];
export const APPROVAL_DECISIONS = ["approve", "reject", "request_changes"];
export const ESCALATION_ACTIONS = ["notify", "reassign", "raise_priority", "escalate"];
export const NOTIFICATION_CHANNELS = ["in_app", "email", "webhook"];
export const NOTIFICATION_STATUSES = ["pending", "sent", "failed", "read"];
export const NOTIFICATION_EVENTS = [
  "workflow.started",
  "workflow.completed",
  "workflow.cancelled",
  "task.assigned",
  "task.completed",
  "task.escalated",
  "approval.requested",
  "approval.approved",
  "approval.rejected",
  "lifecycle.release.approved",
  "lifecycle.release.rejected",
  "lifecycle.release.request_changes",
  "object.created",
];
export const BINDING_EVENTS = [
  "lifecycle.release.approved",
  "lifecycle.release.rejected",
  "lifecycle.release.request_changes",
  "object.created",
  "workflow.completed",
  "manual",
];

// Node types that can block the engine until something external happens.
export const BLOCKING_NODE_TYPES = ["task", "approval", "timer", "subprocess", "join"];
export const AUTO_NODE_TYPES = ["start", "end", "notification", "service", "terminate"];

export function safeParse(raw, fallback = null) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function jsonText(value, fallback = {}) {
  if (value === undefined || value === null) return JSON.stringify(fallback);
  if (typeof value === "string") {
    const parsed = safeParse(value, undefined);
    return JSON.stringify(parsed === undefined ? fallback : parsed);
  }
  return JSON.stringify(value);
}

export function slugifyKey(prefix, value, fallback) {
  const base = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const text = base || fallback || prefix;
  return `${prefix}-${text}`.slice(0, 64);
}

export function conditionToExpression(condition) {
  if (!condition || typeof condition !== "object") return null;
  if (condition.expression !== undefined) return condition.expression;
  if (condition.op) return condition;
  if (Array.isArray(condition.all)) {
    return { op: "and", args: condition.all.map((c) => conditionToExpression(c) || { op: "literal", value: true }) };
  }
  if (Array.isArray(condition.any)) {
    return { op: "or", args: condition.any.map((c) => conditionToExpression(c) || { op: "literal", value: true }) };
  }
  if (condition.not !== undefined) {
    return { op: "not", args: [conditionToExpression(condition.not) || { op: "literal", value: true }] };
  }
  if (condition.field !== undefined) {
    const operator = condition.operator || condition.op || "eq";
    const expression = { op: operator, left: { op: "value", path: String(condition.field) } };
    if (condition.value !== undefined) expression.right = { op: "literal", value: condition.value };
    return expression;
  }
  return null;
}

export function evaluateCondition(condition, context) {
  const expression = conditionToExpression(condition);
  if (!expression) return true;
  return Boolean(evaluateExpression(expression, context));
}

// ---------------------------------------------------------------------------
// Graph validation
// ---------------------------------------------------------------------------

export function nodeConfigOf(node) {
  if (node?.config !== undefined && node.config !== null) return typeof node.config === "object" ? node.config : safeParse(node.config, {});
  return safeParse(node?.config_json, {});
}

export function edgeConditionOf(edge) {
  if (edge?.condition !== undefined && edge.condition !== null) return typeof edge.condition === "object" ? edge.condition : safeParse(edge.condition, {});
  return safeParse(edge?.condition_json, {});
}

export function isDefaultEdge(edge) {
  return edge?.is_default === 1 || edge?.is_default === true || edge?.default === true;
}

export function validateGraph({ nodes = [], transitions = [] } = {}) {
  const errors = [];
  const warnings = [];
  const byId = new Map();
  const byKey = new Map();
  for (const node of nodes) {
    if (byKey.has(node.node_key)) {
      errors.push(`Duplicate node key "${node.node_key}"`);
    }
    byId.set(node.id, node);
    byKey.set(node.node_key, node);
  }

  const starts = nodes.filter((n) => n.type === "start");
  if (starts.length === 0) errors.push("A workflow needs exactly one start node");
  if (starts.length > 1) errors.push("A workflow can only have one start node");
  const ends = nodes.filter((n) => n.type === "end");
  if (ends.length === 0) errors.push("A workflow needs at least one end node");

  const outgoing = new Map();
  const incoming = new Map();
  for (const node of nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  const edgeKeys = new Set();
  for (const edge of transitions) {
    if (edgeKeys.has(edge.transition_key)) errors.push(`Duplicate transition key "${edge.transition_key}"`);
    edgeKeys.add(edge.transition_key);
    const from = byId.get(edge.from_node_id);
    const to = byId.get(edge.to_node_id);
    if (!from) {
      errors.push(`Transition "${edge.transition_key}" has an unknown source node`);
      continue;
    }
    if (!to) {
      errors.push(`Transition "${edge.transition_key}" has an unknown target node`);
      continue;
    }
    if (from.type === "end") errors.push(`End node "${from.node_key}" cannot have outgoing transitions`);
    if (to.type === "start") errors.push(`Start node "${to.node_key}" cannot be a transition target`);
    outgoing.get(from.id)?.push(edge);
    incoming.get(to.id)?.push(edge);
  }

  for (const node of nodes) {
    const out = outgoing.get(node.id) || [];
    const inc = incoming.get(node.id) || [];
    if (node.type === "end") continue;
    if (node.type === "terminate") continue;
    if (out.length === 0) errors.push(`Node "${node.node_key}" is disconnected (no outgoing transition)`);
    if (node.type === "start") continue;
    if (inc.length === 0) errors.push(`Node "${node.node_key}" has no incoming transition`);
    if (node.type === "task") {
      if (out.length > 1) warnings.push(`Node "${node.node_key}" has multiple outgoing transitions; only the first will be followed by the default rule`);
    }
    if (node.type === "decision") {
      const config = nodeConfigOf(node);
      const hasDefault = out.some((e) => isDefaultEdge(e));
      const hasConditions = out.some((e) => {
        const c = edgeConditionOf(e);
        return c && Object.keys(c).length > 0;
      });
      if (!hasDefault && !hasConditions) errors.push(`Decision "${node.node_key}" needs a default branch or a conditional branch`);
    }
    if (node.type === "join" && inc.length < 2) {
      warnings.push(`Join "${node.node_key}" has fewer than two incoming branches`);
    }
    if (node.type === "parallel" && out.length < 2) {
      warnings.push(`Parallel split "${node.node_key}" has fewer than two outgoing branches`);
    }
    if (node.type === "subprocess") {
      const config = nodeConfigOf(node);
      if (!config.definition_id && !config.workflow_code) {
        errors.push(`Subprocess "${node.node_key}" requires a definition_id or workflow_code`);
      }
    }
    if (node.type === "approval") {
      const config = nodeConfigOf(node);
      if (!config.approval_rule_id && !config.approval_rule_code) {
        warnings.push(`Approval "${node.node_key}" has no approval rule; it will be auto-approved`);
      }
      const keys = new Set(out.map((e) => e.transition_key));
      for (const [field, label] of [
        ["approve_transition_key", "approve path"],
        ["reject_transition_key", "reject path"],
      ]) {
        if (config[field] && !keys.has(config[field])) {
          errors.push(`Approval "${node.node_key}" ${label} "${config[field]}" is not one of its outgoing transitions`);
        }
      }
      if (out.length > 1 && !config.approve_transition_key && !config.reject_transition_key) {
        warnings.push(`Approval "${node.node_key}" has multiple outgoing transitions; configure an approve and/or reject path`);
      }
    }
    if (node.type === "service" && !nodeConfigOf(node).handler) {
      warnings.push(`Service "${node.node_key}" has no handler configured`);
    }
  }

  // Reachability from the start node.
  if (starts.length === 1) {
    const seen = new Set();
    const queue = [starts[0].id];
    while (queue.length) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      for (const edge of outgoing.get(id) || []) queue.push(edge.to_node_id);
    }
    for (const node of nodes) {
      if (!seen.has(node.id)) warnings.push(`Node "${node.node_key}" is not reachable from the start node`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    stats: {
      nodes: nodes.length,
      transitions: transitions.length,
      tasks: nodes.filter((n) => n.type === "task").length,
      approvals: nodes.filter((n) => n.type === "approval").length,
      decisions: nodes.filter((n) => n.type === "decision").length,
    },
  };
}

export function assertValidGraph(graph) {
  const result = validateGraph(graph);
  if (!result.valid) {
    throw new HttpError(422, "Workflow graph is invalid", result);
  }
  return result;
}

export function assertNodeType(type) {
  if (!NODE_TYPES.includes(type)) {
    throw new HttpError(400, `Node type must be one of: ${NODE_TYPES.join(", ")}`);
  }
}

export function normalizeNodeConfig(type, config) {
  const value = config && typeof config === "object" ? { ...config } : {};
  if (type === "task" || type === "approval") {
    if (!value.assignee_type) value.assignee_type = "role";
  }
  return value;
}

// ---------------------------------------------------------------------------
// Auto layout: deterministic layered placement.
// ---------------------------------------------------------------------------

export function autoLayout(nodes = [], transitions = [], options = {}) {
  const columnWidth = options.columnWidth ?? 260;
  const rowHeight = options.rowHeight ?? 130;
  const marginX = options.marginX ?? 80;
  const marginY = options.marginY ?? 80;
  const depth = new Map();
  const incoming = new Map();
  const outgoing = new Map();
  for (const node of nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of transitions) {
    outgoing.get(edge.from_node_id)?.push(edge.to_node_id);
    incoming.get(edge.to_node_id)?.push(edge.from_node_id);
  }
  const starts = nodes.filter((n) => n.type === "start");
  const queue = starts.length ? starts.map((n) => n.id) : nodes.slice(0, 1).map((n) => n.id);
  for (const id of queue) depth.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    for (const next of outgoing.get(id) || []) {
      const candidate = (depth.get(id) ?? 0) + 1;
      if (!depth.has(next) || candidate > depth.get(next)) {
        depth.set(next, candidate);
        queue.push(next);
      }
    }
  }
  const columns = new Map();
  const positioned = [];
  for (const node of nodes) {
    const d = depth.has(node.id) ? depth.get(node.id) : 0;
    const list = columns.get(d) || [];
    list.push(node);
    columns.set(d, list);
  }
  for (const [d, list] of [...columns.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0) || a.id - b.id);
    list.forEach((node, index) => {
      positioned.push({
        id: node.id,
        node_key: node.node_key,
        position_x: marginX + d * columnWidth,
        position_y: marginY + index * rowHeight,
      });
    });
  }
  return positioned;
}

export function publicGraph(nodes, transitions) {
  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      node_key: node.node_key,
      type: node.type,
      name: node.name,
      description: node.description || "",
      config: safeParse(node.config_json, {}),
      position_x: node.position_x,
      position_y: node.position_y,
      display_order: node.display_order,
    })),
    transitions: transitions.map((edge) => ({
      id: edge.id,
      transition_key: edge.transition_key,
      from_node_id: edge.from_node_id,
      to_node_id: edge.to_node_id,
      name: edge.name || "",
      condition: safeParse(edge.condition_json, {}),
      is_default: edge.is_default === 1,
      display_order: edge.display_order,
    })),
  };
}
