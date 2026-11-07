// Per-database capability cache.
//
// Resolving effective entitlements touches the profile plus every feature row,
// and it is read on every gated request. The result is cached per database and
// invalidated on any profile/feature write so reads stay O(1) without risking a
// stale entitlement surviving a change (mirrors the prepared-statement cache in
// server/db.js).
const capabilityCache = new WeakMap();

export function getCachedCapabilities(db) {
  return capabilityCache.get(db) || null;
}

export function setCachedCapabilities(db, value) {
  capabilityCache.set(db, value);
  return value;
}

export function invalidateCapabilities(db) {
  capabilityCache.delete(db);
}
