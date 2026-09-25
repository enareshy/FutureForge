// Single source of truth for the P1 Digital Thread vocabulary.
//
// Everything configurable about the thread (domains, semantic links, statuses,
// limits, IAM resources, job/event/handler codes, searchable types and platform
// defaults) lives here so the traversal engine, API and UI never hard-code the
// Requirement -> Service sequence.
export const SOURCE_MODULE = "thread";

export const THREAD_STATUSES = Object.freeze(["ACTIVE", "INACTIVE", "ARCHIVED"]);
export const THREAD_TYPES = Object.freeze([
  "PRODUCT_DEVELOPMENT",
  "REQUIREMENT_TRACEABILITY",
  "CHANGE_IMPACT",
  "MANUFACTURING",
  "QUALITY",
  "SERVICE",
  "CUSTOM",
]);

export const SNAPSHOT_STATUSES = Object.freeze(["DRAFT", "FROZEN", "ARCHIVED"]);
export const BASELINE_STATUSES = Object.freeze(["DRAFT", "RELEASED", "FROZEN", "ARCHIVED"]);
export const IMMUTABLE_BASELINE_STATUSES = Object.freeze(["RELEASED", "FROZEN"]);
export const PROJECTION_CONSISTENCY = Object.freeze(["CURRENT", "UPDATING", "STALE", "FAILED"]);
export const COMPLETENESS_STATES = Object.freeze(["COMPLETE", "INCOMPLETE", "BROKEN_LINK", "MISSING_DOWNSTREAM", "MISSING_UPSTREAM"]);
export const COMPLETENESS_STATE = Object.freeze(Object.fromEntries(COMPLETENESS_STATES.map((state) => [state, state])));
export const COMPARE_RESULT_TYPES = Object.freeze([
  "ADDED_NODE",
  "REMOVED_NODE",
  "CHANGED_NODE",
  "ADDED_RELATIONSHIP",
  "REMOVED_RELATIONSHIP",
  "CHANGED_REVISION",
  "CHANGED_EFFECTIVITY",
  "CHANGED_CONFIGURATION",
]);
export const COMPARE_RESULT_TYPE = Object.freeze(Object.fromEntries(COMPARE_RESULT_TYPES.map((type) => [type, type])));

export const DIRECTIONS = Object.freeze(["UPSTREAM", "DOWNSTREAM", "BOTH"]);
export const LINK_DIRECTIONS = Object.freeze(["OUT", "IN", "BOTH"]);
export const SEVERITIES = Object.freeze(["INFO", "WARNING", "ERROR"]);

// ── Domain catalog ───────────────────────────────────────────────────────────
// A domain is a logical lifecycle stage. `object_types` lists the registered
// object type codes that resolve to it by default; a definition may override
// them. Labels/colours/order drive the UI and reports, not the engine.

export const DOMAIN_TYPES = Object.freeze([
  { code: "REQUIREMENT", label: "Requirement", color: "#7c9cff", icon: "requirement", order: 10, object_types: ["requirement"] },
  { code: "SYSTEM", label: "System", color: "#5bc0eb", icon: "system", order: 20, object_types: ["system"] },
  { code: "DESIGN", label: "Design", color: "#3ee0c0", icon: "design", order: 30, object_types: ["design"] },
  { code: "PART", label: "Part", color: "#f5c15a", icon: "part", order: 40, object_types: ["part"] },
  { code: "PRODUCT", label: "Product", color: "#ffb454", icon: "product", order: 50, object_types: ["product"] },
  { code: "EBOM", label: "Engineering BOM", color: "#c792ea", icon: "ebom", order: 60, object_types: ["ebom"] },
  { code: "MBOM", label: "Manufacturing BOM", color: "#a784ff", icon: "mbom", order: 70, object_types: ["mbom"] },
  { code: "BOP", label: "Bill of process", color: "#ff8fab", icon: "bop", order: 80, object_types: ["bop"] },
  { code: "MANUFACTURING", label: "Manufacturing", color: "#ff6b7a", icon: "manufacturing", order: 90, object_types: ["manufacturing-order", "operation"] },
  { code: "QUALITY", label: "Quality", color: "#6ee7a8", icon: "quality", order: 100, object_types: ["quality-issue", "inspection"] },
  { code: "SERVICE", label: "Service", color: "#8ab4f8", icon: "service", order: 110, object_types: ["service-item", "service-event"] },
]);

