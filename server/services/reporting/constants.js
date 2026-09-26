// Single source of truth for the Reporting & Analytics (Module 20) vocabulary.
//
// Everything configurable about the analytical layer (report types, data
// sources, semantic domains, operators, aggregations, visualization types,
// KPI/metric catalogues, limits, IAM resources, job/event codes and platform
// defaults) lives here so the query engine and the API never hard-code a
// business rule or a chart component.
export const SOURCE_MODULE = "reporting";

// ── Lifecycle vocabulary (§5, §11, §28) ─────────────────────────────────────
export const REPORT_STATUSES = Object.freeze(["DRAFT", "ACTIVE", "DEPRECATED", "ARCHIVED"]);
export const DASHBOARD_STATUSES = Object.freeze(["DRAFT", "ACTIVE", "DEPRECATED", "ARCHIVED"]);
export const METRIC_STATUSES = Object.freeze(["DRAFT", "ACTIVE", "DEPRECATED", "ARCHIVED"]);
export const KPI_STATUSES = Object.freeze(["DRAFT", "ACTIVE", "DEPRECATED", "ARCHIVED"]);
export const PUBLISHED_STATUS = Object.freeze("ACTIVE");
export const IMMUTABLE_STATUSES = Object.freeze(["ACTIVE", "DEPRECATED", "ARCHIVED"]);

export const REPORT_TYPES = Object.freeze(["TABULAR", "SUMMARY", "ANALYTICAL", "CROSS_DOMAIN"]);
export const DASHBOARD_WIDGET_TYPES = Object.freeze([
  "KPI_CARD",
  "TABLE",
  "BAR",
  "LINE",
  "AREA",
  "PIE",
  "DONUT",
  "SCATTER",
  "GAUGE",
  "TREND",
  "TEXT",
  "REPORT",
]);
export const VISUALIZATION_TYPES = Object.freeze([
  "TABLE",
  "KPI_CARD",
  "BAR",
  "LINE",
  "AREA",
  "PIE",
  "DONUT",
  "SCATTER",
  "GAUGE",
  "TREND",
]);

// ── Visibility (§16, §17, §18) ──────────────────────────────────────────────
export const VISIBILITY_SCOPES = Object.freeze(["PRIVATE", "GROUP", "ROLE", "ORGANIZATION", "PLANT", "SITE", "GLOBAL"]);
export const SUBJECT_TYPES = Object.freeze(["USER", "GROUP", "ROLE", "ORGANIZATION", "PLANT", "SITE", "ALL"]);

// ── Data sources (§8) ───────────────────────────────────────────────────────
export const DATA_SOURCE_CODES = Object.freeze(["OBJECT_MODEL", "SEARCH_INDEX", "REPORTING_READ_MODEL", "DATA_MART", "EXTERNAL_BI", "API"]);
export const DATA_SOURCE_STATUSES = Object.freeze(["AVAILABLE", "PLANNED", "UNSUPPORTED", "DISABLED"]);
export const DEFAULT_DATA_SOURCE = "OBJECT_MODEL";

// The controlled list of platform domains the analytical layer may report on.
// Reporting never gains a new source of truth; it reads these through the
// semantic layer and the owning platform services.
export const SUPPORTED_DOMAINS = Object.freeze([
  "PDM",
  "BOM",
  "Classification",
  "Engineering Change",
  "Requirements",
  "Manufacturing",
  "Quality",
  "Workflow",
  "Lifecycle",
  "Documents",
  "Projects",
  "Suppliers",
  "Organizations",
  "Users",
]);

