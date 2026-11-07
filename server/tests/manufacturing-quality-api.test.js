process.env.FILE_STORAGE_PROVIDER = "memory";

// Stage 9 — Manufacturing & Quality Intelligence REST API tests.
//
// Proves the router is mounted on both the versioned and unversioned prefixes,
// enforces authentication and IAM authorization, and returns the documented
// shapes for issues, inspections, corrective actions, readiness and summaries.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, queryOne, run, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import { createObject } from "../services/objects.js";
import { Foundation } from "../services/manufacturing-quality/index.js";

const IP = "127.0.0.1";

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
          resolve({ status: res.statusCode, body: parsed, text });
        });
      }
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function ensureType(db, code, name, module) {
  let row = queryOne(db, "SELECT id FROM metadata_types WHERE code = ? ORDER BY tenant_id NULLS LAST LIMIT 1", [code]);
  if (row) return row.id;
  row = run(db, "INSERT INTO metadata_types (code, name, module, status, tenant_id) VALUES (?, ?, ?, 'active', NULL)", [code, name, module]);
  return row.lastInsertId;
}

describe("Manufacturing & Quality REST API (Stage 9)", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let readerToken;
  let tenant;
  let actor;
  let product;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    Foundation.ensureManufacturingQualityFoundation(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    ensureType(db, "part", "Part", "plm");
    product = createObject(
      db,
      {
        type: "part",
        code: "MQAPI-PROD-1",
        name: "API product",
        status: "released",
        data: { "part.number": "MQAPI-PROD-1", "part.name": "API product", "part.category": "mechanical", "part.status": "released" },
      },
      actor,
      tenant,
      IP
    );
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
    const res = await request(port, "GET", "/api/v1/manufacturing-quality/meta");
    assert.equal(res.status, 401);
  });

  test("serves the capability vocabulary on the versioned prefix", async () => {
    const res = await request(port, "GET", "/api/v1/manufacturing-quality/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "manufacturing-quality");
    assert.ok(res.body.issue_severities.includes("CRITICAL"));
    assert.ok(res.body.readiness.checks.some((check) => check.code === "OPEN_QUALITY_ISSUES"));
    assert.ok(res.body.resources.issues);
  });

  test("serves the capability vocabulary on the unversioned prefix", async () => {
    const res = await request(port, "GET", "/api/manufacturing-quality/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "manufacturing-quality");
  });

  test("reports health and default configuration", async () => {
    const health = await request(port, "GET", "/api/v1/manufacturing-quality/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.ok(health.body.counts);

    const config = await request(port, "GET", "/api/v1/manufacturing-quality/config", { token: adminToken });
    assert.equal(config.status, 200);
    assert.equal(config.body.readiness_pass_threshold, 80);
    assert.equal(config.body.require_released_revision, true);
  });

  test("denies a reader without administration privileges on config", async () => {
    const res = await request(port, "GET", "/api/v1/manufacturing-quality/config", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("updates configuration through the platform config store", async () => {
    const put = await request(port, "PUT", "/api/v1/manufacturing-quality/config/readiness_pass_threshold", { token: adminToken, body: { value: 70 } });
    assert.equal(put.status, 200);
    assert.equal(put.body, 70);
    const config = await request(port, "GET", "/api/v1/manufacturing-quality/config", { token: adminToken });
    assert.equal(config.body.readiness_pass_threshold, 70);
  });

  test("foundation ensure is idempotent", async () => {
    const res = await request(port, "POST", "/api/v1/manufacturing-quality/foundation/ensure", { token: adminToken, body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.event_types, 0);
  });

  test("creates, reads and updates a quality issue over HTTP", async () => {
    const created = await request(port, "POST", "/api/v1/manufacturing-quality/issues", {
      token: adminToken,
      body: { title: "API non-conformance", code: "MQAPI-QI-1", severity: "HIGH", product_object_id: product.id },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "MQAPI-QI-1");
    assert.equal(created.body.status, "OPEN");

    const fetched = await request(port, "GET", "/api/v1/manufacturing-quality/issues/MQAPI-QI-1", { token: adminToken });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.body.issue_ref, created.body.issue_ref);

    const listed = await request(port, "GET", "/api/v1/manufacturing-quality/issues?severity=HIGH", { token: adminToken });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((item) => item.code === "MQAPI-QI-1"));

    const updated = await request(port, "PUT", "/api/v1/manufacturing-quality/issues/MQAPI-QI-1", {
      token: adminToken,
      body: { status: "RESOLVED", disposition: "REWORK", version: created.body.version },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.status, "RESOLVED");
    assert.equal(updated.body.version, created.body.version + 1);
  });

  test("creates an inspection and a corrective action over HTTP", async () => {
    const issue = await request(port, "GET", "/api/v1/manufacturing-quality/issues/MQAPI-QI-1", { token: adminToken });
    const inspection = await request(port, "POST", "/api/v1/manufacturing-quality/inspections", {
      token: adminToken,
      body: { title: "API final inspection", code: "MQAPI-IN-1", inspection_type: "FINAL", status: "PASSED", product_object_id: product.id, quality_issue_id: issue.body.id, sample_size: 5, passed_count: 5, failed_count: 0 },
    });
    assert.equal(inspection.status, 201);
    assert.equal(inspection.body.code, "MQAPI-IN-1");

    const action = await request(port, "POST", "/api/v1/manufacturing-quality/corrective-actions", {
      token: adminToken,
      body: { quality_issue_id: issue.body.id, title: "API corrective action", code: "MQAPI-CA-1" },
    });
    assert.equal(action.status, 201);
    assert.equal(action.body.code, "MQAPI-CA-1");
    assert.equal(action.body.status, "OPEN");

    const actions = await request(port, "GET", "/api/v1/manufacturing-quality/corrective-actions", { token: adminToken });
    assert.equal(actions.status, 200);
    assert.ok(actions.body.items.some((item) => item.code === "MQAPI-CA-1"));
  });

  test("evaluates release readiness over HTTP", async () => {
    const res = await request(port, "POST", "/api/v1/manufacturing-quality/readiness/evaluate", {
      token: adminToken,
      body: { subject_type: "PRODUCT_REVISION", subject_ref: product.id },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.evaluation.subject_type, "PRODUCT_REVISION");
    assert.ok(["PASS", "FAIL", "WARNING", "NOT_EVALUATED"].includes(res.body.evaluation.overall_result));
    assert.ok(Array.isArray(res.body.evaluation.checks));
    assert.ok(res.body.dimensions.length >= 1);

    const listed = await request(port, "GET", "/api/v1/manufacturing-quality/readiness?subject_type=PRODUCT_REVISION", { token: adminToken });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.total >= 1);

    const single = await request(port, "GET", `/api/v1/manufacturing-quality/readiness/${res.body.evaluation.evaluation_ref}`, { token: adminToken });
    assert.equal(single.status, 200);
    assert.equal(single.body.evaluation_ref, res.body.evaluation.evaluation_ref);
  });

  test("serves product summary, metrics and gap views", async () => {
    const summary = await request(port, "GET", `/api/v1/manufacturing-quality/summaries/product/${product.id}`, { token: adminToken });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.product_object_id, product.id);

    const metrics = await request(port, "GET", "/api/v1/manufacturing-quality/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.issues_by_status);

    const gaps = await request(port, "GET", "/api/v1/manufacturing-quality/summaries/gaps", { token: adminToken });
    assert.equal(gaps.status, 200);
    assert.ok(gaps.body.counts);

    const recurrence = await request(port, "GET", "/api/v1/manufacturing-quality/summaries/recurrence?windowDays=3650", { token: adminToken });
    assert.equal(recurrence.status, 200);
    assert.ok(Array.isArray(recurrence.body.patterns));
  });

  test("rejects an unknown subject with a 404", async () => {
    const res = await request(port, "POST", "/api/v1/manufacturing-quality/readiness/evaluate", {
      token: adminToken,
      body: { subject_type: "PRODUCT_REVISION", subject_ref: 999999 },
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, "MANUFACTURING_QUALITY_SUBJECT_NOT_FOUND");
  });

  test("rejects an invalid issue with a 400 and stable error code", async () => {
    const res = await request(port, "POST", "/api/v1/manufacturing-quality/issues", {
      token: adminToken,
      body: { title: "Bad severity", code: "MQAPI-QI-BAD", severity: "SEVERE" },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "MANUFACTURING_QUALITY_INVALID");
  });
});
