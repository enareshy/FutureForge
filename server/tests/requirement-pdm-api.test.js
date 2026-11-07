process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import { Items, Revisions, RevisionRules } from "../services/pdm/index.js";
import { Requirements } from "../services/requirements/index.js";

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

describe("Requirement -> PDM integration REST APIs", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let readerToken;
  let tenant;
  let actor;
  let requirement;
  let revisionId;
  let allocationRef;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    const started = await listen(createApp(db));
    server = started.server;
    port = started.port;
    adminToken = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
    readerToken = (await request(port, "POST", "/api/auth/login", { body: { username: "j.patel", password: "HelixUser!42" } })).body.token;

    const admin = db.prepare("SELECT id, tenant_id FROM users WHERE username = 'admin'").get();
    tenant = Number(admin.tenant_id);
    actor = { id: admin.id, tenant_id: tenant };

    // Fixtures: a requirement and a released PDM item revision.
    requirement = Requirements.createRequirement(db, tenant, { title: "Braking force", requirement_type: "product_requirement" }, actor, null);
    const item = Items.createItem(db, tenant, { item_number: "RPDM-1000", name: "Brake Assembly", item_type: "PRODUCT" });
    const rule = RevisionRules.createRevisionRule(db, tenant, { code: "RPDM-LATEST", rule_type: "LATEST_WORKING", is_default: true });
    RevisionRules.activateRevisionRule(db, tenant, rule.id);
    const revision = Revisions.createRevision(db, tenant, item.item_number, { revision_number: "A1", description: "initial" });
    revisionId = revision.id;
  });

  after(() => {
    server?.close();
    db?.close();
  });

  test("requires authentication", async () => {
    const res = await request(port, "GET", "/api/v1/requirement-pdm/meta");
    assert.equal(res.status, 401);
  });

  test("denies a reader without integration privileges", async () => {
    const res = await request(port, "GET", "/api/v1/requirement-pdm/allocations", { token: readerToken });
    assert.equal(res.status, 403);
  });

  test("serves the capability vocabulary", async () => {
    const res = await request(port, "GET", "/api/v1/requirement-pdm/meta", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "requirement-pdm");
    assert.ok(res.body.allocation_types.some((entry) => entry.code === "IMPLEMENTED_BY"));
    assert.equal(res.body.thread_provider, "requirement-pdm");
  });

  test("reports health and configuration", async () => {
    const health = await request(port, "GET", "/api/v1/requirement-pdm/health", { token: adminToken });
    assert.equal(health.status, 200);
    assert.ok(health.body.counts);
    const config = await request(port, "GET", "/api/v1/requirement-pdm/config", { token: adminToken });
    assert.equal(config.status, 200);
    assert.equal(typeof config.body.auto_trace_on_allocation, "boolean");
  });

  test("resolves a PDM revision target", async () => {
    const res = await request(port, "GET", `/api/v1/requirement-pdm/targets/resolve?target_type=pdm_revision&target_id=${revisionId}`, { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.target_type, "pdm_revision");
  });

  test("creates and reads allocations, coverage and compatibility", async () => {
    const created = await request(port, "POST", "/api/v1/requirement-pdm/allocations", {
      token: adminToken,
      body: { requirement_id: requirement.id, relationship_type: "IMPLEMENTED_BY", target_type: "pdm_revision", target_id: revisionId },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.relationship_type, "IMPLEMENTED_BY");
    allocationRef = created.body.allocation_ref;

    const got = await request(port, "GET", `/api/v1/requirement-pdm/allocations/${allocationRef}`, { token: adminToken });
    assert.equal(got.status, 200);
    assert.equal(got.body.allocation_ref, allocationRef);

    const list = await request(port, "GET", `/api/v1/requirement-pdm/allocations?requirement_id=${requirement.id}`, { token: adminToken });
    assert.equal(list.status, 200);
    assert.ok(list.body.total >= 1);

    const scoped = await request(port, "GET", `/api/v1/requirement-pdm/requirements/${requirement.requirement_ref}/allocations`, { token: adminToken });
    assert.equal(scoped.status, 200);

    const coverage = await request(port, "GET", `/api/v1/requirement-pdm/requirements/${requirement.requirement_ref}/coverage`, { token: adminToken });
    assert.equal(coverage.status, 200);
    assert.ok(["UNALLOCATED", "PARTIAL", "ALLOCATED", "SATISFIED"].includes(coverage.body.coverage));

    const compat = await request(port, "GET", `/api/v1/requirement-pdm/requirements/${requirement.requirement_ref}/compatibilities`, { token: adminToken });
    assert.equal(compat.status, 200);
  });

  test("checks and synchronizes an allocation", async () => {
    const check = await request(port, "POST", `/api/v1/requirement-pdm/allocations/${allocationRef}/check`, { token: adminToken, body: {} });
    assert.equal(check.status, 200);
    assert.ok(check.body.status);

    const sync = await request(port, "POST", "/api/v1/requirement-pdm/synchronize", { token: adminToken, body: { requirement_id: requirement.id } });
    assert.equal(sync.status, 200);
    assert.ok(["COMPLETED", "NOOP", "PARTIAL"].includes(sync.body.status));
  });

  test("exposes impact, integration summary and metrics", async () => {
    const impact = await request(port, "GET", `/api/v1/requirement-pdm/impact?target_type=pdm_revision&target_id=${revisionId}`, { token: adminToken });
    assert.equal(impact.status, 200);
    assert.ok(impact.body.total >= 1);
    const summary = await request(port, "GET", "/api/v1/requirement-pdm/integration/summary", { token: adminToken });
    assert.equal(summary.status, 200);
    const metrics = await request(port, "GET", "/api/v1/requirement-pdm/metrics", { token: adminToken });
    assert.equal(metrics.status, 200);
  });

  test("rejects an unknown allocation and target", async () => {
    const missing = await request(port, "GET", "/api/v1/requirement-pdm/allocations/RPDM-DOES-NOT-EXIST", { token: adminToken });
    assert.equal(missing.status, 404);
    const badTarget = await request(port, "GET", "/api/v1/requirement-pdm/targets/resolve?target_type=pdm_revision&target_id=999999", { token: adminToken });
    assert.equal(badTarget.status, 404);
  });

  test("removes an allocation", async () => {
    const removed = await request(port, "DELETE", `/api/v1/requirement-pdm/allocations/${allocationRef}`, { token: adminToken });
    assert.equal(removed.status, 200);
    const gone = await request(port, "GET", `/api/v1/requirement-pdm/allocations/${allocationRef}`, { token: adminToken });
    assert.equal(gone.status, 404);
  });
});
