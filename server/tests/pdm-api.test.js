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

describe("PDM domain REST APIs", () => {
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
    const res = await request(port, "GET", "/api/v1/pdm/meta");
    assert.equal(res.status, 401);
  });

  test("denies a reader without PDM privileges", async () => {
    const res = await request(port, "GET", "/api/v1/pdm/items", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the PDM capability vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/pdm/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "pdm");
    assert.ok(res.body.capabilities.item_types.includes("PART"));
    assert.ok(res.body.capabilities.revision_rule_types.includes("LATEST_RELEASED"));
    assert.ok(res.body.vocabulary);
  });

  test("reports health, metrics and configuration", async () => {
    const health = await request(port, "GET", "/api/v1/pdm/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.ok(health.body.counts.items >= 1);

    const metrics = await request(port, "GET", "/api/v1/pdm/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
    assert.ok(metrics.body.totals.items >= 1);

    const config = await request(port, "GET", "/api/v1/pdm/config", { token: adminToken });
    assert.equal(config.status, 200);
    assert.equal(config.body.default_item_status, "DRAFT");
  });

  test("lists seeded items and rejects duplicate creation", async () => {
    const list = await request(port, "GET", "/api/v1/pdm/items", { token: adminToken });
    assert.equal(list.status, 200);
    assert.equal(list.body.source_module, "pdm");
    assert.ok(list.body.items.some((item) => item.item_number === "DEMO-PUMP-ASSY"));

    const created = await request(port, "POST", "/api/v1/pdm/items", {
      token: adminToken,
      body: { item_number: "API-ITEM-001", name: "API item", item_type: "PART" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.item_number, "API-ITEM-001");
    assert.match(created.body.item_ref, /^PDM-ITEM-/);

    const duplicate = await request(port, "POST", "/api/v1/pdm/items", {
      token: adminToken,
      body: { item_number: "API-ITEM-001", name: "duplicate", item_type: "PART" },
    });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.code, "PDM_ITEM_CONFLICT");
    assert.ok(duplicate.body.error);
  });

  test("returns a standardized 404 for an unknown item", async () => {
    const res = await request(port, "GET", "/api/v1/pdm/items/DOES-NOT-EXIST", { token: adminToken });
    assert.equal(res.status, 404);
    assert.equal(res.body.code, "PDM_ITEM_NOT_FOUND");
  });

  test("drives revisions, datasets, design data, CAD and structure end to end", async () => {
    const item = await request(port, "GET", "/api/v1/pdm/items/API-ITEM-001", { token: adminToken });
    const revision = await request(port, "POST", "/api/v1/pdm/items/API-ITEM-001/revisions", {
      token: adminToken,
      body: { revision_number: "A1" },
    });
    assert.equal(revision.status, 201);
    const revisionRef = revision.body.revision_ref;

    const dataset = await request(port, "POST", `/api/v1/pdm/revisions/${revisionRef}/datasets`, {
      token: adminToken,
      body: { dataset_number: "API-DS-001", name: "API dataset", dataset_type: "CAD_MODEL" },
    });
    assert.equal(dataset.status, 201);
    assert.equal(dataset.body.dataset_number, "API-DS-001");

    const designData = await request(port, "POST", `/api/v1/pdm/revisions/${revisionRef}/design-data`, {
      token: adminToken,
      body: { code: "API-DD-001", name: "API drawing", data_type: "DRAWING" },
    });
    assert.equal(designData.status, 201);

    const cad = await request(port, "POST", `/api/v1/pdm/revisions/${revisionRef}/cad`, {
      token: adminToken,
      body: { source_object_id: "API-ITEM-001:A1", dataset_id: dataset.body.id, cad_type: "NATIVE", association_type: "MASTER", is_primary: true },
    });
    assert.equal(cad.status, 201);
    assert.equal(cad.body.is_primary, true);

    const relationship = await request(port, "POST", "/api/v1/pdm/relationships", {
      token: adminToken,
      body: { relationship_type: "PRODUCT_HAS_PART", source_type: "ITEM", source_id: String(item.body.id), target_type: "ITEM", target_id: String(item.body.id) },
    });
    assert.equal(relationship.status, 201);
    assert.match(relationship.body.relationship_ref, /^PDM-REL-/);

    const relationshipList = await request(port, "GET", "/api/v1/pdm/relationships?relationship_type=PRODUCT_HAS_PART", { token: adminToken });
    assert.equal(relationshipList.status, 200);
    assert.ok(relationshipList.body.total >= 5);

    const datasets = await request(port, "GET", `/api/v1/pdm/revisions/${revisionRef}/datasets`, { token: adminToken });
    assert.equal(datasets.status, 200);
    assert.equal(datasets.body.items.length, 1);
  });

  test("resolves product structure and where-used", async () => {
    const structure = await request(port, "GET", "/api/v1/pdm/structure/DEMO-PUMP-ASSY?rule_code=DEMO-LATEST-RELEASED", { token: adminToken });
    assert.equal(structure.status, 200);
    assert.equal(structure.body.node_count, 5);
    assert.equal(structure.body.edge_count, 4);

    const whereUsed = await request(port, "GET", "/api/v1/pdm/where-used/DEMO-SEAL-004", { token: adminToken });
    assert.equal(whereUsed.status, 200);
    assert.equal(whereUsed.body.immediate_parent_count, 1);
  });

  test("exposes revision rules, configuration rules and baselines", async () => {
    const revisionRules = await request(port, "GET", "/api/v1/pdm/revision-rules", { token: adminToken });
    assert.equal(revisionRules.status, 200);
    assert.ok(revisionRules.body.items.some((rule) => rule.code === "DEMO-LATEST-RELEASED"));

    const resolved = await request(port, "POST", "/api/v1/pdm/revision-rules/resolve", {
      token: adminToken,
      body: { item_ref: "DEMO-PUMP-ASSY", rule_code: "DEMO-LATEST-RELEASED" },
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.revision.revision_number, "A1");

    const configurationRules = await request(port, "GET", "/api/v1/pdm/configuration-rules", { token: adminToken });
    assert.equal(configurationRules.status, 200);
    assert.ok(configurationRules.body.items.some((rule) => rule.code === "DEMO-VARIANT"));

    const evaluate = await request(port, "POST", "/api/v1/pdm/configuration-rules/evaluate", {
      token: adminToken,
      body: { context: { variant_code: "STANDARD" } },
    });
    assert.equal(evaluate.status, 200);
    assert.ok(evaluate.body.matched.length >= 1);

    const baselines = await request(port, "GET", "/api/v1/pdm/baselines", { token: adminToken });
    assert.equal(baselines.status, 200);
    assert.ok(baselines.body.items.some((baseline) => baseline.baseline_number === "DEMO-PUMP-BL-A"));
  });

  test("runs tenant validation and lists the results", async () => {
    const run = await request(port, "POST", "/api/v1/pdm/validation/run", { token: adminToken, body: { scope: "TENANT" } });
    assert.equal(run.status, 200);
    assert.ok(["PASS", "WARNING"].includes(run.body.status));
    assert.equal(run.body.error_count, 0);

    const detail = await request(port, "GET", `/api/v1/pdm/validation-results/${run.body.id}`, { token: adminToken });
    assert.equal(detail.status, 200);
    assert.ok(Array.isArray(detail.body.issues));

    const rules = await request(port, "GET", "/api/v1/pdm/validation-rules", { token: adminToken });
    assert.equal(rules.status, 200);
    assert.ok(rules.body.items.length >= 1);
  });

  test("submits a background validation job with idempotency", async () => {
    const first = await request(port, "POST", "/api/v1/pdm/jobs/validate", {
      token: adminToken,
      body: { scope: "TENANT" },
      headers: { "Idempotency-Key": "pdm-api-validate-1" },
    });
    assert.equal(first.status, 202);
    assert.ok(first.body.job_ref || first.body.id);

    const second = await request(port, "POST", "/api/v1/pdm/jobs/validate", {
      token: adminToken,
      body: { scope: "TENANT" },
      headers: { "Idempotency-Key": "pdm-api-validate-1" },
    });
    assert.equal(second.status, 202);
    assert.equal(second.body.id ?? second.body.job_id, first.body.id ?? first.body.job_id);
  });

  test("exposes search metadata", async () => {
    const searchMeta = await request(port, "GET", "/api/v1/pdm/search-meta", { token: adminToken });
    assert.equal(searchMeta.status, 200);
    assert.ok(searchMeta.body.object_types.some((entry) => entry.code === "pdm_item"));
  });
});
