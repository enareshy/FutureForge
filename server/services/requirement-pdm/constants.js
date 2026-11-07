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

// ── PLM vocabulary (Requirement -> PLM digital thread) ───────────────────────
//
// The Requirement -> PLM layer adds no new PLM object model. Product and its
// revision reuse the PDM item/revision node types; EBOM, MBOM and BOP reuse the
// single BOM revision node type (the concrete structure is derived from the BOM
// header's bom_type). Only Change Management introduces additional node types,
// because change requests/orders/notices are the platform's own system of
// record and are not projected by the built-in Digital Thread providers.
export const CHANGE_NODE_TYPES = Object.freeze({
  REQUEST: "change_request",
  ORDER: "change_order",
  NOTICE: "change_notice",
});

// Table that owns each change node, used by the node resolver to project change
// artifacts into the Digital Thread without copying them.
export const CHANGE_TARGET_SOURCES = Object.freeze({
  change_request: {
    table: "change_requests",
    ref_column: "request_ref",
    number_column: "request_number",
    label: "Change request",
    status_column: "status",
    parent_column: null,
  },
  change_order: {
    table: "change_orders",
    ref_column: "order_ref",
    number_column: "order_number",
    label: "Change order",
    status_column: "status",
    parent_column: "change_request_id",
  },
  change_notice: {
    table: "change_notices",
    ref_column: "notice_ref",
    number_column: "notice_number",
    label: "Change notice",
    status_column: "status",
    parent_column: "change_order_id",
  },
});

export const CHANGE_NODE_CODES = Object.freeze(Object.keys(CHANGE_TARGET_SOURCES));

// Concise, cross-domain alias map for the thread: the semantic PLM concept and
// the node type it resolves to. Product/Product Revision/EBOM/MBOM/BOP/Document
// deliberately resolve to existing PDM/BOM node types (no duplication).
export const PLM_NODE_TYPES = Object.freeze({
  PRODUCT: PDM_NODE_TYPES.ITEM,
  PRODUCT_REVISION: PDM_NODE_TYPES.REVISION,
  EBOM: PDM_NODE_TYPES.BOM_REVISION,
  MBOM: PDM_NODE_TYPES.BOM_REVISION,
  BOP: PDM_NODE_TYPES.BOM_REVISION,
  DOCUMENT: PDM_NODE_TYPES.DATASET,
  CHANGE_REQUEST: CHANGE_NODE_TYPES.REQUEST,
  CHANGE_ORDER: CHANGE_NODE_TYPES.ORDER,
  CHANGE_NOTICE: CHANGE_NODE_TYPES.NOTICE,
});

// Requirement -> Change Management linkage. Stored in the existing
// requirement_relationships table (no RequirementChangeMapping table), mirroring
// how allocations are stored. Change Management remains the system of record;
// this edge only makes the requirement -> change link traversable.
export const PLM_LINK_TYPES = Object.freeze([
  {
    code: "CHANGED_BY",
    name: "Changed by",
    description: "The requirement is changed by an existing Change Management change request.",
    target_types: [CHANGE_NODE_TYPES.REQUEST],
    direction: "FORWARD",
    mirror: "change",
  },
]);

export const PLM_LINK_CODES = Object.freeze(PLM_LINK_TYPES.map((entry) => entry.code));

// Impact classification (Prompt 4, section 11). Categories are declared here so
// API, events and the UI share one vocabulary; the classification itself is
// computed by composing the Digital Thread traversal with Change Management's
// own impact discovery (never a second impact engine).
export const IMPACT_CATEGORIES = Object.freeze(["DIRECT", "INDIRECT", "CONFIGURATION", "EFFECTIVITY", "PROCESS", "DOCUMENT", "CHANGE"]);

// Status of an initiated change flow, reported by the integration.
export const CHANGE_INITIATION_STATUSES = Object.freeze(["NOT_REQUIRED", "PENDING", "CREATED", "EXISTING", "FAILED"]);

// Severity scale used by the change-initiation rule evaluator. Requirement
// priority and criticality (Requirements Manager vocabulary) project onto one
// ordered scale so a tenant configures a single auto-change threshold. The
// higher of the two projections wins, mirroring how a CCB reads a requirement's
// risk.
export const CHANGE_SEVERITIES = Object.freeze(["LOW", "NORMAL", "HIGH", "CRITICAL"]);

export const PRIORITY_TO_SEVERITY = Object.freeze({
  LOW: "LOW",
  NORMAL: "NORMAL",
  HIGH: "HIGH",
  URGENT: "CRITICAL",
});

export const CRITICALITY_TO_SEVERITY = Object.freeze({
  LOW: "LOW",
  MEDIUM: "NORMAL",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
});

