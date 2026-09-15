import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { assertReadable } from "../metadata/scope.js";
import { APPROVAL_DECISIONS, safeParse } from "./validation.js";
import { recordEvent } from "./events.js";
import { usersForAssignee } from "./routing.js";
import { stepsFor } from "../lifecycle/approvals.js";
import { dispatch } from "./notifications.js";
import { advance } from "./engine.js";

// Approval nodes. Approver definitions are the same lifecycle `approval_rules`
// and `approval_rule_steps` used by release approval, so there is a single
// source of truth for who approves what.

export function publicApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    instance_id: row.instance_id,
    task_id: row.task_id ?? null,
    node_id: row.node_id ?? null,
    node_key: row.node_key,
    approval_rule_id: row.approval_rule_id ?? null,
    step_id: row.step_id ?? null,
    step_code: row.step_code || "",
    sequence: row.sequence,
    parallel: row.parallel === 1,
    approver_type: row.approver_type || "",
    approver_id: row.approver_id ?? null,
    approver_username: row.approver_username ?? null,
    status: row.status,
    decided_by: row.decided_by ?? null,
    decided_username: row.decided_username ?? null,
    decided_at: row.decided_at || null,
    comment: row.comment || "",
    tenant_id: row.tenant_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const APPROVAL_SELECT = `
  SELECT a.*, u.username AS approver_username, du.username AS decided_username
  FROM workflow_approvals a
  LEFT JOIN users u ON u.id = a.approver_id
  LEFT JOIN users du ON du.id = a.decided_by
`;

export function getRuleRow(db, id) {
  return queryOne(db, "SELECT * FROM approval_rules WHERE id = ?", [Number(id)]);
}

export function resolveApprovalRule(db, { ruleId, ruleCode }, tenantId) {
  if (ruleId) {
    const row = getRuleRow(db, ruleId);
    if (row) return row;
  }
  if (ruleCode) {
    return queryOne(
      db,
      `SELECT * FROM approval_rules WHERE code = ? AND status = 'active' AND (tenant_id IS NULL OR tenant_id = ?) ORDER BY tenant_id IS NULL LIMIT 1`,
      [String(ruleCode), Number(tenantId ?? 0)]
    );
  }
  return null;
}

