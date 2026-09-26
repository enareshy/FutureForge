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

describe("Data Observability REST APIs", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let readerToken;

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
    const res = await request(port, "GET", "/api/v1/observability/meta");
    assert.equal(res.status, 401);
  });

  test("serves the capability metadata and provider catalogue", async () => {
    const res = await request(port, "GET", "/api/v1/observability/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "observability");
    assert.ok(res.body.capabilities.providers.length >= 13);
    assert.ok(res.body.capabilities.event_types.includes("AlertCreated"));
    assert.equal(res.body.capabilities.health_statuses.includes("DEGRADED"), true);
  });

  test("denies a reader without administrative privileges on config", async () => {
    const res = await request(port, "GET", "/api/v1/observability/config", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("allows a reader on read-only observability endpoints", async () => {
    const res = await request(port, "GET", "/api/v1/observability/overview", { token: readerToken });
    assert.equal(res.status, 200);
    const health = await request(port, "GET", "/api/v1/observability/health", { token: readerToken });
    assert.equal(health.status, 200);
  });

  test("lists providers and rejects unknown ones", async () => {
    const list = await request(port, "GET", "/api/v1/observability/providers", { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.items.find((entry) => entry.code === "DATA_QUALITY"));
    const missing = await request(port, "GET", "/api/v1/observability/providers/NOPE", { token: adminToken });
    assert.equal(missing.status, 200);
    assert.deepEqual(missing.body, {});
  });

  test("lists the seeded metric catalogue with definitions and observations", async () => {
    const list = await request(port, "GET", "/api/v1/observability/metrics?page_size=200", { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.total >= 20);
    const metric = list.body.items.find((entry) => entry.code === "OBJECT_VOLUME_TOTAL");
    assert.ok(metric);
    const detail = await request(port, "GET", `/api/v1/observability/metrics/${metric.metric_ref}`, { token: adminToken });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.code, "OBJECT_VOLUME_TOTAL");
    const history = await request(port, "GET", `/api/v1/observability/metrics/${metric.metric_ref}/history`, { token: adminToken });
    assert.equal(history.status, 200);
    assert.ok(Array.isArray(history.body.points));
  });

  test("creates, updates and archives a metric definition", async () => {
    const create = await request(port, "POST", "/api/v1/observability/metric-definitions", {
      token: adminToken,
      body: {
        code: "API_TEST_METRIC",
        name: "API test metric",
        provider_code: "OBJECT_MODEL",
        calculation: "COUNT",
        unit: "COUNT",
        category: "DATA_VOLUME",
      },
    });
    assert.equal(create.status, 201);
    assert.ok(create.body.metric_ref.startsWith("OBSMET-"));
    const ref = create.body.metric_ref;

    const updated = await request(port, "PATCH", `/api/v1/observability/metric-definitions/${ref}`, {
      token: adminToken,
      body: { name: "API test metric v2", warning_threshold: 10, critical_threshold: 20 },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, "API test metric v2");
    assert.equal(updated.body.version, 2);

    const versions = await request(port, "GET", `/api/v1/observability/metric-definitions/${ref}/versions`, { token: adminToken });
    assert.equal(versions.status, 200);
    assert.ok(versions.body.items.length >= 1);

    const archived = await request(port, "DELETE", `/api/v1/observability/metric-definitions/${ref}`, { token: adminToken });
    assert.equal(archived.status, 200);
    assert.equal(archived.body.archived, true);
  });

  test("validates metric input and returns structured errors", async () => {
    const bad = await request(port, "POST", "/api/v1/observability/metric-definitions", {
      token: adminToken,
      body: { code: "BAD", name: "Bad", provider_code: "NOT_A_PROVIDER" },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "OBSERVABILITY_INVALID_METRIC");

    const conflict = await request(port, "POST", "/api/v1/observability/metric-definitions", {
      token: adminToken,
      body: { code: "OBJECT_VOLUME_TOTAL", name: "Dup" },
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "OBSERVABILITY_METRIC_CONFLICT");

    const missing = await request(port, "GET", "/api/v1/observability/metrics/NOPE", { token: adminToken });
    assert.equal(missing.status, 404);
  });

  test("runs a synchronous collection and exposes observations", async () => {
    const collect = await request(port, "POST", "/api/v1/observability/collect", { token: adminToken, body: { trigger: "TEST" } });
    assert.equal(collect.status, 200);
    assert.ok(collect.body.run.run_ref.startsWith("OBSRUN-"));
    assert.ok(collect.body.counts.observation_count > 0);
    const runs = await request(port, "GET", "/api/v1/observability/runs", { token: adminToken });
    assert.equal(runs.status, 200);
    assert.ok(runs.body.items.length >= 1);
  });

  test("submits asynchronous collection and retrieval jobs", async () => {
    const async = await request(port, "POST", "/api/v1/observability/collect", { token: adminToken, body: { async: true } });
    assert.equal(async.status, 202);
    assert.ok(async.body.observability_job.job_ref.startsWith("OBSJOB-"));
    const jobs = await request(port, "GET", "/api/v1/observability/jobs", { token: adminToken });
    assert.equal(jobs.status, 200);
    assert.ok(jobs.body.items.length >= 1);
  });

  test("exposes freshness evaluation, health and failure read models", async () => {
    const freshness = await request(port, "GET", "/api/v1/observability/freshness/evaluate", { token: adminToken });
    assert.equal(freshness.status, 200);
    assert.ok(freshness.body.items.length >= 1);
    const pipelines = await request(port, "GET", "/api/v1/observability/pipelines", { token: adminToken });
    assert.equal(pipelines.status, 200);
    const failures = await request(port, "GET", "/api/v1/observability/failures", { token: adminToken });
    assert.equal(failures.status, 200);
    const health = await request(port, "GET", "/api/v1/observability/health/trend", { token: adminToken });
    assert.equal(health.status, 200);
  });

  test("manages alert rules and the alert lifecycle", async () => {
    const rule = await request(port, "POST", "/api/v1/observability/alert-rules", {
      token: adminToken,
      body: {
        code: "API_ALERT_RULE",
        name: "API alert rule",
        metric_code: "OBJECT_VOLUME_TOTAL",
        condition: { operator: "GTE", value: 0 },
        severity: "HIGH",
        cooldown_seconds: 0,
      },
    });
    assert.equal(rule.status, 201);
    assert.ok(rule.body.rule_ref.startsWith("OBSRUL-"));

    // Trigger the rule via collection (OBJECT_VOLUME_TOTAL >= 0 always breaches).
    const collect = await request(port, "POST", "/api/v1/observability/collect", { token: adminToken, body: { trigger: "API" } });
    assert.ok(collect.body.counts.alerts_created >= 1);
    const alerts = await request(port, "GET", "/api/v1/observability/alerts?status=OPEN", { token: adminToken });
    assert.equal(alerts.status, 200);
    const alert = alerts.body.items.find((entry) => entry.rule_code === "API_ALERT_RULE");
    assert.ok(alert, "an alert was raised for the rule");

    const acked = await request(port, "POST", `/api/v1/observability/alerts/${alert.alert_ref}/acknowledge`, { token: readerToken, body: { message: "ack" } });
    assert.equal(acked.status, 200);
    assert.equal(acked.body.status, "ACKNOWLEDGED");

    const suppressed = await request(port, "POST", `/api/v1/observability/alerts/${alert.alert_ref}/suppress`, { token: adminToken, body: { seconds: 300, reason: "test" } });
    assert.equal(suppressed.body.status, "SUPPRESSED");

    const resolved = await request(port, "POST", `/api/v1/observability/alerts/${alert.alert_ref}/resolve`, { token: adminToken, body: { message: "done" } });
    assert.equal(resolved.body.status, "RESOLVED");

    const events = await request(port, "GET", `/api/v1/observability/alerts/${alert.alert_ref}/events`, { token: adminToken });
    assert.ok(events.body.items.length >= 3);

    const summary = await request(port, "GET", "/api/v1/observability/alerts/summary", { token: adminToken });
    assert.equal(summary.status, 200);
  });

  test("tracks incidents and evaluates SLOs", async () => {
    const incident = await request(port, "POST", "/api/v1/observability/incidents", {
      token: adminToken,
      body: { title: "API incident", severity: "HIGH" },
    });
    assert.equal(incident.status, 201);
    assert.ok(incident.body.incident_ref.startsWith("OBSINC-"));
    const updated = await request(port, "PATCH", `/api/v1/observability/incidents/${incident.body.incident_ref}`, {
      token: adminToken,
      body: { status: "RESOLVED", resolution: "fixed" },
    });
    assert.equal(updated.body.status, "RESOLVED");

    const summary = await request(port, "GET", "/api/v1/observability/slos/summary", { token: adminToken });
    assert.equal(summary.status, 200);
    const evaluate = await request(port, "POST", "/api/v1/observability/slos/evaluate", { token: adminToken });
    assert.equal(evaluate.status, 200);
  });

  test("renders the default dashboard and manages widgets", async () => {
    const rendered = await request(port, "GET", "/api/v1/observability/dashboards/default", { token: adminToken });
    assert.equal(rendered.status, 200);
    assert.ok(rendered.body.widgets.length > 0);

    const create = await request(port, "POST", "/api/v1/observability/dashboards", {
      token: adminToken,
      body: { code: "API_DASH", name: "API dash", widgets: [{ title: "Objects", widget_type: "METRIC_CARD", metric: "OBJECT_VOLUME_TOTAL" }] },
    });
    assert.equal(create.status, 201);
    const widget = await request(port, "POST", `/api/v1/observability/dashboards/${create.body.dashboard_ref}/widgets`, {
      token: adminToken,
      body: { widget_type: "HEALTH_STATUS", title: "Health" },
    });
    assert.equal(widget.status, 201);
    assert.ok(widget.body.widget_ref.startsWith("OBSWGT-"));
    const render = await request(port, "GET", `/api/v1/observability/dashboards/${create.body.dashboard_ref}/render`, { token: adminToken });
    assert.equal(render.body.widgets.length, 2);
  });

  test("manages configuration and retention", async () => {
    const config = await request(port, "GET", "/api/v1/observability/config", { token: adminToken });
    assert.equal(config.status, 200);
    assert.equal(config.body.config.enabled, true);
    const set = await request(port, "PUT", "/api/v1/observability/config/alert_cooldown_seconds", { token: adminToken, body: { value: 120 } });
    assert.equal(set.status, 200);
    const invalid = await request(port, "PUT", "/api/v1/observability/config/alert_cooldown_seconds", { token: adminToken, body: { value: -5 } });
    assert.equal(invalid.status, 400);
    const retention = await request(port, "PUT", "/api/v1/observability/retention/HOT", { token: adminToken, body: { retain_days: 45 } });
    assert.equal(retention.status, 200);
  });

  test("searches observability objects via the shared search engine", async () => {
    const meta = await request(port, "GET", "/api/v1/observability/search-meta", { token: adminToken });
    assert.equal(meta.status, 200);
    assert.ok(meta.body.object_types.find((entry) => entry.code === "observability_metric"));
    const reindex = await request(port, "POST", "/api/v1/observability/search/reindex", { token: adminToken });
    assert.equal(reindex.status, 200);
    const search = await request(port, "POST", "/api/v1/observability/search", {
      token: adminToken,
      body: { query: "OBJECT_VOLUME", object_types: ["observability_metric"] },
    });
    assert.equal(search.status, 200);
    assert.ok(Array.isArray(search.body.results));
  });

  test("exposes history and per-tenant operability health", async () => {
    const history = await request(port, "GET", "/api/v1/observability/history", { token: adminToken });
    assert.equal(history.status, 200);
    assert.ok(history.body.items.length >= 1);
    const health = await request(port, "GET", "/api/v1/observability/health-meta", { token: adminToken });
    assert.equal(health.status, 200);
    assert.equal(health.body.source_module, "observability");
  });
});
