// Vocabulary, defaults and platform wiring codes for the Requirement -> PDM
// integration.
//
// This module is a composition layer, not a second PDM model. Requirement
// identity, revisions and edges stay in the Requirements Manager; items,
// revisions, datasets, CAD and BOM stay in their own domains. Here we only
// declare the shared vocabulary (relationship codes, node types, IAM codes,
// event types and configuration keys) that lets the two domains be traced
// together without duplicating either model.
export const SOURCE_MODULE = "requirement-pdm";

// The requirement side of an allocation edge is always a Requirement business
// object, addressed by its Object framework id so the Digital Thread can resolve
// it through the standard object provider.
export const REQUIREMENT_SOURCE_TYPE = "requirement";

// Thread/node types used as the target side of allocation edges. These match
// the object types exposed by the PDM and BOM thread providers, so an allocation
// edge resolves without translation.
export const PDM_NODE_TYPES = Object.freeze({
  ITEM: "pdm_item",
  REVISION: "pdm_revision",
  DATASET: "pdm_dataset",
  BOM_REVISION: "bom_revision",
});

// Maps a target node type to the table that owns the artifact. `object_column`
// is the generic object id when the domain registers one; `ref_column` and
// `number_column` identify the artifact for audit and display.
export const TARGET_SOURCES = Object.freeze({
  pdm_item: { table: "pdm_items", ref_column: "item_ref", number_column: "item_number", object_column: "object_id", label: "PDM item" },
  pdm_revision: { table: "pdm_item_revisions", ref_column: "revision_ref", number_column: "revision_number", object_column: "object_id", label: "PDM item revision" },
  pdm_dataset: { table: "pdm_datasets", ref_column: "dataset_ref", number_column: "dataset_number", object_column: "object_id", label: "PDM dataset" },
  bom_revision: { table: "bom_revisions", ref_column: "revision_ref", number_column: "revision_number", object_column: "object_id", label: "BOM revision" },
});

export const TARGET_NODE_TYPES = Object.freeze(Object.keys(TARGET_SOURCES));

// Allocation relationship semantics. Each is a Requirements Manager edge type
// (see requirements/constants.js RELATIONSHIP_TYPES) so it is stored in the
// existing requirement_relationships table and never duplicated.
export const ALLOCATION_TYPES = Object.freeze([
  {
    code: "ALLOCATED_TO",
    name: "Allocated to",
    description: "The requirement is allocated to a PDM item or product.",
    target_types: [PDM_NODE_TYPES.ITEM],
    direction: "FORWARD",
  },
  {
    code: "IMPLEMENTED_BY",
    name: "Implemented by",
    description: "The requirement is implemented by a PDM item revision.",
    target_types: [PDM_NODE_TYPES.REVISION],
    direction: "FORWARD",
  },
  {
    code: "REALIZED_BY",
    name: "Realized by",
    description: "The requirement is realized by a PDM item, revision, dataset or BOM revision.",
    target_types: [PDM_NODE_TYPES.ITEM, PDM_NODE_TYPES.REVISION, PDM_NODE_TYPES.DATASET, PDM_NODE_TYPES.BOM_REVISION],
    direction: "FORWARD",
  },
  {
    code: "REPRESENTED_BY",
    name: "Represented by",
    description: "The requirement is represented by a PDM dataset (CAD or document).",
    target_types: [PDM_NODE_TYPES.DATASET],
    direction: "FORWARD",
  },
  {
    code: "SATISFIED_BY",
    name: "Satisfied by",
    description: "The requirement is satisfied by an engineering/manufacturing BOM revision.",
    target_types: [PDM_NODE_TYPES.BOM_REVISION],
    direction: "FORWARD",
  },
]);

export const ALLOCATION_CODES = Object.freeze(ALLOCATION_TYPES.map((entry) => entry.code));

// Coverage status reported per requirement allocation.
export const COVERAGE_STATUSES = Object.freeze(["UNALLOCATED", "PARTIAL", "ALLOCATED", "SATISFIED"]);

// Compatibility of an allocation with the current PDM revision/configuration.
export const COMPATIBILITY_STATUSES = Object.freeze(["UNKNOWN", "COMPATIBLE", "INCOMPATIBLE", "STALE"]);

