// Vocabulary for the Generic Traceability Engine.
//
// The engine is a thin, reusable composition layer over the two platform
// capabilities that already own the data:
//   * the Object & Relationship Framework (`services/objects.js`) owns generic
//     objects, typed bidirectional links, references and revisions;
//   * the Digital Thread (`services/thread/`) owns configurable domains,
//     relationship definitions, traceability rules, traversal, paths, impact,
//     matrices, completeness, snapshots and baselines.
//
// Nothing about Requirement/Product/EBOM/MES is hard-coded here: object types,
// relationship types, domains and rules are entirely configuration-driven and
// loaded from the registry at request time.

export const SOURCE_MODULE = "traceability";

// Relationship scopes accepted by the coverage/orphan engines. "ANY" counts any
// active link to the target domain; a specific relationship type narrows it.
export const RELATIONSHIP_SCOPES = Object.freeze(["ANY", "TYPED"]);

// Determines how the coverage denominator is computed.
export const COVERAGE_EXPECTED_MODES = Object.freeze([
  "ALL", // every object of the source domain in the tenant
  "ACTIVE", // only non-obsolete objects
]);

export const COVERAGE_DEFAULTS = Object.freeze({
  expected_mode: "ALL",
  exclude_obsolete: false,
});

// Classification of a broken trace link. Kept as data so the API never needs to
// branch on prose and new reasons can be added without touching the engine.
export const BROKEN_LINK_REASONS = Object.freeze({
  SOURCE_DELETED: "SOURCE_DELETED",
  TARGET_DELETED: "TARGET_DELETED",
  SOURCE_OBSOLETE: "SOURCE_OBSOLETE",
  TARGET_OBSOLETE: "TARGET_OBSOLETE",
  RELATIONSHIP_TYPE_INACTIVE: "RELATIONSHIP_TYPE_INACTIVE",
  RELATIONSHIP_INACTIVE: "RELATIONSHIP_INACTIVE",
  EFFECTIVITY_EXPIRED: "EFFECTIVITY_EXPIRED",
  REFERENCE_TARGET_MISSING: "REFERENCE_TARGET_MISSING",
  REFERENCE_TARGET_DELETED: "REFERENCE_TARGET_DELETED",
});

export const BROKEN_LINK_SEVERITIES = Object.freeze(["INFO", "WARNING", "ERROR"]);

// Object statuses treated as obsolete/archived for broken-link classification.
export const OBSOLETE_STATUSES = Object.freeze(["obsolete", "archived"]);

// Reuse the Digital Thread IAM resources: the traceability API is an alternate
// projection of the same engine, so it must not introduce a second
// authorization system.
export const TRACEABILITY_RESOURCES = Object.freeze({
  overview: "iam.thread.overview",
  explorer: "iam.thread.explorer",
  traceability: "iam.thread.traceability",
  impact: "iam.thread.impact",
  paths: "iam.thread.paths",
  completeness: "iam.thread.completeness",
  definitions: "iam.thread.definitions",
  admin: "iam.thread.admin",
});

export const MAX_COVERAGE_SOURCES = 50000;
export const MAX_BROKEN_LINKS = 500;
export const MAX_ORPHANS = 1000;
