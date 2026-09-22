// Vocabulary, defaults and platform wiring codes for the centralized Data
// Lifecycle & Archival service. Everything an administrator can tune is data:
// states, transitions, tiers, retention bases, policy scopes, legal-hold
// statuses, job types and configuration defaults live here so a deployment can
// evolve without code changes. No retention period, object type or organization
// is ever hard-coded.

export const SOURCE_MODULE = "data-lifecycle";

// Lifecycle states (spec §3). Ordered from live to eliminated.
export const LIFECYCLE_STATES = ["ACTIVE", "INACTIVE", "ARCHIVED", "COLD_STORAGE", "PURGED"];

// Default state model. `system` rows are installed idempotently; tenants may add
// their own states. Flags are the capability matrix the rest of the service and
// the UI consult (spec §3).
export const DEFAULT_STATES = [
  {
    code: "ACTIVE",
    name: "Active",
    description: "Live business data that is in use.",
    sequence: 10,
    read_allowed: true,
    update_allowed: true,
    delete_allowed: true,
    restore_allowed: true,
    export_allowed: true,
    archive_eligible: false,
    purge_eligible: false,
  },
  {
    code: "INACTIVE",
    name: "Inactive",
    description: "Data no longer actively used but still online.",
    sequence: 20,
    read_allowed: true,
    update_allowed: false,
    delete_allowed: true,
    restore_allowed: true,
    export_allowed: true,
    archive_eligible: true,
    purge_eligible: false,
  },
  {
    code: "ARCHIVED",
    name: "Archived",
    description: "Business data moved to archive storage.",
    sequence: 30,
    read_allowed: true,
    update_allowed: false,
    delete_allowed: false,
    restore_allowed: true,
    export_allowed: true,
    archive_eligible: false,
    purge_eligible: false,
  },
  {
    code: "COLD_STORAGE",
    name: "Cold storage",
    description: "Long-term low-cost storage for archived data.",
    sequence: 40,
    read_allowed: true,
    update_allowed: false,
    delete_allowed: false,
    restore_allowed: true,
    export_allowed: false,
    archive_eligible: false,
    purge_eligible: true,
  },
  {
    code: "PURGED",
    name: "Purged",
    description: "Business data permanently removed. Restore is only possible through recovery.",
    sequence: 50,
    read_allowed: false,
    update_allowed: false,
    delete_allowed: false,
    restore_allowed: false,
    export_allowed: false,
    archive_eligible: false,
    purge_eligible: false,
  },
];

// Legal, policy-guarded transitions (spec §4). PURGED has no forward transition:
// recovery is a separate, explicit capability. Backward transitions are the
// "restore" edges.
export const DEFAULT_TRANSITIONS = [
  { from_state: "ACTIVE", to_state: "INACTIVE", action: "DEACTIVATE" },
  { from_state: "INACTIVE", to_state: "ACTIVE", action: "REACTIVATE" },
  { from_state: "INACTIVE", to_state: "ARCHIVED", action: "ARCHIVE" },
  { from_state: "ARCHIVED", to_state: "INACTIVE", action: "RESTORE" },
  { from_state: "ARCHIVED", to_state: "COLD_STORAGE", action: "COLD_STORAGE" },
  { from_state: "COLD_STORAGE", to_state: "ARCHIVED", action: "RESTORE" },
  { from_state: "COLD_STORAGE", to_state: "PURGED", action: "PURGE" },
];

// Lifecycle actions used across the API, history and security vocabulary.
export const LIFECYCLE_ACTIONS = [
  "VIEW_LIFECYCLE",
  "CHANGE_STATE",
  "ARCHIVE",
  "COLD_STORAGE",
  "RESTORE",
  "PURGE",
  "CREATE_LEGAL_HOLD",
  "RELEASE_LEGAL_HOLD",
  "MANAGE_POLICY",
  "EXECUTE_JOB",
];

// Logical data tiers (spec §8). Physical storage is a provider concern; the tier
// is a policy decision and may differ from lifecycle state.
export const DATA_TIERS = ["HOT", "WARM", "ARCHIVE", "COLD"];

export const DEFAULT_STATE_TIER_MAP = Object.freeze({
  ACTIVE: "HOT",
  INACTIVE: "WARM",
  ARCHIVED: "ARCHIVE",
  COLD_STORAGE: "COLD",
  PURGED: "COLD",
});

// Retention anchors (spec §5). Extensible: a module can contribute its own basis
// through registerRetentionBasis().
export const RETENTION_BASES = [
  "CREATED_DATE",
  "LAST_MODIFIED_DATE",
  "LAST_ACCESSED_DATE",
  "RELEASE_DATE",
  "COMPLETION_DATE",
  "LIFECYCLE_TRANSITION_DATE",
  "BUSINESS_EVENT_DATE",
];

