// Compatibility, effectivity and configuration resolution for Requirement -> PDM
// allocations.
//
// Nothing here invents revision or configuration semantics: effective revisions
// come from the PDM revision-rule engine, BOM effectivity comes from the BOM
// effectivity kernel, and configuration rules come from the PDM configuration
// rule engine. This module only relates those existing results back to an
// allocation and reports a stable COMPATIBLE / INCOMPATIBLE / STALE / UNKNOWN
// status (mirrors pdm/revision-rules.js and bom/effectivity.js).
import { run, nowIso } from "../../db.js";
import { runAsync } from "../../db-async.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { RevisionRules, ConfigurationRules } from "../pdm/index.js";
import { Effectivity as BomEffectivity } from "../bom/index.js";
import {
  COMPATIBILITY_STATUSES,
  REQUIREMENT_PDM_EVENT_MAP,
} from "./constants.js";
import { parseObject } from "./validation.js";
import { resolveTarget, resolveTargetAsync } from "./targets.js";
import { getAllocationRow, getAllocationRowAsync, listRequirementAllocations, listRequirementAllocationsAsync } from "./allocations.js";
import { getConfig } from "./configuration.js";
import { publishRequirementPdmEvent, publishRequirementPdmEventAsync } from "./events.js";
import { invalidConfiguration } from "./errors.js";

const LATEST_SENTINEL = "LATEST";

function pickRevisionRule(tenantId, db, override) {
  if (override) return override;
  const configured = getConfig(db, tenantId, "default_revision_rule");
  if (!configured || String(configured).toUpperCase() === LATEST_SENTINEL) return null;
  return configured;
}

function withinWindow(from, to, at) {
  if (from && String(from) > String(at)) return false;
  if (to && String(to) < String(at)) return false;
  return true;
}

function effectiveContext(allocation, target, options) {
  return {
    as_of: options.asOf || options.as_of || null,
    variant_code: options.variantCode || options.variant_code || target?.variant_code || null,
    configuration_context: options.configurationContext || options.configuration_context || allocation.configuration_context || target?.configuration_context || "",
    requirement_id: allocation.requirement_id,
    requirement_type: options.requirementType || null,
  };
}

function resolveEffectiveRevision(db, tenant, target, ruleCode, context) {
  if (!target) return { resolved: null, error: null };
  if (target.target_type === "bom_revision") return { resolved: null, error: null };
  const itemId = target.item_id ?? null;
  if (!itemId) return { resolved: null, error: "item_unresolved" };
  try {
    const resolved = RevisionRules.resolveRevisionRule(db, tenant, { itemId, ruleCode: ruleCode || null, context });
    return { resolved, error: null };
  } catch (error) {
    return { resolved: null, error: error?.code || "revision_rule_unavailable" };
  }
}

