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

const demoCsv =
  "part_number,part_name,part_category,notes,state\n" +
  "PART-9001,Hydraulic pump A,hydraulic,first part,active\n" +
  "PART-9002,Hydraulic pump B,hydraulic,second part,draft\n";

describe("Import / Export Framework REST APIs", () => {
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
    const res = await request(port, "GET", "/api/v1/data-exchange/meta");
    assert.equal(res.status, 401);
  });

  test("denies a reader without data-exchange privileges", async () => {
    const res = await request(port, "GET", "/api/v1/data-exchange/import-definitions", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the data-exchange vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/data-exchange/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "data-exchange");
    assert.ok(res.body.capabilities.connector_types.length >= 10);
    assert.ok(res.body.capabilities.export_formats.includes("CSV"));
    assert.ok(res.body.security_actions.length > 0);
    assert.ok(res.body.capabilities.job_types.includes("DATA_IMPORT"));
  });

  test("reports health and metrics", async () => {
    const health = await request(port, "GET", "/api/v1/data-exchange/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.ok(["healthy", "degraded"].includes(health.body.status));

    const metrics = await request(port, "GET", "/api/v1/data-exchange/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
    assert.equal(typeof metrics.body.import_definitions, "number");
    assert.ok(metrics.body.registered_connectors >= 10);
  });

  test("lists the pluggable connector catalogue", async () => {
    const res = await request(port, "GET", "/api/v1/data-exchange/connectors", { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 10);
    assert.ok(res.body.items.some((c) => c.code === "CSV"));
  });

  test("reads the seeded import/export estate", async () => {
    const imports = await request(port, "GET", "/api/v1/data-exchange/import-definitions", { token: adminToken });
    assert.equal(imports.status, 200);
    assert.ok(imports.body.items.some((d) => d.code === "PART_IMPORT"));

    const exports = await request(port, "GET", "/api/v1/data-exchange/export-definitions", { token: adminToken });
    assert.equal(exports.status, 200);
    assert.ok(exports.body.items.some((d) => d.code === "PART_EXPORT"));

    const templates = await request(port, "GET", "/api/v1/data-exchange/templates", { token: adminToken });
    assert.equal(templates.status, 200);
    assert.ok(templates.body.total >= 1);
  });

  test("previews an import without persisting anything", async () => {
    const res = await request(port, "POST", "/api/v1/data-exchange/import-definitions/PART_IMPORT/preview", {
      token: adminToken,
      body: { content: demoCsv },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.valid, 2);
    assert.equal(res.body.invalid, 0);
  });

  test("runs an import end-to-end and records history", async () => {
    const res = await request(port, "POST", "/api/v1/data-exchange/import-definitions/PART_IMPORT/run", {
      token: adminToken,
      body: { content: demoCsv, mode: "IMPORT" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, "COMPLETED");
    assert.equal(res.body.created_count, 2);
    assert.equal(res.body.failed_count, 0);

    const jobRef = res.body.job_ref;
    const records = await request(port, "GET", `/api/v1/data-exchange/import-jobs/${jobRef}/records`, { token: adminToken });
    assert.equal(records.status, 200);
    assert.equal(records.body.total, 2);

    const errors = await request(port, "GET", `/api/v1/data-exchange/import-jobs/${jobRef}/errors`, { token: adminToken });
    assert.equal(errors.status, 200);
    assert.equal(errors.body.total, 0);

    const reconcile = await request(port, "POST", `/api/v1/data-exchange/import-jobs/${jobRef}/reconcile`, { token: adminToken, body: {} });
    assert.equal(reconcile.status, 200);
    assert.equal(reconcile.body.job_ref, jobRef);
  });

  test("is idempotent when an idempotency key is supplied", async () => {
    const first = await request(port, "POST", "/api/v1/data-exchange/import-definitions/PART_IMPORT/run", {
      token: adminToken,
      body: { content: demoCsv, mode: "IMPORT" },
      headers: { "Idempotency-Key": "api-test-idem-import" },
    });
    assert.equal(first.status, 201);

    const second = await request(port, "POST", "/api/v1/data-exchange/import-definitions/PART_IMPORT/run", {
      token: adminToken,
      body: { content: demoCsv, mode: "IMPORT" },
      headers: { "Idempotency-Key": "api-test-idem-import" },
    });
    assert.equal(second.status, 200);
    assert.equal(second.body.job_ref, first.body.job_ref);
  });

  test("runs an export, downloads it and enforces authorization", async () => {
    const res = await request(port, "POST", "/api/v1/data-exchange/export-definitions/PART_EXPORT/run", { token: adminToken, body: {} });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, "COMPLETED");
    assert.ok(res.body.exported_count >= 1);

    const results = await request(port, "GET", `/api/v1/data-exchange/export-jobs/${res.body.job_ref}/results`, { token: adminToken });
    assert.equal(results.status, 200);
    assert.equal(results.body.total, 1);
    const resultRef = results.body.items[0].result_ref;

    const download = await request(port, "GET", `/api/v1/data-exchange/export-results/${resultRef}/download`, { token: adminToken });
    assert.equal(download.status, 200);
    assert.match(String(download.text).split("\n")[0], /Part Number/);

    const unauth = await request(port, "GET", `/api/v1/data-exchange/export-results/${resultRef}/download`);
    assert.equal(unauth.status, 401);

    const forbidden = await request(port, "GET", `/api/v1/data-exchange/export-results/${resultRef}/download`, { token: readerToken });
    assert.equal(forbidden.status, 403);
  });

  test("rejects an unknown export result download", async () => {
    const res = await request(port, "GET", "/api/v1/data-exchange/export-results/DOES-NOT-EXIST/download", { token: adminToken });
    assert.equal(res.status, 404);
  });

  test("lists jobs and history", async () => {
    const jobs = await request(port, "GET", "/api/v1/data-exchange/jobs", { token: adminToken });
    assert.equal(jobs.status, 200);
    assert.ok(jobs.body.total >= 1);

    const history = await request(port, "GET", "/api/v1/data-exchange/history", { token: adminToken });
    assert.equal(history.status, 200);
    assert.ok(history.body.total >= 1);
  });

  test("reads and updates configuration with validated bounds", async () => {
    const config = await request(port, "GET", "/api/v1/data-exchange/configuration", { token: adminToken });
    assert.equal(config.status, 200);
    assert.equal(typeof config.body.max_export_records, "number");

    const updated = await request(port, "PUT", "/api/v1/data-exchange/configuration/max_export_records", { token: adminToken, body: { value: 250 } });
    assert.equal(updated.status, 200);
    assert.equal(Number(updated.body.value), 250);

    const invalid = await request(port, "PUT", "/api/v1/data-exchange/configuration/max_export_records", { token: adminToken, body: { value: -5 } });
    assert.equal(invalid.status, 400);
  });

  test("standardizes error payloads", async () => {
    const res = await request(port, "GET", "/api/v1/data-exchange/import-definitions/NOPE", { token: adminToken });
    assert.equal(res.status, 404);
    assert.ok(res.body.error);
  });
});