export const DOMAIN_CODES = Object.freeze(DOMAIN_TYPES.map((entry) => entry.code));

// ── Traceability link semantics ──────────────────────────────────────────────
// Maps a semantic link name to a registered Object & Relationship relationship
// type. The registry is the default; definitions may declare additional links
// through their relationship list, so the model is extensible without code.

export const TRACEABILITY_LINKS = Object.freeze([
  { code: "SATISFIES", name: "Satisfies", source_domain: "REQUIREMENT", target_domain: "SYSTEM", relationship_type: "requirement.satisfies.system" },
  { code: "ALLOCATED_TO", name: "Allocated to", source_domain: "REQUIREMENT", target_domain: "DESIGN", relationship_type: "requirement.allocated-to.design" },
  { code: "REALIZED_BY", name: "Realized by", source_domain: "SYSTEM", target_domain: "DESIGN", relationship_type: "system.realized-by.design" },
  { code: "IMPLEMENTED_BY", name: "Implemented by", source_domain: "DESIGN", target_domain: "PART", relationship_type: "design.implemented-by.part" },
  { code: "USED_IN", name: "Used in", source_domain: "PART", target_domain: "EBOM", relationship_type: "part.used-in.ebom" },
  { code: "TRANSFORMED_TO", name: "Transformed to", source_domain: "EBOM", target_domain: "MBOM", relationship_type: "ebom.transformed-to.mbom" },
  { code: "REALIZED_AS", name: "Realized as", source_domain: "MBOM", target_domain: "BOP", relationship_type: "mbom.realized-as.bop" },
  { code: "EXECUTED_IN", name: "Executed in", source_domain: "BOP", target_domain: "MANUFACTURING", relationship_type: "bop.executed-in.manufacturing" },
  { code: "PRODUCES", name: "Produces", source_domain: "MANUFACTURING", target_domain: "QUALITY", relationship_type: "manufacturing.produces.quality" },
  { code: "APPLIES_TO", name: "Applies to", source_domain: "QUALITY", target_domain: "PRODUCT", relationship_type: "quality.applies-to.product" },
  { code: "SUPPORTED_BY", name: "Supported by", source_domain: "PRODUCT", target_domain: "SERVICE", relationship_type: "product.supported-by.service" },
  { code: "DERIVED_FROM", name: "Derived from", source_domain: "PART", target_domain: "DESIGN", relationship_type: "part.derived-from.design" },
  { code: "DEPENDS_ON", name: "Depends on", source_domain: "*", target_domain: "*", relationship_type: "thread.depends-on" },
]);

export const LINK_SEMANTICS = Object.freeze(TRACEABILITY_LINKS.map((entry) => entry.code));
export const DEFAULT_DEFINITION_CODE = "PRODUCT-DEVELOPMENT";

// ── Limits & bounds ──────────────────────────────────────────────────────────
export const MAX_DEPTH = 50;
export const MAX_NODES = 20000;
export const MAX_EDGES = 50000;
export const MAX_PATHS = 200;
export const MAX_PATH_DEPTH = 20;
export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_MAX_DEPTH = 25;
export const DEFAULT_MAX_NODES = 10000;
export const DEFAULT_MAX_PATHS = 50;
export const DEFAULT_QUERY_TIMEOUT_MS = 20000;

// ── IAM resources ────────────────────────────────────────────────────────────
export const THREAD_RESOURCES = Object.freeze({
  module: "iam.thread",
  overview: "iam.thread.overview",
  explorer: "iam.thread.explorer",
  traceability: "iam.thread.traceability",
  impact: "iam.thread.impact",
  paths: "iam.thread.paths",
  definitions: "iam.thread.definitions",
  snapshots: "iam.thread.snapshots",
  baselines: "iam.thread.baselines",
  compare: "iam.thread.compare",
  completeness: "iam.thread.completeness",
  search: "iam.thread.search",
  auditTrail: "iam.thread.audit",
  metrics: "iam.thread.metrics",
  admin: "iam.thread.admin",
});

