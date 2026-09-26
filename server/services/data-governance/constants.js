// Vocabulary for the centralized Data Governance & Data Quality service.
//
// Everything here is configuration/registry data, never enterprise business
// logic: new rule types, dimensions, severities and statuses are added through
// registration, and the core engine never changes. Business modules (PDM, BOM,
// EDM, ...) declare which object types they own and which rules apply.

export const SOURCE_MODULE = "data-governance";

export const DOMAIN_STATUSES = Object.freeze(["draft", "active", "inactive", "retired"]);

export const OWNERSHIP_RELATIONSHIPS = Object.freeze(["owner", "steward"]);
export const OWNERSHIP_SCOPES = Object.freeze(["domain", "object", "attribute"]);
export const SUBJECT_TYPES = Object.freeze(["user", "group", "organization", "role"]);

export const POLICY_STATUSES = Object.freeze(["draft", "active", "suspended", "retired"]);
export const POLICY_TRANSITIONS = Object.freeze({
  draft: ["active", "retired"],
  active: ["suspended", "retired", "active"],
  suspended: ["active", "retired"],
  retired: [],
});

export const RULE_STATUSES = Object.freeze(["draft", "active", "inactive", "retired"]);
export const RULE_TRANSITIONS = Object.freeze({
  draft: ["active", "retired"],
  active: ["inactive", "retired", "active"],
  inactive: ["active", "retired"],
  retired: [],
});

// Open for extension: a new rule type is registered with an evaluator, not by
// editing the engine.
export const RULE_TYPES = Object.freeze([
  "REQUIRED",
  "NOT_NULL",
  "UNIQUE",
  "FORMAT",
  "RANGE",
  "ENUM",
  "REFERENCE",
  "RELATIONSHIP",
  "CROSS_FIELD",
  "CROSS_OBJECT",
  "PATTERN",
  "CUSTOM",
]);

export const QUALITY_DIMENSIONS = Object.freeze([
  "completeness",
  "validity",
  "consistency",
  "accuracy",
  "uniqueness",
]);

export const DIMENSION_LABELS = Object.freeze({
  completeness: "Completeness",
  validity: "Validity",
  consistency: "Consistency",
  accuracy: "Accuracy",
  uniqueness: "Uniqueness",
});

export const RULE_TYPE_DIMENSIONS = Object.freeze({
  REQUIRED: "completeness",
  NOT_NULL: "completeness",
  UNIQUE: "uniqueness",
  FORMAT: "validity",
  RANGE: "validity",
  ENUM: "validity",
  REFERENCE: "accuracy",
  RELATIONSHIP: "consistency",
  CROSS_FIELD: "consistency",
  CROSS_OBJECT: "consistency",
  PATTERN: "validity",
  CUSTOM: "validity",
});

export const SEVERITIES = Object.freeze(["info", "warning", "error", "critical"]);
export const SEVERITY_RANK = Object.freeze({ info: 1, warning: 2, error: 3, critical: 4 });

export const OPERATORS = Object.freeze([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "not_in",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "matches",
  "is_null",
  "is_not_null",
  "between",
  "length_gt",
  "length_gte",
  "length_lt",
  "length_lte",
]);

export const NULLARY_OPERATORS = Object.freeze(["is_null", "is_not_null"]);

export const QUALITY_STATUSES = Object.freeze([
  "EXCELLENT",
  "GOOD",
  "WARNING",
  "POOR",
  "CRITICAL",
  "UNKNOWN",
]);

// Configuration defaults. Organizations can override every threshold.
export const DEFAULT_STATUS_THRESHOLDS = Object.freeze([
  { status: "EXCELLENT", min: 90 },
  { status: "GOOD", min: 75 },
  { status: "WARNING", min: 60 },
  { status: "POOR", min: 40 },
  { status: "CRITICAL", min: 0 },
]);

export const DEFAULT_DIMENSION_WEIGHTS = Object.freeze({
  completeness: 1,
  validity: 1,
  consistency: 1,
  accuracy: 1,
  uniqueness: 1,
});

export const DEFAULT_SCORING_STRATEGY = "weighted_average";

export const EXECUTION_MODES = Object.freeze(["SYNC", "ASYNC", "BATCH", "SCHEDULED", "EVENT_DRIVEN"]);

export const EXCEPTION_STATUSES = Object.freeze([
  "OPEN",
  "ASSIGNED",
  "IN_PROGRESS",
  "RESOLVED",
  "VERIFIED",
  "CLOSED",
  "REJECTED",
  "WAIVED",
  "DUPLICATE",
  "FALSE_POSITIVE",
]);

// Terminal and open status sets used by dashboards and SLA sweeps.
export const EXCEPTION_OPEN_STATUSES = Object.freeze(["OPEN", "ASSIGNED", "IN_PROGRESS"]);
export const EXCEPTION_TERMINAL_STATUSES = Object.freeze([
  "CLOSED",
  "WAIVED",
  "DUPLICATE",
  "FALSE_POSITIVE",
  "REJECTED",
]);

