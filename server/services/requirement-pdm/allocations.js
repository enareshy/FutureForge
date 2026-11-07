// Requirement -> PDM allocation service.
//
// Allocations are stored as Requirements Manager relationships in the existing
// requirement_relationships table; this module adds PDM semantics on top: it
// resolves and validates the PDM/BOM target, enforces configuration gates,
// keeps allocation idempotent, records audit and publishes integration events.
// It never creates a parallel relationship store (mirrors
// requirements/relationships.js).
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { queryAllAsync, queryOneAsync, runAsync } from "../../db-async.js";
import { writeAudit, writeAuditAsync } from "../audit.js";
import { Relationships, Requirements } from "../requirements/index.js";
import { recordRequirementHistory, recordRequirementHistoryAsync } from "../requirements/history.js";
import {
  REQUIREMENT_SOURCE_TYPE,
  ALLOCATION_CODES,
  REQUIREMENT_PDM_EVENT_MAP,
} from "./constants.js";
import { normalizeAllocationInput, normalizeText, parseObject, paginateAllocations } from "./validation.js";
import { allocationNotFound, invalidTarget, effectivityInvalid } from "./errors.js";
import { resolveTarget, resolveTargetAsync, isReleased } from "./targets.js";
import { getConfig } from "./configuration.js";
import { publishRequirementPdmEvent, publishRequirementPdmEventAsync } from "./events.js";

function placeholders(values) {
  return values.map(() => "?").join(", ");
}

function allocationEvent(relationshipType, target) {
  if (relationshipType === "ALLOCATED_TO") {
    return target?.item_type === "PRODUCT" ? REQUIREMENT_PDM_EVENT_MAP.PRODUCT_ALLOCATED : REQUIREMENT_PDM_EVENT_MAP.ITEM_ALLOCATED;
  }
  if (relationshipType === "IMPLEMENTED_BY") return REQUIREMENT_PDM_EVENT_MAP.REVISION_ALLOCATED;
  if (relationshipType === "REPRESENTED_BY") return REQUIREMENT_PDM_EVENT_MAP.DATASET_ASSOCIATED;
  return REQUIREMENT_PDM_EVENT_MAP.TRACE_CREATED;
}

export function publicAllocation(row, { requirement = null, target = null } = {}) {
  if (!row) return null;
  const attrs = parseObject(row.attributes_json, {});
  const requirementId = Number(row.source_id);
  return {
    id: row.id,
    allocation_ref: row.relationship_ref || "",
    tenant_id: row.tenant_id,
    requirement_id: requirement?.id ?? (Number.isInteger(requirementId) ? requirementId : row.source_id),
    requirement_ref: requirement?.requirement_ref ?? attrs.requirement_ref ?? "",
    requirement_number: requirement?.requirement_number ?? attrs.requirement_number ?? "",
    requirement_object_id: requirement?.object_id ?? attrs.requirement_object_id ?? null,
    requirement_status: requirement?.status ?? "",
    relationship_type: row.relationship_type,
    target_type: row.target_type,
    target_id: row.target_id,
    target: target || null,
    status: row.status,
    effectivity_from: row.effectivity_from ?? null,
    effectivity_to: row.effectivity_to ?? null,
    revision_rule: attrs.revision_rule ?? null,
    configuration_context: attrs.configuration_context ?? "",
    attributes: attrs,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
  };
}

function allocationRowByRef(db, tenant, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOne(db, "SELECT * FROM requirement_relationships WHERE id = ? AND tenant_id = ?", [id, Number(tenant)]);
  }
  return queryOne(db, "SELECT * FROM requirement_relationships WHERE tenant_id = ? AND relationship_ref = ?", [Number(tenant), String(ref)]);
}

async function allocationRowByRefAsync(db, tenant, ref) {
  const id = Number(ref);
  if (Number.isInteger(id) && String(id) === String(ref).trim()) {
    return queryOneAsync(db, "SELECT * FROM requirement_relationships WHERE id = ? AND tenant_id = ?", [id, Number(tenant)]);
  }
  return queryOneAsync(db, "SELECT * FROM requirement_relationships WHERE tenant_id = ? AND relationship_ref = ?", [Number(tenant), String(ref)]);
}

