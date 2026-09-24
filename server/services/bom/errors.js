// Standardized BOM Engine error codes.
//
// The HTTP layer serializes `code` alongside `error` and `details` so clients
// branch on stable identifiers rather than parsing prose, and so the
// correlation id added by the request middleware is always present.
import { HttpError } from "../../validation.js";

export const BOM_ERROR_CODES = Object.freeze({
  BOM_NOT_FOUND: "BOM_NOT_FOUND",
  BOM_CONFLICT: "BOM_CONFLICT",
  INVALID_BOM: "INVALID_BOM",
  BOM_IMMUTABLE: "BOM_IMMUTABLE",
  BOM_OBSOLETE: "BOM_OBSOLETE",
  REVISION_NOT_FOUND: "BOM_REVISION_NOT_FOUND",
  REVISION_CONFLICT: "BOM_REVISION_CONFLICT",
  INVALID_REVISION: "BOM_INVALID_REVISION",
  REVISION_IMMUTABLE: "BOM_REVISION_IMMUTABLE",
  REVISION_STATUS_INVALID: "BOM_REVISION_STATUS_INVALID",
  LINE_NOT_FOUND: "BOM_LINE_NOT_FOUND",
  LINE_CONFLICT: "BOM_LINE_CONFLICT",
  INVALID_LINE: "BOM_INVALID_LINE",
  LINE_IMMUTABLE: "BOM_LINE_IMMUTABLE",
  CIRCULAR_STRUCTURE: "BOM_CIRCULAR_STRUCTURE",
  DEPTH_EXCEEDED: "BOM_DEPTH_EXCEEDED",
  QUANTITY_INVALID: "BOM_QUANTITY_INVALID",
  UNIT_INVALID: "BOM_UNIT_INVALID",
  UNIT_INCOMPATIBLE: "BOM_UNIT_INCOMPATIBLE",
  SUBSTITUTE_NOT_FOUND: "BOM_SUBSTITUTE_NOT_FOUND",
  SUBSTITUTE_CONFLICT: "BOM_SUBSTITUTE_CONFLICT",
  INVALID_SUBSTITUTE: "BOM_INVALID_SUBSTITUTE",
  BASELINE_NOT_FOUND: "BOM_BASELINE_NOT_FOUND",
  BASELINE_CONFLICT: "BOM_BASELINE_CONFLICT",
  BASELINE_IMMUTABLE: "BOM_BASELINE_IMMUTABLE",
  INVALID_BASELINE: "BOM_INVALID_BASELINE",
  TRANSFORMATION_NOT_FOUND: "BOM_TRANSFORMATION_NOT_FOUND",
  TRANSFORMATION_CONFLICT: "BOM_TRANSFORMATION_CONFLICT",
  INVALID_TRANSFORMATION: "BOM_INVALID_TRANSFORMATION",
  TRANSFORMATION_FAILED: "BOM_TRANSFORMATION_FAILED",
  VALIDATION_FAILED: "BOM_VALIDATION_FAILED",
  RULE_NOT_FOUND: "BOM_RULE_NOT_FOUND",
  INVALID_RULE: "BOM_INVALID_RULE",
  COMPARISON_NOT_FOUND: "BOM_COMPARISON_NOT_FOUND",
  INVALID_COMPARISON: "BOM_INVALID_COMPARISON",
  EFFECTIVITY_INVALID: "BOM_EFFECTIVITY_INVALID",
  VARIANT_INVALID: "BOM_VARIANT_INVALID",
  OBJECT_NOT_FOUND: "BOM_OBJECT_NOT_FOUND",
  SECURITY_BLOCKED: "BOM_SECURITY_BLOCKED",
  INVALID_CONFIGURATION: "BOM_INVALID_CONFIGURATION",
  SEARCH_UNAVAILABLE: "BOM_SEARCH_UNAVAILABLE",
  BULK_INVALID: "INVALID_BOM_BULK_OPERATION",
  CONFLICT: "BOM_CONFLICT",
});

export class BomError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export const bomNotFound = (ref) =>
  new BomError(404, `BOM not found: ${ref}`, BOM_ERROR_CODES.BOM_NOT_FOUND, { ref });
export const bomConflict = (number) =>
  new BomError(409, `BOM already exists: ${number}`, BOM_ERROR_CODES.BOM_CONFLICT, { bom_number: number });
export const invalidBom = (message, details = null) =>
  new BomError(400, message, BOM_ERROR_CODES.INVALID_BOM, details);
export const bomImmutable = (ref, status) =>
  new BomError(409, `BOM ${ref} is ${status} and cannot be edited in place`, BOM_ERROR_CODES.BOM_IMMUTABLE, { ref, status });
export const bomObsolete = (ref) =>
  new BomError(409, `BOM ${ref} is obsolete and cannot be revised`, BOM_ERROR_CODES.BOM_OBSOLETE, { ref });

export const revisionNotFound = (ref) =>
  new BomError(404, `BOM revision not found: ${ref}`, BOM_ERROR_CODES.REVISION_NOT_FOUND, { ref });
export const revisionConflict = (bomId, revisionNumber) =>
  new BomError(409, `BOM revision already exists: ${revisionNumber}`, BOM_ERROR_CODES.REVISION_CONFLICT, { bom_id: bomId, revision_number: revisionNumber });
export const invalidRevision = (message, details = null) =>
  new BomError(400, message, BOM_ERROR_CODES.INVALID_REVISION, details);
export const revisionImmutable = (ref, status) =>
  new BomError(409, `BOM revision ${ref} is ${status} and cannot be edited in place`, BOM_ERROR_CODES.REVISION_IMMUTABLE, { ref, status });
