// Single source of truth for the Module 21 Data Observability vocabulary.
//
// Observability is a platform layer: it defines how platform telemetry is
// described, evaluated and alerted on, but it never becomes a source of truth
// for business data. Every configurable value (providers, signal categories,
// health statuses, alert lifecycle, SLO/SLA semantics, IAM resources, job and
// event codes) lives here so the API and the collection engine stay declarative.
export const SOURCE_MODULE = "observability";

// ── Signal categories (§ Data volume / freshness / quality / failures) ──────
export const SIGNAL_CATEGORIES = Object.freeze([
  "DATA_VOLUME",
  "FRESHNESS",
  "QUALITY",
  "API",
  "IMPORT",
  "EXPORT",
  "SEARCH",
  "EVENT",
  "WORKFLOW",
  "INTEGRATION",
  "JOB",
  "LATENCY",
  "THROUGHPUT",
  "ERROR_RATE",
  "AVAILABILITY",
  "SLA",
]);

export const METRIC_STATUSES = Object.freeze(["DRAFT", "ACTIVE", "DEPRECATED", "ARCHIVED"]);
export const IMMUTABLE_STATUSES = Object.freeze(["ACTIVE", "DEPRECATED", "ARCHIVED"]);
export const CONFIGURABLE_STATUSES = Object.freeze(["DRAFT", "ACTIVE", "PAUSED", "ARCHIVED"]);

export const CALCULATIONS = Object.freeze(["COUNT", "SUM", "AVG", "MIN", "MAX", "RATE", "PERCENT", "RATIO", "LATENCY", "DURATION"]);
export const AGGREGATIONS = Object.freeze(["LAST", "AVG", "MIN", "MAX", "SUM", "COUNT"]);
export const METRIC_UNITS = Object.freeze(["COUNT", "PERCENT", "RATIO", "DURATION", "BYTES", "NUMBER"]);

// Direction of "worse": an increase in the metric is bad (HIGHER_IS_WORSE) or a
// decrease is bad (LOWER_IS_WORSE). Used to default thresholds and SLO checks.
export const METRIC_DIRECTIONS = Object.freeze(["HIGHER_IS_WORSE", "LOWER_IS_WORSE"]);
export const THRESHOLD_OPERATORS = Object.freeze(["GT", "GTE", "LT", "LTE", "EQ", "NEQ"]);
export const THRESHOLD_DIRECTIONS = Object.freeze(["INCREASING", "DECREASING", "BOTH"]);

// ── Health & availability ───────────────────────────────────────────────────
export const HEALTH_STATUSES = Object.freeze(["HEALTHY", "WARNING", "DEGRADED", "CRITICAL", "UNKNOWN", "MAINTENANCE"]);
export const HEALTH_RANK = Object.freeze({ HEALTHY: 0, MAINTENANCE: 0, UNKNOWN: 1, WARNING: 2, DEGRADED: 3, CRITICAL: 4 });
export const HEALTH_SCOPES = Object.freeze(["PLATFORM", "MODULE", "SERVICE", "ASSET", "COMPONENT"]);
export const HEALTH_CHECK_TYPES = Object.freeze(["THRESHOLD", "FRESHNESS", "AVAILABILITY", "CUSTOM"]);

// ── Alerting (§ severities, lifecycle, dedup/suppression/cooldown) ──────────
export const SEVERITIES = Object.freeze(["INFO", "WARNING", "HIGH", "CRITICAL"]);
export const SEVERITY_RANK = Object.freeze({ INFO: 0, WARNING: 1, HIGH: 2, CRITICAL: 3 });
export const ALERT_STATUSES = Object.freeze(["OPEN", "ACKNOWLEDGED", "SUPPRESSED", "RESOLVED", "CLOSED"]);
export const ALERT_OPEN_STATUSES = Object.freeze(["OPEN", "ACKNOWLEDGED", "SUPPRESSED"]);
export const ALERT_TERMINAL_STATUSES = Object.freeze(["RESOLVED", "CLOSED"]);
export const ALERT_EVENT_TYPES = Object.freeze([
  "CREATED",
  "UPDATED",
  "ACKNOWLEDGED",
  "SUPPRESSED",
  "UNSUPPRESSED",
  "ESCALATED",
  "RESOLVED",
  "CLOSED",
  "INCIDENT_LINKED",
  "COMMENTED",
]);

// ── Incidents ───────────────────────────────────────────────────────────────
export const INCIDENT_STATUSES = Object.freeze(["OPEN", "ACKNOWLEDGED", "INVESTIGATING", "MITIGATED", "RESOLVED", "CLOSED"]);
export const INCIDENT_OPEN_STATUSES = Object.freeze(["OPEN", "ACKNOWLEDGED", "INVESTIGATING", "MITIGATED"]);

