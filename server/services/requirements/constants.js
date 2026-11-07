// Vocabulary, defaults and platform wiring codes for the Requirements Manager
// domain.
//
// Requirements Manager is a thin business application on top of the shared
// platform. Nothing here duplicates a platform engine: requirement identity,
// revisions, relationships, hierarchy, baselines and validation rules are
// Requirements Manager's own stored state, while numbering, lifecycle,
// workflow, metadata, security, events, audit, search, notifications and
// attachments are all reused through their existing frameworks.
export const SOURCE_MODULE = "requirements";

// Generic metadata type that represents a Requirement in the Object framework.
export const REQUIREMENT_OBJECT_TYPE = "requirement";

// ── Requirement types (configurable, seeded as data — never hard-coded) ─────

export const DEFAULT_REQUIREMENT_TYPES = Object.freeze([
  { code: "business_requirement", name: "Business Requirement", category: "BUSINESS", sequence: 10 },
  { code: "customer_requirement", name: "Customer Requirement", category: "BUSINESS", sequence: 20 },
  { code: "system_requirement", name: "System Requirement", category: "SYSTEM", sequence: 30 },
  { code: "subsystem_requirement", name: "Subsystem Requirement", category: "SYSTEM", sequence: 40 },
  { code: "product_requirement", name: "Product Requirement", category: "PRODUCT", sequence: 50 },
  { code: "functional_requirement", name: "Functional Requirement", category: "PRODUCT", sequence: 60 },
  { code: "non_functional_requirement", name: "Non-Functional Requirement", category: "PRODUCT", sequence: 70 },
  { code: "engineering_requirement", name: "Engineering Requirement", category: "ENGINEERING", sequence: 80 },
  { code: "manufacturing_requirement", name: "Manufacturing Requirement", category: "ENGINEERING", sequence: 90 },
  { code: "quality_requirement", name: "Quality Requirement", category: "QUALITY", sequence: 100 },
  { code: "regulatory_requirement", name: "Regulatory Requirement", category: "COMPLIANCE", sequence: 110 },
  { code: "safety_requirement", name: "Safety Requirement", category: "COMPLIANCE", sequence: 120 },
  { code: "service_requirement", name: "Service Requirement", category: "SERVICE", sequence: 130 },
  { code: "interface_requirement", name: "Interface Requirement", category: "INTERFACE", sequence: 140 },
  { code: "verification_requirement", name: "Verification Requirement", category: "VERIFICATION", sequence: 150 },
]);

// Optional parent-type mapping so the seeded hierarchy can nest by default.
export const DEFAULT_TYPE_PARENTS = Object.freeze({
  customer_requirement: "business_requirement",
  system_requirement: "business_requirement",
  subsystem_requirement: "system_requirement",
  product_requirement: "system_requirement",
  functional_requirement: "product_requirement",
  non_functional_requirement: "product_requirement",
  engineering_requirement: "product_requirement",
  manufacturing_requirement: "engineering_requirement",
  quality_requirement: "engineering_requirement",
  interface_requirement: "system_requirement",
  verification_requirement: "system_requirement",
});

export const REQUIREMENT_TYPE_CATEGORIES = [
  "BUSINESS",
  "SYSTEM",
  "PRODUCT",
  "ENGINEERING",
  "QUALITY",
  "COMPLIANCE",
  "SERVICE",
  "INTERFACE",
  "VERIFICATION",
  "OTHER",
];

// ── Requirement classification ──────────────────────────────────────────────

export const REQUIREMENT_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];
export const REQUIREMENT_CRITICALITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
export const REQUIREMENT_DOMAINS = ["MECHANICAL", "ELECTRICAL", "SOFTWARE", "SYSTEM", "PROCESS", "QUALITY", "SERVICE", "OTHER"];
export const REQUIREMENT_DISCIPLINES = ["DESIGN", "ANALYSIS", "TEST", "MANUFACTURING", "INTEGRATION", "OTHER"];
export const REQUIREMENT_SOURCES = ["BUSINESS", "CUSTOMER", "MARKET", "REGULATORY", "INTERNAL", "ENGINEERING", "SUPPLIER", "SUPPORT", "OTHER"];
export const REQUIREMENT_CLASSIFICATIONS = ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"];

// ── Lifecycle ───────────────────────────────────────────────────────────────