// Creates one approval row per resolved approver for an approval node.
export function createApprovalsForNode(db, { instance, instanceNode, node, actor = null }) {
  const config = safeParse(node.config_json, {});
  const rule = resolveApprovalRule(db, { ruleId: config.approval_rule_id, ruleCode: config.approval_rule_code }, instance.tenant_id);
  if (!rule) {
    return { rule: null, approvals: [], auto: true };
  }
  const steps = stepsFor(db, rule.id);
  if (!steps.length) {
    return { rule, approvals: [], auto: true };
  }
  const ts = nowIso();
  const created = [];
  for (const step of steps) {
    const approvers = usersForAssignee(
      db,
      { assignee_type: step.approver_type, assignee_id: step.approver_id },
      instance.tenant_id,
      instance.organization_id || 0
    );
    if (!approvers.length) {
      throw new HttpError(409, `No eligible approvers resolved for approval step ${step.code}`);
    }
    for (const approver of approvers) {
      const result = run(
        db,
        `INSERT INTO workflow_approvals
          (instance_id, task_id, node_id, node_key, approval_rule_id, step_id, step_code, sequence, parallel,
           approver_type, approver_id, status, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [
          instance.id,
          null,
          node.id,
          node.node_key,
          rule.id,
          step.id,
          step.code,
          step.sequence,
          step.parallel ? 1 : 0,
          step.approver_type,
          approver.id,
          instance.tenant_id,
          ts,
          ts,
        ]
      );
      const row = queryOne(db, `${APPROVAL_SELECT} WHERE a.id = ?`, [result.lastInsertRowid]);
      created.push(row);
      dispatch(db, {
        instance,
        channel: "in_app",
        recipientType: "user",
        recipientId: approver.id,
        recipientRef: approver.username || "",
        subject: `Approval requested: ${instance.title}`,
        body: `A workflow approval step "${step.name}" needs your decision.`,
        payload: { approval_id: row.id, instance_id: instance.id, step: step.code },
        tenantId: instance.tenant_id,
      });
    }
  }
  recordEvent(db, {
    instanceId: instance.id,
    nodeKey: node.node_key,
    eventType: "approval.requested",
    actorId: actor?.id ?? null,
    message: `Approval requested for ${rule.code}`,
    details: { rule_id: rule.id, approvals: created.length },
    tenantId: instance.tenant_id,
  });
  return { rule, approvals: created, auto: false };
}

function evaluateCompletion(db, rule, instanceNodeId, instanceId, nodeId) {
  if (!rule) return true;
  const steps = stepsFor(db, rule.id);
  for (const step of steps) {
    const rows = queryAll(
      db,
      "SELECT status FROM workflow_approvals WHERE instance_id = ? AND node_id = ? AND step_code = ?",
      [instanceId, nodeId, step.code]
    );
    if (!rows.length) continue;
    const approved = rows.filter((r) => r.status === "approved").length;
    if (step.approval_mode === "any") {
      if (approved < 1) return false;
    } else if (step.approval_mode === "min") {
      if (approved < Math.max(1, step.min_approvals)) return false;
    } else if (!rows.every((r) => r.status === "approved")) {
      return false;
    }
  }
  const total = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM workflow_approvals WHERE instance_id = ? AND node_id = ? AND status = 'approved'",
    [instanceId, nodeId]
  ).c;
  return total >= Math.max(1, Number(rule.min_approvals) || 1);
}

function assertStepOpen(db, rule, instanceId, nodeId, approval) {
  if (rule?.sequential !== 1) return;
  const steps = stepsFor(db, rule.id);
  for (const step of steps) {
    if (step.sequence === approval.sequence) return;
    const rows = queryAll(db, "SELECT status FROM workflow_approvals WHERE instance_id = ? AND node_id = ? AND step_code = ?", [
      instanceId,
      nodeId,
      step.code,
    ]);
    if (!rows.length) continue;
    const approved = rows.filter((r) => r.status === "approved").length;
    const satisfied =
      step.approval_mode === "any" ? approved >= 1 : step.approval_mode === "min" ? approved >= Math.max(1, step.min_approvals) : rows.every((r) => r.status === "approved");
    if (!satisfied) throw new HttpError(409, "A previous approval step is still pending", { blocked_by: step.code });
  }
}

export function getApprovalRow(db, id) {
  return queryOne(db, `${APPROVAL_SELECT} WHERE a.id = ?`, [Number(id)]);
}

export function listApprovals(db, query = {}, tenantId, actor, { scope = "mine" } = {}) {
  const { page, pageSize, offset } = pagination(query);
  const where = ["a.tenant_id = ?"];
  const params = [Number(tenantId)];
  if (scope === "mine" && actor) {
    where.push(
      `(a.approver_id = ? OR a.approver_id IN (
          SELECT from_user_id FROM workflow_delegations
           WHERE to_user_id = ? AND status = 'active'
             AND (starts_at IS NULL OR starts_at <= datetime('now'))
             AND (ends_at IS NULL OR ends_at >= datetime('now'))))`
    );
    params.push(actor.id, actor.id);
  }
  if (query.status) {
    where.push("a.status = ?");
    params.push(query.status);
  } else if (scope === "mine") {
    where.push("a.status = 'pending'");
  }
  if (query.instanceId || query.instance_id) {
    where.push("a.instance_id = ?");
    params.push(Number(query.instanceId || query.instance_id));
  }
  if (query.nodeKey || query.node_key) {
    where.push("a.node_key = ?");
    params.push(String(query.nodeKey || query.node_key));
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM workflow_approvals a ${clause}`, params).c;
  const items = queryAll(db, `${APPROVAL_SELECT} ${clause} ORDER BY a.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]).map(
    publicApproval
  );
  return { items, total, page, pageSize, scope };
}

export function getApproval(db, id, tenantId, actor) {
  const row = getApprovalRow(db, id);
  assertReadable(row, tenantId, "Approval not found");
  const approval = publicApproval(row);
  const instance = queryOne(db, "SELECT * FROM workflow_instances WHERE id = ?", [row.instance_id]);
  if (instance) {
    approval.instance = {
      id: instance.id,
      code: instance.code,
      title: instance.title,
      status: instance.status,
      definition_id: instance.definition_id,
      version_id: instance.version_id,
      object_id: instance.object_id ?? null,
    };
  }
  approval.step = row.step_id ? queryOne(db, "SELECT * FROM approval_rule_steps WHERE id = ?", [row.step_id]) : null;
  approval.rule = row.approval_rule_id ? getRuleRow(db, row.approval_rule_id) : null;
  return approval;
}

export function decideApproval(db, id, body = {}, actor = null, tenantId = null, ip = null) {
  const approval = getApprovalRow(db, id);
  assertReadable(approval, tenantId, "Approval not found");
  const decision = body.decision;
  if (!APPROVAL_DECISIONS.includes(decision)) {
    throw new HttpError(400, `decision must be one of: ${APPROVAL_DECISIONS.join(", ")}`);
  }
  const rule = approval.approval_rule_id ? getRuleRow(db, approval.approval_rule_id) : null;
  const comment = String(body.comment ?? body.comments ?? "").trim();
  const isAdmin = actor?.is_platform_admin === true;
  if (approval.approver_id && !isAdmin && Number(approval.approver_id) !== Number(actor?.id)) {
    throw new HttpError(403, "You are not the assigned approver for this step");
  }
  if (approval.status !== "pending") throw new HttpError(409, `Approval is already ${approval.status}`);
  assertStepOpen(db, rule, approval.instance_id, approval.node_id, approval);

  const instanceNode = queryOne(
    db,
    "SELECT * FROM workflow_instance_nodes WHERE instance_id = ? AND node_id = ? ORDER BY id DESC LIMIT 1",
    [approval.instance_id, approval.node_id]
  );
  const instance = queryOne(db, "SELECT * FROM workflow_instances WHERE id = ?", [approval.instance_id]);
  const ts = nowIso();
  const statusMap = { approve: "approved", reject: "rejected", request_changes: "changes_requested" };
  const nextStatus = statusMap[decision];
  if (decision === "reject" && rule?.mandatory_comment_on_reject === 1 && !comment) {
    throw new HttpError(400, "A comment is required when rejecting");
  }
  run(db, "UPDATE workflow_approvals SET status = ?, decided_by = ?, decided_at = ?, comment = ?, updated_at = ? WHERE id = ?", [
    nextStatus,
    actor?.id ?? null,
    ts,
    comment,
    ts,
    approval.id,
  ]);
  recordEvent(db, {
    instanceId: approval.instance_id,
    nodeKey: approval.node_key,
    eventType: nextStatus === "approved" ? "approval.approved" : nextStatus === "rejected" ? "approval.rejected" : "approval.changes_requested",
    actorId: actor?.id ?? null,
    message: `Approval step ${approval.step_code} ${nextStatus}`,
    details: { approval_id: approval.id, decision, comment },
    tenantId: approval.tenant_id,
  });
  writeAudit(db, { actor, action: `workflow.approval.${decision}`, resourceType: "workflow_approval", resourceId: approval.id, details: { instance_id: approval.instance_id, decision, comment }, ip });

  if (decision === "approve") {
    if (evaluateCompletion(db, rule, instanceNode?.id, approval.instance_id, approval.node_id)) {
      // The engine observes zero pending approvals and advances the token, so
      // we do not complete it here (that would bypass the outgoing transition).
      advance(db, approval.instance_id, { actor, ip });
    }
  } else if (decision === "reject" && rejectPathForNode(db, approval.node_id)) {
    // A reject path is configured on the approval node: leave the token blocked
    // so the engine routes it down the configured rejection branch instead of
    // failing the whole instance.
    advance(db, approval.instance_id, { actor, ip });
  } else {
    // A rejection or change request without a configured branch fails the
    // token; the instance is left for an operator to retry or cancel.
    if (instanceNode) {
      run(db, "UPDATE workflow_instance_nodes SET status = ?, outcome = ?, completed_at = ?, updated_at = ? WHERE id = ?", [
        decision === "reject" ? "failed" : "blocked",
        nextStatus,
        ts,
        ts,
        instanceNode.id,
      ]);
    }
    if (instance) {
      run(db, "UPDATE workflow_instances SET status = 'failed', updated_at = ? WHERE id = ?", [ts, instance.id]);
    }
  }
  return getApproval(db, approval.id, tenantId, actor);
}

// Resolves the configured rejection branch for an approval node, if any. Kept
// here so a decision only fails the instance when no reject path can be taken.
function rejectPathForNode(db, nodeId) {
  if (!nodeId) return null;
  const node = queryOne(db, "SELECT config_json FROM workflow_nodes WHERE id = ?", [Number(nodeId)]);
  const config = safeParse(node?.config_json, {});
  if (!config.reject_transition_key) return null;
  return queryOne(
    db,
    "SELECT id FROM workflow_transitions WHERE from_node_id = ? AND transition_key = ?",
    [Number(nodeId), String(config.reject_transition_key)]
  );
}
