import { HttpError } from "../../validation.js";
import { CONTENT_ERROR_CODES } from "./constants.js";

// Standardized content error codes (spec §51). Every failure surfaced by the
// content service carries a stable machine-readable `code` so API clients can
// branch on it without parsing messages. Messages stay safe for end users.

export class ContentError extends HttpError {
  constructor(code, message, details = null, status = null) {
    super(status || CONTENT_ERROR_CODES[code] || 400, message || code, details);
    this.code = code in CONTENT_ERROR_CODES ? code : "CONTENT_ACCESS_DENIED";
  }
}

export function contentError(code, message, details = null, status = null) {
  return new ContentError(code, message, details, status);
}

export const Errors = {
  notFound: (message = "Content not found") => contentError("CONTENT_NOT_FOUND", message),
  accessDenied: (message = "Content access denied") => contentError("CONTENT_ACCESS_DENIED", message),
  uploadFailed: (message = "Content upload failed") => contentError("CONTENT_UPLOAD_FAILED", message),
  sessionNotFound: (message = "Upload session not found") => contentError("UPLOAD_SESSION_NOT_FOUND", message),
  sessionExpired: (message = "Upload session has expired") => contentError("UPLOAD_SESSION_EXPIRED", message),
  invalidFileType: (message = "Invalid file type") => contentError("INVALID_FILE_TYPE", message),
  invalidMimeType: (message = "Invalid MIME type") => contentError("INVALID_MIME_TYPE", message),
  fileTooLarge: (message = "File exceeds the maximum allowed size") => contentError("FILE_TOO_LARGE", message),
  checksumMismatch: (message = "Checksum does not match the uploaded content") => contentError("CHECKSUM_MISMATCH", message),
  scanFailed: (message = "Security scan failed") => contentError("SECURITY_SCAN_FAILED", message),
  infected: (message = "Content is infected and has been quarantined") => contentError("CONTENT_INFECTED", message),
  quarantined: (message = "Content is quarantined and cannot be accessed") => contentError("CONTENT_QUARANTINED", message),
  locked: (message = "Content is checked out and locked") => contentError("CONTENT_LOCKED", message),
  checkoutNotAllowed: (message = "Check-out is not allowed in the current state") => contentError("CHECKOUT_NOT_ALLOWED", message),
  checkinNotAllowed: (message = "Check-in is not allowed in the current state") => contentError("CHECKIN_NOT_ALLOWED", message),
  lockNotFound: (message = "Active lock not found") => contentError("LOCK_NOT_FOUND", message),
  renditionFailed: (message = "Rendition generation failed") => contentError("RENDITION_FAILED", message),
  previewUnavailable: (message = "Preview is not available for this content") => contentError("PREVIEW_NOT_AVAILABLE", message),
  storage: (message = "Storage provider error") => contentError("STORAGE_ERROR", message),
  associationInvalid: (message = "Invalid content association") => contentError("CONTENT_ASSOCIATION_INVALID", message),
  retentionViolation: (message = "Retention policy violation") => contentError("RETENTION_POLICY_VIOLATION", message),
  legalHold: (message = "Content is under legal hold") => contentError("LEGAL_HOLD_ACTIVE", message),
  deletionNotAllowed: (message = "Content deletion is not allowed") => contentError("CONTENT_DELETION_NOT_ALLOWED", message),
  unauthorized: (message = "Unauthorized content operation") => contentError("UNAUTHORIZED_CONTENT_OPERATION", message),
  tenantDenied: (message = "Cross-tenant content access is not permitted") => contentError("TENANT_ACCESS_DENIED", message),
};
