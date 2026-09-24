// Human-readable reference generators. References are safe in URLs, search and
// audit records so operators can identify a BOM artifact without a lookup.
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

export function bomRef(number) {
  return `BOM-${slug(number) || shortId()}`;
}

export function revisionRef(bomNumber, revisionNumber) {
  return `BOM-REV-${slug(bomNumber) || "BOM"}-${slug(revisionNumber) || shortId()}`;
}

export function lineRef(childObjectId) {
  return `BOM-LN-${slug(childObjectId) || shortId()}-${shortId()}`;
}

export function baselineRef(number) {
  return `BOM-BL-${slug(number) || shortId()}`;
}

export function transformationRef(code) {
  return `BOM-TRF-${slug(code) || shortId()}`;
}

export function mappingRef(sourcePath) {
  return `BOM-MAP-${slug(sourcePath) || shortId()}-${shortId()}`;
}

export function ruleRef(code) {
  return `BOM-RUL-${slug(code) || shortId()}`;
}

export function comparisonRef() {
  return `BOM-CMP-${shortId()}`;
}

export function validationRef() {
  return `BOM-VAL-${shortId()}`;
}

export function runRef() {
  return `BOM-RUN-${shortId()}`;
}
