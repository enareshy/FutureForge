// Human-readable reference generators. References are safe in URLs, search and
// audit records so operators can identify a record without a database lookup.
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

export function projectRef(code) {
  return `MIG-PROJ-${slug(code) || shortId()}`;
}

export function packageRef(code) {
  return `MIG-PKG-${slug(code) || shortId()}`;
}

export function definitionRef(code) {
  return `MIG-DEF-${slug(code) || shortId()}`;
}

export function sourceRef(code) {
  return `MIG-SRC-${slug(code) || shortId()}`;
}

export function jobRef(code) {
  return `MIG-JOB-${slug(code) || "RUN"}-${shortId()}`;
}

export function planRef(code) {
  return `MIG-PLAN-${slug(code) || "PLAN"}-${shortId()}`;
}

export function reconciliationRef(jobReference) {
  return `MIG-REC-${slug(jobReference) || shortId()}`;
}
