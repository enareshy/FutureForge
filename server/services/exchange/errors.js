// Standardized Standards & Exchange error codes.
//
// The HTTP layer serializes `code` alongside `error` and `details` so clients
// branch on stable identifiers rather than parsing prose.
import { HttpError } from "../../validation.js";

export const EXCHANGE_ERROR_CODES = Object.freeze({
  FORMAT_NOT_FOUND: "EXCHANGE_FORMAT_NOT_FOUND",
  FORMAT_CONFLICT: "EXCHANGE_FORMAT_CONFLICT",
  INVALID_FORMAT: "EXCHANGE_INVALID_FORMAT",
  ADAPTER_NOT_FOUND: "EXCHANGE_ADAPTER_NOT_FOUND",
  ADAPTER_UNAVAILABLE: "EXCHANGE_ADAPTER_UNAVAILABLE",
  DEFINITION_NOT_FOUND: "EXCHANGE_DEFINITION_NOT_FOUND",
  DEFINITION_CONFLICT: "EXCHANGE_DEFINITION_CONFLICT",
  INVALID_DEFINITION: "EXCHANGE_INVALID_DEFINITION",
  DEFINITION_IMMUTABLE: "EXCHANGE_DEFINITION_IMMUTABLE",
  MAPPING_NOT_FOUND: "EXCHANGE_MAPPING_NOT_FOUND",
  MAPPING_CONFLICT: "EXCHANGE_MAPPING_CONFLICT",
  INVALID_MAPPING: "EXCHANGE_INVALID_MAPPING",
  MAPPING_IMMUTABLE: "EXCHANGE_MAPPING_IMMUTABLE",
  TRANSFORMATION_NOT_FOUND: "EXCHANGE_TRANSFORMATION_NOT_FOUND",
  TRANSFORMATION_CONFLICT: "EXCHANGE_TRANSFORMATION_CONFLICT",
  INVALID_TRANSFORMATION: "EXCHANGE_INVALID_TRANSFORMATION",
  TRANSFORMATION_IMMUTABLE: "EXCHANGE_TRANSFORMATION_IMMUTABLE",
  VALIDATION_PROFILE_NOT_FOUND: "EXCHANGE_VALIDATION_PROFILE_NOT_FOUND",
  VALIDATION_PROFILE_CONFLICT: "EXCHANGE_VALIDATION_PROFILE_CONFLICT",
  INVALID_VALIDATION_PROFILE: "EXCHANGE_INVALID_VALIDATION_PROFILE",
  VALIDATION_FAILED: "EXCHANGE_VALIDATION_FAILED",
  TRANSACTION_NOT_FOUND: "EXCHANGE_TRANSACTION_NOT_FOUND",
  TRANSACTION_CONFLICT: "EXCHANGE_TRANSACTION_CONFLICT",
  TRANSACTION_IMMUTABLE: "EXCHANGE_TRANSACTION_IMMUTABLE",
  INVALID_TRANSACTION: "EXCHANGE_INVALID_TRANSACTION",
  JOB_NOT_FOUND: "EXCHANGE_JOB_NOT_FOUND",
  INVALID_JOB: "EXCHANGE_INVALID_JOB",
  DETECTION_FAILED: "EXCHANGE_DETECTION_FAILED",
  PARSE_FAILED: "EXCHANGE_PARSE_FAILED",
  SERIALIZE_FAILED: "EXCHANGE_SERIALIZE_FAILED",
  PAYLOAD_TOO_LARGE: "EXCHANGE_PAYLOAD_TOO_LARGE",
  UNSUPPORTED_OPERATION: "EXCHANGE_UNSUPPORTED_OPERATION",
  SECURITY_BLOCKED: "EXCHANGE_SECURITY_BLOCKED",
  CLASSIFICATION_BLOCKED: "EXCHANGE_CLASSIFICATION_BLOCKED",
  IDEMPOTENCY_CONFLICT: "EXCHANGE_IDEMPOTENCY_CONFLICT",
  INVALID_QUERY: "EXCHANGE_INVALID_QUERY",
  CONFLICT: "EXCHANGE_CONFLICT",
});

export class ExchangeError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export const formatNotFound = (ref) =>
  new ExchangeError(404, `Exchange format not found: ${ref}`, EXCHANGE_ERROR_CODES.FORMAT_NOT_FOUND, { ref });
export const formatConflict = (code) =>
  new ExchangeError(409, `Exchange format already exists: ${code}`, EXCHANGE_ERROR_CODES.FORMAT_CONFLICT, { code });
export const invalidFormat = (message, details = null) =>
  new ExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_FORMAT, details);

export const adapterNotFound = (code) =>
  new ExchangeError(404, `Exchange adapter not found: ${code}`, EXCHANGE_ERROR_CODES.ADAPTER_NOT_FOUND, { code });
export const adapterUnavailable = (code, status, message = null) =>
  new ExchangeError(
    422,
    message || `Exchange adapter ${code} is not available (status: ${status || "UNKNOWN"})`,
    EXCHANGE_ERROR_CODES.ADAPTER_UNAVAILABLE,
    { code, status }
  );

export const definitionNotFound = (ref) =>
  new ExchangeError(404, `Exchange definition not found: ${ref}`, EXCHANGE_ERROR_CODES.DEFINITION_NOT_FOUND, { ref });
export const definitionConflict = (code) =>
  new ExchangeError(409, `Exchange definition already exists: ${code}`, EXCHANGE_ERROR_CODES.DEFINITION_CONFLICT, { code });