// Deterministic policy resolution scopes (spec §7), most specific first.
export const POLICY_SCOPE_TYPES = ["OBJECT", "OBJECT_TYPE", "ORGANIZATION", "TENANT", "PLATFORM"];

export const POLICY_STATUSES = ["draft", "active", "suspended", "retired"];

// What the policy wants to happen at each stage.
export const POLICY_ACTIONS = ["NONE", "MARK_ELIGIBLE", "AUTOMATIC"];

export const ARCHIVE_PROVIDER_TYPES = ["DATABASE", "OBJECT_STORAGE", "CLOUD_ARCHIVE", "ON_PREMISE", "NETWORK", "EXTERNAL"];

export const LEGAL_HOLD_STATUSES = ["ACTIVE", "RELEASED", "CANCELLED", "EXPIRED"];

export const LEGAL_HOLD_SCOPE_TYPES = ["OBJECT", "OBJECT_TYPE", "OBJECT_SET", "ORGANIZATION", "PLANT", "CLASSIFICATION", "BUSINESS_DOMAIN"];

// Eligibility / dependency outcomes (spec §16, §19). Explainable, not boolean.
export const ELIGIBILITY_RESULTS = ["SAFE", "BLOCKED", "WARNING", "REQUIRES_REVIEW"];

export const DEPENDENCY_RESULTS = ["SAFE", "BLOCKED", "WARNING", "REQUIRES_REVIEW"];

export const RESTORE_CONFLICT_STRATEGIES = ["FAIL", "SKIP", "RENAME", "OVERWRITE_IF_UNCHANGED"];

export const ELIGIBILITY_ACTIONS = ["INACTIVE", "ARCHIVE", "COLD_STORAGE", "PURGE"];

// Reason codes surfaced to operators and the policy simulator.
export const ELIGIBILITY_REASONS = Object.freeze({
  RETENTION_NOT_EXPIRED: "RETENTION_NOT_EXPIRED",
  RETENTION_EXPIRED: "RETENTION_EXPIRED",
  LEGAL_HOLD_ACTIVE: "LEGAL_HOLD_ACTIVE",
  ACTIVE_DEPENDENCY: "ACTIVE_DEPENDENCY",
  QUALITY_GATE_BLOCKED: "QUALITY_GATE_BLOCKED",
  POLICY_BLOCKS_ACTION: "POLICY_BLOCKS_ACTION",
  POLICY_MISSING: "POLICY_MISSING",
  ALREADY_ARCHIVED: "ALREADY_ARCHIVED",
  STATE_NOT_ELIGIBLE: "STATE_NOT_ELIGIBLE",
  ARCHIVE_REQUIRED: "ARCHIVE_REQUIRED",
  ARCHIVE_MISSING: "ARCHIVE_MISSING",
  DEPENDENCY_WARNING: "DEPENDENCY_WARNING",
});

// Background job handler codes registered with the shared execution engine.
export const LIFECYCLE_HANDLER_CODES = Object.freeze({
  EVALUATION: "dataLifecycle.evaluation",
  ARCHIVE: "dataLifecycle.archive",
  COLD_STORAGE: "dataLifecycle.coldStorage",
  RESTORE: "dataLifecycle.restore",
  PURGE: "dataLifecycle.purge",
  RECOVERY: "dataLifecycle.recovery",
  MAINTENANCE: "dataLifecycle.maintenance",
});

