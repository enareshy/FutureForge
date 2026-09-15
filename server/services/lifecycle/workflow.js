import { queryAll, queryOne } from "../../db.js";

// Workflow Engine integration contract. Helix does not yet ship a standalone
// workflow engine, so the default executor resolves approvers in-process and the
// approval evaluator in approvals.js performs the orchestration. If/when a
// general Workflow Engine is introduced it registers itself here and lifecycle
// delegates to it instead of re-implementing orchestration.

let executor = null;

export function registerWorkflowExecutor(impl) {
  executor = impl && typeof impl === "object" ? impl : null;
  return executor;
}

export function workflowExecutor() {
  return executor;
}

export function resolveApprovers(db, { step, object, tenantId }) {
  if (executor?.resolveApprovers) {
    return executor.resolveApprovers(db, { step, object, tenantId });
  }
  const orgId = Number(object?.organization_id) || 0;
  if (step.approver_type === "user") {
    const user = queryOne(
      "SELECT id, username FROM users WHERE id = ? AND status = 'active' AND (tenant_id = ? OR tenant_id IS NULL)",
      [Number(step.approver_id), Number(tenantId)]
    );
    return user ? [user] : [];
  }
  if (step.approver_type === "organization") {
    return queryAll(
      "SELECT id, username FROM users WHERE organization_id = ? AND status = 'active' AND tenant_id = ? ORDER BY username",
      [Number(step.approver_id), Number(tenantId)]
    );
  }
  return queryAll(
    db,
    `SELECT DISTINCT u.id, u.username FROM users u
      WHERE u.status = 'active' AND u.tenant_id = ?
        AND u.id IN (
          SELECT ur.user_id FROM user_roles ur
           WHERE ur.role_id IN (SELECT id FROM roles WHERE id = ? OR code = ?)
             AND (ur.organization_id = 0 OR ur.organization_id = ?)
          UNION
          SELECT gm.user_id FROM group_members gm
            JOIN group_roles gr ON gr.group_id = gm.group_id
           WHERE gr.role_id IN (SELECT id FROM roles WHERE id = ? OR code = ?)
             AND (gr.organization_id = 0 OR gr.organization_id = ?)
        )
      ORDER BY u.username`,
    [
      Number(tenantId),
      Number(step.approver_id) || 0,
      String(step.approver_id ?? ""),
      orgId,
      Number(step.approver_id) || 0,
      String(step.approver_id ?? ""),
      orgId,
    ]
  );
}

export function startApproval() {
  if (executor?.startApproval) return executor.startApproval(...arguments);
  return { delegated: false };
}

export function onApprovalComplete() {
  if (executor?.onApprovalComplete) return executor.onApprovalComplete(...arguments);
  return { delegated: false };
}
