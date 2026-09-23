// Standardized Migration & Onboarding error codes.
//
// The HTTP layer serializes `code` alongside `error` and `details` so clients
// can branch on stable identifiers rather than parsing prose.
import { HttpError } from "../../validation.js";

export const MIGRATION_ERROR_CODES = Object.freeze({
  PROJECT_NOT_FOUND: "MIGRATION_PROJECT_NOT_FOUND",
  PROJECT_CONFLICT: "MIGRATION_PROJECT_CONFLICT",
  INVALID_PROJECT: "INVALID_MIGRATION_PROJECT",
  PROJECT_IMMUTABLE: "MIGRATION_PROJECT_IMMUTABLE",
  PACKAGE_NOT_FOUND: "MIGRATION_PACKAGE_NOT_FOUND",
  PACKAGE_CONFLICT: "MIGRATION_PACKAGE_CONFLICT",
  INVALID_PACKAGE: "INVALID_MIGRATION_PACKAGE",
  DEFINITION_NOT_FOUND: "MIGRATION_DEFINITION_NOT_FOUND",
  DEFINITION_CONFLICT: "MIGRATION_DEFINITION_CONFLICT",
  INVALID_DEFINITION: "INVALID_MIGRATION_DEFINITION",
  DEFINITION_IMMUTABLE: "MIGRATION_DEFINITION_IMMUTABLE",
  DEFINITION_BLOCKED: "MIGRATION_DEFINITION_BLOCKED",
  MAPPING_INVALID: "MIGRATION_MAPPING_INVALID",
  TRANSFORMATION_INVALID: "MIGRATION_TRANSFORMATION_INVALID",
  VALIDATION_INVALID: "MIGRATION_VALIDATION_INVALID",
  SOURCE_NOT_FOUND: "MIGRATION_SOURCE_NOT_FOUND",
  SOURCE_CONFLICT: "MIGRATION_SOURCE_CONFLICT",
  INVALID_SOURCE: "INVALID_MIGRATION_SOURCE",
  ADAPTER_NOT_FOUND: "MIGRATION_ADAPTER_NOT_FOUND",
  ADAPTER_UNSUPPORTED: "MIGRATION_ADAPTER_UNSUPPORTED",
  ADAPTER_FAILED: "MIGRATION_ADAPTER_FAILED",
  DEPENDENCY_NOT_FOUND: "MIGRATION_DEPENDENCY_NOT_FOUND",
  DEPENDENCY_UNSATISFIED: "MIGRATION_DEPENDENCY_UNSATISFIED",
  DEPENDENCY_CIRCULAR: "MIGRATION_DEPENDENCY_CIRCULAR",
  INVALID_DEPENDENCY: "INVALID_MIGRATION_DEPENDENCY",
  PLAN_NOT_FOUND: "MIGRATION_PLAN_NOT_FOUND",
  PLAN_BLOCKED: "MIGRATION_PLAN_BLOCKED",
  INVALID_PLAN: "INVALID_MIGRATION_PLAN",
  JOB_NOT_FOUND: "MIGRATION_JOB_NOT_FOUND",
  JOB_CONFLICT: "MIGRATION_JOB_CONFLICT",
  JOB_FAILED: "MIGRATION_JOB_FAILED",
  JOB_NOT_CANCELLABLE: "MIGRATION_JOB_NOT_CANCELLABLE",
  JOB_NOT_RETRYABLE: "MIGRATION_JOB_NOT_RETRYABLE",
  JOB_NOT_PAUSABLE: "MIGRATION_JOB_NOT_PAUSABLE",
  INVALID_MODE: "INVALID_MIGRATION_MODE",
  INVALID_DUPLICATE_STRATEGY: "INVALID_MIGRATION_DUPLICATE_STRATEGY",
  DUPLICATE_RECORD: "MIGRATION_DUPLICATE_RECORD",
  RECORD_FAILED: "MIGRATION_RECORD_FAILED",
  BATCH_FAILED: "MIGRATION_BATCH_FAILED",
  CHECKPOINT_NOT_FOUND: "MIGRATION_CHECKPOINT_NOT_FOUND",
  RECONCILIATION_NOT_FOUND: "MIGRATION_RECONCILIATION_NOT_FOUND",
  INVALID_RECONCILIATION: "INVALID_MIGRATION_RECONCILIATION",
  IDENTIFIER_NOT_FOUND: "MIGRATION_IDENTIFIER_NOT_FOUND",
  IDENTIFIER_CONFLICT: "MIGRATION_IDENTIFIER_CONFLICT",
  INVALID_IDENTIFIER: "INVALID_MIGRATION_IDENTIFIER",
  RELATIONSHIP_FAILED: "MIGRATION_RELATIONSHIP_FAILED",
  FILE_MIGRATION_FAILED: "MIGRATION_FILE_MIGRATION_FAILED",
  STORAGE_FAILED: "MIGRATION_STORAGE_FAILED",
  SECURITY_BLOCKED: "MIGRATION_SECURITY_BLOCKED",
  LIFECYCLE_BLOCKED: "MIGRATION_LIFECYCLE_BLOCKED",
  QUALITY_BLOCKED: "MIGRATION_QUALITY_BLOCKED",
  INVALID_CONFIGURATION: "INVALID_MIGRATION_CONFIGURATION",
  AUDIT_NOT_FOUND: "MIGRATION_AUDIT_NOT_FOUND",
  CONFLICT: "MIGRATION_CONFLICT",
});

