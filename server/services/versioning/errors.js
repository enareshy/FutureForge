// Standardized Effectivity & Versioning Kernel error codes. The HTTP layer
// serializes `code` alongside `error` so API clients can branch on stable codes.
import { HttpError } from "../../validation.js";

export const VERSIONING_ERROR_CODES = Object.freeze({
  REVISION_NOT_FOUND: "REVISION_NOT_FOUND",
  VERSION_NOT_FOUND: "VERSION_NOT_FOUND",
  INVALID_REVISION: "INVALID_REVISION",
  INVALID_VERSION: "INVALID_VERSION",
  INVALID_EFFECTIVITY: "INVALID_EFFECTIVITY",
  INVALID_EFFECTIVITY_CONTEXT: "INVALID_EFFECTIVITY_CONTEXT",
  EFFECTIVITY_OVERLAP: "EFFECTIVITY_OVERLAP",
  EFFECTIVITY_GAP: "EFFECTIVITY_GAP",
  EFFECTIVITY_CONFLICT: "EFFECTIVITY_CONFLICT",
  NO_APPLICABLE_REVISION: "NO_APPLICABLE_REVISION",
  AMBIGUOUS_RESOLUTION: "AMBIGUOUS_RESOLUTION",
  INVALID_SERIAL_RANGE: "INVALID_SERIAL_RANGE",
  INVALID_CONFIGURATION_CONTEXT: "INVALID_CONFIGURATION_CONTEXT",
  BASELINE_NOT_FOUND: "BASELINE_NOT_FOUND",
  BASELINE_IMMUTABLE: "BASELINE_IMMUTABLE",
  SNAPSHOT_NOT_FOUND: "SNAPSHOT_NOT_FOUND",
  VARIANT_NOT_FOUND: "VARIANT_NOT_FOUND",
  INVALID_RESOLUTION_POLICY: "INVALID_RESOLUTION_POLICY",
  INVALID_RELATIONSHIP: "INVALID_RELATIONSHIP",
  CONCURRENCY_CONFLICT: "VERSIONING_CONCURRENCY_CONFLICT",
  UNAUTHORIZED_OPERATION: "UNAUTHORIZED_OPERATION",
});

export class VersioningError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export function revisionNotFound(ref) {
  return new VersioningError(404, `Revision not found: ${ref}`, VERSIONING_ERROR_CODES.REVISION_NOT_FOUND, { ref });
}

export function versionNotFound(ref) {
  return new VersioningError(404, `Version not found: ${ref}`, VERSIONING_ERROR_CODES.VERSION_NOT_FOUND, { ref });
}

export function invalidRevision(message, details = null) {
  return new VersioningError(400, message, VERSIONING_ERROR_CODES.INVALID_REVISION, details);
}

export function invalidVersion(message, details = null) {
  return new VersioningError(400, message, VERSIONING_ERROR_CODES.INVALID_VERSION, details);
}

export function invalidEffectivity(message, details = null) {
  return new VersioningError(422, message, VERSIONING_ERROR_CODES.INVALID_EFFECTIVITY, details);
}

export function invalidSerialRange(message, details = null) {
  return new VersioningError(422, message, VERSIONING_ERROR_CODES.INVALID_SERIAL_RANGE, details);
}

export function invalidContext(message, details = null) {
  return new VersioningError(422, message, VERSIONING_ERROR_CODES.INVALID_EFFECTIVITY_CONTEXT, details);
}

export function effectivityOverlap(details = null) {
  return new VersioningError(
    409,
    "Effectivity ranges overlap where overlap is not permitted",
    VERSIONING_ERROR_CODES.EFFECTIVITY_OVERLAP,
    details
  );
}

export function effectivityConflict(details = null) {
  return new VersioningError(409, "Conflicting effectivity assignments were detected", VERSIONING_ERROR_CODES.EFFECTIVITY_CONFLICT, details);
}

export function noApplicableRevision(details = null) {
  return new VersioningError(
    404,
    "No revision is effective for the supplied context",
    VERSIONING_ERROR_CODES.NO_APPLICABLE_REVISION,
    details
  );
}

export function ambiguousResolution(details = null) {
  return new VersioningError(
    409,
    "Multiple revisions match the supplied context and no resolution rule can select one",
    VERSIONING_ERROR_CODES.AMBIGUOUS_RESOLUTION,
    details
  );
}

export function baselineNotFound(ref) {
  return new VersioningError(404, `Baseline not found: ${ref}`, VERSIONING_ERROR_CODES.BASELINE_NOT_FOUND, { ref });
}

export function baselineImmutable(ref) {
  return new VersioningError(409, `Baseline is frozen and cannot be modified: ${ref}`, VERSIONING_ERROR_CODES.BASELINE_IMMUTABLE, {
    ref,
  });
}

export function snapshotNotFound(ref) {
  return new VersioningError(404, `Snapshot not found: ${ref}`, VERSIONING_ERROR_CODES.SNAPSHOT_NOT_FOUND, { ref });
}

export function variantNotFound(ref) {
  return new VersioningError(404, `Variant not found: ${ref}`, VERSIONING_ERROR_CODES.VARIANT_NOT_FOUND, { ref });
}

export function invalidResolutionPolicy(message, details = null) {
  return new VersioningError(422, message, VERSIONING_ERROR_CODES.INVALID_RESOLUTION_POLICY, details);
}

export function invalidConfigurationContext(message, details = null) {
  return new VersioningError(422, message, VERSIONING_ERROR_CODES.INVALID_CONFIGURATION_CONTEXT, details);
}

export function invalidRelationship(message, details = null) {
  return new VersioningError(422, message, VERSIONING_ERROR_CODES.INVALID_RELATIONSHIP, details);
}
