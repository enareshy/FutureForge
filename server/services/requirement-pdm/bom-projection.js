// Requirement -> EBOM / MBOM / BOP structure projection.
//
// EBOM, MBOM and BOP are the platform's existing BOM engine: a single
// `bom_headers`/`bom_revisions`/`bom_lines` model where the concrete structure is
// derived from the header's `bom_type`. This module is a read-only projection
// that connects requirements to those structures through the existing allocation
// edges and exposes structure-aware, revision-/configuration-/effectivity-aware
// views. It never duplicates items, revisions, lines, occurrences, quantities,
// find numbers, effectivity or configuration.
import { Requirements } from "../requirements/index.js";
import { Structure as BomStructure } from "../bom/index.js";
import { filterByVariant } from "../bom/variants.js";
import { filterByEffectivity } from "../bom/effectivity.js";
import { listRequirementAllocations, listRequirementAllocationsAsync, listAllocations, listAllocationsAsync } from "./allocations.js";
import { resolveTarget, resolveTargetAsync } from "./targets.js";
import { PDM_NODE_TYPES } from "./constants.js";

const STRUCTURE_TYPES = Object.freeze(["EBOM", "MBOM", "BOP"]);
const RELEASED_STATUSES = Object.freeze(["RELEASED"]);

function upper(value) {
  return String(value || "").toUpperCase();
}

function isReleased(target) {
  return RELEASED_STATUSES.includes(upper(target.status)) || RELEASED_STATUSES.includes(upper(target.lifecycle_state));
}

// Intersect the platform's own variant/configuration and effectivity filters so a
// structure trace can be scoped exactly like any other BOM consumer.
function applyContext(entries, { variant, configuration, variant_code, variantCode, configuration_context, configurationContext, asOf } = {}) {
  let lines = entries.map((entry) => entry.line);
  const context = {
    variant_code: variant_code ?? variantCode ?? variant,
    configuration_context: configuration_context ?? configurationContext ?? configuration,
  };
  if (context.variant_code || context.configuration_context) {
    lines = filterByVariant(lines, context);
  }
  if (asOf) {
    lines = filterByEffectivity(lines, { at: asOf });
  }
  const allowed = new Set(lines.map((line) => line.id));
  return entries.filter((entry) => allowed.has(entry.line.id));
}

function summarizeStructure(entries) {
  const children = new Set(entries.map((entry) => entry.line.child_object_id).filter(Boolean));
  const maxDepth = entries.reduce((depth, entry) => Math.max(depth, Number(entry.level || 0)), 0);
  const roots = entries.filter((entry) => Number(entry.level || 0) === 1).length;
  return { line_count: entries.length, root_count: roots, max_depth: maxDepth, item_count: children.size };
}

function structureDescriptor(target, summary) {
  return {
    target_type: target.target_type,
    target_id: target.target_id,
    object_id: target.object_id ?? null,
    ref: target.ref,
    number: target.number,
    name: target.name,
    bom_id: target.bom_id ?? null,
    bom_type: upper(target.bom_type) || "OTHER",
    revision_number: target.revision_number ?? "",
    status: target.status,
    lifecycle_state: target.lifecycle_state,
    is_released: isReleased(target),
    configuration_context: target.configuration_context || "",
    effectivity_from: target.effectivity_from ?? null,
    effectivity_to: target.effectivity_to ?? null,
    structure: summary || null,
  };
}

function groupStructures(allocationItems) {
  const groups = { EBOM: [], MBOM: [], BOP: [], OTHER: [] };
  for (const item of allocationItems) {
    groups[upper(item.bom_type) in groups ? upper(item.bom_type) : "OTHER"].push(item);
  }
  return groups;
}

function coverageFrom(allocations) {
  const byType = {};
  for (const type of STRUCTURE_TYPES) byType[type] = { allocated: false, released: false, revision_count: 0, line_count: 0 };
  for (const item of allocations) {
    const type = upper(item.bom_type);
    if (!byType[type]) continue;
    byType[type].allocated = true;
    byType[type].revision_count += 1;
    byType[type].line_count += Number(item.structure?.line_count || 0);
    if (item.is_released) byType[type].released = true;
  }
  return {
    by_type: byType,
    covered_types: STRUCTURE_TYPES.filter((type) => byType[type].allocated),
    missing_types: STRUCTURE_TYPES.filter((type) => !byType[type].allocated),
    structure_covered: byType.EBOM.allocated,
    released: byType.EBOM.released && byType.MBOM.released && byType.BOP.released,
  };
}

