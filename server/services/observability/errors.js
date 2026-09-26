// Standardized Data Observability error codes.
//
// The HTTP layer serializes `code` alongside `error` and `details` so clients
// branch on stable identifiers rather than parsing prose. Database exceptions
// and stack traces are never surfaced to clients.
import { HttpError } from "../../validation.js";

export const OBSERVABILITY_ERROR_CODES = Object.freeze({
  METRIC_NOT_FOUND: "OBSERVABILITY_METRIC_NOT_FOUND",
  METRIC_CONFLICT: "OBSERVABILITY_METRIC_CONFLICT",
  INVALID_METRIC: "OBSERVABILITY_INVALID_METRIC",
  OBSERVATION_NOT_FOUND: "OBSERVABILITY_OBSERVATION_NOT_FOUND",
  THRESHOLD_NOT_FOUND: "OBSERVABILITY_THRESHOLD_NOT_FOUND",
  THRESHOLD_CONFLICT: "OBSERVABILITY_THRESHOLD_CONFLICT",
  INVALID_THRESHOLD: "OBSERVABILITY_INVALID_THRESHOLD",
  FRESHNESS_NOT_FOUND: "OBSERVABILITY_FRESHNESS_NOT_FOUND",
  FRESHNESS_CONFLICT: "OBSERVABILITY_FRESHNESS_CONFLICT",
  INVALID_FRESHNESS: "OBSERVABILITY_INVALID_FRESHNESS",
  ASSET_NOT_FOUND: "OBSERVABILITY_ASSET_NOT_FOUND",
  ASSET_CONFLICT: "OBSERVABILITY_ASSET_CONFLICT",
  HEALTH_CHECK_NOT_FOUND: "OBSERVABILITY_HEALTH_CHECK_NOT_FOUND",
  INVALID_HEALTH_CHECK: "OBSERVABILITY_INVALID_HEALTH_CHECK",
  ALERT_RULE_NOT_FOUND: "OBSERVABILITY_ALERT_RULE_NOT_FOUND",
  ALERT_RULE_CONFLICT: "OBSERVABILITY_ALERT_RULE_CONFLICT",
  INVALID_ALERT_RULE: "OBSERVABILITY_INVALID_ALERT_RULE",
  ALERT_NOT_FOUND: "OBSERVABILITY_ALERT_NOT_FOUND",
  INVALID_ALERT: "OBSERVABILITY_INVALID_ALERT",
  INCIDENT_NOT_FOUND: "OBSERVABILITY_INCIDENT_NOT_FOUND",
  INVALID_INCIDENT: "OBSERVABILITY_INVALID_INCIDENT",
  SLO_NOT_FOUND: "OBSERVABILITY_SLO_NOT_FOUND",
  SLO_CONFLICT: "OBSERVABILITY_SLO_CONFLICT",
  INVALID_SLO: "OBSERVABILITY_INVALID_SLO",
  DASHBOARD_NOT_FOUND: "OBSERVABILITY_DASHBOARD_NOT_FOUND",
  DASHBOARD_CONFLICT: "OBSERVABILITY_DASHBOARD_CONFLICT",
  INVALID_DASHBOARD: "OBSERVABILITY_INVALID_DASHBOARD",
  WIDGET_NOT_FOUND: "OBSERVABILITY_WIDGET_NOT_FOUND",
  PROVIDER_NOT_FOUND: "OBSERVABILITY_PROVIDER_NOT_FOUND",
  PROVIDER_UNAVAILABLE: "OBSERVABILITY_PROVIDER_UNAVAILABLE",
  INVALID_PROVIDER: "OBSERVABILITY_INVALID_PROVIDER",
  INVALID_PARAMETERS: "OBSERVABILITY_INVALID_PARAMETERS",
  INVALID_STATE: "OBSERVABILITY_INVALID_STATE",
  INVALID_CONFIG: "OBSERVABILITY_INVALID_CONFIG",
  IDEMPOTENCY_CONFLICT: "OBSERVABILITY_IDEMPOTENCY_CONFLICT",
  CONFLICT: "OBSERVABILITY_CONFLICT",
});

export class ObservabilityError extends HttpError {
  constructor(status, message, code, details = null) {
    super(status, message, details);
    this.code = code;
  }
}

const mk = (status, code, label) => (message, details = null) =>
  new ObservabilityError(status, message || label, code, details);

export const metricNotFound = (ref) =>
  new ObservabilityError(404, `Metric not found: ${ref}`, OBSERVABILITY_ERROR_CODES.METRIC_NOT_FOUND, { ref });
export const metricConflict = (code) =>
  new ObservabilityError(409, `Metric already exists: ${code}`, OBSERVABILITY_ERROR_CODES.METRIC_CONFLICT, { code });
export const invalidMetric = (message, details = null) =>
  new ObservabilityError(400, message, OBSERVABILITY_ERROR_CODES.INVALID_METRIC, details);

