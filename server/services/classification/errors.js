// Standardized Enterprise Classification error codes.
//
// The HTTP layer serializes `code` alongside `error` and `details` so clients
// branch on stable identifiers rather than parsing prose.
import { HttpError } from "../../validation.js";

export const CLASSIFICATION_ERROR_CODES = Object.freeze({
  CLASSIFICATION_NOT_FOUND: "CLASSIFICATION_NOT_FOUND",
  CLASSIFICATION_CONFLICT: "CLASSIFICATION_CONFLICT",
  INVALID_CLASSIFICATION: "INVALID_CLASSIFICATION",
  CLASSIFICATION_IMMUTABLE: "CLASSIFICATION_IMMUTABLE",
  CLASSIFICATION_OBSOLETE: "CLASSIFICATION_OBSOLETE",
  CLASS_NOT_FOUND: "CLASSIFICATION_CLASS_NOT_FOUND",
  CLASS_CONFLICT: "CLASSIFICATION_CLASS_CONFLICT",
  INVALID_CLASS: "INVALID_CLASSIFICATION_CLASS",
  CLASS_IMMUTABLE: "CLASSIFICATION_CLASS_IMMUTABLE",
  CLASS_HIERARCHY_INVALID: "CLASSIFICATION_HIERARCHY_INVALID",
  CLASS_CYCLE: "CLASSIFICATION_CLASS_CYCLE",
  CLASS_DEPTH_EXCEEDED: "CLASSIFICATION_DEPTH_EXCEEDED",
  CHARACTERISTIC_NOT_FOUND: "CLASSIFICATION_CHARACTERISTIC_NOT_FOUND",
  CHARACTERISTIC_CONFLICT: "CLASSIFICATION_CHARACTERISTIC_CONFLICT",
  INVALID_CHARACTERISTIC: "INVALID_CLASSIFICATION_CHARACTERISTIC",
  GROUP_NOT_FOUND: "CLASSIFICATION_GROUP_NOT_FOUND",
  GROUP_CONFLICT: "CLASSIFICATION_GROUP_CONFLICT",
  INVALID_GROUP: "INVALID_CLASSIFICATION_GROUP",
  ALLOWED_VALUE_NOT_FOUND: "CLASSIFICATION_ALLOWED_VALUE_NOT_FOUND",
  ALLOWED_VALUE_CONFLICT: "CLASSIFICATION_ALLOWED_VALUE_CONFLICT",
  INVALID_ALLOWED_VALUE: "INVALID_CLASSIFICATION_ALLOWED_VALUE",
  ASSIGNMENT_NOT_FOUND: "CLASSIFICATION_ASSIGNMENT_NOT_FOUND",
  ASSIGNMENT_CONFLICT: "CLASSIFICATION_ASSIGNMENT_CONFLICT",
  INVALID_ASSIGNMENT: "INVALID_CLASSIFICATION_ASSIGNMENT",
  ASSIGNMENT_INACTIVE: "CLASSIFICATION_ASSIGNMENT_INACTIVE",
  SINGLE_CLASS_ONLY: "CLASSIFICATION_SINGLE_CLASS_ONLY",
  VALUE_INVALID: "INVALID_CLASSIFICATION_VALUE",
  VALIDATION_FAILED: "CLASSIFICATION_VALIDATION_FAILED",
  REQUIRED_CHARACTERISTIC_MISSING: "CLASSIFICATION_REQUIRED_CHARACTERISTIC_MISSING",
  UNIT_INVALID: "CLASSIFICATION_UNIT_INVALID",
  UNIT_INCOMPATIBLE: "CLASSIFICATION_UNIT_INCOMPATIBLE",
  REFERENCE_INVALID: "CLASSIFICATION_REFERENCE_INVALID",
  RULE_NOT_FOUND: "CLASSIFICATION_RULE_NOT_FOUND",
  INVALID_RULE: "INVALID_CLASSIFICATION_RULE",
  INHERITANCE_CONFLICT: "CLASSIFICATION_INHERITANCE_CONFLICT",
  OBJECT_NOT_FOUND: "CLASSIFICATION_OBJECT_NOT_FOUND",
  DUPLICATE_DETECTED: "CLASSIFICATION_DUPLICATE_DETECTED",
  SECURITY_BLOCKED: "CLASSIFICATION_SECURITY_BLOCKED",
  INVALID_CONFIGURATION: "INVALID_CLASSIFICATION_CONFIGURATION",
  SEARCH_UNAVAILABLE: "CLASSIFICATION_SEARCH_UNAVAILABLE",
  BULK_INVALID: "INVALID_CLASSIFICATION_BULK_OPERATION",
  CONFLICT: "CLASSIFICATION_CONFLICT",
});

