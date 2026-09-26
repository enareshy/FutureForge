// Vocabulary for the File & Content Management Service. Content is a generic,
// object-type-agnostic binary capability: the Document/PDM/BOM layers own
// business meaning, this module owns bytes, versions, storage, security,
// renditions, retention and controlled access.

export const CONTENT_ROLES = [
  "NATIVE",
  "PRIMARY",
  "SECONDARY",
  "PDF",
  "JT",
  "PREVIEW",
  "THUMBNAIL",
  "RENDITION",
  "ATTACHMENT",
];

export const CONTENT_TYPES = ["file", "rendition", "derived", "external"];

// Content lifecycle states. Distinct from the platform object lifecycle — these
// describe the state of the physical content only.
export const CONTENT_STATUSES = [
  "initiated",
  "pending_security",
  "scanning",
  "processing",
  "available",
  "locked",
  "superseded",
  "quarantined",
  "archived",
  "retained",
  "failed",
  "deleted",
];

export const CONTENT_STATUS_LABELS = Object.fromEntries(
  CONTENT_STATUSES.map((status) => [status, status.toUpperCase()])
);

// Only these states may be streamed to ordinary users. Content that has not
// completed required security validation is never downloadable.
export const DOWNLOADABLE_STATUSES = ["available", "locked", "processing", "retained", "archived"];
export const BLOCKED_STATUSES = ["initiated", "pending_security", "scanning", "quarantined", "failed"];

export const SECURITY_STATUSES = ["pending", "scanning", "clean", "infected", "failed", "unknown"];
export const PROCESSING_STATUSES = ["pending", "processing", "ready", "partial", "failed"];

export const VERSION_STATUSES = [
  "pending_security",
  "scanning",
  "processing",
  "available",
  "quarantined",
  "failed",
  "deleted",
];

export const UPLOAD_STATUSES = [
  "initiated",
  "uploading",
  "uploaded",
  "scanning",
  "processing",
  "completed",
  "failed",
  "cancelled",
  "expired",
];

export const UPLOAD_MODES = ["single", "multipart", "stream", "external"];

export const RENDITION_TYPES = [
  "PDF",
  "JT",
  "PREVIEW",
  "THUMBNAIL",
  "IMAGE",
  "TEXT",
  "OTHER",
];

export const RENDITION_STATUSES = [
  "requested",
  "processing",
  "available",
  "failed",
  "skipped",
  "outdated",
  "cancelled",
];

export const SCAN_STATUSES = ["pending", "scanning", "clean", "infected", "failed", "unknown"];

export const CHECKSUM_ALGORITHMS = ["sha256", "sha512", "md5"];
export const DEFAULT_CHECKSUM_ALGORITHM = "sha256";

export const SECURITY_CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"];

export const ASSOCIATION_STATUSES = ["active", "inactive", "superseded", "deleted"];

export const RETENTION_DISPOSITIONS = ["review", "archive", "purge"];
export const RETENTION_STATUSES = ["active", "expired", "eligible", "archived", "purged", "released"];
export const RETENTION_START_BASIS = ["created", "modified", "superseded", "release"];

export const LEGAL_HOLD_STATUSES = ["active", "released"];

export const PROCESSING_JOB_TYPES = [
  "virus_scan",
  "checksum",
  "metadata_extraction",
  "rendition",
  "thumbnail",
  "preview",
  "retention_evaluation",
  "orphan_detection",
  "storage_reconciliation",
];

export const PROCESSING_JOB_STATUSES = ["pending", "running", "completed", "failed", "cancelled"];

// Content lifecycle transition map. Configurable in spirit; the service refuses
// transitions that are not declared here so content state can never drift.
export const CONTENT_TRANSITIONS = {
  initiated: ["pending_security", "failed", "deleted"],
  pending_security: ["scanning", "quarantined", "failed", "deleted"],
  scanning: ["pending_security", "processing", "available", "quarantined", "failed"],
  processing: ["available", "failed", "quarantined"],
  available: ["locked", "superseded", "quarantined", "archived", "retained", "deleted"],
  locked: ["available", "superseded", "quarantined", "deleted"],
  superseded: ["available", "archived", "retained", "deleted"],
  quarantined: ["available", "failed", "deleted"],
  archived: ["available", "retained", "deleted"],
  retained: ["available", "archived", "deleted"],
  failed: ["pending_security", "quarantined", "deleted"],
  deleted: [],
};

