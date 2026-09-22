// The explainable lifecycle eligibility engine.
//
// Given an object and a proposed action it answers whether the action may
// proceed, and why. Every decision is a list of reasons with a severity so the
// UI and the policy simulator can show operators exactly what blocked an object
// (retention not expired, legal hold, dependency, quality gate, state, policy).
import { queryAll, nowIso } from "../../db.js";
import {
  ELIGIBILITY_ACTIONS,
  ELIGIBILITY_REASONS,
  MAX_BATCH_OBJECTS,
  SOURCE_MODULE,
} from "./constants.js";
import { invalidEligibility } from "./errors.js";
import { assertEligibilityAction, assertTenantId, isPast, normalizeText } from "./validation.js";
import { requireObjectLifecycle } from "./objects.js";
import { resolvePolicy } from "./policies.js";
import { allowedTransitions } from "./states.js";
import { evaluateDependencies } from "./dependencies.js";
import { activeHoldsForObject } from "./legal-holds.js";
import { listConfig } from "./configuration.js";
import { qualityGate } from "./quality-gate.js";
import { getLatestArchiveRow } from "./archive.js";

const SEVERITY_RANK = Object.freeze({ INFO: 0, WARNING: 1, REVIEW: 2, BLOCKED: 3 });

const ACTION_TARGET = Object.freeze({
  INACTIVE: "INACTIVE",
  ARCHIVE: "ARCHIVED",
  COLD_STORAGE: "COLD_STORAGE",
  PURGE: "PURGED",
});

function reason(code, severity, message, details = null) {
  return { code, severity, message, ...(details ? { details } : {}) };
}

function policyActionFor(action, policy) {
  if (!policy) return "MARK_ELIGIBLE";
  if (action === "ARCHIVE") return policy.archive_action;
  if (action === "COLD_STORAGE") return policy.cold_storage_action;
  if (action === "PURGE") return policy.purge_action;
  return "AUTOMATIC";
}

