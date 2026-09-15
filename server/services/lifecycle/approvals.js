import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { readTenant, writeTenant, tenantClause, assertReadable, assertMutable } from "../metadata/scope.js";
import * as metadata from "../metadata.js";
import * as tenants from "../tenants.js";
import { findObjectRow, getObjectRow, publicObject } from "../objects/repository.js";
import { getVersionRow, getTransitionRow, getStateRow } from "./definitions.js";
import { applyTransition, conditionContext, evaluateGuard } from "./apply.js";
import {
  APPROVAL_RULE_KINDS,
  APPROVER_TYPES,
  APPROVAL_MODES,
  APPROVAL_DECISIONS,
  safeParse,
} from "./validation.js";
import * as workflow from "./workflow.js";

// Release & approval engine. Rules are configuration bound to a lifecycle
// version and/or transition; releases and per-approver decisions are runtime
// data. The evaluator supports sequential/parallel steps, quorums, mandatory
// rejection comments, change requests/resubmission and automatic transitions.

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

function safeJson(raw) {
  return safeParse(raw, {});
}

export function publicStep(row) {
  if (!row) return null;
  return {
    id: row.id,
    rule_id: row.rule_id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    sequence: row.sequence,
    parallel: row.parallel === 1,
    approver_type: row.approver_type,
    approver_id: row.approver_id ?? null,
    approval_mode: row.approval_mode,
    min_approvals: row.min_approvals,
    conditions: safeParse(row.conditions_json, {}),
  };
}

export function publicRule(row, steps = null) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    kind: row.kind,
    module: row.module,
    lifecycle_version_id: row.lifecycle_version_id ?? null,
    transition_id: row.transition_id ?? null,
    transition_code: row.transition_code ?? null,
    require_all: row.require_all === 1,
    min_approvals: row.min_approvals,
    sequential: row.sequential === 1,
    allow_self_approval: row.allow_self_approval === 1,
    mandatory_comment_on_reject: row.mandatory_comment_on_reject === 1,
    conditions: safeParse(row.conditions_json, {}),
    auto_transition: row.auto_transition === 1,
    rollback_state_id: row.rollback_state_id ?? null,
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    is_system: row.is_system === 1,
    step_count: row.step_count ?? (steps ? steps.length : undefined),
    steps: steps || undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const RULE_SELECT = `
  SELECT r.*, t.code AS transition_code,
    (SELECT COUNT(*) FROM approval_rule_steps s WHERE s.rule_id = r.id) AS step_count
  FROM approval_rules r
  LEFT JOIN lifecycle_transitions t ON t.id = r.transition_id
`;

export function getRuleRow(db, id) {
  return queryOne(db, `${RULE_SELECT} WHERE r.id = ?`, [Number(id)]);
}

export function findRule(db, idOrCode, tenantId) {
  if (idOrCode === undefined || idOrCode === null || idOrCode === "") return null;
  const text = String(idOrCode);
  if (/^\d+$/.test(text)) {
    const byId = getRuleRow(db, Number(text));
    if (byId) {
      assertReadable(byId, tenantId, "Approval rule not found");
      return byId;
    }
  }
  const scope = tenantClause("r", tenantId);
  const byCode = queryOne(
    db,
    `${RULE_SELECT} WHERE r.code = ? AND ${scope.sql} ORDER BY r.tenant_id IS NULL LIMIT 1`,
    [text, ...scope.params]
  );
  if (!byCode) throw new HttpError(404, "Approval rule not found");
  return byCode;
}

export function getRule(db, idOrCode, tenantId) {
  const row = findRule(db, idOrCode, tenantId);
  return publicRule(row, stepsFor(db, row.id));
}

