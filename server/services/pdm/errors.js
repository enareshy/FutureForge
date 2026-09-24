// Standardized PDM domain error codes.
//
// The HTTP layer serializes `code` alongside `error` and `details` so clients
// branch on stable identifiers rather than parsing prose, and so the correlation
// id added by the request middleware is always present.
import { HttpError } from "../../validation.js";

export const PDM_ERROR_CODES = Object.freeze({
  ITEM_NOT_FOUND: "PDM_ITEM_NOT_FOUND",
  ITEM_CONFLICT: "PDM_ITEM_CONFLICT",
  INVALID_ITEM: "PDM_INVALID_ITEM",
  ITEM_IMMUTABLE: "PDM_ITEM_IMMUTABLE",
  ITEM_OBSOLETE: "PDM_ITEM_OBSOLETE",
  REVISION_NOT_FOUND: "PDM_REVISION_NOT_FOUND",
  REVISION_CONFLICT: "PDM_REVISION_CONFLICT",
  INVALID_REVISION: "PDM_INVALID_REVISION",
  REVISION_IMMUTABLE: "PDM_REVISION_IMMUTABLE",
  REVISION_STATUS_INVALID: "PDM_REVISION_STATUS_INVALID",
  PART_NOT_FOUND: "PDM_PART_NOT_FOUND",
  PRODUCT_NOT_FOUND: "PDM_PRODUCT_NOT_FOUND",
  DATASET_NOT_FOUND: "PDM_DATASET_NOT_FOUND",
  DATASET_CONFLICT: "PDM_DATASET_CONFLICT",
  INVALID_DATASET: "PDM_INVALID_DATASET",
  DATASET_IMMUTABLE: "PDM_DATASET_IMMUTABLE",
  REPRESENTATION_NOT_FOUND: "PDM_REPRESENTATION_NOT_FOUND",
  INVALID_REPRESENTATION: "PDM_INVALID_REPRESENTATION",
  DESIGN_DATA_NOT_FOUND: "PDM_DESIGN_DATA_NOT_FOUND",
  INVALID_DESIGN_DATA: "PDM_INVALID_DESIGN_DATA",
  CAD_ASSOCIATION_NOT_FOUND: "PDM_CAD_ASSOCIATION_NOT_FOUND",
  CAD_ASSOCIATION_CONFLICT: "PDM_CAD_ASSOCIATION_CONFLICT",
  INVALID_CAD_ASSOCIATION: "PDM_INVALID_CAD_ASSOCIATION",
  REVISION_RULE_NOT_FOUND: "PDM_REVISION_RULE_NOT_FOUND",
  REVISION_RULE_CONFLICT: "PDM_REVISION_RULE_CONFLICT",
  INVALID_REVISION_RULE: "PDM_INVALID_REVISION_RULE",
  CONFIGURATION_RULE_NOT_FOUND: "PDM_CONFIGURATION_RULE_NOT_FOUND",
  CONFIGURATION_RULE_CONFLICT: "PDM_CONFIGURATION_RULE_CONFLICT",
  INVALID_CONFIGURATION_RULE: "PDM_INVALID_CONFIGURATION_RULE",
  BASELINE_NOT_FOUND: "PDM_BASELINE_NOT_FOUND",
  BASELINE_CONFLICT: "PDM_BASELINE_CONFLICT",
  BASELINE_IMMUTABLE: "PDM_BASELINE_IMMUTABLE",
  INVALID_BASELINE: "PDM_INVALID_BASELINE",
  RELATIONSHIP_NOT_FOUND: "PDM_RELATIONSHIP_NOT_FOUND",
  RELATIONSHIP_CONFLICT: "PDM_RELATIONSHIP_CONFLICT",
  INVALID_RELATIONSHIP: "PDM_INVALID_RELATIONSHIP",
  INVALID_EFFECTIVITY: "PDM_INVALID_EFFECTIVITY",
  INVALID_CONFIGURATION: "PDM_INVALID_CONFIGURATION",
  VALIDATION_FAILED: "PDM_VALIDATION_FAILED",
  RULE_NOT_FOUND: "PDM_RULE_NOT_FOUND",
  INVALID_RULE: "PDM_INVALID_RULE",
  STRUCTURE_UNRESOLVED: "PDM_STRUCTURE_UNRESOLVED",
  DEPTH_EXCEEDED: "PDM_DEPTH_EXCEEDED",
  OBJECT_NOT_FOUND: "PDM_OBJECT_NOT_FOUND",
  SECURITY_BLOCKED: "PDM_SECURITY_BLOCKED",
  SEARCH_UNAVAILABLE: "PDM_SEARCH_UNAVAILABLE",
  BULK_INVALID: "INVALID_PDM_BULK_OPERATION",
  CONTENT_UNAVAILABLE: "PDM_CONTENT_UNAVAILABLE",
  CONFLICT: "PDM_CONFLICT",
});

