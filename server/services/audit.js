// Public facade for the Audit & History Framework. Every module depends on
// this file (or the platform.js re-exports) rather than the internal layout, so
// the implementation can evolve without touching call sites. `writeAudit` is
// intentionally kept as the backwards-compatible entry point used by existing
// modules; it now writes rich, policy-aware audit events.

export {
  AUDIT_ACTIONS,
  AUDIT_ACTOR_TYPES,
  AUDIT_CATEGORIES,
  AUDIT_SECURITY_CLASSIFICATIONS,
  AUDIT_RETENTION_CATEGORIES,
  AUDIT_SOURCES,
  AUDIT_STATUSES,
  AUDIT_VISIBILITIES,
  AUDIT_VALUE_TYPES,
  AUDIT_EXPORT_FORMATS,
  AUDIT_EXPORT_STATUSES,
  AUDIT_FILTER_SCOPES,
  MANDATORY_ACTIONS,
  MANDATORY_CATEGORIES,
  eventTypeOf,
  categoryOfAction,
  isMandatoryEvent,
  normalizeAction,
  normalizeSource,
  normalizeStatus,
  normalizeVisibility,
  normalizeActorType,
  normalizeCategory,
  normalizeClassification,
  normalizeRetentionCategory,
  normalizeExportFormat,
  isSensitiveKey,
  maskValue,
  valueTypeOf,
  validatePolicyInput,
  validateRetentionPolicyInput,
  validateActionTypeInput,
  validateExportRequestInput,
  validateSavedFilterInput,
} from "./audit/validation.js";

export {
  capture,
  recordBatch,
  writeAudit,
  recordObjectChange,
  recordStateChange,
  recordRelationshipChange,
  recordWorkflowAction,
  recordSecurityEvent,
  recordAuthentication,
  resolveActionType,
  diffValues,
  maskObject,
  publicEvent,
  publicChange,
  listChangesForEvent,
  getEventRow,
  structuredLog,
} from "./audit/events.js";

export {
  publicPolicy,
  resolvePolicy,
  defaultEffectivePolicy,
  listPolicies,
  getPolicy,
  getPolicyRow,
  createPolicy,
  updatePolicy,
  deletePolicy,
  validatePolicy,
  ensureDefaultPolicies,
} from "./audit/policies.js";

export {
  buildEventFilters,
  listEvents,
  getEvent,
  objectHistory,
  userActivity,
  attributeHistory,
  relationshipHistory,
  securityActivity,
  workflowAudit,
  lifecycleAudit,
  configurationAudit,
  approvalAudit,
  documentAudit,
  integrationAudit,
  backgroundJobAudit,
  eventFacets,
  auditSummary,
  auditMetrics,
} from "./audit/query.js";

export { EXPORT_FORMATS, EXPORT_COLUMNS, toCsv, toExcelXml, exportEvents } from "./audit/export.js";

export {
  publicAuditExport,
  requestAuditExport,
  runAuditExport,
  listAuditExports,
  getAuditExport,
  markAuditExportDownloaded,
  expireAuditExports,
} from "./audit/exports.js";

export {
  publicActionType,
  listActionTypes,
  getActionType,
  createActionType,
  updateActionType,
  deleteActionType,
  ensureSystemActionTypes,
} from "./audit/actions.js";

export {
  publicSavedFilter,
  listSavedFilters,
  getSavedFilter,
  createSavedFilter,
  updateSavedFilter,
  deleteSavedFilter,
} from "./audit/filters.js";

export {
  publicRetentionPolicy,
  listRetentionPolicies,
  getRetentionPolicy,
  createRetentionPolicy,
  updateRetentionPolicy,
  deleteRetentionPolicy,
  ensureDefaultRetentionPolicies,
  executeRetentionPolicies,
  runRetention,
  listRetentionRuns,
  archiveStats,
} from "./audit/retention.js";

export {
  AUDIT_EVENT_TYPES,
  onAuditEvent,
  publishAuditEvent,
  createNotificationBridge,
  listenerCount,
} from "./audit/publisher.js";

export {
  clientIp,
  requestContext,
  auditContext,
  captureApiFailures,
  auditRoute,
  auditFromRequest,
} from "./audit/hooks.js";

export { registerAuditHandlers, runAuditMaintenance } from "./audit/jobs.js";

import { listEvents } from "./audit/query.js";

// Legacy listing used by GET /api/audit-logs. Preserves the original response
// shape while delegating to the rich query layer.
export function listAuditLogs(db, { page, pageSize, offset, action, resourceType, q, scope } = {}) {
  return listEvents(
    db,
    { page, pageSize, offset, action, objectType: resourceType, q },
    scope || { scopeAll: true }
  );
}