export const thresholdNotFound = (ref) =>
  new ObservabilityError(404, `Threshold not found: ${ref}`, OBSERVABILITY_ERROR_CODES.THRESHOLD_NOT_FOUND, { ref });
export const thresholdConflict = (code) =>
  new ObservabilityError(409, `Threshold already exists: ${code}`, OBSERVABILITY_ERROR_CODES.THRESHOLD_CONFLICT, { code });
export const invalidThreshold = mk(400, OBSERVABILITY_ERROR_CODES.INVALID_THRESHOLD, "Invalid threshold");

export const freshnessNotFound = (ref) =>
  new ObservabilityError(404, `Freshness definition not found: ${ref}`, OBSERVABILITY_ERROR_CODES.FRESHNESS_NOT_FOUND, { ref });
export const freshnessConflict = (code) =>
  new ObservabilityError(409, `Freshness definition already exists: ${code}`, OBSERVABILITY_ERROR_CODES.FRESHNESS_CONFLICT, { code });
export const invalidFreshness = mk(400, OBSERVABILITY_ERROR_CODES.INVALID_FRESHNESS, "Invalid freshness definition");

export const assetNotFound = (ref) =>
  new ObservabilityError(404, `Data asset not found: ${ref}`, OBSERVABILITY_ERROR_CODES.ASSET_NOT_FOUND, { ref });
export const assetConflict = mk(409, OBSERVABILITY_ERROR_CODES.ASSET_CONFLICT, "Data asset already exists");

export const healthCheckNotFound = (ref) =>
  new ObservabilityError(404, `Health check not found: ${ref}`, OBSERVABILITY_ERROR_CODES.HEALTH_CHECK_NOT_FOUND, { ref });
export const invalidHealthCheck = mk(400, OBSERVABILITY_ERROR_CODES.INVALID_HEALTH_CHECK, "Invalid health check");

export const alertRuleNotFound = (ref) =>
  new ObservabilityError(404, `Alert rule not found: ${ref}`, OBSERVABILITY_ERROR_CODES.ALERT_RULE_NOT_FOUND, { ref });
export const alertRuleConflict = (code) =>
  new ObservabilityError(409, `Alert rule already exists: ${code}`, OBSERVABILITY_ERROR_CODES.ALERT_RULE_CONFLICT, { code });
export const invalidAlertRule = mk(400, OBSERVABILITY_ERROR_CODES.INVALID_ALERT_RULE, "Invalid alert rule");

export const alertNotFound = (ref) =>
  new ObservabilityError(404, `Alert not found: ${ref}`, OBSERVABILITY_ERROR_CODES.ALERT_NOT_FOUND, { ref });
export const invalidAlert = mk(400, OBSERVABILITY_ERROR_CODES.INVALID_ALERT, "Invalid alert operation");

export const incidentNotFound = (ref) =>
  new ObservabilityError(404, `Incident not found: ${ref}`, OBSERVABILITY_ERROR_CODES.INCIDENT_NOT_FOUND, { ref });
export const invalidIncident = mk(400, OBSERVABILITY_ERROR_CODES.INVALID_INCIDENT, "Invalid incident operation");

export const sloNotFound = (ref) =>
  new ObservabilityError(404, `SLO/SLA not found: ${ref}`, OBSERVABILITY_ERROR_CODES.SLO_NOT_FOUND, { ref });
export const sloConflict = (code, kind) =>
  new ObservabilityError(409, `SLO/SLA already exists: ${code} (${kind})`, OBSERVABILITY_ERROR_CODES.SLO_CONFLICT, { code, kind });
export const invalidSlo = mk(400, OBSERVABILITY_ERROR_CODES.INVALID_SLO, "Invalid SLO/SLA definition");

export const dashboardNotFound = (ref) =>
  new ObservabilityError(404, `Dashboard not found: ${ref}`, OBSERVABILITY_ERROR_CODES.DASHBOARD_NOT_FOUND, { ref });
export const dashboardConflict = (code) =>
  new ObservabilityError(409, `Dashboard already exists: ${code}`, OBSERVABILITY_ERROR_CODES.DASHBOARD_CONFLICT, { code });
export const invalidDashboard = mk(400, OBSERVABILITY_ERROR_CODES.INVALID_DASHBOARD, "Invalid dashboard");
export const widgetNotFound = (ref) =>
  new ObservabilityError(404, `Widget not found: ${ref}`, OBSERVABILITY_ERROR_CODES.WIDGET_NOT_FOUND, { ref });

export const providerNotFound = (code) =>
  new ObservabilityError(404, `Provider not found: ${code}`, OBSERVABILITY_ERROR_CODES.PROVIDER_NOT_FOUND, { provider: code });
export const invalidParameters = mk(400, OBSERVABILITY_ERROR_CODES.INVALID_PARAMETERS, "Invalid parameters");
export const invalidState = mk(409, OBSERVABILITY_ERROR_CODES.INVALID_STATE, "Invalid state transition");
export const invalidConfig = mk(400, OBSERVABILITY_ERROR_CODES.INVALID_CONFIG, "Invalid configuration");