export const invalidDefinition = (message, details = null) =>
  new ExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_DEFINITION, details);
export const definitionImmutable = (ref, version) =>
  new ExchangeError(409, `Exchange definition ${ref} version ${version} is published and immutable`, EXCHANGE_ERROR_CODES.DEFINITION_IMMUTABLE, { ref, version });

export const mappingNotFound = (ref) =>
  new ExchangeError(404, `Exchange mapping not found: ${ref}`, EXCHANGE_ERROR_CODES.MAPPING_NOT_FOUND, { ref });
export const mappingConflict = (code) =>
  new ExchangeError(409, `Exchange mapping already exists: ${code}`, EXCHANGE_ERROR_CODES.MAPPING_CONFLICT, { code });
export const invalidMapping = (message, details = null) =>
  new ExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_MAPPING, details);
export const mappingImmutable = (ref, version) =>
  new ExchangeError(409, `Exchange mapping ${ref} version ${version} is published and immutable`, EXCHANGE_ERROR_CODES.MAPPING_IMMUTABLE, { ref, version });

export const transformationNotFound = (ref) =>
  new ExchangeError(404, `Exchange transformation not found: ${ref}`, EXCHANGE_ERROR_CODES.TRANSFORMATION_NOT_FOUND, { ref });
export const transformationConflict = (code) =>
  new ExchangeError(409, `Exchange transformation already exists: ${code}`, EXCHANGE_ERROR_CODES.TRANSFORMATION_CONFLICT, { code });
export const invalidTransformation = (message, details = null) =>
  new ExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_TRANSFORMATION, details);
export const transformationImmutable = (ref, version) =>
  new ExchangeError(409, `Exchange transformation ${ref} version ${version} is published and immutable`, EXCHANGE_ERROR_CODES.TRANSFORMATION_IMMUTABLE, { ref, version });

export const validationProfileNotFound = (ref) =>
  new ExchangeError(404, `Exchange validation profile not found: ${ref}`, EXCHANGE_ERROR_CODES.VALIDATION_PROFILE_NOT_FOUND, { ref });
export const validationProfileConflict = (code) =>
  new ExchangeError(409, `Exchange validation profile already exists: ${code}`, EXCHANGE_ERROR_CODES.VALIDATION_PROFILE_CONFLICT, { code });
export const invalidValidationProfile = (message, details = null) =>
  new ExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_VALIDATION_PROFILE, details);

export const transactionNotFound = (ref) =>
  new ExchangeError(404, `Exchange transaction not found: ${ref}`, EXCHANGE_ERROR_CODES.TRANSACTION_NOT_FOUND, { ref });
export const transactionConflict = (ref) =>
  new ExchangeError(409, `Exchange transaction already exists: ${ref}`, EXCHANGE_ERROR_CODES.TRANSACTION_CONFLICT, { ref });
export const transactionImmutable = (ref) =>
  new ExchangeError(409, `Exchange transaction ${ref} is complete and immutable`, EXCHANGE_ERROR_CODES.TRANSACTION_IMMUTABLE, { ref });
export const invalidTransaction = (message, details = null) =>
  new ExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_TRANSACTION, details);

export const jobNotFound = (ref) =>
  new ExchangeError(404, `Exchange job not found: ${ref}`, EXCHANGE_ERROR_CODES.JOB_NOT_FOUND, { ref });
export const invalidJob = (message, details = null) =>
  new ExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_JOB, details);

export const detectionFailed = (message, details = null) =>
  new ExchangeError(422, message, EXCHANGE_ERROR_CODES.DETECTION_FAILED, details);
export const parseFailed = (message, details = null) =>
  new ExchangeError(422, message, EXCHANGE_ERROR_CODES.PARSE_FAILED, details);
export const serializeFailed = (message, details = null) =>
  new ExchangeError(422, message, EXCHANGE_ERROR_CODES.SERIALIZE_FAILED, details);
export const payloadTooLarge = (size, limit) =>
  new ExchangeError(413, `Exchange payload of ${size} bytes exceeds the ${limit} byte limit`, EXCHANGE_ERROR_CODES.PAYLOAD_TOO_LARGE, { size, limit });
export const unsupportedOperation = (message, details = null) =>
  new ExchangeError(422, message, EXCHANGE_ERROR_CODES.UNSUPPORTED_OPERATION, details);
export const securityBlocked = (details) =>
  new ExchangeError(403, "Blocked by security policy", EXCHANGE_ERROR_CODES.SECURITY_BLOCKED, details);
export const classificationBlocked = (details) =>
  new ExchangeError(403, "Blocked by data classification policy", EXCHANGE_ERROR_CODES.CLASSIFICATION_BLOCKED, details);
export const idempotencyConflict = (key) =>
  new ExchangeError(409, `A transaction with idempotency key ${key} already exists`, EXCHANGE_ERROR_CODES.IDEMPOTENCY_CONFLICT, { idempotency_key: key });
export const invalidQuery = (message, details = null) =>
  new ExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_QUERY, details);
export const exchangeConflict = (message, details = null) =>
  new ExchangeError(409, message, EXCHANGE_ERROR_CODES.CONFLICT, details);

// Validation failures are returned as data, not thrown, except when a caller
// explicitly requests fail-fast behaviour.
export class ValidationFailure extends ExchangeError {
  constructor(result) {
    super(422, "Exchange validation failed", EXCHANGE_ERROR_CODES.VALIDATION_FAILED, { result });
    this.result = result;
  }
}
