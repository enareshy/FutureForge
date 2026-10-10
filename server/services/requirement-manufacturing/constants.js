// Vocabulary, defaults and platform wiring codes for the Requirement ->
// Manufacturing traceability layer.
//
// This is a composition layer, not a second manufacturing model. Requirement
// identity and edges stay in the Requirements Manager; EBOM/MBOM/BOP stay in the
// BOM engine; operations, work centers and characteristics reuse the Object &
// Relationship framework and Classification. Here we only declare the shared
// vocabulary (node/relationship codes, IAM codes, event types and configuration
// keys) that lets the domains be traced together without duplicating any of
// them.
export const SOURCE_MODULE = "requirement-manufacturing";

// The requirement side of an allocation edge is always a Requirement business
// object, addressed by its Object framework id so the Digital Thread resolves it
// through the standard object provider.
export const REQUIREMENT_SOURCE_TYPE = "requirement";

// Metadata (business object) types this layer registers. Operations and work
// centers are first-class generic objects; the Digital Thread already reserves
// the `operation` object type for the MANUFACTURING domain and the BOM provider
// already treats a BOP line whose child type is `operation` as a bridge.
export const MANUFACTURING_OBJECT_TYPES = Object.freeze([
  { code: "operation", name: "Operation", description: "A manufacturing operation defined within a Bill of Process." },
  { code: "work_center", name: "Work Center", description: "A plant/site manufacturing work center operations are performed at." },
]);

export const OPERATION_OBJECT_TYPE = "operation";
export const WORK_CENTER_OBJECT_TYPE = "work_center";

// Codes of the metadata object types this layer actually registers. Only these
// can be used as typed `relationship_types` endpoints (the Object framework
// resolves endpoint refs through `metadata_types`). Characteristic/document
// nodes belong to Classification/Content and are resolved by the manufacturing
// thread provider, not by a registered object type, so their relationship
// endpoints stay untyped (null).
export const MANUFACTURING_OBJECT_TYPE_CODES = Object.freeze(MANUFACTURING_OBJECT_TYPES.map((entry) => entry.code));

// Node types used as the target side of allocation and trace edges. These match
// the object types exposed by the PDM/BOM/Object thread providers, so a trace
// edge resolves without translation. EBOM/MBOM/BOP share the single BOM
// revision node type (the concrete structure is derived from the BOM header's
// bom_type); operations/work centers reuse the generic Object provider.
export const MANUFACTURING_NODE_TYPES = Object.freeze({
  PRODUCT: "pdm_item",
  PRODUCT_REVISION: "pdm_revision",
  EBOM: "bom_revision",
  MBOM: "bom_revision",
  BOP: "bom_revision",
  OPERATION: "operation",
  WORK_CENTER: "work_center",
  CHARACTERISTIC: "characteristic",
  DOCUMENT: "content",
});

// Maps an allocation target type to the table/facade that owns the artifact.
// `object_column` is the generic object id when the domain registers one;
// `ref_column`/`number_column` identify the artifact for audit and display.
export const TARGET_SOURCES = Object.freeze({
  pdm_item: { table: "pdm_items", ref_column: "item_ref", number_column: "item_number", object_column: "object_id", label: "PDM item" },
  pdm_revision: { table: "pdm_item_revisions", ref_column: "revision_ref", number_column: "revision_number", object_column: "object_id", label: "PDM item revision" },
  bom_revision: { table: "bom_revisions", ref_column: "revision_ref", number_column: "revision_number", object_column: "object_id", label: "BOM revision" },
  operation: { table: "objects", ref_column: "code", number_column: "code", object_column: "id", label: "Operation" },
  work_center: { table: "objects", ref_column: "code", number_column: "code", object_column: "id", label: "Work center" },
  characteristic: { table: "cla_characteristics", ref_column: "characteristic_ref", number_column: "code", object_column: null, label: "Characteristic" },
  content: { table: "content", ref_column: "content_id", number_column: "content_key", object_column: null, label: "Document" },
});

