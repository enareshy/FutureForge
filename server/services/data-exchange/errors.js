// Standardized Import & Export Framework error codes. The HTTP layer serializes
// `code` alongside `error` and `details` so clients branch on stable identifiers.
import { HttpError } from "../../validation.js";

export const EXCHANGE_ERROR_CODES = Object.freeze({
  DEFINITION_NOT_FOUND: "DATA_EXCHANGE_DEFINITION_NOT_FOUND",
  DEFINITION_CONFLICT: "DATA_EXCHANGE_DEFINITION_CONFLICT",
  INVALID_DEFINITION: "INVALID_DATA_EXCHANGE_DEFINITION",
  DEFINITION_IMMUTABLE: "DATA_EXCHANGE_DEFINITION_IMMUTABLE",
  CONNECTOR_NOT_FOUND: "DATA_EXCHANGE_CONNECTOR_NOT_FOUND",
  CONNECTOR_UNSUPPORTED: "DATA_EXCHANGE_CONNECTOR_UNSUPPORTED",
  INVALID_CONNECTOR: "INVALID_DATA_EXCHANGE_CONNECTOR",
  CONNECTOR_FAILED: "DATA_EXCHANGE_CONNECTOR_FAILED",
  CONNECTION_FAILED: "DATA_EXCHANGE_CONNECTION_FAILED",
  INVALID_MAPPING: "INVALID_DATA_EXCHANGE_MAPPING",
  MAPPING_INVALID: "DATA_EXCHANGE_MAPPING_INVALID",
  MAPPING_BLOCKED: "DATA_EXCHANGE_MAPPING_BLOCKED",
  UNKNOWN_SOURCE_FIELD: "DATA_EXCHANGE_UNKNOWN_SOURCE_FIELD",
  UNKNOWN_TARGET_FIELD: "DATA_EXCHANGE_UNKNOWN_TARGET_FIELD",
  DUPLICATE_TARGET_MAPPING: "DATA_EXCHANGE_DUPLICATE_TARGET_MAPPING",
  INVALID_TRANSFORMATION: "INVALID_DATA_EXCHANGE_TRANSFORMATION",
  TRANSFORMATION_FAILED: "DATA_EXCHANGE_TRANSFORMATION_FAILED",
  INVALID_EXPRESSION: "DATA_EXCHANGE_INVALID_EXPRESSION",
  INVALID_LOOKUP: "DATA_EXCHANGE_INVALID_LOOKUP",
  LOOKUP_NOT_FOUND: "DATA_EXCHANGE_LOOKUP_NOT_FOUND",
  INVALID_VALIDATION: "INVALID_DATA_EXCHANGE_VALIDATION",
  VALIDATION_FAILED: "DATA_EXCHANGE_VALIDATION_FAILED",
  JOB_NOT_FOUND: "DATA_EXCHANGE_JOB_NOT_FOUND",
  JOB_CONFLICT: "DATA_EXCHANGE_JOB_CONFLICT",
  JOB_FAILED: "DATA_EXCHANGE_JOB_FAILED",
  JOB_NOT_CANCELLABLE: "DATA_EXCHANGE_JOB_NOT_CANCELLABLE",
  JOB_NOT_RETRYABLE: "DATA_EXCHANGE_JOB_NOT_RETRYABLE",
  INVALID_MODE: "INVALID_DATA_EXCHANGE_MODE",
  INVALID_DUPLICATE_STRATEGY: "INVALID_DATA_EXCHANGE_DUPLICATE_STRATEGY",
  DUPLICATE_RECORD: "DATA_EXCHANGE_DUPLICATE_RECORD",
  RECORD_FAILED: "DATA_EXCHANGE_RECORD_FAILED",
  BATCH_FAILED: "DATA_EXCHANGE_BATCH_FAILED",
  CHECKPOINT_NOT_FOUND: "DATA_EXCHANGE_CHECKPOINT_NOT_FOUND",
  RECONCILIATION_NOT_FOUND: "DATA_EXCHANGE_RECONCILIATION_NOT_FOUND",
  INVALID_RECONCILIATION: "INVALID_DATA_EXCHANGE_RECONCILIATION",
  RESULT_NOT_FOUND: "DATA_EXCHANGE_RESULT_NOT_FOUND",
  RESULT_EXPIRED: "DATA_EXCHANGE_RESULT_EXPIRED",
  INVALID_EXPORT: "INVALID_DATA_EXCHANGE_EXPORT",
  EXPORT_TOO_LARGE: "DATA_EXCHANGE_EXPORT_TOO_LARGE",
  INVALID_DESTINATION: "INVALID_DATA_EXCHANGE_DESTINATION",
  INVALID_FORMAT: "INVALID_DATA_EXCHANGE_FORMAT",
  SCHEMA_DISCOVERY_FAILED: "DATA_EXCHANGE_SCHEMA_DISCOVERY_FAILED",
  QUALITY_BLOCKED: "DATA_EXCHANGE_QUALITY_BLOCKED",
  LIFECYCLE_BLOCKED: "DATA_EXCHANGE_LIFECYCLE_BLOCKED",
  SECURITY_BLOCKED: "DATA_EXCHANGE_SECURITY_BLOCKED",
  STORAGE_FAILED: "DATA_EXCHANGE_STORAGE_FAILED",
  INVALID_TEMPLATE: "INVALID_DATA_EXCHANGE_TEMPLATE",
  TEMPLATE_NOT_FOUND: "DATA_EXCHANGE_TEMPLATE_NOT_FOUND",
  INVALID_CONFIGURATION: "INVALID_DATA_EXCHANGE_CONFIGURATION",
  CONFLICT: "DATA_EXCHANGE_CONFLICT",
});

