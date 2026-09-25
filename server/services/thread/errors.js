// Standardized Digital Thread error codes.
//
// The HTTP layer serializes `code` alongside `error` and `details` so clients
// branch on stable identifiers rather than parsing prose.
import { HttpError } from "../../validation.js";

export const THREAD_ERROR_CODES = Object.freeze({
  DEFINITION_NOT_FOUND: "THREAD_DEFINITION_NOT_FOUND",
  DEFINITION_CONFLICT: "THREAD_DEFINITION_CONFLICT",
  INVALID_DEFINITION: "THREAD_INVALID_DEFINITION",
  RULE_NOT_FOUND: "THREAD_RULE_NOT_FOUND",
  RULE_CONFLICT: "THREAD_RULE_CONFLICT",
  INVALID_RULE: "THREAD_INVALID_RULE",
  NODE_NOT_FOUND: "THREAD_NODE_NOT_FOUND",
  INVALID_NODE: "THREAD_INVALID_NODE",
  INVALID_QUERY: "THREAD_INVALID_QUERY",
  DEPTH_EXCEEDED: "THREAD_DEPTH_EXCEEDED",
  NODE_LIMIT_EXCEEDED: "THREAD_NODE_LIMIT_EXCEEDED",
  TIMEOUT: "THREAD_QUERY_TIMEOUT",
  SNAPSHOT_NOT_FOUND: "THREAD_SNAPSHOT_NOT_FOUND",
  SNAPSHOT_CONFLICT: "THREAD_SNAPSHOT_CONFLICT",
  SNAPSHOT_IMMUTABLE: "THREAD_SNAPSHOT_IMMUTABLE",
  INVALID_SNAPSHOT: "THREAD_INVALID_SNAPSHOT",
  BASELINE_NOT_FOUND: "THREAD_BASELINE_NOT_FOUND",
  BASELINE_CONFLICT: "THREAD_BASELINE_CONFLICT",
  BASELINE_IMMUTABLE: "THREAD_BASELINE_IMMUTABLE",
  INVALID_BASELINE: "THREAD_INVALID_BASELINE",
  COMPARE_MISMATCH: "THREAD_COMPARE_MISMATCH",
  OBJECT_NOT_FOUND: "THREAD_OBJECT_NOT_FOUND",
  SECURITY_BLOCKED: "THREAD_SECURITY_BLOCKED",
  PROVIDER_NOT_FOUND: "THREAD_PROVIDER_NOT_FOUND",
  SEARCH_UNAVAILABLE: "THREAD_SEARCH_UNAVAILABLE",
  PROJECTION_FAILED: "THREAD_PROJECTION_FAILED",
  CONFLICT: "THREAD_CONFLICT",
});

export class ThreadError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export const definitionNotFound = (ref) =>
  new ThreadError(404, `Digital thread definition not found: ${ref}`, THREAD_ERROR_CODES.DEFINITION_NOT_FOUND, { ref });
export const definitionConflict = (code) =>
  new ThreadError(409, `Digital thread definition already exists: ${code}`, THREAD_ERROR_CODES.DEFINITION_CONFLICT, { code });
export const invalidDefinition = (message, details = null) =>
  new ThreadError(400, message, THREAD_ERROR_CODES.INVALID_DEFINITION, details);

export const ruleNotFound = (ref) =>
  new ThreadError(404, `Traceability rule not found: ${ref}`, THREAD_ERROR_CODES.RULE_NOT_FOUND, { ref });
export const ruleConflict = (code) =>
  new ThreadError(409, `Traceability rule already exists: ${code}`, THREAD_ERROR_CODES.RULE_CONFLICT, { code });
export const invalidRule = (message, details = null) =>
  new ThreadError(400, message, THREAD_ERROR_CODES.INVALID_RULE, details);

export const nodeNotFound = (details) =>
  new ThreadError(404, "Digital thread node not found", THREAD_ERROR_CODES.NODE_NOT_FOUND, details);
export const invalidNode = (message, details = null) =>
  new ThreadError(400, message, THREAD_ERROR_CODES.INVALID_NODE, details);
export const invalidQuery = (message, details = null) =>
  new ThreadError(400, message, THREAD_ERROR_CODES.INVALID_QUERY, details);
export const depthExceeded = (limit) =>
  new ThreadError(422, `Traversal depth exceeds the configured limit of ${limit}`, THREAD_ERROR_CODES.DEPTH_EXCEEDED, { limit });
export const nodeLimitExceeded = (limit) =>
  new ThreadError(422, `Traversal exceeded the configured node limit of ${limit}`, THREAD_ERROR_CODES.NODE_LIMIT_EXCEEDED, { limit });
export const queryTimeout = (limit) =>
  new ThreadError(408, `Digital thread query exceeded the ${limit}ms timeout`, THREAD_ERROR_CODES.TIMEOUT, { timeout_ms: limit });

export const snapshotNotFound = (ref) =>
  new ThreadError(404, `Digital thread snapshot not found: ${ref}`, THREAD_ERROR_CODES.SNAPSHOT_NOT_FOUND, { ref });
export const snapshotConflict = (ref) =>
  new ThreadError(409, `Digital thread snapshot already exists: ${ref}`, THREAD_ERROR_CODES.SNAPSHOT_CONFLICT, { ref });
export const snapshotImmutable = (ref) =>
  new ThreadError(409, `Digital thread snapshot ${ref} is immutable`, THREAD_ERROR_CODES.SNAPSHOT_IMMUTABLE, { ref });
export const invalidSnapshot = (message, details = null) =>
  new ThreadError(400, message, THREAD_ERROR_CODES.INVALID_SNAPSHOT, details);

export const baselineNotFound = (ref) =>
  new ThreadError(404, `Digital thread baseline not found: ${ref}`, THREAD_ERROR_CODES.BASELINE_NOT_FOUND, { ref });
export const baselineConflict = (ref) =>
  new ThreadError(409, `Digital thread baseline already exists: ${ref}`, THREAD_ERROR_CODES.BASELINE_CONFLICT, { ref });
export const baselineImmutable = (ref) =>
  new ThreadError(409, `Digital thread baseline ${ref} is released and immutable`, THREAD_ERROR_CODES.BASELINE_IMMUTABLE, { ref });
export const invalidBaseline = (message, details = null) =>
  new ThreadError(400, message, THREAD_ERROR_CODES.INVALID_BASELINE, details);

export const compareMismatch = (message, details = null) =>
  new ThreadError(422, message, THREAD_ERROR_CODES.COMPARE_MISMATCH, details);
export const objectNotFound = (details) =>
  new ThreadError(404, "Referenced object not found", THREAD_ERROR_CODES.OBJECT_NOT_FOUND, details);
export const securityBlocked = (details) =>
  new ThreadError(403, "Blocked by security policy", THREAD_ERROR_CODES.SECURITY_BLOCKED, details);
export const providerNotFound = (code) =>
  new ThreadError(404, `Digital thread provider not found: ${code}`, THREAD_ERROR_CODES.PROVIDER_NOT_FOUND, { code });
export const searchUnavailable = (message = "Search service is unavailable") =>
  new ThreadError(503, message, THREAD_ERROR_CODES.SEARCH_UNAVAILABLE);
export const projectionFailed = (message, details = null) =>
  new ThreadError(500, message, THREAD_ERROR_CODES.PROJECTION_FAILED, details);
export const threadConflict = (message, details = null) =>
  new ThreadError(409, message, THREAD_ERROR_CODES.CONFLICT, details);