// Allocation lifecycle. Allocations are soft state: removing one deactivates
// the edge rather than deleting history.
export const ALLOCATION_STATUSES = Object.freeze(["ACTIVE", "INACTIVE"]);

// ── IAM resources ────────────────────────────────────────────────────────────

export const REQUIREMENT_PDM_RESOURCES = Object.freeze({
  module: "iam.requirement-pdm",
  overview: "iam.requirement-pdm.overview",
  allocations: "iam.requirement-pdm.allocations",
  coverage: "iam.requirement-pdm.coverage",
  compatibility: "iam.requirement-pdm.compatibility",
  impact: "iam.requirement-pdm.impact",
  synchronization: "iam.requirement-pdm.synchronization",
  metrics: "iam.requirement-pdm.metrics",
  admin: "iam.requirement-pdm.admin",
});

// Stable security action codes published for administrators. Enforcement uses
// the standard IAM read/create/update/delete/execute actions.
export const SECURITY_ACTIONS = Object.freeze([
  "VIEW_REQUIREMENT_PDM",
  "MANAGE_ALLOCATION",
  "REMOVE_ALLOCATION",
  "VIEW_COVERAGE",
  "ANALYZE_COMPATIBILITY",
  "ANALYZE_IMPACT",
  "SYNCHRONIZE",
  "CONFIGURE_REQUIREMENT_PDM",
]);

// ── Domain events ────────────────────────────────────────────────────────────

export const REQUIREMENT_PDM_EVENT_TYPES = Object.freeze([
  { code: "RequirementProductAllocated", description: "A requirement was allocated to a PDM product or item." },
  { code: "RequirementItemAllocated", description: "A requirement was allocated to a PDM item." },
  { code: "RequirementRevisionAllocated", description: "A requirement was implemented by a PDM item revision." },
  { code: "RequirementDatasetAssociated", description: "A requirement was represented by a PDM dataset." },
  { code: "RequirementPDMTraceCreated", description: "A requirement -> PDM traceability edge was created." },
  { code: "RequirementPDMTraceRemoved", description: "A requirement -> PDM traceability edge was removed." },
  { code: "RequirementPDMImpactDetected", description: "A PDM change was detected to impact an allocated requirement." },
  { code: "RequirementPDMCompatibilityChanged", description: "The compatibility of a requirement allocation changed." },
  { code: "RequirementPDMSynchronizationFailed", description: "Synchronizing requirements with PDM failed." },
]);

export const REQUIREMENT_PDM_EVENT_MAP = Object.freeze({
  PRODUCT_ALLOCATED: "RequirementProductAllocated",
  ITEM_ALLOCATED: "RequirementItemAllocated",
  REVISION_ALLOCATED: "RequirementRevisionAllocated",
  DATASET_ASSOCIATED: "RequirementDatasetAssociated",
  TRACE_CREATED: "RequirementPDMTraceCreated",
  TRACE_REMOVED: "RequirementPDMTraceRemoved",
  IMPACT_DETECTED: "RequirementPDMImpactDetected",
  COMPATIBILITY_CHANGED: "RequirementPDMCompatibilityChanged",
  SYNCHRONIZATION_FAILED: "RequirementPDMSynchronizationFailed",
});

// ── IAM action aliases ───────────────────────────────────────────────────────

export const RESOURCE_FOR = Object.freeze({
  ALLOCATED_TO: REQUIREMENT_PDM_RESOURCES.allocations,
  IMPLEMENTED_BY: REQUIREMENT_PDM_RESOURCES.allocations,
  REALIZED_BY: REQUIREMENT_PDM_RESOURCES.allocations,
  REPRESENTED_BY: REQUIREMENT_PDM_RESOURCES.allocations,
  SATISFIED_BY: REQUIREMENT_PDM_RESOURCES.allocations,
});

// ── Configuration keys (registered in the platform config catalog) ───────────

export const CONFIG_PREFIX = "requirement_pdm.";

export const CONFIG_KEYS = Object.freeze({
  autoTraceOnAllocation: "requirement_pdm.auto_trace_on_allocation",
  requireTargetReleased: "requirement_pdm.require_target_released",
  enforceEffectivity: "requirement_pdm.enforce_effectivity",
  defaultRevisionRule: "requirement_pdm.default_revision_rule",
  defaultConfigurationContext: "requirement_pdm.default_configuration_context",
  mirrorToPdmRelationships: "requirement_pdm.mirror_to_pdm_relationships",
  traceabilityProviderEnabled: "requirement_pdm.traceability_provider_enabled",
  impactMaxDepth: "requirement_pdm.impact_max_depth",
  notifyOnAllocation: "requirement_pdm.notify_on_allocation",
  syncBatchSize: "requirement_pdm.sync_batch_size",
});