function projectStructures(requirement, items, { includeStructure = true } = {}) {
  const groups = groupStructures(items);
  return {
    requirement: {
      id: requirement.id,
      requirement_ref: requirement.requirement_ref,
      requirement_number: requirement.requirement_number,
      object_id: requirement.object_id ?? null,
      status: requirement.status || "",
    },
    structures: items,
    by_type: groups,
    counts_by_type: Object.fromEntries(Object.entries(groups).map(([type, list]) => [type, list.length])),
    coverage: coverageFrom(items),
    include_structure: includeStructure,
    total: items.length,
    source_module: "requirement-pdm",
  };
}

function collectStructureItems(db, tenant, allocations, options, isAsync = false) {
  const rows = allocations.filter((item) => item.status === "ACTIVE" && item.target && item.target_type === PDM_NODE_TYPES.BOM_REVISION);
  const run = async () => {
    const items = [];
    for (const item of rows) {
      const target = item.target;
      let structure = null;
      if (options.includeStructure !== false) {
        const flat = isAsync
          ? await BomStructure.flatStructureAsync(db, tenant, target.target_id, { includeInactive: options.includeInactive ?? true, maxDepth: options.maxDepth })
          : BomStructure.flatStructure(db, tenant, target.target_id, { includeInactive: options.includeInactive ?? true, maxDepth: options.maxDepth });
        const scoped = applyContext(flat, options);
        structure = summarizeStructure(scoped);
      }
      items.push({
        allocation_ref: item.allocation_ref,
        relationship_type: item.relationship_type,
        effectivity_from: item.effectivity_from,
        effectivity_to: item.effectivity_to,
        configuration_context: item.configuration_context,
        ...structureDescriptor(target, structure),
      });
    }
    return items;
  };
  return run();
}

export function listRequirementStructures(db, tenantId, requirementRef, options = {}) {
  const tenant = Number(tenantId);
  const requirement = Requirements.requireRequirementRow(db, tenant, requirementRef);
  const allocations = listRequirementAllocations(db, tenant, requirementRef, { withTargets: true, status: options.status }).items;
  const rows = allocations.filter((item) => item.status === "ACTIVE" && item.target && item.target_type === PDM_NODE_TYPES.BOM_REVISION);
  const items = [];
  for (const item of rows) {
    const target = item.target;
    let structure = null;
    if (options.includeStructure !== false) {
      const flat = BomStructure.flatStructure(db, tenant, target.target_id, { includeInactive: options.includeInactive ?? true, maxDepth: options.maxDepth });
      structure = summarizeStructure(applyContext(flat, options));
    }
    items.push({
      allocation_ref: item.allocation_ref,
      relationship_type: item.relationship_type,
      effectivity_from: item.effectivity_from,
      effectivity_to: item.effectivity_to,
      configuration_context: item.configuration_context,
      ...structureDescriptor(target, structure),
    });
  }
  return projectStructures(requirement, items, options);
}

export async function listRequirementStructuresAsync(db, tenantId, requirementRef, options = {}) {
  const tenant = Number(tenantId);
  const requirement = await Requirements.requireRequirementRowAsync(db, tenant, requirementRef);
  const allocations = (await listRequirementAllocationsAsync(db, tenant, requirementRef, { withTargets: true, status: options.status })).items;
  const items = await collectStructureItems(db, tenant, allocations, options, true);
  return projectStructures(requirement, items, options);
}

export function structureCoverage(db, tenantId, requirementRef, options = {}) {
  return listRequirementStructures(db, tenantId, requirementRef, { ...options, includeStructure: true }).coverage;
}

export async function structureCoverageAsync(db, tenantId, requirementRef, options = {}) {
  return (await listRequirementStructuresAsync(db, tenantId, requirementRef, { ...options, includeStructure: true })).coverage;
}