export function getAllocationRow(db, tenantId, ref) {
  const row = allocationRowByRef(db, tenantId, ref);
  if (!row || !ALLOCATION_CODES.includes(row.relationship_type) || row.source_type !== REQUIREMENT_SOURCE_TYPE) return null;
  return row;
}

export async function getAllocationRowAsync(db, tenantId, ref) {
  const row = await allocationRowByRefAsync(db, tenantId, ref);
  if (!row || !ALLOCATION_CODES.includes(row.relationship_type) || row.source_type !== REQUIREMENT_SOURCE_TYPE) return null;
  return row;
}

function requirementMap(db, tenant, ids) {
  if (!ids.length) return new Map();
  const rows = queryAll(db, `SELECT id, requirement_ref, requirement_number, object_id, status FROM requirements WHERE tenant_id = ? AND id IN (${placeholders(ids)})`, [Number(tenant), ...ids]);
  return new Map(rows.map((row) => [Number(row.id), row]));
}

async function requirementMapAsync(db, tenant, ids) {
  if (!ids.length) return new Map();
  const rows = await queryAllAsync(db, `SELECT id, requirement_ref, requirement_number, object_id, status FROM requirements WHERE tenant_id = ? AND id IN (${placeholders(ids)})`, [Number(tenant), ...ids]);
  return new Map(rows.map((row) => [Number(row.id), row]));
}

function enrich(db, tenant, rows, { withTargets = true } = {}) {
  const ids = [...new Set(rows.map((row) => Number(row.source_id)).filter((id) => Number.isInteger(id)))];
  const reqs = requirementMap(db, tenant, ids);
  return rows.map((row) => {
    const requirement = reqs.get(Number(row.source_id)) || null;
    const target = withTargets ? resolveTarget(db, tenant, row.target_type, row.target_id) : null;
    return publicAllocation(row, { requirement, target });
  });
}

async function enrichAsync(db, tenant, rows, { withTargets = true } = {}) {
  const ids = [...new Set(rows.map((row) => Number(row.source_id)).filter((id) => Number.isInteger(id)))];
  const reqs = await requirementMapAsync(db, tenant, ids);
  const output = [];
  for (const row of rows) {
    const requirement = reqs.get(Number(row.source_id)) || null;
    const target = withTargets ? await resolveTargetAsync(db, tenant, row.target_type, row.target_id) : null;
    output.push(publicAllocation(row, { requirement, target }));
  }
  return output;
}

function allocationFilters({ requirementId, relationship_type, target_type, target_id, status } = {}) {
  const clauses = ["rr.tenant_id = ?", "rr.source_type = ?", `rr.relationship_type IN (${placeholders(ALLOCATION_CODES)})`];
  const params = [0, REQUIREMENT_SOURCE_TYPE, ...ALLOCATION_CODES];
  if (requirementId != null && String(requirementId).trim() !== "") {
    clauses.push("rr.source_id = ?");
    params.push(String(requirementId));
  }
  if (relationship_type) {
    clauses.push("rr.relationship_type = ?");
    params.push(String(relationship_type).toUpperCase());
  }
  if (target_type) {
    clauses.push("rr.target_type = ?");
    params.push(String(target_type).toLowerCase());
  }
  if (target_id != null && String(target_id).trim() !== "") {
    clauses.push("rr.target_id = ?");
    params.push(String(target_id));
  }
  if (status) {
    clauses.push("rr.status = ?");
    params.push(String(status).toUpperCase());
  }
  return { clauses, params };
}

