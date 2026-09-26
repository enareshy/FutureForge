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

export function importDefinitionRef(code) {
  return `IE-IMPDEF-${slug(code) || shortId()}`;
}

export function exportDefinitionRef(code) {
  return `IE-EXPDEF-${slug(code) || shortId()}`;
}

export function importJobRef(code) {
  return `IE-IMP-${slug(code) || "JOB"}-${shortId()}`;
}

export function exportJobRef(code) {
  return `IE-EXP-${slug(code) || "JOB"}-${shortId()}`;
}

export function templateRef(code) {
  return `IE-TPL-${slug(code) || shortId()}`;
}

export function connectorRef(code) {
  return `IE-CON-${slug(code) || shortId()}`;
}

export function resultRef(jobRef) {
  return `IE-RES-${slug(jobRef) || shortId()}`;
}
