import { randomUUID } from "node:crypto";

// Human-facing, opaque references for content entities. Storage keys are never
// derived from user input; these references are safe to expose in URLs.

function token(size = 12) {
  return randomUUID().replace(/-/g, "").slice(0, size).toUpperCase();
}

export function newUuid() {
  return randomUUID();
}

export function contentId() {
  return randomUUID();
}

export function contentKey() {
  return `CNT-${token(10)}`;
}

export function associationRef() {
  return `CAS-${token(10)}`;
}

export function renditionRef() {
  return `RND-${token(10)}`;
}

export function uploadId() {
  return `UPL-${randomUUID()}`;
}

export function lockToken() {
  return `LCK-${randomUUID()}`;
}

export function policyRef(tenantId, code) {
  const scope = tenantId === null || tenantId === undefined ? "global" : String(tenantId);
  return `CRP-${scope}-${String(code || "policy").toUpperCase()}`;
}

export function versionLabel(versionNumber) {
  return `v${versionNumber}`;
}
