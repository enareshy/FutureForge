// Human-readable reference generators. Refs are safe in URLs and audit records
// so operators can identify a record without a database lookup.
import { randomUuid } from "../../db.js";

export function shortId() {
  return randomUuid().replace(/-/g, "").slice(0, 12);
}

function slug(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]+/g, "_")
    .slice(0, 40);
}

export function domainRef(code) {
  return `DG-DOM-${slug(code) || shortId()}`;
}

export function policyRef(code) {
  return `DG-POL-${slug(code) || shortId()}`;
}

export function ruleRef(code) {
  return `DG-RULE-${slug(code) || shortId()}`;
}

export function resultRef() {
  return `DG-RES-${shortId()}`;
}

export function exceptionRef() {
  return `DG-EXC-${shortId()}`;
}

export function candidateRef() {
  return `DG-DUP-${shortId()}`;
}

export { slug };
