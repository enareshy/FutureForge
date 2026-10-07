process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, openTestDatabase, queryOne } from "../db.js";
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

describe("Generic Traceability Engine REST APIs", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let readerToken;
  let ids;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    const objectId = (code, type) =>
      queryOne(
        db,
        `SELECT o.id FROM objects o JOIN metadata_types t ON t.id = o.object_type_id
          WHERE o.code = ? AND t.code = ? LIMIT 1`,
        [code, type]
      )?.id;
    ids = {
      product: objectId("PROD-1000", "product"),
      product2: objectId("PROD-2000", "product"),
      revisionA: objectId("PROD-1000-A", "product-revision"),
      bom: objectId("BOM-1000", "bom"),
      document: objectId("DOC-1000", "document"),
    };
    assert.ok(ids.product && ids.product2 && ids.revisionA && ids.bom && ids.document, "seeded objects present");
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
    const res = await request(port, "GET", "/api/v1/traceability/meta");
    assert.equal(res.status, 401);
  });

  test("denies a reader without Digital Thread privileges", async () => {
    const res = await request(port, "GET", "/api/v1/traceability/meta", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the traceability capability vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/traceability/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "traceability");
    assert.equal(res.body.resources.overview, "iam.thread.overview");
    assert.equal(res.body.resources.traceability, "iam.thread.traceability");
    assert.ok(res.body.broken_link_reasons.TARGET_OBSOLETE);
    assert.ok(res.body.broken_link_reasons.RELATIONSHIP_INACTIVE);
  });

  test("reports an aggregate health status", async () => {
    const res = await request(port, "GET", "/api/v1/traceability/health", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "traceability");
    assert.ok(["OK", "DEGRADED"].includes(res.body.status));
    assert.ok(Number.isFinite(res.body.overall_coverage));
    assert.ok(Number.isFinite(res.body.expected));
    assert.ok(Number.isFinite(res.body.broken_links));

    const config = await request(port, "GET", "/api/v1/traceability/config", { token: adminToken });
    assert.equal(config.status, 200);
    assert.equal(config.body.max_traversal_depth, 25);
  });

  test("traverses forward, backward and one-hop neighbours", async () => {
    const forward = await request(port, "GET", `/api/v1/traceability/product/${ids.product}/forward?include_inactive=true`, { token: adminToken });
    assert.equal(forward.status, 200, forward.text);
    assert.equal(forward.body.root.node_ref, `product:${ids.product}`);
    assert.ok(forward.body.node_count >= 2);

    const children = await request(port, "GET", `/api/v1/traceability/product/${ids.product}/children?include_inactive=true`, { token: adminToken });
    assert.equal(children.status, 200, children.text);
    assert.ok(children.body.node_count >= 1);

    const backward = await request(port, "GET", `/api/v1/traceability/product-revision/${ids.revisionA}/backward?include_inactive=true`, { token: adminToken });
    assert.equal(backward.status, 200, backward.text);
    assert.equal(backward.body.root.node_ref, `product-revision:${ids.revisionA}`);

    const links = await request(port, "GET", `/api/v1/traceability/product/${ids.product}/links`, { token: adminToken });
    assert.equal(links.status, 200, links.text);
    assert.equal(links.body.source_module, "traceability");
    assert.ok(links.body.total >= 1);
  });

  test("returns a graph, shortest path and impact analysis", async () => {
    const graph = await request(port, "GET", `/api/v1/traceability/graph?objectType=product&objectId=${ids.product}&include_inactive=true`, { token: adminToken });
    assert.equal(graph.status, 200, graph.text);
    assert.ok(graph.body.node_count >= 1);

    const path = await request(
      port,
      "GET",
      `/api/v1/traceability/path?source=${encodeURIComponent(`product:${ids.product}`)}&target=${encodeURIComponent(`bom:${ids.bom}`)}&include_inactive=true`,
      { token: adminToken }
    );
    assert.equal(path.status, 200, path.text);
    assert.equal(path.body.found, true);
    assert.ok(path.body.path_count >= 1);

    const impact = await request(port, "POST", "/api/v1/traceability/impact-analysis", {
      token: adminToken,
      body: { objectType: "product", objectId: ids.product, include_inactive: true },
    });
    assert.equal(impact.status, 200, impact.text);
    assert.ok(Number.isFinite(impact.body.impact_summary.impacted_count));
  });

  test("projects the traceability matrix, coverage, orphans and broken links", async () => {
    const matrix = await request(port, "GET", `/api/v1/traceability/matrix?objectType=product&objectId=${ids.product}&include_inactive=true`, { token: adminToken });
    assert.equal(matrix.status, 200, matrix.text);
    assert.ok(Array.isArray(matrix.body.matrix));

    const coverage = await request(port, "GET", "/api/v1/traceability/coverage", { token: adminToken });
    assert.equal(coverage.status, 200);
    assert.ok(Number.isFinite(coverage.body.overall_coverage));
    assert.ok(Array.isArray(coverage.body.rules));

    const orphans = await request(port, "GET", "/api/v1/traceability/orphans", { token: adminToken });
    assert.equal(orphans.status, 200);
    assert.ok(Array.isArray(orphans.body.items));

    const broken = await request(port, "GET", "/api/v1/traceability/broken-links", { token: adminToken });
    assert.equal(broken.status, 200);
    assert.ok(Array.isArray(broken.body.items));
    assert.ok(broken.body.counts_by_reason);
  });

  test("creates, updates and deletes a trace link", async () => {
    const created = await request(port, "POST", "/api/v1/traceability/links", {
      token: adminToken,
      body: {
        relationshipType: "document.references-item",
        sourceObject: { objectType: "document", objectId: ids.document },
        targetObject: { objectType: "product", objectId: ids.product2 },
        effectivity: { start: "2026-01-01" },
      },
    });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.source.id, ids.document);
    assert.equal(created.body.target.id, ids.product2);
    assert.equal(created.body.valid_from, "2026-01-01");
    const linkId = created.body.id;

    const read = await request(port, "GET", `/api/v1/traceability/links/${linkId}`, { token: adminToken });
    assert.equal(read.status, 200, read.text);
    assert.equal(read.body.id, linkId);

    const updated = await request(port, "PUT", `/api/v1/traceability/links/${linkId}`, {
      token: adminToken,
      body: { valid_to: "2026-12-31", sequence: 5 },
    });
    assert.equal(updated.status, 200, updated.text);
    assert.equal(updated.body.valid_to, "2026-12-31");
    assert.equal(updated.body.sequence, 5);

    const list = await request(port, "GET", `/api/v1/traceability/document/${ids.document}/links`, { token: adminToken });
    assert.equal(list.status, 200, list.text);
    assert.ok(list.body.outgoing.some((item) => item.id === linkId));

    const removed = await request(port, "DELETE", `/api/v1/traceability/links/${linkId}`, { token: adminToken });
    assert.equal(removed.status, 200, removed.text);
    assert.equal(removed.body.deleted, true);

    const after = await request(port, "GET", `/api/v1/traceability/document/${ids.document}/links`, { token: adminToken });
    assert.equal(after.status, 200);
    assert.ok(!after.body.outgoing.some((item) => item.id === linkId));
  });
});
