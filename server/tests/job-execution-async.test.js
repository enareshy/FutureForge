import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, queryOne, run, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import * as jobs from "../services/jobs.js";
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

describe("async job-execution administration", () => {
  let database;
  let server;
  let port;
  let adminToken;
  let userToken;

  before(async () => {
    database = openTestDatabase();
    migrate(database);
    seedDatabase(database);
    const started = await listen(createApp(database));
    server = started.server;
    port = started.port;
    adminToken = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
    userToken = (await request(port, "POST", "/api/auth/login", { body: { username: "j.patel", password: "HelixUser!42" } })).body.token;
  });

  after(() => {
    server?.close();
    database?.close();
  });

  test("queue create, update and status run on the async layer and audit", async () => {
    const created = await request(port, "POST", "/api/job-queues", {
      token: adminToken,
      body: { code: "ASYNC_QUEUE", name: "Async queue", max_concurrency: 2 },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "ASYNC_QUEUE");

    const engineAudit = queryOne(
      database,
      "SELECT * FROM job_engine_audit WHERE entity_type = 'queue' AND entity_code = 'ASYNC_QUEUE' AND action = 'create'"
    );
    assert.ok(engineAudit, "queue create is recorded in job_engine_audit");
    assert.ok(
      queryOne(database, "SELECT id FROM audit_logs WHERE action = 'job_engine.queue.create' AND resource_id = ?", [String(engineAudit.entity_id)]),
      "queue create is recorded in the platform audit log"
    );

    const listed = await request(port, "GET", "/api/job-queues?pageSize=100", { token: adminToken });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((q) => q.code === "ASYNC_QUEUE"));

    const one = await request(port, "GET", "/api/job-queues/ASYNC_QUEUE", { token: adminToken });
    assert.equal(one.status, 200);
    assert.equal(one.body.max_concurrency, 2);

    const updated = await request(port, "PUT", "/api/job-queues/ASYNC_QUEUE", {
      token: adminToken,
      body: { name: "Async queue v2", max_concurrency: 4 },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, "Async queue v2");
    assert.equal(updated.body.max_concurrency, 4);

    const paused = await request(port, "POST", "/api/job-queues/ASYNC_QUEUE/status", { token: adminToken, body: { paused: true } });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.paused, true);

    const resumed = await request(port, "POST", "/api/job-queues/ASYNC_QUEUE/status", { token: adminToken, body: { paused: false } });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.paused, false);

    const health = await request(port, "GET", "/api/job-queues/ASYNC_QUEUE/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.equal(health.body.queue.code, "ASYNC_QUEUE");
  });

  test("schedule lifecycle and run-now dispatch a job on the async layer", async () => {
    const created = await request(port, "POST", "/api/schedules", {
      token: adminToken,
      body: {
        code: "ASYNC_SCHED",
        name: "Async cron",
        job_type_code: "REPORT_GENERATION",
        queue: "REPORTING",
        schedule_type: "cron",
        cron_expression: "0 4 * * *",
        timezone: "UTC",
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "ASYNC_SCHED");
    assert.ok(created.body.next_run_at, "next run is computed");

    const engineAudit = queryOne(
      database,
      "SELECT * FROM job_engine_audit WHERE entity_type = 'schedule' AND entity_code = 'ASYNC_SCHED' AND action = 'create'"
    );
    assert.ok(engineAudit, "schedule create is recorded in job_engine_audit");

    const listed = await request(port, "GET", "/api/schedules?pageSize=100", { token: adminToken });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.summary !== undefined, true);
    assert.ok(listed.body.items.some((s) => s.code === "ASYNC_SCHED"));

    const one = await request(port, "GET", `/api/schedules/${created.body.id}`, { token: adminToken });
    assert.equal(one.status, 200);
    assert.equal(one.body.code, "ASYNC_SCHED");

    const updated = await request(port, "PUT", `/api/schedules/${created.body.id}`, {
      token: adminToken,
      body: { name: "Async cron v2", max_retries: 2 },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, "Async cron v2");

    const disabled = await request(port, "POST", `/api/schedules/${created.body.id}/disable`, { token: adminToken });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.enabled, false);

    const enabled = await request(port, "POST", `/api/schedules/${created.body.id}/enable`, { token: adminToken });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.body.enabled, true);

    const paused = await request(port, "POST", `/api/schedules/${created.body.id}/pause`, { token: adminToken });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.status, "paused");

    const resumed = await request(port, "POST", `/api/schedules/${created.body.id}/resume`, { token: adminToken });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.status, "active");

    const runNow = await request(port, "POST", `/api/schedules/${created.body.id}/run-now`, { token: adminToken });
    assert.equal(runNow.status, 202);
    assert.ok(runNow.body.job?.id, "run-now dispatches a job");
    assert.equal(runNow.body.job.submitted_as, "schedule");

    const scheduleRun = queryOne(
      database,
      "SELECT * FROM job_schedule_runs WHERE schedule_id = ? AND job_id = ?",
      [created.body.id, runNow.body.job.id]
    );
    assert.ok(scheduleRun, "a job_schedule_runs row links the schedule to the job");
    assert.equal(scheduleRun.status, "enqueued");

    const history = queryOne(
      database,
      "SELECT * FROM job_history WHERE job_id = ? AND message = 'Dispatched by schedule run-now'",
      [runNow.body.job.id]
    );
    assert.ok(history, "run-now records job history");

    const runAudit = queryOne(
      database,
      "SELECT * FROM job_engine_audit WHERE entity_type = 'schedule' AND entity_code = 'ASYNC_SCHED' AND action = 'run_now'"
    );
    assert.ok(runAudit, "run-now is recorded in job_engine_audit");

    const runs = await request(port, "GET", `/api/schedules/${created.body.id}/runs`, { token: adminToken });
    assert.equal(runs.status, 200);
    assert.ok(runs.body.items.length >= 1);
    assert.equal(runs.body.schedule.code, "ASYNC_SCHED");
  });

  test("engine observability reads run on the async layer", async () => {
    const status = await request(port, "GET", "/api/job-execution/status", { token: adminToken });
    assert.equal(status.status, 200);
    assert.ok(Array.isArray(status.body.handlers));
    assert.ok(status.body.checked_at);

    const metrics = await request(port, "GET", "/api/job-execution/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.totals);
    assert.ok(Array.isArray(metrics.body.queues));

    const workers = await request(port, "GET", "/api/job-execution/workers", { token: adminToken });
    assert.equal(workers.status, 200);
    assert.ok(Array.isArray(workers.body.items));
    assert.ok(workers.body.summary);

    const handlers = await request(port, "GET", "/api/job-execution/handlers", { token: adminToken });
    assert.equal(handlers.status, 200);
    assert.ok(Array.isArray(handlers.body.items));

    const deadLetter = await request(port, "GET", "/api/job-execution/dead-letter", { token: adminToken });
    assert.equal(deadLetter.status, 200);
    assert.ok(Array.isArray(deadLetter.body.items));

    const audit = await request(port, "GET", "/api/job-execution/audit", { token: adminToken });
    assert.equal(audit.status, 200);
    assert.ok(Array.isArray(audit.body.items));
  });

  test("read-only user cannot mutate queues or schedules", async () => {
    const readQueues = await request(port, "GET", "/api/job-queues", { token: userToken });
    assert.equal(readQueues.status, 200);
    const readSchedules = await request(port, "GET", "/api/schedules", { token: userToken });
    assert.equal(readSchedules.status, 200);

    const createQueue = await request(port, "POST", "/api/job-queues", {
      token: userToken,
      body: { code: "NOPE_ASYNC_QUEUE" },
    });
    assert.equal(createQueue.status, 403);

    const createSchedule = await request(port, "POST", "/api/schedules", {
      token: userToken,
      body: { code: "NOPE_ASYNC_SCHED", job_type_code: "REPORT_GENERATION" },
    });
    assert.equal(createSchedule.status, 403);
  });
});

