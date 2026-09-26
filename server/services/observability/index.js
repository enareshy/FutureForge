// Public facade for the P2 Data Observability capability (Module 21).
//
// Every consumer (API layer, jobs, search, other modules) depends on this file
// rather than the internal layout so the implementation can evolve safely.
// Databases are always passed first so calls can participate in the caller's
// transaction. Observability is a platform service: business modules consume
// `Observability` instead of building their own monitoring.
import * as Constants from "./constants.js";
import * as Errors from "./errors.js";
import * as Identifiers from "./identifiers.js";
import * as Repository from "./repository.js";
import * as Providers from "./providers.js";
import * as Metrics from "./metrics.js";
import * as Thresholds from "./thresholds.js";
import * as Freshness from "./freshness.js";
import * as Health from "./health.js";
import * as Alerts from "./alerts.js";
import * as Incidents from "./incidents.js";
import * as Slo from "./slo.js";
import * as Dashboards from "./dashboards.js";
import * as Collection from "./collection.js";
import * as Configuration from "./configuration.js";
import * as Events from "./events.js";
import * as History from "./history.js";
import * as Jobs from "./jobs.js";
import * as Search from "./search.js";
import * as ReportingBridge from "./reporting-bridge.js";
import * as Foundation from "./foundation.js";
import * as Seed from "./seed.js";

export {
  Constants,
  Errors,
  Identifiers,
  Repository,
  Providers,
  Metrics,
  Thresholds,
  Freshness,
  Health,
  Alerts,
  Incidents,
  Slo,
  Dashboards,
  Collection,
  Configuration,
  Events,
  History,
  Jobs,
  Search,
  ReportingBridge,
  Foundation,
  Seed,
};

