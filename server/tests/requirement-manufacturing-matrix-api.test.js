process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { RequirementsManager, ensureRequirementsFoundation } from "../services/requirements/index.js";
import { ensureRequirementObject } from "../services/requirement-pdm/index.js";
import { Definitions as BomDefinitions, Revisions as BomRevisions, Lines as BomLines, ensureBomFoundation } from "../services/bom/index.js";
import { createObject } from "../services/objects.js";
import { Characteristics } from "../services/classification/index.js";
import {
  ensureRequirementManufacturingFoundation,
  createManufacturingObject,
  createAllocation,
  designateCtq,
} from "../services/requirement-manufacturing/index.js";

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

describe("Requirement -> Manufacturing matrix, coverage, gaps & navigation API", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let readerToken;
  let requirement;
  let operation;
  const IP = "127.0.0.1";

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureBomFoundation(db);
    ensureRequirementManufacturingFoundation(db);

    const tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    const actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");

    requirement = RequirementsManager.createRequirement(db, tenant, { title: "API matrix", requirement_type: "business_requirement", criticality: "HIGH" }, actor, IP);
    ensureRequirementObject(db, tenant, requirement, actor, IP);
    requirement = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [requirement.id]);

    operation = createManufacturingObject(db, tenant, { object_type: "operation", code: "API-MTX-OP", name: "Op" }, actor, IP);
    createAllocation(db, tenant, { requirement_id: String(requirement.id), target_type: "operation", relationship_type: "REALIZED_BY", target_id: String(operation.id) }, actor, IP);

    const ctq = Characteristics.createCharacteristic(db, tenant, { code: "API-MTX-CTQ", name: "Weld depth", data_type: "UNIT_NUMERIC", unit: "MM" }, actor, IP);
    designateCtq(db, tenant, ctq.id, { ctq: true, severity: "HIGH" }, actor, IP);
    createAllocation(db, tenant, { requirement_id: String(requirement.id), target_type: "characteristic", relationship_type: "CONTROLLED_BY", target_id: String(ctq.id) }, actor, IP);

    const mbom = BomDefinitions.createBom(db, tenant, { bom_number: "API-MTX-MBOM", name: "MBOM", bom_type: "MBOM" }, actor, IP);
    const mbomRevision = BomRevisions.createRevision(db, tenant, mbom.id, { revision_number: "A1" }, actor, IP);
    const part = createObject(db, { type: "part", code: "API-MTX-PART", name: "Housing", status: "released", data: { "part.number": "API-MTX-PART", "part.name": "Housing", "part.category": "mechanical", "part.status": "released" } }, actor, tenant, IP);
    BomLines.addLine(db, tenant, mbomRevision.id, { child_object_id: String(part.id), child_object_type: "part", quantity: 1, uom: "EA", find_number: "10" }, actor, IP);

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
    const unauth = await request(port, "GET", "/api/v1/requirement-manufacturing/matrix");
    assert.equal(unauth.status, 401);
    const denied = await request(port, "GET", "/api/v1/requirement-manufacturing/matrix", { token: readerToken });
    assert.equal(denied.status, 403);
  });

  test("serves the manufacturing matrix", async () => {
    const res = await request(port, "GET", "/api/v1/requirement-manufacturing/matrix?pageSize=500", { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.source_module, "requirement-manufacturing");
    const row = res.body.items.find((item) => item.requirement.requirement_id === requirement.id);
    assert.ok(row, "requirement must be present in the matrix");
    assert.equal(row.coverage_status, "COVERED");
    assert.ok(row.columns.operation.some((target) => target.target_id === String(operation.id)));
  });

  test("serves coverage and gap reports", async () => {
    const coverage = await request(port, "GET", "/api/v1/requirement-manufacturing/coverage", { token: adminToken });
    assert.equal(coverage.status, 200);
    assert.ok(coverage.body.requirements.requirements >= 1);
    assert.equal(typeof coverage.body.overall_coverage, "number");

    const gaps = await request(port, "GET", "/api/v1/requirement-manufacturing/gaps", { token: adminToken });
    assert.equal(gaps.status, 200);
    assert.ok(gaps.body.summary.total >= 1);
    assert.ok(gaps.body.items.some((gap) => gap.rule === "EBOM_MBOM_MAPPING"));

    const filtered = await request(port, "GET", "/api/v1/requirement-manufacturing/gaps?rules=REQUIREMENT_IMPLEMENTATION", { token: adminToken });
    assert.equal(filtered.status, 200);
    assert.ok(filtered.body.items.every((gap) => gap.rule === "REQUIREMENT_IMPLEMENTATION"));
  });

  test("navigates the digital thread bidirectionally", async () => {
    const forward = await request(port, "GET", `/api/v1/requirement-manufacturing/trace?objectType=requirement&objectId=${requirement.object_id}&direction=forward`, { token: adminToken });
    assert.equal(forward.status, 200);
    const keys = forward.body.nodes.map((node) => `${node.object_type}:${node.object_id}`);
    assert.ok(keys.includes(`requirement:${requirement.object_id}`));
    assert.ok(keys.includes(`operation:${operation.id}`));

    const matrix = await request(port, "GET", `/api/v1/requirement-manufacturing/trace/matrix?objectType=requirement&objectId=${requirement.object_id}`, { token: adminToken });
    assert.equal(matrix.status, 200);
  });

  test("rejects an unknown navigation node type", async () => {
    const bad = await request(port, "GET", "/api/v1/requirement-manufacturing/trace?objectType=widget&objectId=1", { token: adminToken });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, "REQUIREMENT_MANUFACTURING_INVALID_TARGET");
  });
});