// ── Background jobs ──────────────────────────────────────────────────────────
export const THREAD_HANDLER_CODES = Object.freeze({
  TRAVERSAL: "thread.traversal",
  IMPACT: "thread.impact",
  PATH: "thread.path",
  SNAPSHOT: "thread.snapshot.create",
  BASELINE: "thread.baseline.create",
  COMPLETENESS: "thread.completeness",
  REINDEX: "thread.reindex",
  PROJECTION_REBUILD: "thread.projection.rebuild",
  MAINTENANCE: "thread.maintenance",
});

export const THREAD_JOB_TYPES = [
  {
    code: "THREAD_TRAVERSAL",
    name: "Digital thread traversal",
    description: "Traverse the digital thread with revision, effectivity and configuration context.",
    source_module: SOURCE_MODULE,
    handler: THREAD_HANDLER_CODES.TRAVERSAL,
    queues: ["thread", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "THREAD_IMPACT",
    name: "Digital thread impact analysis",
    description: "Resolve direct and indirect impact for a digital thread root object.",
    source_module: SOURCE_MODULE,
    handler: THREAD_HANDLER_CODES.IMPACT,
    queues: ["thread", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "THREAD_PATH",
    name: "Digital thread path analysis",
    description: "Find traceability paths between two objects within a bounded depth.",
    source_module: SOURCE_MODULE,
    handler: THREAD_HANDLER_CODES.PATH,
    queues: ["thread", "default"],
    timeout_seconds: 1800,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "THREAD_SNAPSHOT_CREATE",
    name: "Digital thread snapshot",
    description: "Materialise and freeze an immutable digital thread snapshot.",
    source_module: SOURCE_MODULE,
    handler: THREAD_HANDLER_CODES.SNAPSHOT,
    queues: ["thread", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "THREAD_BASELINE_CREATE",
    name: "Digital thread baseline",
    description: "Create a controlled digital thread baseline from a snapshot.",
    source_module: SOURCE_MODULE,
    handler: THREAD_HANDLER_CODES.BASELINE,
    queues: ["thread", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "THREAD_COMPLETENESS",
    name: "Digital thread completeness",
    description: "Evaluate traceability completeness against configured rules.",
    source_module: SOURCE_MODULE,
    handler: THREAD_HANDLER_CODES.COMPLETENESS,
    queues: ["thread", "default"],
    timeout_seconds: 1800,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "THREAD_REINDEX",
    name: "Digital thread search reindex",
    description: "Reindex the digital thread projection into enterprise search.",
    source_module: SOURCE_MODULE,
    handler: THREAD_HANDLER_CODES.REINDEX,
    queues: ["thread", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "low",
  },
  {
    code: "THREAD_PROJECTION_REBUILD",
    name: "Digital thread projection rebuild",
    description: "Rebuild the derived digital thread projection from source events.",
    source_module: SOURCE_MODULE,
    handler: THREAD_HANDLER_CODES.PROJECTION_REBUILD,
    queues: ["thread", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "low",
  },
  {
    code: "THREAD_MAINTENANCE",
    name: "Digital thread maintenance",
    description: "Prune query history, reconcile projections and refresh caches.",
    source_module: SOURCE_MODULE,
    handler: THREAD_HANDLER_CODES.MAINTENANCE,
    queues: ["default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "low",
  },
];

// ── Domain events ────────────────────────────────────────────────────────────
export const THREAD_EVENT_TYPES = [
  { code: "ThreadDefinitionCreated", description: "A digital thread definition was created." },
  { code: "ThreadDefinitionUpdated", description: "A digital thread definition was updated." },
  { code: "ThreadDefinitionActivated", description: "A digital thread definition was activated." },
  { code: "ThreadTraversalRun", description: "A digital thread traversal was executed." },
  { code: "ThreadImpactRun", description: "A digital thread impact analysis was executed." },
  { code: "ThreadPathRun", description: "A digital thread path analysis was executed." },
  { code: "ThreadSnapshotCreated", description: "A digital thread snapshot was frozen." },
  { code: "ThreadBaselineCreated", description: "A digital thread baseline was created." },
  { code: "ThreadBaselineReleased", description: "A digital thread baseline was released and became immutable." },
  { code: "ThreadBaselineFrozen", description: "A digital thread baseline was frozen." },
  { code: "ThreadCompareRun", description: "Two thread projections were compared." },
  { code: "ThreadCompletenessRun", description: "Traceability completeness was evaluated." },
  { code: "ThreadProjectionUpdated", description: "A derived digital thread projection was updated from a source event." },
  { code: "ThreadProjectionFailed", description: "Updating a derived digital thread projection failed." },
  { code: "ThreadProjectionRebuilt", description: "The derived digital thread projection was rebuilt." },
];

export const THREAD_EVENT_MAP = Object.freeze({
  DEFINITION_CREATED: "ThreadDefinitionCreated",
  DEFINITION_UPDATED: "ThreadDefinitionUpdated",
  DEFINITION_ACTIVATED: "ThreadDefinitionActivated",
  TRAVERSAL_RUN: "ThreadTraversalRun",
  IMPACT_RUN: "ThreadImpactRun",
  PATH_RUN: "ThreadPathRun",
  SNAPSHOT_CREATED: "ThreadSnapshotCreated",
  BASELINE_CREATED: "ThreadBaselineCreated",
  BASELINE_RELEASED: "ThreadBaselineReleased",
  BASELINE_FROZEN: "ThreadBaselineFrozen",
  COMPARE_RUN: "ThreadCompareRun",
  COMPLETENESS_RUN: "ThreadCompletenessRun",
  PROJECTION_UPDATED: "ThreadProjectionUpdated",
  PROJECTION_FAILED: "ThreadProjectionFailed",
  PROJECTION_REBUILT: "ThreadProjectionRebuilt",
});

// Source events consumed to keep the derived thread projection fresh. These are
// published by the Object/Relationship, PDM, BOM and Lifecycle frameworks.
export const THREAD_SOURCE_EVENTS = Object.freeze([
  "ObjectCreated",
  "ObjectUpdated",
  "ObjectDeleted",
  "RelationshipCreated",
  "RelationshipDeleted",
  "PdmItemCreated",
  "PdmItemUpdated",
  "PdmItemStatusChanged",
  "PdmRevisionCreated",
  "PdmRevisionReleased",
  "PdmRevisionStatusChanged",
  "BomCreated",
  "BomRevisionCreated",
  "BomLineAdded",
  "BomLineRemoved",
  "EffectivityChanged",
  "ConfigurationChanged",
  "LifecycleChanged",
  "RequirementCreated",
  "RequirementUpdated",
  "SystemUpdated",
  "DesignUpdated",
  "ManufacturingUpdated",
  "QualityUpdated",
  "ServiceUpdated",
]);

// ── Configuration defaults ───────────────────────────────────────────────────
export const CONFIG_DEFAULTS = Object.freeze({
  max_traversal_depth: DEFAULT_MAX_DEPTH,
  max_traversal_nodes: DEFAULT_MAX_NODES,
  max_paths: DEFAULT_MAX_PATHS,
  max_path_depth: MAX_PATH_DEPTH,
  query_timeout_ms: DEFAULT_QUERY_TIMEOUT_MS,
  cache_ttl_seconds: 300,
  default_definition_code: DEFAULT_DEFINITION_CODE,
  projection_enabled: true,
  allow_cross_domain: true,
  include_inactive_nodes: false,
  impact_max_depth: 15,
});

export const CONFIG_BOUNDS = Object.freeze({
  max_traversal_depth: { min: 1, max: MAX_DEPTH },
  max_traversal_nodes: { min: 10, max: MAX_NODES },
  max_paths: { min: 1, max: MAX_PATHS },
  max_path_depth: { min: 1, max: MAX_PATH_DEPTH },
  query_timeout_ms: { min: 1000, max: 120000 },
  cache_ttl_seconds: { min: 0, max: 3600 },
  impact_max_depth: { min: 1, max: MAX_DEPTH },
});

// ── Search integration ───────────────────────────────────────────────────────
export const SEARCH_OBJECT_TYPES = [
  { code: "thread_definition", name: "Digital thread definition", description: "Configurable digital thread definitions." },
  { code: "thread_snapshot", name: "Digital thread snapshot", description: "Immutable digital thread snapshots." },
  { code: "thread_baseline", name: "Digital thread baseline", description: "Controlled digital thread baselines." },
];

// Built-in provider codes. Domains can register additional providers through the
// provider registry, which keeps traversal generic and avoids another graph.
export const PROVIDERS = Object.freeze({
  OBJECT: "object",
  PDM: "pdm",
  BOM: "bom",
});
