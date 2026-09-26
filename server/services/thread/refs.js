// Node-reference helpers shared by the thread services.
//
// A reference is a provider-neutral identity "objectType:objectId". Revisions
// and effectivity are carried on the resolved node/edge, never in the ref, so
// the same identity can be compared across snapshots and contexts.
export { nodeRefKey } from "./validation.js";

export function nodeRefValue(ref) {
  if (!ref) return "";
  return `${String(ref.objectType || "")}:${String(ref.objectId || "")}`;
}

export function parseNodeRefValue(text) {
  const raw = String(text || "");
  const index = raw.indexOf(":");
  if (index <= 0) return { objectType: raw, objectId: "" };
  return { objectType: raw.slice(0, index), objectId: raw.slice(index + 1) };
}

export function slug(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]+/g, "_")
    .slice(0, 48);
}

