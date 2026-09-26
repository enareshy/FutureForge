// Standardized Reporting & Analytics error codes (§35).
//
// The HTTP layer serializes `code` alongside `error` and `details` so clients
// branch on stable identifiers rather than parsing prose. Database exceptions
// and stack traces are never surfaced to clients.
import { HttpError } from "../../validation.js";

export const REPORTING_ERROR_CODES = Object.freeze({
  REPORT_NOT_FOUND: "REPORTING_REPORT_NOT_FOUND",
  REPORT_CONFLICT: "REPORTING_REPORT_CONFLICT",
  INVALID_REPORT: "REPORTING_INVALID_REPORT",
  REPORT_IMMUTABLE: "REPORTING_REPORT_IMMUTABLE",
  DASHBOARD_NOT_FOUND: "REPORTING_DASHBOARD_NOT_FOUND",
  DASHBOARD_CONFLICT: "REPORTING_DASHBOARD_CONFLICT",
  INVALID_DASHBOARD: "REPORTING_INVALID_DASHBOARD",
  DASHBOARD_IMMUTABLE: "REPORTING_DASHBOARD_IMMUTABLE",
  WIDGET_NOT_FOUND: "REPORTING_WIDGET_NOT_FOUND",
  METRIC_NOT_FOUND: "REPORTING_METRIC_NOT_FOUND",
  METRIC_CONFLICT: "REPORTING_METRIC_CONFLICT",
  INVALID_METRIC: "REPORTING_INVALID_METRIC",
  KPI_NOT_FOUND: "REPORTING_KPI_NOT_FOUND",
  KPI_CONFLICT: "REPORTING_KPI_CONFLICT",
  INVALID_KPI: "REPORTING_INVALID_KPI",
  SCHEDULE_NOT_FOUND: "REPORTING_SCHEDULE_NOT_FOUND",
  INVALID_SCHEDULE: "REPORTING_INVALID_SCHEDULE",
  EXPORT_NOT_FOUND: "REPORTING_EXPORT_NOT_FOUND",
  INVALID_EXPORT: "REPORTING_INVALID_EXPORT",
  EXPORT_FAILED: "REPORTING_EXPORT_FAILED",
  DATA_SOURCE_NOT_FOUND: "REPORTING_DATA_SOURCE_NOT_FOUND",
  DATA_SOURCE_UNAVAILABLE: "REPORTING_DATA_SOURCE_UNAVAILABLE",
  INVALID_QUERY: "REPORTING_INVALID_QUERY",
  UNKNOWN_ENTITY: "REPORTING_UNKNOWN_ENTITY",
  UNKNOWN_ATTRIBUTE: "REPORTING_UNKNOWN_ATTRIBUTE",
  UNSUPPORTED_OPERATOR: "REPORTING_UNSUPPORTED_OPERATOR",
  UNSUPPORTED_AGGREGATION: "REPORTING_UNSUPPORTED_AGGREGATION",
  INVALID_EXPRESSION: "REPORTING_INVALID_EXPRESSION",
  SECURITY_BLOCKED: "REPORTING_SECURITY_BLOCKED",
  CLASSIFICATION_BLOCKED: "REPORTING_CLASSIFICATION_BLOCKED",
  QUERY_TIMEOUT: "REPORTING_QUERY_TIMEOUT",
  ROW_LIMIT_EXCEEDED: "REPORTING_ROW_LIMIT_EXCEEDED",
  INVALID_PARAMETERS: "REPORTING_INVALID_PARAMETERS",
  BI_NOT_FOUND: "REPORTING_BI_NOT_FOUND",
  BI_UNAVAILABLE: "REPORTING_BI_UNAVAILABLE",
  IDEMPOTENCY_CONFLICT: "REPORTING_IDEMPOTENCY_CONFLICT",
  CONFLICT: "REPORTING_CONFLICT",
});

export class ReportingError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

export const reportNotFound = (ref) =>
  new ReportingError(404, `Report not found: ${ref}`, REPORTING_ERROR_CODES.REPORT_NOT_FOUND, { ref });
export const reportConflict = (code) =>
  new ReportingError(409, `Report already exists: ${code}`, REPORTING_ERROR_CODES.REPORT_CONFLICT, { code });
export const invalidReport = (message, details = null) =>
  new ReportingError(400, message, REPORTING_ERROR_CODES.INVALID_REPORT, details);
export const reportImmutable = (ref, version) =>
  new ReportingError(409, `Report ${ref} version ${version} is published and immutable`, REPORTING_ERROR_CODES.REPORT_IMMUTABLE, { ref, version });

export const dashboardNotFound = (ref) =>
  new ReportingError(404, `Dashboard not found: ${ref}`, REPORTING_ERROR_CODES.DASHBOARD_NOT_FOUND, { ref });
export const dashboardConflict = (code) =>
  new ReportingError(409, `Dashboard already exists: ${code}`, REPORTING_ERROR_CODES.DASHBOARD_CONFLICT, { code });
export const invalidDashboard = (message, details = null) =>
  new ReportingError(400, message, REPORTING_ERROR_CODES.INVALID_DASHBOARD, details);
export const dashboardImmutable = (ref, version) =>
  new ReportingError(409, `Dashboard ${ref} version ${version} is published and immutable`, REPORTING_ERROR_CODES.DASHBOARD_IMMUTABLE, { ref, version });
