import { HttpError } from "../../validation.js";

// Vocabulary and validation for the Document & File Management module. Statuses
// are stored lower-case and surfaced upper-case to match the enterprise
// lifecycle vocabulary (AVAILABLE, CHECKED_OUT, PENDING_SCAN, ...).

export const FILE_STATUSES = [
  "uploading",
  "upload_failed",
  "pending_scan",
  "scan_in_progress",
  "available",
  "quarantined",
  "scan_failed",
  "checked_out",
  "locked",
  "processing",
  "deleted",
  "archived",
];

export const FILE_STATUS_LABELS = Object.fromEntries(
  FILE_STATUSES.map((status) => [status, status.toUpperCase()])
);

export const DOWNLOADABLE_STATUSES = ["available", "checked_out", "processing"];
export const CONTENT_BLOCKED_STATUSES = ["uploading", "upload_failed", "pending_scan", "scan_in_progress", "quarantined", "scan_failed"];
export const DELETED_STATUS = "deleted";

export const VERSION_STATUSES = ["uploading", "processing", "available", "quarantined", "failed", "deleted"];
export const UPLOAD_STATUSES = ["initiated", "in_progress", "completing", "completed", "aborted", "expired", "failed"];
export const UPLOAD_MODES = ["single", "multipart", "external"];
export const VIRUS_SCAN_STATUSES = ["pending", "in_progress", "clean", "infected", "failed", "skipped"];
export const PREVIEW_STATUSES = ["pending", "processing", "ready", "failed", "unsupported"];
export const RENDITION_STATUSES = ["pending", "processing", "ready", "failed"];
export const SECURITY_CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"];
export const FILE_CATEGORIES = [
  "document", "drawing", "image", "pdf", "spreadsheet", "presentation",
  "archive", "video", "audio", "cad", "text", "other",
];
export const PROCESSING_TYPES = ["virus_scan", "preview", "rendition", "checksum", "metadata_extraction"];
export const PROCESSING_STATUSES = ["pending", "in_progress", "completed", "failed", "skipped"];
export const PRINCIPAL_TYPES = ["user", "group", "role", "tenant", "organization"];
export const PERMISSION_EFFECTS = ["allow", "deny"];
export const ASSOCIATION_RELATIONSHIP_TYPES = [
  "attachment", "reference", "deliverable", "source", "drawing", "specification", "evidence", "other",
];

// File permissions exposed by the module. Each maps to an IAM resource/action
// pair (see resourceForPermission) so backend authorization is consistent.
export const FILE_PERMISSIONS = [
  "view_metadata",
  "view_content",
  "upload",
  "create_version",
  "check_out",
  "check_in",
  "download",
  "preview",
  "edit_metadata",
  "move",
  "associate",
  "remove_association",
  "create_folder",
  "manage_folder",
  "delete",
  "restore",
  "manage_permissions",
  "release_lock",
];

export const FILE_EVENT_TYPES = [
  "FileUploaded",
  "FileVersionCreated",
  "FileCheckedOut",
  "FileCheckedIn",
  "FileLockReleased",
  "FileAssociated",
  "FileDisassociated",
  "FileDeleted",
  "FileRestored",
  "FileScanCompleted",
  "FileMetadataUpdated",
];

const STATUS_SET = new Set(FILE_STATUSES);
const CATEGORY_SET = new Set(FILE_CATEGORIES);
const CLASSIFICATION_SET = new Set(SECURITY_CLASSIFICATIONS);
const PERMISSION_SET = new Set(FILE_PERMISSIONS);
const PRINCIPAL_SET = new Set(PRINCIPAL_TYPES);
const EFFECT_SET = new Set(PERMISSION_EFFECTS);
const EVENT_SET = new Set(FILE_EVENT_TYPES);