export const TARGET_NODE_TYPES = Object.freeze(Object.keys(TARGET_SOURCES));

// Allocation relationship semantics. Each is a Requirements Manager edge type
// (see requirements/constants.js RELATIONSHIP_TYPES) stored in the existing
// requirement_relationships table; this layer adds manufacturing meaning on top
// and never creates a parallel relationship store.
//
// A requirement allocated to an MBOM revision, to an operation, and to a CTQ
// characteristic is distinguishable because the relationship type and the
// target object type differ.
export const ALLOCATION_TYPES = Object.freeze([
  {
    code: "ALLOCATED_TO",
    name: "Allocated to",
    description: "The requirement is allocated to a PDM product or item.",
    target_types: [MANUFACTURING_NODE_TYPES.PRODUCT],
    direction: "FORWARD",
  },
  {
    code: "IMPLEMENTED_BY",
    name: "Implemented by",
    description: "The requirement is implemented by an EBOM or MBOM revision/item.",
    target_types: [MANUFACTURING_NODE_TYPES.EBOM, MANUFACTURING_NODE_TYPES.MBOM, MANUFACTURING_NODE_TYPES.PRODUCT_REVISION],
    direction: "FORWARD",
  },
  {
    code: "REALIZED_BY",
    name: "Realized by",
    description: "The requirement is realized by a BOP / process plan or an operation.",
    target_types: [MANUFACTURING_NODE_TYPES.BOP, MANUFACTURING_NODE_TYPES.OPERATION],
    direction: "FORWARD",
  },
  {
    code: "SATISFIED_BY",
    name: "Satisfied by",
    description: "The requirement is satisfied by a manufacturing structure or work center.",
    target_types: [MANUFACTURING_NODE_TYPES.MBOM, MANUFACTURING_NODE_TYPES.BOP, MANUFACTURING_NODE_TYPES.WORK_CENTER],
    direction: "FORWARD",
  },
  {
    code: "GOVERNED_BY",
    name: "Governed by",
    description: "The requirement is governed by a manufacturing characteristic or process constraint.",
    target_types: [MANUFACTURING_NODE_TYPES.CHARACTERISTIC],
    direction: "FORWARD",
  },
  {
    code: "CONTROLLED_BY",
    name: "Controlled by",
    description: "The requirement is controlled by a critical-to-quality (CTQ) characteristic.",
    target_types: [MANUFACTURING_NODE_TYPES.CHARACTERISTIC],
    direction: "FORWARD",
  },
  {
    code: "REPRESENTED_BY",
    name: "Represented by",
    description: "The requirement is represented by a manufacturing document or work instruction.",
    target_types: [MANUFACTURING_NODE_TYPES.DOCUMENT],
    direction: "FORWARD",
  },
]);

export const ALLOCATION_CODES = Object.freeze(ALLOCATION_TYPES.map((entry) => entry.code));

// Allocation lifecycle statuses reuse the Requirements Manager relationship
// status vocabulary (no parallel status model).
export const ALLOCATION_STATUSES = Object.freeze(["ACTIVE", "INACTIVE"]);

// Requirement allocation coverage, mirroring the Requirement -> PDM vocabulary.
export const COVERAGE_STATUSES = Object.freeze(["UNALLOCATED", "PARTIAL", "ALLOCATED", "SATISFIED"]);

// Compatibility of an allocation with the current manufacturing revision /
// configuration / effectivity.
export const COMPATIBILITY_STATUSES = Object.freeze(["UNKNOWN", "COMPATIBLE", "INCOMPATIBLE", "STALE"]);

