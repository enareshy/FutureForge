import { queryAll, queryOne, run, transaction } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { checkPermission } from "../authorization.js";
import * as tenants from "../tenants.js";
import { findObjectRow, getObjectRow, publicObject, activeCheckoutRow } from "../objects/repository.js";
import {
  getVersionRow,
  getDefinitionRow,
  getStateRow,
  publicDefinition,
  publicVersion,
  publicState,
  publicTransition,
  transitionsFrom,
  resolveAssignment,
  initialStateForVersion,
} from "./definitions.js";
import { getStatusRow, publicStatus, defaultStatusRow, legacyForCategory } from "./statuses.js";
import { applyTransition, assignLifecycle, recordStatusHistory, conditionContext, evaluateGuard } from "./apply.js";
import * as approvals from "./approvals.js";

// The state-transition engine. It is entirely configuration-driven: states,
// guards, permissions and approval gates are read from the object's *pinned*
// lifecycle version, so later configuration edits cannot silently move a
// released object.

export function actorRoleCodes(db, actor, organizationId = 0) {
  if (!actor?.id) return [];
  const org = Number(organizationId) || 0;
  return queryAll(
    db,
    `SELECT DISTINCT r.code AS code FROM roles r
      WHERE r.id IN (
        SELECT ur.role_id FROM user_roles ur
         WHERE ur.user_id = ? AND (ur.organization_id = 0 OR ur.organization_id = ?)
        UNION
        SELECT gr.role_id FROM group_roles gr
          JOIN group_members gm ON gm.group_id = gr.group_id
         WHERE gm.user_id = ? AND (gr.organization_id = 0 OR gr.organization_id = ?)
      )`,
    [actor.id, org, actor.id, org]
  ).map((row) => row.code);
}

function actorSatisfies(db, actor, entry, organizationId) {
  if (!entry) return false;
  if (actorRoleCodes(db, actor, organizationId).includes(entry)) return true;
  for (const action of ["execute", "update", "read"]) {
    if (checkPermission(db, actor?.id, entry, action, { organizationId }).allowed) return true;
  }
  return false;
}

function satisfiesEntry(db, actor, entry, organizationId) {
  if (!entry) return false;
  if (String(entry).includes(":")) {
    const [resource, action] = String(entry).split(":");
    if (checkPermission(db, actor?.id, resource, action, { organizationId }).allowed) return true;
  }
  return actorSatisfies(db, actor, entry, organizationId);
}

function assertTransitionPermission(db, transition, state, actor, tenantId, organizationId) {
  const entries = [transition.required_permission, transition.required_role]
    .concat(parsePermissions(state?.permissions_json))
    .filter(Boolean);
  if (!entries.length) return;
  if (entries.some((entry) => satisfiesEntry(db, actor, entry, organizationId))) return;
  throw new HttpError(403, "You do not have permission to perform this transition", {
    required: entries,
  });
}