export function listAllocations(db, tenantId, opts = {}) {
  const { clauses, params } = allocationFilters(opts);
  params[0] = Number(tenantId);
  const { limit, offset, page: currentPage } = paginateAllocations(opts);
  const where = `WHERE ${clauses.join(" AND ")}`;
  const total = Number(queryOne(db, `SELECT COUNT(*) AS c FROM requirement_relationships rr ${where}`, params)?.c || 0);
  const rows = queryAll(db, `SELECT rr.* FROM requirement_relationships rr ${where} ORDER BY rr.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: enrich(db, Number(tenantId), rows, { withTargets: opts.withTargets !== false }), total, page: currentPage, page_size: limit, source_module: "requirement-pdm" };
}

export async function listAllocationsAsync(db, tenantId, opts = {}) {
  const { clauses, params } = allocationFilters(opts);
  params[0] = Number(tenantId);
  const { limit, offset, page: currentPage } = paginateAllocations(opts);
  const where = `WHERE ${clauses.join(" AND ")}`;
  const row = await queryOneAsync(db, `SELECT COUNT(*) AS c FROM requirement_relationships rr ${where}`, params);
  const total = Number(row?.c || 0);
  const rows = await queryAllAsync(db, `SELECT rr.* FROM requirement_relationships rr ${where} ORDER BY rr.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  return { items: await enrichAsync(db, Number(tenantId), rows, { withTargets: opts.withTargets !== false }), total, page: currentPage, page_size: limit, source_module: "requirement-pdm" };
}

export function getAllocation(db, tenantId, ref) {
  const row = getAllocationRow(db, tenantId, ref);
  if (!row) throw allocationNotFound(ref);
  return enrich(db, Number(tenantId), [row], { withTargets: true })[0];
}

export async function getAllocationAsync(db, tenantId, ref) {
  const row = await getAllocationRowAsync(db, tenantId, ref);
  if (!row) throw allocationNotFound(ref);
  return (await enrichAsync(db, Number(tenantId), [row], { withTargets: true }))[0];
}

function assertEffectivity(effectivityTo) {
  if (!effectivityTo) return;
  const to = Date.parse(String(effectivityTo));
  if (Number.isFinite(to) && to < Date.now()) {
    throw effectivityInvalid("The allocation effectivity window has already ended", { effectivity_to: effectivityTo });
  }
}

function existingAllocationRow(db, tenant, input, requirement) {
  return queryOne(
    db,
    `SELECT * FROM requirement_relationships
      WHERE tenant_id = ? AND relationship_type = ? AND source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?`,
    [Number(tenant), input.relationship_type, REQUIREMENT_SOURCE_TYPE, String(requirement.id), input.target_type, input.target_id]
  );
}

async function existingAllocationRowAsync(db, tenant, input, requirement) {
  return queryOneAsync(
    db,
    `SELECT * FROM requirement_relationships
      WHERE tenant_id = ? AND relationship_type = ? AND source_type = ? AND source_id = ? AND target_type = ? AND target_id = ?`,
    [Number(tenant), input.relationship_type, REQUIREMENT_SOURCE_TYPE, String(requirement.id), input.target_type, input.target_id]
  );
}

function buildAttributes(input, requirement, target) {
  return {
    ...input.attributes,
    integration: "requirement-pdm",
    requirement_ref: requirement.requirement_ref,
    requirement_number: requirement.requirement_number,
    requirement_object_id: requirement.object_id ?? null,
    target_ref: target.ref,
    target_number: target.number,
    target_status: target.status,
    target_object_id: target.object_id ?? null,
    target_item_id: target.item_id ?? null,
    target_bom_type: target.bom_type ?? null,
    revision_rule: input.revision_rule || null,
    configuration_context: input.configuration_context || null,
  };
}

export function createAllocation(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeAllocationInput(body);
  const requirement = Requirements.requireRequirementRow(db, tenant, input.requirement_id);
  const target = resolveTarget(db, tenant, input.target_type, input.target_id);
  if (!target) throw invalidTarget(`${input.target_type} target not found`, { target_type: input.target_type, target_id: input.target_id });

  if (getConfig(db, tenant, "require_target_released") && !isReleased(target)) {
    throw invalidTarget(`${input.target_type} ${target.number} is not released`, { target_type: input.target_type, target_id: target.target_id, status: target.status });
  }
  if (getConfig(db, tenant, "enforce_effectivity")) assertEffectivity(input.effectivity_to);

  const attributes = buildAttributes(input, requirement, target);
  const existing = existingAllocationRow(db, tenant, input, requirement);
  if (existing) {
    if (existing.status === "ACTIVE") {
      return { created: false, reactivated: false, allocation: publicAllocation(existing, { requirement, target }) };
    }
    const ts = nowIso();
    run(db, "UPDATE requirement_relationships SET status = 'ACTIVE', effectivity_from = ?, effectivity_to = ?, attributes_json = ? WHERE id = ?", [
      input.effectivity_from ?? existing.effectivity_from ?? null,
      input.effectivity_to ?? existing.effectivity_to ?? null,
      JSON.stringify(attributes),
      existing.id,
    ]);
    const updated = queryOne(db, "SELECT * FROM requirement_relationships WHERE id = ?", [existing.id]);
    recordRequirementHistory(db, { tenantId: tenant, entityType: "RELATIONSHIP", entityId: existing.id, entityRef: existing.relationship_ref, action: "RELATIONSHIP_UPDATED", status: "ACTIVE", before: publicAllocation(existing), after: publicAllocation(updated), details: { relationship_type: input.relationship_type }, actor, ip });
    writeAudit(db, { actor, action: "requirement-pdm.allocation.reactivate", resourceType: "requirement_pdm_allocation", resourceId: existing.relationship_ref, details: { relationship_type: input.relationship_type }, ip });
    publishRequirementPdmEvent(db, { eventType: allocationEvent(input.relationship_type, target), objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, payload: { allocation_ref: existing.relationship_ref, target_type: input.target_type, target_id: input.target_id } }, actor);
    return { created: false, reactivated: true, allocation: publicAllocation(updated, { requirement, target }) };
  }

  const created = Relationships.createRelationship(
    db,
    tenant,
    {
      relationship_type: input.relationship_type,
      source_type: REQUIREMENT_SOURCE_TYPE,
      source_id: String(requirement.id),
      target_type: input.target_type,
      target_id: input.target_id,
      status: input.status || "ACTIVE",
      effectivity_from: input.effectivity_from,
      effectivity_to: input.effectivity_to,
      attributes,
    },
    actor,
    ip
  );

  writeAudit(db, { actor, action: "requirement-pdm.allocation.create", resourceType: "requirement_pdm_allocation", resourceId: created.relationship_ref, details: { relationship_type: input.relationship_type, target_type: input.target_type, target_id: input.target_id }, ip });
  publishRequirementPdmEvent(db, { eventType: allocationEvent(input.relationship_type, target), objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, payload: { allocation_ref: created.relationship_ref, target_type: input.target_type, target_id: input.target_id } }, actor);
  publishRequirementPdmEvent(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.TRACE_CREATED, objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, payload: { allocation_ref: created.relationship_ref, relationship_type: input.relationship_type, target_type: input.target_type, target_id: input.target_id } }, actor);

  return { created: true, reactivated: false, allocation: publicAllocation(queryOne(db, "SELECT * FROM requirement_relationships WHERE id = ?", [created.id]), { requirement, target }) };
}

