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
          ...(payload !== null ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

describe("Data Lifecycle & Archival REST APIs", () => {
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
    const res = await request(port, "GET", "/api/v1/lifecycle/objects");
    assert.equal(res.status, 401);
  });

  test("denies a reader without lifecycle privileges", async () => {
    const res = await request(port, "GET", "/api/v1/lifecycle/objects", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the lifecycle vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/lifecycle/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "data-lifecycle");
    assert.deepEqual(res.body.capabilities.lifecycle_states, ["ACTIVE", "INACTIVE", "ARCHIVED", "COLD_STORAGE", "PURGED"]);
    assert.ok(res.body.security_actions.includes("PURGE"));
  });

  test("reads the seeded lifecycle estate", async () => {
    const objects = await request(port, "GET", "/api/v1/lifecycle/objects", { token: adminToken });
    assert.equal(objects.status, 200);
    assert.ok(objects.body.total >= 5);

    const policies = await request(port, "GET", "/api/v1/lifecycle/policies", { token: adminToken });
    assert.equal(policies.status, 200);
    assert.ok(policies.body.items.some((p) => p.code === "CUSTOMER_RETENTION"));

    const states = await request(port, "GET", "/api/v1/lifecycle/states", { token: adminToken });
    assert.equal(states.status, 200);
    assert.equal(states.body.items.length, 5);
  });

  test("explains eligibility and honours legal holds", async () => {
    const eligible = await request(port, "POST", "/api/v1/lifecycle/eligibility/check", { token: adminToken, body: { object_type: "customer", object_id: "CUST-1001", action: "ARCHIVE" } });
    assert.equal(eligible.status, 200);
    assert.equal(eligible.body.blocked, false);

    const blocked = await request(port, "POST", "/api/v1/lifecycle/eligibility/check", { token: adminToken, body: { object_type: "customer", object_id: "CUST-1002", action: "ARCHIVE" } });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.blocked, true);
    assert.ok(blocked.body.reasons.some((r) => r.code === "LEGAL_HOLD_ACTIVE"));
  });

  test("creates and releases a legal hold", async () => {
    const created = await request(port, "POST", "/api/v1/lifecycle/legal-holds", {
      token: adminToken,
      body: { code: "API_HOLD", name: "API hold", scope_type: "OBJECT", object_type: "customer", object_ids: [{ object_type: "customer", object_id: "CUST-1001" }] },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "ACTIVE");

    const released = await request(port, "POST", `/api/v1/lifecycle/legal-holds/${created.body.hold_ref}/release`, { token: adminToken, body: { reason: "done" } });
    assert.equal(released.status, 200);
    assert.equal(released.body.status, "RELEASED");
  });

  test("evaluates purge and reports metrics", async () => {
    const purge = await request(port, "POST", "/api/v1/lifecycle/purges/evaluate", { token: adminToken, body: { object_type: "purchase_order", object_id: "PO-3001" } });
    assert.equal(purge.status, 200);
    assert.equal(typeof purge.body.blocked, "boolean");

    const metrics = await request(port, "GET", "/api/v1/lifecycle/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.counters.objects_tracked >= 5);

    const health = await request(port, "GET", "/api/v1/lifecycle/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.ok(["healthy", "degraded"].includes(health.body.status));
  });

  test("reads and updates configuration", async () => {
    const config = await request(port, "GET", "/api/v1/lifecycle/configuration", { token: adminToken });
    assert.equal(config.status, 200);
    assert.equal(typeof config.body.quality_gate_enabled, "boolean");

    const updated = await request(port, "PUT", "/api/v1/lifecycle/configuration/quality_min_score", { token: adminToken, body: { value: 70 } });
    assert.equal(updated.status, 200);
    assert.equal(Number(updated.body.value), 70);

    const invalid = await request(port, "PUT", "/api/v1/lifecycle/configuration/quality_min_score", { token: adminToken, body: { value: 5000 } });
    assert.equal(invalid.status, 400);
  });

  test("submits and lists a lifecycle job", async () => {
    const submit = await request(port, "POST", "/api/v1/lifecycle/jobs/evaluate", { token: adminToken, body: { actions: ["ARCHIVE"] } });
    assert.equal(submit.status, 202);

    const jobs = await request(port, "GET", "/api/v1/lifecycle/jobs", { token: adminToken });
    assert.equal(jobs.status, 200);
    assert.equal(typeof jobs.body.total, "number");
  });

  test("exposes a lifecycle snapshot for catalog integration", async () => {
    const res = await request(port, "GET", "/api/v1/lifecycle/objects/customer/CUST-1001/snapshot", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.object_type, "customer");
  });
});
