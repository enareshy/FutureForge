// Human-readable reference generators. Refs are safe in URLs, search and audit
// records so operators can identify a record without a database lookup.
import { randomUuid } from "../../db.js";

export function shortId() {
  return randomUuid().replace(/-/g, "").slice(0, 12);
}

export function slug(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]+/g, "_")
    .slice(0, 40);
}

export function entryRef(type, code) {
  return `DC-${slug(type) || "ENT"}-${slug(code) || shortId()}`;
}

export function objectRef(code) {
  return `DC-OBJ-${slug(code) || shortId()}`;
}

export function attributeRef(objectType, name) {
  return `DC-ATTR-${slug(`${objectType}.${name}`) || shortId()}`;
}

export function termRef(code) {
  return `DC-TERM-${slug(code) || shortId()}`;
}

export function sourceRef(code) {
  return `DC-SRC-${slug(code) || shortId()}`;
}

export function consumerRef(code) {
  return `DC-CON-${slug(code) || shortId()}`;
}

export function classificationRef(code) {
  return `DC-CLS-${slug(code) || shortId()}`;
}
