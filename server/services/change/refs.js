// Human-readable Change Management reference generators. References are safe
// in URLs, search and audit records so operators can identify an artifact
// without a lookup.
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

export function requestRef(number) {
  return `CHG-ECR-${slug(number) || shortId()}`;
}

export function orderRef(number) {
  return `CHG-ECO-${slug(number) || shortId()}`;
}

export function noticeRef(number) {
  return `CHG-ECN-${slug(number) || shortId()}`;
}

export function relationshipRef() {
  return `CHG-REL-${shortId()}`;
}
