// Human-readable reference generators for Digital Thread artifacts.
import { randomUuid } from "../../db.js";

export function shortId() {
  return randomUuid().replace(/-/g, "").slice(0, 12);
}

export function definitionRef(code) {
  return `THR-DEF-${slug(code) || shortId()}`;
}

export function ruleRef(code) {
  return `THR-RULE-${slug(code) || shortId()}`;
}

export function snapshotRef(name) {
  return `THR-SNAP-${slug(name) || shortId()}`;
}

export function baselineRef(name) {
  return `THR-BL-${slug(name) || shortId()}`;
}

export function threadId() {
  return `THR-${shortId()}`;
}

function slug(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]+/g, "_")
    .slice(0, 48);
}
