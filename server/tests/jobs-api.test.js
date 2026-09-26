import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import * as jobs from "../services/jobs.js";

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

describe("background job REST APIs", () => {
  let port;
  let server;
  let db;
  let adminToken;
  let userToken;
  let tenantId;
  let otherTenantId;

  before(async () => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    otherTenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'emea'").id;
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
    server?.close();
    db?.close();
  });

  test("requires authentication", async () => {
    assert.equal((await request(port, "GET", "/api/jobs")).status, 401);
  });

  test("exposes metadata and job types", async () => {
    const meta = await request(port, "GET", "/api/jobs/meta", { token: adminToken });
    assert.equal(meta.status, 200);
    assert.ok(meta.body.statuses.includes("running"));
    assert.ok(meta.body.transitions.running.includes("completed"));

    const types = await request(port, "GET", "/api/job-types", { token: adminToken });
    assert.equal(types.status, 200);
    assert.ok(types.body.items.some((type) => type.code === "BULK_IMPORT"));
  });

  test("submits, reads and lists jobs", async () => {
    const created = await request(port, "POST", "/api/jobs", {
      token: adminToken,
      body: { job_type_code: "REPORT_GENERATION", name: "API report", related_object_type: "report", related_object_id: "9" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "queued");
    const id = created.body.id;

    const detail = await request(port, "GET", `/api/jobs/${id}`, { token: adminToken });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.job_ref, created.body.job_ref);
    assert.ok(detail.body.dependencies_state);

    const byRef = await request(port, "GET", `/api/jobs/${created.body.job_ref}`, { token: adminToken });
    assert.equal(byRef.status, 200);
    assert.equal(byRef.body.id, id);

    const status = await request(port, "GET", `/api/jobs/${id}/status`, { token: adminToken });
    assert.equal(status.status, 200);
    assert.equal(status.body.status, "queued");

    const list = await request(port, "GET", "/api/jobs?type=REPORT_GENERATION&pageSize=5", { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.items.some((job) => job.id === id));

    const missing = await request(port, "GET", "/api/jobs/999999", { token: adminToken });
    assert.equal(missing.status, 404);
  });

  test("drives progress, history and control operations", async () => {
    const created = await request(port, "POST", "/api/jobs", { token: adminToken, body: { job_type_code: "BOM_VALIDATION", name: "Control me" } });
    const id = created.body.id;

    const running = await request(port, "POST", `/api/jobs/${id}/progress`, { token: adminToken, body: { status: "running", stage: "validate", message: "started" } });
    assert.equal(running.status, 200);
    assert.equal(running.body.status, "running");

    const progress = await request(port, "POST", `/api/jobs/${id}/progress`, { token: adminToken, body: { progress: 65, stage: "scan", message: "scanning" } });
    assert.equal(progress.status, 200);
    assert.equal(progress.body.progress, 65);

    const history = await request(port, "GET", `/api/jobs/${id}/history`, { token: adminToken });
    assert.equal(history.status, 200);
    assert.ok(history.body.items.length >= 3);

    const illegal = await request(port, "POST", `/api/jobs/${id}/progress`, { token: adminToken, body: { status: "queued" } });
    assert.equal(illegal.status, 409);

    const cancel = await request(port, "POST", `/api/jobs/${id}/cancel`, { token: adminToken, body: { reason: "stop" } });
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.requested, true);
    const cancelled = await request(port, "POST", `/api/jobs/${id}/progress`, { token: adminToken, body: { status: "cancelled" } });
    assert.equal(cancelled.body.status, "cancelled");

    const retry = await request(port, "POST", `/api/jobs/${id}/retry`, { token: adminToken });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.retried, true);

    const pause = await request(port, "POST", `/api/jobs/${id}/pause`, { token: adminToken });
    assert.equal(pause.body.paused, true);
    const resume = await request(port, "POST", `/api/jobs/${id}/resume`, { token: adminToken });
    assert.equal(resume.body.resumed, true);
    assert.equal(resume.body.job.status, "queued");
  });

  test("stores and reads results and artifacts", async () => {
    const created = await request(port, "POST", "/api/jobs", { token: adminToken, body: { job_type_code: "REPORT_GENERATION", name: "Result job" } });
    const id = created.body.id;
    await request(port, "POST", `/api/jobs/${id}/progress`, { token: adminToken, body: { status: "running" } });
    const completed = await request(port, "POST", `/api/jobs/${id}/progress`, { token: adminToken, body: { status: "completed", progress: 100 } });
    assert.equal(completed.body.status, "completed");

    const result = await request(port, "POST", `/api/jobs/${id}/result`, { token: adminToken, body: { result: { rows: 12 }, result_ref: "doc://api-report" } });
    assert.equal(result.status, 200);
    assert.equal(result.body.result.rows, 12);

    const artifact = await request(port, "POST", `/api/jobs/${id}/artifacts`, {
      token: adminToken,
      body: { kind: "report", name: "API report", filename: "api.pdf", size: 2048 },
    });
    assert.equal(artifact.status, 201);
    assert.equal(artifact.body.kind, "report");

    const read = await request(port, "GET", `/api/jobs/${id}/result`, { token: adminToken });
    assert.equal(read.status, 200);
    assert.equal(read.body.artifacts.length, 1);
    assert.equal(read.body.result_ref, "doc://api-report");

    const artifacts = await request(port, "GET", `/api/jobs/${id}/artifacts`, { token: adminToken });
    assert.equal(artifacts.body.items.length, 1);
  });

  test("manages dependencies over the API", async () => {
    const parent = await request(port, "POST", "/api/jobs", { token: adminToken, body: { job_type_code: "CAD_PROCESSING", name: "Dep parent" } });
    const child = await request(port, "POST", "/api/jobs", {
      token: adminToken,
      body: { job_type_code: "BOM_VALIDATION", name: "Dep child", dependencies: [parent.body.id] },
    });
    assert.equal(child.body.status, "waiting_for_dependency");

    const deps = await request(port, "GET", `/api/jobs/${child.body.id}/dependencies`, { token: adminToken });
    assert.equal(deps.status, 200);
    assert.equal(deps.body.depends_on.length, 1);

    await request(port, "POST", `/api/jobs/${parent.body.id}/progress`, { token: adminToken, body: { status: "running" } });
    await request(port, "POST", `/api/jobs/${parent.body.id}/progress`, { token: adminToken, body: { status: "completed" } });
    const released = await request(port, "GET", `/api/jobs/${child.body.id}`, { token: adminToken });
    assert.equal(released.body.status, "queued");

    const extra = await request(port, "POST", "/api/jobs", { token: adminToken, body: { job_type_code: "DATA_SYNC", name: "Extra dep" } });
    const added = await request(port, "POST", `/api/jobs/${child.body.id}/dependencies`, { token: adminToken, body: { dependencies: [extra.body.id] } });
    assert.equal(added.status, 201);
    const removed = await request(port, "DELETE", `/api/jobs/${child.body.id}/dependencies/${extra.body.id}`, { token: adminToken });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.removed, true);

    const children = await request(port, "GET", `/api/jobs/${parent.body.id}/children`, { token: adminToken });
    assert.equal(children.status, 200);
    assert.ok(Array.isArray(children.body.items));
  });

  test("administers job types (authorized only)", async () => {
    const created = await request(port, "POST", "/api/job-types", { token: adminToken, body: { code: "API_ETL", name: "API ETL", source_module: "test", queues: ["etl"] } });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "API_ETL");

    const updated = await request(port, "PATCH", "/api/job-types/API_ETL", { token: adminToken, body: { name: "API ETL v2", max_retries: 4 } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.max_retries, 4);

    const disabled = await request(port, "POST", "/api/job-types/API_ETL/status", { token: adminToken, body: { active: false } });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.active, false);

    const denied = await request(port, "POST", "/api/job-types", { token: userToken, body: { code: "NOPE_TYPE", name: "Nope" } });
    assert.equal(denied.status, 403);
  });

  test("serves monitoring metrics to authorized roles", async () => {
    const metrics = await request(port, "GET", "/api/job-metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.total >= 1);
    assert.ok(Array.isArray(metrics.body.by_status));
    assert.ok(Array.isArray(metrics.body.queue_depth));

    const series = await request(port, "GET", "/api/job-metrics/timeseries?days=7", { token: adminToken });
    assert.equal(series.status, 200);
    assert.ok(Array.isArray(series.body.items));

    const scoped = await request(port, "GET", "/api/job-metrics", { token: userToken });
    assert.equal(scoped.status, 200);
    assert.ok(scoped.body.total >= 0);
  });

  test("lets regular users submit and control their own tenant's jobs", async () => {
    const created = await request(port, "POST", "/api/jobs", { token: userToken, body: { job_type_code: "BULK_IMPORT", name: "User import" } });
    assert.equal(created.status, 201);
    const cancelled = await request(port, "POST", `/api/jobs/${created.body.id}/cancel`, { token: userToken });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.job.status, "cancelled");
  });

  test("enforces tenant isolation and supports platform-wide view", async () => {
    const foreign = jobs.submitJob(db, { job_type_code: "DATA_SYNC", name: "Foreign API job", tenant_id: otherTenantId }, { actor: null });

    const scoped = await request(port, "GET", "/api/jobs?q=Foreign%20API%20job", { token: adminToken });
    assert.equal(scoped.status, 200);
    assert.equal(scoped.body.items.length, 0);

    const crossTenant = await request(port, "GET", `/api/jobs/${foreign.id}`, { token: adminToken });
    assert.equal(crossTenant.status, 404);

    const all = await request(port, "GET", "/api/jobs?all=true&q=Foreign%20API%20job", { token: adminToken });
    assert.equal(all.status, 200);
    assert.ok(all.body.items.some((job) => job.id === foreign.id));

    const metricsAll = await request(port, "GET", "/api/job-metrics?all=true", { token: adminToken });
    assert.equal(metricsAll.status, 200);
    assert.ok(metricsAll.body.total >= 1);
  });
});
