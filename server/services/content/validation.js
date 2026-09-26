import { createHash } from "node:crypto";
import {
  CONTENT_ROLES,
  CONTENT_STATUSES,
  CONTENT_TYPES,
  SECURITY_STATUSES,
  PROCESSING_STATUSES,
  VERSION_STATUSES,
  RENDITION_TYPES,
  RENDITION_STATUSES,
  SCAN_STATUSES,
  CHECKSUM_ALGORITHMS,
  DEFAULT_CHECKSUM_ALGORITHM,
  SECURITY_CLASSIFICATIONS,
  ASSOCIATION_STATUSES,
  RETENTION_DISPOSITIONS,
  RETENTION_STATUSES,
  RETENTION_START_BASIS,
  UPLOAD_STATUSES,
  canTransition,
} from "./constants.js";
import { Errors } from "./errors.js";
import {
  sanitizeFilename,
  extensionOf,
  mimeFor,
  isDangerousExtension,
  FILE_CATEGORIES,
  categoryForMime,
} from "../files/validation.js";

// Validation and content-integrity helpers. Filename/MIME policy and category
// heuristics are shared with the Document & File module; content adds server-side
// signature detection, checksum verification and role/status/transition checks.

export { sanitizeFilename, extensionOf, mimeFor, isDangerousExtension, categoryForMime, FILE_CATEGORIES };

