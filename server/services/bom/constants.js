// Vocabulary, defaults and platform wiring codes for the P1 BOM Engine.
//
// The BOM Engine is a reusable enterprise capability layered on top of the
// Object & Relationship Framework, the Lifecycle/Effectivity & Versioning
// Kernel, Classification and Reference/UOM. Every piece of vocabulary an
// administrator can tune (BOM types, statuses, usages, rule types, mapping
// types, job types, event types, search types, configuration) is data here so
// the storage model and services never change when new values are added.

export const SOURCE_MODULE = "bom";

// ── BOM types ────────────────────────────────────────────────────────────────

export const BOM_TYPES = ["EBOM", "MBOM", "BOP", "OTHER"];

// ── Lifecycle ────────────────────────────────────────────────────────────────

export const BOM_STATUSES = ["DRAFT", "IN_REVIEW", "RELEASED", "SUPERSEDED", "OBSOLETE"];

export const REVISION_STATUSES = ["DRAFT", "IN_REVIEW", "RELEASED", "SUPERSEDED", "OBSOLETE"];

// Revisions in these statuses may not be edited in place (immutable).
export const IMMUTABLE_REVISION_STATUSES = ["SUPERSEDED", "OBSOLETE"];

// A default lifecycle state machine used when the BOM object type is not
// onboarded to the shared Lifecycle kernel. Transitions are still validated
// centrally by the BOM service, and the shared kernel is preferred whenever a
// lifecycle assignment exists.
export const DEFAULT_REVISION_TRANSITIONS = Object.freeze({
  DRAFT: ["IN_REVIEW", "OBSOLETE"],
  IN_REVIEW: ["DRAFT", "RELEASED", "OBSOLETE"],
  RELEASED: ["SUPERSEDED", "OBSOLETE"],
  SUPERSEDED: ["OBSOLETE"],
  OBSOLETE: [],
});

export const LINE_STATUSES = ["DRAFT", "ACTIVE", "INACTIVE", "OBSOLETE"];

export const BASELINE_STATUSES = ["DRAFT", "FROZEN", "RETIRED"];

// ── Line semantics ───────────────────────────────────────────────────────────

export const USAGES = ["DESIGN", "MANUFACTURING", "SERVICE", "SPARE", "REFERENCE"];

export const REFERENCE_DESIGNATOR_SEPARATOR = ",";

// ── Transformation ───────────────────────────────────────────────────────────

export const MAPPING_TYPES = ["OBJECT", "LINE", "QUANTITY", "ATTRIBUTE", "CLASSIFICATION", "RELATIONSHIP", "CONSTANT"];

export const TRANSFORMATION_MODES = ["DRY_RUN", "EXECUTE"];

// Run status (bom_transformation_runs) and definition lifecycle (definitions)
// are distinct vocabularies.
export const TRANSFORMATION_STATUSES = ["PENDING", "RUNNING", "COMPLETED", "FAILED"];

export const TRANSFORMATION_DEFINITION_STATUSES = ["DRAFT", "ACTIVE", "INACTIVE"];

// ── Comparison ───────────────────────────────────────────────────────────────

export const CHANGE_TYPES = ["ADDED", "REMOVED", "MODIFIED", "UNCHANGED"];

export const COMPARISON_SCOPES = ["LINE", "RECURSIVE"];

export const COMPARISON_KINDS = ["REVISION", "BASELINE"];

// ── Validation ───────────────────────────────────────────────────────────────

export const RULE_TYPES = [
  "MISSING_CHILD",
  "INVALID_QUANTITY",
  "MISSING_UOM",
  "INVALID_UOM",
  "DUPLICATE_LINE",
  "DUPLICATE_FIND_NUMBER",
  "INVALID_SEQUENCE",
  "CIRCULAR_STRUCTURE",
  "INVALID_SUBSTITUTE",
  "INVALID_EFFECTIVITY",
  "INVALID_VARIANT",
  "UNAUTHORIZED_CHILD",
  "LIFECYCLE_INCOMPATIBILITY",
  "MISSING_MANDATORY_ATTRIBUTE",
  "CUSTOM",
];

export const RULE_SEVERITIES = ["PASS", "WARNING", "ERROR"];

export const VALIDATION_SCOPES = ["REVISION", "LINE"];

export const VALIDATION_STATUSES = ["PASS", "WARNING", "ERROR"];

