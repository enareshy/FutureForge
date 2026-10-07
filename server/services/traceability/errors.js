// Stable error codes for the Generic Traceability Engine.
//
// The HTTP layer serializes `code` next to `error`/`details` so clients branch
// on identifiers rather than prose. Link CRUD reuses the Object & Relationship
// errors directly (the platform has one relationship error contract).
import { HttpError } from "../../validation.js";

export const TRACEABILITY_ERROR_CODES = Object.freeze({
  INVALID_QUERY: "TRACEABILITY_INVALID_QUERY",
  OBJECT_NOT_FOUND: "TRACEABILITY_OBJECT_NOT_FOUND",
  DEFINITION_NOT_FOUND: "TRACEABILITY_DEFINITION_NOT_FOUND",
  SECURITY_BLOCKED: "TRACEABILITY_SECURITY_BLOCKED",
});

export class TraceabilityError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export const invalidQuery = (message, details = null) =>
  new TraceabilityError(400, message, TRACEABILITY_ERROR_CODES.INVALID_QUERY, details);

export const objectNotFound = (details = null) =>
  new TraceabilityError(404, "Traceable object not found", TRACEABILITY_ERROR_CODES.OBJECT_NOT_FOUND, details);

export const securityBlocked = (details = null) =>
  new TraceabilityError(403, "Traceability request blocked by data security", TRACEABILITY_ERROR_CODES.SECURITY_BLOCKED, details);
