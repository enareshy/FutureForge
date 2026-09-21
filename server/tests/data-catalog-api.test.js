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
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

describe("Data Catalog & Business Glossary REST APIs", () => {
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
    const res = await request(port, "GET", "/api/v1/data-catalog/objects");
    assert.equal(res.status, 401);
  });

  test("serves catalog and glossary vocabularies", async () => {
    const catalog = await request(port, "GET", "/api/v1/data-catalog/meta", { token: adminToken });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.source_module, "data-catalog");
    assert.ok(catalog.body.capabilities.entry_types.includes("BUSINESS_TERM"));

    const glossary = await request(port, "GET", "/api/v1/glossary/meta", { token: adminToken });
    assert.equal(glossary.status, 200);
    assert.ok(glossary.body.vocabularies.term_statuses.includes("approved"));
  });

  test("denies a reader without catalog privileges", async () => {
    const objects = await request(port, "GET", "/api/v1/data-catalog/objects", { token: readerToken });
    assert.equal(objects.status, 403);
    const terms = await request(port, "GET", "/api/v1/glossary/terms", { token: readerToken });
    assert.equal(terms.status, 403);
  });

  test("reads the seeded catalog estate and reports metrics", async () => {
    const objects = await request(port, "GET", "/api/v1/data-catalog/objects", { token: adminToken });
    assert.equal(objects.status, 200);
    assert.ok(objects.body.items.length >= 3);

    const entries = await request(port, "GET", "/api/v1/data-catalog/entries", { token: adminToken });
    assert.equal(entries.status, 200);
    assert.ok(entries.body.total >= 3);

    const health = await request(port, "GET", "/api/v1/data-catalog/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.ok(health.body.counts.objects >= 3);

    const metrics = await request(port, "GET", "/api/v1/glossary/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.counters.entries > 0);
  });

  test("manages objects, attributes, sources and consumers through the admin API", async () => {
    const object = await request(port, "POST", "/api/v1/data-catalog/objects", {
      token: adminToken,
      body: { object_type: "api_widget", display_name: "API Widget", classification: "internal" },
    });
    assert.equal(object.status, 201);
    assert.equal(object.body.object_type, "api_widget");

    const attribute = await request(port, "POST", `/api/v1/data-catalog/objects/${object.body.object_ref}/attributes`, {
      token: adminToken,
      body: { attribute_name: "serial_number", display_name: "Serial Number", data_type: "string" },
    });
    assert.equal(attribute.status, 201);
    assert.equal(attribute.body.attribute_name, "serial_number");

    const source = await request(port, "POST", "/api/v1/data-catalog/sources", {
      token: adminToken,
      body: { code: "API_SRC", name: "API Source", source_type: "database", connection_reference: "integration/credentials/api" },
    });
    assert.equal(source.status, 201);
    assert.equal(source.body.code, "API_SRC");

    const badSource = await request(port, "POST", "/api/v1/data-catalog/sources", {
      token: adminToken,
      body: { code: "API_BAD_SRC", name: "Bad", source_type: "database", connection_reference: "postgres://user:pass@host/db" },
    });
    assert.ok([400, 422].includes(badSource.status));

    const consumer = await request(port, "POST", "/api/v1/data-catalog/consumers", {
      token: adminToken,
      body: { code: "API_APP", name: "API App", consumer_type: "application" },
    });
    assert.equal(consumer.status, 201);

    const mapping = await request(port, "POST", `/api/v1/data-catalog/consumers/${consumer.body.code}/mappings`, {
      token: adminToken,
      body: { object_id: object.body.entry_id, purpose: "reporting", frequency: "daily" },
    });
    assert.equal(mapping.status, 201);
  });

  test("drives the glossary review and approval lifecycle", async () => {
    const term = await request(port, "POST", "/api/v1/glossary/terms", {
      token: adminToken,
      body: { code: "API_TERM", name: "API Term", definition: "A term defined through the API." },
    });
    assert.equal(term.status, 201);
    assert.equal(term.body.status, "draft");

    const submit = await request(port, "POST", `/api/v1/glossary/terms/${term.body.code}/submit`, { token: adminToken, body: {} });
    assert.equal(submit.status, 200);
    assert.equal(submit.body.status, "in_review");

    const approve = await request(port, "POST", `/api/v1/glossary/terms/${term.body.code}/approve`, { token: adminToken, body: {} });
    assert.equal(approve.status, 200);
    assert.equal(approve.body.status, "approved");
    assert.equal(approve.body.approval_status, "approved");

    const definitions = await request(port, "GET", `/api/v1/glossary/terms/${term.body.code}/definitions`, { token: adminToken });
    assert.equal(definitions.status, 200);
    assert.ok(definitions.body.items.length >= 1);
  });

  test("explores lineage and ownership for the tenant", async () => {
    const graph = await request(port, "GET", "/api/v1/data-catalog/lineage/graph?root_type=OBJECT&root_id=1&direction=both", {
      token: adminToken,
    });
    assert.equal(graph.status, 200);

    const lineage = await request(port, "POST", "/api/v1/data-catalog/lineage", {
      token: adminToken,
      body: { from_type: "OBJECT", from_id: "api_widget", to_type: "OBJECT", to_id: "api_widget_v2", relationship_type: "DERIVED_FROM" },
    });
    assert.equal(lineage.status, 201);

    const gaps = await request(port, "GET", "/api/v1/data-catalog/ownership/gaps", { token: adminToken });
    assert.equal(gaps.status, 200);
    assert.ok(Array.isArray(gaps.body.items));

    const ownership = await request(port, "GET", "/api/v1/data-catalog/ownership", { token: adminToken });
    assert.equal(ownership.status, 200);
    assert.ok(ownership.body.items.length >= 6);
  });

  test("exposes configuration and import/export for the tenant", async () => {
    const config = await request(port, "GET", "/api/v1/data-catalog/configuration", { token: adminToken });
    assert.equal(config.status, 200);
    const keys = Array.isArray(config.body) ? config.body.map((row) => row.key) : Object.keys(config.body ?? {});
    assert.ok(keys.includes("lineage_max_depth"));

    const exported = await request(port, "GET", "/api/v1/data-catalog/export?resources=sources", { token: adminToken });
    assert.equal(exported.status, 200);
    assert.ok(exported.body.record_count >= 1);

    const imported = await request(port, "POST", "/api/v1/data-catalog/import", {
      token: adminToken,
      body: {
        resource_type: "classifications",
        dry_run: true,
        records: [{ code: "API_CLS", name: "API Classification", category: "business", security_classification: "internal" }],
      },
    });
    assert.equal(imported.status, 202);
    assert.ok(imported.body.stats.total >= 1);
  });
});