// Named business rules evaluated (in order) before an automatic change request
// is raised. Stored as codes so callers and the UI can explain a decision.
export const CHANGE_INITIATION_RULES = Object.freeze(["AUTO_CHANGE_REQUEST", "SEVERITY_THRESHOLD", "RELEASED_IMPACT"]);

// ── Product / Lifecycle projection vocabulary ────────────────────────────────
//
// The realization stage of a requirement is *derived*, never stored. It is a
// read-only projection of the product lifecycle the requirement is allocated to.
// The lifecycle itself (states, categories, transitions, approvals) stays owned
// by the Lifecycle Management framework; here we only translate its controlled
// `category` vocabulary into a stable, requirement-facing stage so APIs and the
// UI never hard-code individual state codes.
export const PRODUCT_ITEM_TYPE = "PRODUCT";

// Advancing requirement realization stages (Prompt 4 section 5). The list is
// ordered: a higher index is a later stage, which makes promotion deterministic.
export const REALIZATION_STAGES = Object.freeze([
  "PLANNED",
  "IN_DEVELOPMENT",
  "UNDER_REVIEW",
  "APPROVED",
  "IMPLEMENTED",
  "RELEASED",
  "SUPERSEDED",
  "OBSOLETE",
]);

// Lifecycle state `category` (Lifecycle Management STATUS_CATEGORIES) -> stage.
// Cancelled products are reported as obsolete, the terminal stage.
export const LIFECYCLE_CATEGORY_TO_STAGE = Object.freeze({
  draft: "IN_DEVELOPMENT",
  in_review: "UNDER_REVIEW",
  approved: "APPROVED",
  released: "RELEASED",
  obsolete: "OBSOLETE",
  cancelled: "OBSOLETE",
});

// Fallback used only when a PDM item/revision is not onboarded to a generic
// lifecycle assignment. This translates the PDM status vocabulary into the same
// Lifecycle Management categories (it does not define lifecycle states).
export const PDM_STATUS_CATEGORY = Object.freeze({
  DRAFT: "draft",
  IN_WORK: "draft",
  IN_REVIEW: "in_review",
  RELEASED: "released",
  OBSOLETE: "obsolete",
});

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
  plm: "iam.requirement-pdm.plm",
  changes: "iam.requirement-pdm.changes",
  changeInitiation: "iam.requirement-pdm.change-initiation",
  documents: "iam.requirement-pdm.documents",
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
  "VIEW_REQUIREMENT_PLM",
  "VIEW_REQUIREMENT_PRODUCTS",
  "INITIATE_CHANGE_REQUEST",
  "VIEW_REQUIREMENT_CHANGES",
  "VIEW_REQUIREMENT_DOCUMENTS",
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
  { code: "RequirementPLMImpactDetected", description: "A requirement change was detected to impact downstream PLM objects." },
  { code: "RequirementChangeInitiated", description: "A requirement change initiated the Change Management process." },
  { code: "RequirementChangeRequestCreated", description: "A change request was created from a requirement change." },
  { code: "RequirementPLMChangeSynchronized", description: "A requirement and its PLM objects were synchronized." },
  { code: "RequirementPLMSynchronizationFailed", description: "Synchronizing a requirement with its PLM objects failed." },
  { code: "RequirementPLMReleaseCompleted", description: "A requirement-driven change completed release across the PLM chain." },
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
  PLM_IMPACT_DETECTED: "RequirementPLMImpactDetected",
  CHANGE_INITIATED: "RequirementChangeInitiated",
  CHANGE_REQUEST_CREATED: "RequirementChangeRequestCreated",
  PLM_CHANGE_SYNCHRONIZED: "RequirementPLMChangeSynchronized",
  PLM_SYNCHRONIZATION_FAILED: "RequirementPLMSynchronizationFailed",
  PLM_RELEASE_COMPLETED: "RequirementPLMReleaseCompleted",
});

// ── IAM action aliases ───────────────────────────────────────────────────────

