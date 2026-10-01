import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";

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

describe("async job writes", () => {
  let database;
  let server;
  let port;
  let token;

  before(async () => {
    database = openTestDatabase();
    migrate(database);
    seedDatabase(database);
    const started = await listen(createApp(database));
    server = started.server;
    port = started.port;
    token = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
  });

  after(() => {
    server?.close();
    database?.close();
  });

  async function submit(name = "Async job", extra = {}) {
    const created = await request(port, "POST", "/api/jobs", {
      token,
      body: { job_type_code: "REPORT_GENERATION", name, ...extra },
    });
    assert.equal(created.status, 201);
    return created.body;
  }

  test("submit writes audit and a creation history entry", async () => {
    const job = await submit("Async submit");
    assert.equal(job.status, "queued");

    const audit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'jobs.submit' AND resource_id = ?",
      [String(job.id)]
    );
    assert.ok(audit, "jobs.submit is audited");

    const history = queryOne(
      database,
      "SELECT * FROM job_history WHERE job_id = ? AND event_type = 'created'",
      [job.id]
    );
    assert.ok(history, "creation history is recorded");
  });

  test("progress and terminal transition update status and history", async () => {
    const job = await submit("Async progress");

    const running = await request(port, "POST", `/api/jobs/${job.id}/progress`, {
      token,
      body: { status: "running", progress: 25, stage: "start" },
    });
    assert.equal(running.status, 200);
    assert.equal(running.body.status, "running");
    assert.equal(running.body.progress, 25);

    const done = await request(port, "POST", `/api/jobs/${job.id}/progress`, {
      token,
      body: { status: "completed", progress: 100 },
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, "completed");
    assert.equal(done.body.is_terminal, true);

    const statusHistory = queryOne(
      database,
      "SELECT COUNT(*) AS c FROM job_history WHERE job_id = ? AND event_type = 'status'",
      [job.id]
    );
    assert.ok(statusHistory.c >= 2, "status changes are recorded");
  });

  test("pause then resume", async () => {
    const job = await submit("Async pause");

    const paused = await request(port, "POST", `/api/jobs/${job.id}/pause`, { token, body: { reason: "hold" } });
    assert.equal(paused.status, 200);
    assert.equal(paused.body.paused, true);
    assert.equal(paused.body.job.status, "paused");

    const resumed = await request(port, "POST", `/api/jobs/${job.id}/resume`, { token });
    assert.equal(resumed.status, 200);
    assert.equal(resumed.body.resumed, true);
    assert.equal(resumed.body.job.status, "queued");
  });

  test("cancel is immediate for queued jobs and audited", async () => {
    const job = await submit("Async cancel");

    const cancelled = await request(port, "POST", `/api/jobs/${job.id}/cancel`, { token, body: { reason: "no longer needed" } });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.cancelled, true);
    assert.equal(cancelled.body.requested, false);
    assert.equal(cancelled.body.job.status, "cancelled");

    const audit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'jobs.cancel' AND resource_id = ?",
      [String(job.id)]
    );
    assert.ok(audit, "jobs.cancel is audited");
  });

  test("dependency add and remove", async () => {
    const parent = await submit("Async parent");
    const child = await submit("Async child");

    const added = await request(port, "POST", `/api/jobs/${child.id}/dependencies`, {
      token,
      body: { dependencies: [parent.id] },
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.items.length, 1);

    const listed = await request(port, "GET", `/api/jobs/${child.id}/dependencies`, { token });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.depends_on.length, 1);

    const removed = await request(port, "DELETE", `/api/jobs/${child.id}/dependencies/${parent.id}`, { token });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);
  });

  test("artifacts and result", async () => {
    const job = await submit("Async artifacts");

    const artifact = await request(port, "POST", `/api/jobs/${job.id}/artifacts`, {
      token,
      body: { kind: "report", name: "report.pdf", content_type: "application/pdf", size: 1024 },
    });
    assert.equal(artifact.status, 201);
    assert.equal(artifact.body.kind, "report");

    const listed = await request(port, "GET", `/api/jobs/${job.id}/artifacts`, { token });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.items.length, 1);

    const result = await request(port, "POST", `/api/jobs/${job.id}/result`, {
      token,
      body: { result_ref: "REPORT-1", result: { rows: 10 } },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.result_ref, "REPORT-1");
    assert.deepEqual(result.body.result, { rows: 10 });
  });

  test("manual retry of a failed job", async () => {
    const job = await submit("Async retry");
    await request(port, "POST", `/api/jobs/${job.id}/progress`, { token, body: { status: "running" } });
    const failed = await request(port, "POST", `/api/jobs/${job.id}/progress`, {
      token,
      body: { status: "failed", message: "boom" },
    });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.status, "failed");

    const retried = await request(port, "POST", `/api/jobs/${job.id}/retry`, { token });
    assert.equal(retried.status, 200);
    assert.equal(retried.body.retried, true);
    assert.equal(retried.body.job.status, "queued");
  });

  test("job type create, update and status", async () => {
    const created = await request(port, "POST", "/api/job-types", {
      token,
      body: { code: "ASYNC_TEST_TYPE", name: "Async test type", handler: "jobs.asyncTest", queues: ["default"] },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "ASYNC_TEST_TYPE");

    const updated = await request(port, "PATCH", "/api/job-types/ASYNC_TEST_TYPE", {
      token,
      body: { description: "updated via async" },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.description, "updated via async");

    const deactivated = await request(port, "POST", "/api/job-types/ASYNC_TEST_TYPE/status", {
      token,
      body: { active: false },
    });
    assert.equal(deactivated.status, 200);
    assert.equal(deactivated.body.active, false);

    const audit = queryOne(
      database,
      "SELECT * FROM audit_logs WHERE action = 'jobs.type.create' AND resource_id = ?",
      [String(created.body.id)]
    );
    assert.ok(audit, "jobs.type.create is audited");
  });
});
