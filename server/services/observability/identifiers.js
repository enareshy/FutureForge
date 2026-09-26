// Human-readable reference generators for Data Observability artifacts.
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

export function metricRef(code) {
  return `OBSMET-${slug(code) || shortId()}`;
}
export function thresholdRef(code) {
  return `OBSTHR-${slug(code) || shortId()}`;
}
export function freshnessRef(code) {
  return `OBSFRH-${slug(code) || shortId()}`;
}
export function assetRef(code) {
  return `OBSAST-${slug(code) || shortId()}`;
}
export function healthCheckRef(code) {
  return `OBSHCK-${slug(code) || shortId()}`;
}
export function healthSnapshotRef() {
  return `OBSSNP-${shortId()}`;
}
export function alertRuleRef(code) {
  return `OBSRUL-${slug(code) || shortId()}`;
}
export function alertRef() {
  return `OBSALT-${shortId()}`;
}
export function incidentRef() {
  return `OBSINC-${shortId()}`;
}
export function sloRef(code, kind = "") {
  return `OBS${kind === "SLA" ? "SLA" : "SLO"}-${slug(code) || shortId()}`;
}
export function dashboardRef(code) {
  return `OBSDASH-${slug(code) || shortId()}`;
}
export function widgetRef() {
  return `OBSWGT-${shortId()}`;
}
export function runRef() {
  return `OBSRUN-${shortId()}`;
}
export function jobRef() {
  return `OBSJOB-${shortId()}`;
}