export const RESOURCE_FOR = Object.freeze({
  ALLOCATED_TO: REQUIREMENT_PDM_RESOURCES.allocations,
  IMPLEMENTED_BY: REQUIREMENT_PDM_RESOURCES.allocations,
  REALIZED_BY: REQUIREMENT_PDM_RESOURCES.allocations,
  REPRESENTED_BY: REQUIREMENT_PDM_RESOURCES.allocations,
  SATISFIED_BY: REQUIREMENT_PDM_RESOURCES.allocations,
  CHANGED_BY: REQUIREMENT_PDM_RESOURCES.changes,
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
  autoChangeRequest: "requirement_pdm.auto_change_request",
  autoChangeRequestSeverities: "requirement_pdm.auto_change_request_severities",
  autoChangeRequestRequireReleased: "requirement_pdm.auto_change_request_require_released",
  impactAnalysisAsyncThreshold: "requirement_pdm.impact_analysis_async_threshold",
  impactCategories: "requirement_pdm.impact_categories",
  changeInitiationWorkflow: "requirement_pdm.change_initiation_workflow",
  changeRequestCategory: "requirement_pdm.change_request_category",
  changeRequestPriority: "requirement_pdm.change_request_priority",
  changeLinkAuto: "requirement_pdm.change_link_auto",
  notifyOnImpact: "requirement_pdm.notify_on_impact",
  plmSyncAnalyze: "requirement_pdm.plm_sync_analyze",
  plmSyncNotify: "requirement_pdm.plm_sync_notify",
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
  auto_change_request: false,
  auto_change_request_severities: "CRITICAL,HIGH",
  auto_change_request_require_released: true,
  impact_analysis_async_threshold: 500,
  impact_categories: "DIRECT,INDIRECT,CONFIGURATION,EFFECTIVITY,PROCESS,DOCUMENT,CHANGE",
  change_initiation_workflow: "",
  change_request_category: "DESIGN",
  change_request_priority: "NORMAL",
  change_link_auto: true,
  notify_on_impact: true,
  plm_sync_analyze: true,
  plm_sync_notify: true,
});

export const CONFIG_BOUNDS = Object.freeze({
  impact_max_depth: { min: 1, max: 50 },
  sync_batch_size: { min: 1, max: 5000 },
  impact_analysis_async_threshold: { min: 1, max: 100000 },
});

// ── Bounds ───────────────────────────────────────────────────────────────────

export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_IMPACT_DEPTH = 50;
export const DEFAULT_REVISION_RULE = "LATEST";

// ── Synchronization statuses ─────────────────────────────────────────────────

export const SYNC_STATUSES = Object.freeze(["COMPLETED", "PARTIAL", "FAILED", "NOOP"]);
export const IMPACT_SEVERITIES = Object.freeze(["INFO", "WARNING", "ERROR"]);

// Direction of a change-synchronization run. The integration only *propagates*
// changes between the two systems of record; it never owns the change itself.
export const PLM_SYNC_DIRECTIONS = Object.freeze({
  REQUIREMENT_TO_PLM: "REQUIREMENT_TO_PLM",
  PLM_TO_REQUIREMENT: "PLM_TO_REQUIREMENT",
});

// Document source categories surfaced by the Requirement -> PLM document
// projection (section 19). "STRUCTURE" groups EBOM/MBOM/BOP revisions.
export const PLM_DOCUMENT_CATEGORIES = Object.freeze(["REQUIREMENT", "PRODUCT", "STRUCTURE", "CHANGE"]);

// Aggregate integration status surfaced to monitoring/UI (Prompt 4 section 28).
export const INTEGRATION_STATUSES = Object.freeze([
  "SUCCESS",
  "PENDING",
  "PROCESSING",
  "FAILED",
  "RETRYING",
  "BLOCKED",
  "DEAD_LETTER",
]);

// Default (global) notification rules the integration installs so a PLM change
// notifies the requirement owner through the existing Notification framework.
// Recipients are resolved from `payload.recipients`, which the sync populates
// with the owner/responsible users of each impacted requirement.
export const PLM_NOTIFICATION_RULES = Object.freeze([
  {
    code: "requirement-pdm-plm-impact",
    name: "Requirement impacted by a PLM change",
    event_type: "RequirementPDMImpactDetected",
  },
  {
    code: "requirement-pdm-plm-sync-failed",
    name: "Requirement/PLM synchronization failed",
    event_type: "RequirementPLMSynchronizationFailed",
  },
]);

export const NOTIFICATION_RECIPIENT_PAYLOAD_PATH = "recipients";

// ── Background jobs ──────────────────────────────────────────────────────────