// Structured trace/validation result model (Prompt 5 sections 16 & 23). Kept as
// data so clients branch on codes, never prose.
export const VALIDATION_STATUSES = Object.freeze([
  "VALID",
  "MISSING_LINK",
  "INVALID_LINK",
  "INCOMPATIBLE_REVISION",
  "CONFIGURATION_MISMATCH",
  "NOT_EFFECTIVE",
  "LIFECYCLE_VIOLATION",
  "PERMISSION_RESTRICTED",
  "PENDING_VALIDATION",
  "VALIDATION_ERROR",
]);

export const VALIDATION_SEVERITIES = Object.freeze(["INFO", "WARNING", "ERROR"]);

// Coverage/validation rule categories (section 16).
export const RULE_CATEGORIES = Object.freeze(["MUST", "SHOULD", "OPTIONAL", "FORBIDDEN"]);

// Manufacturing stages of the digital thread, in order. Used by the matrix and
// coverage projections; the concrete objects are always resolved through the
// Digital Thread, never hard-coded.
export const MANUFACTURING_STAGES = Object.freeze([
  "REQUIREMENT",
  "PRODUCT",
  "EBOM",
  "MBOM",
  "BOP",
  "OPERATION",
  "WORK_CENTER",
  "CHARACTERISTIC",
  "CTQ",
]);

// Object & relationship edge codes this layer registers (via the existing
// relationship-type registry). They are the non-requirement edges of the
// manufacturing thread; requirement-scoped edges reuse requirements
// RELATIONSHIP_TYPES.
export const MANUFACTURING_RELATIONSHIP_TYPES = Object.freeze([
  { code: "ebom.transformed-to.mbom", name: "EBOM transformed to MBOM", description: "An EBOM item/occurrence was transformed into an MBOM item/occurrence.", source_type: null, target_type: null, semantic: "association" },
  { code: "mbom.realized-as.bop", name: "MBOM realized as BOP", description: "An MBOM is realized by a Bill of Process.", source_type: null, target_type: null, semantic: "association" },
  { code: "bop.executed-in.manufacturing", name: "BOP executed in operation", description: "A Bill of Process is executed through a manufacturing operation.", source_type: null, target_type: "operation", semantic: "association" },
  { code: "operation.performed-at.work-center", name: "Operation performed at work center", description: "An operation is performed at a work center.", source_type: "operation", target_type: "work_center", semantic: "association" },
  { code: "operation.consumes.part", name: "Operation consumes part", description: "An operation consumes an MBOM item.", source_type: "operation", target_type: null, semantic: "association" },
  { code: "operation.precedes.operation", name: "Operation precedes operation", description: "An operation is a predecessor of another operation in the process sequence.", source_type: "operation", target_type: "operation", semantic: "association" },
  { code: "characteristic.applies-to.operation", name: "Characteristic applies to operation", description: "A manufacturing characteristic / constraint applies to an operation.", source_type: null, target_type: "operation", semantic: "association" },
]);

export const MANUFACTURING_RELATIONSHIP_CODES = Object.freeze(MANUFACTURING_RELATIONSHIP_TYPES.map((entry) => entry.code));

// ── IAM resources ────────────────────────────────────────────────────────────

export const REQUIREMENT_MANUFACTURING_RESOURCES = Object.freeze({
  module: "iam.requirement-manufacturing",
  overview: "iam.requirement-manufacturing.overview",
  allocations: "iam.requirement-manufacturing.allocations",
  coverage: "iam.requirement-manufacturing.coverage",
  traceability: "iam.requirement-manufacturing.traceability",
  transformations: "iam.requirement-manufacturing.transformations",
  operations: "iam.requirement-manufacturing.operations",
  characteristics: "iam.requirement-manufacturing.characteristics",
  ctq: "iam.requirement-manufacturing.ctq",
  workCenters: "iam.requirement-manufacturing.work-centers",
  impact: "iam.requirement-manufacturing.impact",
  changes: "iam.requirement-manufacturing.changes",
  metrics: "iam.requirement-manufacturing.metrics",
  admin: "iam.requirement-manufacturing.admin",
});