// Streams are processed in the job worker, never in the API process. A reactor
// size guards against zip/decompression bombs and runaway memory use.
export const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024;
export const DEFAULT_MAX_CONTENT_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_UPLOAD_TTL_SECONDS = 24 * 60 * 60;
export const DEFAULT_LOCK_TTL_SECONDS = 30 * 60;
export const MAX_SCAN_BYTES = 16 * 1024 * 1024;

export const RESOURCE_PERMISSION_MAP = {
  browser: { resource: "iam.content.browser", action: "read" },
  details: { resource: "iam.content.details", action: "read" },
  upload: { resource: "iam.content.uploads", action: "create" },
  download: { resource: "iam.content.details", action: "read" },
  versions: { resource: "iam.content.versions", action: "read" },
  create_version: { resource: "iam.content.versions", action: "create" },
  checkout: { resource: "iam.content.locks", action: "create" },
  checkin: { resource: "iam.content.locks", action: "execute" },
  force_unlock: { resource: "iam.content.locks", action: "delete" },
  associations: { resource: "iam.content.associations", action: "read" },
  create_association: { resource: "iam.content.associations", action: "create" },
  remove_association: { resource: "iam.content.associations", action: "delete" },
  renditions: { resource: "iam.content.renditions", action: "read" },
  create_rendition: { resource: "iam.content.renditions", action: "create" },
  processing: { resource: "iam.content.processing", action: "execute" },
  security: { resource: "iam.content.security", action: "read" },
  quarantine: { resource: "iam.content.security", action: "update" },
  retention: { resource: "iam.content.retention", action: "read" },
  manage_retention: { resource: "iam.content.retention", action: "update" },
  legal_hold: { resource: "iam.content.retention", action: "execute" },
  admin: { resource: "iam.content.admin", action: "execute" },
};

export const CONTENT_EVENT_TYPES = [
  "ContentUploaded",
  "ContentUploadCompleted",
  "ContentScanStarted",
  "ContentScanCompleted",
  "ContentQuarantined",
  "ContentCheckedOut",
  "ContentCheckedIn",
  "ContentLockReleased",
  "ContentVersionCreated",
  "RenditionRequested",
  "RenditionCreated",
  "RenditionFailed",
  "ContentAssociated",
  "ContentAssociationRemoved",
  "ContentArchived",
  "ContentRetentionExpired",
  "ContentLegalHoldApplied",
  "ContentLegalHoldReleased",
  "ContentDeleted",
  "ContentRestored",
  "ContentMetadataUpdated",
];

export const CONTENT_ERROR_CODES = {
  CONTENT_NOT_FOUND: 404,
  CONTENT_ACCESS_DENIED: 403,
  CONTENT_UPLOAD_FAILED: 500,
  UPLOAD_SESSION_NOT_FOUND: 404,
  UPLOAD_SESSION_EXPIRED: 410,
  INVALID_FILE_TYPE: 415,
  INVALID_MIME_TYPE: 415,
  FILE_TOO_LARGE: 413,
  CHECKSUM_MISMATCH: 422,
  SECURITY_SCAN_FAILED: 422,
  CONTENT_INFECTED: 422,
  CONTENT_QUARANTINED: 423,
  CONTENT_LOCKED: 423,
  CHECKOUT_NOT_ALLOWED: 409,
  CHECKIN_NOT_ALLOWED: 409,
  LOCK_NOT_FOUND: 404,
  RENDITION_FAILED: 422,
  PREVIEW_NOT_AVAILABLE: 404,
  STORAGE_ERROR: 500,
  CONTENT_ASSOCIATION_INVALID: 422,
  RETENTION_POLICY_VIOLATION: 422,
  LEGAL_HOLD_ACTIVE: 423,
  CONTENT_DELETION_NOT_ALLOWED: 409,
  UNAUTHORIZED_CONTENT_OPERATION: 403,
  TENANT_ACCESS_DENIED: 403,
};

export const STATUS_LABELS = CONTENT_STATUS_LABELS;

export function allowedTransitions(status) {
  return CONTENT_TRANSITIONS[status] || [];
}

export function canTransition(from, to) {
  return allowedTransitions(from).includes(to);
}
