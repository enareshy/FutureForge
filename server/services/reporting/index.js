// Public facade for the P2 Reporting & Analytics capability.
//
// Every consumer (API layer, jobs, search, other modules) depends on this file
// rather than the internal layout so the implementation can evolve safely.
// Databases are always passed first so calls can participate in the caller's
// transaction. Module 20 is a platform service: business modules consume
// `Reporting` instead of building their own report engines.
import * as Constants from "./constants.js";
import * as Errors from "./errors.js";
import * as Identifiers from "./identifiers.js";
import * as Repository from "./repository.js";
import * as Security from "./security.js";
import * as Visibility from "./visibility.js";
import * as Semantic from "./semantic.js";
import * as DataSources from "./datasources.js";
import * as QueryEngine from "./query-engine.js";
import * as Cache from "./cache.js";
import * as Events from "./events.js";
import * as Configuration from "./configuration.js";
import * as Metrics from "./metrics.js";
import * as Kpis from "./kpis.js";
import * as Reports from "./reports.js";
import * as Dashboards from "./dashboards.js";
import * as Exports from "./exports.js";
import * as Scheduling from "./scheduling.js";
import * as Bi from "./bi.js";
import * as History from "./history.js";
import * as ReadModel from "./readmodel.js";
import * as Jobs from "./jobs.js";
import * as Search from "./search.js";
import * as Foundation from "./foundation.js";
import * as Seed from "./seed.js";

export {
  Constants,
  Errors,
  Identifiers,
  Repository,
  Security,
  Visibility,
  Semantic,
  DataSources,
  QueryEngine,
  Cache,
  Events,
  Configuration,
  Metrics,
  Kpis,
  Reports,
  Dashboards,
  Exports,
  Scheduling,
  Bi,
  History,
  ReadModel,
  Jobs,
  Search,
  Foundation,
  Seed,
};

