// Human-readable reference generators. References are safe in URLs, search and
// audit records so operators can identify a definition without a lookup.
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

export function classificationRef(code) {
  return `CLA-${slug(code) || shortId()}`;
}

export function classRef(code) {
  return `CLS-${slug(code) || shortId()}`;
}

export function characteristicRef(code) {
  return `CHR-${slug(code) || shortId()}`;
}

export function ruleRef(code) {
  return `CLR-${slug(code) || shortId()}`;
}

export function assignmentRef(objectType, objectId) {
  return `CLA-ASN-${slug(objectType) || "OBJ"}-${slug(objectId) || shortId()}-${shortId()}`;
}
