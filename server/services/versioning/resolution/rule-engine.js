// ResolutionRuleEngine — applies the configurable precedence and ambiguity
// strategy from a ResolutionPolicy. Never chooses arbitrarily: ambiguous ties
// are reported unless the policy explicitly authorizes a tie-breaker.
import { safeParse, CORE_PRECEDENCE } from "../validation.js";
import { ConflictDetector } from "./conflicts.js";

const REASON_BY_DIMENSION = {
  configuration: "CONFIGURATION_EFFECTIVITY",
  revision: "REVISION_EFFECTIVITY",
  serial: "SERIAL_EFFECTIVITY",
  model: "MODEL_EFFECTIVITY",
  plant: "PLANT_EFFECTIVITY",
  unit: "UNIT_EFFECTIVITY",
  organization: "PLANT_EFFECTIVITY",
  site: "PLANT_EFFECTIVITY",
  variant: "VARIANT_EFFECTIVITY",
  date: "DATE_EFFECTIVITY",
  default: "DEFAULT_REVISION",
};

export function precedenceOf(policy) {
  const list = safeParse(policy?.precedence_json ?? policy?.precedence, null);
  const resolved = Array.isArray(list) && list.length ? list : CORE_PRECEDENCE;
  const ordered = resolved.filter((dim) => dim !== "default");
  return { ordered, includesDefault: resolved.includes("default") || ordered.length === 0 };
}

function candidateScore(candidate) {
  return {
    revision_id: candidate.revision.id,
    revision_code: candidate.revision.revision_code,
    revision_sequence: candidate.revision.revision_sequence,
    specificity: candidate.specificity,
    priority: Number.isFinite(candidate.priority) ? candidate.priority : 100,
    matched_dimensions: [...candidate.matchedDimensions],
  };
}

function tieBreakPolicy() {
  return "error";
}

function pickByStrategy(candidates, strategy) {
  if (candidates.length === 1) return { picked: candidates[0], tie: false };
  if (strategy === "priority") {
    const min = Math.min(...candidates.map((c) => (Number.isFinite(c.priority) ? c.priority : 100)));
    const top = candidates.filter((c) => (Number.isFinite(c.priority) ? c.priority : 100) === min);
    if (top.length === 1) return { picked: top[0], tie: false };
    return { picked: null, tie: true };
  }
  if (strategy === "latest_revision") {
    const max = Math.max(...candidates.map((c) => Number(c.revision.revision_sequence) || 0));
    const top = candidates.filter((c) => Number(c.revision.revision_sequence) === max);
    if (top.length === 1) return { picked: top[0], tie: false };
    return { picked: null, tie: true };
  }
  return { picked: null, tie: true };
}

export const ResolutionRuleEngine = {
  precedenceOf,
  tieBreakPolicy,

  // Returns { status, winner, reason, scored, conflicts, dimension }.
  evaluate(candidates, { policy, fallbackRevision = null } = {}) {
    const { ordered, includesDefault } = precedenceOf(policy);
    const strategy = policy?.ambiguity_strategy ?? "error";
    const allowOverlap = Boolean(policy?.allow_overlap);

    if (!candidates.length) {
      if (fallbackRevision) {
        return {
          status: "RESOLVED",
          winner: {
            revision: fallbackRevision,
            versionId: null,
            matchedDimensions: new Set(["default"]),
            reasons: [{ dimension: "default", reason: "DEFAULT_REVISION" }],
            specificity: 0,
            priority: 100,
            matchedDefinitions: [],
          },
          reason: "DEFAULT_REVISION",
          dimension: "default",
          scored: [],
          conflicts: [],
        };
      }
      return { status: "NOT_FOUND", winner: null, reason: "NO_CANDIDATE", dimension: null, scored: [], conflicts: [] };
    }

    for (const dimension of ordered) {
      const matched = candidates.filter((c) => c.matchedDimensions.has(dimension));
      if (!matched.length) continue;
      // Prefer the most specific candidates within the dimension; only drop
      // lower-specificity candidates when they cannot tie on specificity.
      const maxSpecificity = Math.max(...matched.map((c) => c.specificity));
      const top = matched.filter((c) => c.specificity === maxSpecificity);
      const conflictCheck = ConflictDetector.detect(top, { allowOverlap });
      if (conflictCheck.conflicting) {
        return {
          status: "CONFLICT",
          winner: null,
          reason: "EFFECTIVITY_CONFLICT",
          dimension,
          scored: matched.map(candidateScore),
          conflicts: conflictCheck.conflicts,
        };
      }
      if (top.length === 1) {
        return {
          status: "RESOLVED",
          winner: top[0],
          reason: REASON_BY_DIMENSION[dimension] ?? "EFFECTIVITY",
          dimension,
          scored: matched.map(candidateScore),
          conflicts: [],
        };
      }
      const { picked, tie } = pickByStrategy(top, strategy);
      if (picked) {
        return {
          status: "RESOLVED",
          winner: picked,
          reason: REASON_BY_DIMENSION[dimension] ?? "EFFECTIVITY",
          dimension,
          scored: matched.map(candidateScore),
          conflicts: [],
        };
      }
      if (tie) {
        return {
          status: "AMBIGUOUS",
          winner: null,
          reason: "AMBIGUOUS_RESOLUTION",
          dimension,
          scored: matched.map(candidateScore),
          conflicts: [],
        };
      }
    }

    if (includesDefault && fallbackRevision) {
      return {
        status: "RESOLVED",
        winner: {
          revision: fallbackRevision,
          versionId: null,
          matchedDimensions: new Set(["default"]),
          reasons: [{ dimension: "default", reason: "DEFAULT_REVISION" }],
          specificity: 0,
          priority: 100,
          matchedDefinitions: [],
        },
        reason: "DEFAULT_REVISION",
        dimension: "default",
        scored: candidates.map(candidateScore),
        conflicts: [],
      };
    }

    return { status: "NOT_FOUND", winner: null, reason: "NO_APPLICABLE_REVISION", dimension: null, scored: candidates.map(candidateScore), conflicts: [] };
  },
};