export const revisionStatusInvalid = (status, from, allowed) =>
  new BomError(409, `Cannot change revision status from ${from} to ${status}`, BOM_ERROR_CODES.REVISION_STATUS_INVALID, { status, from, allowed });

export const lineNotFound = (ref) =>
  new BomError(404, `BOM line not found: ${ref}`, BOM_ERROR_CODES.LINE_NOT_FOUND, { ref });
export const lineConflict = (details) =>
  new BomError(409, "A matching BOM line already exists", BOM_ERROR_CODES.LINE_CONFLICT, details);
export const invalidLine = (message, details = null) =>
  new BomError(400, message, BOM_ERROR_CODES.INVALID_LINE, details);
export const lineImmutable = (ref) =>
  new BomError(409, `BOM line ${ref} belongs to a released revision and cannot be edited`, BOM_ERROR_CODES.LINE_IMMUTABLE, { ref });
export const circularStructure = (details) =>
  new BomError(409, "The BOM structure would contain a circular reference", BOM_ERROR_CODES.CIRCULAR_STRUCTURE, details);
export const depthExceeded = (limit) =>
  new BomError(422, `BOM structure depth exceeds the configured limit of ${limit}`, BOM_ERROR_CODES.DEPTH_EXCEEDED, { limit });
export const quantityInvalid = (message, details = null) =>
  new BomError(400, message, BOM_ERROR_CODES.QUANTITY_INVALID, details);
export const invalidUnit = (message, details = null) =>
  new BomError(400, message, BOM_ERROR_CODES.UNIT_INVALID, details);
export const incompatibleUnit = (details) =>
  new BomError(422, "Units are not compatible", BOM_ERROR_CODES.UNIT_INCOMPATIBLE, details);

export const substituteNotFound = (ref) =>
  new BomError(404, `Substitute not found: ${ref}`, BOM_ERROR_CODES.SUBSTITUTE_NOT_FOUND, { ref });
export const substituteConflict = (details) =>
  new BomError(409, "This substitute already exists for the line", BOM_ERROR_CODES.SUBSTITUTE_CONFLICT, details);
export const invalidSubstitute = (message, details = null) =>
  new BomError(400, message, BOM_ERROR_CODES.INVALID_SUBSTITUTE, details);

export const baselineNotFound = (ref) =>
  new BomError(404, `BOM baseline not found: ${ref}`, BOM_ERROR_CODES.BASELINE_NOT_FOUND, { ref });
export const baselineConflict = (number) =>
  new BomError(409, `BOM baseline already exists: ${number}`, BOM_ERROR_CODES.BASELINE_CONFLICT, { baseline_number: number });
export const baselineImmutable = (ref) =>
  new BomError(409, `BOM baseline ${ref} is frozen and immutable`, BOM_ERROR_CODES.BASELINE_IMMUTABLE, { ref });
export const invalidBaseline = (message, details = null) =>
  new BomError(400, message, BOM_ERROR_CODES.INVALID_BASELINE, details);

export const transformationNotFound = (ref) =>
  new BomError(404, `BOM transformation definition not found: ${ref}`, BOM_ERROR_CODES.TRANSFORMATION_NOT_FOUND, { ref });
export const transformationConflict = (code) =>
  new BomError(409, `BOM transformation definition already exists: ${code}`, BOM_ERROR_CODES.TRANSFORMATION_CONFLICT, { code });
export const invalidTransformation = (message, details = null) =>
  new BomError(400, message, BOM_ERROR_CODES.INVALID_TRANSFORMATION, details);
export const transformationFailed = (message, details = null) =>
  new BomError(422, message, BOM_ERROR_CODES.TRANSFORMATION_FAILED, details);

export const validationFailed = (details) =>
  new BomError(422, "BOM validation failed", BOM_ERROR_CODES.VALIDATION_FAILED, details);
export const ruleNotFound = (ref) =>
  new BomError(404, `BOM validation rule not found: ${ref}`, BOM_ERROR_CODES.RULE_NOT_FOUND, { ref });
export const invalidRule = (message, details = null) =>
  new BomError(400, message, BOM_ERROR_CODES.INVALID_RULE, details);

export const comparisonNotFound = (ref) =>
  new BomError(404, `BOM comparison not found: ${ref}`, BOM_ERROR_CODES.COMPARISON_NOT_FOUND, { ref });
export const invalidComparison = (message, details = null) =>
  new BomError(400, message, BOM_ERROR_CODES.INVALID_COMPARISON, details);

export const invalidEffectivity = (message, details = null) =>
  new BomError(400, message, BOM_ERROR_CODES.EFFECTIVITY_INVALID, details);
export const invalidVariant = (message, details = null) =>
  new BomError(400, message, BOM_ERROR_CODES.VARIANT_INVALID, details);
export const objectNotFound = (details) =>
  new BomError(404, "Referenced object not found", BOM_ERROR_CODES.OBJECT_NOT_FOUND, details);

export const securityBlocked = (details) =>
  new BomError(403, "Blocked by security policy", BOM_ERROR_CODES.SECURITY_BLOCKED, details);
export const invalidConfiguration = (message, details = null) =>
  new BomError(400, message, BOM_ERROR_CODES.INVALID_CONFIGURATION, details);
export const bulkInvalid = (message, details = null) =>
  new BomError(400, message, BOM_ERROR_CODES.BULK_INVALID, details);
export const bomConflictError = (message, details = null) =>
  new BomError(409, message, BOM_ERROR_CODES.CONFLICT, details);
