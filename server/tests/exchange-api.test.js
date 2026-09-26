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

const PART_PAYLOAD = JSON.stringify({
  records: [
    {
      external_id: "API-PART-1",
      name: "API bracket",
      attributes: {
        "part.number": "API-PART-1",
        "part.name": "API bracket",
        "part.category": "mechanical",
        "part.status": "draft",
      },
    },
  ],
});

describe("Standards & Exchange REST APIs", () => {
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
    const res = await request(port, "GET", "/api/v1/standards-exchange/meta");
    assert.equal(res.status, 401);
  });

  test("denies a reader without Standards & Exchange privileges", async () => {
    const res = await request(port, "GET", "/api/v1/standards-exchange/meta", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the capability vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/standards-exchange/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "exchange");
    assert.ok(res.body.capabilities.formats.includes("JSON"));
    assert.ok(res.body.capabilities.formats.includes("STEP_AP242"));
    assert.ok(res.body.capabilities.adapters.some((adapter) => adapter.code === "step-ap242" && adapter.status === "PLANNED"));
    assert.deepEqual(res.body.capabilities.integrations.map((entry) => entry.code).sort(), ["bom", "object", "pdm"]);
  });

  test("serves health and metrics", async () => {
    const health = await request(port, "GET", "/api/v1/standards-exchange/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.equal(health.body.source_module, "exchange");
    const metrics = await request(port, "GET", "/api/v1/standards-exchange/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
  });

  test("lists adapters and formats", async () => {
    const adapters = await request(port, "GET", "/api/v1/standards-exchange/adapters", { token: adminToken });
    assert.equal(adapters.status, 200);
    assert.ok(adapters.body.items.length >= 8);
    const formats = await request(port, "GET", "/api/v1/standards-exchange/formats", { token: adminToken });
    assert.equal(formats.status, 200);
    assert.ok(formats.body.items.some((entry) => entry.code === "JSON"));
  });

  test("detects a format", async () => {
    const res = await request(port, "POST", "/api/v1/standards-exchange/detect", { token: adminToken, body: { payload: PART_PAYLOAD } });
    assert.equal(res.status, 200);
    assert.equal(res.body.detected, true);
    assert.equal(res.body.format.code, "JSON");
  });

  test("lists seeded definitions and their summary", async () => {
    const defs = await request(port, "GET", "/api/v1/standards-exchange/definitions?page_size=100", { token: adminToken });
    assert.equal(defs.status, 200);
    assert.ok(defs.body.items.some((entry) => entry.code === "JSON_PART_IMPORT"));
    const summary = await request(port, "GET", "/api/v1/standards-exchange/definitions/summary", { token: adminToken });
    assert.equal(summary.status, 200);
  });

  test("previews an import without writing enterprise data", async () => {
    const res = await request(port, "POST", "/api/v1/standards-exchange/import/preview", {
      token: adminToken,
      body: { definition_code: "JSON_PART_IMPORT", payload: PART_PAYLOAD },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, "PREVIEW");
    assert.equal(res.body.output.preview, true);
  });

  test("executes an import and exposes the transaction", async () => {
    const res = await request(port, "POST", "/api/v1/standards-exchange/import", {
      token: adminToken,
      body: { definition_code: "JSON_PART_IMPORT", payload: PART_PAYLOAD },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, "COMPLETED");
    assert.equal(res.body.counts.records_created, 1);
    const txn = await request(port, "GET", `/api/v1/standards-exchange/transactions/${res.body.transaction_ref}`, { token: adminToken });
    assert.equal(txn.status, 200);
    assert.equal(txn.body.transaction_ref, res.body.transaction_ref);
    const list = await request(port, "GET", "/api/v1/standards-exchange/transactions", { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.total >= 1);
  });

  test("executes an export", async () => {
    const res = await request(port, "POST", "/api/v1/standards-exchange/export", {
      token: adminToken,
      body: { definition_code: "JSON_PART_EXPORT", object_type: "part" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, "COMPLETED");
    assert.ok(res.body.output.size > 0);
  });

  test("exposes reconciliations and history", async () => {
    const recon = await request(port, "GET", "/api/v1/standards-exchange/reconciliations", { token: adminToken });
    assert.equal(recon.status, 200);
    assert.ok(recon.body.total >= 1);
    const history = await request(port, "GET", "/api/v1/standards-exchange/history", { token: adminToken });
    assert.equal(history.status, 200);
    assert.ok(history.body.total >= 1);
  });

  test("reads and updates configuration", async () => {
    const config = await request(port, "GET", "/api/v1/standards-exchange/config", { token: adminToken });
    assert.equal(config.status, 200);
    const updated = await request(port, "PUT", "/api/v1/standards-exchange/config/duplicate_strategy", { token: adminToken, body: { value: "skip" } });
    assert.equal(updated.status, 200);
    assert.equal(String(updated.body.value).toUpperCase(), "SKIP");
  });

  test("refuses a planned CAD adapter through the API", async () => {
    const created = await request(port, "POST", "/api/v1/standards-exchange/definitions", {
      token: adminToken,
      body: { code: "API_STEP_DEF", name: "STEP import", format_code: "STEP_AP242", direction: "IMPORT", target_object_type: "part" },
    });
    assert.equal(created.status, 201);
    const res = await request(port, "POST", "/api/v1/standards-exchange/import", {
      token: adminToken,
      body: { definition_code: created.body.code, payload: "ISO-10303-21;" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, "FAILED");
    assert.equal(res.body.error.code, "EXCHANGE_ADAPTER_UNAVAILABLE");
  });
});
