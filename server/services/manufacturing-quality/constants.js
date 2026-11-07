// Vocabulary, defaults and platform wiring codes for the Manufacturing &
// Quality Intelligence layer (Stage 9).
//
// This is a composition layer. Product structures stay in the BOM engine,
// operations/work centres in the Object framework and Requirement ->
// Manufacturing layer, the graph in the Digital Thread, and verification in the
// V&V engine. Here we declare only the shared vocabulary (quality issue /
// inspection / corrective action codes, readiness checks, IAM resources, event
// types and configuration keys) that lets manufacturing and quality be assessed
// together without duplicating any engine.
export const SOURCE_MODULE = "manufacturing-quality";

// Authoritative source object references a quality record may point at. These
// are resolved through the owning module so a quality issue can never reference
// an object that does not exist or belongs to another tenant.
export const SUBJECT_TYPES = Object.freeze({
  PRODUCT_REVISION: "PRODUCT_REVISION",
  CHANGE: "CHANGE",
  OPERATION: "OPERATION",
  MBOM_REVISION: "MBOM_REVISION",
});

export const ISSUE_TYPES = Object.freeze(["NONCONFORMANCE", "DEVIATION", "COMPLAINT", "DEFECT", "OBSERVATION"]);
export const ISSUE_SEVERITIES = Object.freeze(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export const ISSUE_STATUSES = Object.freeze(["OPEN", "INVESTIGATING", "CONTAINED", "RESOLVED", "CLOSED", "CANCELLED"]);
export const ISSUE_DISPOSITIONS = Object.freeze(["", "USE_AS_IS", "REWORK", "REPAIR", "SCRAP", "RETURN_TO_SUPPLIER", "SORT"]);
export const ACTIVE_ISSUE_STATUSES = Object.freeze(["OPEN", "INVESTIGATING", "CONTAINED"]);
export const CLOSED_ISSUE_STATUSES = Object.freeze(["RESOLVED", "CLOSED"]);

export const INSPECTION_TYPES = Object.freeze(["INCOMING", "IN_PROCESS", "FINAL", "AUDIT", "SUPPLIER", "PERIODIC"]);
export const INSPECTION_STATUSES = Object.freeze(["PLANNED", "IN_PROGRESS", "PASSED", "FAILED", "WAIVED", "CANCELLED"]);
export const TERMINAL_INSPECTION_STATUSES = Object.freeze(["PASSED", "FAILED", "WAIVED", "CANCELLED"]);

export const ACTION_TYPES = Object.freeze(["CORRECTIVE", "PREVENTIVE", "CONTAINMENT"]);
export const ACTION_STATUSES = Object.freeze(["OPEN", "IN_PROGRESS", "IMPLEMENTED", "VERIFIED", "CLOSED", "CANCELLED"]);
export const OPEN_ACTION_STATUSES = Object.freeze(["OPEN", "IN_PROGRESS"]);
export const ACTION_EFFECTIVENESS = Object.freeze(["", "EFFECTIVE", "NOT_EFFECTIVE", "PENDING"]);

// ── Release readiness ────────────────────────────────────────────────────────
//
// Each check is deterministic. A check that cannot obtain its inputs reports
// NOT_EVALUATED rather than silently passing (prompt §6.4). Dimensions are
// grouped so a readiness report can be read by engineering/manufacturing/
// quality without losing the underlying check identity.
export const READINESS_RESULTS = Object.freeze(["PASS", "FAIL", "WARNING", "NOT_EVALUATED"]);
export const READINESS_SEVERITIES = Object.freeze(["INFO", "WARNING", "ERROR", "CRITICAL"]);

export const READINESS_DIMENSIONS = Object.freeze([
  { code: "ENGINEERING", label: "Engineering readiness", order: 10 },
  { code: "PRODUCT_STRUCTURE", label: "Product structure readiness", order: 20 },
  { code: "MANUFACTURING", label: "Manufacturing readiness", order: 30 },
  { code: "WORK_INSTRUCTION", label: "Work-instruction readiness", order: 40 },
  { code: "QUALITY", label: "Quality readiness", order: 50 },
  { code: "APPROVAL", label: "Required approvals", order: 60 },
  { code: "DOCUMENT", label: "Document completeness", order: 70 },
]);

export const READINESS_CHECKS = Object.freeze([
  { code: "PRODUCT_REVISION_PRESENT", dimension: "ENGINEERING", severity: "CRITICAL", description: "The subject product revision exists." },
  { code: "PRODUCT_REVISION_RELEASED", dimension: "ENGINEERING", severity: "ERROR", description: "The subject product revision is released." },
  { code: "BOM_STRUCTURE_PRESENT", dimension: "PRODUCT_STRUCTURE", severity: "ERROR", description: "An EBOM or MBOM structure exists for the revision." },
  { code: "BOM_STRUCTURE_VALID", dimension: "PRODUCT_STRUCTURE", severity: "ERROR", description: "The latest BOM validation run raised no errors." },
  { code: "MBOM_PRESENT", dimension: "MANUFACTURING", severity: "WARNING", description: "A manufacturing BOM exists for the product." },
  { code: "BOP_PRESENT", dimension: "MANUFACTURING", severity: "WARNING", description: "A bill of process exists for the MBOM." },
  { code: "OPERATIONS_PRESENT", dimension: "MANUFACTURING", severity: "WARNING", description: "The bill of process defines at least one operation." },
  { code: "OPERATIONS_HAVE_WORK_INSTRUCTIONS", dimension: "WORK_INSTRUCTION", severity: "WARNING", description: "Every operation has at least one work instruction." },
  { code: "OPEN_QUALITY_ISSUES", dimension: "QUALITY", severity: "ERROR", description: "No critical/high quality issue is open for the product." },
  { code: "CORRECTIVE_ACTIONS_COMPLETE", dimension: "QUALITY", severity: "WARNING", description: "Corrective actions for linked issues are closed." },
  { code: "INSPECTIONS_COMPLETE", dimension: "QUALITY", severity: "WARNING", description: "Planned inspections have a passing or waived outcome." },
  { code: "REQUIRED_APPROVALS", dimension: "APPROVAL", severity: "ERROR", description: "Required approvals are recorded." },
  { code: "DOCUMENT_COMPLETENESS", dimension: "DOCUMENT", severity: "INFO", description: "Linked specification documents are present." },
]);

export const READINESS_CHECK_CODES = Object.freeze(READINESS_CHECKS.map((entry) => entry.code));

// ── IAM resources ────────────────────────────────────────────────────────────

export const MANUFACTURING_QUALITY_RESOURCES = Object.freeze({
  module: "iam.manufacturing-quality",
  overview: "iam.manufacturing-quality.overview",
  issues: "iam.manufacturing-quality.issues",
  inspections: "iam.manufacturing-quality.inspections",
  correctiveActions: "iam.manufacturing-quality.corrective-actions",
  readiness: "iam.manufacturing-quality.readiness",
  impact: "iam.manufacturing-quality.impact",
  summaries: "iam.manufacturing-quality.summaries",
  metrics: "iam.manufacturing-quality.metrics",
  admin: "iam.manufacturing-quality.admin",
});

export const MANUFACTURING_QUALITY_SECURITY_ACTIONS = Object.freeze([
  "VIEW_MANUFACTURING_QUALITY",
  "MANAGE_QUALITY_ISSUE",
  "MANAGE_QUALITY_INSPECTION",
  "MANAGE_CORRECTIVE_ACTION",
  "EVALUATE_RELEASE_READINESS",
  "ANALYZE_MANUFACTURING_QUALITY_IMPACT",
  "CONFIGURE_MANUFACTURING_QUALITY",
]);

// ── Domain events ────────────────────────────────────────────────────────────

export const MANUFACTURING_QUALITY_EVENT_TYPES = Object.freeze([
  { code: "QualityIssueCreated", description: "A quality issue / non-conformance was recorded." },
  { code: "QualityIssueStatusChanged", description: "A quality issue changed status or disposition." },
  { code: "QualityInspectionRecorded", description: "An inspection outcome was recorded." },
  { code: "CorrectiveActionChanged", description: "A corrective action was created or changed status." },
  { code: "ReleaseReadinessEvaluated", description: "A release-readiness evaluation was completed." },
  { code: "ReleaseReadinessStale", description: "A release-readiness evaluation became stale after a source change." },
  { code: "ManufacturingQualitySummaryGenerated", description: "A manufacturing/quality summary was generated." },
]);

export const MANUFACTURING_QUALITY_EVENT_MAP = Object.freeze({
  ISSUE_CREATED: "QualityIssueCreated",
  ISSUE_STATUS_CHANGED: "QualityIssueStatusChanged",
  INSPECTION_RECORDED: "QualityInspectionRecorded",
  CORRECTIVE_ACTION_CHANGED: "CorrectiveActionChanged",
  READINESS_EVALUATED: "ReleaseReadinessEvaluated",
  READINESS_STALE: "ReleaseReadinessStale",
  SUMMARY_GENERATED: "ManufacturingQualitySummaryGenerated",
});

// ── Configuration keys ───────────────────────────────────────────────────────

export const CONFIG_PREFIX = "manufacturing_quality.";

export const CONFIG_KEYS = Object.freeze({
  readinessProfile: "manufacturing_quality.readiness_profile",
  readinessPassThreshold: "manufacturing_quality.readiness_pass_threshold",
  readinessChecks: "manufacturing_quality.readiness_checks",
  requireReleasedRevision: "manufacturing_quality.require_released_revision",
  requireInspections: "manufacturing_quality.require_inspections",
  requireWorkInstructions: "manufacturing_quality.require_work_instructions",
  blockOnCriticalIssues: "manufacturing_quality.block_on_critical_issues",
  staleOnSourceChange: "manufacturing_quality.stale_on_source_change",
  recurrenceWindowDays: "manufacturing_quality.recurrence_window_days",
});

export const CONFIG_DEFAULTS = Object.freeze({
  readiness_profile: "DEFAULT",
  readiness_pass_threshold: 80,
  readiness_checks: READINESS_CHECK_CODES.join(","),
  require_released_revision: true,
  require_inspections: true,
  require_work_instructions: true,
  block_on_critical_issues: true,
  stale_on_source_change: true,
  recurrence_window_days: 90,
});

export const CONFIG_BOUNDS = Object.freeze({
  readiness_pass_threshold: { min: 0, max: 100 },
  recurrence_window_days: { min: 1, max: 3650 },
});

export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 100;