export function evaluateAllocation(db, tenantId, allocation, options = {}) {
  const tenant = Number(tenantId);
  const target = allocation.target || resolveTarget(db, tenant, allocation.target_type, allocation.target_id);
  const at = options.at || nowIso();
  const context = effectiveContext(allocation, target, options);
  const ruleCode = pickRevisionRule(tenant, db, options.revisionRule || options.revision_rule);
  const { resolved, error } = resolveEffectiveRevision(db, tenant, target, ruleCode, context);

  const reasons = [];
  let status = "COMPATIBLE";

  const windowActive = withinWindow(allocation.effectivity_from, allocation.effectivity_to, at);
  let targetEffectivityActive = true;
  if (target) targetEffectivityActive = withinWindow(target.effectivity_from, target.effectivity_to, at);
  if (allocation.status !== "ACTIVE") {
    status = "UNKNOWN";
    reasons.push("allocation_inactive");
  } else if (!target) {
    status = "UNKNOWN";
    reasons.push("target_missing");
  } else if (!windowActive) {
    status = "INCOMPATIBLE";
    reasons.push("allocation_effectivity_expired");
  } else if (!targetEffectivityActive) {
    status = "INCOMPATIBLE";
    reasons.push("target_effectivity_expired");
  }

  let configuration = { allocated: allocation.configuration_context || "", effective: target?.configuration_context || "", matched: false, rule: null };
  if (status === "COMPATIBLE" && configuration.allocated && configuration.effective && configuration.allocated !== configuration.effective) {
    status = "INCOMPATIBLE";
    reasons.push("configuration_context_mismatch");
  }
  const explicitRule = options.configurationRule || options.configurationRuleCode || null;
  if (status === "COMPATIBLE" && explicitRule) {
    try {
      const evaluated = ConfigurationRules.evaluateConfigurationRule(db, tenant, { ruleCode: explicitRule, context });
      configuration = { ...configuration, matched: evaluated.applicable, rule: evaluated.rule };
      if (!evaluated.applicable) {
        status = "INCOMPATIBLE";
        reasons.push("configuration_rule_failed");
      }
    } catch (err) {
      throw invalidConfiguration(`Configuration rule ${explicitRule} could not be evaluated: ${err?.message || err}`);
    }
  }

  const allocatedRevision = target && (target.target_type === "pdm_revision" || target.target_type === "bom_revision")
    ? { id: target.target_id, revision_number: target.revision_number, status: target.status }
    : null;
  const effectiveRevision = resolved?.revision
    ? { id: resolved.revision.id, revision_number: resolved.revision.revision_number, status: resolved.revision.status, revision_sequence: resolved.revision.revision_sequence }
    : null;

  if (status === "COMPATIBLE" && error) {
    status = "UNKNOWN";
    reasons.push(error);
  }
  if (status === "COMPATIBLE" && allocatedRevision && effectiveRevision && String(allocatedRevision.id) !== String(effectiveRevision.id)) {
    status = "STALE";
    reasons.push("revision_superseded");
  }

  return {
    allocation_ref: allocation.allocation_ref,
    relationship_type: allocation.relationship_type,
    target_type: allocation.target_type,
    target_id: allocation.target_id,
    status,
    reasons,
    at,
    effectivity: { active: windowActive, target_active: targetEffectivityActive, from: allocation.effectivity_from ?? null, to: allocation.effectivity_to ?? null },
    configuration,
    revision: {
      allocated: allocatedRevision,
      effective: effectiveRevision,
      rule: resolved?.rule ? { id: resolved.rule.id, code: resolved.rule.code, rule_type: resolved.rule.rule_type } : null,
      candidates: resolved?.candidates ?? 0,
    },
  };
}

export async function evaluateAllocationAsync(db, tenantId, allocation, options = {}) {
  const target = allocation.target || (await resolveTargetAsync(db, Number(tenantId), allocation.target_type, allocation.target_id));
  const detailed = { ...allocation, target };
  return evaluateAllocation(db, tenantId, detailed, options);
}

function persistCompatibility(db, tenant, row, report) {
  const attributes = parseObject(row.attributes_json, {});
  const previous = attributes.compatibility || null;
  attributes.compatibility = report.status;
  attributes.compatibility_reasons = report.reasons;
  attributes.compatibility_checked_at = report.at;
  run(db, "UPDATE requirement_relationships SET attributes_json = ? WHERE id = ?", [JSON.stringify(attributes), row.id]);
  return { previous, current: report.status, changed: previous !== report.status };
}

async function persistCompatibilityAsync(db, tenant, row, report) {
  const attributes = parseObject(row.attributes_json, {});
  const previous = attributes.compatibility || null;
  attributes.compatibility = report.status;
  attributes.compatibility_reasons = report.reasons;
  attributes.compatibility_checked_at = report.at;
  await runAsync(db, "UPDATE requirement_relationships SET attributes_json = ? WHERE id = ?", [JSON.stringify(attributes), row.id]);
  return { previous, current: report.status, changed: previous !== report.status };
}

function allocationFromRow(db, tenant, row) {
  const attributes = parseObject(row.attributes_json, {});
  return {
    id: row.id,
    allocation_ref: row.relationship_ref,
    relationship_type: row.relationship_type,
    target_type: row.target_type,
    target_id: row.target_id,
    status: row.status,
    configuration_context: attributes.configuration_context || "",
    effectivity_from: row.effectivity_from,
    effectivity_to: row.effectivity_to,
    requirement_id: Number(row.source_id),
    target: resolveTarget(db, tenant, row.target_type, row.target_id),
  };
}

