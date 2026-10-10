// Input normalization and validation for Requirement -> Manufacturing
// allocations.
//
// Allocation edges reuse the Requirements Manager relationship vocabulary and
// the shared validation helpers (mirrors requirement-pdm/validation.js) so
// validation stays consistent with the rest of the platform.
import { normalizeText, normalizeUpper, parseObject, toInt, paginate, assertEnum } from "../requirements/validation.js";
import {
  ALLOCATION_CODES,
  ALLOCATION_TYPES,
  ALLOCATION_STATUSES,
  TARGET_NODE_TYPES,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
} from "./constants.js";
import { invalidRelationship, invalidTarget, allocationStatusInvalid } from "./errors.js";

export { normalizeText, normalizeUpper, parseObject, toInt, paginate };

const ALLOCATION_BY_CODE = new Map(ALLOCATION_TYPES.map((entry) => [entry.code, entry]));

// Default relationship for a target when the caller omits `relationship_type`.
// Mirrors the manufacturing meaning declared in ALLOCATION_TYPES.
const DEFAULT_ALLOCATION_FOR_TARGET = Object.freeze({
  pdm_item: "ALLOCATED_TO",
  pdm_revision: "IMPLEMENTED_BY",
  bom_revision: "SATISFIED_BY",
  operation: "REALIZED_BY",
  work_center: "SATISFIED_BY",
  characteristic: "GOVERNED_BY",
  content: "REPRESENTED_BY",
});

export const assertAllocationType = (value) =>
  assertEnum(normalizeUpper(value), ALLOCATION_CODES, "Allocation relationship", invalidRelationship);

export const assertTargetNodeType = (value) =>
  assertEnum(String(value || "").toLowerCase(), TARGET_NODE_TYPES, "Manufacturing target type", invalidTarget);

export const assertAllocationStatus = (value) =>
  assertEnum(normalizeUpper(value), ALLOCATION_STATUSES, "Allocation status", allocationStatusInvalid);

export function allocationSpec(code) {
  return ALLOCATION_BY_CODE.get(String(code || "").toUpperCase()) || null;
}

export function defaultAllocationForTarget(targetType) {
  return DEFAULT_ALLOCATION_FOR_TARGET[String(targetType || "").toLowerCase()] || null;
}

export function normalizeAllocationInput(body = {}) {
  const rawTarget = body.target_type ?? body.targetType ?? body.target;
  const targetType = rawTarget ? assertTargetNodeType(rawTarget) : null;

  const rawRelationship = body.relationship_type ?? body.relationshipType ?? body.relationship;
  let relationshipType = rawRelationship ? assertAllocationType(rawRelationship) : null;
  if (!relationshipType) {
    relationshipType = targetType ? defaultAllocationForTarget(targetType) : null;
    if (!relationshipType) {
      throw invalidRelationship("relationship_type is required when the target type is not supplied");
    }
  }

  const spec = allocationSpec(relationshipType);
  if (targetType && spec && !spec.target_types.includes(targetType)) {
    throw invalidRelationship(
      `${relationshipType} cannot target ${targetType}; expected one of ${spec.target_types.join(", ")}`,
      { relationship_type: relationshipType, target_type: targetType, allowed: spec.target_types }
    );
  }

  const targetId = body.target_id ?? body.targetId;
  if (targetId === undefined || targetId === null || String(targetId).trim() === "") {
    throw invalidTarget("target_id is required");
  }

  const requirementId = body.requirement_id ?? body.requirementId ?? body.requirement ?? body.requirement_ref ?? body.requirementRef;
  if (requirementId === undefined || requirementId === null || String(requirementId).trim() === "") {
    throw invalidRelationship("requirement_id is required");
  }

  return {
    requirement_id: normalizeText(requirementId, { max: 120 }),
    relationship_type: relationshipType,
    target_type: targetType || spec?.target_types?.[0] || null,
    target_id: normalizeText(targetId, { max: 120 }),
    status: body.status ? assertAllocationStatus(body.status) : "ACTIVE",
    effectivity_from: body.effectivity_from ?? body.effectivityFrom ?? body.valid_from ?? body.validFrom ?? null,
    effectivity_to: body.effectivity_to ?? body.effectivityTo ?? body.valid_to ?? body.validTo ?? null,
    revision_rule: body.revision_rule ?? body.revisionRule ?? null,
    configuration_context: body.configuration_context ?? body.configurationContext ?? null,
    attributes: parseObject(body.attributes ?? {}, {}),
  };
}

// Batch allocation input: a requirement plus a list of target ids for one
// relationship type, or a list of {target_type,target_id} entries.
export function normalizeBatchAllocationInput(body = {}) {
  const requirementId = body.requirement_id ?? body.requirementId ?? body.requirement ?? body.requirement_ref ?? body.requirementRef;
  if (requirementId === undefined || requirementId === null || String(requirementId).trim() === "") {
    throw invalidRelationship("requirement_id is required");
  }
  const relationshipType = body.relationship_type ?? body.relationshipType ?? body.relationship;
  const rawTargets = body.targets ?? body.items ?? [];
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw invalidTarget("targets must be a non-empty array");
  }
  const entries = rawTargets.map((entry) => {
    if (entry && typeof entry === "object") {
      return {
        ...entry,
        requirement_id: requirementId,
        relationship_type: entry.relationship_type ?? entry.relationshipType ?? relationshipType,
      };
    }
    return { requirement_id: requirementId, relationship_type: relationshipType, target_type: body.target_type ?? body.targetType, target_id: entry };
  });
  return { requirement_id: normalizeText(requirementId, { max: 120 }), entries };
}

export function paginateAllocations(opts = {}) {
  return paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
}
