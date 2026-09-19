// ConflictDetector — surfaces prohibited overlaps and competing candidates so
// the resolver can return CONFLICT instead of silently selecting one revision.
import { rangesOverlap, serialRangesOverlap } from "../validation.js";

function overlapsFor(definitions) {
  const conflicts = [];
  for (let i = 0; i < definitions.length; i += 1) {
    for (let j = i + 1; j < definitions.length; j += 1) {
      const a = definitions[i];
      const b = definitions[j];
      if (a.revision_id && b.revision_id && String(a.revision_id) === String(b.revision_id)) continue;
      if (a.overlap_allowed && b.overlap_allowed) continue;
      let overlap = false;
      if ((a.effective_from || a.effective_to) && (b.effective_from || b.effective_to)) {
        overlap = rangesOverlap(a.effective_from, a.effective_to, b.effective_from, b.effective_to);
      }
      if (!overlap && (a.serial_from || a.serial_to) && (b.serial_from || b.serial_to)) {
        overlap = serialRangesOverlap(a.serial_from, a.serial_to, b.serial_from, b.serial_to, a.serial_mode || "numeric");
      }
      if (overlap) {
        conflicts.push({
          left: { definition: a.code, revision_id: a.revision_id ?? null, from: a.effective_from, to: a.effective_to },
          right: { definition: b.code, revision_id: b.revision_id ?? null, from: b.effective_from, to: b.effective_to },
        });
      }
    }
  }
  return conflicts;
}

export const ConflictDetector = {
  // Given the winning candidates and their matched definitions, decide whether
  // the situation is a hard conflict (overlapping effectivity) or a plain tie.
  detect(candidates, { allowOverlap = false } = {}) {
    const definitions = [];
    for (const candidate of candidates) {
      for (const definition of candidate.matchedDefinitions ?? []) {
        definitions.push(definition);
      }
    }
    const conflicts = overlapsFor(definitions);
    if (conflicts.length && !allowOverlap) {
      return { conflicting: true, conflicts };
    }
    return { conflicting: false, conflicts };
  },
};
