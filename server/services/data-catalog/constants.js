// Vocabulary and defaults for the Data Catalog & Business Glossary service.
// Everything that a caller could reasonably want to configure is a data value
// here (or in the database) rather than a hard-coded branch, so new catalog
// object types, relationship types, source types and lineage types can be
// registered without rewriting the engine.

export const SOURCE_MODULE = "data-catalog";

// Catalog asset lifecycle (spec §3).
export const CATALOG_STATUSES = ["draft", "active", "deprecated", "retired"];

// The kinds of asset a dc_entries registry row can represent.
export const ENTRY_TYPES = ["DOMAIN", "OBJECT", "ATTRIBUTE", "BUSINESS_TERM", "SOURCE", "CONSUMER", "CLASSIFICATION", "LINEAGE"];

// Business term lifecycle (spec §8).
export const TERM_STATUSES = ["draft", "in_review", "approved", "active", "deprecated", "retired"];
export const TERM_APPROVAL_STATUSES = ["pending", "in_review", "approved", "rejected"];

// Legal lifecycle transitions. Approval/review are driven by the platform
// Workflow service; these transitions guard the metadata state machine.
export const TERM_STATUS_TRANSITIONS = Object.freeze({
  draft: ["in_review", "retired"],
  in_review: ["draft", "approved", "retired"],
  approved: ["active", "deprecated", "retired"],
  active: ["deprecated", "retired"],
  deprecated: ["retired", "active"],
  retired: ["active"],
});

export const DEFINITION_TYPES = ["BUSINESS", "TECHNICAL", "OPERATIONAL", "CALCULATION"];

export const SYNONYM_TYPES = ["SYNONYM", "ABBREVIATION", "ACRONYM", "ALIAS", "DEPRECATED"];

export const TERM_RELATIONSHIP_TYPES = [
  "RELATED_TO",
  "BROADER_THAN",
  "NARROWER_THAN",
  "SYNONYM_OF",
  "ABBREVIATION_OF",
  "CONTAINS",
  "DERIVED_FROM",
];

export const LINEAGE_RELATIONSHIP_TYPES = [
  "SOURCE_OF",
  "DERIVED_FROM",
  "TRANSFORMED_FROM",
  "SENT_TO",
  "CONSUMED_BY",
  "COPIED_TO",
  "AGGREGATED_FROM",
];

export const SOURCE_TYPES = ["APPLICATION", "DATABASE", "API", "FILE", "DATA_LAKE", "DATA_WAREHOUSE", "EXTERNAL_SYSTEM"];

export const CONSUMER_TYPES = [
  "APPLICATION",
  "SERVICE",
  "ANALYTICS",
  "REPORTING",
  "PIPELINE",
  "API",
  "AI_SERVICE",
  "EXTERNAL_SYSTEM",
  "USER_GROUP",
];

export const MAPPING_TYPES = [
  "SOURCE_TO_OBJECT",
  "OBJECT_TO_CONSUMER",
  "RENAME",
  "TRANSFORM",
  "ENRICH",
  "AGGREGATE",
  "SPLIT",
  "MERGE",
];

export const OWNERSHIP_RELATIONSHIPS = ["owner", "steward"];
export const OWNERSHIP_KINDS = ["DATA_OWNER", "DATA_STEWARD", "TECHNICAL_OWNER", "BUSINESS_OWNER"];
export const SUBJECT_TYPES = ["user", "group", "role", "organization"];

// Business categories for catalog classifications; security_classification is
// always one of the P0 Data Security model's values.
export const SECURITY_CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"];
export const CLASSIFICATION_CATEGORIES = ["business", "security", "regulatory", "domain"];

// Term mapping targets (spec §9).
export const TERM_TARGET_TYPES = ["OBJECT", "ATTRIBUTE", "DOMAIN", "SOURCE", "CONSUMER"];

// Bounded lineage traversal so an unbounded graph query is impossible.
export const LINEAGE_MAX_DEPTH = 6;
export const LINEAGE_MAX_NODES = 200;
export const LINEAGE_DEFAULT_DEPTH = 2;

// Background job handler codes (registered with the Job Execution engine).
export const CATALOG_HANDLER_CODES = Object.freeze({
  IMPORT: "dataCatalog.import",
  EXPORT: "dataCatalog.export",
  LINEAGE_MAINTENANCE: "dataCatalog.lineageMaintenance",
  REINDEX: "dataCatalog.reindex",
});

