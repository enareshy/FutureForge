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
import { Characteristics, Definitions, Hierarchy, Assignments, ensureClassificationUnits } from "../services/classification/index.js";
import {
  ensureRequirementManufacturingFoundation,
  createManufacturingObject,
  createAllocation,
  designateCtq,
  setCharacteristicLimits,
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

describe("Requirement -> Manufacturing characteristics & CTQ API", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let readerToken;
  let requirement;
  let ctqCharacteristic;
  let operation;
  const IP = "127.0.0.1";

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureRequirementManufacturingFoundation(db);
    ensureClassificationUnits(db);

    const tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    const actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");

    requirement = RequirementsManager.createRequirement(db, tenant, { title: "API CTQ", requirement_type: "business_requirement" }, actor, IP);
    ensureRequirementObject(db, tenant, requirement, actor, IP);
    requirement = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [requirement.id]);

    ctqCharacteristic = Characteristics.createCharacteristic(db, tenant, { code: "API-CTQ-1", name: "Torque", data_type: "UNIT_NUMERIC", unit: "MM" }, actor, IP);
    const classification = Definitions.createClassification(db, tenant, { code: "API-CLA", name: "Manufacturing" }, actor, IP);
    const cls = Hierarchy.createClass(db, tenant, { classification_id: classification.id, code: "API-ROOT", name: "Root" }, actor, IP);
    Hierarchy.setClassStatus(db, tenant, cls.id, "ACTIVE", actor, IP);
    Characteristics.addClassCharacteristic(db, tenant, cls.id, { characteristic_id: ctqCharacteristic.id }, actor, IP);
    operation = createManufacturingObject(db, tenant, { object_type: "operation", code: "API-OP-CTQ", name: "Op" }, actor, IP);
    Assignments.assignClass(db, tenant, { class_id: cls.id, object_type: "operation", object_id: String(operation.id) }, actor, IP);
    designateCtq(db, tenant, ctqCharacteristic.id, { ctq: true, severity: "HIGH" }, actor, IP);
    setCharacteristicLimits(db, tenant, ctqCharacteristic.id, { min_value: 1, max_value: 5 }, actor, IP);
    createAllocation(db, tenant, { requirement_id: String(requirement.id), target_type: "characteristic", relationship_type: "CONTROLLED_BY", target_id: String(ctqCharacteristic.id) }, actor, IP);

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
    const unauth = await request(port, "GET", `/api/v1/requirement-manufacturing/operations/${operation.id}/characteristics`);
    assert.equal(unauth.status, 401);
    const denied = await request(port, "GET", `/api/v1/requirement-manufacturing/characteristics/${ctqCharacteristic.id}/operations`, { token: readerToken });
    assert.equal(denied.status, 403);
  });

  test("reads operation characteristics and constraints", async () => {
    const chars = await request(port, "GET", `/api/v1/requirement-manufacturing/operations/${operation.id}/characteristics`, { token: adminToken });
    assert.equal(chars.status, 200);
    assert.deepEqual(chars.body.items.map((item) => item.code), ["API-CTQ-1"]);

    const constraints = await request(port, "GET", `/api/v1/requirement-manufacturing/operations/${operation.id}/constraints`, { token: adminToken });
    assert.equal(constraints.status, 200);
    assert.equal(constraints.body.items.length, 1);
    assert.equal(constraints.body.items[0].has_limits, true);
  });

  test("validates a constraint value over the API", async () => {
    const invalid = await request(port, "POST", `/api/v1/requirement-manufacturing/characteristics/${ctqCharacteristic.id}/validate`, { token: adminToken, body: { value: 9 } });
    assert.equal(invalid.status, 200);
    assert.equal(invalid.body.status, "INVALID_LINK");

    const valid = await request(port, "POST", `/api/v1/requirement-manufacturing/characteristics/${ctqCharacteristic.id}/validate`, { token: adminToken, body: { value: 3 } });
    assert.equal(valid.status, 200);
    assert.equal(valid.body.status, "VALID");
  });

  test("reads characteristic operations, requirements, requirement CTQs and CTQ coverage", async () => {
    const ops = await request(port, "GET", `/api/v1/requirement-manufacturing/characteristics/${ctqCharacteristic.id}/operations`, { token: adminToken });
    assert.equal(ops.status, 200);
    assert.deepEqual(ops.body.items.map((item) => item.code), ["API-OP-CTQ"]);

    const reqs = await request(port, "GET", `/api/v1/requirement-manufacturing/characteristics/${ctqCharacteristic.id}/requirements`, { token: adminToken });
    assert.equal(reqs.status, 200);
    assert.equal(reqs.body.total, 1);

    const ctqs = await request(port, "GET", `/api/v1/requirement-manufacturing/requirements/${requirement.id}/ctq`, { token: adminToken });
    assert.equal(ctqs.status, 200);
    assert.equal(ctqs.body.items.length, 1);
    assert.equal(ctqs.body.items[0].has_operation, true);

    const coverage = await request(port, "GET", `/api/v1/requirement-manufacturing/ctq/coverage`, { token: adminToken });
    assert.equal(coverage.status, 200);
    assert.ok(coverage.body.summary.ctq_total >= 1);
    assert.ok(coverage.body.with_coverage.some((entry) => entry.requirement_id === requirement.id));
  });
});
