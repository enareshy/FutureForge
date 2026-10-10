// Standardized Requirement -> Manufacturing integration error codes.
//
// Codes are stable identifiers clients branch on; the HTTP layer serializes them
// next to `error` and `details` (mirrors requirement-pdm/errors.js).
import { HttpError } from "../../validation.js";

export const REQUIREMENT_MANUFACTURING_ERROR_CODES = Object.freeze({
  NOT_FOUND: "REQUIREMENT_MANUFACTURING_NOT_FOUND",
  CONFLICT: "REQUIREMENT_MANUFACTURING_CONFLICT",
  INVALID: "REQUIREMENT_MANUFACTURING_INVALID",
  REQUIREMENT_NOT_FOUND: "REQUIREMENT_MANUFACTURING_REQUIREMENT_NOT_FOUND",
  TARGET_NOT_FOUND: "REQUIREMENT_MANUFACTURING_TARGET_NOT_FOUND",
  INVALID_TARGET: "REQUIREMENT_MANUFACTURING_INVALID_TARGET",
  INVALID_RELATIONSHIP: "REQUIREMENT_MANUFACTURING_INVALID_RELATIONSHIP",
  ALLOCATION_NOT_FOUND: "REQUIREMENT_MANUFACTURING_ALLOCATION_NOT_FOUND",
  ALLOCATION_CONFLICT: "REQUIREMENT_MANUFACTURING_ALLOCATION_CONFLICT",
  COMPATIBILITY_FAILED: "REQUIREMENT_MANUFACTURING_COMPATIBILITY_FAILED",
  EFFECTIVITY_INVALID: "REQUIREMENT_MANUFACTURING_EFFECTIVITY_INVALID",
  MAPPING_NOT_FOUND: "REQUIREMENT_MANUFACTURING_MAPPING_NOT_FOUND",
  INVALID_MAPPING: "REQUIREMENT_MANUFACTURING_INVALID_MAPPING",
  OPERATION_NOT_FOUND: "REQUIREMENT_MANUFACTURING_OPERATION_NOT_FOUND",
  WORK_CENTER_NOT_FOUND: "REQUIREMENT_MANUFACTURING_WORK_CENTER_NOT_FOUND",
  BOP_NOT_FOUND: "REQUIREMENT_MANUFACTURING_BOP_NOT_FOUND",
  INVALID_PROCESS: "REQUIREMENT_MANUFACTURING_INVALID_PROCESS",
  CHARACTERISTIC_NOT_FOUND: "REQUIREMENT_MANUFACTURING_CHARACTERISTIC_NOT_FOUND",
  VALIDATION_FAILED: "REQUIREMENT_MANUFACTURING_VALIDATION_FAILED",
  COVERAGE_FAILED: "REQUIREMENT_MANUFACTURING_COVERAGE_FAILED",
  IMPACT_FAILED: "REQUIREMENT_MANUFACTURING_IMPACT_FAILED",
  SYNCHRONIZATION_FAILED: "REQUIREMENT_MANUFACTURING_SYNCHRONIZATION_FAILED",
  INVALID_CONFIGURATION: "REQUIREMENT_MANUFACTURING_INVALID_CONFIGURATION",
  FORBIDDEN: "REQUIREMENT_MANUFACTURING_FORBIDDEN",
});

export class RequirementManufacturingError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export const integrationNotFound = (ref) =>
  new RequirementManufacturingError(404, `Requirement-Manufacturing resource not found: ${ref}`, REQUIREMENT_MANUFACTURING_ERROR_CODES.NOT_FOUND, { ref });
export const integrationConflict = (message, details = null) =>
  new RequirementManufacturingError(409, message, REQUIREMENT_MANUFACTURING_ERROR_CODES.CONFLICT, details);
export const invalidIntegration = (message, details = null) =>
  new RequirementManufacturingError(400, message, REQUIREMENT_MANUFACTURING_ERROR_CODES.INVALID, details);

export const requirementNotFound = (ref) =>
  new RequirementManufacturingError(404, `Requirement not found: ${ref}`, REQUIREMENT_MANUFACTURING_ERROR_CODES.REQUIREMENT_NOT_FOUND, { ref });
export const targetNotFound = (targetType, ref) =>
  new RequirementManufacturingError(404, `${targetType} target not found: ${ref}`, REQUIREMENT_MANUFACTURING_ERROR_CODES.TARGET_NOT_FOUND, { target_type: targetType, ref });
