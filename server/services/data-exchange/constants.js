// Vocabulary, defaults and platform wiring codes for the centralized Import &
// Export Framework (the enterprise data-movement layer). Everything an
// administrator can tune is data: connector types, formats, mapping/
// transformation/validation types, duplicate strategies, execution modes,
// statuses, error codes, job types and IAM resources. No object type, format or
// endpoint is hard-coded into the engine.

export const SOURCE_MODULE = "data-exchange";

export const DIRECTIONS = ["IMPORT", "EXPORT"];

// Connector types (spec §3, §4). `FILE`/`CLOUD_STORAGE`/`LEGACY_PLM`/`ERP`/`CAD`/
// `MES` are extension points registered as adapters.
export const CONNECTOR_TYPES = [
  "CSV",
  "EXCEL",
  "JSON",
  "XML",
  "REST",
  "DATABASE",
  "FILE",
  "CLOUD_STORAGE",
  "LEGACY_PLM",
  "ERP",
  "CAD",
  "MES",
];

// Capabilities a connector may advertise (spec §4). The UI only offers
// operations the selected connector supports.
export const CONNECTOR_CAPABILITIES = ["READ", "WRITE", "PAGINATION", "TRANSACTION", "STREAMING", "SCHEMA_DISCOVERY", "INCREMENTAL"];

export const READ_ONLY_CAPABILITIES = ["READ"];

// Import definition lifecycle (spec §5).
export const DEFINITION_STATUSES = ["DRAFT", "ACTIVE", "INACTIVE", "DEPRECATED"];

// Import execution modes (spec §16).
export const EXECUTION_MODES = ["PREVIEW", "VALIDATE_ONLY", "IMPORT", "DRY_RUN"];

// Duplicate strategies (spec §15, §53).
export const DUPLICATE_STRATEGIES = ["REJECT", "SKIP", "UPDATE", "UPSERT", "CREATE_NEW", "MERGE"];

// Duplicate/idempotency key types (spec §15, §53).
export const DUPLICATE_KEY_TYPES = ["BUSINESS_KEY", "OBJECT_ID", "EXTERNAL_REFERENCE", "UNIQUE_FIELDS", "SOURCE_EXTERNAL_ID"];

export const ERROR_STRATEGIES = ["CONTINUE", "STOP_ON_ERROR", "ROLLBACK_BATCH"];

export const TRANSACTION_STRATEGIES = ["PER_RECORD", "PER_BATCH", "PER_JOB", "NONE"];

export const RECONCILIATION_STRATEGIES = ["COUNT", "KEY", "FIELD", "SOURCE_TO_TARGET", "TARGET_TO_SOURCE"];

export const RECONCILIATION_STATUSES = ["PENDING", "COMPLETED", "VARIANCE"];

