// The lifecycle ledger: one row per tracked business object.
//
// This module owns registration, retrieval, state changes and (re)computation of
// retention dates. It never copies business data; archives do that. State changes
// are validated against the tenant's transition graph and always blocked by an
// active legal hold where the policy demands it.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SOURCE_MODULE } from "./constants.js";
import { publicObjectLifecycle } from "./repository.js";
import { invalidObject, invalidState, objectConflict, objectNotFound } from "./errors.js";
import {
  assertStateCode,
  assertTenantId,
  normalizeText,
  normalizeUpper,
  paginate,
  parseDate,
  toIso,
} from "./validation.js";
import { assertTransition, getStateRow, requireState } from "./states.js";
import { resolveTier } from "./tiers.js";
import { computeRetentionSchedule, resolvePolicy } from "./policies.js";
import { listConfig } from "./configuration.js";
import { recordHistory } from "./history.js";
import { activeHoldsForObject } from "./legal-holds.js";
import { publishLifecycleEvent } from "./events.js";
import { notifyLifecycleEvent } from "./notifications.js";

export { publicObjectLifecycle };

export function getObjectRow(db, tenantId, objectType, objectId) {
  return queryOne(db, "SELECT * FROM lc_object_lifecycle WHERE tenant_id = ? AND object_type = ? AND object_id = ?", [
    Number(tenantId),
    normalizeText(objectType, { max: 120 }),
    String(objectId),
  ]);
}

export function getObjectLifecycle(db, tenantId, objectType, objectId) {
  const row = getObjectRow(db, tenantId, objectType, objectId);
  if (!row) throw objectNotFound(objectType, objectId);
  return publicObjectLifecycle(row);
}

export function requireObjectLifecycle(db, tenantId, objectType, objectId) {
  const row = getObjectRow(db, tenantId, objectType, objectId);
  if (!row) throw objectNotFound(objectType, objectId);
  return row;
}

function resolveAnchor(input, basis) {
  const candidate = input.retention_anchor || input.retention_start || input.anchor_date || input.anchor;
  const parsed = toIso(parseDate(candidate));
  if (parsed) return parsed;
  return nowIso();
}