// ── Query operators (§9) ────────────────────────────────────────────────────
export const OPERATORS = Object.freeze([
  "EQ",
  "NEQ",
  "GT",
  "GTE",
  "LT",
  "LTE",
  "IN",
  "NOT_IN",
  "CONTAINS",
  "STARTS_WITH",
  "ENDS_WITH",
  "IS_NULL",
  "IS_NOT_NULL",
  "BETWEEN",
]);
export const LOGICAL_OPERATORS = Object.freeze(["AND", "OR", "NOT"]);
export const FUTURE_OPERATORS = Object.freeze(["EXISTS", "RELATIONSHIP", "FULL_TEXT"]);
export const OPERATOR_SYMBOLS = Object.freeze({
  EQ: "=",
  NEQ: "!=",
  GT: ">",
  GTE: ">=",
  LT: "<",
  LTE: "<=",
  IN: "IN",
  NOT_IN: "NOT IN",
  CONTAINS: "CONTAINS",
  STARTS_WITH: "STARTS_WITH",
  ENDS_WITH: "ENDS_WITH",
  IS_NULL: "IS NULL",
  IS_NOT_NULL: "IS NOT NULL",
  BETWEEN: "BETWEEN",
});

// ── Aggregation framework (§10) ─────────────────────────────────────────────
export const AGGREGATIONS = Object.freeze(["COUNT", "COUNT_DISTINCT", "SUM", "AVG", "MIN", "MAX", "PERCENTAGE", "RATIO"]);
export const DERIVED_AGGREGATIONS = Object.freeze(["PERCENTAGE", "RATIO"]);

// ── Execution (§30) ─────────────────────────────────────────────────────────
export const EXECUTION_MODES = Object.freeze(["PREVIEW", "EXECUTE", "EXPORT", "SCHEDULED"]);
export const EXECUTION_STATUSES = Object.freeze(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]);
export const TERMINAL_EXECUTION_STATUSES = Object.freeze(["COMPLETED", "FAILED", "CANCELLED"]);

export const EXPORT_FORMATS = Object.freeze(["CSV", "JSON", "EXCEL", "PDF"]);
export const NATIVE_EXPORT_FORMATS = Object.freeze(["CSV", "JSON", "EXCEL"]);
export const EXPORT_STATUSES = Object.freeze(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]);
export const SCHEDULE_FREQUENCIES = Object.freeze(["ONCE", "HOURLY", "DAILY", "WEEKLY", "MONTHLY"]);
export const SCHEDULE_STATUSES = Object.freeze(["ACTIVE", "PAUSED", "COMPLETED", "FAILED", "CANCELLED"]);

export const JOB_STATUSES = Object.freeze(["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"]);

// ── KPI / metric vocabulary (§11) ───────────────────────────────────────────
export const KPI_DIRECTIONS = Object.freeze(["HIGHER_IS_BETTER", "LOWER_IS_BETTER"]);
export const KPI_THRESHOLD_TONES = Object.freeze(["OK", "WARNING", "CRITICAL"]);
export const METRIC_UNITS = Object.freeze(["COUNT", "PERCENT", "RATIO", "CURRENCY", "DURATION", "SCORE", "NUMBER"]);