export class MigrationError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export const projectNotFound = (ref) =>
  new MigrationError(404, `Migration project not found: ${ref}`, MIGRATION_ERROR_CODES.PROJECT_NOT_FOUND, { ref });
export const projectConflict = (code) =>
  new MigrationError(409, `Migration project already exists: ${code}`, MIGRATION_ERROR_CODES.PROJECT_CONFLICT, { code });
export const invalidProject = (message, details = null) =>
  new MigrationError(400, message, MIGRATION_ERROR_CODES.INVALID_PROJECT, details);
export const projectImmutable = (ref, status) =>
  new MigrationError(409, `Project ${ref} is ${status} and cannot be edited in place`, MIGRATION_ERROR_CODES.PROJECT_IMMUTABLE, { ref, status });

export const packageNotFound = (ref) =>
  new MigrationError(404, `Migration package not found: ${ref}`, MIGRATION_ERROR_CODES.PACKAGE_NOT_FOUND, { ref });
export const packageConflict = (code) =>
  new MigrationError(409, `Migration package already exists: ${code}`, MIGRATION_ERROR_CODES.PACKAGE_CONFLICT, { code });
export const invalidPackage = (message, details = null) =>
  new MigrationError(400, message, MIGRATION_ERROR_CODES.INVALID_PACKAGE, details);

export const definitionNotFound = (ref) =>
  new MigrationError(404, `Migration definition not found: ${ref}`, MIGRATION_ERROR_CODES.DEFINITION_NOT_FOUND, { ref });
export const definitionConflict = (code) =>
  new MigrationError(409, `Migration definition already exists: ${code}`, MIGRATION_ERROR_CODES.DEFINITION_CONFLICT, { code });
export const invalidDefinition = (message, details = null) =>
  new MigrationError(400, message, MIGRATION_ERROR_CODES.INVALID_DEFINITION, details);
export const definitionImmutable = (ref, status) =>
  new MigrationError(409, `Definition ${ref} is ${status} and cannot be edited in place; version it instead`, MIGRATION_ERROR_CODES.DEFINITION_IMMUTABLE, { ref, status });
export const definitionBlocked = (details) =>
  new MigrationError(422, "Definition cannot be activated: blocking mapping or validation errors exist", MIGRATION_ERROR_CODES.DEFINITION_BLOCKED, details);

export const invalidMapping = (message, details = null) =>
  new MigrationError(400, message, MIGRATION_ERROR_CODES.MAPPING_INVALID, details);
export const invalidTransformation = (message, details = null) =>
  new MigrationError(400, message, MIGRATION_ERROR_CODES.TRANSFORMATION_INVALID, details);
export const invalidValidation = (message, details = null) =>
  new MigrationError(400, message, MIGRATION_ERROR_CODES.VALIDATION_INVALID, details);

export const sourceNotFound = (ref) =>
  new MigrationError(404, `Migration source not found: ${ref}`, MIGRATION_ERROR_CODES.SOURCE_NOT_FOUND, { ref });
export const sourceConflict = (code) =>
  new MigrationError(409, `Migration source already exists: ${code}`, MIGRATION_ERROR_CODES.SOURCE_CONFLICT, { code });
export const invalidSource = (message, details = null) =>
  new MigrationError(400, message, MIGRATION_ERROR_CODES.INVALID_SOURCE, details);
export const adapterNotFound = (code) =>
  new MigrationError(404, `Source adapter not registered: ${code}`, MIGRATION_ERROR_CODES.ADAPTER_NOT_FOUND, { code });
export const adapterUnsupported = (code, capability) =>
  new MigrationError(400, `Source adapter ${code} does not support ${capability}`, MIGRATION_ERROR_CODES.ADAPTER_UNSUPPORTED, { code, capability });
export const adapterFailed = (message, details = null) =>
  new MigrationError(502, message, MIGRATION_ERROR_CODES.ADAPTER_FAILED, details);

export const dependencyNotFound = (ref) =>
  new MigrationError(404, `Migration dependency not found: ${ref}`, MIGRATION_ERROR_CODES.DEPENDENCY_NOT_FOUND, { ref });
export const dependencyUnsatisfied = (details) =>
  new MigrationError(409, "Migration dependencies are not satisfied", MIGRATION_ERROR_CODES.DEPENDENCY_UNSATISFIED, details);
export const dependencyCircular = (details) =>
  new MigrationError(409, "Circular migration dependency detected", MIGRATION_ERROR_CODES.DEPENDENCY_CIRCULAR, details);
export const invalidDependency = (message, details = null) =>
  new MigrationError(400, message, MIGRATION_ERROR_CODES.INVALID_DEPENDENCY, details);

export const planNotFound = (ref) =>
  new MigrationError(404, `Migration plan not found: ${ref}`, MIGRATION_ERROR_CODES.PLAN_NOT_FOUND, { ref });
