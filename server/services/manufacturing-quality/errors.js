// Standardized Manufacturing & Quality integration error codes.
//
// Codes are stable identifiers clients branch on; the HTTP layer serializes them
// next to `error` and `details` (mirrors requirement-manufacturing/errors.js).
import { HttpError } from "../../validation.js";

export const MANUFACTURING_QUALITY_ERROR_CODES = Object.freeze({
  NOT_FOUND: "MANUFACTURING_QUALITY_NOT_FOUND",
  CONFLICT: "MANUFACTURING_QUALITY_CONFLICT",
  INVALID: "MANUFACTURING_QUALITY_INVALID",
  ISSUE_NOT_FOUND: "MANUFACTURING_QUALITY_ISSUE_NOT_FOUND",
  ISSUE_CONFLICT: "MANUFACTURING_QUALITY_ISSUE_CONFLICT",
  INSPECTION_NOT_FOUND: "MANUFACTURING_QUALITY_INSPECTION_NOT_FOUND",
  INSPECTION_CONFLICT: "MANUFACTURING_QUALITY_INSPECTION_CONFLICT",
  ACTION_NOT_FOUND: "MANUFACTURING_QUALITY_ACTION_NOT_FOUND",
  ACTION_CONFLICT: "MANUFACTURING_QUALITY_ACTION_CONFLICT",
  SUBJECT_NOT_FOUND: "MANUFACTURING_QUALITY_SUBJECT_NOT_FOUND",
  INVALID_SUBJECT: "MANUFACTURING_QUALITY_INVALID_SUBJECT",
  INVALID_TRANSITION: "MANUFACTURING_QUALITY_INVALID_TRANSITION",
  IMMUTABLE: "MANUFACTURING_QUALITY_IMMUTABLE",
  READINESS_FAILED: "MANUFACTURING_QUALITY_READINESS_FAILED",
  INVALID_CONFIGURATION: "MANUFACTURING_QUALITY_INVALID_CONFIGURATION",
  FORBIDDEN: "MANUFACTURING_QUALITY_FORBIDDEN",
});

export class ManufacturingQualityError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export const mqNotFound = (ref) =>
  new ManufacturingQualityError(404, `Manufacturing-Quality resource not found: ${ref}`, MANUFACTURING_QUALITY_ERROR_CODES.NOT_FOUND, { ref });
export const mqConflict = (message, details = null) =>
  new ManufacturingQualityError(409, message, MANUFACTURING_QUALITY_ERROR_CODES.CONFLICT, details);
export const invalidMq = (message, details = null) =>
  new ManufacturingQualityError(400, message, MANUFACTURING_QUALITY_ERROR_CODES.INVALID, details);

export const issueNotFound = (ref) =>
  new ManufacturingQualityError(404, `Quality issue not found: ${ref}`, MANUFACTURING_QUALITY_ERROR_CODES.ISSUE_NOT_FOUND, { ref });
export const issueConflict = (details) =>
  new ManufacturingQualityError(409, "That quality issue already exists", MANUFACTURING_QUALITY_ERROR_CODES.ISSUE_CONFLICT, details);

export const inspectionNotFound = (ref) =>
  new ManufacturingQualityError(404, `Inspection not found: ${ref}`, MANUFACTURING_QUALITY_ERROR_CODES.INSPECTION_NOT_FOUND, { ref });
export const inspectionConflict = (details) =>
  new ManufacturingQualityError(409, "That inspection already exists", MANUFACTURING_QUALITY_ERROR_CODES.INSPECTION_CONFLICT, details);

export const actionNotFound = (ref) =>
  new ManufacturingQualityError(404, `Corrective action not found: ${ref}`, MANUFACTURING_QUALITY_ERROR_CODES.ACTION_NOT_FOUND, { ref });
export const actionConflict = (details) =>
  new ManufacturingQualityError(409, "That corrective action already exists", MANUFACTURING_QUALITY_ERROR_CODES.ACTION_CONFLICT, details);

export const subjectNotFound = (subjectType, ref) =>
  new ManufacturingQualityError(404, `${subjectType} subject not found: ${ref}`, MANUFACTURING_QUALITY_ERROR_CODES.SUBJECT_NOT_FOUND, { subject_type: subjectType, ref });
export const invalidSubject = (message, details = null) =>
  new ManufacturingQualityError(400, message, MANUFACTURING_QUALITY_ERROR_CODES.INVALID_SUBJECT, details);

export const invalidTransition = (message, details = null) =>
  new ManufacturingQualityError(409, message, MANUFACTURING_QUALITY_ERROR_CODES.INVALID_TRANSITION, details);
export const immutableRecord = (message, details = null) =>
  new ManufacturingQualityError(409, message, MANUFACTURING_QUALITY_ERROR_CODES.IMMUTABLE, details);
export const readinessFailed = (message, details = null) =>
  new ManufacturingQualityError(409, message, MANUFACTURING_QUALITY_ERROR_CODES.READINESS_FAILED, details);
export const invalidConfiguration = (message, details = null) =>
  new ManufacturingQualityError(400, message, MANUFACTURING_QUALITY_ERROR_CODES.INVALID_CONFIGURATION, details);
export const forbidden = (message, details = null) =>
  new ManufacturingQualityError(403, message, MANUFACTURING_QUALITY_ERROR_CODES.FORBIDDEN, details);
