import { safeParse } from "./validation.js";
import { usersForAssignee } from "./routing.js";
import { triggerEvent } from "./bindings.js";
import { registerWorkflowExecutor } from "../lifecycle/workflow.js";

// Bridge between the Workflow Engine and the Lifecycle Management module.
// Lifecycle owns release/approval rules and status transitions; the engine owns
// orchestration. Registering here means lifecycle delegates approval completion
// to the engine without either module duplicating the other's logic.

const RELEASE_EVENTS = {
  approved: "lifecycle.release.approved",
  rejected: "lifecycle.release.rejected",
  changes_requested: "lifecycle.release.request_changes",
};

// Resolves approvers for a lifecycle step. Extends the built-in resolver with
// groups and queues while preserving role/user/organization semantics.
export function resolveLifecycleApprovers(db, { step, object, tenantId }) {
  const organizationId = Number(object?.organization_id) || 0;
  const approverType = step?.approver_type || "role";
  return usersForAssignee(
    db,
    { assignee_type: approverType, assignee_id: step?.approver_id, assignee_ref: step?.approver_code },
    tenantId,
    organizationId
  );
}

export function onLifecycleApprovalComplete(db, { release, object, rule } = {}) {
  if (!release || !release.tenant_id) return { delegated: true, started: [] };
  const event = RELEASE_EVENTS[release.status];
  if (!event) return { delegated: true, started: [] };
  const payload = {
    tenant_id: release.tenant_id,
    object_id: object?.id ?? release.object_id ?? null,
    object_code: object?.code ?? null,
    organization_id: object?.organization_id ?? null,
    release_id: release.id,
    release_status: release.status,
    rule_code: rule?.code ?? null,
    transition_id: release.transition_id ?? null,
    from_state_id: release.from_state_id ?? null,
    to_state_id: release.to_state_id ?? null,
    title: `${object?.code ?? "Object"} release ${release.status}`,
  };
  const result = triggerEvent(db, event, payload, { tenantId: release.tenant_id });
  return { delegated: true, ...result };
}

export function lifecycleExecutor() {
  return {
    resolveApprovers: resolveLifecycleApprovers,
    startApproval: () => ({ delegated: true }),
    onApprovalComplete: onLifecycleApprovalComplete,
  };
}

// Called once when the workflow module is loaded.
export function registerLifecycleExecutor() {
  return registerWorkflowExecutor(lifecycleExecutor());
}

export { safeParse };
