process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { openDatabase, migrate, queryOne } from "../db.js";
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

describe("Search & Discovery REST APIs", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let userToken;
  let tenantId;

  before(async () => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    const started = await listen(createApp(db));
    server = started.server;
    port = started.port;
    const admin = queryOne(db, "SELECT * FROM users WHERE username = 'admin'");
    tenantId = admin.tenant_id ?? admin.organization_id;
    search.reindexTenant(db, { tenantId, limit: 1000 }, admin, "test");
    adminToken = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
    userToken = (await request(port, "POST", "/api/auth/login", { body: { username: "j.patel", password: "HelixUser!42" } })).body.token;
  });

  after(() => {
    server?.close();
    db?.close();
  });

  test("meta exposes vocabulary, providers and object types", async () => {
    const res = await request(port, "GET", "/api/search/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.filter_operators.includes("contains"));
    assert.ok(res.body.providers.some((provider) => provider.name === "relational"));
    assert.ok(res.body.object_types.some((type) => type.code === "object"));
  });

  test("global search returns ranked, highlighted results", async () => {
    const res = await request(port, "GET", "/api/search?q=compressor&page_size=5", { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.total >= 1);
    assert.ok(res.body.items[0].highlights.title.includes("<mark>"));

    const posted = await request(port, "POST", "/api/search", {
      token: adminToken,
      body: { text: "compressor", object_types: ["object"] },
    });
    assert.equal(posted.status, 200);
    assert.ok(posted.body.items.every((item) => item.object_type === "object"));
  });

  test("advanced, by-type, by-attributes and by-relationship search", async () => {
    const advanced = await request(port, "POST", "/api/search/advanced", {
      token: adminToken,
      body: { condition: { operator: "and", filters: [{ field: "object_type", operator: "eq", value: "object" }] } },
    });
    assert.equal(advanced.status, 200);
    assert.ok(advanced.body.items.every((item) => item.object_type === "object"));

    const byType = await request(port, "POST", "/api/search/by-type/object", {
      token: adminToken,
      body: { text: "pump" },
    });
    assert.equal(byType.status, 200);

    const byAttributes = await request(port, "POST", "/api/search/by-attributes", {
      token: adminToken,
      body: { attributes: { status: "draft" } },
    });
    assert.equal(byAttributes.status, 200);
    assert.ok(byAttributes.body.items.length >= 1);

    const edge = queryOne(db, "SELECT * FROM object_relationships WHERE deleted_at IS NULL LIMIT 1");
    if (edge) {
      const byRelationship = await request(port, "POST", "/api/search/by-relationship", {
        token: adminToken,
        body: { related_to: { object_type: "object", object_id: edge.source_object_id, direction: "out" } },
      });
      assert.equal(byRelationship.status, 200);
    }
  });

  test("facets and suggestions", async () => {
    const facets = await request(port, "GET", "/api/search/facets?q=compressor", { token: adminToken });
    assert.equal(facets.status, 200);
    assert.ok(facets.body.facets.some((facet) => facet.field === "object_type"));

    const suggestions = await request(port, "GET", "/api/search/suggestions?q=comp", { token: adminToken });
    assert.equal(suggestions.status, 200);
    assert.ok(suggestions.body.suggestions.some((item) => item.type === "title"));
  });

  test("saved searches can be created, run, updated and deleted", async () => {
    const created = await request(port, "POST", "/api/search/saved", {
      token: adminToken,
      body: { name: "API saved search", query: { text: "compressor" }, sharing_scope: "tenant" },
    });
    assert.equal(created.status, 201);
    const uuid = created.body.uuid;

    const listed = await request(port, "GET", "/api/search/saved", { token: adminToken });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((item) => item.uuid === uuid));

    const run = await request(port, "POST", `/api/search/saved/${uuid}/run`, { token: adminToken, body: {} });
    assert.equal(run.status, 200);
    assert.ok(run.body.total >= 1);

    const shared = await request(port, "GET", `/api/search/saved/${uuid}`, { token: userToken });
    assert.equal(shared.status, 200);

    const updated = await request(port, "PATCH", `/api/search/saved/${uuid}`, {
      token: adminToken,
      body: { description: "updated" },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.description, "updated");

    const removed = await request(port, "DELETE", `/api/search/saved/${uuid}`, { token: adminToken });
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, true);
  });

  test("history is recorded and can be cleared", async () => {
    await request(port, "GET", "/api/search?q=pump", { token: adminToken });
    const listed = await request(port, "GET", "/api/search/history?limit=5", { token: adminToken });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((item) => item.query === "pump"));
    const cleared = await request(port, "DELETE", "/api/search/history", { token: adminToken });
    assert.equal(cleared.status, 200);
    assert.ok(cleared.body.cleared >= 1);
  });

  test("configuration can be read and updated", async () => {
    const initial = await request(port, "GET", "/api/search/configuration", { token: adminToken });
    assert.equal(initial.status, 200);
    const updated = await request(port, "PUT", "/api/search/configuration", {
      token: adminToken,
      body: { page_size: 25, highlight: false },
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.page_size, 25);
    await request(port, "PUT", "/api/search/configuration", { token: adminToken, body: { page_size: 20, highlight: true } });
  });

  test("index administration exposes status, failures and object types", async () => {
    const status = await request(port, "GET", "/api/search/indexes/status", { token: adminToken });
    assert.equal(status.status, 200);
    assert.ok(status.body.documents_total >= 1);

    const failures = await request(port, "GET", "/api/search/indexes/failures", { token: adminToken });
    assert.equal(failures.status, 200);
    assert.ok(Array.isArray(failures.body.items));

    const types = await request(port, "GET", "/api/search/object-types", { token: adminToken });
    assert.equal(types.status, 200);
    assert.ok(types.body.items.some((type) => type.code === "file"));

    const retry = await request(port, "POST", "/api/search/indexes/retry", { token: adminToken, body: {} });
    assert.equal(retry.status, 200);

    const drain = await request(port, "POST", "/api/search/indexes/drain", { token: adminToken, body: {} });
    assert.equal(drain.status, 200);

    const reindexed = await request(port, "POST", "/api/search/indexes/reindex", {
      token: adminToken,
      body: { object_type: "object", limit: 100 },
    });
    assert.equal(reindexed.status, 200);
    assert.ok(reindexed.body.indexed >= 1);
  });

  test("metrics and health are available to administrators", async () => {
    await request(port, "GET", "/api/search?q=pump", { token: adminToken });
    const metrics = await request(port, "GET", "/api/search/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.searches.total >= 1);

    const health = await request(port, "GET", "/api/search/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.ok(health.body.documents_indexed >= 1);
  });

  test("search exports are requested, materialised and downloaded", async () => {
    const created = await request(port, "POST", "/api/search/exports", {
      token: adminToken,
      body: { name: "API export", format: "csv", query: { text: "compressor" } },
    });
    assert.equal(created.status, 201);
    const uuid = created.body.uuid;

    const listed = await request(port, "GET", "/api/search/exports", { token: adminToken });
    assert.equal(listed.status, 200);
    const row = listed.body.items.find((item) => item.uuid === uuid);
    assert.ok(row);
    search.runExport(db, row.id);

    const download = await request(port, "GET", `/api/search/exports/${uuid}/download`, { token: adminToken });
    assert.equal(download.status, 200);
    assert.match(download.headers["content-type"], /text\/csv/);
    assert.match(String(download.body), /object_type/);
  });

  test("search is permission aware", async () => {
    const role = queryOne(db, "SELECT id FROM roles WHERE code = 'app.reader'");
    const permission = queryOne(db, "SELECT id FROM permissions WHERE code = 'iam.search.global:read'");
    assert.ok(role && permission, "reader role and search permission must exist");
    db.prepare(
      "INSERT OR REPLACE INTO role_permissions (role_id, permission_id, effect, organization_id) VALUES (?, ?, 'deny', 0)"
    ).run(role.id, permission.id);
    const denied = await request(port, "GET", "/api/search?q=compressor", { token: userToken });
    assert.equal(denied.status, 403);
  });
});
