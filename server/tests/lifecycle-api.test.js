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
          "Content-Type": "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try {
            json = data ? JSON.parse(data) : null;
          } catch {
            json = data;
          }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe("lifecycle REST APIs", () => {
  let port;
  let server;
  let token;

  before(async () => {
    const database = openDatabase(":memory:");
    migrate(database);
    seedDatabase(database);
    const started = await listen(createApp(database));
    server = started.server;
    port = started.port;
    const login = await request(port, "POST", "/api/auth/login", {
      body: { username: "admin", password: "HelixAdmin!42" },
    });
    assert.equal(login.status, 200);
    token = login.body.token;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  test("requires authentication", async () => {
    const res = await request(port, "GET", "/api/statuses");
    assert.equal(res.status, 401);
  });

  test("exposes configuration catalogs", async () => {
    const statuses = await request(port, "GET", "/api/statuses", { token });
    assert.equal(statuses.status, 200);
    assert.equal(statuses.body.total, 6);

    const definitions = await request(port, "GET", "/api/lifecycle-definitions", { token });
    assert.equal(definitions.status, 200);
    assert.ok(definitions.body.items.some((d) => d.code === "product-lifecycle"));

    const published = definitions.body.items.find((d) => d.code === "product-lifecycle");
    const validate = await request(port, "GET", `/api/lifecycle-definitions/${published.id}/validate`, { token });
    assert.equal(validate.status, 200);
    assert.equal(validate.body.valid, true);

    const assignments = await request(port, "GET", "/api/lifecycle-assignments", { token });
    assert.equal(assignments.status, 200);
    assert.ok(assignments.body.items.some((a) => a.type_code === "product"));

    const rules = await request(port, "GET", "/api/approval-rules", { token });
    assert.equal(rules.status, 200);
    assert.ok(rules.body.items.some((r) => r.code === "product-approval"));
  });

  test("creates a tenant status with validation", async () => {
    const invalid = await request(port, "POST", "/api/statuses", {
      token,
      body: { code: "BAD", name: "Bad" },
    });
    assert.equal(invalid.status, 400);

    const created = await request(port, "POST", "/api/statuses", {
      token,
      body: { code: "on-hold", name: "On Hold", category: "in_review", module: "pdm" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "on-hold");
    assert.equal(created.body.legacy_status, "active");
  });

  test("drives an object through the lifecycle and approvals", async () => {
    const view = await request(port, "GET", "/api/objects/PROD-1000/lifecycle", { token });
    assert.equal(view.status, 200);
    assert.equal(view.body.state.code, "draft");
    assert.ok(view.body.transitions.some((t) => t.code === "submit"));

    const submit = await request(port, "POST", "/api/objects/PROD-1000/transitions", {
      token,
      body: { transition: "submit" },
    });
    assert.equal(submit.status, 200);
    assert.equal(submit.body.gated, false);
    assert.equal(submit.body.state.code, "in-review");

    const release = await request(port, "POST", "/api/objects/PROD-1000/release", {
      token,
      body: { transition: "approve", comments: "Ship it" },
    });
    assert.equal(release.status, 201);
    assert.equal(release.body.status, "pending");
    assert.equal(release.body.approvals.length, 1);

    const releases = await request(port, "GET", "/api/objects/PROD-1000/releases", { token });
    assert.equal(releases.status, 200);
    assert.equal(releases.body.total, 1);

    const approvalId = release.body.approvals[0].id;
    const decided = await request(port, "POST", `/api/objects/PROD-1000/approvals/${approvalId}`, {
      token,
      body: { decision: "approve", comment: "Approved" },
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.body.status, "approved");

    const after = await request(port, "GET", "/api/objects/PROD-1000/lifecycle", { token });
    assert.equal(after.body.state.code, "approved");

    const history = await request(port, "GET", "/api/objects/PROD-1000/status-history", { token });
    assert.equal(history.status, 200);
    assert.ok(history.body.total >= 3);
  });

  test("returns 409 when driving a transition that is not allowed", async () => {
    const res = await request(port, "POST", "/api/objects/BOM-1000/transitions", {
      token,
      body: { transition: "submit" },
    });
    assert.equal(res.status, 409);
  });
});
