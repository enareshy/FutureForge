// In-process decision cache with epoch based invalidation. Epochs live in the
// database so rule changes in one process invalidate caches everywhere they are
// observed (the worker and the API share the same catalog).
import { currentEpoch } from "./repository.js";

const MAX_ENTRIES = 5000;
const cache = new Map();

function keyFor(tenantId, context, action, resourceType, resourceId) {
  return [
    Number(tenantId),
    context?.userId ?? "anon",
    action,
    resourceType || "",
    resourceId ?? "",
  ].join("|");
}

export function decisionCacheKey(tenantId, context, action, resourceType, resourceId) {
  return keyFor(tenantId, context, action, resourceType, resourceId);
}

export function getCachedDecision(db, tenantId, context, action, resourceType, resourceId) {
  const epoch = currentEpoch(db, tenantId, "all");
  const entry = cache.get(keyFor(tenantId, context, action, resourceType, resourceId));
  if (!entry || entry.epoch !== epoch) return null;
  return entry.decision;
}

export function setCachedDecision(db, tenantId, context, action, resourceType, resourceId, decision) {
  const epoch = currentEpoch(db, tenantId, "all");
  const key = keyFor(tenantId, context, action, resourceType, resourceId);
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { epoch, decision, at: Date.now() });
  return decision;
}

export function clearDecisionCache() {
  cache.clear();
}

export function decisionCacheSize() {
  return cache.size;
}
