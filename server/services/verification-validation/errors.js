// Standardized Verification & Validation error codes.
//
// Codes are stable identifiers clients branch on; the HTTP layer serializes them
// next to `error` and `details` (mirrors requirement-manufacturing/errors.js).
import { HttpError } from "../../validation.js";

export const VV_ERROR_CODES = Object.freeze({
  NOT_FOUND: "VERIFICATION_VALIDATION_NOT_FOUND",
  CONFLICT: "VERIFICATION_VALIDATION_CONFLICT",
  INVALID: "VERIFICATION_VALIDATION_INVALID",
  REQUIREMENT_NOT_FOUND: "VERIFICATION_VALIDATION_REQUIREMENT_NOT_FOUND",
  METHOD_NOT_FOUND: "VERIFICATION_VALIDATION_METHOD_NOT_FOUND",
  TEST_CASE_NOT_FOUND: "VERIFICATION_VALIDATION_TEST_CASE_NOT_FOUND",
  TEST_CASE_CONFLICT: "VERIFICATION_VALIDATION_TEST_CASE_CONFLICT",
  PROCEDURE_NOT_FOUND: "VERIFICATION_VALIDATION_PROCEDURE_NOT_FOUND",
  STEP_NOT_FOUND: "VERIFICATION_VALIDATION_STEP_NOT_FOUND",
  EXECUTION_NOT_FOUND: "VERIFICATION_VALIDATION_EXECUTION_NOT_FOUND",
  RESULT_NOT_FOUND: "VERIFICATION_VALIDATION_RESULT_NOT_FOUND",
  WAIVER_NOT_FOUND: "VERIFICATION_VALIDATION_WAIVER_NOT_FOUND",
  INVALID_STATE: "VERIFICATION_VALIDATION_INVALID_STATE",
  INVALID_TRANSITION: "VERIFICATION_VALIDATION_INVALID_TRANSITION",
  IMMUTABLE: "VERIFICATION_VALIDATION_IMMUTABLE",
  LIFECYCLE_VIOLATION: "VERIFICATION_VALIDATION_LIFECYCLE_VIOLATION",
  INCOMPLETE_EXECUTION: "VERIFICATION_VALIDATION_INCOMPLETE_EXECUTION",
  CRITERIA_INVALID: "VERIFICATION_VALIDATION_CRITERIA_INVALID",
  EVALUATION_FAILED: "VERIFICATION_VALIDATION_EVALUATION_FAILED",
  EVIDENCE_REQUIRED: "VERIFICATION_VALIDATION_EVIDENCE_REQUIRED",
  WAIVER_INVALID: "VERIFICATION_VALIDATION_WAIVER_INVALID",
  WAIVER_EXPIRED: "VERIFICATION_VALIDATION_WAIVER_EXPIRED",
  COVERAGE_FAILED: "VERIFICATION_VALIDATION_COVERAGE_FAILED",
  IMPACT_FAILED: "VERIFICATION_VALIDATION_IMPACT_FAILED",
  QUALITY_INTEGRATION_FAILED: "VERIFICATION_VALIDATION_QUALITY_INTEGRATION_FAILED",
  INVALID_CONFIGURATION: "VERIFICATION_VALIDATION_INVALID_CONFIGURATION",
  FORBIDDEN: "VERIFICATION_VALIDATION_FORBIDDEN",
});

export class VerificationValidationError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export const vvNotFound = (message = "Verification & Validation resource not found", details = null) =>
  new VerificationValidationError(404, message, VV_ERROR_CODES.NOT_FOUND, details);
export const vvConflict = (message, details = null) =>
  new VerificationValidationError(409, message, VV_ERROR_CODES.CONFLICT, details);
export const invalidVv = (message, details = null) =>
  new VerificationValidationError(400, message, VV_ERROR_CODES.INVALID, details);

export const requirementNotFound = (ref) =>
  new VerificationValidationError(404, `Requirement not found: ${ref}`, VV_ERROR_CODES.REQUIREMENT_NOT_FOUND, { ref });