export async function createAllocationAsync(db, tenantId, body = {}, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const input = normalizeAllocationInput(body);
  const requirement = await Requirements.requireRequirementRowAsync(db, tenant, input.requirement_id);
  const target = await resolveTargetAsync(db, tenant, input.target_type, input.target_id);
  if (!target) throw invalidTarget(`${input.target_type} target not found`, { target_type: input.target_type, target_id: input.target_id });

  if (getConfig(db, tenant, "require_target_released") && !isReleased(target)) {
    throw invalidTarget(`${input.target_type} ${target.number} is not released`, { target_type: input.target_type, target_id: target.target_id, status: target.status });
  }
  if (getConfig(db, tenant, "enforce_effectivity")) assertEffectivity(input.effectivity_to);

  const attributes = buildAttributes(input, requirement, target);
  const existing = await existingAllocationRowAsync(db, tenant, input, requirement);
  if (existing) {
    if (existing.status === "ACTIVE") {
      return { created: false, reactivated: false, allocation: publicAllocation(existing, { requirement, target }) };
    }
    await runAsync(db, "UPDATE requirement_relationships SET status = 'ACTIVE', effectivity_from = ?, effectivity_to = ?, attributes_json = ? WHERE id = ?", [
      input.effectivity_from ?? existing.effectivity_from ?? null,
      input.effectivity_to ?? existing.effectivity_to ?? null,
      JSON.stringify(attributes),
      existing.id,
    ]);
    const updated = await queryOneAsync(db, "SELECT * FROM requirement_relationships WHERE id = ?", [existing.id]);
    await recordRequirementHistoryAsync(db, { tenantId: tenant, entityType: "RELATIONSHIP", entityId: existing.id, entityRef: existing.relationship_ref, action: "RELATIONSHIP_UPDATED", status: "ACTIVE", before: publicAllocation(existing), after: publicAllocation(updated), details: { relationship_type: input.relationship_type }, actor, ip });
    await writeAuditAsync(db, { actor, action: "requirement-pdm.allocation.reactivate", resourceType: "requirement_pdm_allocation", resourceId: existing.relationship_ref, details: { relationship_type: input.relationship_type }, ip });
    await publishRequirementPdmEventAsync(db, { eventType: allocationEvent(input.relationship_type, target), objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, payload: { allocation_ref: existing.relationship_ref, target_type: input.target_type, target_id: input.target_id } }, actor);
    return { created: false, reactivated: true, allocation: publicAllocation(updated, { requirement, target }) };
  }

  const created = await Relationships.createRelationshipAsync(
    db,
    tenant,
    {
      relationship_type: input.relationship_type,
      source_type: REQUIREMENT_SOURCE_TYPE,
      source_id: String(requirement.id),
      target_type: input.target_type,
      target_id: input.target_id,
      status: input.status || "ACTIVE",
      effectivity_from: input.effectivity_from,
      effectivity_to: input.effectivity_to,
      attributes,
    },
    actor,
    ip
  );

  await writeAuditAsync(db, { actor, action: "requirement-pdm.allocation.create", resourceType: "requirement_pdm_allocation", resourceId: created.relationship_ref, details: { relationship_type: input.relationship_type, target_type: input.target_type, target_id: input.target_id }, ip });
  await publishRequirementPdmEventAsync(db, { eventType: allocationEvent(input.relationship_type, target), objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, payload: { allocation_ref: created.relationship_ref, target_type: input.target_type, target_id: input.target_id } }, actor);
  await publishRequirementPdmEventAsync(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.TRACE_CREATED, objectType: "requirement", objectId: String(requirement.id), tenantId: tenant, payload: { allocation_ref: created.relationship_ref, relationship_type: input.relationship_type, target_type: input.target_type, target_id: input.target_id } }, actor);

  const row = await queryOneAsync(db, "SELECT * FROM requirement_relationships WHERE id = ?", [created.id]);
  return { created: true, reactivated: false, allocation: publicAllocation(row, { requirement, target }) };
}