export const CONFIG_DEFAULTS = Object.freeze({
  auto_trace_on_allocation: true,
  require_target_released: false,
  enforce_effectivity: true,
  default_revision_rule: "LATEST",
  default_configuration_context: "",
  mirror_to_pdm_relationships: false,
  traceability_provider_enabled: true,
  impact_max_depth: 10,
  notify_on_allocation: true,
  sync_batch_size: 200,
});

export const CONFIG_BOUNDS = Object.freeze({
  impact_max_depth: { min: 1, max: 50 },
  sync_batch_size: { min: 1, max: 5000 },
});

// ── Bounds ───────────────────────────────────────────────────────────────────

export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_IMPACT_DEPTH = 50;
export const DEFAULT_REVISION_RULE = "LATEST";

// ── Synchronization statuses ─────────────────────────────────────────────────

export const SYNC_STATUSES = Object.freeze(["COMPLETED", "PARTIAL", "FAILED", "NOOP"]);
export const IMPACT_SEVERITIES = Object.freeze(["INFO", "WARNING", "ERROR"]);

// ── Background jobs ──────────────────────────────────────────────────────────

export const REQUIREMENT_PDM_HANDLER_CODES = Object.freeze({
  SYNCHRONIZE: "requirement-pdm.synchronize",
  IMPACT_SWEEP: "requirement-pdm.impactSweep",
});

export const REQUIREMENT_PDM_JOB_TYPES = [
  {
    code: "REQUIREMENT_PDM_SYNCHRONIZE",
    name: "Requirement/PDM synchronization",
    description: "Re-evaluate requirement allocations against the current PDM revision, configuration and effectivity, publishing impact and compatibility changes.",
    source_module: SOURCE_MODULE,
    handler: REQUIREMENT_PDM_HANDLER_CODES.SYNCHRONIZE,
    queues: ["requirement-pdm", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "REQUIREMENT_PDM_IMPACT_SWEEP",
    name: "Requirement/PDM impact sweep",
    description: "Sweep every active requirement allocation in a tenant and report the ones impacted by PDM changes.",
    source_module: SOURCE_MODULE,
    handler: REQUIREMENT_PDM_HANDLER_CODES.IMPACT_SWEEP,
    queues: ["requirement-pdm", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "low",
  },
];

// ── Integration & API Framework wiring ───────────────────────────────────────

export const REQUIREMENT_PDM_INTEGRATION = Object.freeze({
  handler: "requirement-pdm.sync",
  eventHandler: "requirement-pdm.pdm-change",
  messageType: "requirement_pdm.synchronization",
  queue: "INTEGRATION",
  subscriptionPrefix: "requirement-pdm",
});

// PDM lifecycle events the integration reacts to, mapped to the allocation
// target type they concern. Only the events that can invalidate an allocation
// are subscribed.
export const REQUIREMENT_PDM_EVENT_SUBSCRIPTIONS = Object.freeze([
  { event_type_code: "PdmItemStatusChanged", target_type: "pdm_item" },
  { event_type_code: "PdmItemUpdated", target_type: "pdm_item" },
  { event_type_code: "PdmRevisionCreated", target_type: "pdm_revision" },
  { event_type_code: "PdmRevisionRevised", target_type: "pdm_revision" },
  { event_type_code: "PdmRevisionReleased", target_type: "pdm_revision" },
  { event_type_code: "PdmRevisionStatusChanged", target_type: "pdm_revision" },
  { event_type_code: "PdmDatasetCreated", target_type: "pdm_dataset" },
  { event_type_code: "PdmDatasetUpdated", target_type: "pdm_dataset" },
  { event_type_code: "PdmDatasetDeleted", target_type: "pdm_dataset" },
  { event_type_code: "PdmCadAssociationCreated", target_type: "pdm_revision" },
  { event_type_code: "PdmCadAssociationRemoved", target_type: "pdm_revision" },
]);