export const REQUIREMENT_PDM_HANDLER_CODES = Object.freeze({
  SYNCHRONIZE: "requirement-pdm.synchronize",
  IMPACT_SWEEP: "requirement-pdm.impactSweep",
  IMPACT_ANALYSIS: "requirement-pdm.impactAnalysis",
  CHANGE_INITIATE: "requirement-pdm.changeInitiate",
  PLM_SYNC: "requirement-pdm.plmSync",
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
  {
    code: "REQUIREMENT_PLM_IMPACT_ANALYSIS",
    name: "Requirement/PLM impact analysis",
    description: "Traverse the Digital Thread from a requirement and classify impacted Product, EBOM, MBOM, BOP, Document and Change objects.",
    source_module: SOURCE_MODULE,
    handler: REQUIREMENT_PDM_HANDLER_CODES.IMPACT_ANALYSIS,
    queues: ["requirement-pdm", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "REQUIREMENT_PLM_CHANGE_INITIATE",
    name: "Requirement/PLM change initiation",
    description: "Evaluate configured business rules for a requirement change and initiate an existing Change Management request when the impact warrants it.",
    source_module: SOURCE_MODULE,
    handler: REQUIREMENT_PDM_HANDLER_CODES.CHANGE_INITIATE,
    queues: ["requirement-pdm", "default"],
    timeout_seconds: 3600,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "REQUIREMENT_PLM_SYNCHRONIZE",
    name: "Requirement/PLM change synchronization",
    description: "Propagate a Product, EBOM, MBOM, BOP, Document or Change object change to the requirements linked to it: identify linked requirements, determine impact and notify the requirement owners.",
    source_module: SOURCE_MODULE,
    handler: REQUIREMENT_PDM_HANDLER_CODES.PLM_SYNC,
    queues: ["requirement-pdm", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "normal",
  },
];

// ── Integration & API Framework wiring ───────────────────────────────────────

export const REQUIREMENT_PDM_INTEGRATION = Object.freeze({
  handler: "requirement-pdm.sync",
  eventHandler: "requirement-pdm.pdm-change",
  changeHandler: "requirement-pdm.change-initiate",
  changeEventHandler: "requirement-pdm.requirement-change",
  plmSyncHandler: "requirement-pdm.plm-sync",
  plmEventHandler: "requirement-pdm.plm-change",
  messageType: "requirement_pdm.synchronization",
  changeMessageType: "requirement_plm.change_initiation",
  plmMessageType: "requirement_plm.synchronization",
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

// Events consumed to synchronize the Requirement -> PLM digital thread when
// either side changes (Prompt 4, sections 21-23). These are mapped to the
// integration message queue; the Change Management events are produced by the
// existing Change module, never by a parallel system.
//
// `node_type` is the thread/change node the event concerns; `id_keys` lists the
// payload fields that may carry its id, in priority order. The handler resolves
// the node from those fields (falling back to the event's source object id) and
// then finds the requirements linked to it, so no PLM object is copied here.
export const REQUIREMENT_PLM_EVENT_SUBSCRIPTIONS = Object.freeze([
  { event_type_code: "ChangeRequestCreated", source: "change", direction: "PLM_TO_REQUIREMENT", node_type: "change_request", id_keys: ["change_request_id", "request_id", "id"] },
  { event_type_code: "ChangeRequestPromoted", source: "change", direction: "PLM_TO_REQUIREMENT", node_type: "change_request", id_keys: ["change_request_id", "request_id", "id"] },
  { event_type_code: "ChangeOrderCreated", source: "change", direction: "PLM_TO_REQUIREMENT", node_type: "change_order", id_keys: ["change_order_id", "order_id", "id"] },
  { event_type_code: "ChangeOrderApproved", source: "change", direction: "PLM_TO_REQUIREMENT", node_type: "change_order", id_keys: ["change_order_id", "order_id", "id"] },
  { event_type_code: "ChangeOrderReleased", source: "change", direction: "PLM_TO_REQUIREMENT", node_type: "change_order", id_keys: ["change_order_id", "order_id", "id"] },
  { event_type_code: "ChangeNoticeIssued", source: "change", direction: "PLM_TO_REQUIREMENT", node_type: "change_notice", id_keys: ["change_notice_id", "notice_id", "id"] },
  { event_type_code: "BomRevisionReleased", source: "bom", direction: "PLM_TO_REQUIREMENT", node_type: "bom_revision", id_keys: ["bom_revision_id", "revision_id", "id"] },
  { event_type_code: "PdmRevisionReleased", source: "pdm", direction: "PLM_TO_REQUIREMENT", node_type: "pdm_revision", id_keys: ["pdm_revision_id", "revision_id", "id"] },
]);

// Requirement lifecycle events that can warrant an automatic change request
// (Prompt 4, sections 15-16). Consumed through the shared Event & Messaging
// Framework; the handler only proposes a change when the configured rules pass,
// so subscribing is side-effect free while auto-change is disabled.
export const REQUIREMENT_PLM_CHANGE_SUBSCRIPTIONS = Object.freeze([
  { event_type_code: "RequirementUpdated", source: "requirements" },
  { event_type_code: "RequirementRevised", source: "requirements" },
  { event_type_code: "RequirementReleased", source: "requirements" },
]);
