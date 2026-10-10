process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { RequirementsManager, ensureRequirementsFoundation } from "../services/requirements/index.js";
import { ensureRequirementObject, ensureRequirementPdmFoundation } from "../services/requirement-pdm/index.js";
import { ensureRequirementManufacturingFoundation, createManufacturingObject, createAllocation } from "../services/requirement-manufacturing/index.js";

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
          resolve({ status: res.statusCode, body: parsed, text });
        });
      }
    );
    req.on("error", reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

describe("Requirement -> Manufacturing change impact API", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let readerToken;
  let covered;
  let uncovered;
  let operation;
  const IP = "127.0.0.1";

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureRequirementPdmFoundation(db);
    ensureRequirementManufacturingFoundation(db);

    const tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    const actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");

    covered = RequirementsManager.createRequirement(db, tenant, { title: "API impact covered", requirement_type: "business_requirement", criticality: "HIGH" }, actor, IP);
    ensureRequirementObject(db, tenant, covered, actor, IP);
    covered = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [covered.id]);

    uncovered = RequirementsManager.createRequirement(db, tenant, { title: "API impact uncovered", requirement_type: "business_requirement" }, actor, IP);
    ensureRequirementObject(db, tenant, uncovered, actor, IP);
    uncovered = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [uncovered.id]);

    operation = createManufacturingObject(db, tenant, { object_type: "operation", code: "API-IMP-OP", name: "Op" }, actor, IP);
    createAllocation(db, tenant, { requirement_id: String(covered.id), target_type: "operation", relationship_type: "REALIZED_BY", target_id: String(operation.id) }, actor, IP);

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

  test("requires authentication and denies a reader", async () => {
    const unauth = await request(port, "POST", "/api/v1/requirement-manufacturing/impact-analysis", { body: { requirement_id: covered.id } });
    assert.equal(unauth.status, 401);
    const denied = await request(port, "POST", "/api/v1/requirement-manufacturing/impact-analysis", { token: readerToken, body: { requirement_id: covered.id } });
    assert.equal(denied.status, 403);
  });

  test("analyzes forward impact for a requirement", async () => {
    const res = await request(port, "POST", "/api/v1/requirement-manufacturing/impact-analysis", { token: adminToken, body: { requirement_id: covered.id } });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "requirement-manufacturing");
    assert.ok(res.body.impacted_count >= 1);
    assert.ok(res.body.category_totals);

    const byRef = await request(port, "GET", `/api/v1/requirement-manufacturing/requirements/${covered.id}/impact`, { token: adminToken });
    assert.equal(byRef.status, 200);
    assert.equal(byRef.body.root, res.body.root);
  });

  test("analyzes reverse impact for a manufacturing node", async () => {
    const res = await request(port, "POST", "/api/v1/requirement-manufacturing/node-impact", { token: adminToken, body: { node_type: "operation", node_id: String(operation.id) } });
    assert.equal(res.status, 200);
    assert.equal(res.body.requirement_count, 1);
    assert.equal(res.body.requirements[0].requirement_id, covered.id);
  });

  test("serves requirement-scoped gaps", async () => {
    const gaps = await request(port, "GET", `/api/v1/requirement-manufacturing/requirements/${uncovered.id}/gaps`, { token: adminToken });
    assert.equal(gaps.status, 200);
    assert.ok(gaps.body.total >= 1);
    assert.ok(gaps.body.items.some((gap) => gap.rule === "REQUIREMENT_IMPLEMENTATION"));

    const coveredGaps = await request(port, "GET", `/api/v1/requirement-manufacturing/requirements/${covered.id}/gaps`, { token: adminToken });
    assert.equal(coveredGaps.status, 200);
    assert.ok(!coveredGaps.body.items.some((gap) => gap.rule === "REQUIREMENT_IMPLEMENTATION"), "a realized requirement must not report an implementation gap");
  });

  test("submits impact and gap-sweep jobs", async () => {
    const impactJob = await request(port, "POST", "/api/v1/requirement-manufacturing/impact-analysis/jobs", { token: adminToken, body: { requirement_id: covered.id } });
    assert.equal(impactJob.status, 202);
    assert.ok(impactJob.body.id ?? impactJob.body.job_id);

    const sweepJob = await request(port, "POST", "/api/v1/requirement-manufacturing/gaps/sweep", { token: adminToken, body: {} });
    assert.equal(sweepJob.status, 202);
    assert.ok(sweepJob.body.id ?? sweepJob.body.job_id);
  });
});
