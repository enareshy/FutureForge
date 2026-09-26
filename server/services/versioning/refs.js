// Reference generators for the Effectivity & Versioning Kernel. Human-readable
// prefixes make refs usable in URLs and audit records without a lookup.
import { randomUuid } from "../../db.js";

function shortId() {
  return randomUuid().replace(/-/g, "").slice(0, 12);
}

export function revisionRef(objectType, objectId, revisionCode) {
  const type = String(objectType || "OBJ").toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 20);
  const objectPart = String(objectId || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 32);
  const code = String(revisionCode || "").toUpperCase().replace(/[^A-Z0-9_.-]+/g, "_").slice(0, 24);
  return `REV-${type}-${objectPart || shortId()}-${code || shortId()}`;
}

export function versionRef(revisionId, versionNumber) {
  return `VER-${revisionId}-${String(versionNumber || shortId()).replace(/[^A-Za-z0-9_.-]+/g, "_")}`;
}

export function definitionRef(code) {
  return `EFF-${String(code || "").toUpperCase().replace(/[^A-Z0-9_.-]+/g, "_").slice(0, 32) || shortId()}`;
}

export function assignmentRef() {
  return `EFFA-${shortId()}`;
}

export function variantRef(code) {
  return `VAR-${String(code || "").toUpperCase().replace(/[^A-Z0-9_.-]+/g, "_").slice(0, 32) || shortId()}`;
}

export function contextRef(code) {
  return `CFG-${String(code || "").toUpperCase().replace(/[^A-Z0-9_.-]+/g, "_").slice(0, 32) || shortId()}`;
}

export function baselineRef(code) {
  return `BL-${String(code || "").toUpperCase().replace(/[^A-Z0-9_.-]+/g, "_").slice(0, 32) || shortId()}`;
}

export function snapshotRef(code) {
  return `SNAP-${String(code || "").toUpperCase().replace(/[^A-Z0-9_.-]+/g, "_").slice(0, 32) || shortId()}`;
}

export function resultRef() {
  return `RES-${shortId()}`;
}

export { shortId };
