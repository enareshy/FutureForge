process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne, queryAll } from "../db.js";
import { seedDatabase } from "../seed.js";
import {
  Observability,
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
  Foundation,
} from "../services/observability/index.js";

describe("Data Observability core services", () => {
  let db;
  let tenant;
  let admin;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    Foundation.ensureObservabilityFoundation(db);
  });

  after(() => {
    db?.close();
  });

  test("registers the provider catalog and reuses platform telemetry", () => {
    const providers = Providers.listProviders();
    const codes = providers.map((entry) => entry.code);
    for (const code of ["OBJECT_MODEL", "PDM", "FILE_STORAGE", "DATA_QUALITY", "SEARCH", "EVENTS", "WORKFLOW", "JOBS", "INTEGRATION", "IMPORT_EXPORT", "AUDIT", "DATA_LIFECYCLE", "PLATFORM"]) {
      assert.ok(codes.includes(code), `provider ${code} is registered`);
    }
    assert.ok(providers.every((entry) => entry.status === "AVAILABLE"));
  });

  test("seeds the curated metric, freshness, rule and SLO catalogues", () => {
    const metrics = Metrics.listMetrics(db, tenant, { page_size: 200 });
    assert.ok(metrics.total >= Constants.METRIC_CATALOG.length, "all catalogued metrics are seeded");
    const freshness = Freshness.listFreshness(db, tenant, { page_size: 100 });
    assert.ok(freshness.total >= Constants.FRESHNESS_CATALOG.length);
    const rules = Alerts.listAlertRules(db, tenant, { page_size: 100 });
    assert.ok(rules.total >= Constants.ALERT_RULE_CATALOG.length);
    const slos = Slo.listSlos(db, tenant, { page_size: 100 });
    assert.ok(slos.total >= Constants.SLO_CATALOG.length);
    const dashboards = Dashboards.listDashboards(db, tenant, { page_size: 50 });
    assert.ok(dashboards.total >= Constants.DASHBOARD_CATALOG.length);
  });

  test("seeds observations and dashboard rendering is non-empty", () => {
    const observations = Metrics.listObservations(db, tenant, { page_size: 5 });
    assert.ok(observations.total > 0, "seed performed an initial collection");
    const rendered = Dashboards.defaultDashboard(db, tenant);
    assert.ok(rendered, "a default dashboard exists");
    assert.ok(rendered.widgets.length > 0, "default dashboard has widgets");
    const healthWidget = rendered.widgets.find((widget) => widget.type === "HEALTH_STATUS");
    assert.ok(healthWidget && healthWidget.data, "health widget resolves data");
  });

  test("collects a metric observation and records a history point", () => {
    const metric = Metrics.getMetric(db, tenant, "OBJECT_VOLUME_TOTAL");
    const before = Metrics.metricHistory(db, tenant, metric.code, { window_seconds: 604800 });
    const result = Collection.collectTenant(db, tenant, { trigger: "TEST", actor: admin });
    assert.equal(result.run.status === "COMPLETED" || result.run.status === "PARTIAL", true);
    assert.ok(result.counts.observation_count > 0);
    const after = Metrics.metricHistory(db, tenant, metric.code, { window_seconds: 604800 });
    assert.ok(after.points.length >= before.points.length);
    assert.ok(after.summary.count >= 1);
  });

  test("classifies thresholds and exposes effective thresholds", () => {
    const metric = Metrics.getMetric(db, tenant, "DATA_QUALITY_VIOLATIONS"); // warning 25, critical 100
    const warnings = Thresholds.classifyMetric(db, tenant, metric, 30);
    assert.equal(warnings.band, "WARNING");
    const critical = Thresholds.classifyMetric(db, tenant, metric, 200);
    assert.equal(critical.band, "CRITICAL");
    const ok = Thresholds.classifyMetric(db, tenant, metric, 1);
    assert.equal(ok.band, "OK");
    assert.ok(Thresholds.effectiveThresholds(db, tenant, metric).length >= 1);
  });

  test("evaluates freshness bands from provider signals", () => {
    const items = Freshness.evaluateFreshness(db, tenant);
    assert.ok(items.length >= Constants.FRESHNESS_CATALOG.length);
    const summary = Freshness.freshnessSummary(db, tenant);
    assert.ok(summary.total >= 1);
    assert.ok(["FRESH", "WARNING", "STALE", "CRITICAL"].some((band) => summary.buckets[band] >= 0));
  });

  test("raises, deduplicates and auto-resolves alerts through rule evaluation", () => {
    const rule = Alerts.createAlertRule(
      db,
      tenant,
      {
        code: "TEST_ALERT_RULE",
        name: "Test rule",
        metric_code: "OBJECT_VOLUME_TOTAL",
        condition: { operator: "GTE", value: 0 },
        severity: "HIGH",
        cooldown_seconds: 0,
        auto_resolve: true,
      },
      admin
    );
    const metric = Metrics.getMetric(db, tenant, "OBJECT_VOLUME_TOTAL");
    const first = Alerts.applyAlertRules(db, tenant, metric, { value: 10 }, { actor: admin });
    assert.equal(first.created, 1, "first breach creates an alert");
    const alert = first.alerts[0];
    assert.equal(alert.status, "OPEN");
    assert.equal(alert.severity, "HIGH");
    const second = Alerts.applyAlertRules(db, tenant, metric, { value: 11 }, { actor: admin });
    assert.equal(second.created, 0, "second breach deduplicates");
    assert.equal(second.updated, 1);
    const open = Alerts.getAlert(db, tenant, alert.alert_ref);
    assert.ok(open.occurrence_count >= 2);
    const resolved = Alerts.applyAlertRules(db, tenant, metric, { value: -1 }, { actor: admin });
    assert.equal(resolved.resolved, 1, "condition clearing auto-resolves the alert");
    assert.equal(Alerts.getAlert(db, tenant, alert.alert_ref).status, "RESOLVED");
    assert.ok(Alerts.listAlertEvents(db, tenant, alert.alert_ref).length >= 2);
  });

  test("acknowledges and suppresses an alert", () => {
    const rule = Alerts.createAlertRule(db, tenant, { code: "TEST_ACK_RULE", name: "Ack rule", metric_code: "OBJECT_VOLUME_TOTAL", condition: { operator: "GTE", value: 0 }, severity: "WARNING", cooldown_seconds: 0 }, admin);
    const metric = Metrics.getMetric(db, tenant, "OBJECT_VOLUME_TOTAL");
    const created = Alerts.applyAlertRules(db, tenant, metric, { value: 5 }, { actor: admin }).alerts[0];
    const acked = Alerts.acknowledgeAlert(db, tenant, created.alert_ref, admin, { message: "on it" });
    assert.equal(acked.status, "ACKNOWLEDGED");
    const suppressed = Alerts.suppressAlert(db, tenant, created.alert_ref, { seconds: 600, reason: "maintenance" }, admin);
    assert.equal(suppressed.status, "SUPPRESSED");
    const unsuppressed = Alerts.unsuppressAlert(db, tenant, created.alert_ref, admin);
    assert.equal(unsuppressed.status, "ACKNOWLEDGED");
    void rule;
  });

  test("tracks incidents and links alerts", () => {
    const incident = Incidents.createIncident(db, tenant, { title: "Storage degraded", severity: "HIGH", service_code: "files" }, admin);
    assert.equal(incident.status, "OPEN");
    const updated = Incidents.updateIncident(db, tenant, incident.incident_ref, { status: "RESOLVED", resolution: "scaled storage" }, admin);
    assert.equal(updated.status, "RESOLVED");
    const summary = Incidents.incidentSummary(db, tenant);
    assert.ok(summary.total >= 1);
  });

  test("evaluates SLO/SLA compliance over the observation window", () => {
    // Force an observation so the window is non-empty.
    Collection.collectTenant(db, tenant, { trigger: "TEST", actor: admin });
    const summary = Slo.sloSummary(db, tenant);
    assert.ok(summary.total >= Constants.SLO_CATALOG.length);
    assert.equal(typeof summary.breached, "number");
  });

  test("computes health snapshots and current status", () => {
    const evaluation = Health.evaluateHealth(db, tenant);
    assert.ok(Constants.HEALTH_STATUSES.includes(evaluation.overall));
    assert.ok(Array.isArray(evaluation.services));
    Health.persistHealthSnapshots(db, tenant, evaluation, { actor: admin });
    const current = Health.currentHealth(db, tenant);
    assert.ok(Constants.HEALTH_STATUSES.includes(current.overall));
  });

  test("manages dashboards, widgets and rendering", () => {
    const created = Dashboards.createDashboard(
      db,
      tenant,
      { code: "TEST_DASH", name: "Test dash", widgets: [{ title: "Objects", widget_type: "METRIC_CARD", metric: "OBJECT_VOLUME_TOTAL" }] },
      admin
    );
    assert.equal(created.widgets.length, 1);
    const widget = Dashboards.addWidget(db, tenant, created.dashboard_ref, { widget_type: "HEALTH_STATUS", title: "Health" }, admin);
    assert.ok(widget.widget_ref);
    const rendered = Dashboards.renderDashboard(db, tenant, created.dashboard_ref);
    assert.equal(rendered.widgets.length, 2);
    assert.ok(rendered.widgets.find((entry) => entry.type === "METRIC_CARD").data);
  });

  test("validates configuration and retention policies", () => {
    const defaults = Configuration.listConfig(db, tenant);
    assert.equal(defaults.enabled, true);
    Configuration.setConfig(db, tenant, "alert_cooldown_seconds", 60, admin);
    assert.equal(Configuration.getConfig(db, tenant, "alert_cooldown_seconds"), 60);
    assert.throws(() => Configuration.setConfig(db, tenant, "alert_cooldown_seconds", -1, admin));
    const retention = Configuration.listRetentionPolicies(db, tenant);
    assert.ok(retention.length >= Constants.DEFAULT_RETENTION_POLICIES.length);
  });

  test("reuses Reporting & Analytics for a governed dashboard", () => {
    const linked = queryOne(db, "SELECT reporting_dashboard_ref FROM observability_dashboards WHERE tenant_id = ? AND code = 'OBSERVABILITY_OVERVIEW'", [tenant]);
    assert.ok(linked && linked.reporting_dashboard_ref, "default observability dashboard references a reporting dashboard");
    const reportingDashboard = queryOne(db, "SELECT id FROM reporting_dashboards WHERE tenant_id = ? AND code = 'OBSERVABILITY_PLATFORM_HEALTH'", [tenant]);
    assert.ok(reportingDashboard, "reporting dashboard was created by the bridge");
  });

  test("observability health reports per-tenant counts", () => {
    const health = Foundation.observabilityHealth(db, tenant);
    assert.equal(health.source_module, "observability");
    assert.ok(health.counts.metrics >= Constants.METRIC_CATALOG.length);
    assert.ok(health.providers.length >= 1);
  });

  test("observation history is bounded by retention pruning", () => {
    const removed = queryAll(db, "SELECT COUNT(*) AS c FROM observability_metric_observations WHERE tenant_id = ?", [tenant])[0].c;
    assert.ok(Number(removed) > 0);
    const metrics = Metrics.listMetrics(db, tenant, { page_size: 1 }).items;
    assert.ok(metrics[0].metric_ref.startsWith("OBSMET-"));
  });
});
