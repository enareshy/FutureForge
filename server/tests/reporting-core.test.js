process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne, queryAll } from "../db.js";
import { seedDatabase } from "../seed.js";
import {
  Constants,
  Semantic,
  DataSources,
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
  ensureReportingFoundation,
} from "../services/reporting/index.js";

const IP = "127.0.0.1";

describe("Reporting & Analytics core services", () => {
  let db;
  let tenant;
  let admin;
  let reader;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    reader = queryOne(db, "SELECT id, username FROM users WHERE username = 'j.patel'");
    ensureReportingFoundation(db);
  });

  after(() => {
    db?.close();
  });

  test("registers semantic entities and the data-source catalog", () => {
    const entities = Semantic.listEntities();
    const codes = entities.map((entry) => entry.code);
    for (const code of ["part", "document", "change", "requirement", "supplier", "object", "pdm_item", "bom_component", "workflow_instance"]) {
      assert.ok(codes.includes(code), `semantic entity ${code} is registered`);
    }
    const sources = DataSources.listDataSources();
    assert.equal(sources.items.find((entry) => entry.code === "OBJECT_MODEL").status, "AVAILABLE");
    assert.equal(sources.items.find((entry) => entry.code === "REPORTING_READ_MODEL").status, "AVAILABLE");
    assert.equal(sources.items.find((entry) => entry.code === "DATA_MART").status, "PLANNED");
  });

  test("executes a validated ad-hoc query and rejects unknown entities/attributes", () => {
    const result = QueryEngine.executeQuery(db, tenant, { entity: "object", group_by: ["object_type"], aggregations: [{ function: "COUNT", attribute: null, alias: "n" }] }, { actor: admin, ip: IP });
    assert.ok(result.total >= 1);
    assert.equal(result.query_type, "ANALYTICAL");
    assert.ok(result.rows.every((row) => typeof row.n === "number"));
    assert.throws(() => QueryEngine.executeQuery(db, tenant, { entity: "nope" }, { actor: admin }), /Unknown reporting entity/i);
    assert.throws(() => QueryEngine.normalizeQuery({ entity: "part", columns: [{ attribute: "does_not_exist" }] }), /Unknown attribute/i);
  });

  test("normalizes and validates a calculated-field expression safely", () => {
    const normalized = QueryEngine.normalizeQuery({
      entity: "part",
      group_by: ["status"],
      aggregations: [{ function: "COUNT", attribute: null, alias: "total" }],
      calculated_fields: [{ alias: "share", expression: "total * 2" }],
    });
    assert.equal(normalized.calculated_fields.length, 1);
    assert.throws(() => QueryEngine.normalizeQuery({ entity: "part", calculated_fields: [{ alias: "x", expression: "process.exit(1)" }] }), /Unsupported token|expression/i);  });

  test("creates, versions and publishes a report; edits roll a published report forward", () => {
    const report = Reports.createReport(
      db,
      tenant,
      {
        code: "CORE_REPORT",
        name: "Core report",
        report_type: "ANALYTICAL",
        definition: { entity: "object", group_by: ["object_type"], aggregations: [{ function: "COUNT", attribute: null, alias: "n" }] },
      },
      admin
    );
    assert.equal(report.status, "DRAFT");
    assert.equal(report.version, 1);

    const published = Reports.publishReport(db, tenant, report.id, admin);
    assert.equal(published.status, "ACTIVE");
    assert.equal(published.immutable, true);

    const updated = Reports.updateReport(db, tenant, report.id, { name: "Core report v2" }, admin);
    assert.equal(updated.status, "DRAFT");
    assert.equal(updated.version, 2);
    assert.equal(updated.immutable, false);

    const versions = Reports.listReportVersions(db, tenant, report.id);
    assert.ok(versions.items.length >= 1);
    assert.throws(() => Reports.createReport(db, tenant, { code: "CORE_REPORT", name: "dup", definition: { entity: "object" } }, admin), /already exists/i);
  });

  test("enforces report visibility (private owner-only) in listings", () => {
    const privateReport = Reports.createReport(db, tenant, { code: "PRIVATE_ONLY", name: "Private", visibility: "PRIVATE", definition: { entity: "object" } }, admin);
    const globalReport = Reports.createReport(db, tenant, { code: "GLOBAL_ONE", name: "Global", visibility: "GLOBAL", definition: { entity: "object" } }, admin);
    const adminList = Reports.listReports(db, tenant, { page_size: 200 }, admin).items.map((entry) => entry.code);
    const readerList = Reports.listReports(db, tenant, { page_size: 200 }, reader).items.map((entry) => entry.code);
    assert.ok(adminList.includes(privateReport.code));
    assert.ok(!readerList.includes(privateReport.code));
    assert.ok(readerList.includes(globalReport.code));
  });

  test("executes a report, records execution history and serves it from cache", () => {
    const report = Reports.createReport(
      db,
      tenant,
      { code: "EXEC_REPORT", name: "Exec", definition: { entity: "object", group_by: ["object_type"], aggregations: [{ function: "COUNT", attribute: null, alias: "n" }] } },
      admin
    );
    Reports.publishReport(db, tenant, report.id, admin);
    const first = Reports.executeReport(db, tenant, "EXEC_REPORT", {}, admin, IP);
    assert.equal(first.query_type, "ANALYTICAL");
    assert.ok(first.total >= 1);
    const second = Reports.executeReport(db, tenant, "EXEC_REPORT", {}, admin, IP);
    assert.equal(second.cache_hit, true);
    const executions = History.listExecutions(db, tenant, { page_size: 50 });
    assert.ok(executions.total >= 2);
    assert.ok(History.executionSummary(db, tenant).total >= 2);
    assert.ok(Cache.cacheStats(db, tenant).total >= 1);
  });

  test("computes metrics and KPIs including a formula-based readiness KPI", () => {
    const metric = Metrics.createMetric(db, tenant, { code: "OBJECT_COUNT", name: "Objects", entity: "object", aggregation: "COUNT" }, admin);
    Metrics.setMetricStatus(db, tenant, metric.id, "ACTIVE", admin);
    const computed = Metrics.computeMetric(db, tenant, "OBJECT_COUNT", { actor: admin, ip: IP });
    assert.ok(computed.value >= 1);

    const kpi = Kpis.createKpi(db, tenant, { code: "CORE_OBJECTS", name: "Objects", entity: "object", aggregation: "COUNT", target: 1 }, admin);
    Kpis.setKpiStatus(db, tenant, kpi.id, "ACTIVE", admin);
    const value = Kpis.getKpiValue(db, tenant, "CORE_OBJECTS", { actor: admin, ip: IP });
    assert.ok(value.value >= 1);
    assert.equal(value.status, "OK");

    const readiness = Kpis.getKpiValue(db, tenant, "RELEASE_READINESS", { actor: admin, ip: IP });
    assert.equal(typeof readiness.value, "number");
  });

  test("builds a dashboard, resolves its widgets and supports drill-down configuration", () => {
    const report = Reports.createReport(db, tenant, { code: "DASH_REPORT", name: "Dash", visibility: "GLOBAL", definition: { entity: "object", group_by: ["object_type"], aggregations: [{ function: "COUNT", attribute: null, alias: "n" }] } }, admin);
    const dashboard = Dashboards.createDashboard(
      db,
      tenant,
      {
        code: "CORE_DASH",
        name: "Core dash",
        visibility: "GLOBAL",
        widgets: [{ widget_type: "REPORT", title: "R", report_id: report.id }],
      },
      admin
    );
    const withWidgets = Dashboards.getDashboardWithWidgets(db, tenant, dashboard.id);
    assert.equal(withWidgets.widgets.length, 1);
    const refreshed = Dashboards.refreshDashboard(db, tenant, dashboard.id, {}, admin, IP);
    assert.equal(refreshed.widgets[0].source, "REPORT");
    assert.ok(!refreshed.widgets[0].denied);
    const widget = Dashboards.addWidget(db, tenant, dashboard.id, { widget_type: "KPI_CARD", title: "K", kpi_id: Kpis.getKpi(db, tenant, "TOTAL_OBJECTS").id }, admin);
    assert.ok(widget.widget_ref.startsWith("WGT-"));
    const reordered = Dashboards.reorderWidgets(db, tenant, dashboard.id, [widget.widget_ref, withWidgets.widgets[0].widget_ref], admin);
    assert.equal(reordered.items[0].widget_ref, widget.widget_ref);
  });

  test("exports report results as CSV/JSON and rejects unsupported native formats", () => {
    const report = Reports.createReport(db, tenant, { code: "EXPORT_REPORT", name: "Export", definition: { entity: "object", group_by: ["object_type"], aggregations: [{ function: "COUNT", attribute: null, alias: "n" }] } }, admin);
    const csv = Exports.requestExport(db, tenant, report.id, { format: "CSV" }, admin, IP);
    assert.equal(csv.status, "COMPLETED");
    const file = Exports.downloadExport(db, tenant, csv.export_ref);
    assert.match(file.content_type, /text\/csv/);
    const json = Exports.requestExport(db, tenant, report.id, { format: "JSON" }, admin, IP);
    assert.match(Exports.downloadExport(db, tenant, json.export_ref).content_type, /application\/json/);
    assert.throws(() => Exports.requestExport(db, tenant, report.id, { format: "PDF" }, admin, IP), /not available natively|Unsupported/i);
  });

  test("validates schedule cadence and computes the next run", () => {
    assert.equal(Scheduling.isValidCron("0 2 * * *"), true);
    assert.equal(Scheduling.isValidCron("bad cron"), false);
    const next = Scheduling.computeNextRun({ frequency: "DAILY", status: "ACTIVE" }, new Date("2026-01-01T00:00:00.000Z"));
    assert.ok(next > "2026-01-01T00:00:00.000Z");
    const report = Reports.createReport(db, tenant, { code: "SCHED_REPORT", name: "Sched", definition: { entity: "object" } }, admin);
    const schedule = Scheduling.createSchedule(db, tenant, { name: "Daily", target_type: "REPORT", report_id: report.id, frequency: "DAILY", format: "CSV" }, admin, IP);
    const run = Scheduling.runSchedule(db, tenant, schedule.schedule_ref, admin, IP);
    assert.equal(run.target_type, "REPORT");
    assert.ok(run.rows >= 1);
  });

  test("registers BI connections/datasets, publishes snapshots and exposes OData metadata", () => {
    const connection = Bi.createBiConnection(db, tenant, { provider: "GENERIC_ODATA", name: "Feed" }, admin, IP);
    assert.equal(connection.status, "CONNECTED");
    const dataset = Bi.createBiDataset(db, tenant, { connection_id: connection.id, name: "Objects", definition: { entity: "object", columns: [{ attribute: "number" }, { attribute: "object_type" }] } }, admin, IP);
    const data = Bi.getBiDatasetData(db, tenant, dataset.dataset_ref, {}, admin, IP);
    assert.ok(data.data.total >= 1);
    const metadata = Bi.datasetODataMetadata(db, tenant, dataset.dataset_ref);
    assert.equal(metadata.columns.length, 2);
    const published = Bi.publishDataset(db, tenant, dataset.dataset_ref, {}, admin, IP);
    assert.equal(published.status, "PUBLISHED");
    assert.equal(Bi.biCapabilities().push_supported.length >= 1, true);
  });

  test("refreshes the reporting read model and reports configuration status", () => {
    const summary = ReadModel.refreshReadModel(db, { tenantId: tenant });
    assert.ok(summary.entities >= 9);
    assert.ok(summary.rows >= 1);
    const status = ReadModel.readModelStatus(db, tenant);
    assert.ok(status.entities.length >= 1);
    const readModelReport = Reports.createReport(db, tenant, { code: "RM_REPORT", name: "RM", data_source: "REPORTING_READ_MODEL", definition: { entity: "object", data_source: "REPORTING_READ_MODEL", group_by: ["object_type"], aggregations: [{ function: "COUNT", attribute: null, alias: "n" }] } }, admin);
    const result = Reports.executeReport(db, tenant, readModelReport.id, {}, admin, IP);
    assert.ok(result.total >= 1);
  });

  test("keeps configuration within declared bounds", () => {
    Configuration.setConfig(db, tenant, "max_rows", 1234, admin);
    assert.equal(Configuration.getConfig(db, tenant, "max_rows"), 1234);
    assert.throws(() => Configuration.setConfig(db, tenant, "max_rows", 1, admin), /between/i);
    assert.throws(() => Configuration.setConfig(db, tenant, "unknown_key", 1, admin), /Unknown reporting configuration/i);
    assert.equal(Configuration.listConfig(db, tenant).enable_cache, true);
    const health = Foundation.reportingHealth(db, tenant);
    assert.equal(health.source_module, "reporting");
    assert.ok(health.counts.reports >= 1);
    assert.ok(Constants.REPORTING_RESOURCES.reports.startsWith("iam.reporting"));
  });
});
