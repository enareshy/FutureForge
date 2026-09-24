// Vocabulary, defaults and platform wiring codes for the P1 PDM domain.
//
// PDM provides engineering-data semantics (Item/Revision, Part/Product, Dataset,
// Representation, Design Data, CAD association, Revision/Configuration rules,
// Baseline, Where Used/Referenced) on top of the shared platform services. Every
// piece of vocabulary an administrator can tune is data here so the storage model
// and services never change when new values are added. Nothing in this module
// duplicates an existing platform engine: identity/revision storage is PDM's,
// while lifecycle, effectivity/versioning, classification, numbering, search,
// security, files, workflow, events, jobs and audit are all reused.
export const SOURCE_MODULE = "pdm";

export const PDM_OBJECT_TYPE = "pdm_item";
export const PDM_REVISION_OBJECT_TYPE = "pdm_item_revision";

// ── Item semantics ───────────────────────────────────────────────────────────

export const ITEM_TYPES = ["PART", "PRODUCT", "DOCUMENT", "ASSEMBLY", "OTHER"];

// Item-owned identity kinds that also expose a dedicated semantic service.
export const PART_TYPES = ["PART", "ASSEMBLY"];

export const ITEM_STATUSES = ["DRAFT", "IN_WORK", "IN_REVIEW", "RELEASED", "OBSOLETE"];

export const REVISION_STATUSES = ["DRAFT", "IN_WORK", "IN_REVIEW", "RELEASED", "OBSOLETE"];

// Revisions in these statuses are immutable in place; a new revision is required.
export const IMMUTABLE_REVISION_STATUSES = ["RELEASED", "OBSOLETE"];

// Configurable default lifecycle used when an object type is not onboarded to the
// shared Lifecycle kernel. The kernel is always preferred when an assignment
// exists; this is only the fallback state machine.
export const DEFAULT_ITEM_TRANSITIONS = Object.freeze({
  DRAFT: ["IN_WORK", "OBSOLETE"],
  IN_WORK: ["DRAFT", "IN_REVIEW", "OBSOLETE"],
  IN_REVIEW: ["IN_WORK", "RELEASED", "OBSOLETE"],
  RELEASED: ["OBSOLETE"],
  OBSOLETE: [],
});

export const DEFAULT_REVISION_TRANSITIONS = Object.freeze({
  DRAFT: ["IN_WORK", "OBSOLETE"],
  IN_WORK: ["DRAFT", "IN_REVIEW", "OBSOLETE"],
  IN_REVIEW: ["IN_WORK", "RELEASED", "OBSOLETE"],
  RELEASED: ["OBSOLETE"],
  OBSOLETE: [],
});

// ── Dataset semantics ────────────────────────────────────────────────────────

export const DATASET_TYPES = [
  "CAD_MODEL",
  "CAD_DRAWING",
  "SPECIFICATION",
  "DOCUMENT",
  "IMAGE",
  "MANUFACTURING_DATA",
  "ANALYSIS_DATA",
  "OTHER",
];

export const DATASET_STATUSES = ["DRAFT", "IN_WORK", "IN_REVIEW", "RELEASED", "OBSOLETE"];

export const REPRESENTATION_TYPES = [
  "3D",
  "2D_DRAWING",
  "VISUALIZATION",
  "THUMBNAIL",
  "LIGHTWEIGHT",
  "DERIVED",
  "OTHER",
];

export const DESIGN_DATA_TYPES = ["CAD_MODEL", "DRAWING", "SPECIFICATION", "VISUALIZATION", "OTHER"];

// ── CAD association semantics ────────────────────────────────────────────────

export const CAD_ASSOCIATION_TYPES = ["MASTER", "DRAWING", "DERIVED", "REFERENCE", "VISUALIZATION", "SIMPLIFIED"];

export const CAD_TYPES = ["NATIVE", "NEUTRAL", "LIGHTWEIGHT", "IMAGE", "OTHER"];

export const CAD_ASSOCIATION_STATUSES = ["ACTIVE", "INACTIVE", "SUPERSEDED"];

// ── Rule semantics ───────────────────────────────────────────────────────────

