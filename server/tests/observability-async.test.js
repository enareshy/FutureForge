import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import {
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
  Foundation,
  Seed,
} from "../services/observability/index.js";

// Async parity for the P2 Data Observability module. The synchronous service is
// the reference; async read twins must return the same data and async write
// twins must mirror the same semantics. Distinct codes are used per layer so
// the two paths never observe each other's writes.

const VOLATILE = new Set([
  "created_at",
  "updated_at",
  "generated_at",
  "evaluated_at",
  "computed_at",
  "age_seconds",
  "age_hours",
  "duration_ms",
  "latency_ms",
  "observed_at",
  "occurred_at",
  "next_run_at",
  "last_run_at",
  "refreshed_at",
  "window_start",
  "window_end",
]);

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (VOLATILE.has(key)) continue;
      out[key] = normalize(entry);
    }
    return out;
  }
  return value;
}

describe("async observability twins mirror the synchronous service", () => {
  let db;
  let tenant;
  let admin;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    Foundation.ensureObservabilityFoundation(db);
    Seed.ensureObservabilitySeed(db, tenant);
  });

  after(() => db?.close());

  test("read twins match: metrics, thresholds, observations, history", async () => {
    assert.deepEqual(normalize(await Metrics.listMetricsAsync(db, tenant, { page_size: 200 })), normalize(Metrics.listMetrics(db, tenant, { page_size: 200 })));
    assert.deepEqual(normalize(await Metrics.listObservationsAsync(db, tenant, { page_size: 25 })), normalize(Metrics.listObservations(db, tenant, { page_size: 25 })));
    assert.deepEqual(normalize(await Thresholds.listThresholdsAsync(db, tenant, { page_size: 100 })), normalize(Thresholds.listThresholds(db, tenant, { page_size: 100 })));
    assert.deepEqual(normalize(await History.listHistoryAsync(db, tenant, { page_size: 50 })), normalize(History.listHistory(db, tenant, { page_size: 50 })));

    const metric = Metrics.getMetric(db, tenant, "OBJECT_VOLUME_TOTAL");
    assert.deepEqual(normalize(await Metrics.getMetricAsync(db, tenant, "OBJECT_VOLUME_TOTAL")), normalize(metric));
    assert.deepEqual(normalize(await Metrics.listMetricVersionsAsync(db, tenant, metric.code)), normalize(Metrics.listMetricVersions(db, tenant, metric.code)));
    assert.deepEqual(normalize(await Metrics.metricHistoryAsync(db, tenant, metric.code, { window_seconds: 604800 })), normalize(Metrics.metricHistory(db, tenant, metric.code, { window_seconds: 604800 })));
  });

  test("read twins match: freshness, health, alerts, incidents, slo", async () => {
    assert.deepEqual(normalize(await Freshness.listAssetsAsync(db, tenant, { page_size: 100 })), normalize(Freshness.listAssets(db, tenant, { page_size: 100 })));
    assert.deepEqual(normalize(await Freshness.listFreshnessAsync(db, tenant, { page_size: 100 })), normalize(Freshness.listFreshness(db, tenant, { page_size: 100 })));
    assert.deepEqual(normalize(await Freshness.freshnessSummaryAsync(db, tenant)), normalize(Freshness.freshnessSummary(db, tenant)));
    assert.deepEqual(normalize(await Health.listHealthChecksAsync(db, tenant, { page_size: 100 })), normalize(Health.listHealthChecks(db, tenant, { page_size: 100 })));
    assert.deepEqual(normalize(await Alerts.listAlertRulesAsync(db, tenant, { page_size: 100 })), normalize(Alerts.listAlertRules(db, tenant, { page_size: 100 })));
    assert.deepEqual(normalize(await Alerts.listAlertsAsync(db, tenant, { page_size: 100 })), normalize(Alerts.listAlerts(db, tenant, { page_size: 100 })));
    assert.deepEqual(normalize(await Incidents.listIncidentsAsync(db, tenant, { page_size: 100 })), normalize(Incidents.listIncidents(db, tenant, { page_size: 100 })));
    assert.deepEqual(normalize(await Slo.listSlosAsync(db, tenant, { page_size: 100 })), normalize(Slo.listSlos(db, tenant, { page_size: 100 })));
    assert.deepEqual(normalize(await Slo.sloSummaryAsync(db, tenant)), normalize(Slo.sloSummary(db, tenant)));
    assert.deepEqual(normalize(await Incidents.incidentSummaryAsync(db, tenant)), normalize(Incidents.incidentSummary(db, tenant)));
  });

  test("read twins match: dashboards, collection, config, jobs, foundation", async () => {
    assert.deepEqual(normalize(await Dashboards.listDashboardsAsync(db, tenant, { page_size: 50 })), normalize(Dashboards.listDashboards(db, tenant, { page_size: 50 })));
    assert.deepEqual(normalize(await Dashboards.defaultDashboardAsync(db, tenant)), normalize(Dashboards.defaultDashboard(db, tenant)));
    assert.deepEqual(normalize(await Collection.listRunsAsync(db, tenant, { page_size: 25 })), normalize(Collection.listRuns(db, tenant, { page_size: 25 })));
    assert.deepEqual(normalize(await Collection.categorySummaryAsync(db, tenant, ["QUALITY"])), normalize(Collection.categorySummary(db, tenant, ["QUALITY"])));
    assert.deepEqual(normalize(await Collection.failureSummaryAsync(db, tenant)), normalize(Collection.failureSummary(db, tenant)));
    assert.deepEqual(normalize(await Configuration.listConfigAsync(db, tenant)), normalize(Configuration.listConfig(db, tenant)));
    assert.deepEqual(normalize(await Configuration.listRetentionPoliciesAsync(db, tenant)), normalize(Configuration.listRetentionPolicies(db, tenant)));
    assert.deepEqual(normalize(await Jobs.listObservabilityJobsAsync(db, tenant, { page_size: 25 })), normalize(Jobs.listObservabilityJobs(db, tenant, { page_size: 25 })));
    assert.deepEqual(normalize(await Foundation.observabilityHealthAsync(db, tenant)), normalize(Foundation.observabilityHealth(db, tenant)));
  });

  test("write twins: metric, threshold, observation, history", async () => {
    const asyncMetric = await Metrics.createMetricAsync(db, tenant, { code: "ASYNC_METRIC", name: "Async metric", category: "QUALITY" }, admin);
    const syncMetric = Metrics.createMetric(db, tenant, { code: "SYNC_METRIC", name: "Sync metric", category: "QUALITY" }, admin);
    assert.equal(asyncMetric.code, "ASYNC_METRIC");
    assert.equal(syncMetric.code, "SYNC_METRIC");
    for (const field of ["category", "calculation", "aggregation", "unit", "direction", "provider_code", "status", "frequency_seconds", "owner_user_id", "created_by"]) {
      assert.deepEqual(asyncMetric[field], syncMetric[field], `metric field mismatch: ${field}`);
    }

    const asyncThreshold = await Thresholds.createThresholdAsync(db, tenant, { metric_code: "ASYNC_METRIC", classification: "WARNING", operator: "GTE", value: 42 }, admin);
    assert.equal(asyncThreshold.metric_code, "ASYNC_METRIC");
    const effective = await Thresholds.effectiveThresholdsAsync(db, tenant, asyncMetric);
    assert.ok(Array.isArray(effective));

    const observed = await Metrics.recordObservationAsync(db, tenant, asyncMetric, { value: 7, dimensions: {} });
    assert.ok(observed);

    const history = await History.listHistoryAsync(db, tenant, { page_size: 5 });
    assert.ok(history.total >= 1);
  });

  test("write twins: asset, freshness, health check, alert rule, incident, slo", async () => {
    const asset = await Freshness.createAssetAsync(db, tenant, { code: "ASYNC_ASSET", name: "Async asset", asset_type: "TABLE" }, admin);
    assert.equal(asset.code, "ASYNC_ASSET");
    const freshness = await Freshness.createFreshnessAsync(db, tenant, { code: "ASYNC_FRESH", name: "Async freshness", asset_code: "ASYNC_ASSET", expected_frequency_minutes: 60 }, admin);
    assert.ok(freshness);

    const check = await Health.createHealthCheckAsync(db, tenant, { code: "ASYNC_HEALTH", name: "Async health", check_type: "CUSTOM" }, admin);
    assert.equal(check.code, "ASYNC_HEALTH");

    const rule = await Alerts.createAlertRuleAsync(db, tenant, { code: "ASYNC_RULE", name: "Async rule", metric_code: "ASYNC_METRIC", condition: { operator: "GTE", value: 1 }, severity: "HIGH" }, admin);
    assert.equal(rule.code, "ASYNC_RULE");

    const incident = await Incidents.createIncidentAsync(db, tenant, { title: "Async incident", severity: "HIGH" }, admin);
    assert.equal(incident.title, "Async incident");

    const slo = await Slo.createSloAsync(db, tenant, { code: "ASYNC_SLO", name: "Async SLO", kind: "SLO", metric_code: "ASYNC_METRIC", target: 99.9, unit: "PERCENT" }, admin);
    assert.equal(slo.code, "ASYNC_SLO");
    const evaluated = await Slo.evaluateSloAsync(db, tenant, slo, admin);
    assert.ok(evaluated);
  });

  test("write twins: dashboard, widget, config, collection", async () => {
    const dashboard = await Dashboards.createDashboardAsync(db, tenant, { code: "ASYNC_DASH", name: "Async dashboard" }, admin);
    assert.equal(dashboard.code, "ASYNC_DASH");
    const widget = await Dashboards.addWidgetAsync(db, tenant, dashboard.dashboard_ref || dashboard.code, { widget_type: "METRIC", title: "Async widget", metric_code: "ASYNC_METRIC" }, admin);
    assert.ok(widget);
    const rendered = await Dashboards.renderDashboardAsync(db, tenant, dashboard.dashboard_ref || dashboard.code);
    assert.ok(rendered);

    const latest = await Configuration.setConfigAsync(db, tenant, "alert_cooldown_seconds", 600, admin, "127.0.0.1");
    assert.ok(latest);
    const read = await Configuration.getConfigAsync(db, tenant, "alert_cooldown_seconds");
    assert.ok(read);

    const collected = await Collection.collectTenantAsync(db, tenant, { trigger: "TEST", actor: admin });
    assert.ok(["COMPLETED", "PARTIAL"].includes(collected.run.status));
    assert.ok(collected.counts.observation_count > 0);
  });

  test("async error parity for missing entities", async () => {
    await assert.rejects(() => Metrics.getMetricAsync(db, tenant, "DOES_NOT_EXIST"), /not found/i);
    assert.throws(() => Metrics.getMetric(db, tenant, "DOES_NOT_EXIST"), /not found/i);
    await assert.rejects(() => Alerts.getAlertAsync(db, tenant, "999999"), /not found/i);
    await assert.rejects(() => Slo.getSloAsync(db, tenant, "DOES_NOT_EXIST"), /not found/i);
  });

  test("provider catalog and async provider lookups", async () => {
    const providers = await Providers.listProvidersAsync();
    assert.ok(providers.some((entry) => entry.code === "OBJECT_MODEL"));
    const provider = await Providers.getProviderAsync("OBJECT_MODEL");
    assert.equal(provider.code, "OBJECT_MODEL");
  });
});