export function listRules(db, query = {}, tenantId) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause("r", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  const kind = query.kind;
  if (kind) {
    where.push("r.kind = ?");
    params.push(kind);
  }
  if (query.status) {
    where.push("r.status = ?");
    params.push(query.status);
  }
  if (query.lifecycleVersionId || query.lifecycle_version_id || query.versionId) {
    where.push("r.lifecycle_version_id = ?");
    params.push(Number(query.lifecycleVersionId || query.lifecycle_version_id || query.versionId));
  }
  if (query.transitionId || query.transition_id) {
    where.push("r.transition_id = ?");
    params.push(Number(query.transitionId || query.transition_id));
  }
  if (query.q) {
    where.push("(r.code LIKE ? OR r.name LIKE ? OR r.description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM approval_rules r ${clause}`, params).c;
  const items = queryAll(db, `${RULE_SELECT} ${clause} ORDER BY r.code LIMIT ? OFFSET ?`, [...params, pageSize, offset]).map(
    (row) => publicRule(row, stepsFor(db, row.id))
  );
  return { items, total, page, pageSize };
}

export function stepsFor(db, ruleId) {
  return queryAll(db, "SELECT * FROM approval_rule_steps WHERE rule_id = ? ORDER BY sequence, id", [Number(ruleId)]).map(publicStep);
}

function resolveBinding(db, body, tenantId, actor) {
  const transitionRef = body.transition_id ?? body.transitionId ?? body.transition;
  const versionRef = body.lifecycle_version_id ?? body.lifecycleVersionId ?? body.version_id ?? body.versionId;
  let transition = null;
  let version = null;
  if (transitionRef !== undefined && transitionRef !== null && transitionRef !== "") {
    const text = String(transitionRef);
    transition = /^\d+$/.test(text)
      ? getTransitionRow(db, Number(text))
      : queryOne(db, "SELECT * FROM lifecycle_transitions WHERE code = ?", [text]);
    if (!transition) throw new HttpError(400, "Transition not found");
    version = getVersionRow(db, transition.lifecycle_version_id);
  } else if (versionRef !== undefined && versionRef !== null && versionRef !== "") {
    version = getVersionRow(db, Number(versionRef));
    if (!version) throw new HttpError(400, "Lifecycle version not found");
  }
  return { transition, version };
}

function normalizeSteps(db, rawSteps, tenantId, actor, object, ruleId = null) {
  if (rawSteps === undefined) return null;
  if (!Array.isArray(rawSteps) || !rawSteps.length) throw new HttpError(400, "steps must be a non-empty array");
  const normalized = rawSteps.map((step, index) => {
    if (!step.code || !step.name) throw new HttpError(400, `steps[${index}] requires code and name`);
    validateCode(step.code, `Step ${index} code`);
    const approverType = step.approver_type || step.approverType || "role";
    if (!APPROVER_TYPES.includes(approverType)) {
      throw new HttpError(400, `steps[${index}].approver_type must be one of: ${APPROVER_TYPES.join(", ")}`);
    }
    const mode = step.approval_mode || step.approvalMode || "all";
    if (!APPROVAL_MODES.includes(mode)) {
      throw new HttpError(400, `steps[${index}].approval_mode must be one of: ${APPROVAL_MODES.join(", ")}`);
    }
    let approverId = step.approver_id ?? step.approverId ?? null;
    if (approverType === "role") {
      const role = queryOne(db, "SELECT id FROM roles WHERE code = ?", [String(approverId)]);
      if (role) approverId = role.id;
      else if (!approverId) throw new HttpError(400, `steps[${index}] requires a role approver`);
    } else if (approverType === "user") {
      const user = queryOne(db, "SELECT id FROM users WHERE id = ?", [Number(approverId)]);
      if (!user) throw new HttpError(400, `steps[${index}] approver user not found`);
    } else if (approverType === "organization") {
      const org = queryOne(db, "SELECT id FROM organizations WHERE id = ?", [Number(approverId)]);
      if (!org) throw new HttpError(400, `steps[${index}] approver organization not found`);
    }
    const minApprovals = Number(step.min_approvals ?? step.minApprovals ?? (mode === "min" ? 1 : 1)) || 1;
    return {
      code: step.code,
      name: String(step.name).trim(),
      description: step.description || "",
      sequence: Number(step.sequence ?? index) || 0,
      parallel: step.parallel ? 1 : 0,
      approver_type: approverType,
      approver_id: approverId,
      approval_mode: mode,
      min_approvals: Math.max(1, minApprovals),
      conditions_json: JSON.stringify(step.conditions && typeof step.conditions === "object" ? step.conditions : {}),
    };
  });
  return normalized;
}

function insertSteps(db, ruleId, steps) {
  for (const step of steps) {
    run(
      db,
      `INSERT INTO approval_rule_steps
        (rule_id, code, name, description, sequence, parallel, approver_type, approver_id, approval_mode, min_approvals, conditions_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ruleId, step.code, step.name, step.description, step.sequence, step.parallel, step.approver_type, step.approver_id, step.approval_mode, step.min_approvals, step.conditions_json, nowIso(), nowIso()]
    );
  }
}

export function createRule(db, body, actor, ip, reqTenantId) {
  requireFields(body, ["code", "name"]);
  validateCode(body.code, "Approval rule code");
  const tenantId = writeTenant(db, actor, body, reqTenantId);
  const kind = body.kind || "approval";
  if (!APPROVAL_RULE_KINDS.includes(kind)) {
    throw new HttpError(400, `kind must be one of: ${APPROVAL_RULE_KINDS.join(", ")}`);
  }
  const { transition, version } = resolveBinding(db, body, tenantId, actor);
  const steps = normalizeSteps(db, body.steps, tenantId, actor, null) || [];
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO approval_rules
        (code, name, description, kind, module, lifecycle_version_id, transition_id, require_all, min_approvals,
         sequential, allow_self_approval, mandatory_comment_on_reject, conditions_json, auto_transition,
         rollback_state_id, status, tenant_id, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.description || "",
        kind,
        body.module || "platform",
        version?.id ?? null,
        transition?.id ?? null,
        body.require_all || body.requireAll ? 1 : 0,
        Number(body.min_approvals ?? body.minApprovals ?? 1) || 1,
        body.sequential ? 1 : 0,
        body.allow_self_approval || body.allowSelfApproval ? 1 : 0,
        body.mandatory_comment_on_reject === undefined && body.mandatoryCommentOnReject === undefined
          ? 1
          : body.mandatory_comment_on_reject || body.mandatoryCommentOnReject
            ? 1
            : 0,
        JSON.stringify(body.conditions && typeof body.conditions === "object" ? body.conditions : {}),
        body.auto_transition === undefined && body.autoTransition === undefined
          ? 1
          : body.auto_transition || body.autoTransition
            ? 1
            : 0,
        body.rollback_state_id ?? body.rollbackStateId ?? null,
        body.status || "active",
        tenantId ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Approval rule code already exists in this scope");
    throw err;
  }
  insertSteps(db, result.lastInsertRowid, steps);
  writeAudit(db, {
    actor,
    action: "lifecycle.approval_rule.create",
    resourceType: "approval_rule",
    resourceId: result.lastInsertRowid,
    details: { code: body.code, kind, steps: steps.length },
    ip,
  });
  return getRule(db, result.lastInsertRowid, tenantId);
}

export function updateRule(db, id, body, actor, ip, tenantId) {
  const row = getRuleRow(db, id);
  assertMutable(db, row, tenantId, actor, "Approval rule not found");
  if (body.code && body.code !== row.code) validateCode(body.code, "Approval rule code");
  const kind = body.kind === undefined ? row.kind : body.kind;
  if (!APPROVAL_RULE_KINDS.includes(kind)) {
    throw new HttpError(400, `kind must be one of: ${APPROVAL_RULE_KINDS.join(", ")}`);
  }
  const bindingProvided = body.transition_id !== undefined || body.transitionId !== undefined || body.transition !== undefined ||
    body.lifecycle_version_id !== undefined || body.lifecycleVersionId !== undefined || body.version_id !== undefined || body.versionId !== undefined;
  const binding = bindingProvided ? resolveBinding(db, body, tenantId, actor) : { transition: null, version: null };
  const steps = normalizeSteps(db, body.steps, tenantId, actor, null);
  try {
    run(
      db,
      `UPDATE approval_rules SET
        code = ?, name = ?, description = ?, kind = ?, module = ?, lifecycle_version_id = ?, transition_id = ?,
        require_all = ?, min_approvals = ?, sequential = ?, allow_self_approval = ?, mandatory_comment_on_reject = ?,
        conditions_json = ?, auto_transition = ?, rollback_state_id = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.code ?? row.code,
        String(body.name ?? row.name).trim(),
        body.description ?? row.description,
        kind,
        body.module ?? row.module,
        bindingProvided ? binding.version?.id ?? null : row.lifecycle_version_id,
        bindingProvided ? binding.transition?.id ?? null : row.transition_id,
        body.require_all === undefined && body.requireAll === undefined ? row.require_all : body.require_all || body.requireAll ? 1 : 0,
        body.min_approvals === undefined && body.minApprovals === undefined ? row.min_approvals : Number(body.min_approvals ?? body.minApprovals) || 1,
        body.sequential === undefined ? row.sequential : body.sequential ? 1 : 0,
        body.allow_self_approval === undefined && body.allowSelfApproval === undefined ? row.allow_self_approval : body.allow_self_approval || body.allowSelfApproval ? 1 : 0,
        body.mandatory_comment_on_reject === undefined && body.mandatoryCommentOnReject === undefined
          ? row.mandatory_comment_on_reject
          : body.mandatory_comment_on_reject || body.mandatoryCommentOnReject
            ? 1
            : 0,
        body.conditions === undefined ? row.conditions_json : JSON.stringify(body.conditions && typeof body.conditions === "object" ? body.conditions : {}),
        body.auto_transition === undefined && body.autoTransition === undefined ? row.auto_transition : body.auto_transition || body.autoTransition ? 1 : 0,
        body.rollback_state_id === undefined && body.rollbackStateId === undefined ? row.rollback_state_id : body.rollback_state_id ?? body.rollbackStateId,
        body.status === undefined ? row.status : body.status,
        nowIso(),
        row.id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Approval rule code already exists in this scope");
    throw err;
  }
  if (steps) {
    run(db, "DELETE FROM approval_rule_steps WHERE rule_id = ?", [row.id]);
    insertSteps(db, row.id, steps);
  }
  writeAudit(db, { actor, action: "lifecycle.approval_rule.update", resourceType: "approval_rule", resourceId: row.id, details: { code: row.code }, ip });
  return getRule(db, row.id, tenantId);
}

export function deleteRule(db, id, actor, ip, tenantId) {
  const row = getRuleRow(db, id);
  assertMutable(db, row, tenantId, actor, "Approval rule not found");
  const used = queryOne(db, "SELECT COUNT(*) AS c FROM object_releases WHERE rule_id = ?", [row.id]).c;
  if (used) throw new HttpError(409, "Cannot delete an approval rule used by existing releases");
  run(db, "DELETE FROM approval_rules WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "lifecycle.approval_rule.delete", resourceType: "approval_rule", resourceId: row.id, details: { code: row.code }, ip });
  return { deleted: true, id: row.id };
}

export function listReleaseRules(db, query = {}, tenantId) {
  return listRules(db, { ...query, kind: "release" }, tenantId);
}

export function listApprovalRules(db, query = {}, tenantId) {
  return listRules(db, { ...query, kind: "approval" }, tenantId);
}

export function readRuleTenant(db, actor, query, reqTenantId) {
  return readTenant(db, actor, query, reqTenantId);
}

// ---------------------------------------------------------------------------
// Releases & approvals
// ---------------------------------------------------------------------------

export function publicApproval(row) {
  if (!row) return null;
  return {
    id: row.id,
    release_id: row.release_id,
    object_id: row.object_id,
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
    created_at: row.created_at,
  };
}

export function publicRelease(db, row) {
  if (!row) return null;
  const approvals = queryAll(
    db,
    `SELECT a.*, u.username AS approver_username, du.username AS decided_username
       FROM object_approvals a
       LEFT JOIN users u ON u.id = a.approver_id
       LEFT JOIN users du ON du.id = a.decided_by
      WHERE a.release_id = ? ORDER BY a.sequence, a.id`,
    [row.id]
  ).map(publicApproval);
  return {
    id: row.id,
    object_id: row.object_id,
    lifecycle_version_id: row.lifecycle_version_id ?? null,
    transition_id: row.transition_id ?? null,
    rule_id: row.rule_id ?? null,
    rule_code: row.rule_code ?? null,
    from_state_id: row.from_state_id ?? null,
    to_state_id: row.to_state_id ?? null,
    status: row.status,
    requested_by: row.requested_by ?? null,
    requested_username: row.requested_username ?? null,
    resolved_at: row.resolved_at || null,
    comments: row.comments || "",
    approvals,
    approved_count: approvals.filter((a) => a.status === "approved").length,
    pending_count: approvals.filter((a) => a.status === "pending").length,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const RELEASE_SELECT = `
  SELECT r.*, u.username AS requested_username, ar.code AS rule_code
  FROM object_releases r
  LEFT JOIN users u ON u.id = r.requested_by
  LEFT JOIN approval_rules ar ON ar.id = r.rule_id
`;

export function resolveRule(db, row, transition) {
  if (transition?.approval_rule_id) {
    const rule = queryOne(db, "SELECT * FROM approval_rules WHERE id = ?", [transition.approval_rule_id]);
    if (rule) return rule;
  }
  if (transition) {
    const byTransition = queryOne(
      db,
      `SELECT * FROM approval_rules
        WHERE status = 'active' AND kind IN ('release','approval') AND transition_id = ?
          AND (tenant_id IS NULL OR tenant_id = ?)
        ORDER BY tenant_id IS NULL LIMIT 1`,
      [transition.id, row.tenant_id]
    );
    if (byTransition) return byTransition;
  }
  return queryOne(
    db,
    `SELECT * FROM approval_rules
      WHERE status = 'active' AND kind = 'release' AND transition_id IS NULL AND lifecycle_version_id = ?
        AND (tenant_id IS NULL OR tenant_id = ?)
      ORDER BY tenant_id IS NULL LIMIT 1`,
    [row.lifecycle_version_id, row.tenant_id]
  );
}

function assertEligible(db, row, fromState, rule, actor, tenantId) {
  const errors = [];
  const context = conditionContext(row, fromState, actor);
  evaluateGuard(safeJson(rule.conditions_json), context, "Release condition");
  const validation = metadata.validateRecord(
    db,
    { typeId: row.object_type_id, values: safeJson(row.data_json), user: actor, organization: row.organization_id },
    tenantId
  );
  if (!validation.valid) {
    throw new HttpError(422, "Release eligibility validation failed", validation.errors);
  }
  return errors;
}

export function requestRelease(db, row, transition, fromState, toState, body, actor, tenantId, ip) {
  const pending = queryOne(
    db,
    "SELECT * FROM object_releases WHERE object_id = ? AND status IN ('pending','changes_requested')",
    [row.id]
  );
  if (pending) throw new HttpError(409, "A release request is already pending for this object");
  const rule = resolveRule(db, row, transition);
  if (!rule) throw new HttpError(409, "No active release/approval rule is configured for this transition");
  if (rule.status !== "active") throw new HttpError(409, "The applicable approval rule is not active");
  assertEligible(db, row, fromState, rule, actor, tenantId);
  const steps = queryAll(db, "SELECT * FROM approval_rule_steps WHERE rule_id = ? ORDER BY sequence, id", [rule.id]);
  if (!steps.length) throw new HttpError(409, "The approval rule has no steps configured");
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO object_releases
      (object_id, lifecycle_version_id, transition_id, rule_id, from_state_id, to_state_id, status, requested_by, comments, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.lifecycle_version_id,
      transition?.id ?? null,
      rule.id,
      fromState?.id ?? row.lifecycle_state_id,
      toState?.id ?? null,
      actor?.id ?? null,
      body?.comments || body?.reason || "",
      Number(tenantId),
      ts,
      ts,
    ]
  );
  const releaseId = result.lastInsertRowid;
  let created = 0;
  for (const step of steps) {
    const approvers = workflow.resolveApprovers(db, { step, object: { ...row, organization_id: body?.organization_id ?? row.organization_id }, tenantId });
    if (!approvers.length) {
      throw new HttpError(409, `No eligible approvers resolved for step ${step.code}`);
    }
    for (const approver of approvers) {
      run(
        db,
        `INSERT INTO object_approvals
          (release_id, object_id, step_id, step_code, sequence, parallel, approver_type, approver_id, status, tenant_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [releaseId, row.id, step.id, step.code, step.sequence, step.parallel, step.approver_type, approver.id, Number(tenantId), ts, ts]
      );
      created += 1;
    }
  }
  workflow.startApproval(db, { releaseId, object: row, rule });
  writeAudit(db, {
    actor,
    action: "lifecycle.release.request",
    resourceType: "object",
    resourceId: row.id,
    details: { code: row.code, rule: rule.code, release_id: releaseId, approvals: created },
    ip,
  });
  return publicRelease(db, queryOne(db, `${RELEASE_SELECT} WHERE r.id = ?`, [releaseId]));
}

function stepSatisfied(db, rule, releaseId, step) {
  const rows = queryAll(db, "SELECT status FROM object_approvals WHERE release_id = ? AND step_id = ?", [releaseId, step.id]);
  if (!rows.length) return true; // step not applicable / no approvers resolved
  const approved = rows.filter((r) => r.status === "approved").length;
  if (step.approval_mode === "any") return approved >= 1;
  if (step.approval_mode === "min") return approved >= Math.max(1, step.min_approvals);
  return rows.every((r) => r.status === "approved");
}

function assertStepOpen(db, rule, release, approval) {
  if (rule?.sequential !== 1) return;
  const steps = queryAll(db, "SELECT * FROM approval_rule_steps WHERE rule_id = ? ORDER BY sequence, id", [rule.id]);
  for (const step of steps) {
    if (step.sequence === approval.sequence) return; // our step is the current gate
    if (!stepSatisfied(db, rule, release.id, step)) {
      throw new HttpError(409, "A previous approval step is still pending", { blocked_by: step.code });
    }
  }
}

function evaluateCompletion(db, rule, release) {
  const steps = queryAll(db, "SELECT * FROM approval_rule_steps WHERE rule_id = ? ORDER BY sequence, id", [rule.id]);
  for (const step of steps) {
    if (!stepSatisfied(db, rule, release.id, step)) return false;
  }
  const approved = queryOne(
    db,
    "SELECT COUNT(*) AS c FROM object_approvals WHERE release_id = ? AND status = 'approved'",
    [release.id]
  ).c;
  return approved >= Math.max(1, Number(rule.min_approvals) || 1);
}

function rollback(db, row, rule, actor, tenantId, ip) {
  if (!rule.rollback_state_id || !row.lifecycle_version_id) return null;
  const target = getStateRow(db, rule.rollback_state_id);
  if (!target || Number(target.lifecycle_version_id) !== Number(row.lifecycle_version_id)) return null;
  const transition = queryOne(
    db,
    "SELECT * FROM lifecycle_transitions WHERE from_state_id = ? AND to_state_id = ? AND status = 'active'",
    [row.lifecycle_state_id, target.id]
  );
  return applyTransition(db, row, transition, target, actor, tenantId, ip, {
    source: "approval",
    reason: "Release rollback",
  });
}

export function decideApproval(db, reference, approvalId, body, actor, tenantId, ip) {
  const objectRow = findObjectRow(db, reference, tenantId);
  const approval = queryOne(
    db,
    `SELECT a.*, u.username AS approver_username FROM object_approvals a
     LEFT JOIN users u ON u.id = a.approver_id WHERE a.id = ? AND a.object_id = ?`,
    [Number(approvalId), objectRow.id]
  );
  if (!approval) throw new HttpError(404, "Approval not found");
  const release = queryOne(db, `${RELEASE_SELECT} WHERE r.id = ?`, [approval.release_id]);
  if (!release) throw new HttpError(404, "Release not found");
  const rule = release.rule_id ? queryOne(db, "SELECT * FROM approval_rules WHERE id = ?", [release.rule_id]) : null;
  const decision = body?.decision;
  if (!APPROVAL_DECISIONS.includes(decision)) {
    throw new HttpError(400, `decision must be one of: ${APPROVAL_DECISIONS.join(", ")}`);
  }
  const comment = String(body?.comment ?? body?.comments ?? "").trim();

  if (decision === "resubmit") {
    if (!["changes_requested", "rejected"].includes(release.status)) {
      throw new HttpError(409, "Only a changed or rejected release can be resubmitted");
    }
    return resubmit(db, objectRow, release, actor, tenantId, ip);
  }
  if (["approved", "rejected", "cancelled"].includes(release.status)) {
    throw new HttpError(409, `Release is already ${release.status}`);
  }
  const isAdmin = tenants.isPlatformAdmin(db, actor?.id);
  if (approval.approver_id && !isAdmin && Number(approval.approver_id) !== Number(actor?.id)) {
    throw new HttpError(403, "You are not the assigned approver for this step");
  }
  if (decision === "approve" && !rule?.allow_self_approval && Number(release.requested_by) === Number(actor?.id) && !isAdmin) {
    throw new HttpError(403, "Self-approval is not permitted for this rule");
  }
  assertStepOpen(db, rule, release, approval);

  const ts = nowIso();
  if (decision === "reject") {
    if (rule?.mandatory_comment_on_reject === 1 && !comment) {
      throw new HttpError(400, "A comment is required when rejecting");
    }
    run(db, "UPDATE object_approvals SET status = 'rejected', decided_by = ?, decided_at = ?, comment = ?, updated_at = ? WHERE id = ?", [
      actor?.id ?? null,
      ts,
      comment,
      ts,
      approval.id,
    ]);
    run(db, "UPDATE object_releases SET status = 'rejected', resolved_at = ?, comments = ?, updated_at = ? WHERE id = ?", [
      ts,
      comment || release.comments,
      ts,
      release.id,
    ]);
    rollback(db, objectRow, rule || {}, actor, tenantId, ip);
    workflow.onApprovalComplete(db, { release: { ...release, status: "rejected" }, object: objectRow, rule });
    writeAudit(db, { actor, action: "lifecycle.release.reject", resourceType: "object", resourceId: objectRow.id, details: { code: objectRow.code, rule: rule?.code ?? null, comment }, ip });
    return publicRelease(db, queryOne(db, `${RELEASE_SELECT} WHERE r.id = ?`, [release.id]));
  }
  if (decision === "request_changes") {
    run(db, "UPDATE object_approvals SET status = 'changes_requested', decided_by = ?, decided_at = ?, comment = ?, updated_at = ? WHERE id = ?", [
      actor?.id ?? null,
      ts,
      comment,
      ts,
      approval.id,
    ]);
    run(db, "UPDATE object_releases SET status = 'changes_requested', comments = ?, updated_at = ? WHERE id = ?", [comment || release.comments, ts, release.id]);
    workflow.onApprovalComplete(db, { release: { ...release, status: "changes_requested" }, object: objectRow, rule });
    writeAudit(db, { actor, action: "lifecycle.release.request_changes", resourceType: "object", resourceId: objectRow.id, details: { code: objectRow.code, comment }, ip });
    return publicRelease(db, queryOne(db, `${RELEASE_SELECT} WHERE r.id = ?`, [release.id]));
  }

  // approve
  run(db, "UPDATE object_approvals SET status = 'approved', decided_by = ?, decided_at = ?, comment = ?, updated_at = ? WHERE id = ?", [
    actor?.id ?? null,
    ts,
    comment,
    ts,
    approval.id,
  ]);
  const refreshed = queryOne(db, "SELECT * FROM object_releases WHERE id = ?", [release.id]);
  if (evaluateCompletion(db, rule, refreshed)) {
    run(db, "UPDATE object_releases SET status = 'approved', resolved_at = ?, updated_at = ? WHERE id = ?", [ts, ts, release.id]);
    let moved = null;
    if (rule?.auto_transition === 1 && release.to_state_id) {
      const target = getStateRow(db, release.to_state_id);
      if (target) {
        const transition = release.transition_id ? getTransitionRow(db, release.transition_id) : null;
        const latest = getObjectRow(db, objectRow.id);
        moved = applyTransition(db, latest, transition, target, actor, tenantId, ip, {
          source: "approval",
          reason: "Release approved",
        });
      }
    }
    workflow.onApprovalComplete(db, { release: { ...refreshed, status: "approved" }, object: objectRow, rule, moved });
    writeAudit(db, {
      actor,
      action: "lifecycle.release.approve",
      resourceType: "object",
      resourceId: objectRow.id,
      details: { code: objectRow.code, rule: rule?.code ?? null, auto_transitioned: Boolean(moved) },
      ip,
    });
  }
  return publicRelease(db, queryOne(db, `${RELEASE_SELECT} WHERE r.id = ?`, [release.id]));
}

export function resubmit(db, objectRow, release, actor, tenantId, ip) {
  const ts = nowIso();
  run(
    db,
    `UPDATE object_approvals SET status = 'pending', decided_by = NULL, decided_at = NULL, comment = '', updated_at = ?
     WHERE release_id = ? AND status IN ('changes_requested','rejected','cancelled')`,
    [ts, release.id]
  );
  run(db, "UPDATE object_releases SET status = 'pending', resolved_at = NULL, updated_at = ? WHERE id = ?", [ts, release.id]);
  writeAudit(db, { actor, action: "lifecycle.release.resubmit", resourceType: "object", resourceId: objectRow.id, details: { code: objectRow.code, release_id: release.id }, ip });
  return publicRelease(db, queryOne(db, `${RELEASE_SELECT} WHERE r.id = ?`, [release.id]));
}

export function listReleases(db, reference, tenantId, query = {}) {
  const row = findObjectRow(db, reference, tenantId);
  const { page, pageSize, offset } = pagination(query);
  const total = queryOne(db, "SELECT COUNT(*) AS c FROM object_releases WHERE object_id = ?", [row.id]).c;
  const releases = queryAll(
    db,
    `${RELEASE_SELECT} WHERE r.object_id = ? ORDER BY r.id DESC LIMIT ? OFFSET ?`,
    [row.id, pageSize, offset]
  ).map((release) => publicRelease(db, release));
  return { object: publicObject(row), items: releases, total, page, pageSize };
}

export function decideByRelease(db, reference, releaseId, body, actor, tenantId, ip) {
  const objectRow = findObjectRow(db, reference, tenantId);
  const release = queryOne(db, "SELECT * FROM object_releases WHERE id = ? AND object_id = ?", [Number(releaseId), objectRow.id]);
  if (!release) throw new HttpError(404, "Release not found");
  if (body?.decision === "resubmit") return resubmit(db, objectRow, release, actor, tenantId, ip);
  throw new HttpError(400, "Approve/reject against a specific approval id");
}
