// Standardized Data Lifecycle & Archival error codes. The HTTP layer serializes
// `code` alongside `error` and `details` so clients can branch on stable
// identifiers rather than message text.
import { HttpError } from "../../validation.js";

export const LIFECYCLE_ERROR_CODES = Object.freeze({
  STATE_NOT_FOUND: "DATA_LIFECYCLE_STATE_NOT_FOUND",
  STATE_CONFLICT: "DATA_LIFECYCLE_STATE_CONFLICT",
  INVALID_STATE: "INVALID_DATA_LIFECYCLE_STATE",
  INVALID_TRANSITION: "DATA_LIFECYCLE_INVALID_TRANSITION",
  POLICY_NOT_FOUND: "DATA_LIFECYCLE_POLICY_NOT_FOUND",
  POLICY_CONFLICT: "DATA_LIFECYCLE_POLICY_CONFLICT",
  INVALID_POLICY: "INVALID_DATA_LIFECYCLE_POLICY",
  POLICY_IMMUTABLE: "DATA_LIFECYCLE_POLICY_IMMUTABLE",
  OBJECT_NOT_FOUND: "DATA_LIFECYCLE_OBJECT_NOT_FOUND",
  OBJECT_CONFLICT: "DATA_LIFECYCLE_OBJECT_CONFLICT",
  INVALID_OBJECT: "INVALID_DATA_LIFECYCLE_OBJECT",
  INVALID_TIER: "INVALID_DATA_LIFECYCLE_TIER",
  INVALID_ELIGIBILITY: "INVALID_DATA_LIFECYCLE_ELIGIBILITY",
  LEGAL_HOLD_NOT_FOUND: "DATA_LIFECYCLE_LEGAL_HOLD_NOT_FOUND",
  LEGAL_HOLD_CONFLICT: "DATA_LIFECYCLE_LEGAL_HOLD_CONFLICT",
  INVALID_LEGAL_HOLD: "INVALID_DATA_LIFECYCLE_LEGAL_HOLD",
  LEGAL_HOLD_ACTIVE: "DATA_LIFECYCLE_LEGAL_HOLD_ACTIVE",
  INVALID_DEPENDENCY: "INVALID_DATA_LIFECYCLE_DEPENDENCY",
  DEPENDENCY_BLOCKED: "DATA_LIFECYCLE_DEPENDENCY_BLOCKED",
  ARCHIVE_NOT_FOUND: "DATA_LIFECYCLE_ARCHIVE_NOT_FOUND",
  ARCHIVE_CONFLICT: "DATA_LIFECYCLE_ARCHIVE_CONFLICT",
  ARCHIVE_FAILED: "DATA_LIFECYCLE_ARCHIVE_FAILED",
  ARCHIVE_INTEGRITY_FAILED: "DATA_LIFECYCLE_ARCHIVE_INTEGRITY_FAILED",
  INVALID_ARCHIVE: "INVALID_DATA_LIFECYCLE_ARCHIVE",
  RESTORE_NOT_FOUND: "DATA_LIFECYCLE_RESTORE_NOT_FOUND",
  RESTORE_CONFLICT: "DATA_LIFECYCLE_RESTORE_CONFLICT",
  RESTORE_FAILED: "DATA_LIFECYCLE_RESTORE_FAILED",
  INVALID_RESTORE: "INVALID_DATA_LIFECYCLE_RESTORE",
  RECOVERY_NOT_FOUND: "DATA_LIFECYCLE_RECOVERY_NOT_FOUND",
  RECOVERY_FAILED: "DATA_LIFECYCLE_RECOVERY_FAILED",
  INVALID_RECOVERY: "INVALID_DATA_LIFECYCLE_RECOVERY",
  PURGE_NOT_FOUND: "DATA_LIFECYCLE_PURGE_NOT_FOUND",
  PURGE_DENIED: "DATA_LIFECYCLE_PURGE_DENIED",
  PURGE_FAILED: "DATA_LIFECYCLE_PURGE_FAILED",
  INVALID_PURGE: "INVALID_DATA_LIFECYCLE_PURGE",
  PROVIDER_NOT_FOUND: "DATA_LIFECYCLE_PROVIDER_NOT_FOUND",
  STORAGE_FAILED: "DATA_LIFECYCLE_STORAGE_FAILED",
  JOB_FAILED: "DATA_LIFECYCLE_JOB_FAILED",
  INVALID_CONFIGURATION: "INVALID_DATA_LIFECYCLE_CONFIGURATION",
  CONFLICT: "DATA_LIFECYCLE_CONFLICT",
});