export const REVISION_RULE_TYPES = [
  "LATEST_RELEASED",
  "LATEST_WORKING",
  "RELEASED_AS_OF",
  "SPECIFIC_REVISION",
  "HIGHEST_REVISION",
  "BY_LIFECYCLE",
  "CUSTOM",
];

export const CONFIGURATION_RULE_TYPES = ["VARIANT", "FEATURE", "OPTION", "EFFECTIVITY", "EXPRESSION", "COMPOSITE"];

export const RULE_STATUSES = ["DRAFT", "ACTIVE", "INACTIVE"];

export const CONFIGURATION_OPERATORS = ["EQUALS", "NOT_EQUALS", "IN", "NOT_IN", "EXISTS", "GREATER_THAN", "LESS_THAN"];

// ── Baseline semantics ───────────────────────────────────────────────────────

export const BASELINE_STATUSES = ["DRAFT", "RELEASED", "FROZEN", "RETIRED"];

export const IMMUTABLE_BASELINE_STATUSES = ["RELEASED", "FROZEN", "RETIRED"];

// ── Relationships ────────────────────────────────────────────────────────────

// Typed PDM relationships. Each is realized through the shared Object &
// Relationship Framework when the endpoints expose a generic object id, and is
// always indexed in the PDM relationship table for batched traversal.
export const RELATIONSHIP_TYPES = [
  { code: "ITEM_HAS_REVISION", name: "Item has revision", source: "ITEM", target: "REVISION", cardinality: "1:N", direction: "FORWARD" },
  { code: "REVISION_HAS_DATASET", name: "Revision has dataset", source: "REVISION", target: "DATASET", cardinality: "N:N", direction: "FORWARD" },
  { code: "REVISION_HAS_REPRESENTATION", name: "Revision has representation", source: "REVISION", target: "REPRESENTATION", cardinality: "1:N", direction: "FORWARD" },
  { code: "REVISION_HAS_DESIGN_DATA", name: "Revision has design data", source: "REVISION", target: "DESIGN_DATA", cardinality: "1:N", direction: "FORWARD" },
  { code: "REVISION_HAS_CAD", name: "Revision has CAD", source: "REVISION", target: "CAD_ASSOCIATION", cardinality: "1:N", direction: "FORWARD" },
  { code: "PRODUCT_HAS_PART", name: "Product has part", source: "ITEM", target: "ITEM", cardinality: "1:N", direction: "FORWARD" },
  { code: "REVISION_REFERENCES", name: "Revision references", source: "REVISION", target: "OBJECT", cardinality: "N:N", direction: "FORWARD" },
  { code: "REVISION_USES_DATASET", name: "Revision uses dataset", source: "REVISION", target: "DATASET", cardinality: "N:N", direction: "FORWARD" },
  { code: "REVISION_HAS_BASELINE", name: "Revision has baseline", source: "REVISION", target: "BASELINE", cardinality: "1:N", direction: "FORWARD" },
  { code: "ITEM_DERIVED_FROM", name: "Item derived from", source: "ITEM", target: "ITEM", cardinality: "N:N", direction: "FORWARD" },
  { code: "PART_SUBSTITUTE", name: "Part substitute", source: "ITEM", target: "ITEM", cardinality: "N:N", direction: "FORWARD" },
  { code: "BASELINE_CONTAINS", name: "Baseline contains", source: "BASELINE", target: "OBJECT", cardinality: "N:N", direction: "FORWARD" },
];

export const RELATIONSHIP_STATUSES = ["ACTIVE", "INACTIVE", "SUPERSEDED"];

export const RELATIONSHIP_DIRECTIONS = ["FORWARD", "REVERSE", "BIDIRECTIONAL"];

// ── Where-referenced categories ──────────────────────────────────────────────

export const REFERENCE_CATEGORIES = [
  "BOM",
  "CAD",
  "DATASET",
  "DOCUMENT",
  "SPECIFICATION",
  "WORKFLOW",
  "RELATIONSHIP",
  "PRODUCT",
  "PART",
  "ITEM",
  "REVISION",
  "OTHER",
];

// ── Validation ───────────────────────────────────────────────────────────────