export const methodNotFound = (ref) =>
  new VerificationValidationError(404, `V&V method not found: ${ref}`, VV_ERROR_CODES.METHOD_NOT_FOUND, { ref });
export const testCaseNotFound = (ref) =>
  new VerificationValidationError(404, `Test case not found: ${ref}`, VV_ERROR_CODES.TEST_CASE_NOT_FOUND, { ref });
export const testCaseConflict = (details) =>
  new VerificationValidationError(409, "That test case already exists", VV_ERROR_CODES.TEST_CASE_CONFLICT, details);
export const procedureNotFound = (ref) =>
  new VerificationValidationError(404, `Test procedure not found: ${ref}`, VV_ERROR_CODES.PROCEDURE_NOT_FOUND, { ref });
export const procedureConflict = (details) =>
  new VerificationValidationError(409, "That test procedure conflicts with an existing record", VV_ERROR_CODES.CONFLICT, details);
export const stepNotFound = (ref) =>
  new VerificationValidationError(404, `Procedure step not found: ${ref}`, VV_ERROR_CODES.STEP_NOT_FOUND, { ref });
export const executionNotFound = (ref) =>
  new VerificationValidationError(404, `Test execution not found: ${ref}`, VV_ERROR_CODES.EXECUTION_NOT_FOUND, { ref });
export const resultNotFound = (ref) =>
  new VerificationValidationError(404, `Test result not found: ${ref}`, VV_ERROR_CODES.RESULT_NOT_FOUND, { ref });
export const waiverNotFound = (ref) =>
  new VerificationValidationError(404, `Waiver not found: ${ref}`, VV_ERROR_CODES.WAIVER_NOT_FOUND, { ref });

export const invalidState = (message, details = null) =>
  new VerificationValidationError(400, message, VV_ERROR_CODES.INVALID_STATE, details);
export const invalidTransition = (from, to) =>
  new VerificationValidationError(409, `Invalid transition ${from} -> ${to}`, VV_ERROR_CODES.INVALID_TRANSITION, { from, to });
export const immutableRecord = (message, details = null) =>
  new VerificationValidationError(409, message, VV_ERROR_CODES.IMMUTABLE, details);
export const lifecycleViolation = (message, details = null) =>
  new VerificationValidationError(409, message, VV_ERROR_CODES.LIFECYCLE_VIOLATION, details);
export const incompleteExecution = (message, details = null) =>
  new VerificationValidationError(409, message, VV_ERROR_CODES.INCOMPLETE_EXECUTION, details);

export const criteriaInvalid = (message, details = null) =>
  new VerificationValidationError(400, message, VV_ERROR_CODES.CRITERIA_INVALID, details);
export const evaluationFailed = (message, details = null) =>
  new VerificationValidationError(409, message, VV_ERROR_CODES.EVALUATION_FAILED, details);
export const evidenceRequired = (message, details = null) =>
  new VerificationValidationError(409, message, VV_ERROR_CODES.EVIDENCE_REQUIRED, details);
export const waiverInvalid = (message, details = null) =>
  new VerificationValidationError(400, message, VV_ERROR_CODES.WAIVER_INVALID, details);
export const coverageFailed = (message, details = null) =>
  new VerificationValidationError(409, message, VV_ERROR_CODES.COVERAGE_FAILED, details);
export const impactFailed = (message, details = null) =>
  new VerificationValidationError(409, message, VV_ERROR_CODES.IMPACT_FAILED, details);
export const qualityIntegrationFailed = (message, details = null) =>
  new VerificationValidationError(409, message, VV_ERROR_CODES.QUALITY_INTEGRATION_FAILED, details);

export const invalidConfiguration = (message, details = null) =>
  new VerificationValidationError(400, message, VV_ERROR_CODES.INVALID_CONFIGURATION, details);
export const forbidden = (message, details = null) =>
  new VerificationValidationError(403, message, VV_ERROR_CODES.FORBIDDEN, details);