function inSet(value, set, label, allowed) {
  if (!set.includes(value)) {
    throw Errors.invalidFileType(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

export function assertContentRole(value, label = "content_role") {
  return inSet(value, CONTENT_ROLES, label, CONTENT_ROLES);
}

export function assertContentType(value, label = "content_type") {
  return inSet(value, CONTENT_TYPES, label, CONTENT_TYPES);
}

export function assertStatus(value, label = "status") {
  return inSet(value, CONTENT_STATUSES, label, CONTENT_STATUSES);
}

export function assertSecurityStatus(value, label = "security_status") {
  return inSet(value, SECURITY_STATUSES, label, SECURITY_STATUSES);
}

export function assertProcessingStatus(value, label = "processing_status") {
  return inSet(value, PROCESSING_STATUSES, label, PROCESSING_STATUSES);
}

export function assertVersionStatus(value, label = "status") {
  return inSet(value, VERSION_STATUSES, label, VERSION_STATUSES);
}

export function assertUploadStatus(value, label = "status") {
  return inSet(value, UPLOAD_STATUSES, label, UPLOAD_STATUSES);
}

export function assertRenditionType(value, label = "rendition_type") {
  return inSet(value, RENDITION_TYPES, label, RENDITION_TYPES);
}

export function assertRenditionStatus(value, label = "status") {
  return inSet(value, RENDITION_STATUSES, label, RENDITION_STATUSES);
}

export function assertScanStatus(value, label = "status") {
  return inSet(value, SCAN_STATUSES, label, SCAN_STATUSES);
}

export function assertChecksumAlgorithm(value, label = "checksum_algorithm") {
  const normalized = String(value || DEFAULT_CHECKSUM_ALGORITHM).toLowerCase();
  return inSet(normalized, CHECKSUM_ALGORITHMS, label, CHECKSUM_ALGORITHMS);
}

export function assertClassification(value, label = "security_classification") {
  return inSet(value, SECURITY_CLASSIFICATIONS, label, SECURITY_CLASSIFICATIONS);
}

export function assertAssociationStatus(value, label = "status") {
  return inSet(value, ASSOCIATION_STATUSES, label, ASSOCIATION_STATUSES);
}

export function assertRetentionDisposition(value, label = "disposition") {
  return inSet(value, RETENTION_DISPOSITIONS, label, RETENTION_DISPOSITIONS);
}

export function assertRetentionStatus(value, label = "status") {
  return inSet(value, RETENTION_STATUSES, label, RETENTION_STATUSES);
}

export function assertRetentionStartBasis(value, label = "retention_start_basis") {
  return inSet(value, RETENTION_START_BASIS, label, RETENTION_START_BASIS);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw Errors.unauthorized(`Illegal content lifecycle transition ${from} -> ${to}`);
  }
  return true;
}

export function checksumOf(buffer, algorithm = DEFAULT_CHECKSUM_ALGORITHM) {
  return createHash(assertChecksumAlgorithm(algorithm)).update(buffer).digest("hex");
}

export function assertChecksum(value, label = "checksum") {
  const text = String(value || "").trim().toLowerCase();
  if (text && !/^[a-f0-9]{32,128}$/.test(text)) {
    throw Errors.checksumMismatch(`${label} must be a hex digest`);
  }
  return text;
}

export function verifyChecksum(buffer, expected, algorithm = DEFAULT_CHECKSUM_ALGORITHM) {
  const expectedText = assertChecksum(expected);
  if (!expectedText) return true;
  const actual = checksumOf(buffer, algorithm);
  if (actual !== expectedText) throw Errors.checksumMismatch();
  return true;
}

// ── Server-side MIME detection ───────────────────────────────────────────────
// The declared content type is never trusted on its own. A magic-byte signature
// is inspected when one is known; extension-derived types are only used as a
// fallback for formats with no reliable signature.

const SIGNATURES = [
  { ext: ["pdf"], mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  { ext: ["png"], mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: ["jpg", "jpeg"], mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { ext: ["gif"], mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: ["bmp"], mime: "image/bmp", bytes: [0x42, 0x4d] },
  { ext: ["tif", "tiff"], mime: "image/tiff", bytes: [0x49, 0x49, 0x2a, 0x00] },
  { ext: ["tif", "tiff"], mime: "image/tiff", bytes: [0x4d, 0x4d, 0x00, 0x2a] },
  { ext: ["zip", "docx", "xlsx", "pptx", "odt", "ods", "odp"], mime: "application/zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
  { ext: ["gz"], mime: "application/gzip", bytes: [0x1f, 0x8b] },
  { ext: ["doc", "xls", "ppt", "msi"], mime: "application/x-ole-storage", bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] },
  { ext: ["exe", "dll", "sys", "scr", "com"], mime: "application/x-msdownload", bytes: [0x4d, 0x5a] },
  { ext: ["elf", "so"], mime: "application/x-executable", bytes: [0x7f, 0x45, 0x4c, 0x46] },
];

const GENERIC_MIMES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

function matchesAt(buffer, offset, bytes) {
  if (buffer.length < offset + bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) {
    if (buffer[offset + i] !== bytes[i]) return false;
  }
  return true;
}

export function detectMimeFromSignature(buffer) {
  if (!buffer || !buffer.length) return null;
  const head = buffer;
  for (const sig of SIGNATURES) {
    if (matchesAt(head, 0, sig.bytes)) return { mimeType: sig.mime, extensions: sig.ext };
  }
  if (matchesAt(head, 4, [0x66, 0x74, 0x79, 0x70])) return { mimeType: "video/mp4", extensions: ["mp4", "mov"] };
  if (matchesAt(head, 0, [0x52, 0x49, 0x46, 0x46])) {
    if (matchesAt(head, 8, [0x57, 0x45, 0x42, 0x50])) return { mimeType: "image/webp", extensions: ["webp"] };
    if (matchesAt(head, 8, [0x57, 0x41, 0x56, 0x45])) return { mimeType: "audio/wav", extensions: ["wav"] };
    return { mimeType: "application/octet-stream", extensions: ["avi"] };
  }
  return null;
}

// Resolves the effective MIME type. Detected signatures win over a spoofed or
// generic declared type; the extension is only trusted for text-like formats.
export function resolveContentMime({ declaredMime, fileName, buffer } = {}) {
  const extension = extensionOf(fileName || "");
  const declared = String(declaredMime || "").split(";")[0].trim().toLowerCase();
  const detected = detectMimeFromSignature(buffer);
  if (detected) {
    return {
      mimeType: detected.mimeType,
      extension,
      detected: true,
      signatureMismatch: Boolean(declared && !GENERIC_MIMES.has(declared) && declared !== detected.mimeType),
    };
  }
  if (declared && !GENERIC_MIMES.has(declared)) return { mimeType: declared, extension, detected: false, signatureMismatch: false };
  return { mimeType: mimeFor(fileName || declared), extension, detected: false, signatureMismatch: false };
}

export function validateUploadInput({ fileName, mimeType, size, maxSize } = {}) {
  const name = sanitizeFilename(fileName);
  const extension = extensionOf(name);
  const byteSize = Number(size);
  if (!Number.isFinite(byteSize) || byteSize < 0) throw Errors.uploadFailed("File size is invalid");
  if (byteSize === 0) throw Errors.uploadFailed("File is empty");
  if (maxSize && byteSize > maxSize) throw Errors.fileTooLarge(`File exceeds the maximum allowed size of ${maxSize} bytes`);
  if (isDangerousExtension(extension)) throw Errors.invalidFileType(`Files of type .${extension} are not permitted`);
  return { fileName: name, extension, mimeType: mimeFor(mimeType || name), size: byteSize };
}

export function normalizeText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

export function vocabulary() {
  return {
    content_roles: CONTENT_ROLES,
    content_types: CONTENT_TYPES,
    content_statuses: CONTENT_STATUSES,
    security_statuses: SECURITY_STATUSES,
    processing_statuses: PROCESSING_STATUSES,
    version_statuses: VERSION_STATUSES,
    upload_statuses: UPLOAD_STATUSES,
    rendition_types: RENDITION_TYPES,
    rendition_statuses: RENDITION_STATUSES,
    scan_statuses: SCAN_STATUSES,
    checksum_algorithms: CHECKSUM_ALGORITHMS,
    security_classifications: SECURITY_CLASSIFICATIONS,
    association_statuses: ASSOCIATION_STATUSES,
    retention_dispositions: RETENTION_DISPOSITIONS,
    retention_statuses: RETENTION_STATUSES,
    retention_start_basis: RETENTION_START_BASIS,
    file_categories: FILE_CATEGORIES,
  };
}
