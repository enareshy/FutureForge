// Public facade for the Manufacturing & Quality Intelligence layer (Stage 9).
//
// Every consumer (API layer, other domains, Digital Thread projections) depends
// on this file rather than the internal layout so the implementation can evolve
// safely. Databases are always passed first so a call can participate in the
// caller's transaction (mirrors verification-validation/index.js).
import * as Constants from "./constants.js";
import * as Errors from "./errors.js";
import * as Refs from "./refs.js";
import * as Configuration from "./configuration.js";
import * as Events from "./events.js";
import * as Security from "./security.js";
import * as Subjects from "./subjects.js";
import * as Quality from "./quality.js";
import * as Readiness from "./readiness.js";
import * as Foundation from "./foundation.js";

export { Constants, Errors, Refs, Configuration, Events, Security, Subjects, Quality, Readiness, Foundation };

export {
  SOURCE_MODULE,
  SUBJECT_TYPES,
  ISSUE_TYPES,
  ISSUE_SEVERITIES,
  ISSUE_STATUSES,
  ISSUE_DISPOSITIONS,
  ACTIVE_ISSUE_STATUSES,
  CLOSED_ISSUE_STATUSES,
  INSPECTION_TYPES,
  INSPECTION_STATUSES,
  TERMINAL_INSPECTION_STATUSES,
  ACTION_TYPES,
  ACTION_STATUSES,
  OPEN_ACTION_STATUSES,
  ACTION_EFFECTIVENESS,
  READINESS_RESULTS,
  READINESS_SEVERITIES,
  READINESS_DIMENSIONS,
  READINESS_CHECKS,
  READINESS_CHECK_CODES,
  MANUFACTURING_QUALITY_RESOURCES,
  MANUFACTURING_QUALITY_SECURITY_ACTIONS,
  MANUFACTURING_QUALITY_EVENT_TYPES,
  MANUFACTURING_QUALITY_EVENT_MAP,
  CONFIG_PREFIX,
  CONFIG_KEYS,
  CONFIG_DEFAULTS,
  CONFIG_BOUNDS,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
} from "./constants.js";

export {
  publicIssue,
  publicInspection,
  publicAction,
  listQualityIssues,
  listQualityIssuesAsync,
  getQualityIssue,
  getQualityIssueAsync,
  createQualityIssue,
  createQualityIssueAsync,
  updateQualityIssue,
  updateQualityIssueAsync,
  getIssueRow,
  getIssueRowAsync,
  requireIssueRow,
  requireIssueRowAsync,
  listInspections,
  listInspectionsAsync,
  createInspection,
  createInspectionAsync,
  getInspectionRow,
  getInspectionRowAsync,
  requireInspectionRow,
  requireInspectionRowAsync,
  listCorrectiveActions,
  listCorrectiveActionsAsync,
  createCorrectiveAction,
  createCorrectiveActionAsync,
  updateCorrectiveAction,
  updateCorrectiveActionAsync,
  getActionRow,
  getActionRowAsync,
  requireActionRow,
  requireActionRowAsync,
  productQualitySummary,
  productQualitySummaryAsync,
  detectRecurrence,
  detectRecurrenceAsync,
  detectQualityGaps,
  detectQualityGapsAsync,
  issueMetrics,
  issueMetricsAsync,
} from "./quality.js";

export {
  publicEvaluation,
  listReadinessEvaluations,
  listReadinessEvaluationsAsync,
  getReadinessEvaluation,
  getReadinessEvaluationAsync,
  getEvaluationRow,
  getEvaluationRowAsync,
  requireEvaluationRow,
  requireEvaluationRowAsync,
  evaluateReadiness,
  evaluateReadinessAsync,
  markReadinessStale,
  markReadinessStaleAsync,
  readinessMeta,
} from "./readiness.js";

export {
  resolveSubject,
  resolveSubjectAsync,
  normalizeSubjectType,
  resolveObjectSubject,
  resolveObjectSubjectAsync,
  resolveBomRevisionSubject,
  resolveBomRevisionSubjectAsync,
  resolveChangeSubject,
  resolveChangeSubjectAsync,
} from "./subjects.js";

export { ensureManufacturingQualityFoundation, ensureManufacturingQualityFoundationAsync, manufacturingQualityHealth, manufacturingQualityHealthAsync } from "./foundation.js";