export const SECURITY_ACTIONS = Object.freeze([
  "VIEW_REQUIREMENT_MANUFACTURING",
  "MANAGE_MANUFACTURING_ALLOCATION",
  "REMOVE_MANUFACTURING_ALLOCATION",
  "VIEW_MANUFACTURING_TRACEABILITY",
  "VIEW_MANUFACTURING_COVERAGE",
  "VIEW_EBOM_MBOM_MAPPING",
  "VIEW_MANUFACTURING_OPERATIONS",
  "VIEW_MANUFACTURING_CHARACTERISTICS",
  "VIEW_MANUFACTURING_CTQ",
  "VIEW_MANUFACTURING_WORK_CENTERS",
  "ANALYZE_MANUFACTURING_IMPACT",
  "CONFIGURE_REQUIREMENT_MANUFACTURING",
]);

// ── Domain events ────────────────────────────────────────────────────────────

export const REQUIREMENT_MANUFACTURING_EVENT_TYPES = Object.freeze([
  { code: "RequirementManufacturingTraceCreated", description: "A requirement -> manufacturing traceability edge was created." },
  { code: "RequirementManufacturingTraceRemoved", description: "A requirement -> manufacturing traceability edge was removed." },
  { code: "EBOMMBOMMappingChanged", description: "An EBOM-to-MBOM transformation mapping changed." },
  { code: "RequirementManufacturingImpactDetected", description: "A change was detected to impact a requirement's manufacturing chain." },
  { code: "ManufacturingTraceabilityGapDetected", description: "A required manufacturing traceability link is missing or invalid." },
  { code: "ManufacturingTraceabilityValidationFailed", description: "A manufacturing traceability validation run failed." },
  { code: "ManufacturingTraceabilitySynchronized", description: "Manufacturing traceability was synchronized for a scope." },
]);

export const REQUIREMENT_MANUFACTURING_EVENT_MAP = Object.freeze({
  TRACE_CREATED: "RequirementManufacturingTraceCreated",
  TRACE_REMOVED: "RequirementManufacturingTraceRemoved",
  MAPPING_CHANGED: "EBOMMBOMMappingChanged",
  IMPACT_DETECTED: "RequirementManufacturingImpactDetected",
  GAP_DETECTED: "ManufacturingTraceabilityGapDetected",
  VALIDATION_FAILED: "ManufacturingTraceabilityValidationFailed",
  SYNCHRONIZED: "ManufacturingTraceabilitySynchronized",
});

// ── Change impact classification ─────────────────────────────────────────────
//
// Categories a Requirement -> Manufacturing impact analysis reports. Classification
// reuses the Digital Thread impact traversal; only the vocabulary is ours, so no
// second impact engine is introduced (Prompt 5, change impact integration).

export const MANUFACTURING_IMPACT_CATEGORIES = Object.freeze([
  "DIRECT",
  "INDIRECT",
  "CONFIGURATION",
  "EFFECTIVITY",
  "PROCESS",
  "CHARACTERISTIC",
  "CTQ",
  "DOCUMENT",
  "CHANGE",
]);

// Most specific classification wins when a node could belong to several.
export const MANUFACTURING_IMPACT_PRECEDENCE = Object.freeze([
  "CHANGE",
  "DOCUMENT",
  "CTQ",
  "CHARACTERISTIC",
  "PROCESS",
  "CONFIGURATION",
  "EFFECTIVITY",
  "DIRECT",
  "INDIRECT",
]);

export const MANUFACTURING_IMPACT_STATUSES = Object.freeze(["COMPLETED", "NOOP", "FAILED"]);

// Object types the impact classifier treats as Change Management artifacts. These
// are the existing Change module's node types; the classifier only names them.
export const CHANGE_NODE_TYPES = Object.freeze(["change_request", "change_order", "change_notice"]);

// ── Background jobs ──────────────────────────────────────────────────────────

