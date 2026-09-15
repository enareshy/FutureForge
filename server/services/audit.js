// Public facade for the Audit & History Framework. Every module depends on
// this file (or the platform.js re-exports) rather than the internal layout, so
// the implementation can evolve without touching call sites. `writeAudit` is
// intentionally kept as the backwards-compatible entry point used by existing
// modules; it now writes rich, policy-aware audit events.

export {
  AUDIT_ACTIONS,
  AUDIT_SOURCES,
  AUDIT_STATUSES,
  AUDIT_VISIBILITIES,
  AUDIT_VALUE_TYPES,
  eventTypeOf,
  normalizeAction,
  normalizeSource,
  normalizeStatus,
  normalizeVisibility,
  isSensitiveKey,
  maskValue,
  valueTypeOf,
  validatePolicyInput,
} from "./audit/validation.js";

export {
  capture,
  writeAudit,
  recordObjectChange,
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
  ensureDefaultPolicies,
} from "./audit/policies.js";

export {
  buildEventFilters,
  listEvents,
  getEvent,
  objectHistory,
  userActivity,
  eventFacets,
  auditSummary,
} from "./audit/query.js";

export { EXPORT_FORMATS, EXPORT_COLUMNS, toCsv, toExcelXml, exportEvents } from "./audit/export.js";

export { runRetention, listRetentionRuns, archiveStats } from "./audit/retention.js";

export {
  clientIp,
  requestContext,
  auditContext,
  captureApiFailures,
  auditRoute,
  auditFromRequest,
} from "./audit/hooks.js";

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