// Job types added to the platform job registry (spec §21).
export const LIFECYCLE_JOB_TYPES = [
  {
    code: "LIFECYCLE_EVALUATION",
    name: "Lifecycle eligibility evaluation",
    description: "Evaluate lifecycle eligibility for business objects in batch and schedule follow-up work.",
    source_module: SOURCE_MODULE,
    handler: LIFECYCLE_HANDLER_CODES.EVALUATION,
    queues: ["default"],
    timeout_seconds: 1800,
    max_retries: 2,
    default_priority: "normal",
  },
  {
    code: "LIFECYCLE_ARCHIVE",
    name: "Lifecycle archive",
    description: "Archive eligible business objects to archive storage with integrity validation.",
    source_module: SOURCE_MODULE,
    handler: LIFECYCLE_HANDLER_CODES.ARCHIVE,
    queues: ["default"],
    timeout_seconds: 3600,
    max_retries: 3,
    default_priority: "normal",
  },
  {
    code: "LIFECYCLE_COLD_STORAGE",
    name: "Lifecycle cold storage",
    description: "Move archived objects to cold storage according to policy.",
    source_module: SOURCE_MODULE,
    handler: LIFECYCLE_HANDLER_CODES.COLD_STORAGE,
    queues: ["default"],
    timeout_seconds: 3600,
    max_retries: 3,
    default_priority: "low",
  },
  {
    code: "LIFECYCLE_RESTORE",
    name: "Lifecycle restore",
    description: "Restore archived or cold-storage objects back to active storage.",
    source_module: SOURCE_MODULE,
    handler: LIFECYCLE_HANDLER_CODES.RESTORE,
    queues: ["default"],
    timeout_seconds: 3600,
    max_retries: 2,
    default_priority: "high",
  },
  {
    code: "LIFECYCLE_PURGE",
    name: "Lifecycle purge",
    description: "Permanently delete eligible business objects after all guards pass.",
    source_module: SOURCE_MODULE,
    handler: LIFECYCLE_HANDLER_CODES.PURGE,
    queues: ["default"],
    timeout_seconds: 3600,
    max_retries: 0,
    default_priority: "high",
  },
  {
    code: "LIFECYCLE_RECOVERY",
    name: "Lifecycle recovery",
    description: "Recover business data from an archive/recovery point after failure or storage loss.",
    source_module: SOURCE_MODULE,
    handler: LIFECYCLE_HANDLER_CODES.RECOVERY,
    queues: ["default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "high",
  },
  {
    code: "LIFECYCLE_MAINTENANCE",
    name: "Lifecycle maintenance",
    description: "Expire legal holds, converge lifecycle dates and reconcile archive integrity.",
    source_module: SOURCE_MODULE,
    handler: LIFECYCLE_HANDLER_CODES.MAINTENANCE,
    queues: ["default"],
    timeout_seconds: 1800,
    max_retries: 1,
    default_priority: "low",
  },
];

// Domain events published by the service (spec §34). Consumed events are the
// platform's existing Object*/Relationship* catalogue; the service subscribes to
// them in foundation.js.
export const LIFECYCLE_EVENT_TYPES = [
  { code: "ObjectBecameInactive", description: "A business object became inactive." },
  { code: "ObjectLifecycleChanged", description: "A business object changed lifecycle state." },
  { code: "ObjectArchiveStarted", description: "Archiving started for a business object." },
  { code: "ObjectArchived", description: "A business object was archived." },
  { code: "ObjectMovedToColdStorage", description: "An archived object moved to cold storage." },
  { code: "ObjectRestoreStarted", description: "Restoring started for an archived object." },
  { code: "ObjectRestored", description: "An archived object was restored." },
  { code: "ObjectPurgeStarted", description: "Purging started for an object." },
  { code: "ObjectPurged", description: "A business object was permanently purged." },
  { code: "LegalHoldCreated", description: "A legal hold was created." },
  { code: "LegalHoldReleased", description: "A legal hold was released." },
  { code: "RetentionPolicyChanged", description: "A retention policy was created or changed." },
  { code: "LifecycleEvaluationCompleted", description: "A lifecycle evaluation run completed." },
  { code: "LifecycleOperationFailed", description: "A lifecycle operation failed." },
];

// Tenant configuration defaults. Bounds are values, never constants in code.
export const CONFIG_DEFAULTS = Object.freeze({
  default_retention_days: 3650,
  default_data_tier: "HOT",
  archive_eligible_state: "INACTIVE",
  cold_storage_after_days: 1095,
  purge_after_days: 3650,
  max_batch_size: 500,
  legal_hold_auto_expire: true,
  quality_gate_enabled: false,
  quality_min_score: 60,
  quality_block_statuses: ["CRITICAL"],
  archive_requires_quality: false,
  search_archived: true,
  archive_provider: "database",
  recovery_provider: "database",
  purge_requires_archive: true,
  retention_evaluation_days: 1,
});

// IAM permission resources. Roles are configured through IAM, never hard-coded.
export const LIFECYCLE_RESOURCES = Object.freeze({
  module: "iam.data_lifecycle",
  overview: "iam.data_lifecycle.overview",
  states: "iam.data_lifecycle.states",
  policies: "iam.data_lifecycle.policies",
  objects: "iam.data_lifecycle.objects",
  eligibility: "iam.data_lifecycle.eligibility",
  archive: "iam.data_lifecycle.archive",
  restore: "iam.data_lifecycle.restore",
  recovery: "iam.data_lifecycle.recovery",
  purge: "iam.data_lifecycle.purge",
  legalHolds: "iam.data_lifecycle.legal_holds",
  dependencies: "iam.data_lifecycle.dependencies",
  jobs: "iam.data_lifecycle.jobs",
  metrics: "iam.data_lifecycle.metrics",
  admin: "iam.data_lifecycle.admin",
});

// The security actions the service enforces (spec §32). Exposed as a vocabulary
// so the UI and authorization inspectors stay in sync.
export const SECURITY_ACTIONS = [
  "VIEW_LIFECYCLE",
  "CHANGE_STATE",
  "ARCHIVE",
  "RESTORE",
  "PURGE",
  "CREATE_LEGAL_HOLD",
  "RELEASE_LEGAL_HOLD",
  "MANAGE_POLICY",
  "EXECUTE_JOB",
];

export const DAY_MS = 24 * 60 * 60 * 1000;

export const MAX_POLICY_PRIORITY = 1000;
export const MAX_BATCH_OBJECTS = 5000;