// ── SLO / SLA ───────────────────────────────────────────────────────────────
export const SLO_KINDS = Object.freeze(["SLO", "SLA"]);
export const SLO_COMPARISONS = Object.freeze(["LTE", "GTE", "LT", "GT"]);

// ── Data assets & freshness ─────────────────────────────────────────────────
export const ASSET_TYPES = Object.freeze(["TABLE", "DATASET", "VIEW", "STREAM", "FILE", "SERVICE", "INDEX"]);
export const FRESHNESS_STATUSES = Object.freeze(["FRESH", "WARNING", "STALE", "CRITICAL", "UNKNOWN"]);

// ── Providers: the platform seams observability reads from ──────────────────
// Each provider declares which signal categories it can serve and the
// operational tables it inspects. Providers are read-only adapters; they never
// mutate the owning module.
export const PROVIDER_CATALOG = Object.freeze([
  {
    code: "OBJECT_MODEL",
    name: "Object model",
    description: "Business object volumes and recency from the shared object model.",
    module: "objects",
    categories: ["DATA_VOLUME", "FRESHNESS"],
    tables: ["objects"],
    status: "AVAILABLE",
  },
  {
    code: "PDM",
    name: "PDM / BOM",
    description: "Parts, CAD documents and bill-of-material volumes.",
    module: "pdm",
    categories: ["DATA_VOLUME", "FRESHNESS"],
    tables: ["pdm_items", "bom_lines"],
    status: "AVAILABLE",
  },
  {
    code: "FILE_STORAGE",
    name: "File & content storage",
    description: "Stored file and content-object volumes.",
    module: "files",
    categories: ["DATA_VOLUME", "FRESHNESS"],
    tables: ["files", "content_versions"],
    status: "AVAILABLE",
  },
  {
    code: "DATA_QUALITY",
    name: "Data quality",
    description: "Quality scores, violations and duplicate candidates from the Data Governance & Data Quality engine.",
    module: "data-governance",
    categories: ["QUALITY"],
    tables: ["dg_quality_results", "dg_quality_violations", "dg_duplicate_candidates"],
    status: "AVAILABLE",
  },
  {
    code: "SEARCH",
    name: "Search index",
    description: "Index coverage, pending updates and search activity.",
    module: "search",
    categories: ["SEARCH", "FRESHNESS", "DATA_VOLUME"],
    tables: ["search_index", "search_index_status", "search_history"],
    status: "AVAILABLE",
  },
  {
    code: "EVENTS",
    name: "Event & messaging",
    description: "Event throughput, delivery failures and dead letters.",
    module: "events",
    categories: ["EVENT", "THROUGHPUT", "ERROR_RATE", "LATENCY"],
    tables: ["event_records", "event_deliveries", "event_dead_letters", "event_outbox"],
    status: "AVAILABLE",
  },
  {
    code: "WORKFLOW",
    name: "Workflow engine",
    description: "Workflow instance volume, completion and overdue tasks.",
    module: "workflow",
    categories: ["WORKFLOW", "THROUGHPUT", "ERROR_RATE"],
    tables: ["workflow_instances", "workflow_tasks", "workflow_events"],
    status: "AVAILABLE",
  },
  {
    code: "JOBS",
    name: "Job engine",
    description: "Background job throughput, failures and queue backlog.",
    module: "jobs",
    categories: ["JOB", "THROUGHPUT", "ERROR_RATE", "LATENCY"],
    tables: ["jobs", "job_history", "job_dead_letters", "job_schedules"],
    status: "AVAILABLE",
  },
  {
    code: "INTEGRATION",
    name: "Integration & API",
    description: "Integration execution and API usage/failure telemetry.",
    module: "integration",
    categories: ["INTEGRATION", "API", "THROUGHPUT", "ERROR_RATE", "AVAILABILITY", "LATENCY"],
    tables: ["integration_executions", "integration_messages", "integration_dead_letters", "integration_api_usage", "integration_health_checks"],
    status: "AVAILABLE",
  },
  {
    code: "IMPORT_EXPORT",
    name: "Import & export",
    description: "Bulk import/export volumes, failures and reconciliation.",
    module: "data-exchange",
    categories: ["IMPORT", "EXPORT", "THROUGHPUT", "ERROR_RATE"],
    tables: ["exchange_transactions", "exchange_errors", "ie_import_jobs", "ie_export_jobs", "ie_import_batches"],
    status: "AVAILABLE",
  },
  {
    code: "AUDIT",
    name: "Audit",
    description: "API request latency, failures and denied access from the audit trail.",
    module: "audit",
    categories: ["API", "LATENCY", "ERROR_RATE", "AVAILABILITY"],
    tables: ["audit_logs"],
    status: "AVAILABLE",
  },
  {
    code: "DATA_LIFECYCLE",
    name: "Data lifecycle",
    description: "Archive, restore and purge activity and their failures.",
    module: "data-lifecycle",
    categories: ["DATA_VOLUME", "THROUGHPUT", "ERROR_RATE"],
    tables: ["lc_archive_records", "lc_purge_records", "lc_lifecycle_jobs"],
    status: "AVAILABLE",
  },
  {
    code: "PLATFORM",
    name: "Platform service",
    description: "Synthetic availability checks for platform services.",
    module: "platform",
    categories: ["AVAILABILITY", "LATENCY"],
    tables: [],
    status: "AVAILABLE",
  },
]);

