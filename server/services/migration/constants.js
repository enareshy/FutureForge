// Vocabulary, defaults and platform wiring codes for the Migration & Onboarding
// Framework.
//
// This is a first-class platform capability, separate from the routine
// Import & Export Framework: it orchestrates one-time / controlled onboarding of
// large historical datasets from legacy systems. Everything an administrator can
// tune is data — adapter types, statuses, duplicate strategies, dependency
// strategies, error strategies, reconciliation strategies, job types, event
// types and IAM resources. No source system, object type or endpoint is
// hard-coded into the engine.

export const SOURCE_MODULE = "migration";

// ── Projects ─────────────────────────────────────────────────────────────────

export const PROJECT_STATUSES = [
  "DRAFT",
  "PLANNED",
  "READY",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "CANCELLED",
  "ARCHIVED",
];

// ── Packages ─────────────────────────────────────────────────────────────────

export const PACKAGE_STATUSES = [
  "DRAFT",
  "READY",
  "BLOCKED",
  "RUNNING",
  "PAUSED",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "CANCELLED",
];

// ── Definitions ──────────────────────────────────────────────────────────────

export const DEFINITION_STATUSES = ["DRAFT", "ACTIVE", "INACTIVE", "DEPRECATED"];

// ── Execution ────────────────────────────────────────────────────────────────

export const EXECUTION_MODES = ["DRY_RUN", "EXECUTE", "VALIDATE"];

export const JOB_STATUSES = [
  "QUEUED",
  "PREPARING",
  "VALIDATING",
  "RUNNING",
  "PAUSED",
  "RETRYING",
  "RECONCILING",
  "COMPLETED",
  "PARTIALLY_COMPLETED",
  "FAILED",
  "CANCELLED",
];

export const BATCH_STATUSES = ["RUNNING", "COMPLETED", "FAILED", "PARTIAL"];

// ── Duplicates ───────────────────────────────────────────────────────────────

export const DUPLICATE_STRATEGIES = ["REJECT", "SKIP", "UPDATE", "UPSERT", "CREATE_NEW", "MERGE"];

export const DUPLICATE_KEY_TYPES = ["BUSINESS_KEY", "OBJECT_ID", "EXTERNAL_REFERENCE", "UNIQUE_FIELDS", "SOURCE_EXTERNAL_ID"];

export const ERROR_STRATEGIES = ["CONTINUE", "STOP_ON_ERROR", "ROLLBACK_BATCH"];

// ── Dependencies ─────────────────────────────────────────────────────────────

// STRICT blocks execution until every dependency is satisfied; WARN records the
// gap but allows a plan; IGNORE treats the dependency as advisory only.
export const DEPENDENCY_STRATEGIES = ["STRICT", "WARN", "IGNORE"];

export const DEPENDENCY_TYPES = ["PACKAGE", "OBJECT", "RELATIONSHIP", "REFERENCE", "FILE", "EXTERNAL"];

export const DEPENDENCY_STATUSES = ["pending", "satisfied", "missing", "circular"];

export const PLAN_STATUSES = ["DRAFT", "READY", "BLOCKED", "APPROVED", "RUNNING", "COMPLETED", "FAILED"];

export const PLAN_STEP_STATUSES = ["pending", "ready", "blocked", "running", "completed", "failed", "skipped"];

export const READINESS_STATES = ["ready", "blocked", "warning", "unknown"];

// ── Reconciliation ───────────────────────────────────────────────────────────

export const RECONCILIATION_STRATEGIES = ["COUNT", "KEY", "FIELD", "SOURCE_TO_TARGET", "TARGET_TO_SOURCE"];

export const RECONCILIATION_STATUSES = ["PENDING", "COMPLETED", "VARIANCE", "FAILED"];

export const RECONCILIATION_EXCEPTION_TYPES = [
  "SOURCE_MISSING",
  "TARGET_MISSING",
  "FIELD_MISMATCH",
  "DUPLICATE_TARGET",
  "UNEXPECTED_TARGET",
  "COUNT_VARIANCE",
];

// ── Source adapters (spec §5, §7) ────────────────────────────────────────────

// Legacy systems named by the specification are first-class adapter types.
export const SOURCE_ADAPTER_TYPES = [
  "DATABASE",
  "FILE",
  "REST",
  "OBJECT_STORAGE",
  "LEGACY_TEAMCENTER",
  "LEGACY_PLM",
  "PDM",
  "ERP",
  "MES",
  "CUSTOM",
];

export const SOURCE_ADAPTER_CAPABILITIES = ["READ", "STREAMING", "INCREMENTAL", "SCHEMA_DISCOVERY", "BINARY_FILES", "PAGINATION"];