export class DataExchangeError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export const definitionNotFound = (ref) =>
  new DataExchangeError(404, `Definition not found: ${ref}`, EXCHANGE_ERROR_CODES.DEFINITION_NOT_FOUND, { ref });
export const definitionConflict = (code) =>
  new DataExchangeError(409, `Definition already exists: ${code}`, EXCHANGE_ERROR_CODES.DEFINITION_CONFLICT, { code });
export const invalidDefinition = (message, details = null) =>
  new DataExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_DEFINITION, details);
export const definitionImmutable = (ref, status) =>
  new DataExchangeError(409, `Definition ${ref} is ${status} and cannot be edited in place; version it instead`, EXCHANGE_ERROR_CODES.DEFINITION_IMMUTABLE, { ref, status });

export const connectorNotFound = (code) =>
  new DataExchangeError(404, `Connector not registered: ${code}`, EXCHANGE_ERROR_CODES.CONNECTOR_NOT_FOUND, { code });
export const connectorUnsupported = (code, capability) =>
  new DataExchangeError(400, `Connector ${code} does not support ${capability}`, EXCHANGE_ERROR_CODES.CONNECTOR_UNSUPPORTED, { code, capability });
export const invalidConnector = (message, details = null) =>
  new DataExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_CONNECTOR, details);
export const connectorFailed = (message, details = null) =>
  new DataExchangeError(502, message, EXCHANGE_ERROR_CODES.CONNECTOR_FAILED, details);
export const connectionFailed = (message, details = null) =>
  new DataExchangeError(502, message, EXCHANGE_ERROR_CODES.CONNECTION_FAILED, details);

export const invalidMapping = (message, details = null) =>
  new DataExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_MAPPING, details);
export const mappingBlocked = (details) =>
  new DataExchangeError(422, "Import cannot start: blocking mapping errors exist", EXCHANGE_ERROR_CODES.MAPPING_BLOCKED, details);

export const invalidTransformation = (message, details = null) =>
  new DataExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_TRANSFORMATION, details);
export const transformationFailed = (message, details = null) =>
  new DataExchangeError(422, message, EXCHANGE_ERROR_CODES.TRANSFORMATION_FAILED, details);
export const invalidExpression = (message, details = null) =>
  new DataExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_EXPRESSION, details);
export const invalidLookup = (message, details = null) =>
  new DataExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_LOOKUP, details);

export const invalidValidation = (message, details = null) =>
  new DataExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_VALIDATION, details);
export const validationFailed = (message, details = null) =>
  new DataExchangeError(422, message, EXCHANGE_ERROR_CODES.VALIDATION_FAILED, details);

export const jobNotFound = (ref) =>
  new DataExchangeError(404, `Job not found: ${ref}`, EXCHANGE_ERROR_CODES.JOB_NOT_FOUND, { ref });
export const jobConflict = (message, details = null) =>
  new DataExchangeError(409, message, EXCHANGE_ERROR_CODES.JOB_CONFLICT, details);
export const jobFailed = (message, details = null) =>
  new DataExchangeError(500, message, EXCHANGE_ERROR_CODES.JOB_FAILED, details);