export const REQUIREMENT_STATUSES = [
  "DRAFT",
  "IN_REVIEW",
  "APPROVED",
  "REJECTED",
  "RELEASED",
  "IMPLEMENTED",
  "VERIFIED",
  "VALIDATED",
  "OBSOLETE",
  "WITHDRAWN",
];

export const DEFAULT_REQUIREMENT_TRANSITIONS = Object.freeze({
  DRAFT: ["IN_REVIEW", "WITHDRAWN"],
  IN_REVIEW: ["APPROVED", "REJECTED", "DRAFT", "WITHDRAWN"],
  APPROVED: ["RELEASED", "IN_REVIEW", "WITHDRAWN"],
  REJECTED: ["DRAFT", "WITHDRAWN"],
  RELEASED: ["IMPLEMENTED", "OBSOLETE"],
  IMPLEMENTED: ["VERIFIED", "OBSOLETE"],
  VERIFIED: ["VALIDATED", "OBSOLETE"],
  VALIDATED: ["OBSOLETE"],
  OBSOLETE: [],
  WITHDRAWN: [],
});

export const IMMUTABLE_STATUSES = ["RELEASED", "IMPLEMENTED", "VERIFIED", "VALIDATED", "OBSOLETE"];

// ── Quality / verification / validation ─────────────────────────────────────

export const QUALITY_STATUSES = ["INCOMPLETE", "PARTIAL", "COMPLETE"];
export const VERIFICATION_STATUSES = ["NOT_VERIFIED", "IN_PROGRESS", "VERIFIED", "FAILED", "WAIVED"];
export const VALIDATION_STATUSES = ["NOT_VALIDATED", "IN_PROGRESS", "VALIDATED", "FAILED"];
export const TRACEABILITY_STATUSES = ["UNTRACED", "PARTIAL", "TRACED"];

// ── Revisions ───────────────────────────────────────────────────────────────

export const REVISION_SEQUENCE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const DEFAULT_REVISION = "A";
export const REVISION_STATUSES = ["WORKING", "RELEASED", "SUPERSEDED", "OBSOLETE"];

// ── Relationships ───────────────────────────────────────────────────────────

export const RELATIONSHIP_TYPES = [
  "PARENT_OF",
  "CHILD_OF",
  "DERIVED_FROM",
  "REFINES",
  "SATISFIES",
  "ALLOCATED_TO",
  "DEPENDS_ON",
  "RELATED_TO",
  "CONFLICTS_WITH",
  "SUPERSEDES",
  "SUPERSEDED_BY",
  "DUPLICATE_OF",
  "VERIFIED_BY",
  "VALIDATED_BY",
  "IMPLEMENTED_BY",
  "REALIZED_BY",
  "REPRESENTED_BY",
  "SATISFIED_BY",
  "GOVERNED_BY",
  "CONTROLLED_BY",
  "AFFECTS",
  "CHANGED_BY",
];

// Cross-domain Change Management link vocabulary used by the Requirement -> PLM
// integration. Stored in the same generic requirement_relationships edge table
// so a Requirement is traced to an existing change request/order/notice without
// a RequirementChangeMapping table.
export const CHANGE_RELATIONSHIPS = Object.freeze(["CHANGED_BY"]);

// Cross-domain allocation vocabulary used by the Requirement -> PDM integration.
// These preserve the same generic edge table so a Requirement can be traced to
// a PDM product/item, item revision, dataset or engineering BOM without a
// second relationship model.
export const PDM_ALLOCATION_RELATIONSHIPS = Object.freeze([
  "ALLOCATED_TO",
  "IMPLEMENTED_BY",
  "REALIZED_BY",
  "REPRESENTED_BY",
  "SATISFIED_BY",
]);

// PARENT_OF / CHILD_OF are the hierarchy relationships and get cycle checks.
export const HIERARCHY_RELATIONSHIPS = Object.freeze({
  PARENT_OF: { inverse: "CHILD_OF", directed: true },
  CHILD_OF: { inverse: "PARENT_OF", directed: true },
});

export const SYMMETRIC_RELATIONSHIPS = ["RELATED_TO", "CONFLICTS_WITH", "DUPLICATE_OF"];

// ── Baselines ───────────────────────────────────────────────────────────────

export const BASELINE_STATUSES = ["DRAFT", "RELEASED", "OBSOLETE"];
export const BASELINE_MEMBER_TYPES = ["REQUIREMENT", "REVISION"];

// ── Validation rules ────────────────────────────────────────────────────────