export function providerByCode(code) {
  return PROVIDER_CATALOG.find((entry) => entry.code === String(code || "").toUpperCase()) || null;
}

// ── Curated default metric catalogue (seeded per tenant) ────────────────────
// Every entry is realized by a provider, so no provider is duplicated.
export const METRIC_CATALOG = Object.freeze([
  { code: "OBJECT_VOLUME_TOTAL", name: "Total business objects", category: "DATA_VOLUME", provider: "OBJECT_MODEL", calculation: "COUNT", entity: "object", unit: "COUNT", direction: "HIGHER_IS_WORSE", frequency_seconds: 300, aggregation: "LAST" },
  { code: "OBJECT_VOLUME_CREATED_24H", name: "Objects created (24h)", category: "DATA_VOLUME", provider: "OBJECT_MODEL", calculation: "COUNT", entity: "object", unit: "COUNT", direction: "HIGHER_IS_WORSE", frequency_seconds: 300, aggregation: "SUM" },
  { code: "OBJECT_FRESHNESS_AGE", name: "Object model age", category: "FRESHNESS", provider: "OBJECT_MODEL", calculation: "DURATION", entity: "object", unit: "DURATION", direction: "HIGHER_IS_WORSE", frequency_seconds: 900, aggregation: "MAX", warning_threshold: 86400, critical_threshold: 604800 },
  { code: "PDM_VOLUME_TOTAL", name: "Total PDM items", category: "DATA_VOLUME", provider: "PDM", calculation: "COUNT", entity: "pdm_item", unit: "COUNT", direction: "HIGHER_IS_WORSE", frequency_seconds: 900, aggregation: "LAST" },
  { code: "BOM_LINE_VOLUME", name: "Total BOM lines", category: "DATA_VOLUME", provider: "PDM", calculation: "COUNT", entity: "bom_line", unit: "COUNT", direction: "HIGHER_IS_WORSE", frequency_seconds: 900, aggregation: "LAST" },
  { code: "FILE_STORAGE_VOLUME", name: "Stored files", category: "DATA_VOLUME", provider: "FILE_STORAGE", calculation: "COUNT", entity: "file", unit: "COUNT", direction: "HIGHER_IS_WORSE", frequency_seconds: 900, aggregation: "LAST" },
  { code: "DATA_QUALITY_SCORE", name: "Data quality score", category: "QUALITY", provider: "DATA_QUALITY", calculation: "AVG", entity: "quality_result", unit: "PERCENT", direction: "LOWER_IS_WORSE", frequency_seconds: 3600, aggregation: "AVG", warning_threshold: 90, critical_threshold: 75 },
  { code: "DATA_QUALITY_VIOLATIONS", name: "Open quality violations", category: "QUALITY", provider: "DATA_QUALITY", calculation: "COUNT", entity: "quality_violation", unit: "COUNT", direction: "HIGHER_IS_WORSE", frequency_seconds: 3600, aggregation: "LAST", warning_threshold: 25, critical_threshold: 100 },
  { code: "SEARCH_INDEX_COVERAGE", name: "Search index coverage", category: "SEARCH", provider: "SEARCH", calculation: "PERCENT", entity: "search_index", unit: "PERCENT", direction: "LOWER_IS_WORSE", frequency_seconds: 900, aggregation: "LAST", warning_threshold: 98, critical_threshold: 90 },
  { code: "SEARCH_ERROR_RATE", name: "Search failure rate", category: "SEARCH", provider: "SEARCH", calculation: "PERCENT", entity: "search_index", unit: "PERCENT", direction: "HIGHER_IS_WORSE", frequency_seconds: 900, aggregation: "AVG", warning_threshold: 1, critical_threshold: 5 },
  { code: "EVENT_THROUGHPUT", name: "Events published (24h)", category: "EVENT", provider: "EVENTS", calculation: "COUNT", entity: "event", unit: "COUNT", direction: "LOWER_IS_WORSE", frequency_seconds: 300, aggregation: "SUM" },
  { code: "EVENT_DELIVERY_FAILURES", name: "Event delivery failures (24h)", category: "ERROR_RATE", provider: "EVENTS", calculation: "COUNT", entity: "event_delivery", unit: "COUNT", direction: "HIGHER_IS_WORSE", frequency_seconds: 300, aggregation: "SUM", warning_threshold: 5, critical_threshold: 25 },
  { code: "EVENT_DEAD_LETTERS", name: "Event dead letters", category: "ERROR_RATE", provider: "EVENTS", calculation: "COUNT", entity: "event_dead_letter", unit: "COUNT", direction: "HIGHER_IS_WORSE", frequency_seconds: 300, aggregation: "LAST", warning_threshold: 1, critical_threshold: 10 },
  { code: "WORKFLOW_THROUGHPUT", name: "Workflow instances started (24h)", category: "WORKFLOW", provider: "WORKFLOW", calculation: "COUNT", entity: "workflow_instance", unit: "COUNT", direction: "LOWER_IS_WORSE", frequency_seconds: 900, aggregation: "SUM" },
  { code: "WORKFLOW_FAILURE_RATE", name: "Workflow failure rate", category: "ERROR_RATE", provider: "WORKFLOW", calculation: "PERCENT", entity: "workflow_instance", unit: "PERCENT", direction: "HIGHER_IS_WORSE", frequency_seconds: 900, aggregation: "AVG", warning_threshold: 5, critical_threshold: 15 },
  { code: "WORKFLOW_OVERDUE_TASKS", name: "Overdue workflow tasks", category: "WORKFLOW", provider: "WORKFLOW", calculation: "COUNT", entity: "workflow_task", unit: "COUNT", direction: "HIGHER_IS_WORSE", frequency_seconds: 900, aggregation: "LAST", warning_threshold: 10, critical_threshold: 50 },
  { code: "JOB_FAILURE_RATE", name: "Job failure rate", category: "JOB", provider: "JOBS", calculation: "PERCENT", entity: "job", unit: "PERCENT", direction: "HIGHER_IS_WORSE", frequency_seconds: 300, aggregation: "AVG", warning_threshold: 5, critical_threshold: 15 },
  { code: "JOB_THROUGHPUT", name: "Jobs completed (24h)", category: "JOB", provider: "JOBS", calculation: "COUNT", entity: "job", unit: "COUNT", direction: "LOWER_IS_WORSE", frequency_seconds: 300, aggregation: "SUM" },
  { code: "JOB_DEAD_LETTERS", name: "Job dead letters", category: "ERROR_RATE", provider: "JOBS", calculation: "COUNT", entity: "job_dead_letter", unit: "COUNT", direction: "HIGHER_IS_WORSE", frequency_seconds: 300, aggregation: "LAST", warning_threshold: 1, critical_threshold: 10 },
  { code: "JOB_LATENCY_P95", name: "Job latency (p95)", category: "LATENCY", provider: "JOBS", calculation: "LATENCY", entity: "job", unit: "DURATION", direction: "HIGHER_IS_WORSE", frequency_seconds: 900, aggregation: "AVG", warning_threshold: 600, critical_threshold: 1800 },
  { code: "INTEGRATION_FAILURE_RATE", name: "Integration failure rate", category: "INTEGRATION", provider: "INTEGRATION", calculation: "PERCENT", entity: "integration_execution", unit: "PERCENT", direction: "HIGHER_IS_WORSE", frequency_seconds: 900, aggregation: "AVG", warning_threshold: 5, critical_threshold: 15 },
  { code: "INTEGRATION_THROUGHPUT", name: "Integration executions (24h)", category: "INTEGRATION", provider: "INTEGRATION", calculation: "COUNT", entity: "integration_execution", unit: "COUNT", direction: "LOWER_IS_WORSE", frequency_seconds: 900, aggregation: "SUM" },
  { code: "INTEGRATION_DEAD_LETTERS", name: "Integration dead letters", category: "ERROR_RATE", provider: "INTEGRATION", calculation: "COUNT", entity: "integration_message", unit: "COUNT", direction: "HIGHER_IS_WORSE", frequency_seconds: 900, aggregation: "LAST", warning_threshold: 1, critical_threshold: 10 },
  { code: "API_ERROR_RATE", name: "API error rate", category: "API", provider: "AUDIT", calculation: "PERCENT", entity: "api_request", unit: "PERCENT", direction: "HIGHER_IS_WORSE", frequency_seconds: 300, aggregation: "AVG", warning_threshold: 2, critical_threshold: 10 },
  { code: "API_LATENCY_P95", name: "API latency (p95)", category: "LATENCY", provider: "AUDIT", calculation: "LATENCY", entity: "api_request", unit: "DURATION", direction: "HIGHER_IS_WORSE", frequency_seconds: 300, aggregation: "AVG", warning_threshold: 1000, critical_threshold: 3000 },
  { code: "API_AVAILABILITY", name: "API availability", category: "AVAILABILITY", provider: "AUDIT", calculation: "PERCENT", entity: "api_request", unit: "PERCENT", direction: "LOWER_IS_WORSE", frequency_seconds: 300, aggregation: "AVG", warning_threshold: 99.5, critical_threshold: 99 },
  { code: "IMPORT_FAILURE_RATE", name: "Import failure rate", category: "IMPORT", provider: "IMPORT_EXPORT", calculation: "PERCENT", entity: "import_job", unit: "PERCENT", direction: "HIGHER_IS_WORSE", frequency_seconds: 1800, aggregation: "AVG", warning_threshold: 5, critical_threshold: 15 },
  { code: "IMPORT_THROUGHPUT", name: "Records imported (24h)", category: "IMPORT", provider: "IMPORT_EXPORT", calculation: "COUNT", entity: "import_job", unit: "COUNT", direction: "LOWER_IS_WORSE", frequency_seconds: 1800, aggregation: "SUM" },
  { code: "EXPORT_THROUGHPUT", name: "Exports produced (24h)", category: "EXPORT", provider: "IMPORT_EXPORT", calculation: "COUNT", entity: "export_job", unit: "COUNT", direction: "LOWER_IS_WORSE", frequency_seconds: 1800, aggregation: "SUM" },
  { code: "EXCHANGE_FAILURE_RATE", name: "Exchange failure rate", category: "EXPORT", provider: "IMPORT_EXPORT", calculation: "PERCENT", entity: "exchange_transaction", unit: "PERCENT", direction: "HIGHER_IS_WORSE", frequency_seconds: 1800, aggregation: "AVG", warning_threshold: 5, critical_threshold: 15 },
  { code: "ARCHIVE_THROUGHPUT", name: "Archived records (24h)", category: "DATA_VOLUME", provider: "DATA_LIFECYCLE", calculation: "COUNT", entity: "archive_record", unit: "COUNT", direction: "LOWER_IS_WORSE", frequency_seconds: 3600, aggregation: "SUM" },
  { code: "PURGE_THROUGHPUT", name: "Purged records (24h)", category: "DATA_VOLUME", provider: "DATA_LIFECYCLE", calculation: "COUNT", entity: "purge_record", unit: "COUNT", direction: "LOWER_IS_WORSE", frequency_seconds: 3600, aggregation: "SUM" },
  { code: "SERVICE_AVAILABILITY", name: "Platform service availability", category: "AVAILABILITY", provider: "PLATFORM", calculation: "PERCENT", entity: "service", unit: "PERCENT", direction: "LOWER_IS_WORSE", frequency_seconds: 60, aggregation: "AVG", warning_threshold: 99.5, critical_threshold: 99 },
]);

