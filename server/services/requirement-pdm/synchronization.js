// Change synchronization for the Requirement -> PDM integration.
//
// When PDM artifacts change, the requirements allocated to them can become
// stale or incompatible. This module detects the impacted allocations from the
// authoritative `requirement_relationships` store, reuses the compatibility
// service to re-evaluate each one against the live PDM revision/configuration/
// effectivity, and raises impact events and notifications. It never duplicates
// PDM revision logic (mirrors pdm/jobs.js and change/affected-items.js).
import { queryAll, queryOne } from "../../db.js";
import { queryAllAsync, queryOneAsync } from "../../db-async.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { notifyUser, notifyUserAsync } from "../notifications.js";
import { checkAllocation, checkAllocationAsync } from "./compatibility.js";
import { getAllocationRow, getAllocationRowAsync } from "./allocations.js";
import { getConfig } from "./configuration.js";
import { publishRequirementPdmEvent, publishRequirementPdmEventAsync } from "./events.js";
import {
  REQUIREMENT_SOURCE_TYPE,
  ALLOCATION_CODES,
  REQUIREMENT_PDM_EVENT_MAP,
} from "./constants.js";

const IMPACT_STATUSES = new Set(["INCOMPATIBLE", "STALE"]);

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function syncLimit(db, tenantId, requested) {
  const configured = Number(getConfig(db, tenantId, "sync_batch_size")) || 200;
  const value = Number(requested);
  if (Number.isFinite(value) && value > 0) return Math.min(value, 5000);
  return Math.min(configured, 5000);
}

