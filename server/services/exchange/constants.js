// Single source of truth for the Standards & Exchange (Module 19) vocabulary.
//
// Everything configurable about the exchange layer (format catalog, adapter
// catalog, statuses, validation levels/severities, limits, IAM resources,
// job/event codes and platform defaults) lives here so the adapter engines and
// the API never hard-code a standard or a business rule.
export const SOURCE_MODULE = "exchange";

export const FORMAT_STATUSES = Object.freeze(["DRAFT", "ACTIVE", "DEPRECATED", "OBSOLETE"]);
export const DEFINITION_STATUSES = Object.freeze(["DRAFT", "ACTIVE", "DEPRECATED", "OBSOLETE"]);
export const APPROVAL_STATUSES = Object.freeze(["DRAFT", "PENDING", "APPROVED", "REJECTED"]);
export const ADAPTER_STATUSES = Object.freeze(["AVAILABLE", "PLANNED", "UNSUPPORTED", "DISABLED"]);
export const DIRECTIONS = Object.freeze(["IMPORT", "EXPORT", "BOTH"]);
export const MAPPING_SOURCE_KINDS = Object.freeze(["STANDARD", "CANONICAL", "ENTERPRISE"]);
export const VALIDATION_LEVELS = Object.freeze(["FILE", "STANDARDS", "ENTERPRISE"]);
export const SEVERITIES = Object.freeze(["ERROR", "WARNING", "INFO"]);

// Validation result statuses (§9).
export const VALIDATION_STATUSES = Object.freeze(["PASSED", "WARNING", "FAILED"]);
export const VALIDATION_STATUS = Object.freeze(Object.fromEntries(VALIDATION_STATUSES.map((s) => [s, s])));

// Exchange operations. PREVIEW/DRY_RUN/VALIDATE_ONLY never mutate production
// data; only EXECUTE and EXPORT do.
export const OPERATIONS = Object.freeze(["PREVIEW", "DRY_RUN", "VALIDATE_ONLY", "EXECUTE", "EXPORT"]);
export const MUTATING_OPERATIONS = Object.freeze(["EXECUTE", "EXPORT"]);