export const RULE_TYPES = [
  "MISSING_REVISION",
  "DUPLICATE_ITEM_NUMBER",
  "DUPLICATE_REVISION_NUMBER",
  "INVALID_REVISION_SEQUENCE",
  "MISSING_DATASET_TYPE",
  "INVALID_DATASET_TYPE",
  "ORPHAN_DATASET",
  "INVALID_CAD_ASSOCIATION",
  "MISSING_PRIMARY_CAD",
  "INVALID_EFFECTIVITY",
  "INVALID_REVISION_RULE",
  "INVALID_CONFIGURATION_RULE",
  "MISSING_OWNER",
  "LIFECYCLE_INCOMPATIBILITY",
  "CUSTOM",
];

export const RULE_SEVERITIES = ["PASS", "WARNING", "ERROR"];

export const VALIDATION_STATUSES = ["PASS", "WARNING", "ERROR"];

export const VALIDATION_SCOPES = ["ITEM", "REVISION", "DATASET", "TENANT"];

export const DEFAULT_VALIDATION_RULES = [
  { code: "ITEM_UNIQUE_NUMBER", rule_type: "DUPLICATE_ITEM_NUMBER", severity: "ERROR", description: "Item numbers must be unique within the tenant.", sequence: 10 },
  { code: "ITEM_HAS_OWNER", rule_type: "MISSING_OWNER", severity: "WARNING", description: "An item should declare an accountable owner.", sequence: 20 },
  { code: "REVISION_UNIQUE_NUMBER", rule_type: "DUPLICATE_REVISION_NUMBER", severity: "ERROR", description: "Revision numbers must be unique within an item.", sequence: 30 },
  { code: "REVISION_VALID_SEQUENCE", rule_type: "INVALID_REVISION_SEQUENCE", severity: "WARNING", description: "Revision sequence must be a positive integer.", sequence: 40 },
  { code: "DATASET_VALID_TYPE", rule_type: "INVALID_DATASET_TYPE", severity: "WARNING", description: "Dataset types should come from the configured vocabulary.", sequence: 50 },
  { code: "DATASET_ORPHAN", rule_type: "ORPHAN_DATASET", severity: "WARNING", description: "A dataset should be attached to at least one revision or object.", sequence: 60 },
  { code: "CAD_VALID_ASSOCIATION", rule_type: "INVALID_CAD_ASSOCIATION", severity: "ERROR", description: "CAD associations require a source object and a dataset.", sequence: 70 },
  { code: "CAD_SINGLE_PRIMARY", rule_type: "MISSING_PRIMARY_CAD", severity: "WARNING", description: "A source revision should have at most one primary CAD association per type.", sequence: 80 },
  { code: "RULE_VALID_EFFECTIVITY", rule_type: "INVALID_EFFECTIVITY", severity: "ERROR", description: "Rule effectivity windows must be ordered and valid.", sequence: 90 },
];

export const MAX_STRUCTURE_DEPTH = 200;
export const MAX_TRAVERSAL_NODES = 200000;
export const MAX_BULK_OBJECTS = 50000;

// ── Numeric / misc ───────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 50;

// ── IAM resources ────────────────────────────────────────────────────────────

export const PDM_RESOURCES = Object.freeze({
  module: "iam.pdm",
  overview: "iam.pdm.overview",
  items: "iam.pdm.items",
  revisions: "iam.pdm.revisions",
  parts: "iam.pdm.parts",
  products: "iam.pdm.products",
  datasets: "iam.pdm.datasets",
  representations: "iam.pdm.representations",
  designData: "iam.pdm.design-data",
  cad: "iam.pdm.cad",
  revisionRules: "iam.pdm.revision-rules",
  configurationRules: "iam.pdm.configuration-rules",
  baselines: "iam.pdm.baselines",
  whereUsed: "iam.pdm.whereused",
  whereReferenced: "iam.pdm.wherereferenced",
  structure: "iam.pdm.structure",
  validation: "iam.pdm.validation",
  search: "iam.pdm.search",
  auditTrail: "iam.pdm.audit",
  metrics: "iam.pdm.metrics",
  admin: "iam.pdm.admin",
});