// Business impact ranking used by the seed to order curated KPIs.
export const KPI_CATALOG = Object.freeze([
  {
    code: "TOTAL_OBJECTS",
    name: "Total business objects",
    description: "Count of every business object in scope (cross-domain).",
    entity: "object",
    aggregation: "COUNT",
    unit: "COUNT",
    direction: "HIGHER_IS_BETTER",
  },
  {
    code: "TOTAL_PARTS",
    name: "Total parts",
    description: "Count of all parts in scope.",
    entity: "part",
    aggregation: "COUNT",
    unit: "COUNT",
    direction: "HIGHER_IS_BETTER",
  },
  {
    code: "RELEASED_PARTS",
    name: "Released parts",
    description: "Count of parts whose lifecycle state is released.",
    entity: "part",
    aggregation: "COUNT",
    filters: [{ attribute: "lifecycle_state", operator: "EQ", value: "RELEASED" }],
    unit: "COUNT",
    direction: "HIGHER_IS_BETTER",
  },
  {
    code: "RELEASE_READINESS",
    name: "Release readiness",
    description: "Percentage of parts that are released.",
    entity: "part",
    aggregation: "COUNT",
    formula: "released / total * 100",
    metadata: {
      aggregations: [
        { function: "COUNT", attribute: null, alias: "total" },
        { function: "COUNT", attribute: null, alias: "released", filters: [{ attribute: "lifecycle_state", operator: "EQ", value: "RELEASED" }] },
      ],
    },
    unit: "PERCENT",
    direction: "HIGHER_IS_BETTER",
    target: 80,
    thresholds: { warning: 60, critical: 40 },
  },
  {
    code: "BOM_COMPLETENESS",
    name: "BOM completeness",
    description: "Average number of components per assembly.",
    entity: "part",
    aggregation: "AVG",
    attribute: "bom_component_count",
    unit: "NUMBER",
    direction: "HIGHER_IS_BETTER",
  },
  {
    code: "OPEN_CHANGES",
    name: "Open engineering changes",
    description: "Count of running engineering change workflows.",
    entity: "change",
    aggregation: "COUNT",
    unit: "COUNT",
    direction: "LOWER_IS_BETTER",
    target: 0,
  },
  {
    code: "DATA_QUALITY_SCORE",
    name: "Data quality score",
    description: "Enterprise data quality score reported by Data Governance.",
    entity: "quality",
    aggregation: "AVG",
    attribute: "score",
    unit: "SCORE",
    direction: "HIGHER_IS_BETTER",
    target: 95,
  },
]);

