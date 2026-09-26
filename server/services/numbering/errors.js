// Standardized Numbering Service error codes. Business modules map these to
// their own UI copy; the HTTP layer serializes `code` alongside `error`.
import { HttpError } from "../../validation.js";

export const NUMBERING_ERROR_CODES = Object.freeze({
  SCHEME_NOT_FOUND: "NUMBERING_SCHEME_NOT_FOUND",
  SCHEME_INACTIVE: "NUMBERING_SCHEME_INACTIVE",
  SCHEME_CONFLICT: "NUMBERING_SCHEME_CONFLICT",
  SCHEME_VERSION_NOT_FOUND: "NUMBERING_SCHEME_VERSION_NOT_FOUND",
  NO_APPLICABLE_SCHEME: "NO_APPLICABLE_NUMBERING_SCHEME",
  AMBIGUOUS_SCHEME: "AMBIGUOUS_NUMBERING_SCHEME",
  SEQUENCE_EXHAUSTED: "SEQUENCE_EXHAUSTED",
  SEQUENCE_NOT_FOUND: "NUMBERING_SEQUENCE_NOT_FOUND",
  NUMBER_ALREADY_EXISTS: "NUMBER_ALREADY_EXISTS",
  NUMBER_ALREADY_CONSUMED: "NUMBER_ALREADY_CONSUMED",
  ALLOCATION_NOT_FOUND: "NUMBERING_ALLOCATION_NOT_FOUND",
  RESERVATION_EXPIRED: "RESERVATION_EXPIRED",
  INVALID_NUMBER_FORMAT: "INVALID_NUMBER_FORMAT",
  INVALID_PATTERN: "INVALID_NUMBERING_PATTERN",
  MANUAL_NUMBERING_NOT_ALLOWED: "MANUAL_NUMBERING_NOT_ALLOWED",
  INVALID_SCOPE: "INVALID_SCOPE",
  INVALID_OBJECT_TYPE: "INVALID_OBJECT_TYPE",
  INVALID_CLASSIFICATION: "INVALID_CLASSIFICATION",
  UNAUTHORIZED_OPERATION: "UNAUTHORIZED_NUMBERING_OPERATION",
  CONCURRENCY_CONFLICT: "NUMBERING_CONCURRENCY_CONFLICT",
  IDEMPOTENCY_CONFLICT: "NUMBERING_IDEMPOTENCY_CONFLICT",
});

export class NumberingError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export function schemeNotFound(ref) {
  return new NumberingError(404, `Numbering scheme not found: ${ref}`, NUMBERING_ERROR_CODES.SCHEME_NOT_FOUND);
}

export function schemeInactive(ref) {
  return new NumberingError(409, `Numbering scheme is not active: ${ref}`, NUMBERING_ERROR_CODES.SCHEME_INACTIVE);
}

export function noApplicableScheme(details) {
  return new NumberingError(
    422,
    "No applicable active numbering scheme matches the requested scope",
    NUMBERING_ERROR_CODES.NO_APPLICABLE_SCHEME,
    details
  );
}

export function ambiguousScheme(details) {
  return new NumberingError(
    409,
    "Multiple numbering schemes match the requested scope with equal specificity and priority",
    NUMBERING_ERROR_CODES.AMBIGUOUS_SCHEME,
    details
  );
}

export function sequenceExhausted(details) {
  return new NumberingError(409, "Numbering sequence is exhausted", NUMBERING_ERROR_CODES.SEQUENCE_EXHAUSTED, details);
}

export function numberAlreadyExists(number) {
  return new NumberingError(409, `Number "${number}" already exists in this scope`, NUMBERING_ERROR_CODES.NUMBER_ALREADY_EXISTS, {
    number,
  });
}

export function invalidNumberFormat(message, details) {
  return new NumberingError(400, message, NUMBERING_ERROR_CODES.INVALID_NUMBER_FORMAT, details);
}

export function invalidPattern(message, details) {
  return new NumberingError(400, message, NUMBERING_ERROR_CODES.INVALID_PATTERN, details);
}

export function manualNumberingNotAllowed() {
  return new NumberingError(
    403,
    "Manual numbering is not allowed by the applicable scheme",
    NUMBERING_ERROR_CODES.MANUAL_NUMBERING_NOT_ALLOWED
  );
}

export function invalidObjectType(code) {
  return new NumberingError(400, `Unknown or inactive object type: ${code}`, NUMBERING_ERROR_CODES.INVALID_OBJECT_TYPE, {
    objectType: code,
  });
}

export function allocationNotFound(ref) {
  return new NumberingError(404, `Number allocation not found: ${ref}`, NUMBERING_ERROR_CODES.ALLOCATION_NOT_FOUND);
}

export function reservationExpired(ref) {
  return new NumberingError(409, `Reservation has expired: ${ref}`, NUMBERING_ERROR_CODES.RESERVATION_EXPIRED, { ref });
}

export function numberAlreadyConsumed(ref) {
  return new NumberingError(409, `Allocation is already consumed: ${ref}`, NUMBERING_ERROR_CODES.NUMBER_ALREADY_CONSUMED, {
    ref,
  });
}