export class DataLifecycleError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export const stateNotFound = (ref) =>
  new DataLifecycleError(404, `Lifecycle state not found: ${ref}`, LIFECYCLE_ERROR_CODES.STATE_NOT_FOUND, { ref });
export const stateConflict = (code) =>
  new DataLifecycleError(409, `Lifecycle state already exists: ${code}`, LIFECYCLE_ERROR_CODES.STATE_CONFLICT, { code });
export const invalidState = (message, details = null) =>
  new DataLifecycleError(400, message, LIFECYCLE_ERROR_CODES.INVALID_STATE, details);
export const invalidTransition = (from, to) =>
  new DataLifecycleError(409, `Transition ${from} -> ${to} is not permitted by policy`, LIFECYCLE_ERROR_CODES.INVALID_TRANSITION, { from, to });

export const policyNotFound = (ref) =>
  new DataLifecycleError(404, `Lifecycle policy not found: ${ref}`, LIFECYCLE_ERROR_CODES.POLICY_NOT_FOUND, { ref });
export const policyConflict = (code) =>
  new DataLifecycleError(409, `Lifecycle policy already exists: ${code}`, LIFECYCLE_ERROR_CODES.POLICY_CONFLICT, { code });
export const invalidPolicy = (message, details = null) =>
  new DataLifecycleError(400, message, LIFECYCLE_ERROR_CODES.INVALID_POLICY, details);
export const policyImmutable = (ref, status) =>
  new DataLifecycleError(409, `Active policy ${ref} cannot be edited in place; version it instead`, LIFECYCLE_ERROR_CODES.POLICY_IMMUTABLE, { ref, status });

export const objectNotFound = (objectType, objectId) =>
  new DataLifecycleError(404, `Lifecycle record not found for ${objectType}:${objectId}`, LIFECYCLE_ERROR_CODES.OBJECT_NOT_FOUND, { object_type: objectType, object_id: objectId });
export const objectConflict = (objectType, objectId) =>
  new DataLifecycleError(409, `Lifecycle already tracks ${objectType}:${objectId}`, LIFECYCLE_ERROR_CODES.OBJECT_CONFLICT, { object_type: objectType, object_id: objectId });
export const invalidObject = (message, details = null) =>
  new DataLifecycleError(400, message, LIFECYCLE_ERROR_CODES.INVALID_OBJECT, details);
export const invalidTier = (value) =>
  new DataLifecycleError(400, `Unsupported data tier: ${value}`, LIFECYCLE_ERROR_CODES.INVALID_TIER, { value });
export const invalidEligibility = (message, details = null) =>
  new DataLifecycleError(400, message, LIFECYCLE_ERROR_CODES.INVALID_ELIGIBILITY, details);

export const legalHoldNotFound = (ref) =>
  new DataLifecycleError(404, `Legal hold not found: ${ref}`, LIFECYCLE_ERROR_CODES.LEGAL_HOLD_NOT_FOUND, { ref });
export const legalHoldConflict = (code) =>
  new DataLifecycleError(409, `Legal hold already exists: ${code}`, LIFECYCLE_ERROR_CODES.LEGAL_HOLD_CONFLICT, { code });
export const invalidLegalHold = (message, details = null) =>
  new DataLifecycleError(400, message, LIFECYCLE_ERROR_CODES.INVALID_LEGAL_HOLD, details);
export const legalHoldActive = (holdRef, details = null) =>
  new DataLifecycleError(409, `Blocked by active legal hold ${holdRef}`, LIFECYCLE_ERROR_CODES.LEGAL_HOLD_ACTIVE, { hold_ref: holdRef, ...(details || {}) });

export const invalidDependency = (message, details = null) =>
  new DataLifecycleError(400, message, LIFECYCLE_ERROR_CODES.INVALID_DEPENDENCY, details);