// ── Curated freshness definitions (seeded per tenant) ───────────────────────
export const FRESHNESS_CATALOG = Object.freeze([
  { code: "OBJECT_MODEL", name: "Object model freshness", provider: "OBJECT_MODEL", table: "objects", asset: "OBJECTS", max_age_seconds: 86400, warn_age_seconds: 86400, critical_age_seconds: 604800 },
  { code: "SEARCH_INDEX", name: "Search index freshness", provider: "SEARCH", table: "search_index", asset: "SEARCH_INDEX", max_age_seconds: 3600, warn_age_seconds: 3600, critical_age_seconds: 86400 },
  { code: "EVENT_STREAM", name: "Event stream freshness", provider: "EVENTS", table: "event_records", asset: "EVENT_STREAM", max_age_seconds: 3600, warn_age_seconds: 3600, critical_age_seconds: 21600 },
  { code: "JOB_ENGINE", name: "Job engine freshness", provider: "JOBS", table: "jobs", asset: "JOB_ENGINE", max_age_seconds: 3600, warn_age_seconds: 3600, critical_age_seconds: 21600 },
  { code: "INTEGRATION_RUNS", name: "Integration run freshness", provider: "INTEGRATION", table: "integration_executions", asset: "INTEGRATION_RUNS", max_age_seconds: 86400, warn_age_seconds: 86400, critical_age_seconds: 259200 },
  { code: "DATA_QUALITY", name: "Data quality assessment freshness", provider: "DATA_QUALITY", table: "dg_quality_results", asset: "DATA_QUALITY", max_age_seconds: 86400, warn_age_seconds: 86400, critical_age_seconds: 604800 },
]);

