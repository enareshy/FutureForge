// Human-readable PDM reference generators. References are safe in URLs, search
// and audit records so operators can identify a PDM artifact without a lookup.
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

export function itemRef(number) {
  return `PDM-ITEM-${slug(number) || shortId()}`;
}

export function revisionRef(itemNumber, revisionNumber) {
  return `PDM-REV-${slug(itemNumber) || "ITEM"}-${slug(revisionNumber) || shortId()}`;
}

export function datasetRef(number) {
  return `PDM-DS-${slug(number) || shortId()}`;
}

export function representationRef(datasetNumber) {
  return `PDM-REP-${slug(datasetNumber) || shortId()}-${shortId()}`;
}

export function designDataRef(code) {
  return `PDM-DD-${slug(code) || shortId()}-${shortId()}`;
}

export function cadAssociationRef(sourceId) {
  return `PDM-CAD-${slug(sourceId) || shortId()}-${shortId()}`;
}

export function revisionRuleRef(code) {
  return `PDM-RR-${slug(code) || shortId()}`;
}

export function revisionRuleVersionRef(code, version) {
  return `PDM-RRV-${slug(code) || shortId()}-${slug(version) || shortId()}`;
}

export function configurationRuleRef(code) {
  return `PDM-CR-${slug(code) || shortId()}`;
}

export function configurationRuleVersionRef(code, version) {
  return `PDM-CRV-${slug(code) || shortId()}-${slug(version) || shortId()}`;
}

export function baselineRef(number) {
  return `PDM-BL-${slug(number) || shortId()}`;
}

export function baselineMemberRef() {
  return `PDM-BLM-${shortId()}`;
}

export function relationshipRef() {
  return `PDM-REL-${shortId()}`;
}

export function referenceRef() {
  return `PDM-REF-${shortId()}`;
}

export function validationRef() {
  return `PDM-VAL-${shortId()}`;
}

export function runRef() {
  return `PDM-RUN-${shortId()}`;
}
