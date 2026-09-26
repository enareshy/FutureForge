process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate, queryOne, run } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import * as search from "../services/search.js";

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
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
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

describe("Enterprise Search Foundation v1", () => {
  let db;
  let server;
  let port;
  let admin;
  let adminToken;
  let tenantId;

  before(async () => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    admin = queryOne(db, "SELECT * FROM users WHERE username = 'admin'");
    tenantId = admin.tenant_id ?? admin.organization_id;
    search.initializeSearch(db);
    search.reindexTenant(db, { tenantId, limit: 1000 }, admin, "test");
    const started = await listen(createApp(db));
    server = started.server;
    port = started.port;
    adminToken = (
      await request(port, "POST", "/api/auth/login", {
        body: { username: "admin", password: "HelixAdmin!42" },
      })
    ).body.token;
  });

  after(() => {
    server?.close();
    db?.close();
  });

  test("returns a canonical, provider-independent result shape", () => {
    const result = search.searchObjects(db, { text: "compressor" }, admin, { tenantId, recordHistory: false });
    assert.ok(result.total >= 1);
    assert.ok(result.pageSize >= 1);
    assert.ok(Array.isArray(result.results));
    const first = result.results[0];
    assert.equal(typeof first.objectType, "string");
    assert.equal(typeof first.objectId, "string");
    assert.equal(typeof first.title, "string");
    assert.ok(Array.isArray(first.matchedFields));
  });

  test("parses advanced query syntax into a canonical query", () => {
    const parsed = search.parseQuery({ text: 'object_type:object AND (compressor OR pump)' });
    assert.ok(parsed.operators.includes("CONTAINS"));
    assert.ok(parsed.extendedOperators.includes("FULL_TEXT"));
    assert.equal(parsed.parsed.boolean, true);
    assert.ok(parsed.parsed.attributes.some((filter) => filter.field === "object_type"));
  });

  test("rejects unknown fields with a standard error code", () => {
    assert.throws(
      () =>
        search.searchObjects(
          db,
          { filters: [{ field: "no_such_field", operator: "EQ", value: "x" }] },
          admin,
          { tenantId, recordHistory: false }
        ),
      (err) => err.code === "SEARCH_INVALID_FIELD"
    );
  });

  test("rejects invalid operator / data type combinations", () => {
    assert.throws(
      () =>
        search.searchObjects(
          db,
          { filters: [{ field: "organization_id", operator: "CONTAINS", value: "1" }] },
          admin,
          { tenantId, recordHistory: false }
        ),
      (err) => err.code === "SEARCH_INVALID_OPERATOR"
    );
  });

  test("guards overly broad wildcard patterns", () => {
    assert.throws(
      () =>
        search.searchObjects(
          db,
          { filters: [{ field: "title", operator: "WILDCARD", value: "*" }] },
          admin,
          { tenantId, recordHistory: false }
        ),
      (err) => err.code === "SEARCH_WILDCARD_TOO_BROAD"
    );
  });

  test("count matches the search total", () => {
    const count = search.countObjects(db, { text: "compressor" }, admin, { tenantId });
    const result = search.searchObjects(db, { text: "compressor" }, admin, { tenantId, recordHistory: false });
    assert.equal(count.total, result.total);
  });

  test("exposes registered objects and their field catalog", () => {
    const listed = search.listSearchObjects(db, admin, { tenantId });
    assert.ok(listed.objects.some((type) => type.code === "object"));
    const detail = search.getSearchObject(db, "object", admin, { tenantId });
    assert.equal(detail.objectType.code, "object");
    assert.ok(detail.fields.some((field) => field.field === "title"));
  });

  test("manages field definitions", () => {
    const created = search.createField(
      db,
      { objectType: "object", field: "test_attribute", dataType: "string", filterable: true },
      admin,
      { tenantId }
    );
    assert.equal(created.field, "test_attribute");
    assert.ok(search.listFields(db, admin, { tenantId, objectType: "object" }).fields.some((f) => f.field === "test_attribute"));
    const removed = search.removeField(db, "object", "test_attribute", admin, { tenantId });
    assert.equal(removed.deleted, true);
  });

  test("filters results by an as-of effectivity window", () => {
    const row = queryOne(
      db,
      "SELECT * FROM search_index WHERE tenant_id = ? AND object_type = 'object' ORDER BY id LIMIT 1",
      [tenantId]
    );
    assert.ok(row);
    const baseline = search.searchObjects(db, {}, admin, { tenantId, recordHistory: false });
    run(db, "UPDATE search_index SET attributes_json = ? WHERE id = ?", [
      JSON.stringify({ effective_from: "2099-01-01" }),
      row.id,
    ]);
    try {
      const filtered = search.searchObjects(
        db,
        { effectivity: { asOfDate: "2050-01-01" } },
        admin,
        { tenantId, recordHistory: false }
      );
      assert.equal(filtered.total, baseline.total - 1);
    } finally {
      run(db, "UPDATE search_index SET attributes_json = ? WHERE id = ?", [row.attributes_json, row.id]);
    }
  });

  test("indexes extracted text through the content integration contract", () => {
    const row = queryOne(
      db,
      "SELECT * FROM search_index WHERE tenant_id = ? AND object_type = 'object' ORDER BY id LIMIT 1",
      [tenantId]
    );
    assert.ok(row);
    search.putObjectExtractedText(
      db,
      { objectType: "object", objectId: row.object_id, text: "zzqextractedtoken fastener steel" },
      admin,
      { tenantId }
    );
    const found = search.searchObjects(db, { text: "zzqextractedtoken" }, admin, { tenantId, recordHistory: false });
    assert.ok(found.total >= 1);
    const listed = search.getObjectExtractedText(db, admin, {
      tenantId,
      objectType: "object",
      objectId: row.object_id,
    });
    assert.ok(listed.items.some((item) => item.objectType === "object"));
    search.removeObjectExtractedText(db, { objectType: "object", objectId: row.object_id }, admin, { tenantId });
  });

  test("saved search canonical round-trip", () => {
    const saved = search.createSaved(db, { name: "v1 compressor", query: { text: "compressor" } }, admin, { tenantId });
    const runResult = search.runSaved(db, saved.uuid, {}, admin, { tenantId });
    assert.ok(runResult.total >= 1);
    const fetched = search.getSaved(db, saved.uuid, admin, { tenantId });
    assert.equal(fetched.name, "v1 compressor");
    search.removeSaved(db, saved.uuid, admin, { tenantId });
  });

  test("V1 REST: search, count, parse and objects", async () => {
    const res = await request(port, "POST", "/api/v1/search", { token: adminToken, body: { text: "compressor" } });
    assert.equal(res.status, 200);
    assert.ok(res.body.total >= 1);
    assert.ok(Array.isArray(res.body.results));

    const count = await request(port, "POST", "/api/v1/search/count", { token: adminToken, body: { text: "compressor" } });
    assert.equal(count.status, 200);
    assert.equal(count.body.total, res.body.total);

    const parsed = await request(port, "POST", "/api/v1/search/parse", {
      token: adminToken,
      body: { text: 'object_type:object AND compressor' },
    });
    assert.equal(parsed.status, 200);
    assert.ok(parsed.body.query);

    const objects = await request(port, "GET", "/api/v1/search/objects", { token: adminToken });
    assert.equal(objects.status, 200);
    assert.ok(objects.body.objects.some((type) => type.code === "object"));

    const detail = await request(port, "GET", "/api/v1/search/objects/object", { token: adminToken });
    assert.equal(detail.status, 200);
    assert.ok(detail.body.fields.length >= 1);
  });

  test("V1 REST: facets, suggestions and history", async () => {
    const facets = await request(port, "GET", "/api/v1/search/facets?q=compressor", { token: adminToken });
    assert.equal(facets.status, 200);
    assert.ok(facets.body.facets.some((facet) => facet.name === "object_type"));

    const suggestions = await request(port, "GET", "/api/v1/search/suggestions?q=comp", { token: adminToken });
    assert.equal(suggestions.status, 200);
    assert.ok(Array.isArray(suggestions.body.suggestions));

    const history = await request(port, "GET", "/api/v1/search/history", { token: adminToken });
    assert.equal(history.status, 200);
    assert.ok(Array.isArray(history.body.history));
  });

  test("V1 REST: saved searches lifecycle", async () => {
    const created = await request(port, "POST", "/api/v1/search/saved", {
      token: adminToken,
      body: { name: "v1 api saved", query: { text: "compressor" }, sharing_scope: "tenant" },
    });
    assert.equal(created.status, 201);
    const uuid = created.body.uuid;

    const listed = await request(port, "GET", "/api/v1/search/saved", { token: adminToken });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.savedSearches.some((item) => item.uuid === uuid));

    const executed = await request(port, "POST", `/api/v1/search/saved/${uuid}/execute`, {
      token: adminToken,
      body: {},
    });
    assert.equal(executed.status, 200);
    assert.ok(executed.body.total >= 1);

    const removed = await request(port, "DELETE", `/api/v1/search/saved/${uuid}`, { token: adminToken });
    assert.equal(removed.status, 200);
  });

  test("V1 REST: index status, health, metrics and meta", async () => {
    const status = await request(port, "GET", "/api/v1/search/index/status", { token: adminToken });
    assert.equal(status.status, 200);
    assert.ok(status.body.status.documents_total >= 1);

    const health = await request(port, "GET", "/api/v1/search/health", { token: adminToken });
    assert.equal(health.status, 200);

    const metrics = await request(port, "GET", "/api/v1/search/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);

    const meta = await request(port, "GET", "/api/v1/search/meta", { token: adminToken });
    assert.equal(meta.status, 200);
    assert.ok(meta.body.operators.includes("BETWEEN"));
    assert.ok(meta.body.rankingStrategies.includes("text"));
  });

  test("V1 REST: structured error codes", async () => {
    const res = await request(port, "POST", "/api/v1/search", {
      token: adminToken,
      body: { filters: [{ field: "ghost", operator: "EQ", value: "x" }] },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "SEARCH_INVALID_FIELD");
  });
});
