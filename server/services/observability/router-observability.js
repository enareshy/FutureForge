// REST router for the P2 Data Observability capability (Module 21). Built as a
// factory so it reuses the application's auth, authorization and error
// middleware. Mounted at /api/observability and /api/v1/observability.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization.
import { searchObjects } from "../search/v1.js";
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

export function createObservabilityRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const actorOf = (req) => req.actor;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";

  const canOverview = (a) => can(R.overview, a);
  const canHealth = (a) => can(R.health, a);
  const canMetrics = (a) => can(R.metrics, a);
  const canVolume = (a) => can(R.volume, a);
  const canFreshness = (a) => can(R.freshness, a);
  const canQuality = (a) => can(R.quality, a);
  const canPipelines = (a) => can(R.pipelines, a);
  const canFailures = (a) => can(R.failures, a);
  const canAlerts = (a) => can(R.alerts, a);
  const canIncidents = (a) => can(R.incidents, a);
  const canSlo = (a) => can(R.slo, a);
  const canDashboards = (a) => can(R.dashboards, a);
  const canProviders = (a) => can(R.providers, a);
  const canJobs = (a) => can(R.jobs, a);
  const canHistory = (a) => can(R.history, a);
  const canSearch = (a) => can(R.search, a);
  const canAdmin = (a) => can(R.admin, a);

  const listQuery = (req) => ({ ...req.query });

  // ── Meta, health, observability ───────────────────────────────────────────
  router.get(
    "/meta",
    auth,
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

  router.get("/health-meta", auth, canHealth("read"), wrap((req, res) => res.json({ ...Foundation.observabilityHealth(db, tenantOf(req)) })));
  router.get("/providers", auth, canProviders("read"), wrap((_req, res) => res.json({ items: Providers.listProviders(), total: Providers.listProviders().length })));
  router.get("/providers/:code", auth, canProviders("read"), wrap((req, res) => res.json(Providers.getProvider(req.params.code) || {})));

  // ── Overview & category read models ───────────────────────────────────────
  router.get("/overview", auth, canOverview("read"), wrap((req, res) => res.json(Collection.observabilityOverview(db, tenantOf(req)))));
  router.get("/health", auth, canHealth("read"), wrap((req, res) => res.json({ ...Health.evaluateHealth(db, tenantOf(req)), current: Health.currentHealth(db, tenantOf(req)) })));
  router.get("/health/trend", auth, canHealth("read"), wrap((req, res) => res.json(Health.healthTrend(db, tenantOf(req), listQuery(req)))));
  router.get("/metrics", auth, canMetrics("read"), wrap((req, res) => res.json(Metrics.listMetrics(db, tenantOf(req), listQuery(req)))));
  router.get("/data-volume", auth, canVolume("read"), wrap((req, res) => res.json(Collection.categorySummary(db, tenantOf(req), ["DATA_VOLUME", "FRESHNESS"]))));
  router.get("/quality", auth, canQuality("read"), wrap((req, res) => res.json(Collection.categorySummary(db, tenantOf(req), ["QUALITY"]))));
  router.get("/freshness", auth, canFreshness("read"), wrap((req, res) => res.json({ summary: Freshness.freshnessSummary(db, tenantOf(req)), definitions: Freshness.listFreshness(db, tenantOf(req), listQuery(req)) })));
  router.get("/pipelines", auth, canPipelines("read"), wrap((req, res) => res.json(Collection.throughputSummary(db, tenantOf(req)))));
  router.get("/failures", auth, canFailures("read"), wrap((req, res) => res.json(Collection.failureSummary(db, tenantOf(req)))));
  router.get("/runs", auth, canMetrics("read"), wrap((req, res) => res.json(Collection.listRuns(db, tenantOf(req), listQuery(req)))));
  router.get("/runs/:ref", auth, canMetrics("read"), wrap((req, res) => res.json(Collection.getRun(db, tenantOf(req), req.params.ref) || { not_found: true })));

  // ── Collection ────────────────────────────────────────────────────────────
  router.post("/collect", auth, canMetrics("execute"), wrap((req, res) => {
    const body = req.body || {};
    if (body.async) {
      return res.status(202).json(Jobs.submitCollectJob(db, { tenantId: tenantOf(req), actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req), trigger: body.trigger || "API" }));
    }
    return res.json(Collection.collectTenant(db, tenantOf(req), { trigger: body.trigger || "API", actor: actorOf(req) }));
  }));
  router.post("/collect/all", auth, canAdmin("execute"), wrap((req, res) => res.json(Collection.collectAllTenants(db, { trigger: "API", actor: actorOf(req) }))));

  // ── Metric definitions ────────────────────────────────────────────────────
  router.post("/metric-definitions", auth, canMetrics("create"), wrap((req, res) => res.status(201).json(Metrics.createMetric(db, tenantOf(req), req.body || {}, actorOf(req)))));
  const updateMetric = wrap((req, res) => res.json(Metrics.updateMetric(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/metric-definitions/:ref", auth, canMetrics("read"), wrap((req, res) => res.json(Metrics.getMetric(db, tenantOf(req), req.params.ref))));
  router.put("/metric-definitions/:ref", auth, canMetrics("update"), updateMetric);
  router.patch("/metric-definitions/:ref", auth, canMetrics("update"), updateMetric);
  router.post("/metric-definitions/:ref/status", auth, canMetrics("update"), wrap((req, res) => res.json(Metrics.setMetricStatus(db, tenantOf(req), req.params.ref, req.body?.status, actorOf(req)))));
  router.delete("/metric-definitions/:ref", auth, canMetrics("delete"), wrap((req, res) => res.json(Metrics.deleteMetric(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.get("/metric-definitions/:ref/versions", auth, canMetrics("read"), wrap((req, res) => res.json({ items: Metrics.listMetricVersions(db, tenantOf(req), req.params.ref) })));

  // Metric detail aliases (§ REST: /metrics/{id}, /metrics/{id}/history)
  const getMetric = wrap((req, res) => res.json(Metrics.getMetric(db, tenantOf(req), req.params.ref)));
  router.get("/metrics/:ref", auth, canMetrics("read"), getMetric);
  router.get("/metrics/:ref/history", auth, canMetrics("read"), wrap((req, res) => res.json(Metrics.metricHistory(db, tenantOf(req), req.params.ref, listQuery(req)))));
  router.get("/metrics/:ref/observations", auth, canMetrics("read"), wrap((req, res) => res.json(Metrics.listObservations(db, tenantOf(req), { ...listQuery(req), metric_code: req.params.ref }))));
  router.post("/metrics/:ref/observations", auth, canMetrics("create"), wrap((req, res) => {
    const metric = Metrics.getMetric(db, tenantOf(req), req.params.ref);
    const id = Metrics.recordObservation(db, tenantOf(req), metric, { value: req.body?.value, dimensions: req.body?.dimensions || {}, providerCode: req.body?.provider_code, observedAt: req.body?.observed_at });
    return res.status(201).json({ id, metric_code: metric.code, value: req.body?.value });
  }));

  // ── Thresholds ────────────────────────────────────────────────────────────
  router.get("/thresholds", auth, canMetrics("read"), wrap((req, res) => res.json(Thresholds.listThresholds(db, tenantOf(req), listQuery(req)))));
  router.post("/thresholds", auth, canMetrics("create"), wrap((req, res) => res.status(201).json(Thresholds.createThreshold(db, tenantOf(req), req.body || {}, actorOf(req)))));
  const updateThreshold = wrap((req, res) => res.json(Thresholds.updateThreshold(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/thresholds/:ref", auth, canMetrics("read"), wrap((req, res) => res.json(Thresholds.getThreshold(db, tenantOf(req), req.params.ref))));
  router.put("/thresholds/:ref", auth, canMetrics("update"), updateThreshold);
  router.patch("/thresholds/:ref", auth, canMetrics("update"), updateThreshold);
  router.delete("/thresholds/:ref", auth, canMetrics("delete"), wrap((req, res) => res.json(Thresholds.deleteThreshold(db, tenantOf(req), req.params.ref, actorOf(req)))));

  // ── Data assets & freshness ───────────────────────────────────────────────
  router.get("/assets", auth, canFreshness("read"), wrap((req, res) => res.json(Freshness.listAssets(db, tenantOf(req), listQuery(req)))));
  router.post("/assets", auth, canFreshness("create"), wrap((req, res) => res.status(201).json(Freshness.createAsset(db, tenantOf(req), req.body || {}, actorOf(req)))));
  router.get("/assets/:ref", auth, canFreshness("read"), wrap((req, res) => res.json(Freshness.getAsset(db, tenantOf(req), req.params.ref))));
  router.get("/freshness-definitions", auth, canFreshness("read"), wrap((req, res) => res.json(Freshness.listFreshness(db, tenantOf(req), listQuery(req)))));
  router.post("/freshness-definitions", auth, canFreshness("create"), wrap((req, res) => res.status(201).json(Freshness.createFreshness(db, tenantOf(req), req.body || {}, actorOf(req)))));
  const updateFreshness = wrap((req, res) => res.json(Freshness.updateFreshness(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/freshness-definitions/:ref", auth, canFreshness("read"), wrap((req, res) => res.json(Freshness.getFreshness(db, tenantOf(req), req.params.ref))));
  router.put("/freshness-definitions/:ref", auth, canFreshness("update"), updateFreshness);
  router.patch("/freshness-definitions/:ref", auth, canFreshness("update"), updateFreshness);
  router.delete("/freshness-definitions/:ref", auth, canFreshness("delete"), wrap((req, res) => res.json(Freshness.deleteFreshness(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.get("/freshness/evaluate", auth, canFreshness("read"), wrap((req, res) => res.json({ items: Freshness.evaluateFreshness(db, tenantOf(req)) })));
  router.post("/freshness/check", auth, canFreshness("execute"), wrap((req, res) => res.status(202).json(Jobs.submitFreshnessJob(db, { tenantId: tenantOf(req), actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));

  // ── Health checks & snapshots ─────────────────────────────────────────────
  router.get("/health-checks", auth, canHealth("read"), wrap((req, res) => res.json(Health.listHealthChecks(db, tenantOf(req), listQuery(req)))));
  router.post("/health-checks", auth, canHealth("create"), wrap((req, res) => res.status(201).json(Health.createHealthCheck(db, tenantOf(req), req.body || {}, actorOf(req)))));
  const updateHealthCheck = wrap((req, res) => res.json(Health.updateHealthCheck(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/health-checks/:ref", auth, canHealth("read"), wrap((req, res) => res.json(Health.getHealthCheck(db, tenantOf(req), req.params.ref))));
  router.put("/health-checks/:ref", auth, canHealth("update"), updateHealthCheck);
  router.patch("/health-checks/:ref", auth, canHealth("update"), updateHealthCheck);
  router.delete("/health-checks/:ref", auth, canHealth("delete"), wrap((req, res) => res.json(Health.deleteHealthCheck(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.get("/health/snapshots", auth, canHealth("read"), wrap((req, res) => res.json(Health.listHealthSnapshots(db, tenantOf(req), listQuery(req)))));
  router.post("/health/check", auth, canHealth("execute"), wrap((req, res) => res.status(202).json(Jobs.submitHealthJob(db, { tenantId: tenantOf(req), actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));

  // ── Alert rules ───────────────────────────────────────────────────────────
  router.get("/alert-rules", auth, canAlerts("read"), wrap((req, res) => res.json(Alerts.listAlertRules(db, tenantOf(req), listQuery(req)))));
  router.post("/alert-rules", auth, canAlerts("create"), wrap((req, res) => res.status(201).json(Alerts.createAlertRule(db, tenantOf(req), req.body || {}, actorOf(req)))));
  const updateAlertRule = wrap((req, res) => res.json(Alerts.updateAlertRule(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/alert-rules/:ref", auth, canAlerts("read"), wrap((req, res) => res.json(Alerts.getAlertRule(db, tenantOf(req), req.params.ref))));
  router.put("/alert-rules/:ref", auth, canAlerts("update"), updateAlertRule);
  router.patch("/alert-rules/:ref", auth, canAlerts("update"), updateAlertRule);
  router.delete("/alert-rules/:ref", auth, canAlerts("delete"), wrap((req, res) => res.json(Alerts.deleteAlertRule(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.get("/alert-rules/:ref/versions", auth, canAlerts("read"), wrap((req, res) => res.json({ items: Alerts.listAlertRuleVersions(db, tenantOf(req), req.params.ref) })));

  // ── Alerts ────────────────────────────────────────────────────────────────
  router.get("/alerts", auth, canAlerts("read"), wrap((req, res) => res.json(Alerts.listAlerts(db, tenantOf(req), listQuery(req)))));
  router.get("/alerts/summary", auth, canAlerts("read"), wrap((req, res) => res.json(Alerts.alertSummary(db, tenantOf(req)))));
  router.get("/alerts/trend", auth, canAlerts("read"), wrap((req, res) => res.json(Alerts.alertTrend(db, tenantOf(req), listQuery(req)))));
  router.get("/alerts/:ref", auth, canAlerts("read"), wrap((req, res) => res.json(Alerts.getAlert(db, tenantOf(req), req.params.ref))));
  router.get("/alerts/:ref/events", auth, canAlerts("read"), wrap((req, res) => res.json({ items: Alerts.listAlertEvents(db, tenantOf(req), req.params.ref) })));
  router.post("/alerts/:ref/acknowledge", auth, canAlerts("execute"), wrap((req, res) => res.json(Alerts.acknowledgeAlert(db, tenantOf(req), req.params.ref, actorOf(req), req.body || {}))));
  router.post("/alerts/:ref/suppress", auth, canAlerts("execute"), wrap((req, res) => res.json(Alerts.suppressAlert(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req)))));
  router.post("/alerts/:ref/unsuppress", auth, canAlerts("execute"), wrap((req, res) => res.json(Alerts.unsuppressAlert(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.post("/alerts/:ref/resolve", auth, canAlerts("execute"), wrap((req, res) => res.json(Alerts.resolveAlert(db, tenantOf(req), req.params.ref, actorOf(req), req.body || {}))));
  router.post("/alerts/:ref/close", auth, canAlerts("execute"), wrap((req, res) => res.json(Alerts.closeAlert(db, tenantOf(req), req.params.ref, actorOf(req), req.body || {}))));
  router.post("/alerts/:ref/comments", auth, canAlerts("update"), wrap((req, res) => res.json({ items: Alerts.commentAlert(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req)) })));

  // ── Incidents ─────────────────────────────────────────────────────────────
  router.get("/incidents", auth, canIncidents("read"), wrap((req, res) => res.json(Incidents.listIncidents(db, tenantOf(req), listQuery(req)))));
  router.post("/incidents", auth, canIncidents("create"), wrap((req, res) => res.status(201).json(Incidents.createIncident(db, tenantOf(req), req.body || {}, actorOf(req)))));
  router.get("/incidents/summary", auth, canIncidents("read"), wrap((req, res) => res.json(Incidents.incidentSummary(db, tenantOf(req)))));
  const updateIncident = wrap((req, res) => res.json(Incidents.updateIncident(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/incidents/:ref", auth, canIncidents("read"), wrap((req, res) => res.json(Incidents.getIncident(db, tenantOf(req), req.params.ref))));
  router.put("/incidents/:ref", auth, canIncidents("update"), updateIncident);
  router.patch("/incidents/:ref", auth, canIncidents("update"), updateIncident);

  // ── SLO / SLA ─────────────────────────────────────────────────────────────
  router.get("/slos", auth, canSlo("read"), wrap((req, res) => res.json(Slo.listSlos(db, tenantOf(req), listQuery(req)))));
  router.post("/slos", auth, canSlo("create"), wrap((req, res) => res.status(201).json(Slo.createSlo(db, tenantOf(req), req.body || {}, actorOf(req)))));
  router.get("/slos/summary", auth, canSlo("read"), wrap((req, res) => res.json(Slo.sloSummary(db, tenantOf(req)))));
  router.post("/slos/evaluate", auth, canSlo("execute"), wrap((req, res) => res.json(Slo.evaluateAllSlos(db, tenantOf(req), { actor: actorOf(req) }))));
  const updateSlo = wrap((req, res) => res.json(Slo.updateSlo(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.get("/slos/:ref", auth, canSlo("read"), wrap((req, res) => res.json(Slo.getSlo(db, tenantOf(req), req.params.ref))));
  router.put("/slos/:ref", auth, canSlo("update"), updateSlo);
  router.patch("/slos/:ref", auth, canSlo("update"), updateSlo);
  router.delete("/slos/:ref", auth, canSlo("delete"), wrap((req, res) => res.json(Slo.deleteSlo(db, tenantOf(req), req.params.ref, actorOf(req)))));

  // ── Dashboards ────────────────────────────────────────────────────────────
  router.get("/dashboards", auth, canDashboards("read"), wrap((req, res) => res.json(Dashboards.listDashboards(db, tenantOf(req), listQuery(req)))));
  router.post("/dashboards", auth, canDashboards("create"), wrap((req, res) => res.status(201).json(Dashboards.createDashboard(db, tenantOf(req), req.body || {}, actorOf(req)))));
  router.get("/dashboards/default", auth, canDashboards("read"), wrap((req, res) => res.json(Dashboards.defaultDashboard(db, tenantOf(req)) || { dashboard: null, widgets: [] })));
  router.get("/dashboards/:ref", auth, canDashboards("read"), wrap((req, res) => res.json(Dashboards.getDashboard(db, tenantOf(req), req.params.ref))));
  router.get("/dashboards/:ref/render", auth, canDashboards("read"), wrap((req, res) => res.json(Dashboards.renderDashboard(db, tenantOf(req), req.params.ref))));
  const updateDashboard = wrap((req, res) => res.json(Dashboards.updateDashboard(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req))));
  router.put("/dashboards/:ref", auth, canDashboards("update"), updateDashboard);
  router.patch("/dashboards/:ref", auth, canDashboards("update"), updateDashboard);
  router.delete("/dashboards/:ref", auth, canDashboards("delete"), wrap((req, res) => res.json(Dashboards.deleteDashboard(db, tenantOf(req), req.params.ref, actorOf(req)))));
  router.post("/dashboards/:ref/widgets", auth, canDashboards("update"), wrap((req, res) => res.status(201).json(Dashboards.addWidget(db, tenantOf(req), req.params.ref, req.body || {}, actorOf(req)))));
  router.post("/dashboards/:ref/widgets/:widget/reorder", auth, canDashboards("update"), wrap((req, res) => res.json(Dashboards.updateWidget(db, tenantOf(req), req.params.widget, { sequence: req.body?.sequence }, actorOf(req)))));

  // ── Jobs, history, config, search ─────────────────────────────────────────
  router.get("/jobs", auth, canJobs("read"), wrap((req, res) => res.json(Jobs.listObservabilityJobs(db, tenantOf(req), listQuery(req)))));
  router.get("/jobs/:ref", auth, canJobs("read"), wrap((req, res) => res.json(Jobs.getObservabilityJob(db, tenantOf(req), req.params.ref) || { not_found: true })));
  router.post("/jobs/maintenance", auth, canAdmin("execute"), wrap((req, res) => res.status(202).json(Jobs.submitMaintenanceJob(db, { tenantId: tenantOf(req), actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/slo", auth, canSlo("execute"), wrap((req, res) => res.status(202).json(Jobs.submitSloJob(db, { tenantId: tenantOf(req), actor: actorOf(req), ip: req.ip, idempotencyKey: idem(req) }))));
  router.get("/history", auth, canHistory("read"), wrap((req, res) => res.json(History.listHistory(db, tenantOf(req), listQuery(req)))));
  router.get("/config", auth, canAdmin("read"), wrap((req, res) => res.json({ config: Configuration.listConfig(db, tenantOf(req)), retention: Configuration.listRetentionPolicies(db, tenantOf(req)) })));
  const setConfig = wrap((req, res) => res.json({ key: req.params.key, value: Configuration.setConfig(db, tenantOf(req), req.params.key, req.body?.value, actorOf(req), req.ip) }));
  router.put("/config/:key", auth, canAdmin("update"), setConfig);
  router.patch("/config/:key", auth, canAdmin("update"), setConfig);
  router.put("/retention/:tier", auth, canAdmin("update"), wrap((req, res) => res.json(Configuration.setRetentionPolicy(db, tenantOf(req), req.params.tier, req.body?.retain_days, actorOf(req)))));

  router.get("/search-meta", auth, canSearch("read"), wrap((_req, res) => res.json({ object_types: Constants.SEARCH_OBJECT_TYPES })));
  router.post("/search/reindex", auth, canSearch("execute"), wrap((_req, res) => res.json({ registered: Search.registerObservabilitySources() })));
  router.post("/search", auth, canSearch("read"), wrap((req, res) => {
    const body = req.body || {};
    const input = {
      ...body,
      object_types: body.object_types || body.objectTypes || Constants.SEARCH_OBJECT_TYPES.map((entry) => entry.code),
    };
    return res.json(searchObjects(db, input, actorOf(req), { tenantId: tenantOf(req) }));
  }));

  // ── Lifecycle (seed / foundation) ─────────────────────────────────────────
  router.post("/seed", auth, canAdmin("execute"), wrap((req, res) => res.json(Seed.ensureObservabilitySeed(db, tenantOf(req)))));

  return router;
}

export default createObservabilityRouter;