// ── Semantic layer (§22) ────────────────────────────────────────────────────
// Business entities are declared once and reused by reports, dashboards, KPIs
// and BI datasets. `source` selects the platform table the resolver reads;
// `object_type` narrows object-model entities to a registered object type.
export const SEMANTIC_ENTITIES = Object.freeze([
  {
    code: "part",
    name: "Part",
    domain: "PDM",
    source: "object",
    object_type: "part",
    description: "Engineering parts mastered in the object model.",
    attributes: [
      { code: "number", name: "Part number", type: "STRING", column: "code", filterable: true, groupable: true, sortable: true },
      { code: "name", name: "Name", type: "STRING", column: "name", filterable: true, groupable: true, sortable: true },
      { code: "description", name: "Description", type: "STRING", column: "description", filterable: true },
      { code: "status", name: "Status", type: "STRING", column: "status", filterable: true, groupable: true, sortable: true },
      { code: "lifecycle_state", name: "Lifecycle", type: "STRING", column: "status", filterable: true, groupable: true },
      { code: "revision", name: "Revision", type: "NUMBER", column: "revision", sortable: true },
      { code: "owner", name: "Owner", type: "STRING", column: "owner_id", filterable: true, groupable: true },
      { code: "organization", name: "Organization", type: "STRING", column: "organization_id", filterable: true, groupable: true },
      { code: "category", name: "Category", type: "STRING", json_path: "part.category", filterable: true, groupable: true },
      { code: "created_at", name: "Created", type: "DATE", column: "created_at", filterable: true, sortable: true },
      { code: "updated_at", name: "Updated", type: "DATE", column: "updated_at", filterable: true, sortable: true },
      { code: "bom_component_count", name: "BOM components", type: "NUMBER", derived: "bom_component_count", sortable: true },
      { code: "open_change_count", name: "Open changes", type: "NUMBER", derived: "open_change_count", sortable: true },
    ],
  },
  {
    code: "document",
    name: "Document",
    domain: "Documents",
    source: "object",
    object_type: "document",
    description: "Controlled documents and specifications.",
    attributes: [
      { code: "number", name: "Number", type: "STRING", column: "code", filterable: true, groupable: true, sortable: true },
      { code: "name", name: "Name", type: "STRING", column: "name", filterable: true, groupable: true, sortable: true },
      { code: "status", name: "Status", type: "STRING", column: "status", filterable: true, groupable: true, sortable: true },
      { code: "lifecycle_state", name: "Lifecycle", type: "STRING", column: "status", filterable: true, groupable: true },
      { code: "owner", name: "Owner", type: "STRING", column: "owner_id", filterable: true, groupable: true },
      { code: "organization", name: "Organization", type: "STRING", column: "organization_id", filterable: true, groupable: true },
      { code: "created_at", name: "Created", type: "DATE", column: "created_at", filterable: true, sortable: true },
    ],
  },
  {
    code: "change",
    name: "Engineering change",
    domain: "Engineering Change",
    source: "object",
    object_type: "change_request",
    description: "Engineering change requests and their disposition.",
    attributes: [
      { code: "number", name: "Number", type: "STRING", column: "code", filterable: true, groupable: true, sortable: true },
      { code: "name", name: "Title", type: "STRING", column: "name", filterable: true, groupable: true, sortable: true },
      { code: "status", name: "Status", type: "STRING", column: "status", filterable: true, groupable: true, sortable: true },
      { code: "lifecycle_state", name: "Lifecycle", type: "STRING", column: "status", filterable: true, groupable: true },
      { code: "owner", name: "Owner", type: "STRING", column: "owner_id", filterable: true, groupable: true },
      { code: "organization", name: "Organization", type: "STRING", column: "organization_id", filterable: true, groupable: true },
      { code: "created_at", name: "Created", type: "DATE", column: "created_at", filterable: true, sortable: true },
    ],
  },
  {
    code: "requirement",
    name: "Requirement",
    domain: "Requirements",
    source: "object",
    object_type: "requirement",
    description: "Product and system requirements.",
    attributes: [
      { code: "number", name: "Number", type: "STRING", column: "code", filterable: true, groupable: true, sortable: true },
      { code: "name", name: "Name", type: "STRING", column: "name", filterable: true, groupable: true, sortable: true },
      { code: "status", name: "Status", type: "STRING", column: "status", filterable: true, groupable: true, sortable: true },
      { code: "organization", name: "Organization", type: "STRING", column: "organization_id", filterable: true, groupable: true },
      { code: "created_at", name: "Created", type: "DATE", column: "created_at", filterable: true, sortable: true },
    ],
  },
  {
    code: "supplier",
    name: "Supplier",
    domain: "Suppliers",
    source: "object",
    object_type: "supplier",
    description: "Approved suppliers and sourcing entities.",
    attributes: [
      { code: "number", name: "Number", type: "STRING", column: "code", filterable: true, groupable: true, sortable: true },
      { code: "name", name: "Name", type: "STRING", column: "name", filterable: true, groupable: true, sortable: true },
      { code: "status", name: "Status", type: "STRING", column: "status", filterable: true, groupable: true, sortable: true },
      { code: "organization", name: "Organization", type: "STRING", column: "organization_id", filterable: true, groupable: true },
    ],
  },
  {
    code: "quality",
    name: "Quality record",
    domain: "Quality",
    source: "object",
    object_type: "quality_record",
    description: "Quality records mastered by the Quality domain (inspections, NCRs, CAPAs).",
    attributes: [
      { code: "number", name: "Number", type: "STRING", column: "code", filterable: true, groupable: true, sortable: true },
      { code: "name", name: "Name", type: "STRING", column: "name", filterable: true, groupable: true, sortable: true },
      { code: "status", name: "Status", type: "STRING", column: "status", filterable: true, groupable: true, sortable: true },
      { code: "score", name: "Score", type: "NUMBER", json_path: "quality.score", filterable: true, sortable: true },
      { code: "organization", name: "Organization", type: "STRING", column: "organization_id", filterable: true, groupable: true },
      { code: "created_at", name: "Created", type: "DATE", column: "created_at", filterable: true, sortable: true },
    ],
  },
  {
    code: "object",
    name: "Business object",
    domain: "Organizations",
    source: "object",
    object_type: null,
    description: "Every business object regardless of type (cross-domain reporting base).",
    attributes: [
      { code: "number", name: "Number", type: "STRING", column: "code", filterable: true, groupable: true, sortable: true },
      { code: "name", name: "Name", type: "STRING", column: "name", filterable: true, groupable: true, sortable: true },
      { code: "status", name: "Status", type: "STRING", column: "status", filterable: true, groupable: true, sortable: true },
      { code: "object_type", name: "Object type", type: "STRING", derived: "object_type", filterable: true, groupable: true, sortable: true },
      { code: "organization", name: "Organization", type: "STRING", column: "organization_id", filterable: true, groupable: true },
      { code: "created_at", name: "Created", type: "DATE", column: "created_at", filterable: true, sortable: true },
    ],
  },
  {
    code: "pdm_item",
    name: "PDM item",
    domain: "PDM",
    source: "pdm_item",
    description: "Items mastered by the PDM domain (parts, products, documents).",
    attributes: [
      { code: "number", name: "Item number", type: "STRING", column: "item_number", filterable: true, groupable: true, sortable: true },
      { code: "name", name: "Name", type: "STRING", column: "name", filterable: true, groupable: true, sortable: true },
      { code: "item_type", name: "Item type", type: "STRING", column: "item_type", filterable: true, groupable: true, sortable: true },
      { code: "status", name: "Status", type: "STRING", column: "status", filterable: true, groupable: true, sortable: true },
      { code: "lifecycle_state", name: "Lifecycle", type: "STRING", column: "lifecycle_state", filterable: true, groupable: true },
      { code: "classification", name: "Classification", type: "STRING", column: "classification_code", filterable: true, groupable: true },
      { code: "organization", name: "Organization", type: "STRING", column: "organization_id", filterable: true, groupable: true },
      { code: "created_at", name: "Created", type: "DATE", column: "created_at", filterable: true, sortable: true },
    ],
  },
  {
    code: "bom_component",
    name: "BOM component",
    domain: "BOM",
    source: "bom_line",
    description: "BOM lines (parent/child structure) mastered by the BOM engine.",
    attributes: [
      { code: "parent", name: "Parent", type: "STRING", column: "parent_object_id", filterable: true, groupable: true },
      { code: "child", name: "Child", type: "STRING", column: "child_object_id", filterable: true, groupable: true },
      { code: "quantity", name: "Quantity", type: "NUMBER", column: "quantity", filterable: true, sortable: true },
      { code: "uom", name: "UoM", type: "STRING", column: "uom", filterable: true, groupable: true },
      { code: "usage", name: "Usage", type: "STRING", column: "usage", filterable: true, groupable: true },
      { code: "line_status", name: "Line status", type: "STRING", column: "line_status", filterable: true, groupable: true },
      { code: "optional", name: "Optional", type: "STRING", column: "optional", filterable: true, groupable: true },
    ],
  },
  {
    code: "workflow_instance",
    name: "Workflow instance",
    domain: "Workflow",
    source: "workflow_instance",
    description: "Workflow instances and their status.",
    attributes: [
      { code: "code", name: "Code", type: "STRING", column: "code", filterable: true, groupable: true, sortable: true },
      { code: "title", name: "Title", type: "STRING", column: "title", filterable: true, groupable: true },
      { code: "status", name: "Status", type: "STRING", column: "status", filterable: true, groupable: true, sortable: true },
      { code: "organization", name: "Organization", type: "STRING", column: "organization_id", filterable: true, groupable: true },
      { code: "started_at", name: "Started", type: "DATE", column: "started_at", filterable: true, sortable: true },
    ],
  },
]);