// ── Curated alert rules (seeded per tenant) ─────────────────────────────────
export const ALERT_RULE_CATALOG = Object.freeze([
  { code: "OBJECT_MODEL_STALE", name: "Object model is stale", metric: "OBJECT_FRESHNESS_AGE", operator: "GT", value: 604800, severity: "HIGH", service: "objects", for_seconds: 0, cooldown_seconds: 3600, auto_resolve: true },
  { code: "QUALITY_SCORE_LOW", name: "Data quality score is low", metric: "DATA_QUALITY_SCORE", operator: "LT", value: 90, severity: "WARNING", service: "data-governance", for_seconds: 0, cooldown_seconds: 3600, auto_resolve: true },
  { code: "QUALITY_VIOLATIONS_HIGH", name: "Too many open quality violations", metric: "DATA_QUALITY_VIOLATIONS", operator: "GT", value: 100, severity: "HIGH", service: "data-governance", for_seconds: 0, cooldown_seconds: 1800, auto_resolve: true },
  { code: "SEARCH_COVERAGE_LOW", name: "Search index coverage is low", metric: "SEARCH_INDEX_COVERAGE", operator: "LT", value: 90, severity: "HIGH", service: "search", for_seconds: 0, cooldown_seconds: 1800, auto_resolve: true },
  { code: "EVENT_FAILURES_HIGH", name: "Elevated event delivery failures", metric: "EVENT_DELIVERY_FAILURES", operator: "GT", value: 25, severity: "HIGH", service: "events", for_seconds: 0, cooldown_seconds: 900, auto_resolve: true },
  { code: "EVENT_DEAD_LETTERS", name: "Event dead letters present", metric: "EVENT_DEAD_LETTERS", operator: "GT", value: 0, severity: "CRITICAL", service: "events", for_seconds: 0, cooldown_seconds: 600, auto_resolve: true },
  { code: "WORKFLOW_FAILURE_RATE_HIGH", name: "Workflow failure rate is high", metric: "WORKFLOW_FAILURE_RATE", operator: "GT", value: 15, severity: "WARNING", service: "workflow", for_seconds: 0, cooldown_seconds: 1800, auto_resolve: true },
  { code: "JOB_FAILURE_RATE_HIGH", name: "Job failure rate is high", metric: "JOB_FAILURE_RATE", operator: "GT", value: 15, severity: "HIGH", service: "jobs", for_seconds: 0, cooldown_seconds: 900, auto_resolve: true },
  { code: "JOB_DEAD_LETTERS", name: "Job dead letters present", metric: "JOB_DEAD_LETTERS", operator: "GT", value: 0, severity: "HIGH", service: "jobs", for_seconds: 0, cooldown_seconds: 600, auto_resolve: true },
  { code: "INTEGRATION_FAILURE_RATE_HIGH", name: "Integration failure rate is high", metric: "INTEGRATION_FAILURE_RATE", operator: "GT", value: 15, severity: "HIGH", service: "integration", for_seconds: 0, cooldown_seconds: 900, auto_resolve: true },
  { code: "API_ERROR_RATE_HIGH", name: "API error rate is high", metric: "API_ERROR_RATE", operator: "GT", value: 10, severity: "CRITICAL", service: "api", for_seconds: 0, cooldown_seconds: 600, auto_resolve: true },
  { code: "API_AVAILABILITY_LOW", name: "API availability degraded", metric: "API_AVAILABILITY", operator: "LT", value: 99, severity: "CRITICAL", service: "api", for_seconds: 0, cooldown_seconds: 600, auto_resolve: true },
  { code: "IMPORT_FAILURE_RATE_HIGH", name: "Import failure rate is high", metric: "IMPORT_FAILURE_RATE", operator: "GT", value: 15, severity: "WARNING", service: "data-exchange", for_seconds: 0, cooldown_seconds: 1800, auto_resolve: true },
]);