export function removeAllocation(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = getAllocationRow(db, tenant, ref);
  if (!row) throw allocationNotFound(ref);
  const requirement = Requirements.getRequirementRow(db, tenant, row.source_id);
  const target = resolveTarget(db, tenant, row.target_type, row.target_id);
  Relationships.deleteRelationship(db, tenant, row.relationship_ref, actor, ip);
  writeAudit(db, { actor, action: "requirement-pdm.allocation.remove", resourceType: "requirement_pdm_allocation", resourceId: row.relationship_ref, details: { relationship_type: row.relationship_type, target_type: row.target_type, target_id: row.target_id }, ip });
  publishRequirementPdmEvent(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.TRACE_REMOVED, objectType: "requirement", objectId: String(row.source_id), tenantId: tenant, payload: { allocation_ref: row.relationship_ref, relationship_type: row.relationship_type, target_type: row.target_type, target_id: row.target_id } }, actor);
  return { removed: true, allocation: publicAllocation(row, { requirement, target }) };
}

export async function removeAllocationAsync(db, tenantId, ref, actor = null, ip = null) {
  const tenant = Number(tenantId);
  const row = await getAllocationRowAsync(db, tenant, ref);
  if (!row) throw allocationNotFound(ref);
  const requirement = await Requirements.getRequirementRowAsync(db, tenant, row.source_id);
  const target = await resolveTargetAsync(db, tenant, row.target_type, row.target_id);
  await Relationships.deleteRelationshipAsync(db, tenant, row.relationship_ref, actor, ip);
  await writeAuditAsync(db, { actor, action: "requirement-pdm.allocation.remove", resourceType: "requirement_pdm_allocation", resourceId: row.relationship_ref, details: { relationship_type: row.relationship_type, target_type: row.target_type, target_id: row.target_id }, ip });
  await publishRequirementPdmEventAsync(db, { eventType: REQUIREMENT_PDM_EVENT_MAP.TRACE_REMOVED, objectType: "requirement", objectId: String(row.source_id), tenantId: tenant, payload: { allocation_ref: row.relationship_ref, relationship_type: row.relationship_type, target_type: row.target_type, target_id: row.target_id } }, actor);
  return { removed: true, allocation: publicAllocation(row, { requirement, target }) };
}

