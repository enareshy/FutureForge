process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import { SOURCE_MODULE, VV_NODE_TYPES, VV_EVENT_TYPES, DEFAULT_METHODS } from "../services/verification-validation/index.js";

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

describe("Verification & Validation engine foundation", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let readerToken;

  before(async () => {
    db = openTestDatabase();
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
    const res = await request(port, "GET", "/api/v1/verification-validation/meta");
    assert.equal(res.status, 401);
  });

  test("denies a reader without administration privileges", async () => {
    const res = await request(port, "GET", "/api/v1/verification-validation/config", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the capability vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/verification-validation/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, SOURCE_MODULE);
    assert.equal(res.body.node_types.TEST_CASE, VV_NODE_TYPES.TEST_CASE);
    assert.ok(res.body.method_types.includes("TEST"));
    assert.ok(res.body.method_types.includes("ANALYSIS"));
    assert.ok(res.body.execution_statuses.includes("COMPLETED"));
    assert.ok(res.body.result_outcomes.includes("PASS"));
    assert.ok(res.body.requirement_vnv_statuses.includes("VERIFIED"));
    assert.equal(res.body.quality_module.source_module, "data-governance");
  });

  test("reports health and default configuration", async () => {
    const health = await request(port, "GET", "/api/v1/verification-validation/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.ok(health.body.counts);
    assert.equal(health.body.counts.methods, DEFAULT_METHODS.length);

    const config = await request(port, "GET", "/api/v1/verification-validation/config", { token: adminToken });
    assert.equal(config.status, 200);
    assert.equal(config.body.require_approved_test_case, true);
    assert.equal(config.body.impact_max_depth, 10);
    assert.equal(config.body.aggregation_rule, "ALL_MANDATORY");
  });

  test("updates configuration through the platform config store", async () => {
    const put = await request(port, "PUT", "/api/v1/verification-validation/config/require_evidence_for_pass", { token: adminToken, body: { value: false } });
    assert.equal(put.status, 200);
    assert.equal(put.body, false);
    const config = await request(port, "GET", "/api/v1/verification-validation/config", { token: adminToken });
    assert.equal(config.body.require_evidence_for_pass, false);
  });

  test("foundation ensure is idempotent", async () => {
    const first = await request(port, "POST", "/api/v1/verification-validation/foundation/ensure", { token: adminToken, body: {} });
    assert.equal(first.status, 200);
    assert.equal(first.body.event_types, 0);
    assert.equal(first.body.methods.created, 0);
    assert.equal(first.body.metadata_types.registered, 0);
    assert.equal(first.body.search.created, 0);
  });

  test("seeds the default verification/validation methods", async () => {
    const res = await request(port, "GET", "/api/v1/verification-validation/methods", { token: adminToken });
    assert.equal(res.status, 200);
    const codes = res.body.items.map((entry) => entry.code);
    for (const method of DEFAULT_METHODS) assert.ok(codes.includes(method.code), `missing method ${method.code}`);
  });

  test("creates and updates a tenant method", async () => {
    const created = await request(port, "POST", "/api/v1/verification-validation/methods", {
      token: adminToken,
      body: { code: "FIELD_TRIAL", name: "Field trial", verification_kind: "VALIDATION", method_type: "DEMONSTRATION" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "FIELD_TRIAL");
    assert.equal(created.body.verification_kind, "VALIDATION");

    const updated = await request(port, "PUT", "/api/v1/verification-validation/methods/FIELD_TRIAL", { token: adminToken, body: { name: "Field acceptance trial" } });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.name, "Field acceptance trial");
  });

  test("rejects a reader creating a method", async () => {
    const res = await request(port, "POST", "/api/v1/verification-validation/methods", {
      token: readerToken,
      body: { code: "SHOULD_NOT_EXIST", name: "Nope", method_type: "TEST" },
    });
    assert.equal(res.status, 403);
  });

  test("registers V&V metadata business-object types", () => {
    for (const code of [VV_NODE_TYPES.TEST_CASE, VV_NODE_TYPES.TEST_PROCEDURE, VV_NODE_TYPES.TEST_EXECUTION, VV_NODE_TYPES.TEST_RESULT, VV_NODE_TYPES.WAIVER]) {
      const row = db.prepare("SELECT id, status FROM metadata_types WHERE code = ? AND tenant_id IS NULL").get(code);
      assert.ok(row, `metadata type ${code} not registered`);
      assert.equal(row.status, "active");
    }
  });

  test("registers V&V domain event types", () => {
    for (const type of VV_EVENT_TYPES) {
      const row = db.prepare("SELECT id FROM event_registry WHERE code = ?").get(type.code);
      assert.ok(row, `event type ${type.code} not registered`);
    }
  });

  test("exposes V&V IAM resources", () => {
    for (const code of ["iam.verification-validation", "iam.verification-validation.test-cases", "iam.verification-validation.executions", "iam.verification-validation.admin"]) {
      const row = db.prepare("SELECT id FROM resources WHERE code = ?").get(code);
      assert.ok(row, `resource ${code} not registered`);
    }
  });
});
