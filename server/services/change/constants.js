// Vocabulary, defaults and platform wiring codes for the Change Management
// domain (ECR/ECO/ECN).
//
// Change Management provides engineering change control (Request/Order/
// Notice) on top of the shared platform services. Nothing here duplicates an
// existing platform engine: identity/status storage is Change Management's
// own, while numbering, effectivity/versioning, BOM impact discovery,
// security, events, audit and (for the change order CCB gate) lifecycle and
// workflow are all reused.
export const SOURCE_MODULE = "change";

export const CHANGE_REQUEST_OBJECT_TYPE = "change_request";
export const CHANGE_ORDER_OBJECT_TYPE = "change_order";
export const CHANGE_NOTICE_OBJECT_TYPE = "change_notice";

// ── Change Request (ECR) ─────────────────────────────────────────────────────

export const REQUEST_CATEGORIES = ["DESIGN", "PROCESS", "DOCUMENTATION", "SUPPLIER", "QUALITY", "OTHER"];
export const REQUEST_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"];
export const REQUEST_STATUSES = ["DRAFT", "SUBMITTED", "SCREENING", "APPROVED", "REJECTED", "WITHDRAWN", "PROMOTED"];

// Configurable default lifecycle for the request. A change request is a
// lightweight CCB-triage object; it does not need the full generic Lifecycle
// kernel to be onboarded (the change order does — see workflow.js).
export const DEFAULT_REQUEST_TRANSITIONS = Object.freeze({
  DRAFT: ["SUBMITTED", "WITHDRAWN"],
  SUBMITTED: ["SCREENING", "WITHDRAWN"],
  SCREENING: ["APPROVED", "REJECTED", "WITHDRAWN"],
  APPROVED: ["PROMOTED"],
  REJECTED: [],
  WITHDRAWN: [],
  PROMOTED: [],
});

// ── Change Order (ECO) ───────────────────────────────────────────────────────

export const ORDER_STATUSES = ["DRAFT", "IN_REVIEW", "APPROVED", "REJECTED", "RELEASED", "CANCELLED"];

export const DEFAULT_ORDER_TRANSITIONS = Object.freeze({
  DRAFT: ["IN_REVIEW", "CANCELLED"],
  IN_REVIEW: ["APPROVED", "REJECTED", "DRAFT"],
  APPROVED: ["RELEASED", "CANCELLED"],
  REJECTED: ["DRAFT"],
  RELEASED: [],
  CANCELLED: [],
});

export const EFFECTIVE_STRATEGIES = ["DATE", "IMMEDIATE", "SERIAL"];

export const AFFECTED_ITEM_DISPOSITIONS = ["NEW_REVISION", "OBSOLETE", "NO_CHANGE", "SUPERSEDED"];

// ── Change Notice (ECN) ──────────────────────────────────────────────────────

export const NOTICE_STATUSES = ["DRAFT", "ISSUED", "ACKNOWLEDGED"];

export const DEFAULT_NOTICE_TRANSITIONS = Object.freeze({
  DRAFT: ["ISSUED"],
  ISSUED: ["ACKNOWLEDGED"],
  ACKNOWLEDGED: [],
});

// ── Relationships ────────────────────────────────────────────────────────────

export const RELATIONSHIP_TYPES = ["PRODUCES_ORDER", "PRODUCES_NOTICE", "AFFECTS"];

// ── Numeric / misc ───────────────────────────────────────────────────────────

export const DEFAULT_PAGE_SIZE = 50;

// ── IAM resources ────────────────────────────────────────────────────────────

export const CHANGE_RESOURCES = Object.freeze({
  module: "iam.change",
  overview: "iam.change.overview",
  requests: "iam.change.requests",
  orders: "iam.change.orders",
  notices: "iam.change.notices",
  affectedItems: "iam.change.affected-items",
  ccb: "iam.change.ccb",
  admin: "iam.change.admin",
});

// ── Numbering object types (registered at foundation time) ─────────────────

export const NUMBERING_OBJECT_TYPES = Object.freeze({
  REQUEST: "ECR",
  ORDER: "ECO",
  NOTICE: "ECN",
});

// ── Domain events ────────────────────────────────────────────────────────────

export const CHANGE_EVENT_TYPES = [
  { code: "ChangeRequestCreated", description: "A change request (ECR) was created." },
  { code: "ChangeRequestSubmitted", description: "A change request was submitted for CCB screening." },
  { code: "ChangeRequestScreened", description: "A change request was screened by the CCB." },
  { code: "ChangeRequestPromoted", description: "A change request was promoted to a change order." },
  { code: "ChangeOrderCreated", description: "A change order (ECO) was created." },
  { code: "ChangeOrderSubmitted", description: "A change order was submitted for CCB approval." },
  { code: "ChangeOrderApproved", description: "A change order was approved by the CCB." },
  { code: "ChangeOrderRejected", description: "A change order was rejected by the CCB." },
  { code: "ChangeOrderReleased", description: "A change order was released; affected items became effective." },
  { code: "ChangeOrderCancelled", description: "A change order was cancelled." },
  { code: "ChangeAffectedItemAdded", description: "An affected item was added to a change order." },
  { code: "ChangeAffectedItemRemoved", description: "An affected item was removed from a change order." },
  { code: "ChangeNoticeCreated", description: "A change notice (ECN) was created." },
  { code: "ChangeNoticeIssued", description: "A change notice was issued." },
  { code: "ChangeNoticeAcknowledged", description: "A change notice was acknowledged." },
];

// ── Tenant configuration ─────────────────────────────────────────────────────

export const CONFIG_DEFAULTS = Object.freeze({
  default_request_status: "DRAFT",
  default_order_status: "DRAFT",
  enforce_unique_numbers: true,
  require_affected_items_to_release: true,
  ccb_min_approvals: 1,
  history_retention_days: 365,
});

export const CONFIG_BOUNDS = Object.freeze({
  ccb_min_approvals: { min: 1, max: 20 },
  history_retention_days: { min: 1, max: 3650 },
});