export function evaluateEligibility(db, { tenantId, objectType, objectId, action, force = false } = {}) {
  const tid = assertTenantId(tenantId);
  const normalizedAction = assertEligibilityAction(action);
  const targetState = ACTION_TARGET[normalizedAction];
  const row = requireObjectLifecycle(db, tid, objectType, objectId);
  const currentState = String(row.current_state).toUpperCase();
  const reasons = [];

  const resolution = resolvePolicy(db, {
    tenantId: tid,
    objectType,
    objectId,
    organizationId: row.organization_id,
    plantId: row.plant_id,
    classification: row.classification,
    lifecycleState: currentState,
  });
  const policy = resolution.policy;

  // 1. State reachability from the tenant's transition graph.
  const transitions = allowedTransitions(db, tid, currentState).map((t) => String(t.to_state).toUpperCase());
  const alreadyThere = currentState === targetState;
  if (alreadyThere) {
    reasons.push(reason(ELIGIBILITY_REASONS.ALREADY_ARCHIVED, "INFO", `Object is already ${currentState}`));
  } else if (!transitions.includes(targetState)) {
    reasons.push(
      reason(ELIGIBILITY_REASONS.STATE_NOT_ELIGIBLE, "BLOCKED", `No permitted transition from ${currentState} to ${targetState}`, {
        from: currentState,
        to: targetState,
        allowed: transitions,
      })
    );
  }

  // 2. Retention window.
  if (!policy) {
    reasons.push(reason(ELIGIBILITY_REASONS.POLICY_MISSING, "WARNING", "No active retention policy resolves for this object"));
  }
  const anchorField = { INACTIVE: null, ARCHIVE: "archive_eligible_at", COLD_STORAGE: "cold_storage_at", PURGE: "purge_eligible_at" }[normalizedAction];
  if (anchorField && policy) {
    const due = row[anchorField];
    if (!due) {
      reasons.push(reason(ELIGIBILITY_REASONS.RETENTION_NOT_EXPIRED, "BLOCKED", "Retention schedule has not been computed for this object"));
    } else if (!isPast(due)) {
      reasons.push(
        reason(ELIGIBILITY_REASONS.RETENTION_NOT_EXPIRED, force ? "WARNING" : "BLOCKED", `Retention period has not elapsed (eligible ${due})`, {
          eligible_at: due,
        })
      );
    } else {
      reasons.push(reason(ELIGIBILITY_REASONS.RETENTION_EXPIRED, "INFO", "Retention period has elapsed", { eligible_at: due }));
    }
  }

  // 3. Legal holds always win.
  const holds = activeHoldsForObject(db, {
    tenantId: tid,
    objectType,
    objectId,
    organizationId: row.organization_id,
    plantId: row.plant_id,
    classification: row.classification,
  });
  if (holds.length) {
    reasons.push(
      reason(ELIGIBILITY_REASONS.LEGAL_HOLD_ACTIVE, "BLOCKED", `Blocked by ${holds.length} active legal hold(s)`, {
        legal_holds: holds.map((h) => h.hold_ref),
      })
    );
  }

  // 4. Dependencies.
  const dependencies = evaluateDependencies(db, { tenantId: tid, objectType, objectId });
  if (dependencies.blocked) {
    reasons.push(
      reason(ELIGIBILITY_REASONS.ACTIVE_DEPENDENCY, "BLOCKED", `${dependencies.blocking.length} active dependenc(ies) block this action`, {
        dependencies: dependencies.blocking.map((d) => `${d.depends_on_type}:${d.depends_on_id}`),
      })
    );
  } else if (dependencies.warnings.length) {
    reasons.push(reason(ELIGIBILITY_REASONS.DEPENDENCY_WARNING, "WARNING", `${dependencies.warnings.length} dependency warning(s)`, {}));
  }

  // 5. Optional quality gate (archive and purge only).
  let gate = { applicable: false, blocked: false, reasons: [] };
  if (normalizedAction === "ARCHIVE" || normalizedAction === "PURGE") {
    gate = qualityGate(db, { tenantId: tid, objectType, objectId, action: normalizedAction });
    for (const r of gate.reasons || []) {
      reasons.push(reason(r.code, r.severity, r.message, r.details || null));
    }
  }

  // 6. Policy stage action.
  if (policy) {
    const stage = policyActionFor(normalizedAction, policy);
    if (stage === "NONE") {
      reasons.push(reason(ELIGIBILITY_REASONS.POLICY_BLOCKS_ACTION, "BLOCKED", `Policy ${policy.code} disables ${normalizedAction}`));
    }
  }

  // 7. Purge prerequisites.
  if (normalizedAction === "PURGE") {
    const archive = getLatestArchiveRow(db, { tenantId: tid, objectType, objectId });
    if (!archive) {
      reasons.push(reason(ELIGIBILITY_REASONS.ARCHIVE_REQUIRED, "WARNING", "No archive record exists for this object"));
    }
  }

  const worst = reasons.reduce((acc, r) => Math.max(acc, SEVERITY_RANK[r.severity] ?? 0), 0);
  const blocked = reasons.some((r) => r.severity === "BLOCKED");
  let result = "SAFE";
  if (worst === SEVERITY_RANK.BLOCKED) result = "BLOCKED";
  else if (worst === SEVERITY_RANK.REVIEW) result = "REQUIRES_REVIEW";
  else if (worst === SEVERITY_RANK.WARNING) result = "WARNING";

  return {
    tenant_id: tid,
    object_type: normalizeText(objectType, { max: 120 }),
    object_id: String(objectId),
    action: normalizedAction,
    target_state: targetState,
    current_state: currentState,
    data_tier: row.data_tier,
    policy_ref: policy?.policy_ref ?? null,
    policy_resolution: { match_score: resolution.match_score, candidates: resolution.candidates },
    eligible: !blocked,
    blocked,
    result,
    reasons,
    legal_holds: holds,
    dependencies: { result: dependencies.result, blocked: dependencies.blocked, blocking: dependencies.blocking.length, warnings: dependencies.warnings.length },
    quality: gate,
    retention: {
      basis: row.retention_basis,
      anchor: row.retention_anchor,
      archive_eligible_at: row.archive_eligible_at,
      cold_storage_at: row.cold_storage_at,
      purge_eligible_at: row.purge_eligible_at,
    },
    actions: ELIGIBILITY_ACTIONS,
    evaluated_at: nowIso(),
    source_module: SOURCE_MODULE,
  };
}