// Stable security action codes published for administrators. Enforcement uses
// the standard IAM read/create/update/delete/execute actions on PDM resources.
export const SECURITY_ACTIONS = [
  "VIEW_ITEM",
  "MANAGE_ITEM",
  "CREATE_REVISION",
  "REVISE_REVISION",
  "RELEASE_REVISION",
  "MANAGE_DATASET",
  "MANAGE_REPRESENTATION",
  "MANAGE_DESIGN_DATA",
  "ASSOCIATE_CAD",
  "DISASSOCIATE_CAD",
  "MANAGE_REVISION_RULE",
  "MANAGE_CONFIGURATION_RULE",
  "CREATE_BASELINE",
  "VIEW_BASELINE",
  "WHERE_USED",
  "WHERE_REFERENCED",
  "RESOLVE_STRUCTURE",
  "VALIDATE_PDM",
  "VIEW_AUDIT",
];

// ── Background job handlers ──────────────────────────────────────────────────

export const PDM_HANDLER_CODES = Object.freeze({
  STRUCTURE: "pdm.structure.resolve",
  WHERE_USED: "pdm.whereUsed",
  WHERE_REFERENCED: "pdm.whereReferenced",
  BASELINE: "pdm.baseline.create",
  VALIDATE: "pdm.validate",
  REINDEX: "pdm.reindex",
  MAINTENANCE: "pdm.maintenance",
});