export const EXCEPTION_TRANSITIONS = Object.freeze({
  OPEN: ["ASSIGNED", "IN_PROGRESS", "RESOLVED", "REJECTED", "WAIVED", "DUPLICATE", "FALSE_POSITIVE"],
  ASSIGNED: ["IN_PROGRESS", "RESOLVED", "REJECTED", "WAIVED", "DUPLICATE", "FALSE_POSITIVE"],
  IN_PROGRESS: ["RESOLVED", "REJECTED", "WAIVED", "DUPLICATE", "FALSE_POSITIVE"],
  RESOLVED: ["VERIFIED", "IN_PROGRESS", "REJECTED"],
  VERIFIED: ["CLOSED", "IN_PROGRESS"],
  CLOSED: [],
  REJECTED: ["OPEN"],
  WAIVED: ["OPEN"],
  DUPLICATE: [],
  FALSE_POSITIVE: [],
});

export const EXCEPTION_PRIORITIES = Object.freeze(["low", "normal", "high", "urgent"]);
export const DEFAULT_SLA_HOURS = Object.freeze({ low: 168, normal: 72, high: 24, urgent: 8 });

export const DUPLICATE_STRATEGIES = Object.freeze(["exact", "normalized", "attribute", "similarity"]);
export const DUPLICATE_MATCH_TYPES = Object.freeze(["EXACT", "POTENTIAL", "SIMILARITY", "CANDIDATE"]);
export const DUPLICATE_STATUSES = Object.freeze(["OPEN", "REVIEWING", "CONFIRMED", "DISMISSED", "MERGED"]);

export const REMEDIATION_ACTIONS = Object.freeze([
  "SET_ATTRIBUTE",
  "REPLACE_VALUE",
  "ASSIGN_CLASSIFICATION",
  "CORRECT_UOM",
  "MERGE_DUPLICATE",
  "ASSIGN_OWNER",
]);

export const DEFAULT_EVALUATION_LIMIT = 500;
export const MAX_BATCH_SIZE = 5000;

export const CONFIG_DEFAULTS = Object.freeze({
  scoring_strategy: DEFAULT_SCORING_STRATEGY,
  status_thresholds: DEFAULT_STATUS_THRESHOLDS,
  dimension_weights: DEFAULT_DIMENSION_WEIGHTS,
  auto_raise_exceptions: true,
  exception_min_severity: "warning",
  event_evaluation_enabled: true,
  notify_on_critical: true,
  history_retention_days: 730,
  duplicate_threshold: 0.85,
});

// Domain events published by this service (registered idempotently on boot).
export const GOVERNANCE_EVENT_TYPES = Object.freeze([
  { code: "DataDomainCreated", description: "A data governance domain was created." },
  { code: "DataDomainChanged", description: "A data governance domain was changed." },
  { code: "DataOwnershipChanged", description: "A data owner or steward assignment changed." },
  { code: "DataPolicyCreated", description: "A data policy was created." },
  { code: "DataPolicyChanged", description: "A data policy version was changed." },
  { code: "DataPolicyActivated", description: "A data policy was activated." },
  { code: "DataPolicyRetired", description: "A data policy was retired." },
  { code: "DataQualityRuleCreated", description: "A data quality rule was created." },
  { code: "DataQualityRuleChanged", description: "A data quality rule was changed." },
  { code: "DataQualityRuleActivated", description: "A data quality rule was activated." },
  { code: "DataQualityRuleDeactivated", description: "A data quality rule was deactivated." },
  { code: "DataQualityEvaluated", description: "An object was evaluated for data quality." },
  { code: "DataQualityViolationDetected", description: "A quality rule violation was detected." },
  { code: "DataQualityScoreChanged", description: "An object's quality score changed." },
  { code: "DataQualityExceptionCreated", description: "A data quality exception was created." },
  { code: "DataQualityExceptionChanged", description: "A data quality exception was updated." },
  { code: "DataQualityExceptionAssigned", description: "A data quality exception was assigned." },
  { code: "DataQualityExceptionResolved", description: "A data quality exception was resolved." },
  { code: "DataQualityExceptionClosed", description: "A data quality exception was closed." },
  { code: "DuplicateCandidateDetected", description: "A duplicate candidate was detected." },
  { code: "DuplicateCandidateResolved", description: "A duplicate candidate was resolved." },
  { code: "DataRemediationApplied", description: "A remedial change was applied to an object." },
]);

export const GOVERNANCE_HANDLER_CODES = Object.freeze({
  BATCH: "dataQuality.batch",
  SCHEDULED: "dataQuality.scheduled",
  DUPLICATES: "dataQuality.duplicates",
  MAINTENANCE: "dataQuality.maintenance",
  EVENT: "dataQuality.evaluateEvent",
});