// Extraction scopes (spec §8).
export const MIGRATION_SCOPES = ["FULL", "INCREMENTAL", "DELTA", "SUBSET"];

// ── Pipeline stages (spec §2) ────────────────────────────────────────────────

export const PIPELINE_STAGES = [
  "PACKAGE",
  "EXTRACT",
  "MAP",
  "TRANSFORM",
  "VALIDATE",
  "DEPENDENCY",
  "EXECUTE",
  "RECONCILE",
  "AUDIT",
];

export const ERROR_CATEGORIES = [
  "SOURCE_ERROR",
  "MAPPING_ERROR",
  "TRANSFORMATION_ERROR",
  "VALIDATION_ERROR",
  "DEPENDENCY_ERROR",
  "DUPLICATE_ERROR",
  "RELATIONSHIP_ERROR",
  "FILE_ERROR",
  "SECURITY_ERROR",
  "TARGET_ERROR",
  "SYSTEM_ERROR",
];

export const ERROR_TYPES = ["RECORD", "BATCH", "CONNECTOR", "DEPENDENCY", "FILE", "SYSTEM"];

export const ERROR_STATUSES = ["OPEN", "RETRYING", "RESOLVED", "IGNORED", "REJECTED"];

export const RETRY_STRATEGIES = ["MANUAL", "AUTOMATIC", "SCHEDULED"];

export const IDENTIFIER_STATUSES = ["MAPPED", "PENDING", "MISSING", "REJECTED"];

export const RELATIONSHIP_STATUSES = ["MAPPED", "MISSING", "SKIPPED", "FAILED"];

export const FILE_MIGRATION_STATUSES = ["PENDING", "MIGRATED", "FAILED", "SKIPPED"];

// ── Background job handlers ──────────────────────────────────────────────────

export const MIGRATION_HANDLER_CODES = Object.freeze({
  EXECUTE: "migration.execute",
  VALIDATE: "migration.validate",
  RECONCILE: "migration.reconcile",
  RETRY_FAILED: "migration.retryFailed",
  REPLAN: "migration.replan",
  MAINTENANCE: "migration.maintenance",
});