export class ClassificationError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export const classificationNotFound = (ref) =>
  new ClassificationError(404, `Classification not found: ${ref}`, CLASSIFICATION_ERROR_CODES.CLASSIFICATION_NOT_FOUND, { ref });
export const classificationConflict = (code) =>
  new ClassificationError(409, `Classification already exists: ${code}`, CLASSIFICATION_ERROR_CODES.CLASSIFICATION_CONFLICT, { code });
export const invalidClassification = (message, details = null) =>
  new ClassificationError(400, message, CLASSIFICATION_ERROR_CODES.INVALID_CLASSIFICATION, details);
export const classificationImmutable = (ref, status) =>
  new ClassificationError(409, `Classification ${ref} is ${status} and cannot be edited in place`, CLASSIFICATION_ERROR_CODES.CLASSIFICATION_IMMUTABLE, { ref, status });
export const classificationObsolete = (ref) =>
  new ClassificationError(409, `Classification ${ref} is obsolete and cannot be assigned`, CLASSIFICATION_ERROR_CODES.CLASSIFICATION_OBSOLETE, { ref });

export const classNotFound = (ref) =>
  new ClassificationError(404, `Classification class not found: ${ref}`, CLASSIFICATION_ERROR_CODES.CLASS_NOT_FOUND, { ref });
export const classConflict = (code) =>
  new ClassificationError(409, `Classification class already exists: ${code}`, CLASSIFICATION_ERROR_CODES.CLASS_CONFLICT, { code });
export const invalidClass = (message, details = null) =>
  new ClassificationError(400, message, CLASSIFICATION_ERROR_CODES.INVALID_CLASS, details);
export const classImmutable = (ref, status) =>
  new ClassificationError(409, `Class ${ref} is ${status} and cannot be edited in place`, CLASSIFICATION_ERROR_CODES.CLASS_IMMUTABLE, { ref, status });
export const classHierarchyInvalid = (message, details = null) =>
  new ClassificationError(400, message, CLASSIFICATION_ERROR_CODES.CLASS_HIERARCHY_INVALID, details);
export const classCycle = (details) =>
  new ClassificationError(409, "A class cannot be moved beneath itself or one of its descendants", CLASSIFICATION_ERROR_CODES.CLASS_CYCLE, details);
export const classDepthExceeded = (limit) =>
  new ClassificationError(422, `Classification hierarchy depth exceeds the configured limit of ${limit}`, CLASSIFICATION_ERROR_CODES.CLASS_DEPTH_EXCEEDED, { limit });

export const characteristicNotFound = (ref) =>
  new ClassificationError(404, `Characteristic not found: ${ref}`, CLASSIFICATION_ERROR_CODES.CHARACTERISTIC_NOT_FOUND, { ref });
export const characteristicConflict = (code) =>
  new ClassificationError(409, `Characteristic already exists: ${code}`, CLASSIFICATION_ERROR_CODES.CHARACTERISTIC_CONFLICT, { code });
export const invalidCharacteristic = (message, details = null) =>
  new ClassificationError(400, message, CLASSIFICATION_ERROR_CODES.INVALID_CHARACTERISTIC, details);

export const groupNotFound = (ref) =>
  new ClassificationError(404, `Characteristic group not found: ${ref}`, CLASSIFICATION_ERROR_CODES.GROUP_NOT_FOUND, { ref });
export const groupConflict = (code) =>
  new ClassificationError(409, `Characteristic group already exists: ${code}`, CLASSIFICATION_ERROR_CODES.GROUP_CONFLICT, { code });
export const invalidGroup = (message, details = null) =>
  new ClassificationError(400, message, CLASSIFICATION_ERROR_CODES.INVALID_GROUP, details);

