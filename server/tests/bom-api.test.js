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

describe("BOM Engine REST APIs", () => {
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
    const res = await request(port, "GET", "/api/v1/bom/meta");
    assert.equal(res.status, 401);
  });

  test("denies a reader without BOM privileges", async () => {
    const res = await request(port, "GET", "/api/v1/bom/boms", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the BOM capability vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/bom/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "bom");
    assert.ok(res.body.capabilities.bom_types.includes("EBOM"));
    assert.ok(res.body.capabilities.revision_statuses.includes("RELEASED"));
    assert.ok(res.body.vocabularies);
  });

  test("reports health, metrics and configuration", async () => {
    const health = await request(port, "GET", "/api/v1/bom/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.ok(health.body.counts.boms >= 1);

    const metrics = await request(port, "GET", "/api/v1/bom/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.totals.boms >= 1);

    const config = await request(port, "GET", "/api/v1/bom/config", { token: adminToken });
    assert.equal(config.status, 200);
    assert.equal(config.body.default_uom, "EA");

    const units = await request(port, "GET", "/api/v1/bom/units", { token: adminToken });
    assert.equal(units.status, 200);
    assert.ok(units.body.items.some((unit) => unit.code === "EA"));
  });

  test("lists seeded BOMs and rejects duplicate creation", async () => {
    const list = await request(port, "GET", "/api/v1/bom/boms", { token: adminToken });
    assert.equal(list.status, 200);
    assert.equal(list.body.source_module, "bom");
    assert.ok(list.body.items.some((bom) => bom.bom_number === "DEMO-EBOM-PUMP"));

    const created = await request(port, "POST", "/api/v1/bom/boms", {
      token: adminToken,
      body: { bom_number: "API-BOM-001", name: "API BOM", bom_type: "EBOM" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.bom_number, "API-BOM-001");

    const duplicate = await request(port, "POST", "/api/v1/bom/boms", {
      token: adminToken,
      body: { bom_number: "API-BOM-001", name: "duplicate", bom_type: "EBOM" },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, "BOM_CONFLICT");
    assert.ok(duplicate.body.error);
  });

  test("returns a standardized 404 for an unknown BOM", async () => {
    const res = await request(port, "GET", "/api/v1/bom/boms/DOES-NOT-EXIST", { token: adminToken });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, "BOM_NOT_FOUND");
  });

  test("drives revisions, lines, structure and analysis end to end", async () => {
    const bom = await request(port, "GET", "/api/v1/bom/boms/API-BOM-001", { token: adminToken });
    assert.equal(bom.status, 200);

    const revision = await request(port, "POST", `/api/v1/bom/boms/${bom.body.id}/revisions`, {
      token: adminToken,
      body: { revision_number: "A1" },
    });
    assert.equal(revision.status, 201);
    const revisionId = revision.body.id;

    const line = await request(port, "POST", `/api/v1/bom/revisions/${revisionId}/lines`, {
      token: adminToken,
      body: { child_object_id: "API-CHILD-1", quantity: 4, uom: "EA", find_number: "10", usage: "DESIGN" },
    });
    assert.equal(line.status, 201);
    assert.equal(line.body.child_object_id, "API-CHILD-1");

    const invalidLine = await request(port, "POST", `/api/v1/bom/revisions/${revisionId}/lines`, {
      token: adminToken,
      body: { child_object_id: "API-CHILD-2", quantity: -1, uom: "EA" },
    });
    assert.equal(invalidLine.status, 400);
    assert.equal(invalidLine.body.code, "BOM_QUANTITY_INVALID");

    await request(port, "PUT", `/api/v1/bom/lines/${line.body.id}/attributes`, {
      token: adminToken,
      body: { attributes: [{ attribute_code: "finish", value: "anodized" }] },
    });
    const attributes = await request(port, "GET", `/api/v1/bom/lines/${line.body.id}/attributes`, { token: adminToken });
    assert.equal(attributes.body.items.length, 1);

    const lines = await request(port, "GET", `/api/v1/bom/revisions/${revisionId}/lines`, { token: adminToken });
    assert.equal(lines.status, 200);
    assert.equal(lines.body.total, 1);

    const tree = await request(port, "GET", `/api/v1/bom/revisions/${revisionId}/tree`, { token: adminToken });
    assert.equal(tree.status, 200);
    assert.equal(tree.body.line_count, 1);

    const rollup = await request(port, "POST", `/api/v1/bom/revisions/${revisionId}/rollup`, {
      token: adminToken,
      body: { options: { includeOptional: true } },
    });
    assert.equal(rollup.status, 200);
    assert.equal(rollup.body.line_count, 1);

    const validation = await request(port, "POST", `/api/v1/bom/revisions/${revisionId}/validate`, {
      token: adminToken,
      body: {},
    });
    assert.equal(validation.status, 200);
    assert.ok(["PASS", "WARNING"].includes(validation.body.status));

    const whereUsed = await request(port, "GET", "/api/v1/bom/where-used/API-CHILD-1", { token: adminToken });
    assert.equal(whereUsed.status, 200);
    assert.equal(whereUsed.body.total, 1);
  });

  test("compares two revisions and lists the results", async () => {
    const bom = await request(port, "GET", "/api/v1/bom/boms/API-BOM-001", { token: adminToken });
    const revisions = await request(port, "GET", `/api/v1/bom/boms/${bom.body.id}/revisions`, { token: adminToken });
    const source = revisions.body.items[0];
    const revised = await request(port, "POST", `/api/v1/bom/revisions/${source.id}/revise`, {
      token: adminToken,
      body: { revision_number: "B1" },
    });
    assert.equal(revised.status, 201);

    const comparison = await request(port, "POST", "/api/v1/bom/compare", {
      token: adminToken,
      body: { left_kind: "REVISION", left_id: source.id, right_kind: "REVISION", right_id: revised.body.revision.id },
    });
    assert.equal(comparison.status, 201);
    assert.ok(comparison.body.comparison.comparison_ref);

    const detail = await request(port, "GET", `/api/v1/bom/comparisons/${comparison.body.comparison.comparison_ref}`, { token: adminToken });
    assert.equal(detail.status, 200);
    assert.ok(detail.body.summary);
  });

  test("exposes baselines, transformations, history and search metadata", async () => {
    const baselines = await request(port, "GET", "/api/v1/bom/baselines", { token: adminToken });
    assert.equal(baselines.status, 200);
    assert.ok(baselines.body.items.some((baseline) => baseline.baseline_number === "DEMO-EBOM-PUMP-BL-A"));

    const transformations = await request(port, "GET", "/api/v1/bom/transformations", { token: adminToken });
    assert.equal(transformations.status, 200);
    assert.ok(transformations.body.items.some((definition) => definition.code === "EBOM_TO_MBOM_DEMO"));

    const history = await request(port, "GET", "/api/v1/bom/history", { token: adminToken });
    assert.equal(history.status, 200);
    assert.ok(Array.isArray(history.body.items));

    const searchMeta = await request(port, "GET", "/api/v1/bom/search-meta", { token: adminToken });
    assert.equal(searchMeta.status, 200);
    assert.ok(searchMeta.body.object_types.some((entry) => entry.code === "bom"));
  });

  test("submits a background rollup job with idempotency", async () => {
    const bom = await request(port, "GET", "/api/v1/bom/boms/DEMO-EBOM-PUMP", { token: adminToken });
    const revisions = await request(port, "GET", `/api/v1/bom/boms/${bom.body.id}/revisions`, { token: adminToken });
    const revisionId = revisions.body.items[0].id;

    const first = await request(port, "POST", "/api/v1/bom/jobs/rollup", {
      token: adminToken,
      body: { revision_id: revisionId },
      headers: { "Idempotency-Key": "bom-api-rollup-1" },
    });
    assert.equal(first.status, 202);
    assert.ok(first.body.job_ref || first.body.id);

    const second = await request(port, "POST", "/api/v1/bom/jobs/rollup", {
      token: adminToken,
      body: { revision_id: revisionId },
      headers: { "Idempotency-Key": "bom-api-rollup-1" },
    });
    assert.equal(second.status, 202);
    assert.equal(second.body.id ?? second.body.job_id, first.body.id ?? first.body.job_id);
  });
});