function impactedFilters({ targetType, targetId, requirementId, status = "ACTIVE" } = {}) {
  const clauses = ["tenant_id = ?", "source_type = ?", `relationship_type IN (${placeholders(ALLOCATION_CODES)})`];
  const params = [0, REQUIREMENT_SOURCE_TYPE, ...ALLOCATION_CODES];
  if (targetType) {
    clauses.push("target_type = ?");
    params.push(String(targetType).toLowerCase());
  }
  if (targetId != null && String(targetId).trim() !== "") {
    clauses.push("target_id = ?");
    params.push(String(targetId));
  }
  if (requirementId != null && String(requirementId).trim() !== "") {
    clauses.push("source_id = ?");
    params.push(String(requirementId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(String(status).toUpperCase());
  }
  return { clauses, params };
}

export function impactedAllocations(db, tenantId, options = {}) {
  const { clauses, params } = impactedFilters(options);
  params[0] = Number(tenantId);
  const limit = syncLimit(db, tenantId, options.limit);
  return queryAll(db, `SELECT * FROM requirement_relationships WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`, [...params, limit]);
}

export async function impactedAllocationsAsync(db, tenantId, options = {}) {
  const { clauses, params } = impactedFilters(options);
  params[0] = Number(tenantId);
  const limit = syncLimit(db, tenantId, options.limit);
  return queryAllAsync(db, `SELECT * FROM requirement_relationships WHERE ${clauses.join(" AND ")} ORDER BY id LIMIT ?`, [...params, limit]);
}

// Distinct requirements allocated to a PDM artifact — the change-impact view.
export function impactedRequirements(db, tenantId, { targetType, targetId, limit } = {}) {
  const rows = impactedAllocations(db, tenantId, { targetType, targetId, limit });
  const ids = [...new Set(rows.map((row) => Number(row.source_id)))];
  if (!ids.length) return { requirements: [], total: 0, allocations: rows.length };
  const reqs = queryAll(db, `SELECT id, requirement_ref, requirement_number, title, status, owner_user_id FROM requirements WHERE tenant_id = ? AND id IN (${placeholders(ids)})`, [Number(tenantId), ...ids]);
  return {
    requirements: reqs.map((row) => ({
      requirement_id: row.id,
      requirement_ref: row.requirement_ref,
      requirement_number: row.requirement_number,
      title: row.title,
      status: row.status,
      owner_user_id: row.owner_user_id ?? null,
      allocation_count: rows.filter((allocation) => Number(allocation.source_id) === Number(row.id)).length,
    })),
    total: reqs.length,
    allocations: rows.length,
  };
}

export async function impactedRequirementsAsync(db, tenantId, { targetType, targetId, limit } = {}) {
  const rows = await impactedAllocationsAsync(db, tenantId, { targetType, targetId, limit });
  const ids = [...new Set(rows.map((row) => Number(row.source_id)))];
  if (!ids.length) return { requirements: [], total: 0, allocations: rows.length };
  const reqs = await queryAllAsync(db, `SELECT id, requirement_ref, requirement_number, title, status, owner_user_id FROM requirements WHERE tenant_id = ? AND id IN (${placeholders(ids)})`, [Number(tenantId), ...ids]);
  return {
    requirements: reqs.map((row) => ({
      requirement_id: row.id,
      requirement_ref: row.requirement_ref,
      requirement_number: row.requirement_number,
      title: row.title,
      status: row.status,
      owner_user_id: row.owner_user_id ?? null,
      allocation_count: rows.filter((allocation) => Number(allocation.source_id) === Number(row.id)).length,
    })),
    total: reqs.length,
    allocations: rows.length,
  };
}

function requirementOwner(db, tenantId, requirementId) {
  return queryOne(db, "SELECT id, requirement_ref, requirement_number, title, owner_user_id FROM requirements WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(requirementId)]);
}

async function requirementOwnerAsync(db, tenantId, requirementId) {
  return queryOneAsync(db, "SELECT id, requirement_ref, requirement_number, title, owner_user_id FROM requirements WHERE tenant_id = ? AND id = ?", [Number(tenantId), Number(requirementId)]);
}

function summarize(rows, evaluations, failures) {
  const changed = evaluations.filter((entry) => entry.changed).length;
  const incompatible = evaluations.filter((entry) => entry.status === "INCOMPATIBLE").length;
  const stale = evaluations.filter((entry) => entry.status === "STALE").length;
  let status = "COMPLETED";
  if (!rows.length) status = "NOOP";
  else if (failures.length && failures.length === rows.length) status = "FAILED";
  else if (failures.length) status = "PARTIAL";
  return {
    source_module: "requirement-pdm",
    status,
    evaluated: evaluations.length,
    changed,
    incompatible,
    stale,
    failed: failures.length,
    total_candidates: rows.length,
    evaluations,
    failures,
  };
}

export function synchronize(db, tenantId, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const rows = impactedAllocations(db, tenant, options);
  const evaluations = [];
  const failures = [];
  const notify = options.notify ?? getConfig(db, tenant, "notify_on_allocation");
  const notified = new Set();

  for (const row of rows) {
    try {
      const report = checkAllocation(db, tenant, row.relationship_ref, options, actor, ip);
      if (!report) continue;
      evaluations.push({
        allocation_ref: row.relationship_ref,
        requirement_id: Number(row.source_id),
        target_type: row.target_type,
        target_id: row.target_id,
        previous_status: report.previous_status,
        status: report.status,
        reasons: report.reasons,
        changed: report.changed,
      });
      if (report.changed && IMPACT_STATUSES.has(report.status)) {
        publishRequirementPdmEvent(
          db,
          {
            eventType: REQUIREMENT_PDM_EVENT_MAP.IMPACT_DETECTED,
            objectType: "requirement",
            objectId: String(row.source_id),
            tenantId: tenant,
            payload: { allocation_ref: row.relationship_ref, status: report.status, reasons: report.reasons, target_type: row.target_type, target_id: row.target_id },
          },
          actor
        );
        if (notify && !notified.has(Number(row.source_id))) {
          const requirement = requirementOwner(db, tenant, row.source_id);
          if (requirement?.owner_user_id) {
            notifyUser(
              db,
              requirement.owner_user_id,
              {
                event_type: "requirement_pdm.impact_detected",
                source_module: "requirement-pdm",
                object_type: "requirement",
                object_id: String(requirement.id),
                object_name: requirement.title || requirement.requirement_number,
                payload: { status: report.status, reasons: report.reasons, allocation_ref: row.relationship_ref },
              },
              { actor, tenantId: tenant, ip }
            );
          }
        }
        notified.add(Number(row.source_id));
      }
    } catch (error) {
      const failure = { allocation_ref: row.relationship_ref, requirement_id: Number(row.source_id), error: error?.message || String(error), code: error?.code || "synchronization_failed" };
      failures.push(failure);
      publishRequirementPdmEvent(
        db,
        { eventType: REQUIREMENT_PDM_EVENT_MAP.SYNCHRONIZATION_FAILED, objectType: "requirement", objectId: String(row.source_id), tenantId: tenant, payload: failure },
        actor
      );
    }
  }

  const summary = summarize(rows, evaluations, failures);
  writeAudit(db, { actor, action: "requirement-pdm.synchronize", resourceType: "requirement_pdm_synchronization", resourceId: null, details: { status: summary.status, evaluated: summary.evaluated, changed: summary.changed, failed: summary.failed }, ip });
  return summary;
}

export async function synchronizeAsync(db, tenantId, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const rows = await impactedAllocationsAsync(db, tenant, options);
  const evaluations = [];
  const failures = [];
  const notify = options.notify ?? getConfig(db, tenant, "notify_on_allocation");
  const notified = new Set();

  for (const row of rows) {
    try {
      const report = await checkAllocationAsync(db, tenant, row.relationship_ref, options, actor, ip);
      if (!report) continue;
      evaluations.push({
        allocation_ref: row.relationship_ref,
        requirement_id: Number(row.source_id),
        target_type: row.target_type,
        target_id: row.target_id,
        previous_status: report.previous_status,
        status: report.status,
        reasons: report.reasons,
        changed: report.changed,
      });
      if (report.changed && IMPACT_STATUSES.has(report.status)) {
        await publishRequirementPdmEventAsync(
          db,
          {
            eventType: REQUIREMENT_PDM_EVENT_MAP.IMPACT_DETECTED,
            objectType: "requirement",
            objectId: String(row.source_id),
            tenantId: tenant,
            payload: { allocation_ref: row.relationship_ref, status: report.status, reasons: report.reasons, target_type: row.target_type, target_id: row.target_id },
          },
          actor
        );
        if (notify && !notified.has(Number(row.source_id))) {
          const requirement = await requirementOwnerAsync(db, tenant, row.source_id);
          if (requirement?.owner_user_id) {
            await notifyUserAsync(
              db,
              requirement.owner_user_id,
              {
                event_type: "requirement_pdm.impact_detected",
                source_module: "requirement-pdm",
                object_type: "requirement",
                object_id: String(requirement.id),
                object_name: requirement.title || requirement.requirement_number,
                payload: { status: report.status, reasons: report.reasons, allocation_ref: row.relationship_ref },
              },
              { actor, tenantId: tenant, ip }
            );
          }
        }
        notified.add(Number(row.source_id));
      }
    } catch (error) {
      const failure = { allocation_ref: row.relationship_ref, requirement_id: Number(row.source_id), error: error?.message || String(error), code: error?.code || "synchronization_failed" };
      failures.push(failure);
      await publishRequirementPdmEventAsync(
        db,
        { eventType: REQUIREMENT_PDM_EVENT_MAP.SYNCHRONIZATION_FAILED, objectType: "requirement", objectId: String(row.source_id), tenantId: tenant, payload: failure },
        actor
      );
    }
  }

  const summary = summarize(rows, evaluations, failures);
  await writeAuditAsync(db, { actor, action: "requirement-pdm.synchronize", resourceType: "requirement_pdm_synchronization", resourceId: null, details: { status: summary.status, evaluated: summary.evaluated, changed: summary.changed, failed: summary.failed }, ip });
  return summary;
}

// Synchronizes one allocation by ref (used by the API "check & sync" action).
export function synchronizeAllocation(db, tenantId, ref, options = {}, actor = null, ip = null) {
  const row = getAllocationRow(db, tenantId, ref);
  if (!row) return null;
  return checkAllocation(db, Number(tenantId), row.relationship_ref, options, actor, ip);
}

export async function synchronizeAllocationAsync(db, tenantId, ref, options = {}, actor = null, ip = null) {
  const row = await getAllocationRowAsync(db, tenantId, ref);
  if (!row) return null;
  return checkAllocationAsync(db, Number(tenantId), row.relationship_ref, options, actor, ip);
}