export const REQUIREMENT_MANUFACTURING_HANDLER_CODES = Object.freeze({
  IMPACT_ANALYSIS: "requirement-manufacturing.impactAnalysis",
  GAP_SWEEP: "requirement-manufacturing.gapSweep",
  NODE_IMPACT: "requirement-manufacturing.nodeImpact",
});

export const REQUIREMENT_MANUFACTURING_JOB_TYPES = [
  {
    code: "MANUFACTURING_IMPACT_ANALYSIS",
    name: "Requirement/Manufacturing impact analysis",
    description: "Traverse the Digital Thread from a requirement and classify impacted Product, EBOM, MBOM, BOP, Operation, Work center, Characteristic, CTQ, Document and Change objects.",
    source_module: SOURCE_MODULE,
    handler: REQUIREMENT_MANUFACTURING_HANDLER_CODES.IMPACT_ANALYSIS,
    queues: ["requirement-manufacturing", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "MANUFACTURING_GAP_SWEEP",
    name: "Requirement/Manufacturing traceability gap sweep",
    description: "Sweep the manufactured requirements of a tenant, evaluate the configured coverage rules and publish gap events for missing or invalid links.",
    source_module: SOURCE_MODULE,
    handler: REQUIREMENT_MANUFACTURING_HANDLER_CODES.GAP_SWEEP,
    queues: ["requirement-manufacturing", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "low",
  },
  {
    code: "MANUFACTURING_NODE_IMPACT",
    name: "Requirement/Manufacturing node impact",
    description: "Propagate a Product, EBOM, MBOM or BOP change to the requirements linked to it, classify the impact and publish impact events.",
    source_module: SOURCE_MODULE,
    handler: REQUIREMENT_MANUFACTURING_HANDLER_CODES.NODE_IMPACT,
    queues: ["requirement-manufacturing", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "normal",
  },
];

export const REQUIREMENT_MANUFACTURING_QUEUE = "requirement-manufacturing";

// ── Integration & Event Framework wiring ─────────────────────────────────────

export const REQUIREMENT_MANUFACTURING_INTEGRATION = Object.freeze({
  impactHandler: "requirement-manufacturing.impact",
  nodeEventHandler: "requirement-manufacturing.node-change",
  traceEventHandler: "requirement-manufacturing.trace-change",
  messageType: "requirement_manufacturing.impact",
  queue: "INTEGRATION",
  subscriptionPrefix: "req-mfg",
});

// Manufacturing/PLM lifecycle events that can invalidate a requirement's
// manufacturing trace. `node_type` is the manufacturing target node the event
// concerns; `id_keys` lists the payload fields that may carry its id, in
// priority order. The handler resolves the node, finds the requirements linked
// to it through their allocations and classifies the impact, so no manufacturing
// object is copied here (mirrors requirement-pdm subscriptions).
export const REQUIREMENT_MANUFACTURING_NODE_SUBSCRIPTIONS = Object.freeze([
  { event_type_code: "BomRevisionReleased", node_type: "bom_revision", id_keys: ["bom_revision_id", "revision_id", "id"] },
  { event_type_code: "BomRevisionRevised", node_type: "bom_revision", id_keys: ["bom_revision_id", "revision_id", "id"] },
  { event_type_code: "BomRevisionStatusChanged", node_type: "bom_revision", id_keys: ["bom_revision_id", "revision_id", "id"] },
  { event_type_code: "BomTransformationCompleted", node_type: "bom_revision", id_keys: ["revision_id", "bom_revision_id", "id"] },
  { event_type_code: "PdmRevisionReleased", node_type: "pdm_revision", id_keys: ["pdm_revision_id", "revision_id", "id"] },
  { event_type_code: "PdmRevisionRevised", node_type: "pdm_revision", id_keys: ["pdm_revision_id", "revision_id", "id"] },
]);

// Own trace events that warrant a fresh gap evaluation for the affected
// requirement. Consuming our own events keeps the gap logic in one place and
// avoids polling.
export const REQUIREMENT_MANUFACTURING_TRACE_SUBSCRIPTIONS = Object.freeze([
  { event_type_code: "RequirementManufacturingTraceCreated" },
  { event_type_code: "RequirementManufacturingTraceRemoved" },
  { event_type_code: "EBOMMBOMMappingChanged" },
]);

// ── IAM action aliases ───────────────────────────────────────────────────────

export const RESOURCE_FOR = Object.freeze({
  ALLOCATED_TO: REQUIREMENT_MANUFACTURING_RESOURCES.allocations,
  IMPLEMENTED_BY: REQUIREMENT_MANUFACTURING_RESOURCES.allocations,
  REALIZED_BY: REQUIREMENT_MANUFACTURING_RESOURCES.allocations,
  SATISFIED_BY: REQUIREMENT_MANUFACTURING_RESOURCES.allocations,
  GOVERNED_BY: REQUIREMENT_MANUFACTURING_RESOURCES.characteristics,
  CONTROLLED_BY: REQUIREMENT_MANUFACTURING_RESOURCES.ctq,
  REPRESENTED_BY: REQUIREMENT_MANUFACTURING_RESOURCES.allocations,
});

// ── Configuration keys (registered in the platform config catalog) ───────────

export const CONFIG_PREFIX = "requirement_manufacturing.";

export const CONFIG_KEYS = Object.freeze({
  autoTraceOnAllocation: "requirement_manufacturing.auto_trace_on_allocation",
  requireTargetReleased: "requirement_manufacturing.require_target_released",
  enforceEffectivity: "requirement_manufacturing.enforce_effectivity",
  defaultConfigurationContext: "requirement_manufacturing.default_configuration_context",
  traceProvenance: "requirement_manufacturing.trace_provenance",
  requireEbomMbomMapping: "requirement_manufacturing.require_ebom_mbom_mapping",
  requireMbomBopAssignment: "requirement_manufacturing.require_mbom_bop_assignment",
  requireOperationWorkCenter: "requirement_manufacturing.require_operation_work_center",
  ctqEnabled: "requirement_manufacturing.ctq_enabled",
  requireCtqForCritical: "requirement_manufacturing.require_ctq_for_critical",
  ctqCriticality: "requirement_manufacturing.ctq_criticality",
  coverageRules: "requirement_manufacturing.coverage_rules",
  impactMaxDepth: "requirement_manufacturing.impact_max_depth",
  syncBatchSize: "requirement_manufacturing.sync_batch_size",
  notifyOnImpact: "requirement_manufacturing.notify_on_impact",
});

export const CONFIG_DEFAULTS = Object.freeze({
  auto_trace_on_allocation: true,
  require_target_released: false,
  enforce_effectivity: true,
  default_configuration_context: "",
  trace_provenance: true,
  require_ebom_mbom_mapping: true,
  require_mbom_bop_assignment: false,
  require_operation_work_center: false,
  ctq_enabled: true,
  require_ctq_for_critical: false,
  ctq_criticality: "HIGH,CRITICAL",
  coverage_rules: "MUST:EBOM_MBOM_MAPPING,MUST:REQUIREMENT_IMPLEMENTATION,SHOULD:MBOM_BOP_ASSIGNMENT,SHOULD:CTQ_COVERAGE",
  impact_max_depth: 10,
  sync_batch_size: 200,
  notify_on_impact: true,
});

export const CONFIG_BOUNDS = Object.freeze({
  impact_max_depth: { min: 1, max: 50 },
  sync_batch_size: { min: 1, max: 5000 },
});

// ── Bounds ───────────────────────────────────────────────────────────────────

export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_IMPACT_DEPTH = 50;

// ── Synchronization statuses ─────────────────────────────────────────────────

export const SYNC_STATUSES = Object.freeze(["COMPLETED", "PARTIAL", "FAILED", "NOOP"]);