// Job type codes added to the platform job registry.
export const CATALOG_JOB_TYPES = [
  {
    code: "DATA_CATALOG_IMPORT",
    name: "Data catalog metadata import",
    description: "Import catalog metadata (terms, objects, sources) from CSV or JSON in batches.",
    source_module: SOURCE_MODULE,
    handler: CATALOG_HANDLER_CODES.IMPORT,
    queues: ["default"],
    timeout_seconds: 600,
    max_retries: 2,
    default_priority: "normal",
  },
  {
    code: "DATA_CATALOG_EXPORT",
    name: "Data catalog metadata export",
    description: "Export catalog metadata (glossary, objects, mappings, lineage) to CSV or JSON.",
    source_module: SOURCE_MODULE,
    handler: CATALOG_HANDLER_CODES.EXPORT,
    queues: ["default"],
    timeout_seconds: 600,
    max_retries: 2,
    default_priority: "normal",
  },
  {
    code: "DATA_CATALOG_LINEAGE_MAINTENANCE",
    name: "Data catalog lineage maintenance",
    description: "Converge lineage metadata: deactivate expired edges and prune detached edges.",
    source_module: SOURCE_MODULE,
    handler: CATALOG_HANDLER_CODES.LINEAGE_MAINTENANCE,
    queues: ["default"],
    timeout_seconds: 300,
    max_retries: 1,
    default_priority: "low",
  },
  {
    code: "DATA_CATALOG_REINDEX",
    name: "Data catalog search reindex",
    description: "Rebuild the search index for catalog object types.",
    source_module: SOURCE_MODULE,
    handler: CATALOG_HANDLER_CODES.REINDEX,
    queues: ["default"],
    timeout_seconds: 600,
    max_retries: 1,
    default_priority: "normal",
  },
];

// Domain events published by the catalog (consumed through the shared Event
// & Messaging Framework; no separate event system).
export const CATALOG_EVENT_TYPES = [
  { code: "BusinessTermCreated", description: "A business glossary term was created." },
  { code: "BusinessTermUpdated", description: "A business glossary term was updated." },
  { code: "BusinessTermSubmitted", description: "A business glossary term was submitted for review." },
  { code: "BusinessTermApproved", description: "A business glossary term was approved." },
  { code: "BusinessTermDeprecated", description: "A business glossary term was deprecated." },
  { code: "BusinessTermRetired", description: "A business glossary term was retired." },
  { code: "CatalogObjectCreated", description: "A catalog object was created." },
  { code: "CatalogObjectUpdated", description: "A catalog object was updated." },
  { code: "CatalogAttributeChanged", description: "A catalog attribute was created or updated." },
  { code: "DataSourceCataloged", description: "A data source was cataloged or changed." },
  { code: "DataConsumerCataloged", description: "A data consumer was cataloged or changed." },
  { code: "LineageCreated", description: "A lineage relationship was created." },
  { code: "LineageChanged", description: "A lineage relationship was changed or removed." },
  { code: "CatalogOwnerChanged", description: "Catalog ownership changed." },
  { code: "CatalogStewardChanged", description: "Catalog stewardship changed." },
  { code: "CatalogClassificationChanged", description: "A catalog classification assignment changed." },
  { code: "CatalogEntryImported", description: "Catalog metadata was imported." },
];

// Module configuration defaults (per tenant).
export const CONFIG_DEFAULTS = Object.freeze({
  lineage_max_depth: LINEAGE_MAX_DEPTH,
  lineage_max_nodes: LINEAGE_MAX_NODES,
  import_batch_size: 500,
  require_definition_for_approval: true,
  auto_publish_terms: false,
});

// Resource codes seeded into IAM. Kept here so foundation/seed/router agree.
export const CATALOG_RESOURCES = Object.freeze({
  module: "iam.data_catalog",
  overview: "iam.data_catalog.overview",
  domains: "iam.data_catalog.domains",
  objects: "iam.data_catalog.objects",
  attributes: "iam.data_catalog.attributes",
  glossary: "iam.data_catalog.glossary",
  terms: "iam.data_catalog.terms",
  sources: "iam.data_catalog.sources",
  consumers: "iam.data_catalog.consumers",
  mappings: "iam.data_catalog.mappings",
  lineage: "iam.data_catalog.lineage",
  relationships: "iam.data_catalog.relationships",
  classifications: "iam.data_catalog.classifications",
  ownership: "iam.data_catalog.ownership",
  importExport: "iam.data_catalog.import_export",
  admin: "iam.data_catalog.admin",
  jobs: "iam.data_catalog.jobs",
  metrics: "iam.data_catalog.metrics",
});
