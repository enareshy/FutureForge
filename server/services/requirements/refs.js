// Human-readable Requirements Manager reference generators. References are
// safe in URLs, search and audit records so operators can identify an artifact
// without a lookup (mirrors server/services/change/refs.js).
import { randomUuid } from "../../db.js";

export function shortId() {
  return randomUuid().replace(/-/g, "").slice(0, 12);
}

export function slug(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]+/g, "_")
    .slice(0, 48);
}

export function requirementRef(number) {
  return `REQ-${slug(number) || shortId()}`;
}

export function revisionRef(requirementNumber, revision) {
  return `REQ-REV-${slug(requirementNumber) || shortId()}-${slug(revision) || "A"}`;
}

export function relationshipRef() {
  return `REQ-REL-${shortId()}`;
}

export function baselineRef(number) {
  return `REQ-BL-${slug(number) || shortId()}`;
}

export function typeRef(code) {
  return `REQ-TYPE-${slug(code) || shortId()}`;
}
