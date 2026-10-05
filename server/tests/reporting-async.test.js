process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import {
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
  Cache,
  Configuration,
  Foundation,
  Jobs,
  ensureReportingFoundation,
} from "../services/reporting/index.js";

// Async parity for the P2 Reporting & Analytics module. The synchronous
// service is the reference; async read twins must return the same data and
// async write twins must mirror the same semantics.

const IP = "127.0.0.1";
const VOLATILE = new Set([
  "created_at",
  "updated_at",
  "generated_at",
  "executed_at",
  "started_at",
  "finished_at",
  "last_run_at",
  "next_run_at",
  "computed_at",
  "refreshed_at",
  "duration_ms",
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

describe("async reporting twins mirror the synchronous service", () => {
  let db;
  let tenant;
  let admin;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    ensureReportingFoundation(db);
  });

  after(() => db?.close());

  test("query engine async twin matches the sync engine", async () => {
    const spec = { entity: "object", group_by: ["object_type"], aggregations: [{ function: "COUNT", attribute: null, alias: "n" }] };
    const asyncResult = await QueryEngine.executeQueryAsync(db, tenant, spec, { actor: admin, ip: IP });
    const syncResult = QueryEngine.executeQuery(db, tenant, spec, { actor: admin, ip: IP });
    assert.equal(asyncResult.total, syncResult.total);
    assert.equal(asyncResult.query_type, syncResult.query_type);
    assert.deepEqual(normalize(asyncResult.rows), normalize(syncResult.rows));
  });

  test("report lifecycle: create, publish, edit and version", async () => {
    const asyncReport = await Reports.createReportAsync(db, tenant, {
      code: "P2_ASYNC_REPORT",
      name: "Async report",
      report_type: "ANALYTICAL",
      definition: { entity: "object", group_by: ["object_type"], aggregations: [{ function: "COUNT", attribute: null, alias: "n" }] },
    }, admin);
    const syncReport = Reports.createReport(db, tenant, { code: "P2_SYNC_REPORT", name: "Sync report", definition: { entity: "object" } }, admin);
    for (const field of ["status", "version", "immutable", "visibility"]) {
      assert.equal(asyncReport[field], syncReport[field], `report field mismatch: ${field}`);
    }

    const published = await Reports.publishReportAsync(db, tenant, asyncReport.id, admin);
    assert.equal(published.status, "ACTIVE");
    assert.equal(published.immutable, true);

    const updated = await Reports.updateReportAsync(db, tenant, asyncReport.id, { name: "Async report v2" }, admin);
    assert.equal(updated.version, 2);
    assert.equal(updated.status, "DRAFT");

    assert.deepEqual(
      normalize(await Reports.listReportVersionsAsync(db, tenant, asyncReport.id)),
      normalize(Reports.listReportVersions(db, tenant, asyncReport.id))
    );
    assert.deepEqual(
      normalize(await Reports.getReportAsync(db, tenant, asyncReport.id)),
      normalize(Reports.getReport(db, tenant, asyncReport.id))
    );
  });

  test("execute report twin records history and uses the cache", async () => {
    const report = await Reports.createReportAsync(db, tenant, { code: "P2_EXEC", name: "Exec", definition: { entity: "object", group_by: ["object_type"], aggregations: [{ function: "COUNT", attribute: null, alias: "n" }] } }, admin);
    await Reports.publishReportAsync(db, tenant, report.id, admin);
    const first = await Reports.executeReportAsync(db, tenant, "P2_EXEC", {}, admin, IP);
    assert.equal(first.query_type, "ANALYTICAL");
    assert.ok(first.total >= 1);
    const second = await Reports.executeReportAsync(db, tenant, "P2_EXEC", {}, admin, IP);
    assert.equal(second.cache_hit, true);

    assert.deepEqual(normalize(await History.listExecutionsAsync(db, tenant, { page_size: 50 })), normalize(History.listExecutions(db, tenant, { page_size: 50 })));
    assert.deepEqual(normalize(await History.executionSummaryAsync(db, tenant)), normalize(History.executionSummary(db, tenant)));
    assert.deepEqual(normalize(await Cache.cacheStatsAsync(db, tenant)), normalize(Cache.cacheStats(db, tenant)));
  });

  test("metric and KPI twins compute the same values", async () => {
    const asyncMetric = await Metrics.createMetricAsync(db, tenant, { code: "P2_METRIC", name: "Objects", entity: "object", aggregation: "COUNT" }, admin);
    const syncMetric = Metrics.createMetric(db, tenant, { code: "P2_METRIC_S", name: "Objects", entity: "object", aggregation: "COUNT" }, admin);
    assert.equal(asyncMetric.status, syncMetric.status);
    await Metrics.setMetricStatusAsync(db, tenant, asyncMetric.id, "ACTIVE", admin);
    const computed = await Metrics.computeMetricAsync(db, tenant, "P2_METRIC", { actor: admin, ip: IP });
    assert.ok(computed.value >= 1);

    const asyncKpi = await Kpis.createKpiAsync(db, tenant, { code: "P2_KPI", name: "Objects", entity: "object", aggregation: "COUNT", target: 1 }, admin);
    await Kpis.setKpiStatusAsync(db, tenant, asyncKpi.id, "ACTIVE", admin);
    const value = await Kpis.getKpiValueAsync(db, tenant, "P2_KPI", { actor: admin, ip: IP });
    assert.ok(value.value >= 1);

    assert.deepEqual(normalize(await Kpis.getKpiAsync(db, tenant, asyncKpi.id)), normalize(Kpis.getKpi(db, tenant, asyncKpi.id)));
    assert.deepEqual(normalize(await Metrics.getMetricAsync(db, tenant, asyncMetric.id)), normalize(Metrics.getMetric(db, tenant, asyncMetric.id)));
  });

  test("dashboard twins build, resolve and reorder the same widgets", async () => {
    const report = await Reports.createReportAsync(db, tenant, { code: "P2_DASH_REPORT", name: "Dash", visibility: "GLOBAL", definition: { entity: "object", group_by: ["object_type"], aggregations: [{ function: "COUNT", attribute: null, alias: "n" }] } }, admin);
    const dashboard = await Dashboards.createDashboardAsync(db, tenant, { code: "P2_DASH", name: "Dash", visibility: "GLOBAL", widgets: [{ widget_type: "REPORT", title: "R", report_id: report.id }] }, admin);
    const withWidgets = await Dashboards.getDashboardWithWidgetsAsync(db, tenant, dashboard.id);
    assert.equal(withWidgets.widgets.length, 1);
    const refreshed = await Dashboards.refreshDashboardAsync(db, tenant, dashboard.id, {}, admin, IP);
    assert.equal(refreshed.widgets[0].source, "REPORT");

    const widget = await Dashboards.addWidgetAsync(db, tenant, dashboard.id, { widget_type: "KPI_CARD", title: "K" }, admin);
    assert.ok(widget.widget_ref.startsWith("WGT-"));
    assert.deepEqual(
      normalize((await Dashboards.listWidgetsAsync(db, tenant, dashboard.id))),
      normalize(Dashboards.listWidgets(db, tenant, dashboard.id))
    );
  });

  test("export twins produce the same file payloads", async () => {
    const report = await Reports.createReportAsync(db, tenant, { code: "P2_EXPORT", name: "Export", definition: { entity: "object", group_by: ["object_type"], aggregations: [{ function: "COUNT", attribute: null, alias: "n" }] } }, admin);
    const csv = await Exports.requestExportAsync(db, tenant, report.id, { format: "CSV" }, admin, IP);
    assert.equal(csv.status, "COMPLETED");
    const file = await Exports.downloadExportAsync(db, tenant, csv.export_ref);
    assert.match(file.content_type, /text\/csv/);
    assert.deepEqual(normalize(await Exports.listExportsAsync(db, tenant, { page_size: 50 })), normalize(Exports.listExports(db, tenant, { page_size: 50 })));
    assert.deepEqual(normalize(await Exports.getExportAsync(db, tenant, csv.export_ref)), normalize(Exports.getExport(db, tenant, csv.export_ref)));
  });

  test("schedule twins run the same target", async () => {
    const report = await Reports.createReportAsync(db, tenant, { code: "P2_SCHED", name: "Sched", definition: { entity: "object" } }, admin);
    const schedule = await Scheduling.createScheduleAsync(db, tenant, { name: "Daily", target_type: "REPORT", report_id: report.id, frequency: "DAILY", format: "CSV" }, admin, IP);
    const run = await Scheduling.runScheduleAsync(db, tenant, schedule.schedule_ref, admin, IP);
    assert.equal(run.target_type, "REPORT");
    assert.ok(run.rows >= 1);
    assert.deepEqual(normalize(await Scheduling.listSchedulesAsync(db, tenant, { page_size: 50 })), normalize(Scheduling.listSchedules(db, tenant, { page_size: 50 })));
  });

  test("BI twins register datasets and expose OData metadata", async () => {
    const connection = await Bi.createBiConnectionAsync(db, tenant, { provider: "GENERIC_ODATA", name: "Feed" }, admin, IP);
    const dataset = await Bi.createBiDatasetAsync(db, tenant, { connection_id: connection.id, name: "Objects", definition: { entity: "object", columns: [{ attribute: "number" }, { attribute: "object_type" }] } }, admin, IP);
    const data = await Bi.getBiDatasetDataAsync(db, tenant, dataset.dataset_ref, {}, admin, IP);
    assert.ok(data.data.total >= 1);
    const metadata = await Bi.datasetODataMetadataAsync(db, tenant, dataset.dataset_ref);
    assert.equal(metadata.columns.length, 2);
    assert.deepEqual(normalize(await Bi.listBiConnectionsAsync(db, tenant, { page_size: 50 })), normalize(Bi.listBiConnections(db, tenant, { page_size: 50 })));
    assert.deepEqual(normalize(await Bi.listBiDatasetsAsync(db, tenant, { page_size: 50 })), normalize(Bi.listBiDatasets(db, tenant, { page_size: 50 })));
  });

  test("read model and configuration twins match", async () => {
    const summary = await ReadModel.refreshReadModelAsync(db, { tenantId: tenant });
    assert.ok(summary.entities >= 9);
    assert.deepEqual(normalize(await ReadModel.readModelStatusAsync(db, tenant)), normalize(ReadModel.readModelStatus(db, tenant)));

    assert.deepEqual(await Configuration.listConfigAsync(db, tenant), Configuration.listConfig(db, tenant));
    await Configuration.setConfigAsync(db, tenant, "max_rows", 1234, admin);
    assert.equal(await Configuration.getConfigAsync(db, tenant, "max_rows"), 1234);
    assert.deepEqual(normalize(await Foundation.reportingHealthAsync(db, tenant)), normalize(Foundation.reportingHealth(db, tenant)));
  });

  test("job submission twins return durable jobs", async () => {
    const asyncJob = await Jobs.submitExecuteJobAsync(db, { tenantId: tenant, reportRef: "P2_EXEC", actor: admin, ip: IP });
    assert.ok(asyncJob && Number.isInteger(Number(asyncJob.id)));
    assert.deepEqual(normalize(await Jobs.listReportingJobsAsync(db, tenant, { page_size: 20 })), normalize(Jobs.listReportingJobs(db, tenant, { page_size: 20 })));
  });

  test("async error parity for missing entities", async () => {
    await assert.rejects(() => Reports.getReportAsync(db, tenant, "NOPE"), /not found/i);
    assert.throws(() => Reports.getReport(db, tenant, "NOPE"), /not found/i);
    await assert.rejects(() => Configuration.setConfigAsync(db, tenant, "unknown_key", 1, admin), /Unknown reporting configuration/i);
    await assert.rejects(() => QueryEngine.executeQueryAsync(db, tenant, { entity: "nope" }, { actor: admin }), /Unknown reporting entity/i);
  });
});
