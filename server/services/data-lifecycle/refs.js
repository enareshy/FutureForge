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

export function policyRef(code) {
  return `LC-POL-${slug(code) || shortId()}`;
}

export function stateRef(code) {
  return `LC-ST-${slug(code) || shortId()}`;
}

export function legalHoldRef(code) {
  return `LC-LH-${slug(code) || shortId()}`;
}

export function archiveRef(objectType, objectId) {
  return `LC-ARC-${slug(`${objectType}.${objectId}`) || "OBJ"}-${shortId()}`;
}

export function restoreRef(objectType, objectId) {
  return `LC-RST-${slug(`${objectType}.${objectId}`) || "OBJ"}-${shortId()}`;
}

export function purgeRef(objectType, objectId) {
  return `LC-PRG-${slug(`${objectType}.${objectId}`) || "OBJ"}-${shortId()}`;
}

export function recoveryRef(scope) {
  return `LC-RCV-${slug(scope) || "SCOPE"}-${shortId()}`;
}

export function jobRef(jobType) {
  return `LC-JOB-${slug(jobType) || "JOB"}-${shortId()}`;
}
