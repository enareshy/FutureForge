import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate, queryOne } from "../db.js";
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

const past = (minutes = 5) => new Date(Date.now() - minutes * 60000).toISOString().replace("T", " ").slice(0, 19);

describe("delivery REST APIs", () => {
  let port;
  let server;
  let db;
  let adminToken;
  let userToken;
  let tenantId;
  let operatorUserId;
  let requestId;

  before(async () => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    operatorUserId = queryOne(db, "SELECT id FROM users WHERE username = 'j.patel'").id;
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

  after(() => server?.close());

  describe("vocabulary and access control", () => {
    test("exposes delivery metadata", async () => {
      const res = await request(port, "GET", "/api/delivery/meta", { token: adminToken });
      assert.equal(res.status, 200);
      assert.ok(res.body.statuses.includes("dead_lettered"));
      assert.ok(res.body.channels.includes("email"));
      assert.ok(Array.isArray(res.body.transport_types));
      assert.ok(res.body.escalation_recipient_types.length >= 1);
    });

    test("requires authentication and enforces delivery permissions", async () => {
      const anonymous = await request(port, "GET", "/api/delivery/requests");
      assert.equal(anonymous.status, 401);
      const forbidden = await request(port, "GET", "/api/delivery/requests", { token: userToken });
      assert.equal(forbidden.status, 403);
    });
  });

  describe("requests and processing", () => {
    test("creates, lists, reads and processes a request", async () => {
      const created = await request(port, "POST", "/api/delivery/requests", {
        token: adminToken,
        body: { recipient_id: operatorUserId, recipient_address: "admin@helix.example.com", channel: "in_app", subject: "API request", body: "hello", idempotency_key: "api-req-1" },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.status, "queued");
      requestId = created.body.id;

      const list = await request(port, "GET", "/api/delivery/requests", { token: adminToken });
      assert.equal(list.status, 200);
      assert.ok(list.body.total >= 1);

      const read = await request(port, "GET", `/api/delivery/requests/${requestId}`, { token: adminToken });
      assert.equal(read.status, 200);
      assert.equal(read.body.id, requestId);

      const processed = await request(port, "POST", "/api/delivery/process", { token: adminToken, body: { limit: 10 } });
      assert.equal(processed.status, 200);
      assert.ok(processed.body.processed >= 1);

      const attempts = await request(port, "GET", `/api/delivery/requests/${requestId}/attempts`, { token: adminToken });
      assert.equal(attempts.status, 200);
      assert.ok(attempts.body.items.length >= 1);
    });

    test("supports retry and cancel operations", async () => {
      const failed = await request(port, "POST", "/api/delivery/requests", {
        token: adminToken,
        body: { recipient_id: operatorUserId, channel: "webhook", subject: "API failing request", body: "x", max_attempts: 1, idempotency_key: "api-req-fail-1" },
      });
      assert.equal(failed.status, 201);
      await request(port, "POST", "/api/delivery/process", { token: adminToken, body: { limit: 10 } });

      const retry = await request(port, "POST", `/api/delivery/requests/${failed.body.id}/retry`, { token: adminToken });
      assert.equal(retry.status, 200);
      assert.equal(retry.body.retried, true);

      const cancel = await request(port, "POST", `/api/delivery/requests/${failed.body.id}/cancel`, { token: adminToken });
      assert.equal(cancel.status, 200);
      assert.equal(cancel.body.cancelled, true);
    });
  });

  describe("providers", () => {
    let providerId;

    test("creates, reads, tests and updates a provider without leaking secrets", async () => {
      const created = await request(port, "POST", "/api/delivery/providers", {
        token: adminToken,
        body: {
          code: "api-webhook",
          name: "API Webhook",
          channel: "webhook",
          type: "webhook",
          config: { webhook_url: "https://example.com/hook" },
          api_key: "super-secret",
          is_default: true,
          priority: 3,
        },
      });
      assert.equal(created.status, 201);
      assert.equal(created.body.code, "api-webhook");
      assert.equal(JSON.stringify(created.body).includes("super-secret"), false);
      providerId = created.body.id;

      const list = await request(port, "GET", "/api/delivery/providers", { token: adminToken });
      assert.equal(list.status, 200);
      assert.ok(list.body.items.some((p) => p.code === "api-webhook"));

      const read = await request(port, "GET", `/api/delivery/providers/${providerId}`, { token: adminToken });
      assert.equal(read.status, 200);

      const tested = await request(port, "POST", `/api/delivery/providers/${providerId}/test`, { token: adminToken, body: {} });
      assert.equal(tested.status, 200);
      assert.equal(tested.body.ok, true);

      const status = await request(port, "PUT", `/api/delivery/providers/${providerId}/status`, { token: adminToken, body: { status: "inactive" } });
      assert.equal(status.status, 200);
      assert.equal(status.body.enabled, false);
    });

    test("exposes provider health and failures", async () => {
      const health = await request(port, "GET", "/api/delivery/provider-health", { token: adminToken });
      assert.equal(health.status, 200);
      assert.ok(health.body.total >= 2);

      const failures = await request(port, "GET", "/api/delivery/provider-failures", { token: adminToken });
      assert.equal(failures.status, 200);
      assert.ok(Array.isArray(failures.body.items));
      assert.ok(Array.isArray(failures.body.summary));
    });
  });

  describe("reminders and escalations", () => {
    let reminderId;

    test("schedules, lists and sweeps reminders", async () => {
      const created = await request(port, "POST", "/api/delivery/reminders", {
        token: adminToken,
        body: {
          recipient_id: operatorUserId,
          kind: "overdue",
          due_at: past(5),
          details: { subject: "API reminder", channel: "in_app", body: "tick" },
          dedupe_key: "api-reminder-1",
        },
      });
      assert.equal(created.status, 201);
      reminderId = created.body.id;

      const list = await request(port, "GET", "/api/delivery/reminders", { token: adminToken });
      assert.equal(list.status, 200);
      assert.ok(list.body.total >= 1);

      const read = await request(port, "GET", `/api/delivery/reminders/${reminderId}`, { token: adminToken });
      assert.equal(read.status, 200);

      const sweep = await request(port, "POST", "/api/delivery/reminders/sweep", { token: adminToken, body: { limit: 10 } });
      assert.equal(sweep.status, 200);
      assert.ok(sweep.body.fired >= 1);

      const cancel = await request(port, "POST", `/api/delivery/reminders/${reminderId}/cancel`, { token: adminToken });
      assert.equal(cancel.status, 200);
    });

    test("schedules, lists and sweeps escalations", async () => {
      const created = await request(port, "POST", "/api/delivery/escalations", {
        token: adminToken,
        body: {
          object_type: "api-change",
          object_id: "API-1",
          recipient: { items: [{ type: "user", id: operatorUserId }] },
          level: 1,
          max_level: 1,
          after_minutes: 0,
          dedupe_key: "api-escalation-1",
          details: { subject: "API escalation", channel: "in_app" },
        },
      });
      assert.equal(created.status, 201);
      const escalationId = created.body.id;

      const list = await request(port, "GET", "/api/delivery/escalations", { token: adminToken });
      assert.equal(list.status, 200);
      assert.ok(list.body.total >= 1);

      const read = await request(port, "GET", `/api/delivery/escalations/${escalationId}`, { token: adminToken });
      assert.equal(read.status, 200);

      const sweep = await request(port, "POST", "/api/delivery/escalations/sweep", { token: adminToken, body: { limit: 10 } });
      assert.equal(sweep.status, 200);
      assert.ok(sweep.body.escalated >= 1);
    });
  });

  describe("monitoring", () => {
    test("reports metrics, stats, timeseries and runs", async () => {
      const metrics = await request(port, "GET", "/api/delivery/metrics", { token: adminToken });
      assert.equal(metrics.status, 200);
      assert.ok(metrics.body.total >= 1);

      const stats = await request(port, "GET", "/api/delivery/stats", { token: adminToken });
      assert.equal(stats.status, 200);
      assert.equal(typeof stats.body.queued, "number");

      const series = await request(port, "GET", "/api/delivery/timeseries", { token: adminToken });
      assert.equal(series.status, 200);
      assert.ok(Array.isArray(series.body.items));

      const runs = await request(port, "GET", "/api/delivery/runs", { token: adminToken });
      assert.equal(runs.status, 200);
      assert.ok(Array.isArray(runs.body.items));
    });

    test("lists and acknowledges alerts", async () => {
      const list = await request(port, "GET", "/api/delivery/alerts", { token: adminToken });
      assert.equal(list.status, 200);
      assert.ok(Array.isArray(list.body.items));
      if (list.body.items.length) {
        const ack = await request(port, "POST", `/api/delivery/alerts/${list.body.items[0].id}/acknowledge`, { token: adminToken });
        assert.equal(ack.status, 200);
        assert.equal(ack.body.status, "acknowledged");
      }
    });
  });
});
