// Vocabulary, defaults and platform wiring codes for the Verification &
// Validation (V&V) Engine.
//
// V&V is a native domain: it owns its test-method, test-case, procedure,
// execution, result and waiver state, and composes everything else from the
// existing platform. Requirement identity/revisions, relationships, documents/
// evidence, workflow/approvals, lifecycle, quality exceptions, change
// management, traceability, events, jobs, audit and IAM all stay in their own
// engines. Nothing here duplicates a platform capability; this file only
// declares the shared vocabulary that lets the V&V flow be traced and governed.
export const SOURCE_MODULE = "verification-validation";

// The requirement side of a V&V edge is always a Requirement business object.
export const REQUIREMENT_SOURCE_TYPE = "requirement";

// Node types the V&V Digital Thread provider resolves. These are backed by the
// V&V engine's own tables (never by the generic object framework), so the
// provider projects them directly.
export const VV_NODE_TYPES = Object.freeze({
  REQUIREMENT: "requirement",
  TEST_CASE: "test_case",
  TEST_PROCEDURE: "test_procedure",
  TEST_EXECUTION: "test_execution",
  TEST_RESULT: "test_result",
  WAIVER: "waiver",
  EVIDENCE: "content",
});

export const VV_NODE_TYPE_CODES = Object.freeze([
  VV_NODE_TYPES.TEST_CASE,
  VV_NODE_TYPES.TEST_PROCEDURE,
  VV_NODE_TYPES.TEST_EXECUTION,
  VV_NODE_TYPES.TEST_RESULT,
  VV_NODE_TYPES.WAIVER,
]);

// ── Methods ─────────────────────────────────────────────────────────────────

export const VERIFICATION_KINDS = Object.freeze(["VERIFICATION", "VALIDATION"]);

export const METHOD_TYPES = Object.freeze(["TEST", "INSPECTION", "ANALYSIS", "DEMONSTRATION", "MEASUREMENT", "SIMULATION"]);

// Seeded verification/validation methods. Tenant configuration may add more; the
// engine treats them as data, never hard-codes behaviour on a method code.
export const DEFAULT_METHODS = Object.freeze([
  { code: "TEST", name: "Test", description: "Execute a controlled test and observe the outcome.", verification_kind: "BOTH", method_type: "TEST", requires_evidence: 1, sequence: 10 },
  { code: "INSPECTION", name: "Inspection", description: "Inspect the artifact against specified criteria.", verification_kind: "BOTH", method_type: "INSPECTION", requires_evidence: 1, sequence: 20 },
  { code: "ANALYSIS", name: "Analysis", description: "Analytical / computational demonstration of satisfaction.", verification_kind: "BOTH", method_type: "ANALYSIS", requires_evidence: 1, sequence: 30 },
  { code: "DEMONSTRATION", name: "Demonstration", description: "Demonstrate operation without detailed measurement.", verification_kind: "BOTH", method_type: "DEMONSTRATION", requires_evidence: 1, sequence: 40 },
  { code: "MEASUREMENT", name: "Measurement", description: "Measure a physical quantity against acceptance criteria.", verification_kind: "BOTH", method_type: "MEASUREMENT", requires_evidence: 1, sequence: 50 },
  { code: "SIMULATION", name: "Simulation", description: "Simulate behaviour and evaluate the results.", verification_kind: "BOTH", method_type: "SIMULATION", requires_evidence: 1, sequence: 60 },
]);

// ── Definitions ─────────────────────────────────────────────────────────────

export const DEFINITION_STATUSES = Object.freeze(["DRAFT", "IN_REVIEW", "APPROVED", "RELEASED", "OBSOLETE"]);

export const DEFINITION_TRANSITIONS = Object.freeze({
  DRAFT: ["IN_REVIEW", "OBSOLETE"],
  IN_REVIEW: ["APPROVED", "DRAFT", "OBSOLETE"],
  APPROVED: ["RELEASED", "IN_REVIEW", "OBSOLETE"],
  RELEASED: ["OBSOLETE"],
  OBSOLETE: [],
});

export const IMMUTABLE_DEFINITION_STATUSES = Object.freeze(["RELEASED", "OBSOLETE"]);

// ── Executions ──────────────────────────────────────────────────────────────

export const EXECUTION_STATUSES = Object.freeze([
  "PLANNED",
  "READY",
  "IN_PROGRESS",
  "COMPLETED",
  "EVALUATED",
  "REVIEWED",
  "BLOCKED",
  "CANCELLED",
  "FAILED",
  "REQUIRES_RETEST",
]);

