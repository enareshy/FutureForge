// Human-readable reference generators for Standards & Exchange artifacts.
import { randomUuid } from "../../db.js";

export function shortId() {
  return randomUuid().replace(/-/g, "").slice(0, 12);
}

export function formatRef(code) {
  return `EXC-FMT-${slug(code) || shortId()}`;
}

export function adapterRef(code) {
  return `EXC-ADP-${slug(code) || shortId()}`;
}

export function definitionRef(code) {
  return `EXC-DEF-${slug(code) || shortId()}`;
}

export function mappingRef(code) {
  return `EXC-MAP-${slug(code) || shortId()}`;
}

export function transformationRef(code) {
  return `EXC-TRF-${slug(code) || shortId()}`;
}

export function validationProfileRef(code) {
  return `EXC-VAL-${slug(code) || shortId()}`;
}

export function transactionRef() {
  return `EXC-TXN-${shortId()}`;
}

export function jobRef() {
  return `EXC-JOB-${shortId()}`;
}

export function reconciliationRef() {
  return `EXC-REC-${shortId()}`;
}

export function slug(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]+/g, "_")
    .slice(0, 48);
}