export const dependencyBlocked = (details) =>
  new DataLifecycleError(409, "Operation blocked by active dependencies", LIFECYCLE_ERROR_CODES.DEPENDENCY_BLOCKED, details);

export const archiveNotFound = (ref) =>
  new DataLifecycleError(404, `Archive record not found: ${ref}`, LIFECYCLE_ERROR_CODES.ARCHIVE_NOT_FOUND, { ref });
export const archiveConflict = (details) =>
  new DataLifecycleError(409, "An archive record already exists for this object and version", LIFECYCLE_ERROR_CODES.ARCHIVE_CONFLICT, details);
export const archiveFailed = (message, details = null) =>
  new DataLifecycleError(502, message, LIFECYCLE_ERROR_CODES.ARCHIVE_FAILED, details);
export const archiveIntegrityFailed = (details) =>
  new DataLifecycleError(502, "Archive integrity validation failed", LIFECYCLE_ERROR_CODES.ARCHIVE_INTEGRITY_FAILED, details);
export const invalidArchive = (message, details = null) =>
  new DataLifecycleError(400, message, LIFECYCLE_ERROR_CODES.INVALID_ARCHIVE, details);

export const restoreNotFound = (ref) =>
  new DataLifecycleError(404, `Restore record not found: ${ref}`, LIFECYCLE_ERROR_CODES.RESTORE_NOT_FOUND, { ref });
export const restoreConflict = (ref, details = null) =>
  new DataLifecycleError(409, `Restore already in progress for ${ref}`, LIFECYCLE_ERROR_CODES.RESTORE_CONFLICT, { ref, ...(details || {}) });
export const restoreFailed = (message, details = null) =>
  new DataLifecycleError(502, message, LIFECYCLE_ERROR_CODES.RESTORE_FAILED, details);
export const invalidRestore = (message, details = null) =>
  new DataLifecycleError(400, message, LIFECYCLE_ERROR_CODES.INVALID_RESTORE, details);

export const recoveryNotFound = (ref) =>
  new DataLifecycleError(404, `Recovery record not found: ${ref}`, LIFECYCLE_ERROR_CODES.RECOVERY_NOT_FOUND, { ref });
export const recoveryFailed = (message, details = null) =>
  new DataLifecycleError(502, message, LIFECYCLE_ERROR_CODES.RECOVERY_FAILED, details);
export const invalidRecovery = (message, details = null) =>
  new DataLifecycleError(400, message, LIFECYCLE_ERROR_CODES.INVALID_RECOVERY, details);

export const purgeNotFound = (ref) =>
  new DataLifecycleError(404, `Purge record not found: ${ref}`, LIFECYCLE_ERROR_CODES.PURGE_NOT_FOUND, { ref });
export const purgeDenied = (detail) =>
  new DataLifecycleError(409, "Purge is denied: eligibility is not satisfied", LIFECYCLE_ERROR_CODES.PURGE_DENIED, detail);
export const purgeFailed = (message, details = null) =>
  new DataLifecycleError(502, message, LIFECYCLE_ERROR_CODES.PURGE_FAILED, details);
export const invalidPurge = (message, details = null) =>
  new DataLifecycleError(400, message, LIFECYCLE_ERROR_CODES.INVALID_PURGE, details);

export const providerNotFound = (code) =>
  new DataLifecycleError(500, `Storage provider not registered: ${code}`, LIFECYCLE_ERROR_CODES.PROVIDER_NOT_FOUND, { code });
export const storageFailed = (message, details = null) =>
  new DataLifecycleError(502, message, LIFECYCLE_ERROR_CODES.STORAGE_FAILED, details);
export const jobFailed = (message, details = null) =>
  new DataLifecycleError(500, message, LIFECYCLE_ERROR_CODES.JOB_FAILED, details);
export const invalidConfiguration = (message, details = null) =>
  new DataLifecycleError(400, message, LIFECYCLE_ERROR_CODES.INVALID_CONFIGURATION, details);
export const lifecycleConflict = (message, details = null) =>
  new DataLifecycleError(409, message, LIFECYCLE_ERROR_CODES.CONFLICT, details);