export const SEMANTIC_ENTITY_CODES = Object.freeze(SEMANTIC_ENTITIES.map((entry) => entry.code));

// ── Limits & bounds (§30) ───────────────────────────────────────────────────
export const MAX_ROWS = 50000;
export const DEFAULT_MAX_ROWS = 10000;
export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_GROUP_ROWS = 5000;
export const MAX_COLUMNS = 100;
export const MAX_FILTERS = 50;
export const MAX_AGGREGATIONS = 25;
export const MAX_CALCULATED_FIELDS = 25;
export const ASYNC_ROW_THRESHOLD = 2000;
export const MAX_EXPORT_ROWS = 100000;
export const DEFAULT_TIMEOUT_MS = 30000;
export const MAX_TIMEOUT_MS = 600000;
export const DEFAULT_CACHE_TTL_SECONDS = 300;
export const MAX_CACHE_TTL_SECONDS = 86400;
export const MAX_CONCURRENT_REPORTS = 5;

// ── IAM resources ────────────────────────────────────────────────────────────
export const REPORTING_RESOURCES = Object.freeze({
  module: "iam.reporting",
  home: "iam.reporting.home",
  reports: "iam.reporting.reports",
  builder: "iam.reporting.builder",
  dashboards: "iam.reporting.dashboards",
  dashboardBuilder: "iam.reporting.dashboard_builder",
  kpis: "iam.reporting.kpis",
  metrics: "iam.reporting.metrics",
  dataSources: "iam.reporting.data_sources",
  schedules: "iam.reporting.schedules",
  exports: "iam.reporting.exports",
  bi: "iam.reporting.bi",
  jobs: "iam.reporting.jobs",
  history: "iam.reporting.history",
  search: "iam.reporting.search",
  observability: "iam.reporting.observability",
  audit: "iam.reporting.audit",
  admin: "iam.reporting.admin",
});