function parsePermissions(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function assertNotLocked(db, row, actor) {
  const checkout = activeCheckoutRow(db, row.id);
  if (!checkout) return;
  if (actor?.id && Number(checkout.locked_by) === Number(actor.id)) return;
  throw new HttpError(409, "Object is checked out by another user", { locked_by: checkout.locked_by });
}

export function availableTransitions(db, row) {
  if (!row?.lifecycle_version_id || !row.lifecycle_state_id) return [];
  return transitionsFrom(db, row.lifecycle_version_id, row.lifecycle_state_id);
}

// Called when an object is created: if its type has a published lifecycle
// assignment, pin the object to that version and move it to the initial state.
// Returns the updated row, or null when no lifecycle applies (the caller keeps
// the freshly created row).
export function applyInitialLifecycle(db, row, actor = null) {
  if (!row || row.lifecycle_version_id) return null;
  const assignment = resolveAssignment(db, row.object_type_id, Number(row.tenant_id) || null);
  if (!assignment) return null;
  const version = getVersionRow(db, assignment.lifecycle_version_id);
  if (!version) return null;
  const state = initialStateForVersion(db, version.id);
  if (!state) return null;
  return assignLifecycle(db, row, version, state, actor);
}

function pendingRelease(db, objectId) {
  return queryOne(
    db,
    `SELECT * FROM object_releases WHERE object_id = ? AND status IN ('pending', 'changes_requested') ORDER BY id DESC LIMIT 1`,
    [objectId]
  );
}

export function objectLifecycle(db, reference, tenantId) {
  const row = findObjectRow(db, reference, tenantId);
  const version = row.lifecycle_version_id ? getVersionRow(db, row.lifecycle_version_id) : null;
  const definition = version ? getDefinitionRow(db, version.definition_id) : null;
  const state = row.lifecycle_state_id ? getStateRow(db, row.lifecycle_state_id) : null;
  const status = row.lifecycle_status_id ? getStatusRow(db, row.lifecycle_status_id) : null;
  const pending = pendingRelease(db, row.id);
  return {
    object: publicObject(row),
    lifecycle: definition ? publicDefinition(definition) : null,
    version: version ? publicVersion(version) : null,
    state: state ? publicState(state) : null,
    status: publicStatus(status),
    transitions: availableTransitions(db, row),
    pending_release: pending ? approvals.publicRelease(db, pending) : null,
  };
}

export function transitionObject(db, reference, body, actor, tenantId, ip) {
  return transaction(db, () => {
    const row = findObjectRow(db, reference, tenantId);
    if (row.deleted_at) throw new HttpError(409, "Cannot transition a deleted object");
    if (!row.lifecycle_version_id || !row.lifecycle_state_id) {
      throw new HttpError(409, "Object has no lifecycle assigned");
    }
    const version = getVersionRow(db, row.lifecycle_version_id);
    const state = getStateRow(db, row.lifecycle_state_id);
    if (!version || !state) throw new HttpError(409, "Object lifecycle configuration is unavailable");
    const transition = resolveTransition(db, version.id, body);
    if (transition.status !== "active") throw new HttpError(409, "Transition is not active");
    if (Number(transition.from_state_id) !== Number(state.id)) {
      throw new HttpError(409, "Invalid transition for the current state", {
        current_state: state.code,
        from_state: (queryOne(db, "SELECT code FROM lifecycle_states WHERE id = ?", [transition.from_state_id]) || {}).code,
      });
    }
    const toState = getStateRow(db, transition.to_state_id);
    if (!toState) throw new HttpError(409, "Target state is unavailable");
    assertNotLocked(db, row, actor);
    const organizationId = body?.organization_id ?? body?.organizationId ?? row.organization_id ?? 0;
    assertTransitionPermission(db, transition, state, actor, tenantId, organizationId);
    const context = conditionContext(row, state, actor);
    evaluateGuard(state.exit_conditions_json ? safeJson(state.exit_conditions_json) : {}, context, "State exit condition");
    evaluateGuard(transition.conditions_json ? safeJson(transition.conditions_json) : {}, context, "Transition condition");
    evaluateGuard(toState.entry_conditions_json ? safeJson(toState.entry_conditions_json) : {}, context, "State entry condition");

    const bypass = transition.auto_approve === 1 && tenants.isPlatformAdmin(db, actor?.id);
    if (transition.requires_approval && !bypass) {
      const release = approvals.requestRelease(db, row, transition, state, toState, body || {}, actor, tenantId, ip);
      return { gated: true, object: publicObject(getObjectRow(db, row.id)), release };
    }
    const next = applyTransition(db, row, transition, toState, actor, tenantId, ip, {
      source: "manual",
      reason: body?.reason || "",
      comments: body?.comments || "",
    });
    return {
      gated: false,
      object: publicObject(next),
      state: publicState(toState),
      transition: publicTransition(transition),
    };
  });
}

function safeJson(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function resolveTransition(db, versionId, body) {
  const ref = body?.transition ?? body?.transition_id ?? body?.transitionId ?? body?.transition_code ?? body?.transitionCode;
  if (ref === undefined || ref === null || ref === "") {
    throw new HttpError(400, "transition is required");
  }
  const text = String(ref);
  const row = /^\d+$/.test(text)
    ? queryOne(db, "SELECT * FROM lifecycle_transitions WHERE id = ? AND lifecycle_version_id = ?", [Number(text), Number(versionId)])
    : queryOne(db, "SELECT * FROM lifecycle_transitions WHERE code = ? AND lifecycle_version_id = ?", [text, Number(versionId)]);
  if (!row) throw new HttpError(404, "Transition not found for this lifecycle version");
  return row;
}

export function statusHistory(db, reference, tenantId, query = {}) {
  const row = findObjectRow(db, reference, tenantId);
  const { page, pageSize, offset } = pagination(query);
  const total = queryOne(db, "SELECT COUNT(*) AS c FROM object_status_history WHERE object_id = ?", [row.id]).c;
  const items = queryAll(
    db,
    `SELECT h.*, u.username AS actor_username, fs.code AS from_state_code, ts.code AS to_state_code,
            fst.code AS from_status_code, tst.code AS to_status_code, lt.code AS transition_code
       FROM object_status_history h
       LEFT JOIN users u ON u.id = h.actor_id
       LEFT JOIN lifecycle_states fs ON fs.id = h.from_state_id
       LEFT JOIN lifecycle_states ts ON ts.id = h.to_state_id
       LEFT JOIN lifecycle_statuses fst ON fst.id = h.from_status_id
       LEFT JOIN lifecycle_statuses tst ON tst.id = h.to_status_id
       LEFT JOIN lifecycle_transitions lt ON lt.id = h.transition_id
      WHERE h.object_id = ?
      ORDER BY h.id DESC LIMIT ? OFFSET ?`,
    [row.id, pageSize, offset]
  );
  return { items, total, page, pageSize };
}

export function requestObjectRelease(db, reference, body, actor, tenantId, ip) {
  return transaction(db, () => {
    const row = findObjectRow(db, reference, tenantId);
    if (row.deleted_at) throw new HttpError(409, "Cannot release a deleted object");
    if (!row.lifecycle_version_id || !row.lifecycle_state_id) {
      throw new HttpError(409, "Object has no lifecycle assigned");
    }
    const version = getVersionRow(db, row.lifecycle_version_id);
    const state = getStateRow(db, row.lifecycle_state_id);
    if (!version || !state) throw new HttpError(409, "Object lifecycle configuration is unavailable");
    const ref = body?.transition ?? body?.transition_id ?? body?.transitionId ?? body?.transition_code ?? body?.transitionCode;
    let transition;
    if (ref !== undefined && ref !== null && ref !== "") {
      transition = resolveTransition(db, version.id, body);
      if (Number(transition.from_state_id) !== Number(state.id)) {
        throw new HttpError(409, "Transition does not start at the object's current state");
      }
    } else {
      const candidates = transitionsFrom(db, version.id, state.id).filter((t) => t.requires_approval);
      transition = candidates.length === 1
        ? queryOne(db, "SELECT * FROM lifecycle_transitions WHERE id = ?", [candidates[0].id])
        : null;
    }
    if (!transition) throw new HttpError(400, "transition is required (no single approval transition available)");
    if (transition.requires_approval !== 1) {
      throw new HttpError(409, "Transition does not require approval; use POST /objects/:id/transitions instead");
    }
    assertNotLocked(db, row, actor);
    const toState = getStateRow(db, transition.to_state_id);
    const organizationId = body?.organization_id ?? body?.organizationId ?? row.organization_id ?? 0;
    assertTransitionPermission(db, transition, state, actor, tenantId, organizationId);
    return approvals.requestRelease(db, row, transition, state, toState, body || {}, actor, tenantId, ip);
  });
}

export function objectReleases(db, reference, tenantId, query = {}) {
  return approvals.listReleases(db, reference, tenantId, query);
}

// Exposed so other modules (or future workflow integrations) can move an object
// through the engine's guarded path programmatically.
export function statusForLegacyCategory(category) {
  return legacyForCategory(category);
}

export { recordStatusHistory };
