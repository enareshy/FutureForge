process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate, queryOne, run } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function request(port, method, path, { token, body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers: {
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const data = Buffer.concat(chunks).toString("utf8");
          let parsed = data;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch {
            parsed = data;
          }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("Event & Messaging Framework REST APIs", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let userToken;

  before(async () => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    const started = await listen(createApp(db));
    server = started.server;
    port = started.port;
    adminToken = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
    userToken = (await request(port, "POST", "/api/auth/login", { body: { username: "j.patel", password: "HelixUser!42" } })).body.token;
  });

  after(() => {
    server?.close();
    db?.close();
  });

  const auth = () => ({ token: adminToken });

  test("meta advertises vocabulary, event types and bus providers", async () => {
    const res = await request(port, "GET", "/api/events/meta", auth());
    assert.equal(res.status, 200);
    assert.ok(res.body.categories.includes("product"));
    assert.ok(res.body.event_types.some((t) => t.code === "ProductCreated"));
    assert.ok(res.body.bus_providers.includes("database"));
    assert.ok(Array.isArray(res.body.handlers));
  });

  test("requires authentication and enforces permissions", async () => {
    assert.equal((await request(port, "GET", "/api/events/event-types")).status, 401);
    const forbidden = await request(port, "GET", "/api/events/event-types", { token: userToken });
    assert.ok([401, 403].includes(forbidden.status));
  });

  test("event type registry: create, list, get, update and version schemas", async () => {
    const created = await request(port, "POST", "/api/events/event-types", {
      ...auth(),
      body: {
        code: "ApiWidgetCreated",
        category: "product",
        source_module: "test",
        schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "ApiWidgetCreated");

    const listed = await request(port, "GET", "/api/events/event-types?q=ApiWidget", auth());
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((t) => t.code === "ApiWidgetCreated"));

    const fetched = await request(port, "GET", "/api/events/event-types/ApiWidgetCreated", auth());
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.schema.required[0], "name");

    const updated = await request(port, "PATCH", "/api/events/event-types/ApiWidgetCreated", { ...auth(), body: { description: "api demo" } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.description, "api demo");

    const versions = await request(port, "GET", "/api/events/event-types/ApiWidgetCreated/versions", auth());
    assert.equal(versions.status, 200);
    assert.ok(versions.body.items.length >= 1);

    const added = await request(port, "POST", "/api/events/event-types/ApiWidgetCreated/versions", {
      ...auth(),
      body: { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, qty: { type: "number" } } } },
    });
    assert.equal(added.status, 201);
    assert.equal(added.body.version.version, 2);
    assert.equal(added.body.comparison.compatible, true);

    const compatibility = await request(port, "POST", "/api/events/event-types/ApiWidgetCreated/compatibility", {
      ...auth(),
      body: { schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
    });
    assert.equal(compatibility.status, 200);
    assert.equal(compatibility.body.compatible, false, "removing a property is breaking");
  });

  test("publishes events through the transactional outbox and surfaces deliveries", async () => {
    const queued = await request(port, "POST", "/api/events", {
      ...auth(),
      body: { event_type_code: "ApiWidgetCreated", payload: { name: "api" }, source_module: "test" },
    });
    assert.equal(queued.status, 202);
    assert.equal(queued.body.queued, true);
    assert.ok(queued.body.event_ref);

    const outbox = await request(port, "GET", "/api/events/outbox/stats", auth());
    assert.equal(outbox.status, 200);
    assert.ok(outbox.body.pending >= 1);

    const processed = await request(port, "POST", "/api/events/outbox/process", { ...auth(), body: {} });
    assert.equal(processed.status, 200);
    assert.ok(processed.body.published >= 1);

    const listed = await request(port, "GET", "/api/events?event_type_code=ApiWidgetCreated", auth());
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((e) => e.event_ref === queued.body.event_ref));

    const detail = await request(port, "GET", `/api/events/${queued.body.event_ref}`, auth());
    assert.equal(detail.status, 200);
    assert.equal(detail.body.status, "published");

    const stats = await request(port, "GET", "/api/events/deliveries/stats", auth());
    assert.equal(stats.status, 200);
    assert.ok("delivered" in stats.body);
  });

  test("subscription lifecycle: create, validate, activate, test, stats, delete", async () => {
    const created = await request(port, "POST", "/api/events/subscriptions", {
      ...auth(),
      body: {
        code: "api-widget-sub",
        event_type_code: "ApiWidgetCreated",
        subscriber: "audit",
        handler: "audit.record",
        filter: { "payload.name": "api" },
      },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.status, "draft");

    const validation = await request(port, "POST", "/api/events/subscriptions/api-widget-sub/validate", auth());
    assert.equal(validation.status, 200);
    assert.equal(validation.body.valid, true);

    const activated = await request(port, "POST", "/api/events/subscriptions/api-widget-sub/status", { ...auth(), body: { status: "active" } });
    assert.equal(activated.status, 200);
    assert.equal(activated.body.status, "active");

    const tested = await request(port, "POST", "/api/events/subscriptions/api-widget-sub/test", { ...auth(), body: { payload: { name: "api" } } });
    assert.equal(tested.status, 200);
    assert.equal(tested.body.matched, true);

    const stats = await request(port, "GET", "/api/events/subscriptions/api-widget-sub/stats", auth());
    assert.equal(stats.status, 200);
    assert.ok("total" in stats.body);

    const updated = await request(port, "PATCH", "/api/events/subscriptions/api-widget-sub", { ...auth(), body: { description: "updated" } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.description, "updated");

    const removed = await request(port, "DELETE", "/api/events/subscriptions/api-widget-sub", auth());
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);
  });

  test("immediate publish routes synchronously and creates deliveries", async () => {
    const sub = await request(port, "POST", "/api/events/subscriptions", {
      ...auth(),
      body: { code: "api-immediate-sub", event_type_code: "ApiWidgetCreated", subscriber: "audit", handler: "audit.record" },
    });
    assert.equal(sub.status, 201);
    await request(port, "POST", "/api/events/subscriptions/api-immediate-sub/status", { ...auth(), body: { status: "active" } });

    const published = await request(port, "POST", "/api/events?immediate=true", {
      ...auth(),
      body: { event_type_code: "ApiWidgetCreated", payload: { name: "api" }, source_module: "test" },
    });
    assert.equal(published.status, 202);
    assert.equal(published.body.queued, false);
    assert.ok(published.body.deliveries.length >= 1);

    const eventDeliveries = await request(port, "GET", `/api/events/${published.body.event_ref}/deliveries`, auth());
    assert.equal(eventDeliveries.status, 200);
    assert.ok(eventDeliveries.body.total >= 1);
  });

  test("batch publish, validate and serialize helpers", async () => {
    const batch = await request(port, "POST", "/api/events/batch", {
      ...auth(),
      body: { events: [{ event_type_code: "ApiWidgetCreated", payload: { name: "b1" } }, { event_type_code: "ApiWidgetCreated", payload: {} }] },
    });
    assert.equal(batch.status, 207);
    assert.equal(batch.body.published, 1);
    assert.equal(batch.body.failed, 1);

    const validated = await request(port, "POST", "/api/events/validate", { ...auth(), body: { event_type_code: "ApiWidgetCreated", payload: { name: "ok" } } });
    assert.equal(validated.status, 200);
    assert.equal(validated.body.valid, true);

    const invalid = await request(port, "POST", "/api/events/validate", { ...auth(), body: { event_type_code: "ApiWidgetCreated", payload: {} } });
    assert.equal(invalid.status, 400);

    const serialized = await request(port, "POST", "/api/events/serialize", { ...auth(), body: { event_type_code: "ApiWidgetCreated", payload: { name: "ok" } } });
    assert.equal(serialized.status, 200);
    assert.match(serialized.body.serialized, /ApiWidgetCreated/);
  });

  test("topology manages topics, queues and consumer groups", async () => {
    assert.equal((await request(port, "POST", "/api/events/topics", { ...auth(), body: { code: "api-topic", name: "API topic" } })).status, 201);
    assert.equal((await request(port, "POST", "/api/events/queues", { ...auth(), body: { code: "api-queue", name: "API queue", consumer_group: "api-group" } })).status, 201);
    assert.equal((await request(port, "POST", "/api/events/consumer-groups", { ...auth(), body: { code: "api-group", name: "API group", topic_code: "api-topic", queue_code: "api-queue" } })).status, 201);

    assert.ok((await request(port, "GET", "/api/events/topics", auth())).body.items.some((t) => t.code === "api-topic"));
    assert.ok((await request(port, "GET", "/api/events/queues", auth())).body.items.some((q) => q.code === "api-queue"));
    assert.ok((await request(port, "GET", "/api/events/consumer-groups", auth())).body.items.some((g) => g.code === "api-group"));
    assert.equal((await request(port, "GET", "/api/events/queues/api-queue/stats", auth())).status, 200);
  });

  test("replay previews, runs, reports and cancels", async () => {
    const preview = await request(port, "POST", "/api/events/replays/preview", { ...auth(), body: { event_type_code: "ApiWidgetCreated" } });
    assert.equal(preview.status, 200);
    assert.ok(preview.body.matched_events >= 1);

    const created = await request(port, "POST", "/api/events/replays", {
      ...auth(),
      body: { scope_type: "type", event_type_code: "ApiWidgetCreated", dry_run: true },
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.replay_ref);

    const run = await request(port, "POST", `/api/events/replays/${created.body.replay_ref}/run`, auth());
    assert.equal(run.status, 200);
    assert.equal(run.body.status, "completed");

    const fetched = await request(port, "GET", `/api/events/replays/${created.body.replay_ref}`, auth());
    assert.equal(fetched.status, 200);
    assert.ok("preview" in fetched.body);

    const stats = await request(port, "GET", "/api/events/replays/stats", auth());
    assert.equal(stats.status, 200);
    assert.ok(stats.body.total >= 1);

    const live = await request(port, "POST", "/api/events/replays", { ...auth(), body: { scope_type: "type", event_type_code: "ApiWidgetCreated" } });
    assert.equal(live.status, 201);
    const cancelled = await request(port, "POST", `/api/events/replays/${live.body.replay_ref}/cancel`, auth());
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "cancelled");
  });

  test("retention policies create, preview, apply and report", async () => {
    const created = await request(port, "POST", "/api/events/retention-policies", {
      ...auth(),
      body: { code: "api-retention", event_type_code: "ApiWidgetCreated", retention_days: 30, action: "archive" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "api-retention");

    const fetched = await request(port, "GET", "/api/events/retention-policies/api-retention", auth());
    assert.equal(fetched.status, 200);
    assert.ok("candidates" in fetched.body.stats);

    const applied = await request(port, "POST", "/api/events/retention-policies/api-retention/apply", { ...auth(), body: { dry_run: true } });
    assert.equal(applied.status, 200);
    assert.equal(applied.body.dry_run, true);

    const stats = await request(port, "GET", "/api/events/retention/stats", auth());
    assert.equal(stats.status, 200);
    assert.ok(stats.body.policies >= 1);
  });

  test("dead letters list and report stats", async () => {
    const list = await request(port, "GET", "/api/events/dead-letters", auth());
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body.items));
    const stats = await request(port, "GET", "/api/events/dead-letters/stats", auth());
    assert.equal(stats.status, 200);
    assert.ok("open" in stats.body);
  });

  test("bulk retry requeues the requested dead letters", async () => {
    const tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    const ids = [];
    for (let i = 0; i < 2; i += 1) {
      const result = run(
        db,
        `INSERT INTO event_dead_letters
          (event_ref, event_type_code, event_version, subscriber, handler, attempts, error_category, error_message,
           failure_at, payload_json, security_classification, status, tenant_id, created_at, updated_at)
         VALUES (?, 'WidgetApiBulk', 1, 'test', 'test.api-bulk', 1, 'technical', 'manual', ?, '{}', 'internal', 'open', ?, ?, ?)`,
        [`EVT-API-BULK-${i}`, ts, tenantId, ts, ts]
      );
      ids.push(Number(result.lastInsertRowid));
    }

    const result = await request(port, "POST", "/api/events/dead-letters/bulk-retry", { ...auth(), body: { ids } });
    assert.equal(result.status, 200);
    assert.equal(result.body.requested, 2);
    assert.equal(result.body.retried, 2);
    assert.equal(result.body.failed, 0);

    const stats = await request(port, "GET", "/api/events/dead-letters/stats", auth());
    assert.ok(stats.body.retrying >= 2);
  });

  test("denied access emits a SecurityAccessDenied platform event", async () => {
    const denied = await request(port, "GET", "/api/events/event-types", { token: userToken });
    assert.equal(denied.status, 403);
    const event = queryOne(
      db,
      "SELECT * FROM event_records WHERE event_type_code = 'SecurityAccessDenied' ORDER BY id DESC LIMIT 1"
    );
    assert.ok(event, "SecurityAccessDenied event is stored");
    assert.equal(event.security_classification, "confidential");
    assert.equal(event.source_module, "iam");
  });

  test("monitoring exposes dashboard, health, breakdowns and traceability", async () => {
    for (const path of [
      "/api/events/monitoring/dashboard",
      "/api/events/monitoring/throughput",
      "/api/events/monitoring/failures",
      "/api/events/monitoring/latency",
      "/api/events/monitoring/ordering",
      "/api/events/monitoring/health",
    ]) {
      const res = await request(port, "GET", path, auth());
      assert.equal(res.status, 200, path);
    }
    const dashboard = await request(port, "GET", "/api/events/monitoring/dashboard", auth());
    assert.ok(dashboard.body.events.published >= 1);
    const health = await request(port, "GET", "/api/events/monitoring/health", auth());
    assert.equal(health.body.provider, "database");
  });

  test("/api/v1 alias serves the same router", async () => {
    const res = await request(port, "GET", "/api/v1/events/meta", auth());
    assert.equal(res.status, 200);
    assert.ok(res.body.categories.length >= 1);
    const list = await request(port, "GET", "/api/v1/events/event-types?pageSize=1", auth());
    assert.equal(list.status, 200);
    assert.ok(list.body.total >= 1);
  });
});
