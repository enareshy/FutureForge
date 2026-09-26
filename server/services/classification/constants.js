// Vocabulary, defaults and platform wiring codes for the Enterprise
// Classification Framework.
//
// Classification is a centralized semantic capability: hierarchies, classes,
// characteristics, characteristic groups, units, allowed values, inheritance,
// assignments, validation, search, facets and duplicate signals. Everything an
// administrator can tune is data. No classification tree, characteristic or
// allowed value is hard-coded into the engine.

export const SOURCE_MODULE = "classification";

// ── Lifecycle ────────────────────────────────────────────────────────────────

export const CLASSIFICATION_STATUSES = ["DRAFT", "ACTIVE", "SUPERSEDED", "OBSOLETE"];

export const CLASS_STATUSES = ["DRAFT", "ACTIVE", "SUPERSEDED", "OBSOLETE"];

export const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED"];

// Definitions that may receive new assignments.
export const ASSIGNABLE_STATUSES = ["ACTIVE"];

// ── Characteristics ──────────────────────────────────────────────────────────

// The spec's supported data types. New types are added as data here plus a
// validator in validation.js; the storage model never changes.
export const CHARACTERISTIC_DATA_TYPES = [
  "STRING",
  "INTEGER",
  "DECIMAL",
  "BOOLEAN",
  "DATE",
  "DATETIME",
  "ENUMERATION",
  "REFERENCE",
  "UNIT_NUMERIC",
];

export const CHARACTERISTIC_STATUSES = ["ACTIVE", "INACTIVE", "DEPRECATED"];

export const CHARACTERISTIC_ORIGINS = ["LOCAL", "INHERITED", "OVERRIDDEN"];

export const ALLOWED_VALUE_MODES = ["INHERIT", "EXTEND", "RESTRICT"];

export const RULE_TYPES = ["REQUIRED", "RANGE", "ENUM", "REGEX", "EXPRESSION", "MULTI_VALUE", "UNIT", "REFERENCE"];

export const RULE_SEVERITIES = ["ERROR", "WARNING", "INFO"];

// ── Assignments ──────────────────────────────────────────────────────────────

export const ASSIGNMENT_STATUSES = ["ACTIVE", "INACTIVE", "OBSOLETE"];

// Objects may belong to multiple classifications simultaneously; the only
// restriction is an optional per-object-type single-class policy.
export const OBJECT_CARDINALITIES = ["MULTIPLE", "SINGLE"];

// ── Numeric / unit handling ──────────────────────────────────────────────────

export const NUMERIC_DATA_TYPES = ["INTEGER", "DECIMAL", "UNIT_NUMERIC"];

export const UNIT_DATA_TYPES = ["DECIMAL", "UNIT_NUMERIC"];

// The reference-data domain that owns the enterprise unit list. Classification
// never maintains its own unit master; it reads and writes this domain.
export const UNIT_DOMAIN_CODE = "UNIT_OF_MEASURE";

export const MAX_HIERARCHY_DEPTH = 64;
export const MAX_CHILDREN = 5000;
export const MAX_ALLOWED_VALUES = 5000;
export const MAX_CLASS_CHARACTERISTICS = 500;
export const MAX_ASSIGNMENT_VALUES = 500;
export const MAX_BULK_OBJECTS = 50000;

// ── Background job handlers ──────────────────────────────────────────────────

export const CLASSIFICATION_HANDLER_CODES = Object.freeze({
  BULK_ASSIGN: "classification.bulkAssign",
  BULK_VALIDATE: "classification.bulkValidate",
  DUPLICATE_SCAN: "classification.duplicateScan",
  MAINTENANCE: "classification.maintenance",
});

