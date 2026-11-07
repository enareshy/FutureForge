// Public facade for the Verification & Validation (V&V) Engine.
//
// Every consumer (API layer, jobs, Digital Thread projections, other domains)
// depends on this file rather than the internal layout so the implementation can
// evolve safely. Databases are always passed first so a call can participate in
// the caller's transaction (mirrors requirement-manufacturing/index.js).
import * as Constants from "./constants.js";
import * as Errors from "./errors.js";
import * as Refs from "./refs.js";
import * as Configuration from "./configuration.js";
import * as Events from "./events.js";
import * as Security from "./security.js";
import * as Methods from "./methods.js";
import * as TestCases from "./test-cases.js";
import * as TestProcedures from "./test-procedures.js";
import * as TestExecutions from "./test-executions.js";
import * as TestResults from "./test-results.js";
import * as Evaluation from "./evaluation.js";
import * as Evidence from "./evidence.js";
import * as Coverage from "./coverage.js";
import * as Waivers from "./waivers.js";
import * as Retest from "./retest.js";
import * as Deviation from "./deviation.js";
import * as RevisionImpact from "./revision-impact.js";
import * as Provider from "./provider.js";
import * as Jobs from "./jobs.js";
import * as Subscriptions from "./subscriptions.js";
import * as Audit from "./audit.js";
import * as Search from "./search.js";
import * as Foundation from "./foundation.js";

export { Constants, Errors, Refs, Configuration, Events, Security, Methods, TestCases, TestProcedures, TestExecutions, TestResults, Evaluation, Evidence, Coverage, Waivers, Retest, Deviation, RevisionImpact, Provider, Jobs, Subscriptions, Audit, Search, Foundation };

export {
  SOURCE_MODULE,
  REQUIREMENT_SOURCE_TYPE,
  VV_NODE_TYPES,
  VV_NODE_TYPE_CODES,
  VERIFICATION_KINDS,
  METHOD_TYPES,
  DEFAULT_METHODS,
  DEFINITION_STATUSES,
  DEFINITION_TRANSITIONS,
  IMMUTABLE_DEFINITION_STATUSES,
  EXECUTION_STATUSES,
  DEFAULT_EXECUTION_TRANSITIONS,
  TERMINAL_EXECUTION_STATUSES,
  RESULT_OUTCOMES,
  RESULT_LEVELS,
  WAIVER_STATUSES,
  DEFAULT_WAIVER_TRANSITIONS,
  ACTIVE_WAIVER_STATUSES,
  PLANNING_COVERAGE_STATUSES,
  EXECUTION_COVERAGE_STATUSES,
  REQUIREMENT_VNV_STATUSES,
  REQUIREMENT_VERIFICATION_STATUS_MAP,
  COVERAGE_AGGREGATION_RULES,
  COVERAGE_STATUSES,
  REQUIREMENT_VNV_RELATIONSHIPS,
  RELATIONSHIP_TYPE_FOR_KIND,
  VV_RELATIONSHIP_TYPES,
  VV_RELATIONSHIP_CODES,
  VV_RESOURCES,
  VV_SECURITY_ACTIONS,
  VV_EVENT_TYPES,
  VV_EVENT_MAP,
  VV_HANDLER_CODES,
  VV_JOB_TYPES,
  VV_QUEUE,
  VV_INTEGRATION,
  VV_REQUIREMENT_SUBSCRIPTIONS,
  VV_EVENT_SUBSCRIPTIONS,
  CONFIG_PREFIX,
  CONFIG_KEYS,
  CONFIG_DEFAULTS,
  CONFIG_BOUNDS,
  RETEST_POLICIES,
  QUALITY_MODULE,
  NUMBERING_OBJECT_TYPES,
  NUMBERING_SCHEMES,
  SEARCH_OBJECT_TYPES,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  MAX_IMPACT_DEPTH,
  MAX_TRAVERSAL_DEPTH,
} from "./constants.js";

export {
  APPLICABILITY_STATUSES,
  APPLICABILITY_REASONS,
  assessRevisionApplicability,
  assessExecutionApplicability,
  assessExecutionApplicabilityAsync,
  listStaleEvidence,
  listStaleEvidenceAsync,
  flagStaleEvidence,
  flagStaleEvidenceAsync,
  scanStaleEvidence,
  scanStaleEvidenceAsync,
  analyzeRequirementImpact,
  analyzeRequirementImpactAsync,
} from "./revision-impact.js";

export { verificationValidationProvider, registerVvProvider } from "./provider.js";

export {
  ensureVvJobTypes,
  ensureVvJobTypesAsync,
  registerVvHandlers,
  runCoverageRecalc,
  runCoverageRecalcAsync,
  runStaleEvidenceScan,
  runStaleEvidenceScanAsync,
  submitCoverageRecalc,
  submitCoverageRecalcAsync,
  submitStaleEvidenceScan,
  submitStaleEvidenceScanAsync,
} from "./jobs.js";

export {
  registerVvCoverageEventHandler,
  registerVvRequirementEventHandler,
  ensureVvEventSubscriptions,
  ensureVvEventSubscriptionsAsync,
  ensureVvRequirementSubscriptions,
  ensureVvRequirementSubscriptionsAsync,
  vvSubscriptionSummary,
  vvSubscriptionSummaryAsync,
} from "./subscriptions.js";

export { listVvAudit, listVvAuditAsync } from "./audit.js";

export {
  recalculateTenantCoverage,
  recalculateTenantCoverageAsync,
} from "./coverage.js";