// Default rules installed per tenant; rules remain fully configurable data.
export const DEFAULT_VALIDATION_RULES = [
  { code: "LINE_REQUIRES_CHILD", rule_type: "MISSING_CHILD", severity: "ERROR", description: "Every BOM line must reference a child object.", sequence: 10 },
  { code: "LINE_REQUIRES_UOM", rule_type: "MISSING_UOM", severity: "ERROR", description: "Every BOM line must declare a unit of measure.", sequence: 20 },
  { code: "LINE_POSITIVE_QUANTITY", rule_type: "INVALID_QUANTITY", severity: "ERROR", description: "BOM line quantity must be a positive number.", config_json: { min: 0, exclusive: true }, sequence: 30 },
  { code: "LINE_UNIQUE_FIND_NUMBER", rule_type: "DUPLICATE_FIND_NUMBER", severity: "WARNING", description: "Find numbers should be unique within a parent.", sequence: 40 },
  { code: "LINE_UNIQUE_CHILD", rule_type: "DUPLICATE_LINE", severity: "WARNING", description: "A child should appear at most once under the same parent.", sequence: 50 },
  { code: "LINE_VALID_SEQUENCE", rule_type: "INVALID_SEQUENCE", severity: "WARNING", description: "Line sequence must be a non-negative integer.", sequence: 60 },
  { code: "STRUCTURE_NO_CYCLES", rule_type: "CIRCULAR_STRUCTURE", severity: "ERROR", description: "A BOM structure must not contain circular references.", sequence: 70 },
  { code: "SUBSTITUTE_VALID", rule_type: "INVALID_SUBSTITUTE", severity: "ERROR", description: "Substitute parts must differ from the primary part.", sequence: 80 },
];

// ── Numeric / unit handling ──────────────────────────────────────────────────

export const DEFAULT_UOM = "EA";

// The shared reference-data domain that owns the enterprise unit list. The BOM
// Engine never maintains its own unit master.
export const UNIT_DOMAIN_CODE = "UNIT_OF_MEASURE";

export const MAX_LINES_PER_REVISION = 200000;
export const MAX_STRUCTURE_DEPTH = 200;
export const MAX_BULK_OBJECTS = 50000;
export const MAX_COMPARE_LINES = 200000;

// ── Background job handlers ──────────────────────────────────────────────────

export const BOM_HANDLER_CODES = Object.freeze({
  ROLLUP: "bom.rollup",
  WHERE_USED: "bom.whereUsed",
  TRANSFORM: "bom.transform",
  VALIDATE: "bom.validate",
  COMPARE: "bom.compare",
  MAINTENANCE: "bom.maintenance",
});