export const DEFAULT_EXECUTION_TRANSITIONS = Object.freeze({
  PLANNED: ["READY", "CANCELLED", "BLOCKED"],
  READY: ["IN_PROGRESS", "PLANNED", "BLOCKED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "BLOCKED", "CANCELLED", "FAILED"],
  COMPLETED: ["EVALUATED", "REQUIRES_RETEST"],
  EVALUATED: ["REVIEWED", "REQUIRES_RETEST"],
  REVIEWED: ["REQUIRES_RETEST"],
  BLOCKED: ["READY", "PLANNED", "CANCELLED"],
  CANCELLED: [],
  FAILED: ["REQUIRES_RETEST", "EVALUATED"],
  REQUIRES_RETEST: [],
});

export const TERMINAL_EXECUTION_STATUSES = Object.freeze(["CANCELLED", "REVIEWED", "REQUIRES_RETEST"]);

// ── Results ─────────────────────────────────────────────────────────────────

export const RESULT_OUTCOMES = Object.freeze(["PASS", "FAIL", "PENDING", "BLOCKED", "NOT_EVALUABLE"]);

export const RESULT_LEVELS = Object.freeze(["OVERALL", "STEP", "MEASUREMENT", "REQUIREMENT"]);

// ── Waivers ─────────────────────────────────────────────────────────────────

export const WAIVER_STATUSES = Object.freeze(["REQUESTED", "APPROVED", "REJECTED", "REVOKED", "EXPIRED"]);

export const DEFAULT_WAIVER_TRANSITIONS = Object.freeze({
  REQUESTED: ["APPROVED", "REJECTED"],
  APPROVED: ["REVOKED", "EXPIRED"],
  REJECTED: [],
  REVOKED: [],
  EXPIRED: [],
});

// A waiver that counts as a valid exception for coverage/status.
export const ACTIVE_WAIVER_STATUSES = Object.freeze(["APPROVED"]);

// ── Coverage / requirement V&V status ───────────────────────────────────────

// Planning coverage: are the required definitions and criteria defined/linked.
export const PLANNING_COVERAGE_STATUSES = Object.freeze(["NOT_PLANNED", "PARTIAL", "PLANNED"]);

// Execution coverage: have the required executions completed with results/evidence.
export const EXECUTION_COVERAGE_STATUSES = Object.freeze(["NOT_STARTED", "IN_PROGRESS", "COMPLETE", "BLOCKED"]);

// The configurable requirement V&V status model (spec §12). Distinct from the
// requirement lifecycle status; mapped onto the existing
// `requirements.verification_status` / `.validation_status` columns where the
// platform already models those.
export const REQUIREMENT_VNV_STATUSES = Object.freeze([
  "NOT_PLANNED",
  "PLANNED",
  "IN_PROGRESS",
  "PENDING_EVIDENCE",
  "VERIFIED",
  "VALIDATION_COMPLETE",
  "FAILED",
  "PARTIALLY_VERIFIED",
  "WAIVED",
  "BLOCKED",
  "NOT_APPLICABLE",
  "OBSOLETE",
]);

// Maps a computed V&V status onto the existing requirement verification_status
// vocabulary so no competing requirement lifecycle is introduced.
export const REQUIREMENT_VERIFICATION_STATUS_MAP = Object.freeze({
  NOT_PLANNED: "NOT_VERIFIED",
  PLANNED: "NOT_VERIFIED",
  IN_PROGRESS: "IN_PROGRESS",
  PENDING_EVIDENCE: "IN_PROGRESS",
  VERIFIED: "VERIFIED",
  VALIDATION_COMPLETE: "VERIFIED",
  FAILED: "FAILED",
  PARTIALLY_VERIFIED: "IN_PROGRESS",
  WAIVED: "WAIVED",
  BLOCKED: "IN_PROGRESS",
  NOT_APPLICABLE: "NOT_VERIFIED",
  OBSOLETE: "NOT_VERIFIED",
});

export const COVERAGE_AGGREGATION_RULES = Object.freeze(["ALL_MANDATORY", "ANY", "MAJORITY"]);

export const COVERAGE_STATUSES = Object.freeze(["COVERED", "PARTIAL", "GAP", "UNALLOCATED"]);

// ── Relationship / trace strategy ───────────────────────────────────────────
//
// Requirement <-> Test case links reuse the Requirements Manager's generic edge
// table (`requirement_relationships`) and its existing relationship vocabulary,
// so no second requirement-to-test mapping model is created (spec §5). These two
// codes already exist in `requirements/constants.js RELATIONSHIP_TYPES`.
export const REQUIREMENT_VNV_RELATIONSHIPS = Object.freeze(["VERIFIED_BY", "VALIDATED_BY"]);

export const RELATIONSHIP_TYPE_FOR_KIND = Object.freeze({
  VERIFICATION: "VERIFIED_BY",
  VALIDATION: "VALIDATED_BY",
});

// Object & relationship edge codes this layer registers for non-requirement
// cross-domain context edges (product/item, operation, documents). Internal V&V
// relationships use foreign keys, so only genuinely cross-domain edges are here.
export const VV_RELATIONSHIP_TYPES = Object.freeze([
  { code: "test-execution.applies-to.product", name: "Test execution applies to product", description: "A test execution was performed against a PDM product/item revision.", source_type: null, target_type: null, semantic: "association" },
  { code: "test-execution.realizes.operation", name: "Test execution realizes operation", description: "A test execution verifies a manufacturing operation (Prompt 5/6 context).", source_type: null, target_type: "operation", semantic: "association" },
  { code: "test-result.evidence-for.requirement", name: "Test result evidence for requirement", description: "A test result provides evidence for a requirement revision.", source_type: null, target_type: null, semantic: "association" },
  { code: "waiver.applies-to.requirement", name: "Waiver applies to requirement", description: "A waiver / exception applies to a requirement revision.", source_type: null, target_type: null, semantic: "association" },
  { code: "test-result.supported-by.content", name: "Test result supported by evidence", description: "A test result is supported by a controlled evidence document.", source_type: null, target_type: null, semantic: "association" },
]);

export const VV_RELATIONSHIP_CODES = Object.freeze(VV_RELATIONSHIP_TYPES.map((entry) => entry.code));

// ── IAM resources ─────────────────────────────────────────────────────────────

export const VV_RESOURCES = Object.freeze({
  module: "iam.verification-validation",
  overview: "iam.verification-validation.overview",
  testCases: "iam.verification-validation.test-cases",
  procedures: "iam.verification-validation.procedures",
  executions: "iam.verification-validation.executions",
  results: "iam.verification-validation.results",
  evidence: "iam.verification-validation.evidence",
  coverage: "iam.verification-validation.coverage",
  waivers: "iam.verification-validation.waivers",
  traceability: "iam.verification-validation.traceability",
  impact: "iam.verification-validation.impact",
  quality: "iam.verification-validation.quality",
  metrics: "iam.verification-validation.metrics",
  admin: "iam.verification-validation.admin",
});

export const VV_SECURITY_ACTIONS = Object.freeze([
  "VIEW_VERIFICATION_VALIDATION",
  "MANAGE_TEST_CASE",
  "APPROVE_TEST_CASE",
  "MANAGE_TEST_PROCEDURE",
  "PLAN_TEST_EXECUTION",
  "EXECUTE_TEST",
  "RECORD_TEST_RESULT",
  "REVIEW_TEST_RESULT",
  "ATTACH_EVIDENCE",
  "VIEW_VV_COVERAGE",
  "REQUEST_WAIVER",
  "APPROVE_WAIVER",
  "VIEW_VV_TRACEABILITY",
  "ANALYZE_VV_IMPACT",
  "RAISE_QUALITY_EXCEPTION",
  "CONFIGURE_VERIFICATION_VALIDATION",
]);

// ── Domain events ─────────────────────────────────────────────────────────────

export const VV_EVENT_TYPES = Object.freeze([
  { code: "TestCaseCreated", description: "A V&V test case was created." },
  { code: "TestCaseApproved", description: "A V&V test case was approved." },
  { code: "TestProcedureCreated", description: "A V&V test procedure was created." },
  { code: "TestExecutionStarted", description: "A V&V test execution started." },
  { code: "TestExecutionCompleted", description: "A V&V test execution completed." },
  { code: "TestResultRecorded", description: "A V&V test result was recorded." },
  { code: "TestResultEvaluated", description: "A V&V test result was evaluated against acceptance criteria." },
  { code: "VerificationFailed", description: "A verification activity failed." },
  { code: "VerificationCompleted", description: "A requirement verification completed successfully." },
  { code: "ValidationCompleted", description: "A requirement validation completed successfully." },
  { code: "EvidenceAttached", description: "Evidence was attached to an execution or result." },
  { code: "RetestRequested", description: "A retest was requested for a failed execution." },
  { code: "WaiverRequested", description: "A waiver / exception was requested." },
  { code: "WaiverApproved", description: "A waiver / exception was approved." },
  { code: "WaiverRevoked", description: "A waiver / exception was revoked or rejected." },
  { code: "RequirementVnVStatusChanged", description: "A requirement's V&V status changed." },
  { code: "VerificationEvidenceInvalidated", description: "Verification evidence was flagged as potentially stale after a revision change." },
  { code: "QualityExceptionRaised", description: "A failure raised an existing Quality module exception." },
]);

export const VV_EVENT_MAP = Object.freeze({
  TEST_CASE_CREATED: "TestCaseCreated",
  TEST_CASE_APPROVED: "TestCaseApproved",
  TEST_PROCEDURE_CREATED: "TestProcedureCreated",
  EXECUTION_STARTED: "TestExecutionStarted",
  EXECUTION_COMPLETED: "TestExecutionCompleted",
  RESULT_RECORDED: "TestResultRecorded",
  RESULT_EVALUATED: "TestResultEvaluated",
  VERIFICATION_FAILED: "VerificationFailed",
  VERIFICATION_COMPLETED: "VerificationCompleted",
  VALIDATION_COMPLETED: "ValidationCompleted",
  EVIDENCE_ATTACHED: "EvidenceAttached",
  RETEST_REQUESTED: "RetestRequested",
  WAIVER_REQUESTED: "WaiverRequested",
  WAIVER_APPROVED: "WaiverApproved",
  WAIVER_REVOKED: "WaiverRevoked",
  REQ_VNV_STATUS_CHANGED: "RequirementVnVStatusChanged",
  EVIDENCE_INVALIDATED: "VerificationEvidenceInvalidated",
  QUALITY_EXCEPTION_RAISED: "QualityExceptionRaised",
});

// ── Background jobs ────────────────────────────────────────────────────────────

export const VV_HANDLER_CODES = Object.freeze({
  COVERAGE_RECALC: "verification-validation.coverageRecalc",
  STALE_EVIDENCE_SCAN: "verification-validation.staleEvidenceScan",
});

export const VV_JOB_TYPES = [
  {
    code: "VV_COVERAGE_RECALC",
    name: "V&V requirement coverage recalculation",
    description: "Recalculate planning/execution coverage and requirement V&V status from executions, results, evidence and valid waivers.",
    source_module: SOURCE_MODULE,
    handler: VV_HANDLER_CODES.COVERAGE_RECALC,
    queues: ["verification-validation", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "normal",
  },
  {
    code: "VV_STALE_EVIDENCE_SCAN",
    name: "V&V stale evidence scan",
    description: "Detect verification evidence that may be stale after a requirement, test case or product revision change and publish invalidation events.",
    source_module: SOURCE_MODULE,
    handler: VV_HANDLER_CODES.STALE_EVIDENCE_SCAN,
    queues: ["verification-validation", "default"],
    timeout_seconds: 7200,
    max_retries: 1,
    default_priority: "low",
  },
];

export const VV_QUEUE = "verification-validation";

// ── Integration / subscriptions ─────────────────────────────────────────────────

export const VV_INTEGRATION = Object.freeze({
  coverageHandler: "verification-validation.coverage",
  requirementEventHandler: "verification-validation.requirement-change",
  messageType: "verification_validation.status",
  queue: "INTEGRATION",
  subscriptionPrefix: "vv",
});

// Requirement lifecycle events that can invalidate a requirement's verification
// evidence. The handler resolves the affected requirement's executions and flags
// potentially stale evidence (never auto-deleting history).
export const VV_REQUIREMENT_SUBSCRIPTIONS = Object.freeze([
  { event_type_code: "RequirementRevised" },
  { event_type_code: "RequirementUpdated" },
  { event_type_code: "RequirementReleased" },
]);

// Own V&V events that warrant a coverage/status re-evaluation for the affected
// requirement(s). Consuming our own events keeps the coverage logic in one place
// and avoids polling (mirrors requirement-manufacturing trace subscriptions).
export const VV_EVENT_SUBSCRIPTIONS = Object.freeze([
  { event_type_code: "TestCaseApproved" },
  { event_type_code: "TestExecutionCompleted" },
  { event_type_code: "TestResultRecorded" },
  { event_type_code: "TestResultEvaluated" },
  { event_type_code: "VerificationCompleted" },
  { event_type_code: "ValidationCompleted" },
  { event_type_code: "WaiverApproved" },
  { event_type_code: "WaiverRevoked" },
]);

// ── Configuration ─────────────────────────────────────────────────────────────

export const CONFIG_PREFIX = "verification_validation.";

export const CONFIG_KEYS = Object.freeze({
  defaultVerificationKind: "verification_validation.default_verification_kind",
  requireApprovedTestCase: "verification_validation.require_approved_test_case",
  requireApprovedProcedure: "verification_validation.require_approved_procedure",
  requireEvidenceForPass: "verification_validation.require_evidence_for_pass",
  requireExecutionForVerification: "verification_validation.require_execution_for_verification",
  aggregationRule: "verification_validation.aggregation_rule",
  waiversEnabled: "verification_validation.waivers_enabled",
  waiverRequireApproval: "verification_validation.waiver_require_approval",
  retestPolicy: "verification_validation.retest_policy",
  staleEvidenceOnRevisionChange: "verification_validation.stale_evidence_on_revision_change",
  autoInvalidateEvidence: "verification_validation.auto_invalidate_evidence",
  impactMaxDepth: "verification_validation.impact_max_depth",
  notifyOnFailure: "verification_validation.notify_on_failure",
  qualityExceptionOnFailure: "verification_validation.quality_exception_on_failure",
  qualityExceptionSeverity: "verification_validation.quality_exception_severity",
  coverageBatchSize: "verification_validation.coverage_batch_size",
});

export const CONFIG_DEFAULTS = Object.freeze({
  default_verification_kind: "VERIFICATION",
  require_approved_test_case: true,
  require_approved_procedure: false,
  require_evidence_for_pass: true,
  require_execution_for_verification: true,
  aggregation_rule: "ALL_MANDATORY",
  waivers_enabled: true,
  waiver_require_approval: true,
  retest_policy: "FULL_TEST",
  stale_evidence_on_revision_change: true,
  auto_invalidate_evidence: false,
  impact_max_depth: 10,
  notify_on_failure: true,
  quality_exception_on_failure: false,
  quality_exception_severity: "warning",
  coverage_batch_size: 200,
});

export const CONFIG_BOUNDS = Object.freeze({
  impact_max_depth: { min: 1, max: 50 },
  coverage_batch_size: { min: 1, max: 5000 },
});

export const RETEST_POLICIES = Object.freeze(["FULL_TEST", "FAILED_STEPS", "FAILED_TEST"]);

// ── Quality module relation ─────────────────────────────────────────────────────
//
// A failed V&V result can raise an existing Data Quality exception (source module
// `data-governance`) instead of a parallel quality/deviation subsystem. The V&V
// engine only stores the returned exception reference; the exception lifecycle,
// waiver semantics and notifications stay owned by the Quality module.
export const QUALITY_MODULE = Object.freeze({
  source_module: "data-governance",
  exception_resource: "iam.data-governance",
  default_dimension: "validity",
  default_severity: "warning",
});

// ── Numbering ─────────────────────────────────────────────────────────────────

export const NUMBERING_OBJECT_TYPES = Object.freeze({
  TEST_CASE: "VV_TEST_CASE",
  PROCEDURE: "VV_TEST_PROCEDURE",
  EXECUTION: "VV_TEST_EXECUTION",
  WAIVER: "VV_TEST_WAIVER",
});

export const NUMBERING_SCHEMES = Object.freeze({
  [NUMBERING_OBJECT_TYPES.TEST_CASE]: { code: "VV_TEST_CASE_DEFAULT", pattern: "TC-{SEQ}", padding: 6 },
  [NUMBERING_OBJECT_TYPES.PROCEDURE]: { code: "VV_TEST_PROCEDURE_DEFAULT", pattern: "TP-{SEQ}", padding: 6 },
  [NUMBERING_OBJECT_TYPES.EXECUTION]: { code: "VV_TEST_EXECUTION_DEFAULT", pattern: "TE-{SEQ}", padding: 6 },
  [NUMBERING_OBJECT_TYPES.WAIVER]: { code: "VV_TEST_WAIVER_DEFAULT", pattern: "VW-{SEQ}", padding: 5 },
});

// ── Search ─────────────────────────────────────────────────────────────────────

export const SEARCH_OBJECT_TYPES = [
  { code: "vv_test_case", name: "V&V test cases", description: "Verification & validation test case definitions with method, kind and lifecycle status." },
  { code: "vv_test_execution", name: "V&V test executions", description: "Verification & validation test executions with status, tester and outcome." },
];

// ── Bounds ─────────────────────────────────────────────────────────────────────

export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 100;
export const MAX_IMPACT_DEPTH = 50;
export const MAX_TRAVERSAL_DEPTH = 10;