// Flat, stable SDK surface. Consumers should prefer these named functions so
// the internal module layout can evolve without breaking callers.
export const Reporting = {
  // Reports
  createReport: Reports.createReport,
  getReport: Reports.getReport,
  listReports: Reports.listReports,
  updateReport: Reports.updateReport,
  publishReport: Reports.publishReport,
  setReportStatus: Reports.setReportStatus,
  deleteReport: Reports.deleteReport,
  cloneReport: Reports.cloneReport,
  listReportVersions: Reports.listReportVersions,
  getReportVersion: Reports.getReportVersion,
  previewReport: Reports.previewReport,
  executeReport: Reports.executeReport,
  runReport: Reports.runReport,
  // Query engine & semantic layer
  normalizeQuery: QueryEngine.normalizeQuery,
  executeQuery: QueryEngine.executeQuery,
  listEntities: Semantic.listEntities,
  getEntity: Semantic.getEntity,
  listDataSources: DataSources.listDataSources,
  // Metrics & KPIs
  createMetric: Metrics.createMetric,
  getMetric: Metrics.getMetric,
  listMetrics: Metrics.listMetrics,
  updateMetric: Metrics.updateMetric,
  deleteMetric: Metrics.deleteMetric,
  computeMetric: Metrics.computeMetric,
  createKpi: Kpis.createKpi,
  getKpi: Kpis.getKpi,
  listKpis: Kpis.listKpis,
  updateKpi: Kpis.updateKpi,
  setKpiStatus: Kpis.setKpiStatus,
  deleteKpi: Kpis.deleteKpi,
  computeKpi: Kpis.computeKpi,
  getKpiValue: Kpis.getKpiValue,
  // Dashboards
  createDashboard: Dashboards.createDashboard,
  getDashboard: Dashboards.getDashboard,
  listDashboards: Dashboards.listDashboards,
  updateDashboard: Dashboards.updateDashboard,
  publishDashboard: Dashboards.publishDashboard,
  deleteDashboard: Dashboards.deleteDashboard,
  cloneDashboard: Dashboards.cloneDashboard,
  getDashboardWithWidgets: Dashboards.getDashboardWithWidgets,
  addWidget: Dashboards.addWidget,
  updateWidget: Dashboards.updateWidget,
  deleteWidget: Dashboards.deleteWidget,
  reorderWidgets: Dashboards.reorderWidgets,
  refreshDashboard: Dashboards.refreshDashboard,
  drillDown: Dashboards.drillDown,
  // Exports
  requestExport: Exports.requestExport,
  executeExport: Exports.executeExport,
  getExport: Exports.getExport,
  listExports: Exports.listExports,
  downloadExport: Exports.downloadExport,
  deleteExport: Exports.deleteExport,
  // Scheduling
  createSchedule: Scheduling.createSchedule,
  getSchedule: Scheduling.getSchedule,
  listSchedules: Scheduling.listSchedules,
  updateSchedule: Scheduling.updateSchedule,
  setScheduleStatus: Scheduling.setScheduleStatus,
  deleteSchedule: Scheduling.deleteSchedule,
  runSchedule: Scheduling.runSchedule,
  computeNextRun: Scheduling.computeNextRun,
  // BI integration
  createBiConnection: Bi.createBiConnection,
  listBiConnections: Bi.listBiConnections,
  getBiConnection: Bi.getBiConnection,
  updateBiConnection: Bi.updateBiConnection,
  deleteBiConnection: Bi.deleteBiConnection,
  createBiDataset: Bi.createBiDataset,
  listBiDatasets: Bi.listBiDatasets,
  getBiDataset: Bi.getBiDataset,
  updateBiDataset: Bi.updateBiDataset,
  deleteBiDataset: Bi.deleteBiDataset,
  getBiDatasetData: Bi.getBiDatasetData,
  datasetODataMetadata: Bi.datasetODataMetadata,
  publishDataset: Bi.publishDataset,
  listBiPublishJobs: Bi.listBiPublishJobs,
  biCapabilities: Bi.biCapabilities,
  // History, execution & read model
  listExecutions: History.listExecutions,
  getExecution: History.getExecution,
  executionSummary: History.executionSummary,
  listHistory: History.listHistory,
  refreshReadModel: ReadModel.refreshReadModel,
  readModelStatus: ReadModel.readModelStatus,
  // Jobs
  listReportingJobs: Jobs.listReportingJobs,
  getReportingJob: Jobs.getReportingJob,
  submitExecuteJob: Jobs.submitExecuteJob,
  submitExportJob: Jobs.submitExportJob,
  submitScheduleRunJob: Jobs.submitScheduleRunJob,
  submitKpiJob: Jobs.submitKpiJob,
  submitRefreshJob: Jobs.submitRefreshJob,
  submitMaintenanceJob: Jobs.submitMaintenanceJob,
  // Configuration
  getConfig: Configuration.getConfig,
  setConfig: Configuration.setConfig,
  listConfig: Configuration.listConfig,
};

export const ensureReportingFoundation = Foundation.ensureReportingFoundation;
export const reportingHealth = Foundation.reportingHealth;
export const ensureReportingSeed = Seed.ensureReportingSeed;
export const seedReporting = Seed.seedReporting;
export const ensureDefaultReportingAssets = Seed.ensureDefaultReportingAssets;
export const reportingResourceCodes = Seed.reportingResourceCodes;
export const registerReportingHandlers = Jobs.registerReportingHandlers;
export const ensureReportingJobTypes = Jobs.ensureReportingJobTypes;
export const runReportingMaintenance = Jobs.runReportingMaintenance;
export const registerReportingSources = Search.registerReportingSources;
export const ensureReportingSearch = Search.ensureReportingSearch;
export const ensureReportingConfig = Configuration.ensureReportingConfig;
export const ensureReportingEventTypes = Events.ensureReportingEventTypes;
export const executeQuery = QueryEngine.executeQuery;
export const listEntities = Semantic.listEntities;
export const listDataSources = DataSources.listDataSources;
export const executeReport = Reports.executeReport;
export const getKpiValue = Kpis.getKpiValue;