export const TRANSACTION_STATUSES = Object.freeze([
  "QUEUED",
  "RUNNING",
  "VALIDATING",
  "PREVIEW",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
]);
export const TERMINAL_TRANSACTION_STATUSES = Object.freeze(["COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]);

export const JOB_STATUSES = Object.freeze(["QUEUED", "RUNNING", "COMPLETED", "PARTIAL", "FAILED", "CANCELLED"]);
export const RECONCILIATION_COUNTERS = Object.freeze([
  "records_read",
  "records_validated",
  "records_created",
  "records_updated",
  "records_skipped",
  "records_failed",
  "relationships_created",
  "relationships_failed",
  "files_processed",
  "warnings",
  "errors",
]);

// ── Format catalog ───────────────────────────────────────────────────────────
// Descriptive defaults only. A tenant may re-register, deprecate or extend any
// of them through the Format Registry; nothing in the engine assumes these
// exact codes. `adapter_code` binds a format to an adapter implementation.
export const FORMAT_CATALOG = Object.freeze([
  {
    code: "JSON",
    name: "JSON",
    standard_name: "RFC 8259 JSON",
    standard_version: "RFC 8259",
    category: "DATA",
    description: "JavaScript Object Notation (RFC 8259) data exchange.",
    mime_types: ["application/json"],
    extensions: [".json"],
    adapter_code: "json",
    direction: "BOTH",
    capabilities: { parse: true, serialize: true, schema: "JSON_SCHEMA", streaming: true, secure: true, payload_limit: true },
    display_order: 10,
  },
  {
    code: "XML",
    name: "XML",
    standard_name: "W3C XML 1.0",
    standard_version: "1.0",
    category: "DATA",
    description: "W3C XML 1.0 exchange with XSD-style declarative schema validation.",
    mime_types: ["application/xml", "text/xml"],
    extensions: [".xml"],
    adapter_code: "xml",
    direction: "BOTH",
    capabilities: { parse: true, serialize: true, schema: "XSD_DECLARATIVE", namespaces: true, secure: true, payload_limit: true },
    display_order: 20,
  },
  {
    code: "EDI_X12",
    name: "EDI (ANSI X12)",
    standard_name: "ANSI ASC X12",
    standard_version: "005010",
    category: "EDI",
    description: "ANSI X12 EDI interchange with trading-partner configuration.",
    mime_types: ["application/edi-x12", "text/plain"],
    extensions: [".edi", ".x12", ".txt"],
    adapter_code: "edi-x12",
    direction: "BOTH",
    capabilities: { parse: true, serialize: true, schema: "SEGMENT", partner_config: true, secure: true },
    display_order: 30,
  },
  {
    code: "BOM_EXCHANGE",
    name: "BOM exchange",
    standard_name: "FutureForge BOM exchange",
    standard_version: "1.0",
    category: "BOM",
    description: "Canonical BOM structure exchange delegating to the BOM Engine.",
    mime_types: ["application/json", "text/csv"],
    extensions: [".bom.json", ".bom.csv"],
    adapter_code: "bom",
    direction: "BOTH",
    capabilities: { parse: true, serialize: true, integration: "bom", variants: true, effectivity: true },
    display_order: 40,
  },
  {
    code: "STEP_AP242",
    name: "STEP AP242",
    standard_name: "ISO 10303-242",
    standard_version: "AP242",
    category: "CAD",
    description: "ISO 10303-242 managed model-based 3D engineering. Extension point; requires a STEP parser library.",
    mime_types: ["model/step", "application/step", "application/octet-stream"],
    extensions: [".stp", ".step", ".p21"],
    adapter_code: "step-ap242",
    direction: "BOTH",
    capabilities: { parse: false, serialize: false, schema: "STEP_SCHEMA", requires_library: true },
    display_order: 50,
  },
  {
    code: "JT",
    name: "JT",
    standard_name: "ISO 14306 JT",
    standard_version: "ISO 14306",
    category: "CAD",
    description: "ISO 14306 JT visualization/CAD format. Extension point; requires a JT parser library.",
    mime_types: ["model/jt", "application/octet-stream"],
    extensions: [".jt"],
    adapter_code: "jt",
    direction: "BOTH",
    capabilities: { parse: false, serialize: false, schema: "JT_SCHEMA", requires_library: true },
    display_order: 60,
  },
  {
    code: "PDF_A",
    name: "PDF/A",
    standard_name: "ISO 19005 PDF/A",
    standard_version: "PDF/A",
    category: "DOCUMENT",
    description: "ISO 19005 PDF/A archival documents: metadata extraction and compliance validation via File/Content.",
    mime_types: ["application/pdf"],
    extensions: [".pdf"],
    adapter_code: "pdfa",
    direction: "BOTH",
    capabilities: { parse: false, serialize: false, metadata: true, compliance: true, requires_library: true },
    display_order: 70,
  },
  {
    code: "CAD_EXCHANGE",
    name: "CAD exchange",
    standard_name: "FutureForge CAD exchange",
    standard_version: "1.0",
    category: "CAD",
    description: "Generic CAD exchange layer dispatching to concrete CAD adapters (STEP/JT) and PDM associations.",
    mime_types: ["application/octet-stream"],
    extensions: [],
    adapter_code: "cad",
    direction: "BOTH",
    capabilities: { parse: false, serialize: false, dispatch: true, requires_library: true },
    display_order: 80,
  },
]);

export const DEFAULT_JSON_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    objects: { type: "array" },
    relationships: { type: "array" },
  },
  required: ["objects"],
});

