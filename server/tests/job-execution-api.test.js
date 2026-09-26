import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import * as jobExecution from "../services/job-execution.js";

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function request(port, method, path, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let parsed = data;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("job execution engine REST APIs", () => {
  let port;
  let server;
  let db;
  let adminToken;
  let userToken;

  before(async () => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    jobExecution.registerDemoHandlers();
    const started = await listen(createApp(db));
    server = started.server;
    port = started.port;

    const adminLogin = await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } });
    assert.equal(adminLogin.status, 200);
    adminToken = adminLogin.body.token;

    const userLogin = await request(port, "POST", "/api/auth/login", { body: { username: "j.patel", password: "HelixUser!42" } });
    assert.equal(userLogin.status, 200);
    userToken = userLogin.body.token;
  });

  after(() => {
    jobExecution.clearHandlers();
    server?.close();
    db?.close();
  });

  test("requires authentication", async () => {
    assert.equal((await request(port, "GET", "/api/job-queues")).status, 401);
    assert.equal((await request(port, "GET", "/api/schedules")).status, 401);
    assert.equal((await request(port, "GET", "/api/job-execution/metrics")).status, 401);
  });

  test("exposes engine metadata", async () => {
    const meta = await request(port, "GET", "/api/job-queues/meta", { token: adminToken });
    assert.equal(meta.status, 200);
    assert.deepEqual(meta.body.logical_queues, jobExecution.LOGICAL_QUEUES);
    assert.ok(meta.body.retry_strategies.includes("exponential"));
    assert.ok(meta.body.schedule_types.includes("cron"));
    assert.ok(meta.body.error_categories.includes("business_validation"));
    assert.ok(Array.isArray(meta.body.handlers));
  });

  test("lists and inspects queues with health", async () => {
    const list = await request(port, "GET", "/api/job-queues?pageSize=100", { token: adminToken });
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 9);
    const codes = list.body.items.map((queue) => queue.code);
    for (const code of jobExecution.LOGICAL_QUEUES) assert.ok(codes.includes(code));

    const one = await request(port, "GET", "/api/job-queues/HIGH_PRIORITY", { token: adminToken });
    assert.equal(one.status, 200);
    assert.equal(one.body.code, "HIGH_PRIORITY");

    const health = await request(port, "GET", "/api/job-queues/HIGH_PRIORITY/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.equal(health.body.queue.code, "HIGH_PRIORITY");
    assert.ok(["healthy", "saturated", "rate_limited", "degraded", "paused", "disabled"].includes(health.body.status));
  });

  test("administers queues with RBAC", async () => {
    const created = await request(port, "POST", "/api/job-queues", {
      token: adminToken,
      body: { code: "API_QUEUE", name: "API queue", priority: 88, max_concurrency: 2, retry_strategy: "fixed", retry_delay_seconds: 5 },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "API_QUEUE");

    const invalid = await request(port, "POST", "/api/job-queues", { token: adminToken, body: { code: "bad code" } });
    assert.equal(invalid.status, 400);

    const updated = await request(port, "PUT", "/api/job-queues/API_QUEUE", { token: adminToken, body: { name: "API queue v2", max_concurrency: 4 } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, "API queue v2");
    assert.equal(updated.body.max_concurrency, 4);

    const paused = await request(port, "POST", "/api/job-queues/API_QUEUE/status", { token: adminToken, body: { paused: true } });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.paused, true);

    const denied = await request(port, "POST", "/api/job-queues", { token: userToken, body: { code: "NOPE_QUEUE" } });
    assert.equal(denied.status, 403);
  });

  test("administers schedules and runs them on demand", async () => {
    const seeded = await request(port, "GET", "/api/schedules?pageSize=100", { token: adminToken });
    assert.equal(seeded.status, 200);
    assert.ok(seeded.body.total >= 1);

    const created = await request(port, "POST", "/api/schedules", {
      token: adminToken,
      body: { code: "API_CRON", name: "API cron", job_type_code: "REPORT_GENERATION", queue: "REPORTING", schedule_type: "cron", cron_expression: "0 4 * * *", timezone: "UTC" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "API_CRON");
    assert.ok(created.body.next_run_at);

    const bad = await request(port, "POST", "/api/schedules", {
      token: adminToken,
      body: { code: "API_BAD", job_type_code: "REPORT_GENERATION", schedule_type: "cron" },
    });
    assert.equal(bad.status, 400);

    const one = await request(port, "GET", `/api/schedules/${created.body.id}`, { token: adminToken });
    assert.equal(one.status, 200);
    assert.equal(one.body.code, "API_CRON");

    const updated = await request(port, "PUT", `/api/schedules/${created.body.id}`, { token: adminToken, body: { name: "API cron v2", max_retries: 2 } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, "API cron v2");
    assert.equal(updated.body.max_retries, 2);

    const disabled = await request(port, "POST", `/api/schedules/${created.body.id}/disable`, { token: adminToken });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.enabled, false);
    assert.equal(disabled.body.status, "disabled");

    const enabled = await request(port, "POST", `/api/schedules/${created.body.id}/enable`, { token: adminToken });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.enabled, true);

    const runNow = await request(port, "POST", `/api/schedules/${created.body.id}/run-now`, { token: adminToken });
    assert.equal(runNow.status, 202);
    assert.equal(runNow.body.job.status, "queued");
    assert.equal(runNow.body.schedule.execution_count, 1);

    const runs = await request(port, "GET", `/api/schedules/${created.body.id}/runs`, { token: adminToken });
    assert.equal(runs.status, 200);
    assert.ok(runs.body.items.length >= 1);

    const denied = await request(port, "POST", "/api/schedules", { token: userToken, body: { code: "NOPE_SCHED", job_type_code: "REPORT_GENERATION" } });
    assert.equal(denied.status, 403);
  });

  test("exposes execution status, metrics, workers and handlers", async () => {
    const status = await request(port, "GET", "/api/job-execution/status", { token: adminToken });
    assert.equal(status.status, 200);
    assert.ok(Array.isArray(status.body.queues));
    assert.equal(typeof status.body.online_workers, "number");

    const metrics = await request(port, "GET", "/api/job-execution/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.queue_count >= 9);
    assert.ok(metrics.body.totals);
    assert.ok(Array.isArray(metrics.body.queues));

    const workers = await request(port, "GET", "/api/job-execution/workers", { token: adminToken });
    assert.equal(workers.status, 200);
    assert.ok(Array.isArray(workers.body.items));

    const handlers = await request(port, "GET", "/api/job-execution/handlers", { token: adminToken });
    assert.equal(handlers.status, 200);
    assert.ok(handlers.body.items.some((handler) => handler.code === "JOBS.DEMO"));

    const audit = await request(port, "GET", "/api/job-execution/audit", { token: adminToken });
    assert.equal(audit.status, 200);
    assert.ok(audit.body.items.length >= 1);
  });

  test("executes a submitted job through the engine API", async () => {
    const created = await request(port, "POST", "/api/jobs", { token: adminToken, body: { job_type_code: "DATA_SYNC", name: "API execute", queue: "INTEGRATION" } });
    assert.equal(created.status, 201);

    const executed = await request(port, "POST", `/api/job-execution/jobs/${created.body.id}/execute`, { token: adminToken });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.status, "completed");

    const job = await request(port, "GET", `/api/jobs/${created.body.id}`, { token: adminToken });
    assert.equal(job.body.status, "completed");
    assert.equal(job.body.progress, 100);
    assert.equal(job.body.retry_count, 0);
  });

  test("lands permanent failures on the dead-letter queue and supports retry", async () => {
    const created = await request(port, "POST", "/api/jobs", {
      token: adminToken,
      body: { job_type_code: "BULK_IMPORT", name: "API dead letter", queue: "IMPORT", input: { fail: { category: "business_validation", message: "invalid rows" } } },
    });
    assert.equal(created.status, 201);

    const executed = await request(port, "POST", `/api/job-execution/jobs/${created.body.id}/execute`, { token: adminToken });
    assert.equal(executed.status, 200);
    assert.equal(executed.body.status, "failed");

    const dead = await request(port, "GET", "/api/job-execution/dead-letter?pageSize=100", { token: adminToken });
    assert.equal(dead.status, 200);
    const letter = dead.body.items.find((item) => item.job_id === created.body.id);
    assert.ok(letter);
    assert.equal(letter.category, "business_validation");

    const requeued = await request(port, "POST", `/api/job-execution/dead-letter/${letter.id}/retry`, { token: adminToken, body: { note: "fixed" } });
    assert.equal(requeued.status, 200);
    assert.equal(requeued.body.requeued, true);
    assert.equal(requeued.body.dead_letter.status, "requeued");

    const job = await request(port, "GET", `/api/jobs/${created.body.id}`, { token: adminToken });
    assert.equal(job.body.status, "queued");
  });

  test("ticks the engine and runs maintenance", async () => {
    await request(port, "POST", "/api/jobs", { token: adminToken, body: { job_type_code: "REPORT_GENERATION", name: "Tick job", queue: "DEFAULT" } });
    const tick = await request(port, "POST", "/api/job-execution/tick", { token: adminToken, body: { run: true, limit: 1, queues: ["DEFAULT"] } });
    assert.equal(tick.status, 200);
    assert.ok(tick.body.maintenance);
    assert.ok(tick.body.processed);
    assert.equal(typeof tick.body.processed.claimed, "number");

    const maintenance = await request(port, "POST", "/api/job-execution/maintenance", { token: adminToken });
    assert.equal(maintenance.status, 200);
    assert.ok(maintenance.body.recovered);
    assert.ok(maintenance.body.timed_out);

    const denied = await request(port, "POST", "/api/job-execution/tick", { token: userToken, body: {} });
    assert.equal(denied.status, 403);
  });

  test("lets readers view engine data but not administer it", async () => {
    assert.equal((await request(port, "GET", "/api/job-queues", { token: userToken })).status, 200);
    assert.equal((await request(port, "GET", "/api/schedules", { token: userToken })).status, 200);
    assert.equal((await request(port, "GET", "/api/job-execution/metrics", { token: userToken })).status, 200);
    assert.equal((await request(port, "PUT", "/api/job-queues/DEFAULT", { token: userToken, body: { priority: 1 } })).status, 403);
    assert.equal((await request(port, "POST", "/api/job-execution/dead-letter/1/retry", { token: userToken })).status, 403);
  });
});
