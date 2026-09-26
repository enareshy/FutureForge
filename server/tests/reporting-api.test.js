process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function request(port, method, path, { token, body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload !== null ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(headers || {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          resolve({ status: res.statusCode, body: parsed, text, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const REPORT_DEFINITION = {
  entity: "object",
  group_by: ["object_type"],
  aggregations: [{ function: "COUNT", attribute: null, alias: "n" }],
};

describe("Reporting & Analytics REST APIs", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let readerToken;
  let createdReportRef;

  before(async () => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    const started = await listen(createApp(db));
    server = started.server;
    port = started.port;
    adminToken = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
    readerToken = (await request(port, "POST", "/api/auth/login", { body: { username: "j.patel", password: "HelixUser!42" } })).body.token;
  });

  after(() => {
    server?.close();
    db?.close();
  });

  test("requires authentication", async () => {
    const res = await request(port, "GET", "/api/v1/reporting/meta");
    assert.equal(res.status, 401);
  });

  test("denies a reader without Reporting & Analytics privileges", async () => {
    const res = await request(port, "GET", "/api/v1/reporting/meta", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the capability vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/reporting/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "reporting");
    assert.ok(res.body.capabilities.report_types.includes("ANALYTICAL"));
    assert.ok(res.body.capabilities.semantic_entities.some((entry) => entry.code === "object"));
    assert.ok(res.body.capabilities.data_sources.some((entry) => entry.code === "OBJECT_MODEL" && entry.status === "AVAILABLE"));
    assert.ok(res.body.capabilities.kpi_catalog.includes("RELEASE_READINESS"));
    assert.ok(res.body.capabilities.native_export_formats.includes("CSV"));
  });

  test("serves health, metrics and observability", async () => {
    for (const path of ["/api/v1/reporting/health", "/api/v1/reporting/metrics", "/api/v1/reporting/observability"]) {
      const res = await request(port, "GET", path, { token: adminToken });
      assert.equal(res.status, 200, path);
    }
  });

  test("exposes the semantic layer and data sources", async () => {
    const entities = await request(port, "GET", "/api/v1/reporting/semantic/entities", { token: adminToken });
    assert.equal(entities.status, 200);
    assert.ok(entities.body.items.length >= 9);
    const entity = await request(port, "GET", "/api/v1/reporting/semantic/entities/object", { token: adminToken });
    assert.equal(entity.status, 200);
    const sources = await request(port, "GET", "/api/v1/reporting/data-sources", { token: adminToken });
    assert.equal(sources.status, 200);
    assert.equal(sources.body.items.find((entry) => entry.code === "REPORTING_READ_MODEL").status, "AVAILABLE");
  });

  test("validates and executes an ad-hoc query", async () => {
    const validated = await request(port, "POST", "/api/v1/reporting/query/validate", { token: adminToken, body: { query: REPORT_DEFINITION } });
    assert.equal(validated.status, 200);
    const executed = await request(port, "POST", "/api/v1/reporting/query/execute", { token: adminToken, body: { query: REPORT_DEFINITION } });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.query_type, "ANALYTICAL");
    assert.ok(executed.body.total >= 1);
    const bad = await request(port, "POST", "/api/v1/reporting/query/execute", { token: adminToken, body: { query: { entity: "nope" } } });
    assert.equal(bad.status, 400);
  });

  test("lists the seeded demo report and dashboard", async () => {
    const reports = await request(port, "GET", "/api/v1/reporting/reports?page_size=100", { token: adminToken });
    assert.equal(reports.status, 200);
    assert.ok(reports.body.items.some((entry) => entry.code === "OBJECTS_BY_TYPE"));
    const dashboards = await request(port, "GET", "/api/v1/reporting/dashboards?page_size=100", { token: adminToken });
    assert.equal(dashboards.status, 200);
    assert.ok(dashboards.body.items.some((entry) => entry.code === "OPERATIONS_OVERVIEW"));
  });

  test("creates, publishes, versions and executes a report", async () => {
    const created = await request(port, "POST", "/api/v1/reporting/reports", {
      token: adminToken,
      body: { code: "API_REPORT", name: "API report", definition: REPORT_DEFINITION },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "DRAFT");
    createdReportRef = created.body.report_ref;
    const published = await request(port, "POST", `/api/v1/reporting/reports/${createdReportRef}/publish`, { token: adminToken });
    assert.equal(published.status, 200);
    assert.equal(published.body.status, "ACTIVE");
    const updated = await request(port, "PATCH", `/api/v1/reporting/reports/${createdReportRef}`, { token: adminToken, body: { name: "API report v2" } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.version, 2);
    assert.equal(updated.body.status, "DRAFT");
    const versions = await request(port, "GET", `/api/v1/reporting/reports/${createdReportRef}/versions`, { token: adminToken });
    assert.equal(versions.status, 200);
    assert.ok(versions.body.items.length >= 1);
    const executed = await request(port, "POST", `/api/v1/reporting/reports/${createdReportRef}/execute`, { token: adminToken, body: {} });
    assert.equal(executed.status, 200);
    assert.ok(executed.body.total >= 1);
  });

  test("executes the seeded cross-domain report by code", async () => {
    const res = await request(port, "POST", "/api/v1/reporting/reports/OBJECTS_BY_TYPE/execute", { token: adminToken, body: {} });
    assert.equal(res.status, 200);
    assert.ok(res.body.total >= 1);
  });

  test("returns KPI values and evaluates a KPI", async () => {
    const value = await request(port, "GET", "/api/v1/reporting/kpis/TOTAL_OBJECTS/value", { token: adminToken });
    assert.equal(value.status, 200);
    assert.ok(value.body.value >= 1);
    const evaluate = await request(port, "POST", "/api/v1/reporting/kpis/RELEASE_READINESS/evaluate", { token: adminToken, body: {} });
    assert.equal(evaluate.status, 200);
    assert.equal(typeof evaluate.body.value, "number");
  });

  test("computes a metric definition", async () => {
    const created = await request(port, "POST", "/api/v1/reporting/metric-definitions", {
      token: adminToken,
      body: { code: "API_METRIC", name: "API metric", entity: "object", aggregation: "COUNT" },
    });
    assert.equal(created.status, 201);
    const activated = await request(port, "POST", `/api/v1/reporting/metric-definitions/${created.body.metric_ref}/status`, { token: adminToken, body: { status: "ACTIVE" } });
    assert.equal(activated.status, 200);
    const computed = await request(port, "POST", `/api/v1/reporting/metric-definitions/${created.body.metric_ref}/compute`, { token: adminToken, body: {} });
    assert.equal(computed.status, 200);
    assert.ok(computed.body.value >= 1);
  });

  test("refreshes the seeded dashboard and drills down", async () => {
    const refreshed = await request(port, "POST", "/api/v1/reporting/dashboards/OPERATIONS_OVERVIEW/refresh", { token: adminToken, body: {} });
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.body.widgets.length >= 1);
    assert.ok(refreshed.body.widgets.some((widget) => widget.source === "REPORT"));
    const widget = await request(port, "POST", "/api/v1/reporting/dashboards/OPERATIONS_OVERVIEW/widgets", {
      token: adminToken,
      body: { widget_type: "REPORT", title: "Drill", report_id: "OBJECTS_BY_TYPE", config: { drill_down: { parameter: "object_type" } } },
    });
    assert.equal(widget.status, 201);
    const drill = await request(port, "POST", `/api/v1/reporting/widgets/${widget.body.widget_ref}/drill-down`, { token: adminToken, body: { value: "product" } });
    assert.equal(drill.status, 200);
  });

  test("creates and downloads an export", async () => {
    const created = await request(port, "POST", `/api/v1/reporting/reports/${createdReportRef}/export`, { token: adminToken, body: { format: "CSV" } });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "COMPLETED");
    const download = await request(port, "GET", `/api/v1/reporting/exports/${created.body.export_ref}/download`, { token: adminToken });
    assert.equal(download.status, 200);
    assert.match(download.headers["content-type"], /text\/csv/);
    assert.ok(download.text.length > 0);
    const list = await request(port, "GET", "/api/v1/reporting/exports", { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.total >= 1);
    const pdf = await request(port, "POST", `/api/v1/reporting/reports/${createdReportRef}/export`, { token: adminToken, body: { format: "PDF" } });
    assert.ok(pdf.status >= 400);
  });

  test("manages schedules and runs one synchronously", async () => {
    const created = await request(port, "POST", "/api/v1/reporting/schedules", {
      token: adminToken,
      body: { name: "Daily API", target_type: "REPORT", report_code: "OBJECTS_BY_TYPE", frequency: "DAILY", format: "CSV" },
    });
    assert.equal(created.status, 201);
    const run = await request(port, "POST", `/api/v1/reporting/schedules/${created.body.schedule_ref}/run`, { token: adminToken });
    assert.equal(run.status, 200);
    assert.equal(run.body.target_type, "REPORT");
    const due = await request(port, "GET", "/api/v1/reporting/schedules/due", { token: adminToken });
    assert.equal(due.status, 200);
  });

  test("registers BI connections/datasets and publishes a snapshot", async () => {
    const capabilities = await request(port, "GET", "/api/v1/reporting/bi/capabilities", { token: adminToken });
    assert.equal(capabilities.status, 200);
    const connection = await request(port, "POST", "/api/v1/reporting/bi/connections", { token: adminToken, body: { provider: "GENERIC_ODATA", name: "API feed" } });
    assert.equal(connection.status, 201);
    const dataset = await request(port, "POST", "/api/v1/reporting/bi/datasets", {
      token: adminToken,
      body: { connection_id: connection.body.id, name: "API dataset", definition: REPORT_DEFINITION },
    });
    assert.equal(dataset.status, 201);
    const data = await request(port, "GET", `/api/v1/reporting/bi/datasets/${dataset.body.dataset_ref}/data`, { token: adminToken });
    assert.equal(data.status, 200);
    assert.ok(data.body.data.total >= 1);
    const metadata = await request(port, "GET", `/api/v1/reporting/bi/datasets/${dataset.body.dataset_ref}/metadata`, { token: adminToken });
    assert.equal(metadata.status, 200);
    const published = await request(port, "POST", `/api/v1/reporting/bi/datasets/${dataset.body.dataset_ref}/publish`, { token: adminToken, body: {} });
    assert.equal(published.status, 200);
    assert.equal(published.body.status, "PUBLISHED");
  });

  test("submits reporting background jobs", async () => {
    const report = await request(port, "POST", "/api/v1/reporting/jobs/execute", { token: adminToken, headers: { "Idempotency-Key": "api-exec-1" }, body: { report_code: "OBJECTS_BY_TYPE" } });
    assert.equal(report.status, 202);
    assert.ok(report.body.job_ref);
    const kpi = await request(port, "POST", "/api/v1/reporting/jobs/kpi", { token: adminToken, body: { kpi_code: "TOTAL_OBJECTS" } });
    assert.equal(kpi.status, 202);
    const list = await request(port, "GET", "/api/v1/reporting/jobs", { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.total >= 2);
  });

  test("exposes execution history and the read model", async () => {
    const executions = await request(port, "GET", "/api/v1/reporting/executions", { token: adminToken });
    assert.equal(executions.status, 200);
    assert.ok(executions.body.total >= 1);
    const history = await request(port, "GET", "/api/v1/reporting/history", { token: adminToken });
    assert.equal(history.status, 200);
    const summary = await request(port, "GET", "/api/v1/reporting/executions/summary", { token: adminToken });
    assert.equal(summary.status, 200);
    const readModel = await request(port, "GET", "/api/v1/reporting/read-model/status", { token: adminToken });
    assert.equal(readModel.status, 200);
  });

  test("reads and updates configuration within bounds", async () => {
    const config = await request(port, "GET", "/api/v1/reporting/config", { token: adminToken });
    assert.equal(config.status, 200);
    const updated = await request(port, "PUT", "/api/v1/reporting/config/max_rows", { token: adminToken, body: { value: 900 } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.value, 900);
    const invalid = await request(port, "PUT", "/api/v1/reporting/config/max_rows", { token: adminToken, body: { value: 1 } });
    assert.equal(invalid.status, 400);
    const unknown = await request(port, "PUT", "/api/v1/reporting/config/not_a_key", { token: adminToken, body: { value: 1 } });
    assert.equal(unknown.status, 400);
  });

  test("exposes search metadata and seeds foundation assets", async () => {
    const searchMeta = await request(port, "GET", "/api/v1/reporting/search-meta", { token: adminToken });
    assert.equal(searchMeta.status, 200);
    assert.ok(searchMeta.body.object_types.some((entry) => entry.code === "reporting_report"));
    const seed = await request(port, "POST", "/api/v1/reporting/seed", { token: adminToken });
    assert.equal(seed.status, 200);
  });
});