const FILENAME_BAD = /[\\/:*?"<>|\u0000-\u001f\u007f]/g;
const DANGEROUS_EXTENSIONS = new Set([
  "exe", "scr", "com", "pif", "bat", "cmd", "msi", "vbs", "vbe", "js", "jse",
  "wsf", "wsh", "ps1", "psm1", "sh", "jar", "app", "dll", "sys", "cpl", "hta",
  "reg", "lnk", "iso", "img", "apk", "deb", "rpm",
]);

const MIME_BY_EXTENSION = {
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  md: "text/markdown",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  gz: "application/gzip",
  step: "model/step",
  stp: "model/step",
  iges: "model/iges",
  igs: "model/iges",
  dwg: "image/vnd.dwg",
  dxf: "image/vnd.dxf",
  stl: "model/stl",
  obj: "model/obj",
  mp4: "video/mp4",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

const CATEGORY_BY_EXTENSION = {
  document: ["doc", "docx", "rtf", "odt"],
  drawing: ["dwg", "dxf", "svg"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff"],
  pdf: ["pdf"],
  spreadsheet: ["xls", "xlsx", "ods", "csv"],
  presentation: ["ppt", "pptx", "odp"],
  archive: ["zip", "gz", "tar", "7z", "rar"],
  video: ["mp4", "mov", "avi", "mkv", "webm"],
  audio: ["mp3", "wav", "ogg", "flac"],
  cad: ["step", "stp", "iges", "igs", "stl", "obj"],
  text: ["txt", "md", "log", "json", "xml", "html", "yml", "yaml"],
};

export function assertFileStatus(status, label = "status") {
  if (!STATUS_SET.has(status)) throw new HttpError(400, `${label} must be one of: ${FILE_STATUSES.join(", ")}`);
}

export function assertVersionStatus(status, label = "status", allowed = VERSION_STATUSES) {
  if (!allowed.includes(status)) throw new HttpError(400, `${label} must be one of: ${allowed.join(", ")}`);
}

export function assertSecurityClassification(value, label = "security_classification") {
  if (!CLASSIFICATION_SET.has(value)) {
    throw new HttpError(400, `${label} must be one of: ${SECURITY_CLASSIFICATIONS.join(", ")}`);
  }
}

export function assertFileCategory(value, label = "file_category") {
  if (!CATEGORY_SET.has(value)) throw new HttpError(400, `${label} must be one of: ${FILE_CATEGORIES.join(", ")}`);
}

export function assertFilePermission(value, label = "permission") {
  if (!PERMISSION_SET.has(value)) throw new HttpError(400, `${label} must be one of: ${FILE_PERMISSIONS.join(", ")}`);
}

export function assertPrincipalType(value, label = "principal_type") {
  if (!PRINCIPAL_SET.has(value)) throw new HttpError(400, `${label} must be one of: ${PRINCIPAL_TYPES.join(", ")}`);
}

export function assertPermissionEffect(value, label = "effect") {
  if (!EFFECT_SET.has(value)) throw new HttpError(400, `${label} must be allow or deny`);
}

export function assertUploadMode(value, label = "upload_mode") {
  if (!UPLOAD_MODES.includes(value)) throw new HttpError(400, `${label} must be one of: ${UPLOAD_MODES.join(", ")}`);
}

export function assertEventType(value, label = "event_type") {
  if (!EVENT_SET.has(value)) throw new HttpError(400, `${label} must be one of: ${FILE_EVENT_TYPES.join(", ")}`);
}

export function isDownloadableStatus(status) {
  return DOWNLOADABLE_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Filename and content-type policy
// ---------------------------------------------------------------------------

export function extensionOf(name) {
  const value = String(name || "");
  const idx = value.lastIndexOf(".");
  if (idx <= 0 || idx === value.length - 1) return "";
  return value.slice(idx + 1).toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function sanitizeFilename(name, { fallback = "file" } = {}) {
  let value = String(name ?? "").replace(FILENAME_BAD, "_").replace(/\.+$/, "").trim();
  value = value.replace(/^\.+/, "").replace(/\s+/g, " ").slice(0, 200).trim();
  if (!value) value = fallback;
  return value;
}

export function mimeFor(nameOrMime) {
  const value = String(nameOrMime || "").toLowerCase();
  if (value.includes("/")) return value;
  return MIME_BY_EXTENSION[extensionOf(value)] || "application/octet-stream";
}

export function categoryForMime(mimeType, extension) {
  const ext = (extension || "").toLowerCase();
  for (const [category, extensions] of Object.entries(CATEGORY_BY_EXTENSION)) {
    if (extensions.includes(ext)) return category;
  }
  const mime = String(mimeType || "").toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("text/")) return "text";
  if (mime.includes("zip") || mime.includes("compressed") || mime.includes("gzip")) return "archive";
  if (mime.includes("cad") || mime.includes("step") || mime.includes("dwg")) return "cad";
  return "other";
}

export function isDangerousExtension(extension) {
  return DANGEROUS_EXTENSIONS.has(String(extension || "").toLowerCase());
}

// Validates declared size, extension, MIME and filename. Throws HttpError with
// a safe message; callers must not echo internal details.
export function validateUploadInput({ name, mimeType, size, maxSize } = {}) {
  const sanitized = sanitizeFilename(name);
  const extension = extensionOf(sanitized);
  const byteSize = Number(size);
  if (!Number.isFinite(byteSize) || byteSize < 0) throw new HttpError(400, "File size is invalid");
  if (maxSize && byteSize > maxSize) {
    throw new HttpError(413, `File exceeds the maximum allowed size of ${maxSize} bytes`);
  }
  if (byteSize === 0) throw new HttpError(400, "File is empty");
  if (isDangerousExtension(extension)) {
    throw new HttpError(415, `Files of type .${extension} are not permitted`);
  }
  const resolvedMime = mimeFor(mimeType || sanitized);
  return { name: sanitized, extension, mimeType: resolvedMime, size: byteSize };
}

export const vocabulary = {
  file_statuses: FILE_STATUSES,
  file_status_labels: FILE_STATUS_LABELS,
  security_classifications: SECURITY_CLASSIFICATIONS,
  file_categories: FILE_CATEGORIES,
  version_statuses: VERSION_STATUSES,
  upload_statuses: UPLOAD_STATUSES,
  upload_modes: UPLOAD_MODES,
  virus_scan_statuses: VIRUS_SCAN_STATUSES,
  preview_statuses: PREVIEW_STATUSES,
  rendition_statuses: RENDITION_STATUSES,
  processing_types: PROCESSING_TYPES,
  processing_statuses: PROCESSING_STATUSES,
  principal_types: PRINCIPAL_TYPES,
  permission_effects: PERMISSION_EFFECTS,
  permissions: FILE_PERMISSIONS,
  association_relationship_types: ASSOCIATION_RELATIONSHIP_TYPES,
  event_types: FILE_EVENT_TYPES,
};