export const widgetNotFound = (ref) =>
  new ReportingError(404, `Dashboard widget not found: ${ref}`, REPORTING_ERROR_CODES.WIDGET_NOT_FOUND, { ref });

export const metricNotFound = (ref) =>
  new ReportingError(404, `Metric not found: ${ref}`, REPORTING_ERROR_CODES.METRIC_NOT_FOUND, { ref });
export const metricConflict = (code) =>
  new ReportingError(409, `Metric already exists: ${code}`, REPORTING_ERROR_CODES.METRIC_CONFLICT, { code });
export const invalidMetric = (message, details = null) =>
  new ReportingError(400, message, REPORTING_ERROR_CODES.INVALID_METRIC, details);

export const kpiNotFound = (ref) =>
  new ReportingError(404, `KPI not found: ${ref}`, REPORTING_ERROR_CODES.KPI_NOT_FOUND, { ref });
export const kpiConflict = (code) =>
  new ReportingError(409, `KPI already exists: ${code}`, REPORTING_ERROR_CODES.KPI_CONFLICT, { code });
export const invalidKpi = (message, details = null) =>
  new ReportingError(400, message, REPORTING_ERROR_CODES.INVALID_KPI, details);

export const scheduleNotFound = (ref) =>
  new ReportingError(404, `Schedule not found: ${ref}`, REPORTING_ERROR_CODES.SCHEDULE_NOT_FOUND, { ref });
export const invalidSchedule = (message, details = null) =>
  new ReportingError(400, message, REPORTING_ERROR_CODES.INVALID_SCHEDULE, details);

export const exportNotFound = (ref) =>
  new ReportingError(404, `Export not found: ${ref}`, REPORTING_ERROR_CODES.EXPORT_NOT_FOUND, { ref });
export const invalidExport = (message, details = null) =>
  new ReportingError(400, message, REPORTING_ERROR_CODES.INVALID_EXPORT, details);
export const exportFailed = (message, details = null) =>
  new ReportingError(422, message, REPORTING_ERROR_CODES.EXPORT_FAILED, details);

export const dataSourceNotFound = (code) =>
  new ReportingError(404, `Data source not found: ${code}`, REPORTING_ERROR_CODES.DATA_SOURCE_NOT_FOUND, { code });
export const dataSourceUnavailable = (code, status, message = null) =>
  new ReportingError(
    422,
    message || `Data source ${code} is not available (status: ${status || "UNKNOWN"})`,
    REPORTING_ERROR_CODES.DATA_SOURCE_UNAVAILABLE,
    { code, status }
  );

export const invalidQuery = (message, details = null) =>
  new ReportingError(400, message, REPORTING_ERROR_CODES.INVALID_QUERY, details);
export const unknownEntity = (entity) =>
  new ReportingError(400, `Unknown reporting entity: ${entity}`, REPORTING_ERROR_CODES.UNKNOWN_ENTITY, { entity });
export const unknownAttribute = (entity, attribute) =>
  new ReportingError(400, `Unknown attribute ${attribute} on entity ${entity}`, REPORTING_ERROR_CODES.UNKNOWN_ATTRIBUTE, { entity, attribute });
export const unsupportedOperator = (operator) =>
  new ReportingError(400, `Unsupported filter operator: ${operator}`, REPORTING_ERROR_CODES.UNSUPPORTED_OPERATOR, { operator });
export const unsupportedAggregation = (aggregation) =>
  new ReportingError(400, `Unsupported aggregation: ${aggregation}`, REPORTING_ERROR_CODES.UNSUPPORTED_AGGREGATION, { aggregation });
export const invalidExpression = (message, details = null) =>
  new ReportingError(400, message, REPORTING_ERROR_CODES.INVALID_EXPRESSION, details);
export const invalidParameters = (message, details = null) =>
  new ReportingError(400, message, REPORTING_ERROR_CODES.INVALID_PARAMETERS, details);

export const securityBlocked = (details) =>
  new ReportingError(403, "Blocked by security policy", REPORTING_ERROR_CODES.SECURITY_BLOCKED, details);
export const classificationBlocked = (details) =>
  new ReportingError(403, "Blocked by data classification policy", REPORTING_ERROR_CODES.CLASSIFICATION_BLOCKED, details);
export const queryTimeout = (limitMs, details = null) =>
  new ReportingError(408, `Report query exceeded the ${limitMs}ms execution limit`, REPORTING_ERROR_CODES.QUERY_TIMEOUT, { limit_ms: limitMs, ...(details || {}) });
export const rowLimitExceeded = (rows, limit) =>
  new ReportingError(413, `Report produced ${rows} rows which exceeds the ${limit} row limit`, REPORTING_ERROR_CODES.ROW_LIMIT_EXCEEDED, { rows, limit });

export const biNotFound = (ref) =>
  new ReportingError(404, `BI connection not found: ${ref}`, REPORTING_ERROR_CODES.BI_NOT_FOUND, { ref });
export const biUnavailable = (provider, message = null) =>
  new ReportingError(422, message || `BI provider ${provider} is not available`, REPORTING_ERROR_CODES.BI_UNAVAILABLE, { provider });
export const idempotencyConflict = (key) =>
  new ReportingError(409, `A reporting artifact with idempotency key ${key} already exists`, REPORTING_ERROR_CODES.IDEMPOTENCY_CONFLICT, { idempotency_key: key });
export const reportingConflict = (message, details = null) =>
  new ReportingError(409, message, REPORTING_ERROR_CODES.CONFLICT, details);
