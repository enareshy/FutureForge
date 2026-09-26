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

export function createReportingRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const actorOf = (req) => req.actor;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";

  const canReports = (a) => can(R.reports, a);
  const canBuilder = (a) => can(R.builder, a);
  const canDashboards = (a) => can(R.dashboards, a);
  const canKpis = (a) => can(R.kpis, a);
  const canMetrics = (a) => can(R.metrics, a);
  const canDataSources = (a) => can(R.dataSources, a);
  const canSchedules = (a) => can(R.schedules, a);
  const canExports = (a) => can(R.exports, a);
  const canBi = (a) => can(R.bi, a);
  const canJobs = (a) => can(R.jobs, a);
  const canHistory = (a) => can(R.history, a);
  const canSearch = (a) => can(R.search, a);
  const canObservability = (a) => can(R.observability, a);
  const canAdmin = (a) => can(R.admin, a);

  const listQuery = (req) => ({ ...req.query });

  // ── Meta, health, observability ───────────────────────────────────────────
  router.get(
    "/meta",
    auth,
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

  router.get("/health", auth, canObservability("read"), wrap((req, res) => res.json({ ...Foundation.reportingHealth(db, tenantOf(req)), ...History.executionSummary(db, tenantOf(req)) })));
  router.get("/metrics", auth, canObservability("read"), wrap((req, res) => res.json({ executions: History.executionSummary(db, tenantOf(req)), cache: Cache.cacheStats(db, tenantOf(req)), read_model: ReadModel.readModelStatus(db, tenantOf(req)) })));
  router.get("/observability", auth, canObservability("read"), wrap((req, res) => res.json({ executions: History.executionSummary(db, tenantOf(req)), cache: Cache.cacheStats(db, tenantOf(req)), read_model: ReadModel.readModelStatus(db, tenantOf(req)) })));

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get("/config", auth, canAdmin("read"), wrap((req, res) => res.json(Configuration.listConfig(db, tenantOf(req)))));
  const setConfig = wrap((req, res) => res.json({ key: req.params.key, value: Configuration.setConfig(db, tenantOf(req), req.params.key, req.body?.value, actorOf(req), req.ip) }));
  router.put("/config/:key", auth, canAdmin("update"), setConfig);
  router.patch("/config/:key", auth, canAdmin("update"), setConfig);

  // ── Semantic layer & data sources ─────────────────────────────────────────
  router.get("/data-sources", auth, canDataSources("read"), wrap((_req, res) => res.json(DataSources.listDataSources())));
  router.get("/semantic/entities", auth, canDataSources("read"), wrap((_req, res) => res.json({ items: Semantic.listEntities(), total: Semantic.listEntities().length })));
  router.get("/semantic/entities/:code", auth, canDataSources("read"), wrap((req, res) => res.json(Semantic.getEntity(req.params.code))));

  // ── Ad-hoc query (report builder) ─────────────────────────────────────────
  const queryContext = (req) => ({ actor: actorOf(req), organizationId: req.body?.organization_id ?? null, ip: req.ip, parameters: req.body?.parameters || {}, page: req.body?.page, page_size: req.body?.page_size });
  router.post("/query/validate", auth, canBuilder("read"), wrap((req, res) => res.json(QueryEngine.normalizeQuery(req.body?.query || req.body?.definition || {}))));
  router.post("/query/execute", auth, canBuilder("read"), wrap((req, res) => res.json(QueryEngine.executeQuery(db, tenantOf(req), req.body?.query || req.body?.definition || {}, queryContext(req)))));
  router.post("/query/preview", auth, canBuilder("read"), wrap((req, res) => res.json(QueryEngine.executeQuery(db, tenantOf(req), req.body?.query || req.body?.definition || {}, { ...queryContext(req), parameters: req.body?.parameters || {} }))));

  // ── Reports ───────────────────────────────────────────────────────────────
  router.get("/reports", auth, canReports("read"), wrap((req, res) => res.json(Reports.listReports(db, tenantOf(req), listQuery(req), actorOf(req)))));
  router.post("/reports", auth, canReports("create"), wrap((req, res) => res.status(201).json(Reports.createReport(db, tenantOf(req), req.body || {}, actorOf(req), req.ip))));
  const updateReport = wrap((req, res) => res.json(Reports.updateReport(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req), req.ip)));
  router.get("/reports/:ref", auth, canReports("read"), wrap((req, res) => res.json(Reports.getReport(db, tenantOf(req), req.params.ref))));
  router.put("/reports/:ref", auth, canReports("update"), updateReport);
  router.patch("/reports/:ref", auth, canReports("update"), updateReport);
  router.post("/reports/:ref/publish", auth, canReports("update"), wrap((req, res) => res.json(Reports.publishReport(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.post("/reports/:ref/status", auth, canReports("update"), wrap((req, res) => res.json(Reports.setReportStatus(db, tenantOf(req), req.params.ref, req.body?.status, actorOf(req)))));
  router.post("/reports/:ref/clone", auth, canReports("create"), wrap((req, res) => res.status(201).json(Reports.cloneReport(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req)))));
  router.delete("/reports/:ref", auth, canReports("delete"), wrap((req, res) => res.json(Reports.deleteReport(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.get("/reports/:ref/versions", auth, canReports("read"), wrap((req, res) => res.json(Reports.listReportVersions(db, tenantOf(req), req.params.ref))));
  router.get("/reports/:ref/versions/:version", auth, canReports("read"), wrap((req, res) => res.json(Reports.getReportVersion(db, tenantOf(req), req.params.ref, req.params.version))));
  router.post("/reports/:ref/shares", auth, canReports("update"), wrap((req, res) => res.json({ shares: Reports.replaceReportShares(db, tenantOf(req), Reports.getReport(db, tenantOf(req), req.params.ref).id, req.body?.shares || []) })));
  router.post("/reports/:ref/preview", auth, canReports("read"), wrap((req, res) => res.json(Reports.previewReport(db, tenantOf(req), req.params.ref, { parameters: req.body?.parameters || {}, page: req.body?.page, page_size: req.body?.page_size, filters: req.body?.filters }, actorOf(req), req.ip))));
  router.post("/reports/:ref/execute", auth, canReports("read"), wrap((req, res) => res.json(Reports.executeReport(db, tenantOf(req), req.params.ref, { parameters: req.body?.parameters || {}, page: req.body?.page, page_size: req.body?.page_size, filters: req.body?.filters }, actorOf(req), req.ip))));
  router.post("/reports/:ref/export", auth, canExports("execute"), wrap((req, res) => res.status(201).json(Exports.requestExport(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req), req.ip))));

  // ── Metrics (reusable metric engine) ──────────────────────────────────────
  router.get("/metric-definitions", auth, canMetrics("read"), wrap((req, res) => res.json(Metrics.listMetrics(db, tenantOf(req), listQuery(req)))));
  router.post("/metric-definitions", auth, canMetrics("create"), wrap((req, res) => res.status(201).json(Metrics.createMetric(db, tenantOf(req), req.body || {}, actorOf(req), req.ip))));
  const updateMetric = wrap((req, res) => res.json(Metrics.updateMetric(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/metric-definitions/:ref", auth, canMetrics("read"), wrap((req, res) => res.json(Metrics.getMetric(db, tenantOf(req), req.params.ref))));
  router.put("/metric-definitions/:ref", auth, canMetrics("update"), updateMetric);
  router.patch("/metric-definitions/:ref", auth, canMetrics("update"), updateMetric);
  router.post("/metric-definitions/:ref/status", auth, canMetrics("update"), wrap((req, res) => res.json(Metrics.setMetricStatus(db, tenantOf(req), req.params.ref, req.body?.status, actorOf(req)))));
  router.post("/metric-definitions/:ref/compute", auth, canMetrics("read"), wrap((req, res) => res.json(Metrics.computeMetric(db, tenantOf(req), req.params.ref, { actor: actorOf(req), ip: req.ip, organizationId: req.body?.organization_id ?? null, parameters: req.body?.parameters || {} }))));
  router.get("/metric-definitions/:ref/versions", auth, canMetrics("read"), wrap((req, res) => res.json(Metrics.listMetricVersions(db, tenantOf(req), req.params.ref))));
  router.delete("/metric-definitions/:ref", auth, canMetrics("delete"), wrap((req, res) => res.json(Metrics.deleteMetric(db, tenantOf(req), req.params.ref))));

  // ── KPIs ──────────────────────────────────────────────────────────────────
  router.get("/kpis", auth, canKpis("read"), wrap((req, res) => res.json(Kpis.listKpis(db, tenantOf(req), listQuery(req)))));
  router.post("/kpis", auth, canKpis("create"), wrap((req, res) => res.status(201).json(Kpis.createKpi(db, tenantOf(req), req.body || {}, actorOf(req), req.ip))));
  const updateKpi = wrap((req, res) => res.json(Kpis.updateKpi(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/kpis/:ref", auth, canKpis("read"), wrap((req, res) => res.json(Kpis.getKpi(db, tenantOf(req), req.params.ref))));
  router.put("/kpis/:ref", auth, canKpis("update"), updateKpi);
  router.patch("/kpis/:ref", auth, canKpis("update"), updateKpi);
  router.post("/kpis/:ref/status", auth, canKpis("update"), wrap((req, res) => res.json(Kpis.setKpiStatus(db, tenantOf(req), req.params.ref, req.body?.status, actorOf(req)))));
  router.get("/kpis/:ref/value", auth, canKpis("read"), wrap((req, res) => res.json(Kpis.getKpiValue(db, tenantOf(req), req.params.ref, { actor: actorOf(req), ip: req.ip, organizationId: req.query.organization_id ?? null, parameters: req.query }))));
  router.post("/kpis/:ref/evaluate", auth, canKpis("read"), wrap((req, res) => res.json(Kpis.computeKpi(db, tenantOf(req), req.params.ref, { actor: actorOf(req), ip: req.ip, organizationId: req.body?.organization_id ?? null, parameters: req.body?.parameters || {} }))));
  router.get("/kpis/:ref/versions", auth, canKpis("read"), wrap((req, res) => res.json(Kpis.listKpiVersions(db, tenantOf(req), req.params.ref))));
  router.delete("/kpis/:ref", auth, canKpis("delete"), wrap((req, res) => res.json(Kpis.deleteKpi(db, tenantOf(req), req.params.ref))));

  // ── Dashboards ────────────────────────────────────────────────────────────
  router.get("/dashboards", auth, canDashboards("read"), wrap((req, res) => res.json(Dashboards.listDashboards(db, tenantOf(req), listQuery(req), actorOf(req)))));
  router.post("/dashboards", auth, canDashboards("create"), wrap((req, res) => res.status(201).json(Dashboards.createDashboard(db, tenantOf(req), req.body || {}, actorOf(req), req.ip))));
  const updateDashboard = wrap((req, res) => res.json(Dashboards.updateDashboard(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req), req.ip)));
  router.get("/dashboards/:ref", auth, canDashboards("read"), wrap((req, res) => res.json(Dashboards.getDashboardWithWidgets(db, tenantOf(req), req.params.ref))));
  router.put("/dashboards/:ref", auth, canDashboards("update"), updateDashboard);
  router.patch("/dashboards/:ref", auth, canDashboards("update"), updateDashboard);
  router.post("/dashboards/:ref/publish", auth, canDashboards("update"), wrap((req, res) => res.json(Dashboards.publishDashboard(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.post("/dashboards/:ref/status", auth, canDashboards("update"), wrap((req, res) => res.json(Dashboards.setDashboardStatus(db, tenantOf(req), req.params.ref, req.body?.status, actorOf(req)))));
  router.post("/dashboards/:ref/clone", auth, canDashboards("create"), wrap((req, res) => res.status(201).json(Dashboards.cloneDashboard(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req)))));
  router.delete("/dashboards/:ref", auth, canDashboards("delete"), wrap((req, res) => res.json(Dashboards.deleteDashboard(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.post("/dashboards/:ref/refresh", auth, canDashboards("read"), wrap((req, res) => res.json(Dashboards.refreshDashboard(db, tenantOf(req), req.params.ref, { parameters: req.body?.parameters || {} }, actorOf(req), req.ip))));
  router.get("/dashboards/:ref/versions", auth, canDashboards("read"), wrap((req, res) => res.json(Dashboards.listDashboardVersions(db, tenantOf(req), req.params.ref))));
  router.get("/dashboards/:ref/widgets", auth, canDashboards("read"), wrap((req, res) => res.json(Dashboards.listWidgets(db, tenantOf(req), req.params.ref))));
  router.post("/dashboards/:ref/widgets", auth, canDashboards("update"), wrap((req, res) => res.status(201).json(Dashboards.addWidget(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req)))));
  router.post("/dashboards/:ref/widgets/reorder", auth, canDashboards("update"), wrap((req, res) => res.json(Dashboards.reorderWidgets(db, tenantOf(req), req.params.ref, req.body?.order || [], actorOf(req)))));
  router.patch("/widgets/:ref", auth, canDashboards("update"), wrap((req, res) => res.json(Dashboards.updateWidget(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req)))));
  router.delete("/widgets/:ref", auth, canDashboards("delete"), wrap((req, res) => res.json(Dashboards.deleteWidget(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.post("/widgets/:ref/drill-down", auth, canDashboards("read"), wrap((req, res) => res.json(Dashboards.drillDown(db, tenantOf(req), req.params.ref, { parameters: req.body?.parameters || {}, value: req.body?.value, filters: req.body?.filters || [] }, actorOf(req), req.ip))));

  // ── Exports ───────────────────────────────────────────────────────────────
  router.get("/exports", auth, canExports("read"), wrap((req, res) => res.json(Exports.listExports(db, tenantOf(req), listQuery(req)))));
  router.post("/exports", auth, canExports("execute"), wrap((req, res) => res.status(201).json(Exports.requestExport(db, tenantOf(req), req.body?.report_ref || req.body?.report_code || req.body?.report, req.body || {}, actorOf(req), req.ip))));
  router.get("/exports/:ref", auth, canExports("read"), wrap((req, res) => res.json(Exports.getExport(db, tenantOf(req), req.params.ref))));
  router.get("/exports/:ref/download", auth, canExports("read"), wrap((req, res) => {
    const file = Exports.downloadExport(db, tenantOf(req), req.params.ref);
    res.setHeader("Content-Type", file.content_type);
    res.setHeader("Content-Disposition", `attachment; filename="${file.file_name}"`);
    res.send(file.content);
  }));
  router.post("/exports/:ref/run", auth, canExports("execute"), wrap((req, res) => res.json(Exports.executeExport(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req), req.ip))));
  router.delete("/exports/:ref", auth, canExports("delete"), wrap((req, res) => res.json(Exports.deleteExport(db, tenantOf(req), req.params.ref))));

  // ── Schedules ─────────────────────────────────────────────────────────────
  router.get("/schedules", auth, canSchedules("read"), wrap((req, res) => res.json(Scheduling.listSchedules(db, tenantOf(req), listQuery(req)))));
  router.post("/schedules", auth, canSchedules("create"), wrap((req, res) => res.status(201).json(Scheduling.createSchedule(db, tenantOf(req), req.body || {}, actorOf(req), req.ip))));
  router.get("/schedules/due", auth, canSchedules("read"), wrap((req, res) => res.json({ items: Scheduling.dueSchedules(db, tenantOf(req)), as_of: new Date().toISOString() })));
  const updateSchedule = wrap((req, res) => res.json(Scheduling.updateSchedule(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/schedules/:ref", auth, canSchedules("read"), wrap((req, res) => res.json(Scheduling.getSchedule(db, tenantOf(req), req.params.ref))));
  router.put("/schedules/:ref", auth, canSchedules("update"), updateSchedule);
  router.patch("/schedules/:ref", auth, canSchedules("update"), updateSchedule);
  router.post("/schedules/:ref/status", auth, canSchedules("update"), wrap((req, res) => res.json(Scheduling.setScheduleStatus(db, tenantOf(req), req.params.ref, req.body?.status, actorOf(req)))));
  router.post("/schedules/:ref/run", auth, canSchedules("execute"), wrap((req, res) => res.json(Scheduling.runSchedule(db, tenantOf(req), req.params.ref, actorOf(req), req.ip))));
  router.delete("/schedules/:ref", auth, canSchedules("delete"), wrap((req, res) => res.json(Scheduling.deleteSchedule(db, tenantOf(req), req.params.ref))));

  // ── BI integration ────────────────────────────────────────────────────────
  router.get("/bi/capabilities", auth, canBi("read"), wrap((_req, res) => res.json(Bi.biCapabilities())));
  router.get("/bi/connections", auth, canBi("read"), wrap((req, res) => res.json(Bi.listBiConnections(db, tenantOf(req), listQuery(req)))));
  router.post("/bi/connections", auth, canBi("create"), wrap((req, res) => res.status(201).json(Bi.createBiConnection(db, tenantOf(req), req.body || {}, actorOf(req), req.ip))));
  const updateBiConnection = wrap((req, res) => res.json(Bi.updateBiConnection(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/bi/connections/:ref", auth, canBi("read"), wrap((req, res) => res.json(Bi.getBiConnection(db, tenantOf(req), req.params.ref))));
  router.put("/bi/connections/:ref", auth, canBi("update"), updateBiConnection);
  router.patch("/bi/connections/:ref", auth, canBi("update"), updateBiConnection);
  router.delete("/bi/connections/:ref", auth, canBi("delete"), wrap((req, res) => res.json(Bi.deleteBiConnection(db, tenantOf(req), req.params.ref))));
  router.get("/bi/datasets", auth, canBi("read"), wrap((req, res) => res.json(Bi.listBiDatasets(db, tenantOf(req), listQuery(req)))));
  router.post("/bi/datasets", auth, canBi("create"), wrap((req, res) => res.status(201).json(Bi.createBiDataset(db, tenantOf(req), req.body || {}, actorOf(req), req.ip))));
  const updateBiDataset = wrap((req, res) => res.json(Bi.updateBiDataset(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/bi/datasets/:ref", auth, canBi("read"), wrap((req, res) => res.json(Bi.getBiDataset(db, tenantOf(req), req.params.ref))));
  router.put("/bi/datasets/:ref", auth, canBi("update"), updateBiDataset);
  router.patch("/bi/datasets/:ref", auth, canBi("update"), updateBiDataset);
  router.delete("/bi/datasets/:ref", auth, canBi("delete"), wrap((req, res) => res.json(Bi.deleteBiDataset(db, tenantOf(req), req.params.ref))));
  router.get("/bi/datasets/:ref/data", auth, canBi("read"), wrap((req, res) => res.json(Bi.getBiDatasetData(db, tenantOf(req), req.params.ref, { parameters: req.query }, actorOf(req), req.ip))));
  router.get("/bi/datasets/:ref/metadata", auth, canBi("read"), wrap((req, res) => res.json(Bi.datasetODataMetadata(db, tenantOf(req), req.params.ref))));
  router.post("/bi/datasets/:ref/publish", auth, canBi("execute"), wrap((req, res) => res.json(Bi.publishDataset(db, tenantOf(req), req.params.ref, { parameters: req.body?.parameters || {} }, actorOf(req), req.ip))));
  router.get("/bi/publish-jobs", auth, canBi("read"), wrap((req, res) => res.json(Bi.listBiPublishJobs(db, tenantOf(req), listQuery(req)))));

  // ── History, executions, read model ───────────────────────────────────────
  router.get("/executions", auth, canHistory("read"), wrap((req, res) => res.json(History.listExecutions(db, tenantOf(req), listQuery(req)))));
  router.get("/executions/summary", auth, canObservability("read"), wrap((req, res) => res.json(History.executionSummary(db, tenantOf(req)))));
  router.get("/executions/:ref", auth, canHistory("read"), wrap((req, res) => res.json(History.getExecution(db, tenantOf(req), req.params.ref))));
  router.get("/history", auth, canHistory("read"), wrap((req, res) => res.json(History.listHistory(db, tenantOf(req), listQuery(req)))));
  router.get("/read-model", auth, canObservability("read"), wrap((req, res) => res.json(ReadModel.listReadModelEntries(db, tenantOf(req), listQuery(req)))));
  router.get("/read-model/status", auth, canObservability("read"), wrap((req, res) => res.json(ReadModel.readModelStatus(db, tenantOf(req)))));

  // ── Search & discovery ────────────────────────────────────────────────────
  router.post("/search/reindex", auth, canSearch("execute"), wrap((_req, res) => res.json({ registered: Search.registerReportingSources() })));
  router.get("/search-meta", auth, canSearch("read"), wrap((_req, res) => res.json({ object_types: Constants.SEARCH_OBJECT_TYPES })));

  // ── Background jobs ───────────────────────────────────────────────────────
  router.get("/jobs", auth, canJobs("read"), wrap((req, res) => res.json(Jobs.listReportingJobs(db, tenantOf(req), listQuery(req)))));
  router.get("/jobs/:ref", auth, canJobs("read"), wrap((req, res) => res.json(Jobs.getReportingJob(db, tenantOf(req), req.params.ref))));
  router.post("/jobs/execute", auth, canReports("read"), wrap(async (req, res) => res.status(202).json(await Jobs.submitExecuteJob(db, { tenantId: tenantOf(req), reportRef: req.body?.report_ref || req.body?.report_code, parameters: req.body?.parameters || {}, actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/export", auth, canExports("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitExportJob(db, { tenantId: tenantOf(req), exportRef: req.body?.export_ref, actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/schedule-run", auth, canSchedules("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitScheduleRunJob(db, { tenantId: tenantOf(req), scheduleRef: req.body?.schedule_ref, actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/kpi", auth, canKpis("read"), wrap(async (req, res) => res.status(202).json(await Jobs.submitKpiJob(db, { tenantId: tenantOf(req), kpiRef: req.body?.kpi_ref || req.body?.kpi_code, actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/refresh-read-model", auth, canAdmin("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitRefreshJob(db, { tenantId: tenantOf(req), entities: req.body?.entities || null, actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/maintenance", auth, canAdmin("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitMaintenanceJob(db, { tenantId: tenantOf(req), actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));

  // ── Foundation & demo seed ────────────────────────────────────────────────
  router.post("/foundation/ensure", auth, canAdmin("execute"), wrap((_req, res) => res.json(Foundation.ensureReportingFoundation(db))));
  router.post("/seed", auth, canAdmin("execute"), wrap((req, res) => res.json(Seed.seedReporting(db, tenantOf(req)))));

  return router;
}
