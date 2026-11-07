// Standardized Requirements Manager domain error codes.
//
// The HTTP layer serializes `code` alongside `error` and `details` so clients
// branch on stable identifiers rather than parsing prose (mirrors
// server/services/change/errors.js).
import { HttpError } from "../../validation.js";

export const REQUIREMENT_ERROR_CODES = Object.freeze({
  NOT_FOUND: "REQUIREMENT_NOT_FOUND",
  CONFLICT: "REQUIREMENT_CONFLICT",
  INVALID: "REQUIREMENT_INVALID",
  STATUS_INVALID: "REQUIREMENT_STATUS_INVALID",
  IMMUTABLE: "REQUIREMENT_IMMUTABLE",
  TYPE_NOT_FOUND: "REQUIREMENT_TYPE_NOT_FOUND",
  TYPE_CONFLICT: "REQUIREMENT_TYPE_CONFLICT",
  INVALID_TYPE: "REQUIREMENT_INVALID_TYPE",
  REVISION_NOT_FOUND: "REQUIREMENT_REVISION_NOT_FOUND",
  REVISION_CONFLICT: "REQUIREMENT_REVISION_CONFLICT",
  INVALID_REVISION: "REQUIREMENT_INVALID_REVISION",
  RELATIONSHIP_NOT_FOUND: "REQUIREMENT_RELATIONSHIP_NOT_FOUND",
  RELATIONSHIP_CONFLICT: "REQUIREMENT_RELATIONSHIP_CONFLICT",
  INVALID_RELATIONSHIP: "REQUIREMENT_INVALID_RELATIONSHIP",
  CYCLE: "REQUIREMENT_HIERARCHY_CYCLE",
  BASELINE_NOT_FOUND: "REQUIREMENT_BASELINE_NOT_FOUND",
  BASELINE_CONFLICT: "REQUIREMENT_BASELINE_CONFLICT",
  INVALID_BASELINE: "REQUIREMENT_INVALID_BASELINE",
  BASELINE_MEMBER_NOT_FOUND: "REQUIREMENT_BASELINE_MEMBER_NOT_FOUND",
  INVALID_CONFIGURATION: "REQUIREMENT_INVALID_CONFIGURATION",
  VALIDATION_FAILED: "REQUIREMENT_VALIDATION_FAILED",
  FORBIDDEN: "REQUIREMENT_FORBIDDEN",
});

export class RequirementError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

// Requirement
export const requirementNotFound = (ref) =>
  new RequirementError(404, `Requirement not found: ${ref}`, REQUIREMENT_ERROR_CODES.NOT_FOUND, { ref });
export const requirementConflict = (number) =>
  new RequirementError(409, `Requirement already exists: ${number}`, REQUIREMENT_ERROR_CODES.CONFLICT, { requirement_number: number });
export const invalidRequirement = (message, details = null) =>
  new RequirementError(400, message, REQUIREMENT_ERROR_CODES.INVALID, details);
export const statusInvalid = (status, from, allowed) =>
  new RequirementError(409, `Cannot change requirement status from ${from} to ${status}`, REQUIREMENT_ERROR_CODES.STATUS_INVALID, { status, from, allowed });
export const requirementImmutable = (ref, status) =>
  new RequirementError(409, `Requirement ${ref} is ${status} and cannot be edited; create a new revision instead`, REQUIREMENT_ERROR_CODES.IMMUTABLE, { ref, status });

// Requirement type
export const typeNotFound = (ref) =>
  new RequirementError(404, `Requirement type not found: ${ref}`, REQUIREMENT_ERROR_CODES.TYPE_NOT_FOUND, { ref });
export const typeConflict = (code) =>
  new RequirementError(409, `Requirement type already exists: ${code}`, REQUIREMENT_ERROR_CODES.TYPE_CONFLICT, { code });
export const invalidType = (message, details = null) =>
  new RequirementError(400, message, REQUIREMENT_ERROR_CODES.INVALID_TYPE, details);

// Revision
export const revisionNotFound = (ref) =>
  new RequirementError(404, `Requirement revision not found: ${ref}`, REQUIREMENT_ERROR_CODES.REVISION_NOT_FOUND, { ref });
export const revisionConflict = (details) =>
  new RequirementError(409, "A revision with that number already exists", REQUIREMENT_ERROR_CODES.REVISION_CONFLICT, details);
export const invalidRevision = (message, details = null) =>
  new RequirementError(400, message, REQUIREMENT_ERROR_CODES.INVALID_REVISION, details);

// Relationship
export const relationshipNotFound = (ref) =>
  new RequirementError(404, `Requirement relationship not found: ${ref}`, REQUIREMENT_ERROR_CODES.RELATIONSHIP_NOT_FOUND, { ref });
export const relationshipConflict = (details) =>
  new RequirementError(409, "That relationship already exists", REQUIREMENT_ERROR_CODES.RELATIONSHIP_CONFLICT, details);
export const invalidRelationship = (message, details = null) =>
  new RequirementError(400, message, REQUIREMENT_ERROR_CODES.INVALID_RELATIONSHIP, details);
export const hierarchyCycle = (details) =>
  new RequirementError(409, "The relationship would create a circular requirement hierarchy", REQUIREMENT_ERROR_CODES.CYCLE, details);

// Baseline
export const baselineNotFound = (ref) =>
  new RequirementError(404, `Requirement baseline not found: ${ref}`, REQUIREMENT_ERROR_CODES.BASELINE_NOT_FOUND, { ref });
export const baselineConflict = (number) =>
  new RequirementError(409, `Requirement baseline already exists: ${number}`, REQUIREMENT_ERROR_CODES.BASELINE_CONFLICT, { baseline_number: number });
export const invalidBaseline = (message, details = null) =>
  new RequirementError(400, message, REQUIREMENT_ERROR_CODES.INVALID_BASELINE, details);
export const baselineMemberNotFound = (ref) =>
  new RequirementError(404, `Baseline member not found: ${ref}`, REQUIREMENT_ERROR_CODES.BASELINE_MEMBER_NOT_FOUND, { ref });

// Cross-cutting
export const invalidConfiguration = (message, details = null) =>
  new RequirementError(400, message, REQUIREMENT_ERROR_CODES.INVALID_CONFIGURATION, details);
export const validationFailed = (message, details = null) =>
  new RequirementError(422, message, REQUIREMENT_ERROR_CODES.VALIDATION_FAILED, details);
export const requirementsConflict = (message, details = null) =>
  new RequirementError(409, message, REQUIREMENT_ERROR_CODES.CONFLICT, details);
export const forbidden = (message, details = null) =>
  new RequirementError(403, message, REQUIREMENT_ERROR_CODES.FORBIDDEN, details);