describe("async job-execution engine reads and dead-letter control", () => {
  let database;
  let tenantId;

  before(() => {
    database = openTestDatabase();
    migrate(database);
    seedDatabase(database);
    tenantId = queryOne(database, "SELECT id FROM organizations WHERE code = 'helix'").id;
  });

  after(() => database?.close());

  test("engineStatusAsync, executionMetricsAsync, listWorkersAsync and getLockAsync run on the async layer", async () => {
    const status = await jobExecution.engineStatusAsync(database);
    assert.ok(Array.isArray(status.handlers));
    assert.ok(status.checked_at);

    const metrics = await jobExecution.executionMetricsAsync(database, tenantId);
    assert.ok(metrics.totals);
    assert.ok(Array.isArray(metrics.queues));
    const counts = await jobExecution.jobStatusCountsAsync(database, tenantId);
    assert.equal(typeof counts, "object");

    const workers = await jobExecution.listWorkersAsync(database, {});
    assert.ok(Array.isArray(workers.items));
    assert.ok(workers.summary);

    assert.equal(await jobExecution.getLockAsync(database, "engine:scheduler"), null);
  });

  test("discardDeadLetterAsync resolves an open dead-letter entry", async () => {
    const submitted = jobs.submitJob(
      database,
      { job_type_code: "REPORT_GENERATION", name: "Async dead letter", tenant_id: tenantId, queue: "REPORTING" },
      { actor: null }
    );
    const jobRow = queryOne(database, "SELECT id FROM jobs WHERE job_ref = ?", [submitted.job_ref]);
    const ts = "2026-01-01 00:00:00";
    const inserted = run(
      database,
      `INSERT INTO job_dead_letters
         (job_id, queue, job_type_code, tenant_id, reason, category, attempts, status, created_at, updated_at)
       VALUES (?, 'REPORTING', 'REPORT_GENERATION', ?, 'async reason', 'PERMANENT', 1, 'open', ?, ?)`,
      [jobRow.id, tenantId, ts, ts]
    );
    const deadLetterId = Number(inserted.lastInsertId);

    const result = await jobExecution.discardDeadLetterAsync(database, deadLetterId, { actor: { id: 1 }, note: "async discard" });
    assert.equal(result.discarded, true);
    assert.equal(result.dead_letter.status, "discarded");
    assert.equal(queryOne(database, "SELECT status FROM job_dead_letters WHERE id = ?", [deadLetterId]).status, "discarded");
  });
});