export const jobNotCancellable = (ref, status) =>
  new DataExchangeError(409, `Job ${ref} is ${status} and cannot be cancelled`, EXCHANGE_ERROR_CODES.JOB_NOT_CANCELLABLE, { ref, status });
export const jobNotRetryable = (ref, status) =>
  new DataExchangeError(409, `Job ${ref} is ${status} and has no retryable failures`, EXCHANGE_ERROR_CODES.JOB_NOT_RETRYABLE, { ref, status });

export const invalidMode = (value) =>
  new DataExchangeError(400, `Unsupported execution mode: ${value}`, EXCHANGE_ERROR_CODES.INVALID_MODE, { value });
export const invalidDuplicateStrategy = (value) =>
  new DataExchangeError(400, `Unsupported duplicate strategy: ${value}`, EXCHANGE_ERROR_CODES.INVALID_DUPLICATE_STRATEGY, { value });
export const duplicateRecord = (details) =>
  new DataExchangeError(409, "Duplicate record", EXCHANGE_ERROR_CODES.DUPLICATE_RECORD, details);
export const recordFailed = (message, details = null) =>
  new DataExchangeError(422, message, EXCHANGE_ERROR_CODES.RECORD_FAILED, details);
export const batchFailed = (message, details = null) =>
  new DataExchangeError(500, message, EXCHANGE_ERROR_CODES.BATCH_FAILED, details);

export const reconciliationNotFound = (ref) =>
  new DataExchangeError(404, `Reconciliation not found: ${ref}`, EXCHANGE_ERROR_CODES.RECONCILIATION_NOT_FOUND, { ref });
export const invalidReconciliation = (message, details = null) =>
  new DataExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_RECONCILIATION, details);

export const resultNotFound = (ref) =>
  new DataExchangeError(404, `Export result not found: ${ref}`, EXCHANGE_ERROR_CODES.RESULT_NOT_FOUND, { ref });
export const resultExpired = (ref) =>
  new DataExchangeError(410, `Export result ${ref} has expired`, EXCHANGE_ERROR_CODES.RESULT_EXPIRED, { ref });
export const invalidExport = (message, details = null) =>
  new DataExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_EXPORT, details);
export const exportTooLarge = (count, limit) =>
  new DataExchangeError(422, `Export would produce ${count} records which exceeds the limit of ${limit}`, EXCHANGE_ERROR_CODES.EXPORT_TOO_LARGE, { count, limit });
export const invalidDestination = (value) =>
  new DataExchangeError(400, `Unsupported export destination: ${value}`, EXCHANGE_ERROR_CODES.INVALID_DESTINATION, { value });
export const invalidFormat = (value) =>
  new DataExchangeError(400, `Unsupported format: ${value}`, EXCHANGE_ERROR_CODES.INVALID_FORMAT, { value });
export const schemaDiscoveryFailed = (message, details = null) =>
  new DataExchangeError(422, message, EXCHANGE_ERROR_CODES.SCHEMA_DISCOVERY_FAILED, details);
export const qualityBlocked = (details) =>
  new DataExchangeError(422, "Blocked by the data quality gate", EXCHANGE_ERROR_CODES.QUALITY_BLOCKED, details);
export const lifecycleBlocked = (details) =>
  new DataExchangeError(409, "Blocked by lifecycle state or retention", EXCHANGE_ERROR_CODES.LIFECYCLE_BLOCKED, details);
export const securityBlocked = (details) =>
  new DataExchangeError(403, "Blocked by security policy", EXCHANGE_ERROR_CODES.SECURITY_BLOCKED, details);
export const storageFailed = (message, details = null) =>
  new DataExchangeError(502, message, EXCHANGE_ERROR_CODES.STORAGE_FAILED, details);
export const invalidTemplate = (message, details = null) =>
  new DataExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_TEMPLATE, details);
export const templateNotFound = (ref) =>
  new DataExchangeError(404, `Template not found: ${ref}`, EXCHANGE_ERROR_CODES.TEMPLATE_NOT_FOUND, { ref });
export const invalidConfiguration = (message, details = null) =>
  new DataExchangeError(400, message, EXCHANGE_ERROR_CODES.INVALID_CONFIGURATION, details);
export const exchangeConflict = (message, details = null) =>
  new DataExchangeError(409, message, EXCHANGE_ERROR_CODES.CONFLICT, details);
