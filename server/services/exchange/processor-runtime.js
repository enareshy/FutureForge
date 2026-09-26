// Shared runtime helpers for the exchange processor and reconciliation.
//
// Kept in a leaf module so reconciliation.js and processor.js can share count
// shaping without importing each other.
import { parseJson } from "./repository.js";
import { RECONCILIATION_COUNTERS } from "./constants.js";

export function emptyCounts() {
  const counts = {};
  for (const key of RECONCILIATION_COUNTERS) counts[key] = 0;
  return counts;
}

// Extracts normalized reconciliation counts from a transaction row.
export function runtimeCounts(transaction) {
  const counts = emptyCounts();
  const stored = parseJson(transaction?.counts_json, {});
  for (const key of RECONCILIATION_COUNTERS) {
    if (stored[key] !== undefined) counts[key] = Math.max(0, Number(stored[key]) || 0);
  }
  return counts;
}

export function mergeCounts(base, delta = {}) {
  const counts = { ...emptyCounts(), ...(base || {}) };
  for (const key of RECONCILIATION_COUNTERS) {
    if (delta[key] !== undefined) counts[key] = (Number(counts[key]) || 0) + (Number(delta[key]) || 0);
  }
  return counts;
}
