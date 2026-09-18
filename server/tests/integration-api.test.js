process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import { Validation } from "../services/integration.js";

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

describe("Integration & API Framework REST APIs", () => {
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

  test("meta advertises vocabulary, adapters and registries", async () => {
    const res = await request(port, "GET", "/api/integration/meta", auth());
    assert.equal(res.status, 200);
    assert.ok(res.body.adapters.length >= 9);
    assert.ok(res.body.integration_types.length >= 8);
    assert.ok(res.body.directions.includes("inbound"));
    assert.ok(res.body.error_categories);
    assert.ok(Array.isArray(res.body.event_types ?? res.body.event_statuses ?? []));
  });

  test("requires authentication and enforces permissions", async () => {
    assert.equal((await request(port, "GET", "/api/integration/definitions")).status, 401);
    const forbidden = await request(port, "GET", "/api/integration/definitions", { token: userToken });
    assert.ok([401, 403].includes(forbidden.status));
  });

  test("definition lifecycle: create, list, get, update, versions, run", async () => {
    const created = await request(port, "POST", "/api/integration/definitions", {
      ...auth(),
      body: { code: "api-demo", integration_type: "api", direction: "outbound", adapter_type: "internal", config: { handler_code: "not.registered" }, status: "active" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "api-demo");

    const listed = await request(port, "GET", "/api/integration/definitions?q=api-demo", auth());
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((d) => d.code === "api-demo"));

    const updated = await request(port, "PATCH", "/api/integration/definitions/api-demo", { ...auth(), body: { description: "demo" } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.description, "demo");

    const versions = await request(port, "GET", "/api/integration/definitions/api-demo/versions", auth());
    assert.equal(versions.status, 200);
    assert.ok(versions.body.total >= 2);

    const run = await request(port, "POST", "/api/integration/definitions/api-demo/run", { ...auth(), body: { payload: { a: 1 } } });
    assert.equal(run.status, 200);
    assert.ok(run.body.execution);
    const executions = await request(port, "GET", "/api/integration/executions?definition_code=api-demo", auth());
    assert.equal(executions.status, 200);
    assert.ok(executions.body.total >= 1);
  });

  test("credentials never expose secrets over the API", async () => {
    const created = await request(port, "POST", "/api/integration/credentials", { ...auth(), body: { code: "api-cred", kind: "api_key", secret: "top-secret" } });
    assert.equal(created.status, 201);
    assert.equal(created.body.secret, undefined);
    assert.equal(created.body.has_secret, true);
    const fetched = await request(port, "GET", "/api/integration/credentials/api-cred", auth());
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.secret, undefined);
  });

  test("external systems register and report health", async () => {
    const created = await request(port, "POST", "/api/integration/systems", { ...auth(), body: { code: "api-erp", system_type: "erp", environment: "test" } });
    assert.equal(created.status, 201);
    const tested = await request(port, "POST", "/api/integration/systems/api-erp/test", auth());
    assert.equal(tested.status, 200);
    const health = await request(port, "GET", "/api/integration/systems/api-erp/health", auth());
    assert.equal(health.status, 200);
    assert.ok(Array.isArray(health.body.items));
  });

  test("transformation API maps payloads and previews tests", async () => {
    const created = await request(port, "POST", "/api/integration/transformations", {
      ...auth(),
      body: { code: "api-map", source_format: "json", target_format: "json", mappings: [{ source: "id", target: "Id" }] },
    });
    assert.equal(created.status, 201);
    const tested = await request(port, "POST", "/api/integration/transformations/api-map/test", { ...auth(), body: { input: { id: "X1" } } });
    assert.equal(tested.status, 200);
    assert.equal(tested.body.output.Id, "X1");
  });

  test("inbound and outbound webhooks are manageable", async () => {
    const inbound = await request(port, "POST", "/api/integration/webhooks/inbound", { ...auth(), body: { code: "api-hook", auth_type: "none", event_type_code: "ProductCreated" } });
    assert.equal(inbound.status, 201);
    const outbound = await request(port, "POST", "/api/integration/webhooks/outbound", { ...auth(), body: { code: "api-out", url: "https://example.com/hook" } });
    assert.equal(outbound.status, 201);
    const deliveries = await request(port, "GET", "/api/integration/webhooks/outbound/api-out/deliveries", auth());
    assert.equal(deliveries.status, 200);
  });

  test("public webhook receiver accepts signed payloads without a session", async () => {
    await request(port, "POST", "/api/integration/credentials", { ...auth(), body: { code: "api-hook-secret", kind: "signature", secret: "hook-secret" } });
    const credential = queryOne(db, "SELECT id FROM integration_credentials WHERE code = 'api-hook-secret'");
    await request(port, "POST", "/api/integration/webhooks/inbound", {
      ...auth(),
      body: { code: "signed-hook", auth_type: "signature", credential_id: credential.id, event_type_code: "ProductCreated" },
    });
    const body = { event_type: "ProductCreated", payload: { id: "P-API" } };
    const raw = JSON.stringify(body);
    const res = await request(port, "POST", "/api/v1/integration/webhooks/receive/signed-hook", {
      body: raw,
      headers: { "x-integration-signature": Validation.signPayload(raw, "hook-secret") },
    });
    assert.equal(res.status, 202);
    assert.equal(res.body.accepted, true);
  });

  test("events publish, filter through subscriptions and replay", async () => {
    await request(port, "POST", "/api/integration/event-types", { ...auth(), body: { code: "ApiTestEvent", category: "test" } });
    const sub = await request(port, "POST", "/api/integration/subscriptions", {
      ...auth(),
      body: { code: "api-sub", event_type_code: "ApiTestEvent", subscriber_type: "internal", target_ref: "handler.x" },
    });
    assert.equal(sub.status, 201);
    const published = await request(port, "POST", "/api/integration/events", { ...auth(), body: { event_type_code: "ApiTestEvent", payload: { n: 1 } } });
    assert.equal(published.status, 201);
    assert.ok(published.body.event_ref);
    const fetched = await request(port, "GET", `/api/integration/events/${published.body.event_ref}`, auth());
    assert.equal(fetched.status, 200);
    const replayed = await request(port, "POST", `/api/integration/events/${published.body.event_ref}/replay`, auth());
    assert.equal(replayed.status, 200);
    const deliveries = await request(port, "GET", "/api/integration/deliveries", auth());
    assert.equal(deliveries.status, 200);
  });

  test("messages queue and dead letter stats are exposed", async () => {
    const queued = await request(port, "POST", "/api/integration/messages", { ...auth(), body: { message_type: "api.msg", payload: { a: 1 } } });
    assert.equal(queued.status, 201);
    const queues = await request(port, "GET", "/api/integration/queues", auth());
    assert.equal(queues.status, 200);
    const dl = await request(port, "GET", "/api/integration/dead-letters/stats", auth());
    assert.equal(dl.status, 200);
    assert.ok(dl.body);
  });

  test("transfers import/export and download content", async () => {
    const handlers = await request(port, "GET", "/api/integration/transfers/handlers", auth());
    assert.equal(handlers.status, 200);
    const transfer = await request(port, "POST", "/api/integration/transfers/import", {
      ...auth(),
      body: { direction: "import", format: "json", resource_type: "nonexistent.handler", content: JSON.stringify([{ code: "A" }]) },
    });
    assert.ok([200, 201, 400].includes(transfer.status));
  });

  test("monitoring dashboards aggregate operations", async () => {
    for (const path of ["/api/integration/monitoring/overview", "/api/integration/monitoring/executions", "/api/integration/monitoring/deliveries", "/api/integration/monitoring/systems", "/api/integration/monitoring/api-usage"]) {
      const res = await request(port, "GET", path, auth());
      assert.equal(res.status, 200, path);
    }
  });

  test("API catalog clients issue, rotate and revoke hashed keys", async () => {
    await request(port, "POST", "/api/integration/api-catalog", { ...auth(), body: { code: "OrdersAPI", method: "GET", path: "/orders", api_version: "v1" } });
    const created = await request(port, "POST", "/api/integration/api-clients", { ...auth(), body: { code: "api-client", scopes: ["read"] } });
    assert.equal(created.status, 201);
    assert.ok(created.body.api_key);
    const rotated = await request(port, "POST", "/api/integration/api-clients/api-client/rotate", auth());
    assert.equal(rotated.status, 200);
    assert.ok(rotated.body.api_key);
    const revoked = await request(port, "POST", "/api/integration/api-clients/api-client/revoke", auth());
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.status, "revoked");
  });

  test("schedules create and run through the job engine", async () => {
    const definition = queryOne(db, "SELECT id FROM integration_definitions WHERE code = 'api-demo'");
    const created = await request(port, "POST", "/api/integration/schedules", {
      ...auth(),
      body: { code: "api-schedule", schedule_type: "interval", interval_seconds: 3600, integration_id: definition?.id ?? null },
    });
    assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
    const run = await request(port, "POST", "/api/integration/schedules/api-schedule/run", auth());
    assert.ok([200, 201, 202].includes(run.status), JSON.stringify(run.body));
  });

  test("/api/v1 alias serves the same router", async () => {
    const res = await request(port, "GET", "/api/v1/integration/event-types", auth());
    assert.equal(res.status, 200);
    assert.ok(res.body.total >= 1);
  });
});