// Full, structure-aware trace for one BOM revision (EBOM/MBOM/BOP subtree
// traversal), revision-/configuration-/effectivity-aware.
export function bomRevisionStructure(db, tenantId, bomRevisionRef, options = {}) {
  const tenant = Number(tenantId);
  const target = resolveTarget(db, tenant, PDM_NODE_TYPES.BOM_REVISION, bomRevisionRef);
  if (!target) throw new Error(`BOM revision not found: ${bomRevisionRef}`);
  const flat = BomStructure.flatStructure(db, tenant, target.target_id, { includeInactive: options.includeInactive ?? true, maxDepth: options.maxDepth });
  const scoped = applyContext(flat, options);
  return {
    structure: structureDescriptor(target, summarizeStructure(scoped)),
    nodes: scoped.map((entry) => ({ level: entry.level, path: entry.path, line: entry.line })),
    ...summarizeStructure(scoped),
    source_module: "requirement-pdm",
  };
}

export async function bomRevisionStructureAsync(db, tenantId, bomRevisionRef, options = {}) {
  const tenant = Number(tenantId);
  const target = await resolveTargetAsync(db, tenant, PDM_NODE_TYPES.BOM_REVISION, bomRevisionRef);
  if (!target) throw new Error(`BOM revision not found: ${bomRevisionRef}`);
  const flat = await BomStructure.flatStructureAsync(db, tenant, target.target_id, { includeInactive: options.includeInactive ?? true, maxDepth: options.maxDepth });
  const scoped = applyContext(flat, options);
  return {
    structure: structureDescriptor(target, summarizeStructure(scoped)),
    nodes: scoped.map((entry) => ({ level: entry.level, path: entry.path, line: entry.line })),
    ...summarizeStructure(scoped),
    source_module: "requirement-pdm",
  };
}

// Reverse trace: every requirement allocated to a BOM revision structure. Reuses
// the allocation reverse-query so no relationship table is duplicated.
export function listStructureRequirements(db, tenantId, bomRevisionRef, options = {}) {
  const tenant = Number(tenantId);
  const target = resolveTarget(db, tenant, PDM_NODE_TYPES.BOM_REVISION, bomRevisionRef);
  if (!target) throw new Error(`BOM revision not found: ${bomRevisionRef}`);
  const result = listAllocations(db, tenant, { target_type: PDM_NODE_TYPES.BOM_REVISION, target_id: target.target_id, status: options.status, withTargets: false });
  return {
    structure: structureDescriptor(target, null),
    items: result.items.map((allocation) => ({
      allocation_ref: allocation.allocation_ref,
      relationship_type: allocation.relationship_type,
      status: allocation.status,
      requirement_id: allocation.requirement_id,
      requirement_ref: allocation.requirement_ref,
      requirement_number: allocation.requirement_number,
      requirement_status: allocation.requirement_status,
      effectivity_from: allocation.effectivity_from,
      effectivity_to: allocation.effectivity_to,
    })),
    total: result.total,
    source_module: "requirement-pdm",
  };
}

export async function listStructureRequirementsAsync(db, tenantId, bomRevisionRef, options = {}) {
  const tenant = Number(tenantId);
  const target = await resolveTargetAsync(db, tenant, PDM_NODE_TYPES.BOM_REVISION, bomRevisionRef);
  if (!target) throw new Error(`BOM revision not found: ${bomRevisionRef}`);
  const result = await listAllocationsAsync(db, tenant, { target_type: PDM_NODE_TYPES.BOM_REVISION, target_id: target.target_id, status: options.status, withTargets: false });
  return {
    structure: structureDescriptor(target, null),
    items: result.items.map((allocation) => ({
      allocation_ref: allocation.allocation_ref,
      relationship_type: allocation.relationship_type,
      status: allocation.status,
      requirement_id: allocation.requirement_id,
      requirement_ref: allocation.requirement_ref,
      requirement_number: allocation.requirement_number,
      requirement_status: allocation.requirement_status,
      effectivity_from: allocation.effectivity_from,
      effectivity_to: allocation.effectivity_to,
    })),
    total: result.total,
    source_module: "requirement-pdm",
  };
}
