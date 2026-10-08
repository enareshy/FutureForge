// Standardized Requirement -> PDM integration error codes.
//
// Codes are stable identifiers clients branch on, serialized next to `error`
// and `details` by the HTTP layer (mirrors requirements/errors.js).
import { HttpError } from "../../validation.js";

export const REQUIREMENT_PDM_ERROR_CODES = Object.freeze({
  NOT_FOUND: "REQUIREMENT_PDM_NOT_FOUND",
  CONFLICT: "REQUIREMENT_PDM_CONFLICT",
  INVALID: "REQUIREMENT_PDM_INVALID",
  REQUIREMENT_NOT_FOUND: "REQUIREMENT_PDM_REQUIREMENT_NOT_FOUND",
  TARGET_NOT_FOUND: "REQUIREMENT_PDM_TARGET_NOT_FOUND",
  INVALID_TARGET: "REQUIREMENT_PDM_INVALID_TARGET",
  INVALID_RELATIONSHIP: "REQUIREMENT_PDM_INVALID_RELATIONSHIP",
  ALLOCATION_NOT_FOUND: "REQUIREMENT_PDM_ALLOCATION_NOT_FOUND",
  ALLOCATION_CONFLICT: "REQUIREMENT_PDM_ALLOCATION_CONFLICT",
  STATUS_INVALID: "REQUIREMENT_PDM_STATUS_INVALID",
  COMPATIBILITY_FAILED: "REQUIREMENT_PDM_COMPATIBILITY_FAILED",
  EFFECTIVITY_INVALID: "REQUIREMENT_PDM_EFFECTIVITY_INVALID",
  CONFIGURATION_RULE_FAILED: "REQUIREMENT_PDM_CONFIGURATION_RULE_FAILED",
  IMPACT_FAILED: "REQUIREMENT_PDM_IMPACT_FAILED",
  SYNCHRONIZATION_FAILED: "REQUIREMENT_PDM_SYNCHRONIZATION_FAILED",
  INVALID_CONFIGURATION: "REQUIREMENT_PDM_INVALID_CONFIGURATION",
  FORBIDDEN: "REQUIREMENT_PDM_FORBIDDEN",
});

export class RequirementPdmError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export const integrationNotFound = (ref) =>
  new RequirementPdmError(404, `Requirement-PDM integration resource not found: ${ref}`, REQUIREMENT_PDM_ERROR_CODES.NOT_FOUND, { ref });
export const integrationConflict = (message, details = null) =>
  new RequirementPdmError(409, message, REQUIREMENT_PDM_ERROR_CODES.CONFLICT, details);
export const invalidIntegration = (message, details = null) =>
  new RequirementPdmError(400, message, REQUIREMENT_PDM_ERROR_CODES.INVALID, details);

export const requirementNotFound = (ref) =>
  new RequirementPdmError(404, `Requirement not found: ${ref}`, REQUIREMENT_PDM_ERROR_CODES.REQUIREMENT_NOT_FOUND, { ref });
export const targetNotFound = (targetType, ref) =>
  new RequirementPdmError(404, `${targetType} target not found: ${ref}`, REQUIREMENT_PDM_ERROR_CODES.TARGET_NOT_FOUND, { target_type: targetType, ref });
export const invalidTarget = (message, details = null) =>
  new RequirementPdmError(400, message, REQUIREMENT_PDM_ERROR_CODES.INVALID_TARGET, details);
export const invalidRelationship = (message, details = null) =>
  new RequirementPdmError(400, message, REQUIREMENT_PDM_ERROR_CODES.INVALID_RELATIONSHIP, details);

export const allocationNotFound = (ref) =>
  new RequirementPdmError(404, `Requirement allocation not found: ${ref}`, REQUIREMENT_PDM_ERROR_CODES.ALLOCATION_NOT_FOUND, { ref });
export const allocationConflict = (details) =>
  new RequirementPdmError(409, "That requirement allocation already exists", REQUIREMENT_PDM_ERROR_CODES.ALLOCATION_CONFLICT, details);
export const statusInvalid = (status, allowed) =>
  new RequirementPdmError(409, `Allocation status ${status} is not valid`, REQUIREMENT_PDM_ERROR_CODES.STATUS_INVALID, { status, allowed });

export const compatibilityFailed = (message, details = null) =>
  new RequirementPdmError(409, message, REQUIREMENT_PDM_ERROR_CODES.COMPATIBILITY_FAILED, details);
export const effectivityInvalid = (message, details = null) =>
  new RequirementPdmError(400, message, REQUIREMENT_PDM_ERROR_CODES.EFFECTIVITY_INVALID, details);
export const configurationRuleFailed = (message, details = null) =>
  new RequirementPdmError(409, message, REQUIREMENT_PDM_ERROR_CODES.CONFIGURATION_RULE_FAILED, details);
export const impactFailed = (message, details = null) =>
  new RequirementPdmError(409, message, REQUIREMENT_PDM_ERROR_CODES.IMPACT_FAILED, details);
export const synchronizationFailed = (message, details = null) =>
  new RequirementPdmError(409, message, REQUIREMENT_PDM_ERROR_CODES.SYNCHRONIZATION_FAILED, details);

export const invalidConfiguration = (message, details = null) =>
  new RequirementPdmError(400, message, REQUIREMENT_PDM_ERROR_CODES.INVALID_CONFIGURATION, details);
export const forbidden = (message, details = null) =>
  new RequirementPdmError(403, message, REQUIREMENT_PDM_ERROR_CODES.FORBIDDEN, details);
