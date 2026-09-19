// Reference generators for Enterprise Reference Data Management. Human-readable
// prefixes keep refs usable in URLs and audit records without a lookup.
import { randomUuid } from "../../db.js";

export function shortId() {
  return randomUuid().replace(/-/g, "").slice(0, 12);
}

function slug(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]+/g, "_")
    .slice(0, 32);
}

export function domainRef(code) {
  return `RDM-DOM-${slug(code) || shortId()}`;
}

export function itemRef(domainCode, code, scopeKey = "GLOBAL") {
  const base = `RDM-${slug(domainCode) || "ITEM"}-${slug(code) || shortId()}`;
  const scope = String(scopeKey || "GLOBAL");
  if (scope === "GLOBAL") return base;
  return `${base}-${slug(scope)}`;
}

export function versionRef(itemId, versionNumber) {
  return `RDM-VER-${itemId}-${String(versionNumber || shortId()).replace(/[^A-Za-z0-9_.-]+/g, "_")}`;
}

export function codeRef(itemId, code) {
  return `RDM-CODE-${itemId}-${slug(code) || shortId()}`;
}

export function aliasRef(itemId, alias) {
  return `RDM-ALIAS-${itemId}-${slug(alias) || shortId()}`;
}

export function translationRef(itemId, language) {
  return `RDM-TR-${itemId}-${slug(language) || shortId()}`;
}

export function edgeRef() {
  return `RDM-EDGE-${shortId()}`;
}

export function relationshipRef() {
  return `RDM-REL-${shortId()}`;
}

export function scopePolicyRef(code) {
  return `RDM-SCOPE-${slug(code) || shortId()}`;
}

export function approvalRef() {
  return `RDM-APR-${shortId()}`;
}

export function changeRef() {
  return `RDM-CR-${shortId()}`;
}

export function importRef() {
  return `RDM-IMP-${shortId()}`;
}

export function exportRef() {
  return `RDM-EXP-${shortId()}`;
}

export { slug };