export const VALIDATION_SEVERITIES = ["ERROR", "WARNING", "INFO"];
export const VALIDATION_RULE_TYPES = ["REQUIRED", "REGEX", "RANGE", "LENGTH", "RELATIONSHIP", "UNIQUE", "EXPRESSION"];

// ── Numeric / misc ───────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_HIERARCHY_DEPTH = 30;

// ── IAM resources ────────────────────────────────────────────────────────────

export const REQUIREMENTS_RESOURCES = Object.freeze({
  module: "iam.requirements",
  overview: "iam.requirements.overview",
  items: "iam.requirements.items",
  types: "iam.requirements.types",
  relationships: "iam.requirements.relationships",
  hierarchy: "iam.requirements.hierarchy",
  baselines: "iam.requirements.baselines",
  reviews: "iam.requirements.reviews",
  admin: "iam.requirements.admin",
});

// ── Numbering object types (registered at foundation time) ─────────────────

export const NUMBERING_OBJECT_TYPES = Object.freeze({
  REQUIREMENT: "REQUIREMENT",
  BASELINE: "REQUIREMENT_BASELINE",
});

// ── Domain events ────────────────────────────────────────────────────────────

export const REQUIREMENT_EVENT_TYPES = [
  { code: "RequirementCreated", description: "A requirement was created." },
  { code: "RequirementUpdated", description: "A requirement was updated." },
  { code: "RequirementRevised", description: "A new requirement revision was created." },
  { code: "RequirementSubmitted", description: "A requirement was submitted for review." },
  { code: "RequirementApproved", description: "A requirement was approved." },
  { code: "RequirementRejected", description: "A requirement was rejected in review." },
  { code: "RequirementReleased", description: "A requirement revision was released." },
  { code: "RequirementImplemented", description: "A requirement was marked implemented." },
  { code: "RequirementVerified", description: "A requirement was verified." },
  { code: "RequirementValidated", description: "A requirement was validated." },
  { code: "RequirementObsoleted", description: "A requirement was obsoleted." },
  { code: "RequirementWithdrawn", description: "A requirement was withdrawn." },
  { code: "RequirementRelationshipCreated", description: "A requirement relationship was created." },
  { code: "RequirementRelationshipRemoved", description: "A requirement relationship was removed." },
  { code: "RequirementBaselineCreated", description: "A requirement baseline was created." },
  { code: "RequirementBaselineReleased", description: "A requirement baseline was released." },
  { code: "RequirementTypeConfigured", description: "A requirement type was configured." },
  { code: "RequirementAttachmentAdded", description: "An attachment was added to a requirement." },
];

// ── Job types ────────────────────────────────────────────────────────────────

export const REQUIREMENT_JOB_TYPES = [
  { code: "requirement_reindex", name: "Requirements reindex", description: "Rebuild search index documents for requirements." },
  { code: "requirement_validation", name: "Requirements validation sweep", description: "Run configured validation rules across requirements." },
  { code: "requirement_baseline_diff", name: "Requirement baseline comparison", description: "Compare a baseline against current requirement revisions." },
];

export const REQUIREMENT_HANDLER_CODES = ["requirement_reindex", "requirement_validation", "requirement_baseline_diff"];

// ── Multi-tenancy cache ──────────────────────────────────────────────────────

export const CACHE_EPOCH_KEY = "requirements:epoch";

// ── Tenant configuration ─────────────────────────────────────────────────────

export const CONFIG_DEFAULTS = Object.freeze({
  default_status: "DRAFT",
  default_revision: "A",
  enforce_unique_numbers: true,
  require_owner: true,
  require_type: true,
  require_description: false,
  allow_self_parent: false,
  max_hierarchy_depth: MAX_HIERARCHY_DEPTH,
  require_verification_to_validate: true,
  auto_baseline_on_release: false,
  history_retention_days: 365,
});

export const CONFIG_BOUNDS = Object.freeze({
  max_hierarchy_depth: { min: 1, max: 100 },
  history_retention_days: { min: 1, max: 3650 },
});

// ── Search object types ──────────────────────────────────────────────────────

export const SEARCH_OBJECT_TYPES = [
  { code: "requirement", name: "Requirements", description: "Requirements with type, classification, priority and lifecycle status." },
  { code: "requirement_revision", name: "Requirement revisions", description: "Requirement revisions with status, change reason and effectivity." },
  { code: "requirement_baseline", name: "Requirement baselines", description: "Controlled requirement baselines and their member revisions." },
];