// Flat, stable SDK surface. Consumers should prefer these named functions so
// the internal module layout can evolve without breaking callers.
export const Observability = {
  // Providers
  listProviders: Providers.listProviders,
  getProvider: Providers.getProvider,
  measureMetric: Providers.measureMetric,
  measureFreshness: Providers.measureFreshness,
  probeProvider: Providers.probeProvider,
  // Metrics & observations
  createMetric: Metrics.createMetric,
  getMetric: Metrics.getMetric,
  listMetrics: Metrics.listMetrics,
  updateMetric: Metrics.updateMetric,
  setMetricStatus: Metrics.setMetricStatus,
  deleteMetric: Metrics.deleteMetric,
  listMetricVersions: Metrics.listMetricVersions,
  recordObservation: Metrics.recordObservation,
  listObservations: Metrics.listObservations,
  latestObservations: Metrics.latestObservations,
  latestObservationFor: Metrics.latestObservationFor,
  metricHistory: Metrics.metricHistory,
  // Thresholds
  createThreshold: Thresholds.createThreshold,
  getThreshold: Thresholds.getThreshold,
  listThresholds: Thresholds.listThresholds,
  updateThreshold: Thresholds.updateThreshold,
  deleteThreshold: Thresholds.deleteThreshold,
  classifyMetric: Thresholds.classifyMetric,
  effectiveThresholds: Thresholds.effectiveThresholds,
  // Assets & freshness
  createAsset: Freshness.createAsset,
  getAsset: Freshness.getAsset,
  listAssets: Freshness.listAssets,
  createFreshness: Freshness.createFreshness,
  getFreshness: Freshness.getFreshness,
  listFreshness: Freshness.listFreshness,
  updateFreshness: Freshness.updateFreshness,
  deleteFreshness: Freshness.deleteFreshness,
  evaluateFreshness: Freshness.evaluateFreshness,
  freshnessSummary: Freshness.freshnessSummary,
  // Health
  createHealthCheck: Health.createHealthCheck,
  listHealthChecks: Health.listHealthChecks,
  getHealthCheck: Health.getHealthCheck,
  updateHealthCheck: Health.updateHealthCheck,
  deleteHealthCheck: Health.deleteHealthCheck,
  evaluateHealth: Health.evaluateHealth,
  persistHealthSnapshots: Health.persistHealthSnapshots,
  currentHealth: Health.currentHealth,
  listHealthSnapshots: Health.listHealthSnapshots,
  healthTrend: Health.healthTrend,
  // Alerts
  createAlertRule: Alerts.createAlertRule,
  getAlertRule: Alerts.getAlertRule,
  listAlertRules: Alerts.listAlertRules,
  updateAlertRule: Alerts.updateAlertRule,
  deleteAlertRule: Alerts.deleteAlertRule,
  listAlertRuleVersions: Alerts.listAlertRuleVersions,
  applyAlertRules: Alerts.applyAlertRules,
  listAlerts: Alerts.listAlerts,
  getAlert: Alerts.getAlert,
  alertSummary: Alerts.alertSummary,
  alertTrend: Alerts.alertTrend,
  listAlertEvents: Alerts.listAlertEvents,
  acknowledgeAlert: Alerts.acknowledgeAlert,
  suppressAlert: Alerts.suppressAlert,
  unsuppressAlert: Alerts.unsuppressAlert,
  resolveAlert: Alerts.resolveAlert,
  closeAlert: Alerts.closeAlert,
  commentAlert: Alerts.commentAlert,
  refreshSuppressions: Alerts.refreshSuppressions,
  // Incidents
  createIncident: Incidents.createIncident,
  getIncident: Incidents.getIncident,
  listIncidents: Incidents.listIncidents,
  updateIncident: Incidents.updateIncident,
  incidentSummary: Incidents.incidentSummary,
  linkAlertToIncident: Incidents.linkAlert,
  // SLO / SLA
  createSlo: Slo.createSlo,
  getSlo: Slo.getSlo,
  listSlos: Slo.listSlos,
  updateSlo: Slo.updateSlo,
  deleteSlo: Slo.deleteSlo,
  evaluateSlo: Slo.evaluateSlo,
  evaluateAllSlos: Slo.evaluateAllSlos,
  sloSummary: Slo.sloSummary,
  // Dashboards
  createDashboard: Dashboards.createDashboard,
  getDashboard: Dashboards.getDashboard,
  listDashboards: Dashboards.listDashboards,
  updateDashboard: Dashboards.updateDashboard,
  deleteDashboard: Dashboards.deleteDashboard,
  addWidget: Dashboards.addWidget,
  updateWidget: Dashboards.updateWidget,
  removeWidget: Dashboards.removeWidget,
  renderDashboard: Dashboards.renderDashboard,
  defaultDashboard: Dashboards.defaultDashboard,
  ensureDefaultDashboards: Dashboards.ensureDefaultDashboards,
  // Collection & overview
  collectTenant: Collection.collectTenant,
  collectAllTenants: Collection.collectAllTenants,
  observabilityOverview: Collection.observabilityOverview,
  categorySummary: Collection.categorySummary,
  failureSummary: Collection.failureSummary,
  throughputSummary: Collection.throughputSummary,
  listRuns: Collection.listRuns,
  getRun: Collection.getRun,
  // Configuration
  getConfig: Configuration.getConfig,
  listConfig: Configuration.listConfig,
  setConfig: Configuration.setConfig,
  listRetentionPolicies: Configuration.listRetentionPolicies,
  setRetentionPolicy: Configuration.setRetentionPolicy,
  // History, jobs, search
  listHistory: History.listHistory,
  submitCollectJob: Jobs.submitCollectJob,
  submitFreshnessJob: Jobs.submitFreshnessJob,
  submitHealthJob: Jobs.submitHealthJob,
  submitSloJob: Jobs.submitSloJob,
  submitMaintenanceJob: Jobs.submitMaintenanceJob,
  listJobs: Jobs.listObservabilityJobs,
  getJob: Jobs.getObservabilityJob,
  registerSearchSources: Search.registerObservabilitySources,
  // Lifecycle
  ensureObservabilityFoundation: Foundation.ensureObservabilityFoundation,
  observabilityHealth: Foundation.observabilityHealth,
  ensureObservabilitySeed: Seed.ensureObservabilitySeed,
  observabilityResourceCodes: Seed.observabilityResourceCodes,
};

export default Observability;

// Convenience named exports parity with the other P2 modules.
export const ensureObservabilityFoundation = Foundation.ensureObservabilityFoundation;
export const ensureObservabilitySeed = Seed.ensureObservabilitySeed;
export const observabilityHealth = Foundation.observabilityHealth;
export const observabilityResourceCodes = Seed.observabilityResourceCodes;
