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

describe("Change Management REST APIs", () => {
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
    const res = await request(port, "GET", "/api/v1/change/meta");
    assert.equal(res.status, 401);
  });

  test("denies a reader without Change Management privileges", async () => {
    const res = await request(port, "GET", "/api/v1/change/requests", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the capability vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/change/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "change");
    assert.ok(res.body.vocabulary.order_statuses.includes("RELEASED"));
  });

  test("reports health", async () => {
    const res = await request(port, "GET", "/api/v1/change/health", { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.counts);
  });

  test("drives an ECR through the full lifecycle: create, submit, screen, promote to ECO", async () => {
    const created = await request(port, "POST", "/api/v1/change/requests", {
      token: adminToken,
      body: { title: "API test ECR", category: "DESIGN", priority: "HIGH" },
    });
    assert.equal(created.status, 201);
    assert.ok(created.body.request_number.startsWith("ECR-"));
    const ref = created.body.request_ref;

    const submitted = await request(port, "POST", `/api/v1/change/requests/${ref}/submit`, { token: adminToken });
    assert.equal(submitted.status, 200);
    assert.equal(submitted.body.status, "SUBMITTED");

    const screened = await request(port, "POST", `/api/v1/change/requests/${ref}/screen`, { token: adminToken, body: { decision: "APPROVED", notes: "CCB approves" } });
    assert.equal(screened.status, 200);
    assert.equal(screened.body.status, "APPROVED");

    const promoted = await request(port, "POST", `/api/v1/change/requests/${ref}/promote`, { token: adminToken, body: { title: "API test ECO" } });
    assert.equal(promoted.status, 201);
    assert.equal(promoted.body.request.status, "PROMOTED");
    assert.ok(promoted.body.order.order_number.startsWith("ECO-"));

    const history = await request(port, "GET", `/api/v1/change/requests/${ref}/history`, { token: adminToken });
    assert.equal(history.status, 200);
    assert.ok(history.body.total >= 3);
  });

  test("drives an ECO through affected items, approval and release, producing an effectivity and baseline", async () => {
    const order = (await request(port, "POST", "/api/v1/change/orders", { token: adminToken, body: { title: "API test release order" } })).body;
    const orderRef = order.order_ref;

    const blocked = await request(port, "POST", `/api/v1/change/orders/${orderRef}/release`, { token: adminToken });
    assert.equal(blocked.status, 400);

    const affected = await request(port, "POST", `/api/v1/change/orders/${orderRef}/affected-items`, {
      token: adminToken,
      body: { object_type: "pdm_item", object_id: "DEMO-SEAL-004", disposition: "NEW_REVISION" },
    });
    assert.equal(affected.status, 201);

    await request(port, "POST", `/api/v1/change/orders/${orderRef}/submit`, { token: adminToken });
    const approved = await request(port, "POST", `/api/v1/change/orders/${orderRef}/decide`, { token: adminToken, body: { decision: "APPROVED" } });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.status, "APPROVED");

    const released = await request(port, "POST", `/api/v1/change/orders/${orderRef}/release`, { token: adminToken });
    assert.equal(released.status, 200);
    assert.equal(released.body.order.status, "RELEASED");
    assert.equal(released.body.effectivity.length, 1);

    const items = await request(port, "GET", `/api/v1/change/orders/${orderRef}/affected-items`, { token: adminToken });
    assert.equal(items.status, 200);
    assert.equal(items.body.items.length, 1);

    const notice = await request(port, "POST", "/api/v1/change/notices", { token: adminToken, body: { change_order_id: order.id, distribution: ["engineering"] } });
    assert.equal(notice.status, 201);
    assert.ok(notice.body.notice_number.startsWith("ECN-"));
    const issued = await request(port, "POST", `/api/v1/change/notices/${notice.body.notice_ref}/issue`, { token: adminToken });
    assert.equal(issued.status, 200);
    assert.equal(issued.body.status, "ISSUED");
  });

  test("404s on an unknown order and rejects an out-of-sequence decision", async () => {
    const missing = await request(port, "GET", "/api/v1/change/orders/does-not-exist", { token: adminToken });
    assert.equal(missing.status, 404);

    const order = (await request(port, "POST", "/api/v1/change/orders", { token: adminToken, body: { title: "Out of sequence" } })).body;
    const decide = await request(port, "POST", `/api/v1/change/orders/${order.order_ref}/decide`, { token: adminToken, body: { decision: "APPROVED" } });
    assert.equal(decide.status, 409);
  });
});