export const invalidTarget = (message, details = null) =>
  new RequirementManufacturingError(400, message, REQUIREMENT_MANUFACTURING_ERROR_CODES.INVALID_TARGET, details);
export const invalidRelationship = (message, details = null) =>
  new RequirementManufacturingError(400, message, REQUIREMENT_MANUFACTURING_ERROR_CODES.INVALID_RELATIONSHIP, details);

export const allocationNotFound = (ref) =>
  new RequirementManufacturingError(404, `Manufacturing allocation not found: ${ref}`, REQUIREMENT_MANUFACTURING_ERROR_CODES.ALLOCATION_NOT_FOUND, { ref });
export const allocationConflict = (details) =>
  new RequirementManufacturingError(409, "That manufacturing allocation already exists", REQUIREMENT_MANUFACTURING_ERROR_CODES.ALLOCATION_CONFLICT, details);
export const allocationStatusInvalid = (message, details = null) =>
  new RequirementManufacturingError(400, message, REQUIREMENT_MANUFACTURING_ERROR_CODES.INVALID_RELATIONSHIP, details);

export const compatibilityFailed = (message, details = null) =>
  new RequirementManufacturingError(409, message, REQUIREMENT_MANUFACTURING_ERROR_CODES.COMPATIBILITY_FAILED, details);
export const effectivityInvalid = (message, details = null) =>
  new RequirementManufacturingError(400, message, REQUIREMENT_MANUFACTURING_ERROR_CODES.EFFECTIVITY_INVALID, details);

export const mappingNotFound = (ref) =>
  new RequirementManufacturingError(404, `EBOM-to-MBOM mapping not found: ${ref}`, REQUIREMENT_MANUFACTURING_ERROR_CODES.MAPPING_NOT_FOUND, { ref });
export const invalidMapping = (message, details = null) =>
  new RequirementManufacturingError(400, message, REQUIREMENT_MANUFACTURING_ERROR_CODES.INVALID_MAPPING, details);

export const operationNotFound = (ref) =>
  new RequirementManufacturingError(404, `Operation not found: ${ref}`, REQUIREMENT_MANUFACTURING_ERROR_CODES.OPERATION_NOT_FOUND, { ref });
export const workCenterNotFound = (ref) =>
  new RequirementManufacturingError(404, `Work center not found: ${ref}`, REQUIREMENT_MANUFACTURING_ERROR_CODES.WORK_CENTER_NOT_FOUND, { ref });
export const characteristicNotFound = (ref) =>
  new RequirementManufacturingError(404, `Characteristic not found: ${ref}`, REQUIREMENT_MANUFACTURING_ERROR_CODES.CHARACTERISTIC_NOT_FOUND, { ref });
export const bopNotFound = (ref) =>
  new RequirementManufacturingError(404, `BOP / process plan not found: ${ref}`, REQUIREMENT_MANUFACTURING_ERROR_CODES.BOP_NOT_FOUND, { ref });
export const invalidProcess = (message, details = null) =>
  new RequirementManufacturingError(400, message, REQUIREMENT_MANUFACTURING_ERROR_CODES.INVALID_PROCESS, details);

export const validationFailed = (message, details = null) =>
  new RequirementManufacturingError(409, message, REQUIREMENT_MANUFACTURING_ERROR_CODES.VALIDATION_FAILED, details);
export const coverageFailed = (message, details = null) =>
  new RequirementManufacturingError(409, message, REQUIREMENT_MANUFACTURING_ERROR_CODES.COVERAGE_FAILED, details);
export const impactFailed = (message, details = null) =>
  new RequirementManufacturingError(409, message, REQUIREMENT_MANUFACTURING_ERROR_CODES.IMPACT_FAILED, details);
export const synchronizationFailed = (message, details = null) =>
  new RequirementManufacturingError(409, message, REQUIREMENT_MANUFACTURING_ERROR_CODES.SYNCHRONIZATION_FAILED, details);

export const invalidConfiguration = (message, details = null) =>
  new RequirementManufacturingError(400, message, REQUIREMENT_MANUFACTURING_ERROR_CODES.INVALID_CONFIGURATION, details);
export const forbidden = (message, details = null) =>
  new RequirementManufacturingError(403, message, REQUIREMENT_MANUFACTURING_ERROR_CODES.FORBIDDEN, details);