export class PdmError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

// Item
export const itemNotFound = (ref) =>
  new PdmError(404, `PDM item not found: ${ref}`, PDM_ERROR_CODES.ITEM_NOT_FOUND, { ref });
export const itemConflict = (number) =>
  new PdmError(409, `PDM item already exists: ${number}`, PDM_ERROR_CODES.ITEM_CONFLICT, { item_number: number });
export const invalidItem = (message, details = null) =>
  new PdmError(400, message, PDM_ERROR_CODES.INVALID_ITEM, details);
export const itemImmutable = (ref, status) =>
  new PdmError(409, `PDM item ${ref} is ${status} and cannot be edited in place`, PDM_ERROR_CODES.ITEM_IMMUTABLE, { ref, status });
export const itemObsolete = (ref) =>
  new PdmError(409, `PDM item ${ref} is obsolete and cannot be revised`, PDM_ERROR_CODES.ITEM_OBSOLETE, { ref });

// Revision
export const revisionNotFound = (ref) =>
  new PdmError(404, `PDM revision not found: ${ref}`, PDM_ERROR_CODES.REVISION_NOT_FOUND, { ref });
export const revisionConflict = (itemId, revisionNumber) =>
  new PdmError(409, `PDM revision already exists: ${revisionNumber}`, PDM_ERROR_CODES.REVISION_CONFLICT, { item_id: itemId, revision_number: revisionNumber });
export const invalidRevision = (message, details = null) =>
  new PdmError(400, message, PDM_ERROR_CODES.INVALID_REVISION, details);
export const revisionImmutable = (ref, status) =>
  new PdmError(409, `PDM revision ${ref} is ${status} and cannot be edited in place`, PDM_ERROR_CODES.REVISION_IMMUTABLE, { ref, status });
export const revisionStatusInvalid = (status, from, allowed) =>
  new PdmError(409, `Cannot change revision status from ${from} to ${status}`, PDM_ERROR_CODES.REVISION_STATUS_INVALID, { status, from, allowed });

// Semantic types
export const partNotFound = (ref) =>
  new PdmError(404, `PDM part not found: ${ref}`, PDM_ERROR_CODES.PART_NOT_FOUND, { ref });
export const productNotFound = (ref) =>
  new PdmError(404, `PDM product not found: ${ref}`, PDM_ERROR_CODES.PRODUCT_NOT_FOUND, { ref });

// Dataset
export const datasetNotFound = (ref) =>
  new PdmError(404, `PDM dataset not found: ${ref}`, PDM_ERROR_CODES.DATASET_NOT_FOUND, { ref });
export const datasetConflict = (ref) =>
  new PdmError(409, `PDM dataset already exists: ${ref}`, PDM_ERROR_CODES.DATASET_CONFLICT, { ref });
export const invalidDataset = (message, details = null) =>
  new PdmError(400, message, PDM_ERROR_CODES.INVALID_DATASET, details);
export const datasetImmutable = (ref, status) =>
  new PdmError(409, `PDM dataset ${ref} is ${status} and cannot be edited in place`, PDM_ERROR_CODES.DATASET_IMMUTABLE, { ref, status });

// Representation
export const representationNotFound = (ref) =>
  new PdmError(404, `PDM representation not found: ${ref}`, PDM_ERROR_CODES.REPRESENTATION_NOT_FOUND, { ref });
export const invalidRepresentation = (message, details = null) =>
  new PdmError(400, message, PDM_ERROR_CODES.INVALID_REPRESENTATION, details);

// Design data
export const designDataNotFound = (ref) =>
  new PdmError(404, `PDM design data not found: ${ref}`, PDM_ERROR_CODES.DESIGN_DATA_NOT_FOUND, { ref });
export const invalidDesignData = (message, details = null) =>
  new PdmError(400, message, PDM_ERROR_CODES.INVALID_DESIGN_DATA, details);

// CAD
export const cadAssociationNotFound = (ref) =>
  new PdmError(404, `CAD association not found: ${ref}`, PDM_ERROR_CODES.CAD_ASSOCIATION_NOT_FOUND, { ref });
export const cadAssociationConflict = (details) =>
  new PdmError(409, "A matching CAD association already exists", PDM_ERROR_CODES.CAD_ASSOCIATION_CONFLICT, details);
export const invalidCadAssociation = (message, details = null) =>
  new PdmError(400, message, PDM_ERROR_CODES.INVALID_CAD_ASSOCIATION, details);

