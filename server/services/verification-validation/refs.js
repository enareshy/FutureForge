// Human-readable Verification & Validation reference generators. References are
// safe in URLs, search and audit records so operators can identify a V&V
// artifact without a lookup (mirrors requirements/refs.js).
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

export function testCaseRef(number) {
  return `TC-${slug(number) || shortId()}`;
}

export function procedureRef(number) {
  return `TP-${slug(number) || shortId()}`;
}

export function executionRef(number) {
  return `TE-${slug(number) || shortId()}`;
}

export function resultRef(number) {
  return `TR-${slug(number) || shortId()}`;
}

export function waiverRef(number) {
  return `VW-${slug(number) || shortId()}`;
}

export function requirementEdgeRef() {
  return `VV-REL-${shortId()}`;
}