// Job types registered with the shared Job Scheduling & Execution Engine. The
// execution engine treats each package as an independent, resumable work item.
export const MIGRATION_JOB_TYPES = [
  {
    code: "DATA_MIGRATION",
    name: "Data migration execution",
    description: "Execute a migration package: extract, map, transform, validate, resolve dependencies and write.",
    source_module: SOURCE_MODULE,
    handler: MIGRATION_HANDLER_CODES.EXECUTE,
    queues: ["migrations", "default"],
    timeout_seconds: 28800,
    max_retries: 2,
    default_priority: "normal",
  },
  {
    code: "DATA_MIGRATION_VALIDATE",
    name: "Data migration validation",
    description: "Validate a migration package without writing business data.",
    source_module: SOURCE_MODULE,
    handler: MIGRATION_HANDLER_CODES.VALIDATE,
    queues: ["migrations", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "DATA_MIGRATION_RECONCILE",
    name: "Data migration reconciliation",
    description: "Reconcile a migration job against the source and emit an exception report.",
    source_module: SOURCE_MODULE,
    handler: MIGRATION_HANDLER_CODES.RECONCILE,
    queues: ["default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "DATA_MIGRATION_RETRY",
    name: "Data migration retry",
    description: "Retry retryable failed records for a migration job.",
    source_module: SOURCE_MODULE,
    handler: MIGRATION_HANDLER_CODES.RETRY_FAILED,
    queues: ["migrations", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "high",
  },
  {
    code: "DATA_MIGRATION_REPLAN",
    name: "Data migration replan",
    description: "Recompute the dependency-aware execution plan for a migration project.",
    source_module: SOURCE_MODULE,
    handler: MIGRATION_HANDLER_CODES.REPLAN,
    queues: ["default"],
    timeout_seconds: 1800,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "DATA_MIGRATION_MAINTENANCE",
    name: "Data migration maintenance",
    description: "Prune stale checkpoints, resolve identifier mappings and recompute statistics.",
    source_module: SOURCE_MODULE,
    handler: MIGRATION_HANDLER_CODES.MAINTENANCE,
    queues: ["default"],
    timeout_seconds: 1800,
    max_retries: 1,
    default_priority: "low",
  },
];

// ── Domain events ────────────────────────────────────────────────────────────

export const MIGRATION_EVENT_TYPES = [
  { code: "MigrationStarted", description: "A migration project or package started executing." },
  { code: "MigrationCompleted", description: "A migration job completed successfully." },
  { code: "MigrationPartiallyCompleted", description: "A migration job completed with failures." },
  { code: "MigrationFailed", description: "A migration job failed." },
  { code: "MigrationCancelled", description: "A migration job was cancelled." },
  { code: "MigrationPaused", description: "A migration job was paused." },
  { code: "MigrationResumed", description: "A migration job was resumed." },
  { code: "MigrationCheckpointReached", description: "A migration checkpoint was written." },
  { code: "MigrationReconciled", description: "A migration reconciliation completed." },
  { code: "MigrationDependencyResolved", description: "A migration dependency was satisfied or found missing." },
  { code: "MigrationIdentifierMapped", description: "A source identifier was mapped to a target object." },
  { code: "MigrationPackageCompleted", description: "A migration package completed." },
  { code: "MigrationOperationFailed", description: "A migration operation failed and needs attention." },
];

// ── Tenant configuration ─────────────────────────────────────────────────────

export const CONFIG_DEFAULTS = Object.freeze({
  default_batch_size: 500,
  max_batch_size: 10000,
  default_duplicate_strategy: "REJECT",
  default_error_strategy: "CONTINUE",
  default_dependency_strategy: "STRICT",
  default_reconciliation_strategy: "COUNT",
  default_mode: "EXECUTE",
  preview_limit: 50,
  checkpoint_interval: 1000,
  max_retry_attempts: 3,
  retry_backoff_ms: 500,
  max_concurrent_packages: 4,
  reconciliation_tolerance: 0.005,
  lifecycle_guard_enabled: true,
  blocked_lifecycle_states: ["ARCHIVED", "COLD_STORAGE", "PURGED"],
  quality_gate_enabled: false,
  quality_min_score: 60,
  migrate_files: true,
  file_storage_provider: "database",
  adapter_timeout_seconds: 60,
  adapter_page_size: 1000,
  identifier_mapping_enabled: true,
  hash_chain_audit: true,
});

export const CONFIG_BOUNDS = Object.freeze({
  default_batch_size: { min: 1, max: 100000 },
  max_batch_size: { min: 1, max: 1000000 },
  preview_limit: { min: 1, max: 5000 },
  checkpoint_interval: { min: 1, max: 1000000 },
  max_retry_attempts: { min: 0, max: 20 },
  retry_backoff_ms: { min: 0, max: 60000 },
  max_concurrent_packages: { min: 1, max: 64 },
  reconciliation_tolerance: { min: 0, max: 1 },
  quality_min_score: { min: 0, max: 100 },
  adapter_timeout_seconds: { min: 1, max: 3600 },
  adapter_page_size: { min: 1, max: 100000 },
});

// ── IAM resources (spec §27) ─────────────────────────────────────────────────

export const MIGRATION_RESOURCES = Object.freeze({
  module: "iam.migration",
  overview: "iam.migration.overview",
  projects: "iam.migration.projects",
  packages: "iam.migration.packages",
  definitions: "iam.migration.definitions",
  sources: "iam.migration.sources",
  mapping: "iam.migration.mapping",
  validation: "iam.migration.validation",
  dependencies: "iam.migration.dependencies",
  planning: "iam.migration.planning",
  execution: "iam.migration.execution",
  reconciliation: "iam.migration.reconciliation",
  identifiers: "iam.migration.identifiers",
  relationships: "iam.migration.relationships",
  files: "iam.migration.files",
  auditTrail: "iam.migration.audit",
  statistics: "iam.migration.statistics",
  metrics: "iam.migration.metrics",
  admin: "iam.migration.admin",
});

export const SECURITY_ACTIONS = [
  "VIEW_PROJECT",
  "MANAGE_PROJECT",
  "MANAGE_PACKAGE",
  "MANAGE_DEFINITION",
  "MANAGE_SOURCE",
  "PLAN_MIGRATION",
  "EXECUTE_MIGRATION",
  "PAUSE_MIGRATION",
  "RETRY_MIGRATION",
  "RECONCILE_MIGRATION",
  "MANAGE_IDENTIFIER",
  "VIEW_AUDIT",
  "VIEW_ERRORS",
];

// ── Search integration ───────────────────────────────────────────────────────

export const SEARCH_OBJECT_TYPES = [
  { code: "migration_project", name: "Migration Project", description: "A legacy onboarding / migration project." },
  { code: "migration_package", name: "Migration Package", description: "A dependency-aware unit of migration work." },
  { code: "migration_job", name: "Migration Job", description: "A migration execution run." },
];

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_MAPPINGS = 2000;
export const MAX_CHILDREN = 5000;