// Rules
export const revisionRuleNotFound = (ref) =>
  new PdmError(404, `PDM revision rule not found: ${ref}`, PDM_ERROR_CODES.REVISION_RULE_NOT_FOUND, { ref });
export const revisionRuleConflict = (code) =>
  new PdmError(409, `PDM revision rule already exists: ${code}`, PDM_ERROR_CODES.REVISION_RULE_CONFLICT, { code });
export const invalidRevisionRule = (message, details = null) =>
  new PdmError(400, message, PDM_ERROR_CODES.INVALID_REVISION_RULE, details);
export const configurationRuleNotFound = (ref) =>
  new PdmError(404, `PDM configuration rule not found: ${ref}`, PDM_ERROR_CODES.CONFIGURATION_RULE_NOT_FOUND, { ref });
export const configurationRuleConflict = (code) =>
  new PdmError(409, `PDM configuration rule already exists: ${code}`, PDM_ERROR_CODES.CONFIGURATION_RULE_CONFLICT, { code });
export const invalidConfigurationRule = (message, details = null) =>
  new PdmError(400, message, PDM_ERROR_CODES.INVALID_CONFIGURATION_RULE, details);

// Baseline
export const baselineNotFound = (ref) =>
  new PdmError(404, `PDM baseline not found: ${ref}`, PDM_ERROR_CODES.BASELINE_NOT_FOUND, { ref });
export const baselineConflict = (number) =>
  new PdmError(409, `PDM baseline already exists: ${number}`, PDM_ERROR_CODES.BASELINE_CONFLICT, { baseline_number: number });
export const baselineImmutable = (ref) =>
  new PdmError(409, `PDM baseline ${ref} is released and immutable`, PDM_ERROR_CODES.BASELINE_IMMUTABLE, { ref });
export const invalidBaseline = (message, details = null) =>
  new PdmError(400, message, PDM_ERROR_CODES.INVALID_BASELINE, details);

// Relationship
export const relationshipNotFound = (ref) =>
  new PdmError(404, `PDM relationship not found: ${ref}`, PDM_ERROR_CODES.RELATIONSHIP_NOT_FOUND, { ref });
export const relationshipConflict = (details) =>
  new PdmError(409, "A matching PDM relationship already exists", PDM_ERROR_CODES.RELATIONSHIP_CONFLICT, details);
export const invalidRelationship = (message, details = null) =>
  new PdmError(400, message, PDM_ERROR_CODES.INVALID_RELATIONSHIP, details);

// Cross-cutting
export const invalidEffectivity = (message, details = null) =>
  new PdmError(400, message, PDM_ERROR_CODES.INVALID_EFFECTIVITY, details);
export const invalidConfiguration = (message, details = null) =>
  new PdmError(400, message, PDM_ERROR_CODES.INVALID_CONFIGURATION, details);
export const validationFailed = (details) =>
  new PdmError(422, "PDM validation failed", PDM_ERROR_CODES.VALIDATION_FAILED, details);
export const ruleNotFound = (ref) =>
  new PdmError(404, `PDM validation rule not found: ${ref}`, PDM_ERROR_CODES.RULE_NOT_FOUND, { ref });
export const invalidRule = (message, details = null) =>
  new PdmError(400, message, PDM_ERROR_CODES.INVALID_RULE, details);
export const structureUnresolved = (message, details = null) =>
  new PdmError(422, message, PDM_ERROR_CODES.STRUCTURE_UNRESOLVED, details);
export const invalidStructure = (message, details = null) =>
  new PdmError(400, message, PDM_ERROR_CODES.STRUCTURE_UNRESOLVED, details);
export const depthExceeded = (limit) =>
  new PdmError(422, `PDM structure depth exceeds the configured limit of ${limit}`, PDM_ERROR_CODES.DEPTH_EXCEEDED, { limit });
export const objectNotFound = (details) =>
  new PdmError(404, "Referenced PDM object not found", PDM_ERROR_CODES.OBJECT_NOT_FOUND, details);
export const securityBlocked = (details) =>
  new PdmError(403, "Blocked by security policy", PDM_ERROR_CODES.SECURITY_BLOCKED, details);
export const searchUnavailable = (message = "Search service is unavailable") =>
  new PdmError(503, message, PDM_ERROR_CODES.SEARCH_UNAVAILABLE);
export const bulkInvalid = (message, details = null) =>
  new PdmError(400, message, PDM_ERROR_CODES.BULK_INVALID, details);
export const contentUnavailable = (message, details = null) =>
  new PdmError(409, message, PDM_ERROR_CODES.CONTENT_UNAVAILABLE, details);
export const pdmConflict = (message, details = null) =>
  new PdmError(409, message, PDM_ERROR_CODES.CONFLICT, details);