// Reverse navigation: every PDM allocation attached to one requirement.
export function listRequirementAllocations(db, tenantId, requirementRef, opts = {}) {
  const tenant = Number(tenantId);
  const requirement = Requirements.requireRequirementRow(db, tenant, requirementRef);
  const clauses = ["tenant_id = ?", "source_type = ?", "source_id = ?", `relationship_type IN (${placeholders(ALLOCATION_CODES)})`];
  const params = [tenant, REQUIREMENT_SOURCE_TYPE, String(requirement.id), ...ALLOCATION_CODES];
  if (opts.relationship_type) {
    clauses.push("relationship_type = ?");
    params.push(String(opts.relationship_type).toUpperCase());
  }
  if (opts.status) {
    clauses.push("status = ?");
    params.push(String(opts.status).toUpperCase());
  }
  const rows = queryAll(db, `SELECT * FROM requirement_relationships WHERE ${clauses.join(" AND ")} ORDER BY id DESC`, params);
  const items = enrich(db, tenant, rows, { withTargets: opts.withTargets !== false });
  return { requirement_id: requirement.id, requirement_ref: requirement.requirement_ref, items, total: items.length, source_module: "requirement-pdm" };
}

export async function listRequirementAllocationsAsync(db, tenantId, requirementRef, opts = {}) {
  const tenant = Number(tenantId);
  const requirement = await Requirements.requireRequirementRowAsync(db, tenant, requirementRef);
  const clauses = ["tenant_id = ?", "source_type = ?", "source_id = ?", `relationship_type IN (${placeholders(ALLOCATION_CODES)})`];
  const params = [tenant, REQUIREMENT_SOURCE_TYPE, String(requirement.id), ...ALLOCATION_CODES];
  if (opts.relationship_type) {
    clauses.push("relationship_type = ?");
    params.push(String(opts.relationship_type).toUpperCase());
  }
  if (opts.status) {
    clauses.push("status = ?");
    params.push(String(opts.status).toUpperCase());
  }
  const rows = await queryAllAsync(db, `SELECT * FROM requirement_relationships WHERE ${clauses.join(" AND ")} ORDER BY id DESC`, params);
  const items = await enrichAsync(db, tenant, rows, { withTargets: opts.withTargets !== false });
  return { requirement_id: requirement.id, requirement_ref: requirement.requirement_ref, items, total: items.length, source_module: "requirement-pdm" };
}

function coverageFor(items) {
  const byRelationship = Object.fromEntries(ALLOCATION_CODES.map((code) => [code, 0]));
  for (const item of items) {
    if (item.status === "ACTIVE") byRelationship[item.relationship_type] = (byRelationship[item.relationship_type] || 0) + 1;
  }
  const has = (code) => (byRelationship[code] || 0) > 0;
  let coverage = "UNALLOCATED";
  if (has("SATISFIED_BY")) coverage = "SATISFIED";
  else if (has("ALLOCATED_TO") || has("REALIZED_BY") || has("IMPLEMENTED_BY")) coverage = "ALLOCATED";
  else if (items.length > 0) coverage = "PARTIAL";
  return { coverage, by_relationship: byRelationship, active: items.filter((item) => item.status === "ACTIVE").length, total: items.length };
}

export function allocationCoverage(db, tenantId, requirementRef) {
  const result = listRequirementAllocations(db, tenantId, requirementRef, { withTargets: false });
  return { requirement_id: result.requirement_id, requirement_ref: result.requirement_ref, ...coverageFor(result.items) };
}

export async function allocationCoverageAsync(db, tenantId, requirementRef) {
  const result = await listRequirementAllocationsAsync(db, tenantId, requirementRef, { withTargets: false });
  return { requirement_id: result.requirement_id, requirement_ref: result.requirement_ref, ...coverageFor(result.items) };
}

export { normalizeText };
