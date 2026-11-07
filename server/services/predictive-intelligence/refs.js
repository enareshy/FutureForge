// Human-readable Predictive Intelligence reference generators. References are
// safe in URLs, search and audit records (mirrors manufacturing-quality/refs.js).
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

export function predictionRef(code) {
  return `PRD-${slug(code) || shortId()}`;
}

export function recommendationRef(code) {
  return `REC-${slug(code) || shortId()}`;
}

export function evaluationRef(code) {
  return `MEV-${slug(code) || shortId()}`;
}

export function stableKey(...parts) {
  return parts
    .map((part) => String(part ?? "").trim().toUpperCase())
    .filter(Boolean)
    .join("|")
    .slice(0, 240);
}