function applySchedule(db, tenantId, row, policyRow, anchor, basis) {
  const config = listConfig(db, tenantId);
  const schedule = computeRetentionSchedule(anchor, policyRow, config);
  run(
    db,
    `UPDATE lc_object_lifecycle SET retention_policy_id = ?, retention_basis = ?, retention_anchor = ?, retention_start = ?, archive_eligible_at = ?, cold_storage_at = ?, purge_eligible_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      policyRow?.id ?? null,
      basis,
      schedule.retention_anchor,
      schedule.retention_anchor,
      schedule.archive_eligible_at,
      schedule.cold_storage_at,
      schedule.purge_eligible_at,
      nowIso(),
      row.id,
    ]
  );
  return queryOne(db, "SELECT * FROM lc_object_lifecycle WHERE id = ?", [row.id]);
}

// Idempotent registration/refresh. Registering an already-tracked object updates
// its descriptive metadata and re-resolves the retention policy, but never
// silently resets its state.
export function registerObjectLifecycle(db, tenantId, input = {}, actor = null, ip = null) {
  const tid = assertTenantId(tenantId);
  const objectType = normalizeText(input.object_type || input.objectType, { max: 120 });
  const objectId = input.object_id ?? input.objectId;
  if (!objectType) throw invalidObject("object_type is required");
  if (objectId === undefined || objectId === null || String(objectId) === "") throw invalidObject("object_id is required");

  const currentState = normalizeUpper(input.current_state || input.currentState || "ACTIVE");
  requireState(db, tid, currentState);
  const classification = normalizeText(input.classification || "internal", { max: 120 });
  const subtype = normalizeText(input.subtype, { max: 120 });
  const organizationId = input.organization_id ?? input.organizationId ?? null;
  const plantId = input.plant_id ?? input.plantId ?? null;

  const existing = getObjectRow(db, tid, objectType, objectId);
  if (existing && !input.allow_existing) {
    throw objectConflict(objectType, objectId);
  }

  const resolution = resolvePolicy(db, {
    tenantId: tid,
    objectType,
    objectId,
    organizationId,
    plantId,
    subtype,
    classification,
    lifecycleState: existing?.current_state || currentState,
  });
  const policyRow = resolution.policy_id ? queryOne(db, "SELECT * FROM lc_policies WHERE id = ?", [resolution.policy_id]) : null;
  const basis = normalizeUpper(input.retention_basis || policyRow?.retention_basis || "LAST_MODIFIED_DATE");
  const ts = nowIso();

  if (existing) {
    run(
      db,
      `UPDATE lc_object_lifecycle SET object_ref = ?, organization_id = ?, plant_id = ?, classification = ?, retention_basis = ?, last_evaluated_at = ?, updated_at = ?
       WHERE id = ?`,
      [
        normalizeText(input.object_ref || existing.object_ref, { max: 200 }),
        organizationId ?? existing.organization_id,
        plantId ?? existing.plant_id,
        classification,
        basis,
        ts,
        ts,
        existing.id,
      ]
    );
    const refreshed = applySchedule(db, tid, existing, policyRow, resolveAnchor(input, basis), basis);
    return publicObjectLifecycle(refreshed);
  }

  const tier = input.data_tier ? normalizeUpper(input.data_tier) : resolveTier(db, tid, currentState);
  const result = run(
    db,
    `INSERT INTO lc_object_lifecycle (tenant_id, organization_id, plant_id, object_type, object_id, object_ref, current_state, previous_state, data_tier, retention_basis, legal_hold_status, classification, version, last_evaluated_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'NONE', ?, 1, ?, ?, ?, ?)`,
    [
      tid,
      organizationId,
      plantId,
      objectType,
      String(objectId),
      normalizeText(input.object_ref, { max: 200 }),
      currentState,
      tier,
      basis,
      classification,
      ts,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM lc_object_lifecycle WHERE id = ?", [Number(result.lastInsertRowid)]);
  const scheduled = applySchedule(db, tid, row, policyRow, resolveAnchor(input, basis), basis);

  writeAudit(db, {
    actor,
    action: "data_lifecycle.object.register",
    resourceType: "lc_object_lifecycle",
    resourceId: `${objectType}:${objectId}`,
    details: { object_type: objectType, object_id: String(objectId), policy_ref: policyRow?.policy_ref ?? null },
    ip,
  });
  recordHistory(db, {
    tenantId: tid,
    objectType,
    objectId,
    objectRef: scheduled.object_ref,
    action: "REGISTER",
    toState: currentState,
    dataTier: scheduled.data_tier,
    policyId: policyRow?.id ?? null,
    reason: "object registered with the lifecycle service",
    details: { retention_basis: basis },
    actor,
  });
  return publicObjectLifecycle(scheduled);
}

export function listObjectLifecycles(db, query = {}) {
  const tid = assertTenantId(query.tenantId);
  const clauses = ["tenant_id = ?"];
  const params = [tid];
  if (query.objectType) {
    clauses.push("object_type = ?");
    params.push(normalizeText(query.objectType, { max: 120 }));
  }
  if (query.objectId !== undefined && query.objectId !== null && query.objectId !== "") {
    clauses.push("object_id = ?");
    params.push(String(query.objectId));
  }
  if (query.state || query.currentState) {
    clauses.push("current_state = ?");
    params.push(assertStateCode(query.state || query.currentState));
  }
  if (query.dataTier) {
    clauses.push("data_tier = ?");
    params.push(normalizeUpper(query.dataTier));
  }
  if (query.legalHoldStatus) {
    clauses.push("legal_hold_status = ?");
    params.push(normalizeUpper(query.legalHoldStatus));
  }
  if (query.classification) {
    clauses.push("classification = ?");
    params.push(normalizeText(query.classification, { max: 120 }));
  }
  if (query.organizationId) {
    clauses.push("organization_id = ?");
    params.push(Number(query.organizationId));
  }
  const term = normalizeText(query.q, { max: 200 });
  if (term) {
    clauses.push("(object_id LIKE ? OR object_ref LIKE ? OR object_type LIKE ?)");
    const like = `%${term}%`;
    params.push(like, like, like);
  }
  const where = `WHERE ${clauses.join(" AND ")}`;
  const { limit, offset, page } = paginate(query, { defaultPageSize: 100, maxPageSize: 500 });
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM lc_object_lifecycle ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT * FROM lc_object_lifecycle ${where} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: rows.map(publicObjectLifecycle), total, page, page_size: limit, source_module: SOURCE_MODULE };
}

// Change the lifecycle state of a tracked object. Blocked by an active legal
// hold when the transition demands it; the PURGED state is only reachable
// through the purge workflow, never here.
export function changeState(db, tenantId, objectType, objectId, toState, { reason = "", actor = null, ip = null, force = false, allowPurged = false } = {}) {
  const tid = assertTenantId(tenantId);
  const row = requireObjectLifecycle(db, tid, objectType, objectId);
  const target = assertStateCode(toState);
  if (target === "PURGED" && !force && !allowPurged) {
    throw invalidState("PURGED is reached through the purge workflow, not a direct state change");
  }
  if (normalizeUpper(row.current_state) === target) {
    return publicObjectLifecycle(row);
  }
  const transition = force ? null : assertTransition(db, tid, row.current_state, target);

  if (!force) {
    const holds = activeHoldsForObject(db, { tenantId: tid, objectType, objectId, organizationId: row.organization_id, classification: row.classification });
    if (holds.length && (transition.requires_legal_hold_clear || target !== "ACTIVE")) {
      throw invalidState(`Cannot transition ${row.current_state} -> ${target}: active legal hold ${holds[0].hold_ref}`, {
        legal_holds: holds.map((h) => h.hold_ref),
      });
    }
  }

  const tier = resolveTier(db, tid, target);
  const ts = nowIso();
  const archivedAt = target === "ARCHIVED" ? ts : row.archived_at;
  run(
    db,
    "UPDATE lc_object_lifecycle SET previous_state = current_state, current_state = ?, data_tier = ?, archived_at = ?, updated_at = ? WHERE id = ?",
    [target, tier, archivedAt, ts, row.id]
  );
  const updated = queryOne(db, "SELECT * FROM lc_object_lifecycle WHERE id = ?", [row.id]);

  writeAudit(db, {
    actor,
    action: "data_lifecycle.object.change_state",
    resourceType: "lc_object_lifecycle",
    resourceId: `${objectType}:${objectId}`,
    details: { from: row.current_state, to: target, reason },
    ip,
  });
  recordHistory(db, {
    tenantId: tid,
    objectType,
    objectId,
    objectRef: row.object_ref,
    action: "CHANGE_STATE",
    fromState: row.current_state,
    toState: target,
    dataTier: tier,
    policyId: row.retention_policy_id,
    reason,
    details: transition?.action ? { transition: transition.action } : {},
    actor,
  });
  publishLifecycleEvent(
    db,
    {
      eventType: target === "INACTIVE" ? "ObjectBecameInactive" : "ObjectLifecycleChanged",
      tenantId: tid,
      objectType,
      objectId,
      payload: { from_state: row.current_state, to_state: target, data_tier: tier, reason },
    },
    actor
  );
  notifyLifecycleEvent(db, {
    eventType: target === "INACTIVE" ? "ObjectBecameInactive" : "ObjectLifecycleChanged",
    tenantId: tid,
    objectType,
    objectId,
    objectName: row.object_ref,
    payload: { from_state: row.current_state, to_state: target },
    actor,
  });
  return publicObjectLifecycle(updated);
}

// Recompute retention dates from the resolved policy and a fresh anchor.
export function applyRetention(db, tenantId, objectType, objectId, { anchor = null, basis = null, actor = null } = {}) {
  const tid = assertTenantId(tenantId);
  const row = requireObjectLifecycle(db, tid, objectType, objectId);
  const resolution = resolvePolicy(db, {
    tenantId: tid,
    objectType,
    objectId,
    organizationId: row.organization_id,
    plantId: row.plant_id,
    classification: row.classification,
    lifecycleState: row.current_state,
  });
  const policyRow = resolution.policy_id ? queryOne(db, "SELECT * FROM lc_policies WHERE id = ?", [resolution.policy_id]) : null;
  const chosenBasis = normalizeUpper(basis || policyRow?.retention_basis || row.retention_basis || "LAST_MODIFIED_DATE");
  const chosenAnchor = toIso(parseDate(anchor)) || row.retention_anchor || nowIso();
  const updated = applySchedule(db, tid, row, policyRow, chosenAnchor, chosenBasis);
  recordHistory(db, {
    tenantId: tid,
    objectType,
    objectId,
    objectRef: row.object_ref,
    action: "RETENTION_APPLIED",
    fromState: row.current_state,
    toState: row.current_state,
    dataTier: updated.data_tier,
    policyId: policyRow?.id ?? null,
    reason: "retention schedule recomputed",
    details: { retention_basis: chosenBasis, anchor: chosenAnchor },
    actor,
  });
  return publicObjectLifecycle(updated);
}

export function setObjectTier(db, tenantId, objectType, objectId, dataTier, { actor = null, ip = null } = {}) {
  const tid = assertTenantId(tenantId);
  const row = requireObjectLifecycle(db, tid, objectType, objectId);
  const tier = normalizeUpper(dataTier);
  if (!["HOT", "WARM", "ARCHIVE", "COLD"].includes(tier)) throw invalidState(`Unsupported data tier: ${dataTier}`);
  run(db, "UPDATE lc_object_lifecycle SET data_tier = ?, updated_at = ? WHERE id = ?", [tier, nowIso(), row.id]);
  writeAudit(db, { actor, action: "data_lifecycle.object.set_tier", resourceType: "lc_object_lifecycle", resourceId: `${objectType}:${objectId}`, details: { data_tier: tier }, ip });
  return publicObjectLifecycle(queryOne(db, "SELECT * FROM lc_object_lifecycle WHERE id = ?", [row.id]));
}

export function markEvaluated(db, tenantId, id, when = nowIso()) {
  run(db, "UPDATE lc_object_lifecycle SET last_evaluated_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [when, when, Number(id), Number(tenantId)]);
}

export function stateCapabilities(db, tenantId, stateCode) {
  const row = getStateRow(db, tenantId, stateCode);
  if (!row) return null;
  return {
    code: row.code,
    read: Boolean(Number(row.read_allowed)),
    update: Boolean(Number(row.update_allowed)),
    delete: Boolean(Number(row.delete_allowed)),
    restore: Boolean(Number(row.restore_allowed)),
    export: Boolean(Number(row.export_allowed)),
    archive_eligible: Boolean(Number(row.archive_eligible)),
    purge_eligible: Boolean(Number(row.purge_eligible)),
  };
}