export const BOM_JOB_TYPES = [
  {
    code: "BOM_ROLLUP",
    name: "BOM rollup",
    description: "Compute a recursive, UOM-aware quantity rollup for a BOM revision.",
    source_module: SOURCE_MODULE,
    handler: BOM_HANDLER_CODES.ROLLUP,
    queues: ["bom", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "BOM_WHERE_USED",
    name: "BOM where-used",
    description: "Resolve direct and multi-level where-used parents for a part.",
    source_module: SOURCE_MODULE,
    handler: BOM_HANDLER_CODES.WHERE_USED,
    queues: ["bom", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "BOM_TRANSFORM",
    name: "BOM transformation",
    description: "Execute a controlled BOM transformation (for example EBOM to MBOM).",
    source_module: SOURCE_MODULE,
    handler: BOM_HANDLER_CODES.TRANSFORM,
    queues: ["bom", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "BOM_VALIDATE",
    name: "BOM validation",
    description: "Run the configurable BOM validation rules over a revision.",
    source_module: SOURCE_MODULE,
    handler: BOM_HANDLER_CODES.VALIDATE,
    queues: ["bom", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "BOM_COMPARE",
    name: "BOM comparison",
    description: "Compare two BOM revisions or baselines recursively.",
    source_module: SOURCE_MODULE,
    handler: BOM_HANDLER_CODES.COMPARE,
    queues: ["bom", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "BOM_MAINTENANCE",
    name: "BOM maintenance",
    description: "Refresh caches, prune stale history and repair orphaned lines.",
    source_module: SOURCE_MODULE,
    handler: BOM_HANDLER_CODES.MAINTENANCE,
    queues: ["default"],
    timeout_seconds: 1800,
    max_retries: 1,
    default_priority: "low",
  },
];

// ── Domain events ────────────────────────────────────────────────────────────

export const BOM_EVENT_TYPES = [
  { code: "BomCreated", description: "A BOM header was created." },
  { code: "BomUpdated", description: "A BOM header was updated." },
  { code: "BomRevisionCreated", description: "A BOM revision was created." },
  { code: "BomRevisionRevised", description: "A BOM revision was revised from another revision." },
  { code: "BomRevisionReleased", description: "A BOM revision was released." },
  { code: "BomRevisionStatusChanged", description: "A BOM revision changed lifecycle status." },
  { code: "BomLineAdded", description: "A BOM line was added." },
  { code: "BomLineUpdated", description: "A BOM line was updated." },
  { code: "BomLineRemoved", description: "A BOM line was removed." },
  { code: "BomSubstituteAdded", description: "A substitute part was added." },
  { code: "BomSubstituteRemoved", description: "A substitute part was removed." },
  { code: "BomBaselineCreated", description: "An immutable BOM baseline was created." },
  { code: "BomBaselineFrozen", description: "A BOM baseline was frozen." },
  { code: "BomTransformed", description: "A BOM transformation completed." },
  { code: "BomValidationCompleted", description: "A BOM validation run completed." },
  { code: "BomCompared", description: "A BOM comparison completed." },
  { code: "BomRollupCompleted", description: "A BOM rollup completed." },
  { code: "BomBulkCompleted", description: "A bulk BOM job completed." },
];

// ── Tenant configuration ─────────────────────────────────────────────────────

export const CONFIG_DEFAULTS = Object.freeze({
  default_revision_status: "DRAFT",
  default_uom: "EA",
  enforce_uom: true,
  auto_normalize_units: true,
  require_child_object: true,
  allow_duplicate_children: true,
  allow_optional_lines: true,
  allow_substitutes: true,
  enforce_single_default_revision: true,
  block_cycle: true,
  max_structure_depth: 200,
  max_lines_per_revision: 200000,
  default_rollup_mode: "QUANTITY",
  rollup_include_optional: false,
  compare_case_sensitive: false,
  bulk_batch_size: 500,
  max_bulk_objects: 50000,
  cache_ttl_seconds: 300,
  history_retention_days: 365,
  baseline_immutable: true,
});

export const CONFIG_BOUNDS = Object.freeze({
  max_structure_depth: { min: 1, max: 1000 },
  max_lines_per_revision: { min: 1, max: 5000000 },
  bulk_batch_size: { min: 1, max: 10000 },
  max_bulk_objects: { min: 1, max: 1000000 },
  cache_ttl_seconds: { min: 0, max: 86400 },
  history_retention_days: { min: 1, max: 3650 },
});

// ── IAM resources ────────────────────────────────────────────────────────────

export const BOM_RESOURCES = Object.freeze({
  module: "iam.bom",
  overview: "iam.bom.overview",
  boms: "iam.bom.boms",
  revisions: "iam.bom.revisions",
  lines: "iam.bom.lines",
  structure: "iam.bom.structure",
  compare: "iam.bom.compare",
  whereUsed: "iam.bom.whereused",
  rollup: "iam.bom.rollup",
  transformation: "iam.bom.transformation",
  validation: "iam.bom.validation",
  baseline: "iam.bom.baseline",
  search: "iam.bom.search",
  auditTrail: "iam.bom.audit",
  metrics: "iam.bom.metrics",
  admin: "iam.bom.admin",
});

export const SECURITY_ACTIONS = [
  "VIEW_BOM",
  "MANAGE_BOM",
  "REVISE_BOM",
  "RELEASE_BOM",
  "COMPARE_BOM",
  "WHERE_USED",
  "ROLLUP",
  "TRANSFORM_BOM",
  "VALIDATE_BOM",
  "BASELINE_BOM",
  "VIEW_AUDIT",
];

// ── Search integration ───────────────────────────────────────────────────────

export const SEARCH_OBJECT_TYPES = [
  { code: "bom", name: "BOM headers", description: "BOM headers and their type, lifecycle and ownership." },
  { code: "bom_revision", name: "BOM revisions", description: "BOM revisions with status, variant and effectivity." },
  { code: "bom_line", name: "BOM lines", description: "BOM lines with child part, quantity, find number and usage." },
];

export const DAY_MS = 24 * 60 * 60 * 1000;
