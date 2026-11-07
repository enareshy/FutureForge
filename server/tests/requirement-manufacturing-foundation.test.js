process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import { normalizeRelationshipInput } from "../services/requirements/validation.js";
import {
  SOURCE_MODULE,
  MANUFACTURING_OBJECT_TYPES,
  MANUFACTURING_RELATIONSHIP_TYPES,
  REQUIREMENT_MANUFACTURING_EVENT_TYPES,
} from "../services/requirement-manufacturing/index.js";

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

describe("Requirement -> Manufacturing integration foundation", () => {
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
    const res = await request(port, "GET", "/api/v1/requirement-manufacturing/meta");
    assert.equal(res.status, 401);
  });

  test("denies a reader without integration privileges", async () => {
    const res = await request(port, "GET", "/api/v1/requirement-manufacturing/config", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the capability vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/requirement-manufacturing/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, SOURCE_MODULE);
    assert.equal(res.body.thread_provider, "requirement-manufacturing");
    const codes = res.body.allocation_types.map((entry) => entry.code);
    for (const code of ["ALLOCATED_TO", "IMPLEMENTED_BY", "REALIZED_BY", "SATISFIED_BY", "GOVERNED_BY", "CONTROLLED_BY", "REPRESENTED_BY"]) {
      assert.ok(codes.includes(code), `missing allocation type ${code}`);
    }
    assert.equal(res.body.object_types.length, MANUFACTURING_OBJECT_TYPES.length);
    assert.equal(res.body.relationship_types.length, MANUFACTURING_RELATIONSHIP_TYPES.length);
  });

  test("reports health and default configuration", async () => {
    const health = await request(port, "GET", "/api/v1/requirement-manufacturing/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.ok(health.body.counts);

    const config = await request(port, "GET", "/api/v1/requirement-manufacturing/config", { token: adminToken });
    assert.equal(config.status, 200);
    assert.equal(config.body.auto_trace_on_allocation, true);
    assert.equal(config.body.ctq_enabled, true);
    assert.equal(config.body.impact_max_depth, 10);
  });

  test("updates configuration through the platform config store", async () => {
    const put = await request(port, "PUT", "/api/v1/requirement-manufacturing/config/require_ebom_mbom_mapping", { token: adminToken, body: { value: false } });
    assert.equal(put.status, 200);
    assert.equal(put.body, false);
    const config = await request(port, "GET", "/api/v1/requirement-manufacturing/config", { token: adminToken });
    assert.equal(config.body.require_ebom_mbom_mapping, false);
  });

  test("returns the allocation target vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/requirement-manufacturing/targets", { token: adminToken });
    assert.equal(res.status, 200);
    const codes = res.body.target_types.map((entry) => entry.code);
    assert.ok(codes.includes("bom_revision"));
    assert.ok(codes.includes("operation"));
    assert.ok(codes.includes("work_center"));
  });

  test("foundation ensure is idempotent", async () => {
    const first = await request(port, "POST", "/api/v1/requirement-manufacturing/foundation/ensure", { token: adminToken, body: {} });
    assert.equal(first.status, 200);
    assert.equal(first.body.event_types, 0);
    assert.equal(first.body.object_types.created, 0);
    assert.equal(first.body.relationship_types.created, 0);
  });

  test("registers manufacturing metadata object types", async () => {
    for (const type of MANUFACTURING_OBJECT_TYPES) {
      const row = db.prepare("SELECT id, status FROM metadata_types WHERE code = ? AND tenant_id IS NULL").get(type.code);
      assert.ok(row, `metadata type ${type.code} not registered`);
      assert.equal(row.status, "active");
    }
  });

  test("registers manufacturing relationship edge types", async () => {
    for (const type of MANUFACTURING_RELATIONSHIP_TYPES) {
      const row = db.prepare("SELECT id FROM relationship_types WHERE code = ? AND tenant_id IS NULL").get(type.code);
      assert.ok(row, `relationship type ${type.code} not registered`);
    }
  });

  test("registers manufacturing domain event types", async () => {
    for (const type of REQUIREMENT_MANUFACTURING_EVENT_TYPES) {
      const row = db.prepare("SELECT id FROM event_registry WHERE code = ?").get(type.code);
      assert.ok(row, `event type ${type.code} not registered`);
    }
  });

  test("exposes manufacturing IAM resources to the administrator", async () => {
    for (const code of ["iam.requirement-manufacturing", "iam.requirement-manufacturing.allocations", "iam.requirement-manufacturing.ctq", "iam.requirement-manufacturing.admin"]) {
      const row = db.prepare("SELECT id FROM resources WHERE code = ?").get(code);
      assert.ok(row, `resource ${code} not registered`);
    }
  });

  test("accepts GOVERNED_BY and CONTROLLED_BY requirement relationship types", () => {
    for (const code of ["GOVERNED_BY", "CONTROLLED_BY"]) {
      const input = normalizeRelationshipInput({ relationship_type: code, source_id: "1", target_id: "2", target_type: "characteristic" });
      assert.equal(input.relationship_type, code);
      assert.equal(input.target_type, "characteristic");
    }
  });
});
