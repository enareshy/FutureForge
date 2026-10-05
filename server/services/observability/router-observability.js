// REST router for the P2 Data Observability capability (Module 21). Built as a
// factory so it reuses the application's auth, authorization and error
// middleware. Mounted at /api/observability and /api/v1/observability.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization. The module is served from the
// asynchronous data-access layer; only pure metadata routes and the search
// source registration route stay synchronous.
import { searchObjectsAsync } from "../search/v1.js";
import {
  Constants,
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
  History,
  Jobs,
  Search,
  Foundation,
  Seed,
} from "./index.js";

const R = Constants.OBSERVABILITY_RESOURCES;

export function createObservabilityRouter({ express, db, auth, authAsync, can, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const actorOf = (req) => req.actor;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";

  const canOverview = (a) => canAsync(R.overview, a);
  const canHealth = (a) => canAsync(R.health, a);
  const canMetrics = (a) => canAsync(R.metrics, a);
  const canVolume = (a) => canAsync(R.volume, a);
  const canFreshness = (a) => canAsync(R.freshness, a);
  const canQuality = (a) => canAsync(R.quality, a);
  const canPipelines = (a) => canAsync(R.pipelines, a);
  const canFailures = (a) => canAsync(R.failures, a);
  const canAlerts = (a) => canAsync(R.alerts, a);
  const canIncidents = (a) => canAsync(R.incidents, a);
  const canSlo = (a) => canAsync(R.slo, a);
  const canDashboards = (a) => canAsync(R.dashboards, a);
  const canProviders = (a) => canAsync(R.providers, a);
  const canJobs = (a) => canAsync(R.jobs, a);
  const canHistory = (a) => canAsync(R.history, a);
  const canSearch = (a) => canAsync(R.search, a);
  const canAdmin = (a) => canAsync(R.admin, a);

  const listQuery = (req) => ({ ...req.query });

  // ── Meta, health, observability ───────────────────────────────────────────
  router.get(
    "/meta",
    authAsync,
    canOverview("read"),
    wrap((_req, res) => {
      res.json({
        source_module: Constants.SOURCE_MODULE,
        model_version: Constants.OBSERVABILITY_MODEL_VERSION,
        resources: R,
        capabilities: {
          signal_categories: Constants.SIGNAL_CATEGORIES,
          metric_statuses: Constants.METRIC_STATUSES,
          calculations: Constants.CALCULATIONS,
          aggregations: Constants.AGGREGATIONS,
          metric_units: Constants.METRIC_UNITS,
          metric_directions: Constants.METRIC_DIRECTIONS,
          threshold_operators: Constants.THRESHOLD_OPERATORS,
          health_statuses: Constants.HEALTH_STATUSES,
          health_scopes: Constants.HEALTH_SCOPES,
          health_check_types: Constants.HEALTH_CHECK_TYPES,
          severities: Constants.SEVERITIES,
          alert_statuses: Constants.ALERT_STATUSES,
          alert_event_types: Constants.ALERT_EVENT_TYPES,
          incident_statuses: Constants.INCIDENT_STATUSES,
          slo_kinds: Constants.SLO_KINDS,
          slo_comparisons: Constants.SLO_COMPARISONS,
          asset_types: Constants.ASSET_TYPES,
          freshness_statuses: Constants.FRESHNESS_STATUSES,
          providers: Providers.listProviders(),
          metric_catalog: Constants.METRIC_CATALOG.map((entry) => entry.code),
          dashboard_catalog: Constants.DASHBOARD_CATALOG.map((entry) => entry.code),
          config_defaults: Constants.CONFIG_DEFAULTS,
          job_types: Constants.OBSERVABILITY_JOB_TYPES.map((job) => job.code),
          handler_codes: Constants.OBSERVABILITY_HANDLER_CODES,
          event_types: Constants.OBSERVABILITY_EVENT_TYPES.map((event) => event.code),
          search_types: Constants.SEARCH_OBJECT_TYPES.map((entry) => entry.code),
        },
      });
    })
  );

  router.get("/health-meta", authAsync, canHealth("read"), wrap(async (req, res) => res.json({ ...(await Foundation.observabilityHealthAsync(db, tenantOf(req))) })));
  router.get("/providers", authAsync, canProviders("read"), wrap((_req, res) => res.json({ items: Providers.listProviders(), total: Providers.listProviders().length })));
  router.get("/providers/:code", authAsync, canProviders("read"), wrap(async (req, res) => res.json((await Providers.getProviderAsync(db, req.params.code)) || {})));

  // ── Overview & category read models ───────────────────────────────────────
  router.get("/overview", authAsync, canOverview("read"), wrap(async (req, res) => res.json(await Collection.observabilityOverviewAsync(db, tenantOf(req)))));
  router.get("/health", authAsync, canHealth("read"), wrap(async (req, res) => res.json({ ...(await Health.evaluateHealthAsync(db, tenantOf(req))), current: await Health.currentHealthAsync(db, tenantOf(req)) })));
  router.get("/health/trend", authAsync, canHealth("read"), wrap(async (req, res) => res.json(await Health.healthTrendAsync(db, tenantOf(req), listQuery(req)))));
  router.get("/metrics", authAsync, canMetrics("read"), wrap(async (req, res) => res.json(await Metrics.listMetricsAsync(db, tenantOf(req), listQuery(req)))));
  router.get("/data-volume", authAsync, canVolume("read"), wrap(async (req, res) => res.json(await Collection.categorySummaryAsync(db, tenantOf(req), ["DATA_VOLUME", "FRESHNESS"]))));
  router.get("/quality", authAsync, canQuality("read"), wrap(async (req, res) => res.json(await Collection.categorySummaryAsync(db, tenantOf(req), ["QUALITY"]))));
  router.get("/freshness", authAsync, canFreshness("read"), wrap(async (req, res) => res.json({ summary: await Freshness.freshnessSummaryAsync(db, tenantOf(req)), definitions: await Freshness.listFreshnessAsync(db, tenantOf(req), listQuery(req)) })));
  router.get("/pipelines", authAsync, canPipelines("read"), wrap(async (req, res) => res.json(await Collection.throughputSummaryAsync(db, tenantOf(req)))));
  router.get("/failures", authAsync, canFailures("read"), wrap(async (req, res) => res.json(await Collection.failureSummaryAsync(db, tenantOf(req)))));
  router.get("/runs", authAsync, canMetrics("read"), wrap(async (req, res) => res.json(await Collection.listRunsAsync(db, tenantOf(req), listQuery(req)))));
  router.get("/runs/:ref", authAsync, canMetrics("read"), wrap(async (req, res) => res.json((await Collection.getRunAsync(db, tenantOf(req), req.params.ref)) || { not_found: true })));

  // ── Collection ────────────────────────────────────────────────────────────
  router.post("/collect", authAsync, canMetrics("execute"), wrap(async (req, res) => {
    const body = req.body || {};
    if (body.async) {
      return res.status(202).json(await Jobs.submitCollectJobAsync(db, { tenantId: tenantOf(req), actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req), trigger: body.trigger || "API" }));
    }
    return res.json(await Collection.collectTenantAsync(db, tenantOf(req), { trigger: body.trigger || "API", actor: actorOf(req) }));
  }));
  router.post("/collect/all", authAsync, canAdmin("execute"), wrap(async (req, res) => res.json(await Collection.collectAllTenantsAsync(db, { trigger: "API", actor: actorOf(req) }))));

  // ── Metric definitions ────────────────────────────────────────────────────
  router.post("/metric-definitions", authAsync, canMetrics("create"), wrap(async (req, res) => res.status(201).json(await Metrics.createMetricAsync(db, tenantOf(req), req.body || {}, actorOf(req)))));
  const updateMetric = wrap(async (req, res) => res.json(await Metrics.updateMetricAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/metric-definitions/:ref", authAsync, canMetrics("read"), wrap(async (req, res) => res.json(await Metrics.getMetricAsync(db, tenantOf(req), req.params.ref))));
  router.put("/metric-definitions/:ref", authAsync, canMetrics("update"), updateMetric);
  router.patch("/metric-definitions/:ref", authAsync, canMetrics("update"), updateMetric);
  router.post("/metric-definitions/:ref/status", authAsync, canMetrics("update"), wrap(async (req, res) => res.json(await Metrics.setMetricStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, actorOf(req)))));
  router.delete("/metric-definitions/:ref", authAsync, canMetrics("delete"), wrap(async (req, res) => res.json(await Metrics.deleteMetricAsync(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.get("/metric-definitions/:ref/versions", authAsync, canMetrics("read"), wrap(async (req, res) => res.json({ items: await Metrics.listMetricVersionsAsync(db, tenantOf(req), req.params.ref) })));

  // Metric detail aliases (§ REST: /metrics/{id}, /metrics/{id}/history)
  const getMetric = wrap(async (req, res) => res.json(await Metrics.getMetricAsync(db, tenantOf(req), req.params.ref)));
  router.get("/metrics/:ref", authAsync, canMetrics("read"), getMetric);
  router.get("/metrics/:ref/history", authAsync, canMetrics("read"), wrap(async (req, res) => res.json(await Metrics.metricHistoryAsync(db, tenantOf(req), req.params.ref, listQuery(req)))));
  router.get("/metrics/:ref/observations", authAsync, canMetrics("read"), wrap(async (req, res) => res.json(await Metrics.listObservationsAsync(db, tenantOf(req), { ...listQuery(req), metric_code: req.params.ref }))));
  router.post("/metrics/:ref/observations", authAsync, canMetrics("create"), wrap(async (req, res) => {
    const metric = await Metrics.getMetricAsync(db, tenantOf(req), req.params.ref);
    const id = await Metrics.recordObservationAsync(db, tenantOf(req), metric, { value: req.body?.value, dimensions: req.body?.dimensions || {}, providerCode: req.body?.provider_code, observedAt: req.body?.observed_at });
    return res.status(201).json({ id, metric_code: metric.code, value: req.body?.value });
  }));

  // ── Thresholds ────────────────────────────────────────────────────────────
  router.get("/thresholds", authAsync, canMetrics("read"), wrap(async (req, res) => res.json(await Thresholds.listThresholdsAsync(db, tenantOf(req), listQuery(req)))));
  router.post("/thresholds", authAsync, canMetrics("create"), wrap(async (req, res) => res.status(201).json(await Thresholds.createThresholdAsync(db, tenantOf(req), req.body || {}, actorOf(req)))));
  const updateThreshold = wrap(async (req, res) => res.json(await Thresholds.updateThresholdAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/thresholds/:ref", authAsync, canMetrics("read"), wrap(async (req, res) => res.json(await Thresholds.getThresholdAsync(db, tenantOf(req), req.params.ref))));
  router.put("/thresholds/:ref", authAsync, canMetrics("update"), updateThreshold);
  router.patch("/thresholds/:ref", authAsync, canMetrics("update"), updateThreshold);
  router.delete("/thresholds/:ref", authAsync, canMetrics("delete"), wrap(async (req, res) => res.json(await Thresholds.deleteThresholdAsync(db, tenantOf(req), req.params.ref, actorOf(req)))));

  // ── Data assets & freshness ───────────────────────────────────────────────
  router.get("/assets", authAsync, canFreshness("read"), wrap(async (req, res) => res.json(await Freshness.listAssetsAsync(db, tenantOf(req), listQuery(req)))));
  router.post("/assets", authAsync, canFreshness("create"), wrap(async (req, res) => res.status(201).json(await Freshness.createAssetAsync(db, tenantOf(req), req.body || {}, actorOf(req)))));
  router.get("/assets/:ref", authAsync, canFreshness("read"), wrap(async (req, res) => res.json(await Freshness.getAssetAsync(db, tenantOf(req), req.params.ref))));
  router.get("/freshness-definitions", authAsync, canFreshness("read"), wrap(async (req, res) => res.json(await Freshness.listFreshnessAsync(db, tenantOf(req), listQuery(req)))));
  router.post("/freshness-definitions", authAsync, canFreshness("create"), wrap(async (req, res) => res.status(201).json(await Freshness.createFreshnessAsync(db, tenantOf(req), req.body || {}, actorOf(req)))));
  const updateFreshness = wrap(async (req, res) => res.json(await Freshness.updateFreshnessAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/freshness-definitions/:ref", authAsync, canFreshness("read"), wrap(async (req, res) => res.json(await Freshness.getFreshnessAsync(db, tenantOf(req), req.params.ref))));
  router.put("/freshness-definitions/:ref", authAsync, canFreshness("update"), updateFreshness);
  router.patch("/freshness-definitions/:ref", authAsync, canFreshness("update"), updateFreshness);
  router.delete("/freshness-definitions/:ref", authAsync, canFreshness("delete"), wrap(async (req, res) => res.json(await Freshness.deleteFreshnessAsync(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.get("/freshness/evaluate", authAsync, canFreshness("read"), wrap(async (req, res) => res.json({ items: await Freshness.evaluateFreshnessAsync(db, tenantOf(req)) })));
  router.post("/freshness/check", authAsync, canFreshness("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitFreshnessJobAsync(db, { tenantId: tenantOf(req), actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));

  // ── Health checks & snapshots ─────────────────────────────────────────────
  router.get("/health-checks", authAsync, canHealth("read"), wrap(async (req, res) => res.json(await Health.listHealthChecksAsync(db, tenantOf(req), listQuery(req)))));
  router.post("/health-checks", authAsync, canHealth("create"), wrap(async (req, res) => res.status(201).json(await Health.createHealthCheckAsync(db, tenantOf(req), req.body || {}, actorOf(req)))));
  const updateHealthCheck = wrap(async (req, res) => res.json(await Health.updateHealthCheckAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/health-checks/:ref", authAsync, canHealth("read"), wrap(async (req, res) => res.json(await Health.getHealthCheckAsync(db, tenantOf(req), req.params.ref))));
  router.put("/health-checks/:ref", authAsync, canHealth("update"), updateHealthCheck);
  router.patch("/health-checks/:ref", authAsync, canHealth("update"), updateHealthCheck);
  router.delete("/health-checks/:ref", authAsync, canHealth("delete"), wrap(async (req, res) => res.json(await Health.deleteHealthCheckAsync(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.get("/health/snapshots", authAsync, canHealth("read"), wrap(async (req, res) => res.json(await Health.listHealthSnapshotsAsync(db, tenantOf(req), listQuery(req)))));
  router.post("/health/check", authAsync, canHealth("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitHealthJobAsync(db, { tenantId: tenantOf(req), actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));

  // ── Alert rules ───────────────────────────────────────────────────────────
  router.get("/alert-rules", authAsync, canAlerts("read"), wrap(async (req, res) => res.json(await Alerts.listAlertRulesAsync(db, tenantOf(req), listQuery(req)))));
  router.post("/alert-rules", authAsync, canAlerts("create"), wrap(async (req, res) => res.status(201).json(await Alerts.createAlertRuleAsync(db, tenantOf(req), req.body || {}, actorOf(req)))));
  const updateAlertRule = wrap(async (req, res) => res.json(await Alerts.updateAlertRuleAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/alert-rules/:ref", authAsync, canAlerts("read"), wrap(async (req, res) => res.json(await Alerts.getAlertRuleAsync(db, tenantOf(req), req.params.ref))));
  router.put("/alert-rules/:ref", authAsync, canAlerts("update"), updateAlertRule);
  router.patch("/alert-rules/:ref", authAsync, canAlerts("update"), updateAlertRule);
  router.delete("/alert-rules/:ref", authAsync, canAlerts("delete"), wrap(async (req, res) => res.json(await Alerts.deleteAlertRuleAsync(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.get("/alert-rules/:ref/versions", authAsync, canAlerts("read"), wrap(async (req, res) => res.json({ items: await Alerts.listAlertRuleVersionsAsync(db, tenantOf(req), req.params.ref) })));

  // ── Alerts ────────────────────────────────────────────────────────────────
  router.get("/alerts", authAsync, canAlerts("read"), wrap(async (req, res) => res.json(await Alerts.listAlertsAsync(db, tenantOf(req), listQuery(req)))));
  router.get("/alerts/summary", authAsync, canAlerts("read"), wrap(async (req, res) => res.json(await Alerts.alertSummaryAsync(db, tenantOf(req)))));
  router.get("/alerts/trend", authAsync, canAlerts("read"), wrap(async (req, res) => res.json(await Alerts.alertTrendAsync(db, tenantOf(req), listQuery(req)))));
  router.get("/alerts/:ref", authAsync, canAlerts("read"), wrap(async (req, res) => res.json(await Alerts.getAlertAsync(db, tenantOf(req), req.params.ref))));
  router.get("/alerts/:ref/events", authAsync, canAlerts("read"), wrap(async (req, res) => res.json({ items: await Alerts.listAlertEventsAsync(db, tenantOf(req), req.params.ref) })));
  router.post("/alerts/:ref/acknowledge", authAsync, canAlerts("execute"), wrap(async (req, res) => res.json(await Alerts.acknowledgeAlertAsync(db, tenantOf(req), req.params.ref, actorOf(req), req.body || {}))));
  router.post("/alerts/:ref/suppress", authAsync, canAlerts("execute"), wrap(async (req, res) => res.json(await Alerts.suppressAlertAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req)))));
  router.post("/alerts/:ref/unsuppress", authAsync, canAlerts("execute"), wrap(async (req, res) => res.json(await Alerts.unsuppressAlertAsync(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.post("/alerts/:ref/resolve", authAsync, canAlerts("execute"), wrap(async (req, res) => res.json(await Alerts.resolveAlertAsync(db, tenantOf(req), req.params.ref, actorOf(req), req.body || {}))));
  router.post("/alerts/:ref/close", authAsync, canAlerts("execute"), wrap(async (req, res) => res.json(await Alerts.closeAlertAsync(db, tenantOf(req), req.params.ref, actorOf(req), req.body || {}))));
  router.post("/alerts/:ref/comments", authAsync, canAlerts("update"), wrap(async (req, res) => res.json({ items: await Alerts.commentAlertAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req)) })));

  // ── Incidents ─────────────────────────────────────────────────────────────
  router.get("/incidents", authAsync, canIncidents("read"), wrap(async (req, res) => res.json(await Incidents.listIncidentsAsync(db, tenantOf(req), listQuery(req)))));
  router.post("/incidents", authAsync, canIncidents("create"), wrap(async (req, res) => res.status(201).json(await Incidents.createIncidentAsync(db, tenantOf(req), req.body || {}, actorOf(req)))));
  router.get("/incidents/summary", authAsync, canIncidents("read"), wrap(async (req, res) => res.json(await Incidents.incidentSummaryAsync(db, tenantOf(req)))));
  const updateIncident = wrap(async (req, res) => res.json(await Incidents.updateIncidentAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/incidents/:ref", authAsync, canIncidents("read"), wrap(async (req, res) => res.json(await Incidents.getIncidentAsync(db, tenantOf(req), req.params.ref))));
  router.put("/incidents/:ref", authAsync, canIncidents("update"), updateIncident);
  router.patch("/incidents/:ref", authAsync, canIncidents("update"), updateIncident);

  // ── SLO / SLA ─────────────────────────────────────────────────────────────
  router.get("/slos", authAsync, canSlo("read"), wrap(async (req, res) => res.json(await Slo.listSlosAsync(db, tenantOf(req), listQuery(req)))));
  router.post("/slos", authAsync, canSlo("create"), wrap(async (req, res) => res.status(201).json(await Slo.createSloAsync(db, tenantOf(req), req.body || {}, actorOf(req)))));
  router.get("/slos/summary", authAsync, canSlo("read"), wrap(async (req, res) => res.json(await Slo.sloSummaryAsync(db, tenantOf(req)))));
  router.post("/slos/evaluate", authAsync, canSlo("execute"), wrap(async (req, res) => res.json(await Slo.evaluateAllSlosAsync(db, tenantOf(req), { actor: actorOf(req) }))));
  const updateSlo = wrap(async (req, res) => res.json(await Slo.updateSloAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/slos/:ref", authAsync, canSlo("read"), wrap(async (req, res) => res.json(await Slo.getSloAsync(db, tenantOf(req), req.params.ref))));
  router.put("/slos/:ref", authAsync, canSlo("update"), updateSlo);
  router.patch("/slos/:ref", authAsync, canSlo("update"), updateSlo);
  router.delete("/slos/:ref", authAsync, canSlo("delete"), wrap(async (req, res) => res.json(await Slo.deleteSloAsync(db, tenantOf(req), req.params.ref, actorOf(req)))));

  // ── Dashboards ────────────────────────────────────────────────────────────
  router.get("/dashboards", authAsync, canDashboards("read"), wrap(async (req, res) => res.json(await Dashboards.listDashboardsAsync(db, tenantOf(req), listQuery(req)))));
  router.post("/dashboards", authAsync, canDashboards("create"), wrap(async (req, res) => res.status(201).json(await Dashboards.createDashboardAsync(db, tenantOf(req), req.body || {}, actorOf(req)))));
  router.get("/dashboards/default", authAsync, canDashboards("read"), wrap(async (req, res) => res.json((await Dashboards.defaultDashboardAsync(db, tenantOf(req))) || { dashboard: null, widgets: [] })));
  router.get("/dashboards/:ref", authAsync, canDashboards("read"), wrap(async (req, res) => res.json(await Dashboards.getDashboardAsync(db, tenantOf(req), req.params.ref))));
  router.get("/dashboards/:ref/render", authAsync, canDashboards("read"), wrap(async (req, res) => res.json(await Dashboards.renderDashboardAsync(db, tenantOf(req), req.params.ref))));
  const updateDashboard = wrap(async (req, res) => res.json(await Dashboards.updateDashboardAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.put("/dashboards/:ref", authAsync, canDashboards("update"), updateDashboard);
  router.patch("/dashboards/:ref", authAsync, canDashboards("update"), updateDashboard);
  router.delete("/dashboards/:ref", authAsync, canDashboards("delete"), wrap(async (req, res) => res.json(await Dashboards.deleteDashboardAsync(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.post("/dashboards/:ref/widgets", authAsync, canDashboards("update"), wrap(async (req, res) => res.status(201).json(await Dashboards.addWidgetAsync(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req)))));
  router.post("/dashboards/:ref/widgets/:widget/reorder", authAsync, canDashboards("update"), wrap(async (req, res) => res.json(await Dashboards.updateWidgetAsync(db, tenantOf(req), req.params.widget, { sequence: req.body?.sequence }, actorOf(req)))));

  // ── Jobs, history, config, search ─────────────────────────────────────────
  router.get("/jobs", authAsync, canJobs("read"), wrap(async (req, res) => res.json(await Jobs.listObservabilityJobsAsync(db, tenantOf(req), listQuery(req)))));
  router.get("/jobs/:ref", authAsync, canJobs("read"), wrap(async (req, res) => res.json((await Jobs.getObservabilityJobAsync(db, tenantOf(req), req.params.ref)) || { not_found: true })));
  router.post("/jobs/maintenance", authAsync, canAdmin("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitMaintenanceJobAsync(db, { tenantId: tenantOf(req), actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/slo", authAsync, canSlo("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitSloJobAsync(db, { tenantId: tenantOf(req), actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));
  router.get("/history", authAsync, canHistory("read"), wrap(async (req, res) => res.json(await History.listHistoryAsync(db, tenantOf(req), listQuery(req)))));
  router.get("/config", authAsync, canAdmin("read"), wrap(async (req, res) => res.json({ config: await Configuration.listConfigAsync(db, tenantOf(req)), retention: await Configuration.listRetentionPoliciesAsync(db, tenantOf(req)) })));
  const setConfig = wrap(async (req, res) => res.json({ key: req.params.key, value: await Configuration.setConfigAsync(db, tenantOf(req), req.params.key, req.body?.value, actorOf(req), req.ip) }));
  router.put("/config/:key", authAsync, canAdmin("update"), setConfig);
  router.patch("/config/:key", authAsync, canAdmin("update"), setConfig);
  router.put("/retention/:tier", authAsync, canAdmin("update"), wrap(async (req, res) => res.json(await Configuration.setRetentionPolicyAsync(db, tenantOf(req), req.params.tier, req.body?.retain_days, actorOf(req)))));

  router.get("/search-meta", authAsync, canSearch("read"), wrap((_req, res) => res.json({ object_types: Constants.SEARCH_OBJECT_TYPES })));
  router.post("/search/reindex", authAsync, canSearch("execute"), wrap((_req, res) => res.json({ registered: Search.registerObservabilitySources() })));
  router.post("/search", authAsync, canSearch("read"), wrap(async (req, res) => {
    const body = req.body || {};
    const input = {
      ...body,
      object_types: body.object_types || body.objectTypes || Constants.SEARCH_OBJECT_TYPES.map((entry) => entry.code),
    };
    return res.json(await searchObjectsAsync(db, input, actorOf(req), { tenantId: tenantOf(req) }));
  }));

  // ── Lifecycle (seed / foundation) ─────────────────────────────────────────
  router.post("/seed", authAsync, canAdmin("execute"), wrap((req, res) => res.json(Seed.ensureObservabilitySeed(db, tenantOf(req)))));

  return router;
}

export default createObservabilityRouter;