// Job statuses (spec §23).
export const IMPORT_STATUSES = ["QUEUED", "RUNNING", "VALIDATING", "PREVIEW", "PAUSED", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED"];

export const EXPORT_STATUSES = ["QUEUED", "RUNNING", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED", "EXPIRED"];

// Mapping kinds (spec §8).
export const MAPPING_TYPES = [
  "DIRECT",
  "RENAME",
  "DEFAULT",
  "CONSTANT",
  "LOOKUP",
  "CONDITIONAL",
  "CONCAT",
  "SPLIT",
  "EXPRESSION",
  "NESTED",
  "ARRAY",
];

// Transformation kinds (spec §10).
export const TRANSFORMATION_TYPES = [
  "TRIM",
  "UPPERCASE",
  "LOWERCASE",
  "SUBSTRING",
  "REPLACE",
  "CONCAT",
  "SPLIT",
  "DATE_CONVERT",
  "UNIT_CONVERT",
  "LOOKUP",
  "DEFAULT",
  "EXPRESSION",
  "MASK",
];

export const TRANSFORMATION_STAGES = ["FILE", "RECORD", "FIELD"];

// Validation levels (spec §12).
export const VALIDATION_LEVELS = [
  "FILE",
  "SCHEMA",
  "MAPPING",
  "FIELD",
  "RECORD",
  "RELATIONSHIP",
  "BUSINESS",
  "SECURITY",
];

export const VALIDATION_SEVERITIES = ["ERROR", "WARNING", "INFO"];

// Structured validation/error statuses (spec §13, §19).
export const RECORD_STATUSES = ["SUCCESS", "WARNING", "ERROR", "SKIPPED", "FAILED"];

export const ERROR_TYPES = ["RECORD", "BATCH", "CONNECTOR", "MAPPING", "TRANSFORMATION", "VALIDATION", "BUSINESS", "SYSTEM"];

// Lookup match modes (spec §11).
export const LOOKUP_MATCH_MODES = ["EXACT", "CODE", "NAME", "EXTERNAL_REFERENCE", "CONFIGURED"];

// Export formats (spec §28). PDF/Parquet/API/Database are extension points.
export const EXPORT_FORMATS = ["CSV", "EXCEL", "JSON", "XML", "PDF", "PARQUET", "API", "DATABASE"];

// Import source formats.
export const IMPORT_FORMATS = ["CSV", "EXCEL", "JSON", "XML", "REST", "DATABASE", "FILE"];

// Export destinations (spec §29).
export const EXPORT_DESTINATIONS = ["DOWNLOAD", "FILE_STORAGE", "OBJECT_STORAGE", "REST_API", "DATABASE", "EXTERNAL_SYSTEM"];

export const EXPORT_RESULT_STATUSES = ["AVAILABLE", "EXPIRED", "DELETED"];

export const TEMPLATE_DIRECTIONS = ["IMPORT", "EXPORT"];

export const CONNECTOR_DIRECTIONS = ["SOURCE", "DESTINATION", "BOTH"];

// Filter types (spec §26).
export const EXPORT_FILTER_TYPES = ["ATTRIBUTE", "LIFECYCLE", "ORGANIZATION", "PLANT", "CLASSIFICATION", "DATE_RANGE", "STATUS", "OWNER", "SAVED_SEARCH"];

export const FILTER_OPERATORS = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "nin", "contains", "starts_with", "ends_with", "between", "exists"];

export const SORT_DIRECTIONS = ["asc", "desc"];

// Storage provider types for source files and export artifacts.
export const STORAGE_PROVIDER_TYPES = ["DATABASE", "FILE_STORAGE", "OBJECT_STORAGE", "EXTERNAL"];

// Background job handler codes registered with the shared execution engine.
export const EXCHANGE_HANDLER_CODES = Object.freeze({
  IMPORT: "dataExchange.import",
  VALIDATE: "dataExchange.validate",
  EXPORT: "dataExchange.export",
  RECONCILE: "dataExchange.reconcile",
  RETRY_FAILED: "dataExchange.retryFailed",
  MAINTENANCE: "dataExchange.maintenance",
});

// Job types added to the platform job registry (spec §33, §48).
export const EXCHANGE_JOB_TYPES = [
  {
    code: "DATA_IMPORT",
    name: "Data import execution",
    description: "Execute an import definition with mapping, transformation, validation and reconciliation.",
    source_module: SOURCE_MODULE,
    handler: EXCHANGE_HANDLER_CODES.IMPORT,
    queues: ["imports", "default"],
    timeout_seconds: 7200,
    max_retries: 2,
    default_priority: "normal",
  },
  {
    code: "DATA_IMPORT_VALIDATE",
    name: "Data import validation",
    description: "Validate an import source without changing business data.",
    source_module: SOURCE_MODULE,
    handler: EXCHANGE_HANDLER_CODES.VALIDATE,
    queues: ["imports", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "DATA_EXPORT",
    name: "Data export execution",
    description: "Query, security-filter, transform and serialize an export asynchronously.",
    source_module: SOURCE_MODULE,
    handler: EXCHANGE_HANDLER_CODES.EXPORT,
    queues: ["exports", "default"],
    timeout_seconds: 7200,
    max_retries: 2,
    default_priority: "normal",
  },
  {
    code: "DATA_RECONCILIATION",
    name: "Data reconciliation",
    description: "Reconcile an import/export job result set and persist a report.",
    source_module: SOURCE_MODULE,
    handler: EXCHANGE_HANDLER_CODES.RECONCILE,
    queues: ["default"],
    timeout_seconds: 1800,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "DATA_EXCHANGE_RETRY",
    name: "Data exchange retry",
    description: "Retry retryable failed records for an import job.",
    source_module: SOURCE_MODULE,
    handler: EXCHANGE_HANDLER_CODES.RETRY_FAILED,
    queues: ["imports", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "high",
  },
  {
    code: "DATA_EXCHANGE_MAINTENANCE",
    name: "Data exchange maintenance",
    description: "Expire export artifacts and prune stale import checkpoints/history.",
    source_module: SOURCE_MODULE,
    handler: EXCHANGE_HANDLER_CODES.MAINTENANCE,
    queues: ["default"],
    timeout_seconds: 1800,
    max_retries: 1,
    default_priority: "low",
  },
];

// Domain events published by the framework (spec §47).
export const EXCHANGE_EVENT_TYPES = [
  { code: "ImportStarted", description: "An import job started." },
  { code: "ImportCompleted", description: "An import job completed successfully." },
  { code: "ImportPartiallyCompleted", description: "An import job completed with failures." },
  { code: "ImportFailed", description: "An import job failed." },
  { code: "ImportCancelled", description: "An import job was cancelled." },
  { code: "ExportStarted", description: "An export job started." },
  { code: "ExportCompleted", description: "An export job completed." },
  { code: "ExportFailed", description: "An export job failed." },
  { code: "ExportCancelled", description: "An export job was cancelled." },
  { code: "ImportDefinitionCreated", description: "An import definition was created." },
  { code: "ImportDefinitionUpdated", description: "An import definition was changed." },
  { code: "ExportDefinitionCreated", description: "An export definition was created." },
  { code: "ExportDefinitionUpdated", description: "An export definition was changed." },
  { code: "DataExchangeOperationFailed", description: "A data-exchange operation failed and needs attention." },
];

// Tenant configuration defaults. Bounds are values, never code.
export const CONFIG_DEFAULTS = Object.freeze({
  default_batch_size: 500,
  max_batch_size: 5000,
  default_duplicate_strategy: "REJECT",
  default_error_strategy: "CONTINUE",
  default_transaction_strategy: "PER_BATCH",
  default_import_mode: "IMPORT",
  default_export_format: "CSV",
  default_destination: "DOWNLOAD",
  preview_limit: 50,
  sync_export_limit: 1000,
  export_expiry_days: 30,
  max_export_records: 1000000,
  checkpoint_interval: 1000,
  lookup_cache_size: 5000,
  quality_gate_enabled: false,
  quality_min_score: 60,
  lifecycle_guard_enabled: true,
  blocked_lifecycle_states: ["ARCHIVED", "COLD_STORAGE", "PURGED"],
  mask_output: true,
  storage_provider: "database",
  rest_rate_limit_per_second: 10,
  rest_concurrency: 4,
  rest_timeout_seconds: 30,
  rest_max_retries: 3,
});

// Administrative bounds for numeric configuration. Values are validated on write
// so an operator cannot disable the framework with an out-of-range number.
export const CONFIG_BOUNDS = Object.freeze({
  default_batch_size: { min: 1, max: 50000 },
  max_batch_size: { min: 1, max: 100000 },
  preview_limit: { min: 1, max: 5000 },
  sync_export_limit: { min: 1, max: 100000 },
  export_expiry_days: { min: 0, max: 3650 },
  max_export_records: { min: 1, max: 100000000 },
  checkpoint_interval: { min: 1, max: 1000000 },
  lookup_cache_size: { min: 0, max: 1000000 },
  quality_min_score: { min: 0, max: 100 },
  rest_rate_limit_per_second: { min: 1, max: 10000 },
  rest_concurrency: { min: 1, max: 128 },
  rest_timeout_seconds: { min: 1, max: 600 },
  rest_max_retries: { min: 0, max: 20 },
});

// IAM permission resources. Roles are configured through IAM, never hard-coded.
export const EXCHANGE_RESOURCES = Object.freeze({
  module: "iam.data_exchange",
  overview: "iam.data_exchange.overview",
  imports: "iam.data_exchange.imports",
  importDefinitions: "iam.data_exchange.import_definitions",
  exports: "iam.data_exchange.exports",
  exportDefinitions: "iam.data_exchange.export_definitions",
  connectors: "iam.data_exchange.connectors",
  mapping: "iam.data_exchange.mapping",
  validation: "iam.data_exchange.validation",
  reconciliation: "iam.data_exchange.reconciliation",
  templates: "iam.data_exchange.templates",
  history: "iam.data_exchange.history",
  jobs: "iam.data_exchange.jobs",
  metrics: "iam.data_exchange.metrics",
  admin: "iam.data_exchange.admin",
});

// Security actions the framework enforces (spec §49). Never trust the client.
export const SECURITY_ACTIONS = [
  "VIEW_IMPORT",
  "MANAGE_IMPORT_DEFINITION",
  "EXECUTE_IMPORT",
  "VIEW_EXPORT",
  "MANAGE_EXPORT_DEFINITION",
  "EXECUTE_EXPORT",
  "DOWNLOAD_EXPORT",
  "MANAGE_CONNECTOR",
  "MANAGE_TEMPLATE",
  "VIEW_ERRORS",
  "EXECUTE_JOB",
];

export const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_MAPPINGS = 2000;
export const MAX_FIELDS = 1000;
export const MAX_FILTERS = 200;