// ── Adapter catalog ──────────────────────────────────────────────────────────
// A record of every adapter implementation known to the platform, including
// planned/unsupported ones, so the UI can report honest capability status.
export const ADAPTER_CATALOG = Object.freeze([
  { code: "json", name: "JSON adapter", category: "DATA", status: "AVAILABLE", provider: "platform", library: "builtin", capabilities: { parse: true, serialize: true, validate: true, detect: true } },
  { code: "xml", name: "XML adapter", category: "DATA", status: "AVAILABLE", provider: "platform", library: "builtin-safe-xml", capabilities: { parse: true, serialize: true, validate: true, detect: true, secure: true } },
  { code: "edi-x12", name: "EDI X12 adapter", category: "EDI", status: "AVAILABLE", provider: "platform", library: "builtin-segment", capabilities: { parse: true, serialize: true, validate: true, detect: true, partner_config: true } },
  { code: "bom", name: "BOM exchange adapter", category: "BOM", status: "AVAILABLE", provider: "platform", library: "builtin", capabilities: { parse: true, serialize: true, validate: true, integration: "bom" } },
  { code: "step-ap242", name: "STEP AP242 adapter", category: "CAD", status: "PLANNED", provider: "external", library: "", capabilities: { parse: false, serialize: false, validate: false, extension_point: true } },
  { code: "jt", name: "JT adapter", category: "CAD", status: "PLANNED", provider: "external", library: "", capabilities: { parse: false, serialize: false, validate: false, extension_point: true } },
  { code: "pdfa", name: "PDF/A adapter", category: "DOCUMENT", status: "UNSUPPORTED", provider: "external", library: "", capabilities: { parse: false, serialize: false, validate: false, metadata: true, extension_point: true } },
  { code: "cad", name: "CAD exchange adapter", category: "CAD", status: "PLANNED", provider: "platform", library: "", capabilities: { parse: false, serialize: false, validate: false, dispatch: true, extension_point: true } },
]);

// ── Limits & bounds ──────────────────────────────────────────────────────────
export const MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
export const DEFAULT_MAX_PAYLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_XML_DEPTH = 100;
export const MAX_XML_NODES = 100000;
export const MAX_RECORDS = 100000;
export const ASYNC_RECORD_THRESHOLD = 500;
export const DEFAULT_BATCH_SIZE = 500;
export const MAX_BATCH_SIZE = 5000;
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_ERRORS_RECORDED = 1000;
export const DEFAULT_TIMEOUT_MS = 60000;
export const MAX_TIMEOUT_MS = 3600000;

// ── IAM resources ────────────────────────────────────────────────────────────
export const EXCHANGE_RESOURCES = Object.freeze({
  module: "iam.exchange",
  dashboard: "iam.exchange.dashboard",
  formats: "iam.exchange.formats",
  definitions: "iam.exchange.definitions",
  importRun: "iam.exchange.import",
  exportRun: "iam.exchange.export",
  mappings: "iam.exchange.mappings",
  transformations: "iam.exchange.transformations",
  validation: "iam.exchange.validation",
  jobs: "iam.exchange.jobs",
  history: "iam.exchange.history",
  search: "iam.exchange.search",
  metrics: "iam.exchange.metrics",
  audit: "iam.exchange.audit",
  admin: "iam.exchange.admin",
});

// ── Background jobs ──────────────────────────────────────────────────────────
export const EXCHANGE_HANDLER_CODES = Object.freeze({
  IMPORT: "exchange.import",
  EXPORT: "exchange.export",
  VALIDATE: "exchange.validate",
  RECONCILE: "exchange.reconcile",
  MAINTENANCE: "exchange.maintenance",
});