export const allowedValueNotFound = (ref) =>
  new ClassificationError(404, `Allowed value not found: ${ref}`, CLASSIFICATION_ERROR_CODES.ALLOWED_VALUE_NOT_FOUND, { ref });
export const allowedValueConflict = (code) =>
  new ClassificationError(409, `Allowed value already exists: ${code}`, CLASSIFICATION_ERROR_CODES.ALLOWED_VALUE_CONFLICT, { code });
export const invalidAllowedValue = (message, details = null) =>
  new ClassificationError(400, message, CLASSIFICATION_ERROR_CODES.INVALID_ALLOWED_VALUE, details);

export const assignmentNotFound = (ref) =>
  new ClassificationError(404, `Classification assignment not found: ${ref}`, CLASSIFICATION_ERROR_CODES.ASSIGNMENT_NOT_FOUND, { ref });
export const assignmentConflict = (details) =>
  new ClassificationError(409, "This object is already classified with that class", CLASSIFICATION_ERROR_CODES.ASSIGNMENT_CONFLICT, details);
export const invalidAssignment = (message, details = null) =>
  new ClassificationError(400, message, CLASSIFICATION_ERROR_CODES.INVALID_ASSIGNMENT, details);
export const assignmentInactive = (ref) =>
  new ClassificationError(409, `Classification assignment ${ref} is not active`, CLASSIFICATION_ERROR_CODES.ASSIGNMENT_INACTIVE, { ref });
export const singleClassOnly = (objectType) =>
  new ClassificationError(409, `Object type ${objectType} allows a single classification only`, CLASSIFICATION_ERROR_CODES.SINGLE_CLASS_ONLY, { object_type: objectType });

export const invalidValue = (message, details = null) =>
  new ClassificationError(400, message, CLASSIFICATION_ERROR_CODES.VALUE_INVALID, details);
export const validationFailed = (details) =>
  new ClassificationError(422, "Classification validation failed", CLASSIFICATION_ERROR_CODES.VALIDATION_FAILED, details);
export const requiredCharacteristicMissing = (details) =>
  new ClassificationError(422, "Required characteristics are missing", CLASSIFICATION_ERROR_CODES.REQUIRED_CHARACTERISTIC_MISSING, details);
export const invalidUnit = (message, details = null) =>
  new ClassificationError(400, message, CLASSIFICATION_ERROR_CODES.UNIT_INVALID, details);
export const incompatibleUnit = (details) =>
  new ClassificationError(422, "Units are not compatible", CLASSIFICATION_ERROR_CODES.UNIT_INCOMPATIBLE, details);
export const invalidReference = (message, details = null) =>
  new ClassificationError(400, message, CLASSIFICATION_ERROR_CODES.REFERENCE_INVALID, details);

export const ruleNotFound = (ref) =>
  new ClassificationError(404, `Classification rule not found: ${ref}`, CLASSIFICATION_ERROR_CODES.RULE_NOT_FOUND, { ref });
export const invalidRule = (message, details = null) =>
  new ClassificationError(400, message, CLASSIFICATION_ERROR_CODES.INVALID_RULE, details);

export const inheritanceConflict = (details) =>
  new ClassificationError(409, "Characteristic inheritance is ambiguous", CLASSIFICATION_ERROR_CODES.INHERITANCE_CONFLICT, details);
export const objectNotFound = (details) =>
  new ClassificationError(404, "Object not found", CLASSIFICATION_ERROR_CODES.OBJECT_NOT_FOUND, details);
export const duplicateDetected = (details) =>
  new ClassificationError(409, "Potential duplicate objects detected", CLASSIFICATION_ERROR_CODES.DUPLICATE_DETECTED, details);

export const securityBlocked = (details) =>
  new ClassificationError(403, "Blocked by security policy", CLASSIFICATION_ERROR_CODES.SECURITY_BLOCKED, details);
export const invalidConfiguration = (message, details = null) =>
  new ClassificationError(400, message, CLASSIFICATION_ERROR_CODES.INVALID_CONFIGURATION, details);
export const bulkInvalid = (message, details = null) =>
  new ClassificationError(400, message, CLASSIFICATION_ERROR_CODES.BULK_INVALID, details);
export const classificationConflictError = (message, details = null) =>
  new ClassificationError(409, message, CLASSIFICATION_ERROR_CODES.CONFLICT, details);