async function allocationFromRowAsync(db, tenant, row) {
  const attributes = parseObject(row.attributes_json, {});
  return {
    id: row.id,
    allocation_ref: row.relationship_ref,
    relationship_type: row.relationship_type,
    target_type: row.target_type,
    target_id: row.target_id,
    status: row.status,
    configuration_context: attributes.configuration_context || "",
    effectivity_from: row.effectivity_from,
    effectivity_to: row.effectivity_to,
    requirement_id: Number(row.source_id),
    target: await resolveTargetAsync(db, tenant, row.target_type, row.target_id),
  };
}

export function checkAllocation(db, tenantId, ref, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = getAllocationRow(db, tenant, ref);
  if (!row) return null;
  const report = evaluateAllocation(db, tenant, allocationFromRow(db, tenant, row), options);
  const change = persistCompatibility(db, tenant, row, report);
  writeAudit(db, { actor, action: "requirement-pdm.compatibility.check", resourceType: "requirement_pdm_allocation", resourceId: row.relationship_ref, details: { status: report.status, reasons: report.reasons }, ip });
  if (change.changed) {
    publishRequirementPdmEvent(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.COMPATIBILITY_CHANGED, objectType: "requirement", objectId: String(row.source_id), tenantId: tenant, payload: { allocation_ref: row.relationship_ref, from: change.previous, to: change.current, reasons: report.reasons } }, actor);
  }
  return { ...report, previous_status: change.previous, changed: change.changed };
}

export async function checkAllocationAsync(db, tenantId, ref, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await getAllocationRowAsync(db, tenant, ref);
  if (!row) return null;
  const report = await evaluateAllocationAsync(db, tenant, await allocationFromRowAsync(db, tenant, row), options);
  const change = await persistCompatibilityAsync(db, tenant, row, report);
  await writeAuditAsync(db, { actor, action: "requirement-pdm.compatibility.check", resourceType: "requirement_pdm_allocation", resourceId: row.relationship_ref, details: { status: report.status, reasons: report.reasons }, ip });
  if (change.changed) {
    await publishRequirementPdmEventAsync(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.COMPATIBILITY_CHANGED, objectType: "requirement", objectId: String(row.source_id), tenantId: tenant, payload: { allocation_ref: row.relationship_ref, from: change.previous, to: change.current, reasons: report.reasons } }, actor);
  }
  return { ...report, previous_status: change.previous, changed: change.changed };
}

function summarize(reports) {
  const counts = Object.fromEntries(COMPATIBILITY_STATUSES.map((code) => [code, 0]));
  for (const report of reports) counts[report.status] = (counts[report.status] || 0) + 1;
  const stale = reports.filter((report) => report.status === "STALE").map((report) => report.allocation_ref);
  const incompatible = reports.filter((report) => report.status === "INCOMPATIBLE").map((report) => report.allocation_ref);
  return { total: reports.length, counts, stale, incompatible };
}

export function checkRequirementCompatibilities(db, tenantId, requirementRef, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const list = listRequirementAllocations(db, tenant, requirementRef, { withTargets: true });
  const reports = list.items.map((allocation) => {
    const row = getAllocationRow(db, tenant, allocation.id);
    const report = evaluateAllocation(db, tenant, allocation, options);
    if (row) persistCompatibility(db, tenant, row, report);
    return report;
  });
  writeAudit(db, { actor, action: "requirement-pdm.compatibility.check-requirement", resourceType: "requirement", resourceId: requirementRef, details: summarize(reports), ip });
  return { requirement_id: list.requirement_id, requirement_ref: list.requirement_ref, reports, summary: summarize(reports), source_module: "requirement-pdm" };
}

export async function checkRequirementCompatibilitiesAsync(db, tenantId, requirementRef, options = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const list = await listRequirementAllocationsAsync(db, tenant, requirementRef, { withTargets: true });
  const reports = [];
  for (const allocation of list.items) {
    const row = await getAllocationRowAsync(db, tenant, allocation.id);
    const report = await evaluateAllocationAsync(db, tenant, allocation, options);
    if (row) await persistCompatibilityAsync(db, tenant, row, report);
    reports.push(report);
  }
  await writeAuditAsync(db, { actor, action: "requirement-pdm.compatibility.check-requirement", resourceType: "requirement", resourceId: requirementRef, details: summarize(reports), ip });
  return { requirement_id: list.requirement_id, requirement_ref: list.requirement_ref, reports, summary: summarize(reports), source_module: "requirement-pdm" };
}