export const PDM_JOB_TYPES = [
  {
    code: "PDM_STRUCTURE_RESOLVE",
    name: "PDM structure resolution",
    description: "Resolve a PDM structure with revision, configuration and effectivity context.",
    source_module: SOURCE_MODULE,
    handler: PDM_HANDLER_CODES.STRUCTURE,
    queues: ["pdm", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "PDM_WHERE_USED",
    name: "PDM where-used",
    description: "Resolve direct and multi-level where-used parents for a PDM object.",
    source_module: SOURCE_MODULE,
    handler: PDM_HANDLER_CODES.WHERE_USED,
    queues: ["pdm", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "PDM_WHERE_REFERENCED",
    name: "PDM where-referenced",
    description: "Resolve direct and recursive references to a PDM object.",
    source_module: SOURCE_MODULE,
    handler: PDM_HANDLER_CODES.WHERE_REFERENCED,
    queues: ["pdm", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "PDM_BASELINE_CREATE",
    name: "PDM baseline creation",
    description: "Create and optionally freeze a controlled PDM baseline snapshot.",
    source_module: SOURCE_MODULE,
    handler: PDM_HANDLER_CODES.BASELINE,
    queues: ["pdm", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "PDM_VALIDATE",
    name: "PDM validation",
    description: "Run the configurable PDM validation rules over an item or tenant.",
    source_module: SOURCE_MODULE,
    handler: PDM_HANDLER_CODES.VALIDATE,
    queues: ["pdm", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "PDM_REINDEX",
    name: "PDM search reindex",
    description: "Reindex PDM items, revisions, datasets and baselines for search.",
    source_module: SOURCE_MODULE,
    handler: PDM_HANDLER_CODES.REINDEX,
    queues: ["pdm", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "PDM_MAINTENANCE",
    name: "PDM maintenance",
    description: "Prune history, repair orphaned references and refresh caches.",
    source_module: SOURCE_MODULE,
    handler: PDM_HANDLER_CODES.MAINTENANCE,
    queues: ["default"],
    timeout_seconds: 1800,
    max_retries: 1,
    default_priority: "low",
  },
];

// ── Domain events ────────────────────────────────────────────────────────────

export const PDM_EVENT_TYPES = [
  { code: "PdmItemCreated", description: "A PDM item was created." },
  { code: "PdmItemUpdated", description: "A PDM item was updated." },
  { code: "PdmItemDeleted", description: "A PDM item was deleted." },
  { code: "PdmItemStatusChanged", description: "A PDM item changed lifecycle status." },
  { code: "PdmRevisionCreated", description: "A PDM item revision was created." },
  { code: "PdmRevisionRevised", description: "A PDM revision was revised from another revision." },
  { code: "PdmRevisionReleased", description: "A PDM revision was released." },
  { code: "PdmRevisionStatusChanged", description: "A PDM revision changed lifecycle status." },
  { code: "PdmDatasetCreated", description: "A PDM dataset was created." },
  { code: "PdmDatasetUpdated", description: "A PDM dataset was updated." },
  { code: "PdmDatasetDeleted", description: "A PDM dataset was deleted." },
  { code: "PdmDatasetContentLinked", description: "Content was linked to a PDM dataset." },
  { code: "PdmRepresentationCreated", description: "A PDM representation was created." },
  { code: "PdmRepresentationDeleted", description: "A PDM representation was removed." },
  { code: "PdmDesignDataLinked", description: "Design data was linked to a revision." },
  { code: "PdmDesignDataUnlinked", description: "Design data was unlinked from a revision." },
  { code: "PdmCadAssociationCreated", description: "A CAD association was created." },
  { code: "PdmCadAssociationRemoved", description: "A CAD association was removed." },
  { code: "PdmRevisionRuleCreated", description: "A PDM revision rule was created." },
  { code: "PdmRevisionRuleActivated", description: "A PDM revision rule was activated." },
  { code: "PdmRevisionRuleVersionPublished", description: "A revision rule version was published." },
  { code: "PdmConfigurationRuleCreated", description: "A PDM configuration rule was created." },
  { code: "PdmConfigurationRuleActivated", description: "A PDM configuration rule was activated." },
  { code: "PdmConfigurationRuleVersionPublished", description: "A configuration rule version was published." },
  { code: "PdmBaselineCreated", description: "A PDM baseline was created." },
  { code: "PdmBaselineReleased", description: "A PDM baseline was released." },
  { code: "PdmBaselineFrozen", description: "A PDM baseline was frozen." },
  { code: "PdmStructureResolved", description: "A PDM structure was resolved." },
  { code: "PdmWhereUsedRun", description: "A where-used analysis completed." },
  { code: "PdmWhereReferencedRun", description: "A where-referenced analysis completed." },
  { code: "PdmValidationCompleted", description: "A PDM validation run completed." },
  { code: "PdmBulkCompleted", description: "A bulk PDM job completed." },
];

// ── Tenant configuration ─────────────────────────────────────────────────────

export const CONFIG_DEFAULTS = Object.freeze({
  default_item_status: "DRAFT",
  default_revision_status: "DRAFT",
  enforce_unique_item_number: true,
  enforce_unique_revision_number: true,
  allow_manual_numbers: true,
  auto_create_initial_revision: true,
  immutable_released_revisions: true,
  baseline_immutable: true,
  allow_duplicate_cad_associations: false,
  default_representation_type: "3D",
  revision_rule_default: "LATEST_RELEASED",
  configuration_rule_default: "VARIANT",
  max_structure_depth: 200,
  max_traversal_nodes: 200000,
  bulk_batch_size: 500,
  max_bulk_objects: 50000,
  cache_ttl_seconds: 300,
  history_retention_days: 365,
  search_page_size: 50,
});

export const CONFIG_BOUNDS = Object.freeze({
  max_structure_depth: { min: 1, max: 1000 },
  max_traversal_nodes: { min: 1, max: 5000000 },
  bulk_batch_size: { min: 1, max: 10000 },
  max_bulk_objects: { min: 1, max: 1000000 },
  cache_ttl_seconds: { min: 0, max: 86400 },
  history_retention_days: { min: 1, max: 3650 },
  search_page_size: { min: 1, max: 1000 },
});

// ── Search integration ───────────────────────────────────────────────────────

export const SEARCH_OBJECT_TYPES = [
  { code: "pdm_item", name: "PDM items", description: "PDM items (parts, products, documents) with number, type, lifecycle and ownership." },
  { code: "pdm_revision", name: "PDM item revisions", description: "PDM item revisions with status, configuration and effectivity." },
  { code: "pdm_dataset", name: "PDM datasets", description: "PDM datasets with type, content reference and lifecycle." },
  { code: "pdm_representation", name: "PDM representations", description: "PDM representations of items, revisions and datasets." },
  { code: "pdm_cad_association", name: "PDM CAD associations", description: "CAD associations between revisions and CAD datasets." },
  { code: "pdm_baseline", name: "PDM baselines", description: "Controlled PDM baselines and their members." },
];

export const DAY_MS = 24 * 60 * 60 * 1000;
