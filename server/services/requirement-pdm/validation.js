// Input normalization and validation for Requirement -> PDM allocations.
//
// Allocation edges reuse the Requirements Manager relationship vocabulary and
// the shared validation helpers, so validation stays consistent with the rest
// of the platform (mirrors requirements/validation.js).
import {
  normalizeText,
  normalizeUpper,
  parseObject,
  toInt,
  paginate,
  assertEnum,
} from "../requirements/validation.js";
import {
  ALLOCATION_CODES,
  ALLOCATION_TYPES,
  ALLOCATION_STATUSES,
  TARGET_NODE_TYPES,
  PDM_NODE_TYPES,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
} from "./constants.js";
import {
  invalidRelationship,
  invalidTarget,
  statusInvalid,
} from "./errors.js";

export { normalizeText, normalizeUpper, parseObject, toInt, paginate };

const ALLOCATION_BY_CODE = new Map(ALLOCATION_TYPES.map((entry) => [entry.code, entry]));

const DEFAULT_ALLOCATION_FOR_TARGET = Object.freeze({
  [PDM_NODE_TYPES.ITEM]: "ALLOCATED_TO",
  [PDM_NODE_TYPES.REVISION]: "IMPLEMENTED_BY",
  [PDM_NODE_TYPES.DATASET]: "REPRESENTED_BY",
  [PDM_NODE_TYPES.BOM_REVISION]: "SATISFIED_BY",
});

export const assertAllocationType = (value) =>
  assertEnum(normalizeUpper(value), ALLOCATION_CODES, "Allocation relationship", invalidRelationship);

export const assertTargetNodeType = (value) =>
  assertEnum(String(value || "").toLowerCase(), TARGET_NODE_TYPES, "PDM target type", invalidTarget);

export const assertAllocationStatus = (value) =>
  assertEnum(normalizeUpper(value), ALLOCATION_STATUSES, "Allocation status", statusInvalid);

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

  const status = body.status ? assertAllocationStatus(body.status) : "ACTIVE";

  return {
    requirement_id: normalizeText(requirementId, { max: 120 }),
    relationship_type: relationshipType,
    target_type: targetType || spec?.target_types?.[0] || null,
    target_id: normalizeText(targetId, { max: 120 }),
    status,
    effectivity_from: body.effectivity_from ?? body.effectivityFrom ?? body.valid_from ?? body.validFrom ?? null,
    effectivity_to: body.effectivity_to ?? body.effectivityTo ?? body.valid_to ?? body.validTo ?? null,
    revision_rule: body.revision_rule ?? body.revisionRule ?? null,
    configuration_context: body.configuration_context ?? body.configurationContext ?? null,
    attributes: parseObject(body.attributes ?? {}, {}),
  };
}

export function normalizeSyncInput(body = {}) {
  return {
    requirement_ids: Array.isArray(body.requirement_ids ?? body.requirementIds)
      ? (body.requirement_ids ?? body.requirementIds).map((value) => normalizeText(value, { max: 120 }))
      : null,
    target_types: Array.isArray(body.target_types ?? body.targetTypes)
      ? (body.target_types ?? body.targetTypes).map((value) => assertTargetNodeType(value))
      : null,
    dry_run: Boolean(body.dry_run ?? body.dryRun ?? false),
    batch_size: body.batch_size ?? body.batchSize ?? null,
  };
}

export function paginateAllocations(opts = {}) {
  return paginate({ page: opts.page, pageSize: opts.pageSize }, { defaultPageSize: DEFAULT_PAGE_SIZE, maxPageSize: MAX_PAGE_SIZE });
}