// ── Background jobs (§20) ────────────────────────────────────────────────────
export const REPORTING_HANDLER_CODES = Object.freeze({
  EXECUTE: "reporting.execute",
  EXPORT: "reporting.export",
  SCHEDULE: "reporting.schedule.run",
  KPI: "reporting.kpi.calculate",
  REFRESH: "reporting.readmodel.refresh",
  MAINTENANCE: "reporting.maintenance",
});

export const REPORTING_JOB_TYPES = [
  {
    code: "REPORTING_EXECUTE",
    name: "Report execution",
    description: "Execute or preview a report asynchronously.",
    source_module: SOURCE_MODULE,
    handler: REPORTING_HANDLER_CODES.EXECUTE,
    queues: ["reporting", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "REPORTING_EXPORT",
    name: "Report export",
    description: "Export a report result to CSV, JSON or Excel asynchronously.",
    source_module: SOURCE_MODULE,
    handler: REPORTING_HANDLER_CODES.EXPORT,
    queues: ["reporting", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "REPORTING_SCHEDULE_RUN",
    name: "Scheduled report run",
    description: "Run a scheduled report, snapshot or KPI calculation and distribute results.",
    source_module: SOURCE_MODULE,
    handler: REPORTING_HANDLER_CODES.SCHEDULE,
    queues: ["reporting", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "REPORTING_KPI_CALCULATE",
    name: "KPI calculation",
    description: "Recalculate KPI values and persist the results.",
    source_module: SOURCE_MODULE,
    handler: REPORTING_HANDLER_CODES.KPI,
    queues: ["reporting", "default"],
    timeout_seconds: 1800,
    max_retries: 1,
    default_priority: "low",
  },
  {
    code: "REPORTING_READMODEL_REFRESH",
    name: "Reporting read model refresh",
    description: "Refresh the reporting read model from the operational object model.",
    source_module: SOURCE_MODULE,
    handler: REPORTING_HANDLER_CODES.REFRESH,
    queues: ["default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "low",
  },
  {
    code: "REPORTING_MAINTENANCE",
    name: "Reporting maintenance",
    description: "Prune reporting history, expired cache entries and old exports.",
    source_module: SOURCE_MODULE,
    handler: REPORTING_HANDLER_CODES.MAINTENANCE,
    queues: ["default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "low",
  },
];

export const REPORTING_QUEUE = "reporting";

// ── Domain events (§33) ──────────────────────────────────────────────────────
export const REPORTING_EVENT_TYPES = [
  { code: "ReportCreated", description: "A report definition was created." },
  { code: "ReportUpdated", description: "A report definition was updated." },
  { code: "ReportPublished", description: "A report version was published." },
  { code: "ReportExecuted", description: "A report was executed successfully." },
  { code: "ReportExported", description: "A report result was exported." },
  { code: "ReportFailed", description: "A report execution or export failed." },
  { code: "DashboardCreated", description: "A dashboard was created." },
  { code: "DashboardPublished", description: "A dashboard version was published." },
  { code: "KpiUpdated", description: "A KPI definition or value changed." },
  { code: "MetricUpdated", description: "A metric definition changed." },
];

export const REPORTING_EVENT_MAP = Object.freeze({
  REPORT_CREATED: "ReportCreated",
  REPORT_UPDATED: "ReportUpdated",
  REPORT_PUBLISHED: "ReportPublished",
  REPORT_EXECUTED: "ReportExecuted",
  REPORT_EXPORTED: "ReportExported",
  REPORT_FAILED: "ReportFailed",
  DASHBOARD_CREATED: "DashboardCreated",
  DASHBOARD_PUBLISHED: "DashboardPublished",
  KPI_UPDATED: "KpiUpdated",
  METRIC_UPDATED: "MetricUpdated",
});

// ── Configuration defaults (§30) ─────────────────────────────────────────────
export const CONFIG_DEFAULTS = Object.freeze({
  max_rows: DEFAULT_MAX_ROWS,
  max_execution_ms: DEFAULT_TIMEOUT_MS,
  max_export_rows: MAX_EXPORT_ROWS,
  max_concurrent_reports: MAX_CONCURRENT_REPORTS,
  max_group_rows: MAX_GROUP_ROWS,
  async_row_threshold: ASYNC_ROW_THRESHOLD,
  cache_ttl_seconds: DEFAULT_CACHE_TTL_SECONDS,
  enable_cache: true,
  read_model_enabled: true,
  enforce_classification: true,
  allow_external_bi: false,
  history_retention_days: 180,
});

export const CONFIG_BOUNDS = Object.freeze({
  max_rows: { min: 100, max: MAX_ROWS },
  max_execution_ms: { min: 1000, max: MAX_TIMEOUT_MS },
  max_export_rows: { min: 100, max: MAX_EXPORT_ROWS },
  max_concurrent_reports: { min: 1, max: 100 },
  max_group_rows: { min: 10, max: MAX_ROWS },
  async_row_threshold: { min: 1, max: MAX_ROWS },
  cache_ttl_seconds: { min: 0, max: MAX_CACHE_TTL_SECONDS },
  history_retention_days: { min: 1, max: 3650 },
});

// ── BI integration (§21) ─────────────────────────────────────────────────────
export const BI_PROVIDERS = Object.freeze(["POWER_BI", "TABLEAU", "QLIK", "GENERIC_ODATA", "GENERIC_REST"]);
export const BI_CONNECTION_STATUSES = Object.freeze(["CONNECTED", "DISCONNECTED", "ERROR", "PLANNED"]);
export const BI_PUBLISH_STATUSES = Object.freeze(["QUEUED", "RUNNING", "PUBLISHED", "FAILED"]);

// ── Search integration ───────────────────────────────────────────────────────
export const SEARCH_OBJECT_TYPES = [
  { code: "reporting_report", name: "Report", description: "Versioned reporting & analytics report definitions." },
  { code: "reporting_dashboard", name: "Dashboard", description: "Reporting & analytics dashboards and widgets." },
  { code: "reporting_kpi", name: "KPI", description: "Reusable key performance indicators." },
];

// Analytical model version. Bump only with a backward-compatible reader.
export const ANALYTICS_MODEL_VERSION = "1.0";