// ── Curated SLO/SLA definitions (seeded per tenant) ─────────────────────────
export const SLO_CATALOG = Object.freeze([
  { code: "API_AVAILABILITY_SLO", name: "API availability", kind: "SLO", metric: "API_AVAILABILITY", target: 99.5, comparison: "GTE", window_seconds: 86400, unit: "PERCENT" },
  { code: "API_LATENCY_SLO", name: "API p95 latency", kind: "SLO", metric: "API_LATENCY_P95", target: 1000, comparison: "LTE", window_seconds: 86400, unit: "DURATION" },
  { code: "OBJECT_FRESHNESS_SLO", name: "Object model freshness", kind: "SLO", metric: "OBJECT_FRESHNESS_AGE", target: 86400, comparison: "LTE", window_seconds: 604800, unit: "DURATION" },
  { code: "DATA_QUALITY_SLA", name: "Data quality score", kind: "SLA", metric: "DATA_QUALITY_SCORE", target: 90, comparison: "GTE", window_seconds: 2592000, unit: "PERCENT" },
]);

// ── Curated dashboards (seeded per tenant) ──────────────────────────────────
export const DASHBOARD_CATALOG = Object.freeze([
  {
    code: "OBSERVABILITY_OVERVIEW",
    name: "Platform Observability Overview",
    description: "End-to-end health of data volume, freshness, quality, pipelines and platform services.",
    scope: "PLATFORM",
    is_default: true,
    widgets: [
      { title: "Overall health", widget_type: "HEALTH_STATUS", visualization: "GAUGE" },
      { title: "Open alerts by severity", widget_type: "ALERT_SUMMARY", visualization: "BAR" },
      { title: "Data quality score", metric: "DATA_QUALITY_SCORE", widget_type: "METRIC_CARD", visualization: "GAUGE" },
      { title: "API error rate", metric: "API_ERROR_RATE", widget_type: "METRIC_TREND", visualization: "LINE" },
      { title: "Job failure rate", metric: "JOB_FAILURE_RATE", widget_type: "METRIC_TREND", visualization: "LINE" },
      { title: "Freshness status", widget_type: "FRESHNESS_SUMMARY", visualization: "TABLE" },
      { title: "SLO compliance", widget_type: "SLO_SUMMARY", visualization: "TABLE" },
    ],
  },
  {
    code: "DATA_PIPELINE_HEALTH",
    name: "Data Pipeline Health",
    description: "Import, export, event and integration pipeline throughput and failures.",
    scope: "MODULE",
    is_default: false,
    widgets: [
      { title: "Event throughput", metric: "EVENT_THROUGHPUT", widget_type: "METRIC_TREND", visualization: "LINE" },
      { title: "Event delivery failures", metric: "EVENT_DELIVERY_FAILURES", widget_type: "METRIC_TREND", visualization: "BAR" },
      { title: "Integration failure rate", metric: "INTEGRATION_FAILURE_RATE", widget_type: "METRIC_CARD", visualization: "GAUGE" },
      { title: "Import failure rate", metric: "IMPORT_FAILURE_RATE", widget_type: "METRIC_TREND", visualization: "TREND" },
      { title: "Recent incidents", widget_type: "INCIDENT_LIST", visualization: "TABLE" },
    ],
  },
]);

