import { run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { publish as publishNotificationEvent } from "../notifications.js";
import * as metadata from "../metadata.js";
import { getObjectRow } from "../objects/repository.js";
import { recordObjectVersion } from "../objects/versions.js";
import { getStatusRow, legacyForCategory } from "./statuses.js";
import { hasConditions } from "./validation.js";
import { emitObjectEvent } from "../events/emit.js";

// Builds the expression context used by lifecycle guards and rules. Guard
// expressions see the object's attribute payload plus the resolved
// status/state/category and actor identity.
export function conditionContext(row, state, actor) {
  const data = (() => {
    try {
      return JSON.parse(row.data_json || "{}");
    } catch {
      return {};
    }
  })();
  return {
    ...data,
    status: row.status,
    state: state?.code ?? null,
    category: state?.category ?? null,
    object_id: row.id,
    object_code: row.code,
    organization_id: row.organization_id ?? 0,
    tenant_id: row.tenant_id,
    actor_id: actor?.id ?? null,
    actor_username: actor?.username ?? null,
  };
}

export function evaluateGuard(condition, context, label) {
  if (!hasConditions(condition)) return true;
  let ok = false;
  try {
    ok = metadata.evaluate(condition, context);
  } catch (err) {
    throw new HttpError(422, `Invalid ${label} expression`, { message: err.message });
  }
  if (!ok) throw new HttpError(422, `${label} not satisfied`, { condition });
  return true;
}


// Low-level state application shared by the transition engine and the approval
// evaluator. No imports from engine/approvals, so the two can compose without a
// circular dependency. Every move is atomic (callers wrap in a transaction),
// bumps the object revision, snapshots it, records status history and audits.

export function recordStatusHistory(db, entry) {
  run(
    db,
    `INSERT INTO object_status_history
      (object_id, lifecycle_version_id, transition_id, from_state_id, to_state_id, from_status_id, to_status_id,
       from_status, to_status, source, reason, actor_id, tenant_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.object_id,
      entry.lifecycle_version_id ?? null,
      entry.transition_id ?? null,
      entry.from_state_id ?? null,
      entry.to_state_id ?? null,
      entry.from_status_id ?? null,
      entry.to_status_id ?? null,
      entry.from_status ?? null,
      entry.to_status ?? null,
      entry.source || "manual",
      entry.reason || "",
      entry.actor_id ?? null,
      entry.tenant_id,
      nowIso(),
    ]
  );
}

function legacyForState(db, state) {
  if (state?.status_id) {
    const status = getStatusRow(db, state.status_id);
    if (status) return status.legacy_status;
  }
  return legacyForCategory(state?.category || "draft");
}

// Applies a guarded transition to an object that already passed all checks.
export function applyTransition(db, row, transition, toState, actor, tenantId, ip, options = {}) {
  const { source = "manual", reason = "", comments = "" } = options;
  const legacy = legacyForState(db, toState);
  const nextRevision = Number(row.revision) + 1;
  run(
    db,
    `UPDATE objects SET lifecycle_state_id = ?, lifecycle_status_id = ?, status = ?, revision = ?, updated_by = ?, updated_at = ?
     WHERE id = ?`,
    [toState.id, toState.status_id ?? null, legacy, nextRevision, actor?.id ?? null, nowIso(), row.id]
  );
  const next = getObjectRow(db, row.id);
  recordObjectVersion(
    db,
    next,
    "lifecycle",
    `Transition ${transition?.code || "manual"} \u2192 ${toState.code}${reason ? ` (${reason})` : ""}`,
    actor?.id
  );
  recordStatusHistory(db, {
    object_id: row.id,
    tenant_id: Number(tenantId ?? row.tenant_id),
    lifecycle_version_id: next.lifecycle_version_id,
    transition_id: transition?.id ?? null,
    from_state_id: row.lifecycle_state_id,
    to_state_id: toState.id,
    from_status_id: row.lifecycle_status_id,
    to_status_id: toState.status_id ?? null,
    from_status: row.status,
    to_status: legacy,
    source,
    reason: reason || comments,
    actor_id: actor?.id,
  });
  writeAudit(db, {
    actor,
    action: "lifecycle.object.transition",
    resourceType: "object",
    resourceId: row.id,
    details: {
      code: row.code,
      transition: transition?.code ?? null,
      to_state: toState.code,
      status: legacy,
      source,
    },
    ip,
  });
  publishNotificationEvent(
    db,
    {
      event_type: "lifecycle.state.changed",
      source_module: "lifecycle",
      tenant_id: Number(tenantId ?? row.tenant_id),
      object_type: "object",
      object_id: row.code || String(row.id),
      object_name: next.name || row.code || "",
      payload: {
        status: legacy,
        from_status: row.status,
        to_status: legacy,
        owner_id: next.created_by ?? row.created_by ?? null,
        transition: transition?.code ?? null,
        reason: reason || comments || "",
        link: `/objects/${row.code || row.id}`,
      },
    },
    { actor, ip }
  );
  emitObjectEvent(db, next, "LifecycleStateChanged", {
    source_module: "lifecycle",
    idempotency_key: `lifecycle:${next.id}:${next.revision}`,
    payload: {
      from_state: row.lifecycle_state_id ?? null,
      to_state: toState.code,
      from_state_id: row.lifecycle_state_id ?? null,
      to_state_id: toState.id,
      from_status: row.status,
      to_status: legacy,
      transition: transition?.code ?? null,
      reason: reason || comments || "",
      source,
    },
  }, actor);
  return next;
}

// Assigns a lifecycle version + initial state to a freshly created object.
export function assignLifecycle(db, row, version, state, actor = null) {
  const legacy = legacyForState(db, state);
  run(
    db,
    "UPDATE objects SET lifecycle_version_id = ?, lifecycle_state_id = ?, lifecycle_status_id = ?, status = ?, updated_at = ? WHERE id = ?",
    [version.id, state.id, state.status_id ?? null, legacy, nowIso(), row.id]
  );
  recordStatusHistory(db, {
    object_id: row.id,
    tenant_id: Number(row.tenant_id),
    lifecycle_version_id: version.id,
    from_status: null,
    to_status: legacy,
    to_state_id: state.id,
    to_status_id: state.status_id ?? null,
    source: "system",
    reason: `Initial state ${state.code}`,
    actor_id: actor?.id,
  });
  return getObjectRow(db, row.id);
}