export function evaluateBatch(db, { tenantId, objects = [], action, force = false } = {}) {
  const tid = assertTenantId(tenantId);
  if (!Array.isArray(objects) || !objects.length) throw invalidEligibility("objects must be a non-empty array");
  if (objects.length > MAX_BATCH_OBJECTS) throw invalidEligibility(`A batch may contain at most ${MAX_BATCH_OBJECTS} objects`);
  const normalizedAction = assertEligibilityAction(action);
  const items = [];
  const summary = { requested: objects.length, eligible: 0, blocked: 0, warning: 0, requires_review: 0, errors: 0 };
  for (const entry of objects.slice(0, MAX_BATCH_OBJECTS)) {
    const objectType = entry.object_type ?? entry.objectType;
    const objectId = entry.object_id ?? entry.objectId;
    try {
      const evaluation = evaluateEligibility(db, { tenantId: tid, objectType, objectId, action: normalizedAction, force });
      items.push(evaluation);
      if (evaluation.result === "BLOCKED") summary.blocked += 1;
      else if (evaluation.result === "WARNING") summary.warning += 1;
      else if (evaluation.result === "REQUIRES_REVIEW") summary.requires_review += 1;
      else summary.eligible += 1;
    } catch (error) {
      summary.errors += 1;
      items.push({
        object_type: objectType,
        object_id: objectId != null ? String(objectId) : null,
        action: normalizedAction,
        result: "ERROR",
        eligible: false,
        blocked: true,
        reasons: [{ code: error.code || "ERROR", severity: "BLOCKED", message: error.message }],
      });
    }
  }
  return { action: normalizedAction, summary, items, evaluated_at: nowIso() };
}

export function evaluatePurge(db, { tenantId, objectType, objectId, force = false } = {}) {
  return evaluateEligibility(db, { tenantId, objectType, objectId, action: "PURGE", force });
}

// Objects whose retention date for a stage has elapsed and that are in a state
// eligible for that stage. Used by the evaluation job to build a work list.
export function listDueObjects(db, { tenantId, action, limit = 500 } = {}) {
  const tid = assertTenantId(tenantId);
  const normalizedAction = assertEligibilityAction(action);
  const config = listConfig(db, tid);
  const cap = Math.min(Number(limit) || 500, Number(config.max_batch_size) || 500, 5000);
  const specs = {
    ARCHIVE: { dateColumn: "archive_eligible_at", states: ["INACTIVE"] },
    COLD_STORAGE: { dateColumn: "cold_storage_at", states: ["ARCHIVED"] },
    PURGE: { dateColumn: "purge_eligible_at", states: ["ARCHIVED", "COLD_STORAGE"] },
    INACTIVE: { dateColumn: null, states: ["ACTIVE"] },
  };
  const spec = specs[normalizedAction];
  const marks = spec.states.map(() => "?").join(", ");
  const clauses = ["tenant_id = ?", `current_state IN (${marks})`, "legal_hold_status <> 'ACTIVE'"];
  const params = [tid, ...spec.states];
  if (spec.dateColumn) {
    clauses.push(`${spec.dateColumn} IS NOT NULL AND ${spec.dateColumn} <= ?`);
    params.push(nowIso());
  }
  const rows = queryAll(
    db,
    `SELECT * FROM lc_object_lifecycle WHERE ${clauses.join(" AND ")} ORDER BY ${spec.dateColumn || "id"} ASC LIMIT ?`,
    [...params, cap]
  );
  return { action: normalizedAction, count: rows.length, items: rows };
}