export const CLASSIFICATION_JOB_TYPES = [
  {
    code: "CLASSIFICATION_BULK_ASSIGN",
    name: "Bulk classification assignment",
    description: "Assign or unassign a class to a large set of objects asynchronously.",
    source_module: SOURCE_MODULE,
    handler: CLASSIFICATION_HANDLER_CODES.BULK_ASSIGN,
    queues: ["classification", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "CLASSIFICATION_BULK_VALIDATE",
    name: "Bulk classification validation",
    description: "Validate many classified objects and report gaps and invalid values.",
    source_module: SOURCE_MODULE,
    handler: CLASSIFICATION_HANDLER_CODES.BULK_VALIDATE,
    queues: ["classification", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "CLASSIFICATION_DUPLICATE_SCAN",
    name: "Classification duplicate scan",
    description: "Detect likely duplicate objects using classification characteristics.",
    source_module: SOURCE_MODULE,
    handler: CLASSIFICATION_HANDLER_CODES.DUPLICATE_SCAN,
    queues: ["classification", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "low",
  },
  {
    code: "CLASSIFICATION_MAINTENANCE",
    name: "Classification maintenance",
    description: "Refresh caches, recompute assignment counts and archive stale history.",
    source_module: SOURCE_MODULE,
    handler: CLASSIFICATION_HANDLER_CODES.MAINTENANCE,
    queues: ["default"],
    timeout_seconds: 1800,
    max_retries: 1,
    default_priority: "low",
  },
];

// ── Domain events ────────────────────────────────────────────────────────────

export const CLASSIFICATION_EVENT_TYPES = [
  { code: "ClassificationCreated", description: "A classification definition was created." },
  { code: "ClassificationUpdated", description: "A classification definition was updated." },
  { code: "ClassificationActivated", description: "A classification definition became active." },
  { code: "ClassificationDeprecated", description: "A classification definition was obsoleted." },
  { code: "ClassCreated", description: "A classification class was created." },
  { code: "ClassUpdated", description: "A classification class was updated." },
  { code: "ClassMoved", description: "A class was moved within the hierarchy." },
  { code: "CharacteristicCreated", description: "A characteristic was created." },
  { code: "CharacteristicUpdated", description: "A characteristic was updated." },
  { code: "ClassificationAssigned", description: "A class was assigned to an object." },
  { code: "ClassificationUnassigned", description: "A class was removed from an object." },
  { code: "ClassificationValuesUpdated", description: "Assignment characteristic values changed." },
  { code: "ClassificationValidated", description: "A classification assignment was validated." },
  { code: "ClassificationDuplicateDetected", description: "Potential duplicate objects were detected." },
  { code: "ClassificationBulkCompleted", description: "A bulk classification job completed." },
];

// ── Tenant configuration ─────────────────────────────────────────────────────

export const CONFIG_DEFAULTS = Object.freeze({
  default_class_status: "DRAFT",
  allow_obsolete_assignment: false,
  require_effective_date: false,
  enforce_reference_integrity: true,
  allow_multiple_classification: true,
  allow_multi_value: true,
  enforce_units: true,
  auto_normalize_units: true,
  max_hierarchy_depth: 64,
  max_allowed_values: 5000,
  bulk_batch_size: 500,
  max_bulk_objects: 50000,
  duplicate_similarity_threshold: 0.85,
  duplicate_scan_limit: 500,
  cache_ttl_seconds: 300,
  history_retention_days: 365,
});

export const CONFIG_BOUNDS = Object.freeze({
  max_hierarchy_depth: { min: 1, max: 256 },
  max_allowed_values: { min: 1, max: 100000 },
  bulk_batch_size: { min: 1, max: 10000 },
  max_bulk_objects: { min: 1, max: 1000000 },
  duplicate_similarity_threshold: { min: 0, max: 1 },
  duplicate_scan_limit: { min: 1, max: 10000 },
  cache_ttl_seconds: { min: 0, max: 86400 },
  history_retention_days: { min: 1, max: 3650 },
});

// ── IAM resources ────────────────────────────────────────────────────────────

export const CLASSIFICATION_RESOURCES = Object.freeze({
  module: "iam.classification",
  overview: "iam.classification.overview",
  classifications: "iam.classification.classifications",
  classes: "iam.classification.classes",
  characteristics: "iam.classification.characteristics",
  groups: "iam.classification.groups",
  values: "iam.classification.values",
  assignments: "iam.classification.assignments",
  validation: "iam.classification.validation",
  search: "iam.classification.search",
  governance: "iam.classification.governance",
  migration: "iam.classification.migration",
  auditTrail: "iam.classification.audit",
  metrics: "iam.classification.metrics",
  admin: "iam.classification.admin",
});

export const SECURITY_ACTIONS = [
  "VIEW_CLASSIFICATION",
  "MANAGE_CLASSIFICATION",
  "MANAGE_CLASS",
  "MANAGE_CHARACTERISTIC",
  "MANAGE_ALLOWED_VALUE",
  "ASSIGN_CLASSIFICATION",
  "VALIDATE_CLASSIFICATION",
  "APPROVE_CLASSIFICATION",
  "VIEW_AUDIT",
];

// ── Search integration ───────────────────────────────────────────────────────

export const SEARCH_OBJECT_TYPES = [
  { code: "classification", name: "Classifications", description: "Enterprise classification definitions and their classes." },
  { code: "classification_class", name: "Classification classes", description: "Classification classes and characteristic definitions." },
  { code: "classification_assignment", name: "Classification assignments", description: "Objects classified against a classification class." },
];

export const DAY_MS = 24 * 60 * 60 * 1000;