export const EXCHANGE_JOB_TYPES = [
  {
    code: "EXCHANGE_IMPORT",
    name: "Standards exchange import",
    description: "Execute or dry-run a standards import exchange asynchronously.",
    source_module: SOURCE_MODULE,
    handler: EXCHANGE_HANDLER_CODES.IMPORT,
    queues: ["exchange", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "EXCHANGE_EXPORT",
    name: "Standards exchange export",
    description: "Execute a standards export exchange asynchronously.",
    source_module: SOURCE_MODULE,
    handler: EXCHANGE_HANDLER_CODES.EXPORT,
    queues: ["exchange", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "EXCHANGE_VALIDATE",
    name: "Standards exchange validation",
    description: "Validate a payload against file, standards and enterprise rules.",
    source_module: SOURCE_MODULE,
    handler: EXCHANGE_HANDLER_CODES.VALIDATE,
    queues: ["exchange", "default"],
    timeout_seconds: 1800,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "EXCHANGE_RECONCILE",
    name: "Standards exchange reconciliation",
    description: "Reconcile an exchange transaction against the enterprise model.",
    source_module: SOURCE_MODULE,
    handler: EXCHANGE_HANDLER_CODES.RECONCILE,
    queues: ["exchange", "default"],
    timeout_seconds: 1800,
    max_retries: 1,
    default_priority: "low",
  },
  {
    code: "EXCHANGE_MAINTENANCE",
    name: "Standards exchange maintenance",
    description: "Prune exchange history, resolve stale transactions and refresh caches.",
    source_module: SOURCE_MODULE,
    handler: EXCHANGE_HANDLER_CODES.MAINTENANCE,
    queues: ["default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "low",
  },
];

// ── Domain events (§30) ──────────────────────────────────────────────────────
export const EXCHANGE_EVENT_TYPES = [
  { code: "ExchangeStarted", description: "A standards exchange operation started." },
  { code: "ExchangeValidated", description: "A standards exchange payload was validated." },
  { code: "ExchangeCompleted", description: "A standards exchange operation completed successfully." },
  { code: "ExchangeFailed", description: "A standards exchange operation failed." },
  { code: "ExchangeCancelled", description: "A standards exchange operation was cancelled." },
  { code: "ExchangeDefinitionPublished", description: "An exchange definition version was published." },
  { code: "ExchangeDefinitionDeprecated", description: "An exchange definition was deprecated." },
  { code: "ValidationFailed", description: "Standards or enterprise validation produced blocking errors." },
  { code: "ExchangeReconciled", description: "An exchange transaction was reconciled." },
];

export const EXCHANGE_EVENT_MAP = Object.freeze({
  STARTED: "ExchangeStarted",
  VALIDATED: "ExchangeValidated",
  COMPLETED: "ExchangeCompleted",
  FAILED: "ExchangeFailed",
  CANCELLED: "ExchangeCancelled",
  DEFINITION_PUBLISHED: "ExchangeDefinitionPublished",
  DEFINITION_DEPRECATED: "ExchangeDefinitionDeprecated",
  VALIDATION_FAILED: "ValidationFailed",
  RECONCILED: "ExchangeReconciled",
});

// ── Configuration defaults ───────────────────────────────────────────────────
export const CONFIG_DEFAULTS = Object.freeze({
  max_payload_bytes: DEFAULT_MAX_PAYLOAD_BYTES,
  batch_size: DEFAULT_BATCH_SIZE,
  async_record_threshold: ASYNC_RECORD_THRESHOLD,
  timeout_ms: DEFAULT_TIMEOUT_MS,
  max_records: MAX_RECORDS,
  duplicate_strategy: "REJECT",
  error_strategy: "CONTINUE",
  auto_publish_definitions: false,
  record_history: true,
  enforce_classification: true,
  allow_partial_execution: true,
});

export const CONFIG_BOUNDS = Object.freeze({
  max_payload_bytes: { min: 1024, max: MAX_PAYLOAD_BYTES },
  batch_size: { min: 1, max: MAX_BATCH_SIZE },
  async_record_threshold: { min: 1, max: MAX_RECORDS },
  timeout_ms: { min: 1000, max: MAX_TIMEOUT_MS },
  max_records: { min: 1, max: MAX_RECORDS },
});

export const DUPLICATE_STRATEGIES = Object.freeze(["REJECT", "SKIP", "UPDATE", "MERGE", "CREATE"]);
export const ERROR_STRATEGIES = Object.freeze(["CONTINUE", "ROLLBACK", "ABORT"]);

// ── Search integration ───────────────────────────────────────────────────────
export const SEARCH_OBJECT_TYPES = [
  { code: "exchange_format", name: "Exchange format", description: "Registered standards exchange formats." },
  { code: "exchange_definition", name: "Exchange definition", description: "Versioned standards exchange definitions." },
  { code: "exchange_transaction", name: "Exchange transaction", description: "Import/export exchange history." },
];

// Canonical Exchange Model version. Bump only with a backward-compatible reader.
export const CANONICAL_MODEL_VERSION = "1.0";