export const planBlocked = (details) =>
  new MigrationError(422, "Migration plan is blocked", MIGRATION_ERROR_CODES.PLAN_BLOCKED, details);
export const invalidPlan = (message, details = null) =>
  new MigrationError(400, message, MIGRATION_ERROR_CODES.INVALID_PLAN, details);

export const jobNotFound = (ref) =>
  new MigrationError(404, `Migration job not found: ${ref}`, MIGRATION_ERROR_CODES.JOB_NOT_FOUND, { ref });
export const jobConflict = (message, details = null) =>
  new MigrationError(409, message, MIGRATION_ERROR_CODES.JOB_CONFLICT, details);
export const jobFailed = (message, details = null) =>
  new MigrationError(500, message, MIGRATION_ERROR_CODES.JOB_FAILED, details);
export const jobNotCancellable = (ref, status) =>
  new MigrationError(409, `Migration job ${ref} is ${status} and cannot be cancelled`, MIGRATION_ERROR_CODES.JOB_NOT_CANCELLABLE, { ref, status });
export const jobNotRetryable = (ref, status) =>
  new MigrationError(409, `Migration job ${ref} is ${status} and has no retryable failures`, MIGRATION_ERROR_CODES.JOB_NOT_RETRYABLE, { ref, status });
export const jobNotPausable = (ref, status) =>
  new MigrationError(409, `Migration job ${ref} is ${status} and cannot be paused`, MIGRATION_ERROR_CODES.JOB_NOT_PAUSABLE, { ref, status });

export const invalidMode = (value) =>
  new MigrationError(400, `Unsupported migration mode: ${value}`, MIGRATION_ERROR_CODES.INVALID_MODE, { value });
export const invalidDuplicateStrategy = (value) =>
  new MigrationError(400, `Unsupported duplicate strategy: ${value}`, MIGRATION_ERROR_CODES.INVALID_DUPLICATE_STRATEGY, { value });
export const duplicateRecord = (details) =>
  new MigrationError(409, "Duplicate record", MIGRATION_ERROR_CODES.DUPLICATE_RECORD, details);
export const recordFailed = (message, details = null) =>
  new MigrationError(422, message, MIGRATION_ERROR_CODES.RECORD_FAILED, details);
export const batchFailed = (message, details = null) =>
  new MigrationError(500, message, MIGRATION_ERROR_CODES.BATCH_FAILED, details);
export const checkpointNotFound = (ref) =>
  new MigrationError(404, `Migration checkpoint not found: ${ref}`, MIGRATION_ERROR_CODES.CHECKPOINT_NOT_FOUND, { ref });

export const reconciliationNotFound = (ref) =>
  new MigrationError(404, `Migration reconciliation not found: ${ref}`, MIGRATION_ERROR_CODES.RECONCILIATION_NOT_FOUND, { ref });
export const invalidReconciliation = (message, details = null) =>
  new MigrationError(400, message, MIGRATION_ERROR_CODES.INVALID_RECONCILIATION, details);

export const identifierNotFound = (ref) =>
  new MigrationError(404, `Identifier mapping not found: ${ref}`, MIGRATION_ERROR_CODES.IDENTIFIER_NOT_FOUND, { ref });
export const identifierConflict = (details) =>
  new MigrationError(409, "This source identifier is already mapped", MIGRATION_ERROR_CODES.IDENTIFIER_CONFLICT, details);
export const invalidIdentifier = (message, details = null) =>
  new MigrationError(400, message, MIGRATION_ERROR_CODES.INVALID_IDENTIFIER, details);

export const relationshipFailed = (message, details = null) =>
  new MigrationError(422, message, MIGRATION_ERROR_CODES.RELATIONSHIP_FAILED, details);
export const fileMigrationFailed = (message, details = null) =>
  new MigrationError(422, message, MIGRATION_ERROR_CODES.FILE_MIGRATION_FAILED, details);
export const storageFailed = (message, details = null) =>
  new MigrationError(502, message, MIGRATION_ERROR_CODES.STORAGE_FAILED, details);

export const securityBlocked = (details) =>
  new MigrationError(403, "Blocked by security policy", MIGRATION_ERROR_CODES.SECURITY_BLOCKED, details);
export const lifecycleBlocked = (details) =>
  new MigrationError(409, "Blocked by lifecycle state or retention", MIGRATION_ERROR_CODES.LIFECYCLE_BLOCKED, details);
export const qualityBlocked = (details) =>
  new MigrationError(422, "Blocked by the data quality gate", MIGRATION_ERROR_CODES.QUALITY_BLOCKED, details);

export const invalidConfiguration = (message, details = null) =>
  new MigrationError(400, message, MIGRATION_ERROR_CODES.INVALID_CONFIGURATION, details);
export const auditNotFound = (ref) =>
  new MigrationError(404, `Migration audit entry not found: ${ref}`, MIGRATION_ERROR_CODES.AUDIT_NOT_FOUND, { ref });
export const migrationConflict = (message, details = null) =>
  new MigrationError(409, message, MIGRATION_ERROR_CODES.CONFLICT, details);
