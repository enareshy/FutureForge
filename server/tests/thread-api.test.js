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

describe("Digital Thread REST APIs", () => {
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
    const res = await request(port, "GET", "/api/v1/digital-thread/meta");
    assert.equal(res.status, 401);
  });

  test("denies a reader without Digital Thread privileges", async () => {
    const res = await request(port, "GET", "/api/v1/digital-thread/meta", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the Digital Thread capability vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/digital-thread/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "thread");
    assert.ok(res.body.capabilities.domains.some((domain) => domain.code === "REQUIREMENT"));
    assert.ok(res.body.capabilities.domains.some((domain) => domain.code === "SERVICE"));
    assert.ok(res.body.capabilities.directions.includes("DOWNSTREAM"));
    assert.ok(res.body.capabilities.traceability_links.length >= 7);
  });

  test("reports health, metrics, activity and configuration", async () => {
    const health = await request(port, "GET", "/api/v1/digital-thread/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.equal(health.body.source_module, "thread");
    assert.equal(health.body.status, "OK");

    const metrics = await request(port, "GET", "/api/v1/digital-thread/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.counts.snapshots >= 1);
    assert.ok(metrics.body.counts.baselines >= 1);

    const activity = await request(port, "GET", "/api/v1/digital-thread/activity", { token: adminToken });
    assert.equal(activity.status, 200);
    assert.ok(Array.isArray(activity.body.items));

    const config = await request(port, "GET", "/api/v1/digital-thread/config", { token: adminToken });
    assert.equal(config.status, 200);
    assert.equal(config.body.max_traversal_depth, 25);
  });

  test("lists seeded definitions and traceability rules", async () => {
    const definitions = await request(port, "GET", "/api/v1/digital-thread/definitions", { token: adminToken });
    assert.equal(definitions.status, 200);
    assert.ok(definitions.body.items.some((entry) => entry.code === "PRODUCT-DEVELOPMENT"));

    const rules = await request(port, "GET", "/api/v1/digital-thread/rules", { token: adminToken });
    assert.equal(rules.status, 200);
    assert.ok(rules.body.items.some((rule) => rule.code === "REQ-TO-SYSTEM"));
  });

  test("returns a standardized 404 for an unknown definition", async () => {
    const res = await request(port, "GET", "/api/v1/digital-thread/definitions/DOES-NOT-EXIST", { token: adminToken });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, "THREAD_DEFINITION_NOT_FOUND");
  });

  test("traverses the seeded product thread and exports a graph", async () => {
    const snapshots = await request(port, "GET", "/api/v1/digital-thread/snapshots", { token: adminToken });
    assert.equal(snapshots.status, 200);
    const seeded = snapshots.body.items.find((entry) => entry.name === "Demonstration product thread snapshot");
    assert.ok(seeded);
    assert.ok(seeded.node_count >= 1);

    const root = `${seeded.root_object_type}:${seeded.root_object_id}`;
    const traverse = await request(port, "POST", "/api/v1/digital-thread/traverse", {
      token: adminToken,
      body: { root, direction: "DOWNSTREAM", include_inactive: true, max_depth: 5 },
    });
    assert.equal(traverse.status, 200);
    assert.equal(traverse.body.source_module, "thread");
    assert.ok(traverse.body.node_count >= 1);
    assert.equal(traverse.body.root.node_ref, root);

    const read = await request(port, "GET", `/api/v1/digital-thread/traverse?root=${encodeURIComponent(root)}&direction=DOWNSTREAM&include_inactive=true`, {
      token: adminToken,
    });
    assert.equal(read.status, 200);
    assert.ok(read.body.node_count >= 1);
  });

  test("computes traceability, impact, dependency and completeness", async () => {
    const snapshots = await request(port, "GET", "/api/v1/digital-thread/snapshots", { token: adminToken });
    const seeded = snapshots.body.items.find((entry) => entry.name === "Demonstration product thread snapshot");
    const root = `${seeded.root_object_type}:${seeded.root_object_id}`;

    const matrix = await request(port, "POST", "/api/v1/digital-thread/traceability/matrix", { token: adminToken, body: { root, include_inactive: true } });
    assert.equal(matrix.status, 200);
    assert.ok(Array.isArray(matrix.body.matrix));

    const impact = await request(port, "POST", "/api/v1/digital-thread/impact", { token: adminToken, body: { root, include_inactive: true } });
    assert.equal(impact.status, 200);
    assert.ok(Number.isFinite(impact.body.impact_summary.impacted_count));

    const dependency = await request(port, "POST", "/api/v1/digital-thread/dependency", { token: adminToken, body: { root, include_inactive: true } });
    assert.equal(dependency.status, 200);
    assert.ok(Number.isFinite(dependency.body.dependency_summary.dependency_count));

    const completeness = await request(port, "POST", "/api/v1/digital-thread/completeness", { token: adminToken, body: { root, include_inactive: true } });
    assert.equal(completeness.status, 200);
    assert.ok(Number.isFinite(completeness.body.completeness_score));
  });

  test("creates an immutable snapshot, releases a baseline and compares them", async () => {
    const snapshots = await request(port, "GET", "/api/v1/digital-thread/snapshots", { token: adminToken });
    const seeded = snapshots.body.items.find((entry) => entry.name === "Demonstration product thread snapshot");
    const root = `${seeded.root_object_type}:${seeded.root_object_id}`;

    const before = await request(port, "POST", "/api/v1/digital-thread/snapshots", {
      token: adminToken,
      body: { root, include_inactive: true, name: "API thread snapshot before" },
    });
    assert.equal(before.status, 201);
    assert.equal(before.body.status, "FROZEN");
    assert.equal(before.body.immutable, true);

    const after = await request(port, "POST", "/api/v1/digital-thread/snapshots", {
      token: adminToken,
      body: { root, include_inactive: true, name: "API thread snapshot after" },
    });
    assert.equal(after.status, 201);

    const diff = await request(port, "POST", "/api/v1/digital-thread/compare/snapshots", {
      token: adminToken,
      body: { left: before.body.id, right: after.body.id },
    });
    assert.equal(diff.status, 200);
    assert.ok(Array.isArray(diff.body.added_nodes));
    assert.ok(diff.body.summary);

    const baseline = await request(port, "POST", "/api/v1/digital-thread/baselines", {
      token: adminToken,
      body: { name: "API thread baseline", snapshot_id: before.body.id },
    });
    assert.equal(baseline.status, 201);
    assert.equal(baseline.body.status, "DRAFT");

    const released = await request(port, "POST", `/api/v1/digital-thread/baselines/${baseline.body.id}/release`, { token: adminToken });
    assert.equal(released.status, 200);
    assert.equal(released.body.status, "RELEASED");
    assert.equal(released.body.immutable, true);

    const denied = await request(port, "PATCH", `/api/v1/digital-thread/baselines/${baseline.body.id}`, {
      token: adminToken,
      body: { name: "should fail" },
    });
    assert.equal(denied.status, 409);
    assert.equal(denied.body.code, "THREAD_BASELINE_IMMUTABLE");
  });

  test("resolves paths and rebuilds the derived projection", async () => {
    const snapshots = await request(port, "GET", "/api/v1/digital-thread/snapshots", { token: adminToken });
    const seeded = snapshots.body.items.find((entry) => entry.name === "Demonstration product thread snapshot");
    const root = `${seeded.root_object_type}:${seeded.root_object_id}`;

    const paths = await request(port, "POST", "/api/v1/digital-thread/paths", {
      token: adminToken,
      body: { source: root, target: root, include_inactive: true },
    });
    assert.equal(paths.status, 200);
    assert.equal(paths.body.found, true);

    const rebuild = await request(port, "POST", "/api/v1/digital-thread/projections/rebuild", { token: adminToken, body: {} });
    assert.equal(rebuild.status, 200);
    assert.ok(rebuild.body.processed >= 0);

    const state = await request(port, "GET", "/api/v1/digital-thread/projections/state", { token: adminToken });
    assert.equal(state.status, 200);
    assert.ok(state.body.consistency);
  });

  test("validates configuration bounds", async () => {
    const invalid = await request(port, "PUT", "/api/v1/digital-thread/config/max_traversal_depth", {
      token: adminToken,
      body: { value: 9999 },
    });
    assert.equal(invalid.status, 400);

    const valid = await request(port, "PUT", "/api/v1/digital-thread/config/max_traversal_depth", {
      token: adminToken,
      body: { value: 12 },
    });
    assert.equal(valid.status, 200);
    assert.equal(valid.body, 12);
  });

  test("submits a background traversal job with idempotency", async () => {
    const snapshots = await request(port, "GET", "/api/v1/digital-thread/snapshots", { token: adminToken });
    const seeded = snapshots.body.items.find((entry) => entry.name === "Demonstration product thread snapshot");
    const root = `${seeded.root_object_type}:${seeded.root_object_id}`;

    const first = await request(port, "POST", "/api/v1/digital-thread/jobs/traverse", {
      token: adminToken,
      body: { root, options: { include_inactive: true } },
      headers: { "Idempotency-Key": "thread-api-traverse-1" },
    });
    assert.equal(first.status, 202);
    assert.ok(first.body.job_ref || first.body.id);

    const second = await request(port, "POST", "/api/v1/digital-thread/jobs/traverse", {
      token: adminToken,
      body: { root, options: { include_inactive: true } },
      headers: { "Idempotency-Key": "thread-api-traverse-1" },
    });
    assert.equal(second.status, 202);
    assert.equal(second.body.id ?? second.body.job_id, first.body.id ?? first.body.job_id);
  });

  test("exposes search metadata and domain catalog", async () => {
    const searchMeta = await request(port, "GET", "/api/v1/digital-thread/search-meta", { token: adminToken });
    assert.equal(searchMeta.status, 200);
    assert.ok(searchMeta.body.object_types.some((entry) => entry.code === "thread_snapshot"));

    const domains = await request(port, "GET", "/api/v1/digital-thread/domains", { token: adminToken });
    assert.equal(domains.status, 200);
    assert.ok(domains.body.items.some((domain) => domain.domain_code === "PART"));

    const providers = await request(port, "GET", "/api/v1/digital-thread/providers", { token: adminToken });
    assert.equal(providers.status, 200);
    assert.ok(providers.body.items.some((provider) => provider.code === "object"));
  });
});
