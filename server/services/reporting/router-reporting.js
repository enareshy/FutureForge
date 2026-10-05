// REST router for the P2 Reporting & Analytics capability. Built as a factory
// so it reuses the application's auth, authorization and error middleware.
// Mounted at /api/reporting and /api/v1/reporting.
//
// Every route is authorized against an IAM permission resource and every read
// applies the central data-security engine; the client is never trusted to
// declare its own authorization.
import {
  Constants,
  DataSources,
  Semantic,
  QueryEngine,
  Reports,
  Metrics,
  Kpis,
  Dashboards,
  Exports,
  Scheduling,
  Bi,
  History,
  ReadModel,
  Jobs,
  Cache,
  Configuration,
  Search,
  Foundation,
  Seed,
} from "./index.js";

const R = Constants.REPORTING_RESOURCES;

export function createReportingRouter({ express, db, auth, authAsync, can, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const actorOf = (req) => req.actor;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";

  const canReports = (a) => canAsync(R.reports, a);
  const canBuilder = (a) => canAsync(R.builder, a);
  const canDashboards = (a) => canAsync(R.dashboards, a);
  const canKpis = (a) => canAsync(R.kpis, a);
  const canMetrics = (a) => canAsync(R.metrics, a);
  const canDataSources = (a) => canAsync(R.dataSources, a);
  const canSchedules = (a) => canAsync(R.schedules, a);
  const canExports = (a) => canAsync(R.exports, a);
  const canBi = (a) => canAsync(R.bi, a);
  const canJobs = (a) => canAsync(R.jobs, a);
  const canHistory = (a) => canAsync(R.history, a);
  const canSearch = (a) => canAsync(R.search, a);
  const canObservability = (a) => canAsync(R.observability, a);
  const canAdmin = (a) => canAsync(R.admin, a);

  const listQuery = (req) => ({ ...req.query });

  // ── Meta, health, observability ───────────────────────────────────────────
  router.get(
    "/meta",
    authAsync,
    canObservability("read"),
    wrap((_req, res) => {
      res.json({
        source_module: Constants.SOURCE_MODULE,
        model_version: Constants.ANALYTICS_MODEL_VERSION,
        resources: R,
        capabilities: {
          report_types: Constants.REPORT_TYPES,
          report_statuses: Constants.REPORT_STATUSES,
          dashboard_widget_types: Constants.DASHBOARD_WIDGET_TYPES,
          visualization_types: Constants.VISUALIZATION_TYPES,
          visibility_scopes: Constants.VISIBILITY_SCOPES,
          operators: Constants.OPERATORS,
          aggregations: Constants.AGGREGATIONS,
          data_sources: DataSources.dataSourceCatalog(),
          semantic_entities: Semantic.listEntities(),
          export_formats: Constants.EXPORT_FORMATS,
          native_export_formats: Constants.NATIVE_EXPORT_FORMATS,
          schedule_frequencies: Constants.SCHEDULE_FREQUENCIES,
          execution_modes: Constants.EXECUTION_MODES,
          bi_providers: Constants.BI_PROVIDERS,
          kpi_catalog: Constants.KPI_CATALOG.map((entry) => entry.code),
          supported_domains: Constants.SUPPORTED_DOMAINS,
          config_defaults: Constants.CONFIG_DEFAULTS,
          job_types: Constants.REPORTING_JOB_TYPES.map((job) => job.code),
          handler_codes: Constants.REPORTING_HANDLER_CODES,
          search_types: Constants.SEARCH_OBJECT_TYPES.map((entry) => entry.code),
          bi: Bi.biCapabilities(),
        },
      });
    })
  );

  router.get("/health", authAsync, canObservability("read"), wrap(async (req, res) => res.json({ ...(await Foundation.reportingHealthAsync(db, tenantOf(req))), ...(await History.executionSummaryAsync(db, tenantOf(req))) })));
  router.get("/metrics", authAsync, canObservability("read"), wrap(async (req, res) => res.json({ executions: await History.executionSummaryAsync(db, tenantOf(req)), cache: await Cache.cacheStatsAsync(db, tenantOf(req)), read_model: await ReadModel.readModelStatusAsync(db, tenantOf(req)) })));
  router.get("/observability", authAsync, canObservability("read"), wrap(async (req, res) => res.json({ executions: await History.executionSummaryAsync(db, tenantOf(req)), cache: await Cache.cacheStatsAsync(db, tenantOf(req)), read_model: await ReadModel.readModelStatusAsync(db, tenantOf(req)) })));

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get("/config", authAsync, canAdmin("read"), wrap(async (req, res) => res.json(await Configuration.listConfigAsync(db, tenantOf(req)))));
  const setConfig = wrap(async (req, res) => res.json({ key: req.params.key, value: await Configuration.setConfigAsync(db, tenantOf(req), req.params.key, req.body?.value, actorOf(req), req.ip) }));
  router.put("/config/:key", authAsync, canAdmin("update"), setConfig);
  router.patch("/config/:key", authAsync, canAdmin("update"), setConfig);

  // ── Semantic layer & data sources ─────────────────────────────────────────
  router.get("/data-sources", authAsync, canDataSources("read"), wrap((_req, res) => res.json(DataSources.listDataSources())));
  router.get("/semantic/entities", authAsync, canDataSources("read"), wrap((_req, res) => res.json({ items: Semantic.listEntities(), total: Semantic.listEntities().length })));
  router.get("/semantic/entities/:code", authAsync, canDataSources("read"), wrap((req, res) => res.json(Semantic.getEntity(req.params.code))));

  // ── Ad-hoc query (report builder) ─────────────────────────────────────────
  const queryContext = (req) => ({ actor: actorOf(req), organizationId: req.body?.organization_id ?? null, ip: req.ip, parameters: req.body?.parameters || {}, page: req.body?.page, page_size: req.body?.page_size });
  router.post("/query/validate", authAsync, canBuilder("read"), wrap((req, res) => res.json(QueryEngine.normalizeQuery(req.body?.query || req.body?.definition || {}))));
  router.post("/query/execute", authAsync, canBuilder("read"), wrap(async (req, res) => res.json(await QueryEngine.executeQueryAsync(db, tenantOf(req), req.body?.query || req.body?.definition || {}, queryContext(req)))));
  router.post("/query/preview", authAsync, canBuilder("read"), wrap(async (req, res) => res.json(await QueryEngine.executeQueryAsync(db, tenantOf(req), req.body?.query || req.body?.definition || {}, { ...queryContext(req), parameters: req.body?.parameters || {} }))));

  // ── Reports ───────────────────────────────────────────────────────────────
  router.get("/reports", authAsync, canReports("read"), wrap(async (req, res) => res.json(await Reports.listReportsAsync(db, tenantOf(req), listQuery(req), actorOf(req)))));
  router.post("/reports", authAsync, canReports("create"), wrap(async (req, res) => res.status(201).json(await Reports.createReportAsync(db, tenantOf(req), req.body || {}, actorOf(req), req.ip))));
  const updateReport = wrap(async (req, res) => res.json(await Reports.updateReportAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req), req.ip)));
  router.get("/reports/:ref", authAsync, canReports("read"), wrap(async (req, res) => res.json(await Reports.getReportAsync(db, tenantOf(req), req.params.ref))));
  router.put("/reports/:ref", authAsync, canReports("update"), updateReport);
  router.patch("/reports/:ref", authAsync, canReports("update"), updateReport);
  router.post("/reports/:ref/publish", authAsync, canReports("update"), wrap(async (req, res) => res.json(await Reports.publishReportAsync(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.post("/reports/:ref/status", authAsync, canReports("update"), wrap(async (req, res) => res.json(await Reports.setReportStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, actorOf(req)))));
  router.post("/reports/:ref/clone", authAsync, canReports("create"), wrap(async (req, res) => res.status(201).json(await Reports.cloneReportAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req)))));
  router.delete("/reports/:ref", authAsync, canReports("delete"), wrap(async (req, res) => res.json(await Reports.deleteReportAsync(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.get("/reports/:ref/versions", authAsync, canReports("read"), wrap(async (req, res) => res.json(await Reports.listReportVersionsAsync(db, tenantOf(req), req.params.ref))));
  router.get("/reports/:ref/versions/:version", authAsync, canReports("read"), wrap(async (req, res) => res.json(await Reports.getReportVersionAsync(db, tenantOf(req), req.params.ref, req.params.version))));
  router.post("/reports/:ref/shares", authAsync, canReports("update"), wrap(async (req, res) => res.json({ shares: await Reports.replaceReportSharesAsync(db, tenantOf(req), (await Reports.getReportAsync(db, tenantOf(req), req.params.ref)).id, req.body?.shares || []) })));
  router.post("/reports/:ref/preview", authAsync, canReports("read"), wrap(async (req, res) => res.json(await Reports.previewReportAsync(db, tenantOf(req), req.params.ref, { parameters: req.body?.parameters || {}, page: req.body?.page, page_size: req.body?.page_size, filters: req.body?.filters }, actorOf(req), req.ip))));
  router.post("/reports/:ref/execute", authAsync, canReports("read"), wrap(async (req, res) => res.json(await Reports.executeReportAsync(db, tenantOf(req), req.params.ref, { parameters: req.body?.parameters || {}, page: req.body?.page, page_size: req.body?.page_size, filters: req.body?.filters }, actorOf(req), req.ip))));
  router.post("/reports/:ref/export", authAsync, canExports("execute"), wrap(async (req, res) => res.status(201).json(await Exports.requestExportAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req), req.ip))));

  // ── Metrics (reusable metric engine) ──────────────────────────────────────
  router.get("/metric-definitions", authAsync, canMetrics("read"), wrap(async (req, res) => res.json(await Metrics.listMetricsAsync(db, tenantOf(req), listQuery(req)))));
  router.post("/metric-definitions", authAsync, canMetrics("create"), wrap(async (req, res) => res.status(201).json(await Metrics.createMetricAsync(db, tenantOf(req), req.body || {}, actorOf(req), req.ip))));
  const updateMetric = wrap(async (req, res) => res.json(await Metrics.updateMetricAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/metric-definitions/:ref", authAsync, canMetrics("read"), wrap(async (req, res) => res.json(await Metrics.getMetricAsync(db, tenantOf(req), req.params.ref))));
  router.put("/metric-definitions/:ref", authAsync, canMetrics("update"), updateMetric);
  router.patch("/metric-definitions/:ref", authAsync, canMetrics("update"), updateMetric);
  router.post("/metric-definitions/:ref/status", authAsync, canMetrics("update"), wrap(async (req, res) => res.json(await Metrics.setMetricStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, actorOf(req)))));
  router.post("/metric-definitions/:ref/compute", authAsync, canMetrics("read"), wrap(async (req, res) => res.json(await Metrics.computeMetricAsync(db, tenantOf(req), req.params.ref, { actor: actorOf(req), ip: req.ip, organizationId: req.body?.organization_id ?? null, parameters: req.body?.parameters || {} }))));
  router.get("/metric-definitions/:ref/versions", authAsync, canMetrics("read"), wrap(async (req, res) => res.json(await Metrics.listMetricVersionsAsync(db, tenantOf(req), req.params.ref))));
  router.delete("/metric-definitions/:ref", authAsync, canMetrics("delete"), wrap(async (req, res) => res.json(await Metrics.deleteMetricAsync(db, tenantOf(req), req.params.ref))));

  // ── KPIs ──────────────────────────────────────────────────────────────────
  router.get("/kpis", authAsync, canKpis("read"), wrap(async (req, res) => res.json(await Kpis.listKpisAsync(db, tenantOf(req), listQuery(req)))));
  router.post("/kpis", authAsync, canKpis("create"), wrap(async (req, res) => res.status(201).json(await Kpis.createKpiAsync(db, tenantOf(req), req.body || {}, actorOf(req), req.ip))));
  const updateKpi = wrap(async (req, res) => res.json(await Kpis.updateKpiAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/kpis/:ref", authAsync, canKpis("read"), wrap(async (req, res) => res.json(await Kpis.getKpiAsync(db, tenantOf(req), req.params.ref))));
  router.put("/kpis/:ref", authAsync, canKpis("update"), updateKpi);
  router.patch("/kpis/:ref", authAsync, canKpis("update"), updateKpi);
  router.post("/kpis/:ref/status", authAsync, canKpis("update"), wrap(async (req, res) => res.json(await Kpis.setKpiStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, actorOf(req)))));
  router.get("/kpis/:ref/value", authAsync, canKpis("read"), wrap(async (req, res) => res.json(await Kpis.getKpiValueAsync(db, tenantOf(req), req.params.ref, { actor: actorOf(req), ip: req.ip, organizationId: req.query.organization_id ?? null, parameters: req.query }))));
  router.post("/kpis/:ref/evaluate", authAsync, canKpis("read"), wrap(async (req, res) => res.json(await Kpis.computeKpiAsync(db, tenantOf(req), req.params.ref, { actor: actorOf(req), ip: req.ip, organizationId: req.body?.organization_id ?? null, parameters: req.body?.parameters || {} }))));
  router.get("/kpis/:ref/versions", authAsync, canKpis("read"), wrap(async (req, res) => res.json(await Kpis.listKpiVersionsAsync(db, tenantOf(req), req.params.ref))));
  router.delete("/kpis/:ref", authAsync, canKpis("delete"), wrap(async (req, res) => res.json(await Kpis.deleteKpiAsync(db, tenantOf(req), req.params.ref))));

  // ── Dashboards ────────────────────────────────────────────────────────────
  router.get("/dashboards", authAsync, canDashboards("read"), wrap(async (req, res) => res.json(await Dashboards.listDashboardsAsync(db, tenantOf(req), listQuery(req), actorOf(req)))));
  router.post("/dashboards", authAsync, canDashboards("create"), wrap(async (req, res) => res.status(201).json(await Dashboards.createDashboardAsync(db, tenantOf(req), req.body || {}, actorOf(req), req.ip))));
  const updateDashboard = wrap(async (req, res) => res.json(await Dashboards.updateDashboardAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req), req.ip)));
  router.get("/dashboards/:ref", authAsync, canDashboards("read"), wrap(async (req, res) => res.json(await Dashboards.getDashboardWithWidgetsAsync(db, tenantOf(req), req.params.ref))));
  router.put("/dashboards/:ref", authAsync, canDashboards("update"), updateDashboard);
  router.patch("/dashboards/:ref", authAsync, canDashboards("update"), updateDashboard);
  router.post("/dashboards/:ref/publish", authAsync, canDashboards("update"), wrap(async (req, res) => res.json(await Dashboards.publishDashboardAsync(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.post("/dashboards/:ref/status", authAsync, canDashboards("update"), wrap(async (req, res) => res.json(await Dashboards.setDashboardStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, actorOf(req)))));
  router.post("/dashboards/:ref/clone", authAsync, canDashboards("create"), wrap(async (req, res) => res.status(201).json(await Dashboards.cloneDashboardAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req)))));
  router.delete("/dashboards/:ref", authAsync, canDashboards("delete"), wrap(async (req, res) => res.json(await Dashboards.deleteDashboardAsync(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.post("/dashboards/:ref/refresh", authAsync, canDashboards("read"), wrap(async (req, res) => res.json(await Dashboards.refreshDashboardAsync(db, tenantOf(req), req.params.ref, { parameters: req.body?.parameters || {} }, actorOf(req), req.ip))));
  router.get("/dashboards/:ref/versions", authAsync, canDashboards("read"), wrap(async (req, res) => res.json(await Dashboards.listDashboardVersionsAsync(db, tenantOf(req), req.params.ref))));
  router.get("/dashboards/:ref/widgets", authAsync, canDashboards("read"), wrap(async (req, res) => res.json(await Dashboards.listWidgetsAsync(db, tenantOf(req), req.params.ref))));
  router.post("/dashboards/:ref/widgets", authAsync, canDashboards("update"), wrap(async (req, res) => res.status(201).json(await Dashboards.addWidgetAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req)))));
  router.post("/dashboards/:ref/widgets/reorder", authAsync, canDashboards("update"), wrap(async (req, res) => res.json(await Dashboards.reorderWidgetsAsync(db, tenantOf(req), req.params.ref, req.body?.order || [], actorOf(req)))));
  router.patch("/widgets/:ref", authAsync, canDashboards("update"), wrap(async (req, res) => res.json(await Dashboards.updateWidgetAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req)))));
  router.delete("/widgets/:ref", authAsync, canDashboards("delete"), wrap(async (req, res) => res.json(await Dashboards.deleteWidgetAsync(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.post("/widgets/:ref/drill-down", authAsync, canDashboards("read"), wrap(async (req, res) => res.json(await Dashboards.drillDownAsync(db, tenantOf(req), req.params.ref, { parameters: req.body?.parameters || {}, value: req.body?.value, filters: req.body?.filters || [] }, actorOf(req), req.ip))));

  // ── Exports ───────────────────────────────────────────────────────────────
  router.get("/exports", authAsync, canExports("read"), wrap(async (req, res) => res.json(await Exports.listExportsAsync(db, tenantOf(req), listQuery(req)))));
  router.post("/exports", authAsync, canExports("execute"), wrap(async (req, res) => res.status(201).json(await Exports.requestExportAsync(db, tenantOf(req), req.body?.report_ref || req.body?.report_code || req.body?.report, req.body || {}, actorOf(req), req.ip))));
  router.get("/exports/:ref", authAsync, canExports("read"), wrap(async (req, res) => res.json(await Exports.getExportAsync(db, tenantOf(req), req.params.ref))));
  router.get("/exports/:ref/download", authAsync, canExports("read"), wrap(async (req, res) => {
    const file = await Exports.downloadExportAsync(db, tenantOf(req), req.params.ref);
    res.setHeader("Content-Type", file.content_type);
    res.setHeader("Content-Disposition", `attachment; filename="${file.file_name}"`);
    res.send(file.content);
  }));
  router.post("/exports/:ref/run", authAsync, canExports("execute"), wrap(async (req, res) => res.json(await Exports.executeExportAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req), req.ip))));
  router.delete("/exports/:ref", authAsync, canExports("delete"), wrap(async (req, res) => res.json(await Exports.deleteExportAsync(db, tenantOf(req), req.params.ref))));

  // ── Schedules ─────────────────────────────────────────────────────────────
  router.get("/schedules", authAsync, canSchedules("read"), wrap(async (req, res) => res.json(await Scheduling.listSchedulesAsync(db, tenantOf(req), listQuery(req)))));
  router.post("/schedules", authAsync, canSchedules("create"), wrap(async (req, res) => res.status(201).json(await Scheduling.createScheduleAsync(db, tenantOf(req), req.body || {}, actorOf(req), req.ip))));
  router.get("/schedules/due", authAsync, canSchedules("read"), wrap(async (req, res) => res.json({ items: await Scheduling.dueSchedulesAsync(db, tenantOf(req)), as_of: new Date().toISOString() })));
  const updateSchedule = wrap(async (req, res) => res.json(await Scheduling.updateScheduleAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/schedules/:ref", authAsync, canSchedules("read"), wrap(async (req, res) => res.json(await Scheduling.getScheduleAsync(db, tenantOf(req), req.params.ref))));
  router.put("/schedules/:ref", authAsync, canSchedules("update"), updateSchedule);
  router.patch("/schedules/:ref", authAsync, canSchedules("update"), updateSchedule);
  router.post("/schedules/:ref/status", authAsync, canSchedules("update"), wrap(async (req, res) => res.json(await Scheduling.setScheduleStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, actorOf(req)))));
  router.post("/schedules/:ref/run", authAsync, canSchedules("execute"), wrap(async (req, res) => res.json(await Scheduling.runScheduleAsync(db, tenantOf(req), req.params.ref, actorOf(req), req.ip))));
  router.delete("/schedules/:ref", authAsync, canSchedules("delete"), wrap(async (req, res) => res.json(await Scheduling.deleteScheduleAsync(db, tenantOf(req), req.params.ref))));

  // ── BI integration ────────────────────────────────────────────────────────
  router.get("/bi/capabilities", authAsync, canBi("read"), wrap((_req, res) => res.json(Bi.biCapabilities())));
  router.get("/bi/connections", authAsync, canBi("read"), wrap(async (req, res) => res.json(await Bi.listBiConnectionsAsync(db, tenantOf(req), listQuery(req)))));
  router.post("/bi/connections", authAsync, canBi("create"), wrap(async (req, res) => res.status(201).json(await Bi.createBiConnectionAsync(db, tenantOf(req), req.body || {}, actorOf(req), req.ip))));
  const updateBiConnection = wrap(async (req, res) => res.json(await Bi.updateBiConnectionAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/bi/connections/:ref", authAsync, canBi("read"), wrap(async (req, res) => res.json(await Bi.getBiConnectionAsync(db, tenantOf(req), req.params.ref))));
  router.put("/bi/connections/:ref", authAsync, canBi("update"), updateBiConnection);
  router.patch("/bi/connections/:ref", authAsync, canBi("update"), updateBiConnection);
  router.delete("/bi/connections/:ref", authAsync, canBi("delete"), wrap(async (req, res) => res.json(await Bi.deleteBiConnectionAsync(db, tenantOf(req), req.params.ref))));
  router.get("/bi/datasets", authAsync, canBi("read"), wrap(async (req, res) => res.json(await Bi.listBiDatasetsAsync(db, tenantOf(req), listQuery(req)))));
  router.post("/bi/datasets", authAsync, canBi("create"), wrap(async (req, res) => res.status(201).json(await Bi.createBiDatasetAsync(db, tenantOf(req), req.body || {}, actorOf(req), req.ip))));
  const updateBiDataset = wrap(async (req, res) => res.json(await Bi.updateBiDatasetAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/bi/datasets/:ref", authAsync, canBi("read"), wrap(async (req, res) => res.json(await Bi.getBiDatasetAsync(db, tenantOf(req), req.params.ref))));
  router.put("/bi/datasets/:ref", authAsync, canBi("update"), updateBiDataset);
  router.patch("/bi/datasets/:ref", authAsync, canBi("update"), updateBiDataset);
  router.delete("/bi/datasets/:ref", authAsync, canBi("delete"), wrap(async (req, res) => res.json(await Bi.deleteBiDatasetAsync(db, tenantOf(req), req.params.ref))));
  router.get("/bi/datasets/:ref/data", authAsync, canBi("read"), wrap(async (req, res) => res.json(await Bi.getBiDatasetDataAsync(db, tenantOf(req), req.params.ref, { parameters: req.query }, actorOf(req), req.ip))));
  router.get("/bi/datasets/:ref/metadata", authAsync, canBi("read"), wrap(async (req, res) => res.json(await Bi.datasetODataMetadataAsync(db, tenantOf(req), req.params.ref))));
  router.post("/bi/datasets/:ref/publish", authAsync, canBi("execute"), wrap(async (req, res) => res.json(await Bi.publishDatasetAsync(db, tenantOf(req), req.params.ref, { parameters: req.body?.parameters || {} }, actorOf(req), req.ip))));
  router.get("/bi/publish-jobs", authAsync, canBi("read"), wrap(async (req, res) => res.json(await Bi.listBiPublishJobsAsync(db, tenantOf(req), listQuery(req)))));

  // ── History, executions, read model ───────────────────────────────────────
  router.get("/executions", authAsync, canHistory("read"), wrap(async (req, res) => res.json(await History.listExecutionsAsync(db, tenantOf(req), listQuery(req)))));
  router.get("/executions/summary", authAsync, canObservability("read"), wrap(async (req, res) => res.json(await History.executionSummaryAsync(db, tenantOf(req)))));
  router.get("/executions/:ref", authAsync, canHistory("read"), wrap(async (req, res) => res.json(await History.getExecutionAsync(db, tenantOf(req), req.params.ref))));
  router.get("/history", authAsync, canHistory("read"), wrap(async (req, res) => res.json(await History.listHistoryAsync(db, tenantOf(req), listQuery(req)))));
  router.get("/read-model", authAsync, canObservability("read"), wrap(async (req, res) => res.json(await ReadModel.listReadModelEntriesAsync(db, tenantOf(req), listQuery(req)))));
  router.get("/read-model/status", authAsync, canObservability("read"), wrap(async (req, res) => res.json(await ReadModel.readModelStatusAsync(db, tenantOf(req)))));

  // ── Search & discovery ────────────────────────────────────────────────────
  router.post("/search/reindex", authAsync, canSearch("execute"), wrap((_req, res) => res.json({ registered: Search.registerReportingSources() })));
  router.get("/search-meta", authAsync, canSearch("read"), wrap((_req, res) => res.json({ object_types: Constants.SEARCH_OBJECT_TYPES })));

  // ── Background jobs ───────────────────────────────────────────────────────
  router.get("/jobs", authAsync, canJobs("read"), wrap(async (req, res) => res.json(await Jobs.listReportingJobsAsync(db, tenantOf(req), listQuery(req)))));
  router.get("/jobs/:ref", authAsync, canJobs("read"), wrap(async (req, res) => res.json(await Jobs.getReportingJobAsync(db, tenantOf(req), req.params.ref))));
  router.post("/jobs/execute", authAsync, canReports("read"), wrap(async (req, res) => res.status(202).json(await Jobs.submitExecuteJobAsync(db, { tenantId: tenantOf(req), reportRef: req.body?.report_ref || req.body?.report_code, parameters: req.body?.parameters || {}, actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/export", authAsync, canExports("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitExportJobAsync(db, { tenantId: tenantOf(req), exportRef: req.body?.export_ref, actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/schedule-run", authAsync, canSchedules("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitScheduleRunJobAsync(db, { tenantId: tenantOf(req), scheduleRef: req.body?.schedule_ref, actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/kpi", authAsync, canKpis("read"), wrap(async (req, res) => res.status(202).json(await Jobs.submitKpiJobAsync(db, { tenantId: tenantOf(req), kpiRef: req.body?.kpi_ref || req.body?.kpi_code, actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/refresh-read-model", authAsync, canAdmin("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitRefreshJobAsync(db, { tenantId: tenantOf(req), entities: req.body?.entities || null, actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/maintenance", authAsync, canAdmin("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitMaintenanceJobAsync(db, { tenantId: tenantOf(req), actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));

  // ── Foundation & demo seed ────────────────────────────────────────────────
  router.post("/foundation/ensure", authAsync, canAdmin("execute"), wrap(async (_req, res) => res.json(await Foundation.ensureReportingFoundationAsync(db))));
  router.post("/seed", authAsync, canAdmin("execute"), wrap(async (req, res) => res.json(await Seed.seedReportingAsync(db, tenantOf(req)))));

  return router;
}
