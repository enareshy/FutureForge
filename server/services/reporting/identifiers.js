// Human-readable reference generators for Reporting & Analytics artifacts.
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

export function reportRef(code) {
  return `RPT-${slug(code) || shortId()}`;
}

export function dashboardRef(code) {
  return `DSH-${slug(code) || shortId()}`;
}

export function metricRef(code) {
  return `MET-${slug(code) || shortId()}`;
}

export function kpiRef(code) {
  return `KPI-${slug(code) || shortId()}`;
}

export function executionRef() {
  return `RUN-${shortId()}`;
}

export function exportRef() {
  return `EXP-${shortId()}`;
}

export function scheduleRef() {
  return `SCH-${shortId()}`;
}

export function biConnectionRef(code) {
  return `BIC-${slug(code) || shortId()}`;
}

export function biDatasetRef(code) {
  return `BID-${slug(code) || shortId()}`;
}

export function widgetRef() {
  return `WGT-${shortId()}`;
}

export function jobRef() {
  return `RJB-${shortId()}`;
}