export const DEFAULT_DASHBOARD_CODE = "OBSERVABILITY_OVERVIEW";

// ── Background jobs ─────────────────────────────────────────────────────────
export const OBSERVABILITY_QUEUE = "observability";

export const OBSERVABILITY_HANDLER_CODES = Object.freeze({
  COLLECT: "observability.collect",
  FRESHNESS: "observability.freshness.check",
  HEALTH: "observability.health.check",
  SLO: "observability.slo.evaluate",
  MAINTENANCE: "observability.maintenance",
});

export const OBSERVABILITY_JOB_TYPES = [
  {
    code: "OBSERVABILITY_COLLECT",
    name: "Observability metric collection",
    description: "Collect metric observations from platform providers and evaluate thresholds.",
    source_module: SOURCE_MODULE,
    handler: OBSERVABILITY_HANDLER_CODES.COLLECT,
    queues: [OBSERVABILITY_QUEUE, "default"],
    timeout_seconds: 1800,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "OBSERVABILITY_FRESHNESS_CHECK",
    name: "Observability freshness check",
    description: "Evaluate data-asset freshness against configured age limits.",
    source_module: SOURCE_MODULE,
    handler: OBSERVABILITY_HANDLER_CODES.FRESHNESS,
    queues: [OBSERVABILITY_QUEUE, "default"],
    timeout_seconds: 900,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "OBSERVABILITY_HEALTH_CHECK",
    name: "Observability health check",
    description: "Compute platform/service health snapshots.",
    source_module: SOURCE_MODULE,
    handler: OBSERVABILITY_HANDLER_CODES.HEALTH,
    queues: [OBSERVABILITY_QUEUE, "default"],
    timeout_seconds: 900,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "OBSERVABILITY_SLO_EVALUATE",
    name: "Observability SLO/SLA evaluation",
    description: "Evaluate SLO/SLA compliance over rolling windows.",
    source_module: SOURCE_MODULE,
    handler: OBSERVABILITY_HANDLER_CODES.SLO,
    queues: [OBSERVABILITY_QUEUE, "default"],
    timeout_seconds: 900,
    max_retries: 1,
    default_priority: "low",
  },
  {
    code: "OBSERVABILITY_MAINTENANCE",
    name: "Observability maintenance",
    description: "Prune observability history, observations and resolved alerts per retention policy.",
    source_module: SOURCE_MODULE,
    handler: OBSERVABILITY_HANDLER_CODES.MAINTENANCE,
    queues: ["default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "low",
  },
];

// ── Domain events ───────────────────────────────────────────────────────────
export const OBSERVABILITY_EVENT_TYPES = [
  { code: "MetricThresholdBreached", description: "A metric crossed a configured threshold." },
  { code: "MetricObserved", description: "A metric observation was recorded." },
  { code: "HealthStatusChanged", description: "A service or asset health status changed." },
  { code: "AlertCreated", description: "A new observability alert was raised." },
  { code: "AlertAcknowledged", description: "An observability alert was acknowledged." },
  { code: "AlertResolved", description: "An observability alert was resolved." },
  { code: "IncidentCreated", description: "A new observability incident was opened." },
  { code: "IncidentResolved", description: "An observability incident was resolved." },
  { code: "SlaBreached", description: "An SLA target was breached." },
  { code: "SloBreached", description: "An SLO target was breached." },
];

export const OBSERVABILITY_EVENT_MAP = Object.freeze({
  THRESHOLD_BREACHED: "MetricThresholdBreached",
  METRIC_OBSERVED: "MetricObserved",
  HEALTH_CHANGED: "HealthStatusChanged",
  ALERT_CREATED: "AlertCreated",
  ALERT_ACKNOWLEDGED: "AlertAcknowledged",
  ALERT_RESOLVED: "AlertResolved",
  INCIDENT_CREATED: "IncidentCreated",
  INCIDENT_RESOLVED: "IncidentResolved",
  SLA_BREACHED: "SlaBreached",
  SLO_BREACHED: "SloBreached",
});

// ── IAM resources ───────────────────────────────────────────────────────────
export const OBSERVABILITY_RESOURCES = Object.freeze({
  module: "iam.observability",
  home: "iam.observability.home",
  overview: "iam.observability.overview",
  health: "iam.observability.health",
  metrics: "iam.observability.metrics",
  volume: "iam.observability.data_volume",
  freshness: "iam.observability.freshness",
  quality: "iam.observability.quality",
  pipelines: "iam.observability.pipelines",
  failures: "iam.observability.failures",
  alerts: "iam.observability.alerts",
  incidents: "iam.observability.incidents",
  slo: "iam.observability.slo",
  dashboards: "iam.observability.dashboards",
  providers: "iam.observability.providers",
  jobs: "iam.observability.jobs",
  history: "iam.observability.history",
  search: "iam.observability.search",
  audit: "iam.observability.audit",
  admin: "iam.observability.admin",
});

// ── Configuration ───────────────────────────────────────────────────────────
export const DEFAULT_COLLECTION_INTERVAL_SECONDS = 300;
export const DEFAULT_OBSERVATION_RETENTION_DAYS = 30;
export const MAX_WINDOW_SECONDS = 7776000;

export const CONFIG_DEFAULTS = Object.freeze({
  collection_interval_seconds: DEFAULT_COLLECTION_INTERVAL_SECONDS,
  enabled: true,
  auto_collect_on_seed: true,
  default_alert_severity: "WARNING",
  alert_cooldown_seconds: 300,
  alert_dedup_window_seconds: 3600,
  auto_create_incidents: true,
  incident_min_severity: "HIGH",
  notify_on_alerts: true,
  observation_retention_days: DEFAULT_OBSERVATION_RETENTION_DAYS,
  history_retention_days: 180,
  staleness_warning_ratio: 0.75,
  availability_target: 99.5,
  max_metrics_per_run: 500,
});

export const CONFIG_BOUNDS = Object.freeze({
  collection_interval_seconds: { min: 30, max: 86400 },
  alert_cooldown_seconds: { min: 0, max: 86400 },
  alert_dedup_window_seconds: { min: 0, max: 604800 },
  observation_retention_days: { min: 1, max: 3650 },
  history_retention_days: { min: 1, max: 3650 },
  staleness_warning_ratio: { min: 0.1, max: 1 },
  availability_target: { min: 0, max: 100 },
  max_metrics_per_run: { min: 1, max: 10000 },
});

export const DEFAULT_RETENTION_POLICIES = Object.freeze([
  { tier: "OBSERVATIONS", retain_days: 30 },
  { tier: "HEALTH_SNAPSHOTS", retain_days: 90 },
  { tier: "ALERTS", retain_days: 365 },
  { tier: "INCIDENTS", retain_days: 730 },
  { tier: "HISTORY", retain_days: 180 },
]);

// ── Search integration ───────────────────────────────────────────────────────
export const SEARCH_OBJECT_TYPES = [
  { code: "observability_metric", name: "Observability metric", description: "Observability metric definitions." },
  { code: "observability_alert", name: "Observability alert", description: "Active and historical observability alerts." },
  { code: "observability_incident", name: "Observability incident", description: "Observability incidents." },
  { code: "observability_dashboard", name: "Observability dashboard", description: "Observability dashboards and widgets." },
];

export const OBSERVABILITY_MODEL_VERSION = "1.0";
