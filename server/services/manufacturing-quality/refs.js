// Human-readable Manufacturing & Quality reference generators. References are
// safe in URLs, search and audit records (mirrors verification-validation/refs.js).
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

export function issueRef(code) {
  return `QI-${slug(code) || shortId()}`;
}

export function inspectionRef(code) {
  return `QIN-${slug(code) || shortId()}`;
}

export function actionRef(code) {
  return `CA-${slug(code) || shortId()}`;
}

export function evaluationRef(code) {
  return `RR-${slug(code) || shortId()}`;
}
