process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import { RequirementsManager, ensureRequirementsFoundation } from "../services/requirements/index.js";
import {
  TestCases,
  TestProcedures,
  Foundation,
} from "../services/verification-validation/index.js";

const IP = "127.0.0.1";

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
      { hostname: "127.0.0.1", port, path, method, headers: { ...(payload !== null ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
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

describe("Verification & Validation test cases & procedures", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let tenant;
  let actor;
  let requirement;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureRequirementsFoundation(db);
    Foundation.ensureVvFoundation(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    requirement = RequirementsManager.createRequirement(db, tenant, { title: "V&V covered requirement", requirement_type: "business_requirement" }, actor, IP);
    const started = await listen(createApp(db));
    server = started.server;
    port = started.port;
    adminToken = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
  });

  after(() => {
    server?.close();
    db?.close();
  });

  test("creates a test case with defaults and a resolved method", () => {
    const tc = TestCases.createTestCase(db, tenant, { code: "VV-TC-1", name: "Braking distance", method_code: "TEST" }, actor, IP);
    assert.equal(tc.code, "VV-TC-1");
    assert.equal(tc.status, "DRAFT");
    assert.equal(tc.revision, "A");
    assert.equal(tc.verification_kind, "VERIFICATION");
    assert.equal(tc.method_code, "TEST");
    assert.ok(tc.method_id);
    assert.equal(tc.test_case_ref, "TC-VV-TC-1");
  });

  test("generates a code from the numbering service when omitted", () => {
    const tc = TestCases.createTestCase(db, tenant, { name: "Numbered test case" }, actor, IP);
    assert.match(tc.code, /^TC-\d+/);
  });

  test("rejects an unknown method", () => {
    assert.throws(() => TestCases.createTestCase(db, tenant, { code: "VV-TC-BAD", name: "Bad", method_code: "NOPE" }, actor, IP), /method/i);
  });

  test("rejects a duplicate code", () => {
    assert.throws(() => TestCases.createTestCase(db, tenant, { code: "VV-TC-1", name: "Dup" }, actor, IP), /exists/i);
  });

  test("lists and filters test cases", () => {
    const all = TestCases.listTestCases(db, { tenantId: tenant });
    assert.ok(all.total >= 2);
    const validation = TestCases.createTestCase(db, tenant, { code: "VV-TC-VAL", name: "User acceptance", verification_kind: "VALIDATION" }, actor, IP);
    const filtered = TestCases.listTestCases(db, { tenantId: tenant, verification_kind: "VALIDATION" });
    assert.ok(filtered.items.some((entry) => entry.id === validation.id));
    assert.ok(filtered.items.every((entry) => entry.verification_kind === "VALIDATION"));
  });

  test("updates an editable test case", () => {
    const tc = TestCases.getTestCase(db, tenant, "VV-TC-1");
    const updated = TestCases.updateTestCase(db, tenant, "VV-TC-1", { name: "Braking distance (dry)", version: tc.version }, actor, IP);
    assert.equal(updated.name, "Braking distance (dry)");
    assert.equal(updated.version, tc.version + 1);
  });

  test("runs the definition lifecycle and rejects invalid transitions", () => {
    TestCases.transitionTestCase(db, tenant, "VV-TC-1", "IN_REVIEW", { actor, ip: IP });
    const approved = TestCases.transitionTestCase(db, tenant, "VV-TC-1", "APPROVED", { actor, ip: IP });
    assert.equal(approved.status, "APPROVED");
    assert.ok(approved.approved_at);
    assert.throws(() => TestCases.transitionTestCase(db, tenant, "VV-TC-1", "DRAFT", { actor, ip: IP }), /Invalid transition/i);
    const released = TestCases.transitionTestCase(db, tenant, "VV-TC-1", "RELEASED", { actor, ip: IP });
    assert.equal(released.status, "RELEASED");
    assert.throws(() => TestCases.updateTestCase(db, tenant, "VV-TC-1", { name: "nope" }, actor, IP), /cannot edit/i);
  });

  test("revises a released test case without losing history", () => {
    const revised = TestCases.reviseTestCase(db, tenant, "VV-TC-1", { name: "Braking distance (wet)" }, actor, IP);
    assert.equal(revised.revision, "B");
    assert.equal(revised.status, "DRAFT");
    assert.ok(Array.isArray(revised.metadata.revisions));
    assert.equal(revised.metadata.revisions[0].revision, "A");
  });

  test("links a test case to a requirement (VERIFIED_BY) and unlinks it", () => {
    const linked = TestCases.linkRequirement(db, tenant, "VV-TC-1", { requirement_id: requirement.id }, actor, IP);
    assert.equal(linked.relationship.relationship_type, "VERIFIED_BY");
    assert.equal(linked.relationship.source_id, String(requirement.id));
    const list = TestCases.listTestCaseRequirements(db, tenant, "VV-TC-1");
    assert.equal(list.total, 1);
    assert.equal(list.items[0].requirement_id, Number(requirement.id));
    assert.throws(() => TestCases.linkRequirement(db, tenant, "VV-TC-1", { requirement_id: requirement.id }, actor, IP), /already exists/i);
    TestCases.unlinkRequirement(db, tenant, "VV-TC-1", linked.relationship.relationship_ref, actor, IP);
    assert.equal(TestCases.listTestCaseRequirements(db, tenant, "VV-TC-1").total, 0);
  });

  test("derives VALIDATED_BY for a validation test case", () => {
    const linked = TestCases.linkRequirement(db, tenant, "VV-TC-VAL", { requirement_id: requirement.id }, actor, IP);
    assert.equal(linked.relationship.relationship_type, "VALIDATED_BY");
  });

  test("rejects linking an unknown requirement", () => {
    assert.throws(() => TestCases.linkRequirement(db, tenant, "VV-TC-1", { requirement_id: 999999 }, actor, IP), /not found/i);
  });

  test("manages procedures and ordered steps", () => {
    const procedure = TestProcedures.createProcedure(db, tenant, "VV-TC-1", { code: "VV-TP-1", name: "Braking procedure" }, actor, IP);
    assert.equal(procedure.status, "DRAFT");
    assert.equal(procedure.test_case_id, TestCases.getTestCase(db, tenant, "VV-TC-1").id);

    const s1 = TestProcedures.addStep(db, tenant, "VV-TP-1", { instruction: "Accelerate to 100 km/h" }, actor, IP);
    const s2 = TestProcedures.addStep(db, tenant, "VV-TP-1", { instruction: "Apply full brakes", expected_result: "Stop within 40 m" }, actor, IP);
    assert.equal(s1.sequence, 10);
    assert.equal(s2.sequence, 20);

    const updatedStep = TestProcedures.updateStep(db, tenant, "VV-TP-1", s2.id, { expected_result: "Stop within 38 m" }, actor, IP);
    assert.equal(updatedStep.expected_result, "Stop within 38 m");

    const loaded = TestProcedures.getProcedure(db, tenant, "VV-TP-1");
    assert.equal(loaded.steps.length, 2);

    const removed = TestProcedures.removeStep(db, tenant, "VV-TP-1", s2.id, actor, IP);
    assert.equal(removed.removed, true);
    assert.equal(TestProcedures.getProcedure(db, tenant, "VV-TP-1").steps.length, 1);
  });

  test("freezes a released procedure", () => {
    TestProcedures.transitionProcedure(db, tenant, "VV-TP-1", "IN_REVIEW", { actor, ip: IP });
    TestProcedures.transitionProcedure(db, tenant, "VV-TP-1", "APPROVED", { actor, ip: IP });
    const released = TestProcedures.transitionProcedure(db, tenant, "VV-TP-1", "RELEASED", { actor, ip: IP });
    assert.equal(released.status, "RELEASED");
    assert.throws(() => TestProcedures.addStep(db, tenant, "VV-TP-1", { instruction: "late" }, actor, IP), /cannot edit/i);
  });

  test("exposes test cases and procedures over the API", async () => {
    const created = await request(port, "POST", "/api/v1/verification-validation/test-cases", {
      token: adminToken,
      body: { code: "VV-API-TC", name: "API test case", verification_kind: "VALIDATION" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.code, "VV-API-TC");

    const listed = await request(port, "GET", "/api/v1/verification-validation/test-cases?verification_kind=VALIDATION", { token: adminToken });
    assert.equal(listed.status, 200);
    assert.ok(listed.body.items.some((entry) => entry.code === "VV-API-TC"));

    const proc = await request(port, "POST", "/api/v1/verification-validation/test-cases/VV-API-TC/procedures", { token: adminToken, body: { name: "API procedure" } });
    assert.equal(proc.status, 201);
    const procRef = proc.body.procedure_ref;

    const step = await request(port, "POST", `/api/v1/verification-validation/procedures/${procRef}/steps`, { token: adminToken, body: { instruction: "Step one" } });
    assert.equal(step.status, 201);
    assert.equal(step.body.sequence, 10);

    const transitioned = await request(port, "POST", `/api/v1/verification-validation/test-cases/VV-API-TC/transition`, { token: adminToken, body: { status: "IN_REVIEW" } });
    assert.equal(transitioned.status, 200);
    assert.equal(transitioned.body.status, "IN_REVIEW");

    const linked = await request(port, "POST", `/api/v1/verification-validation/test-cases/VV-API-TC/requirements`, { token: adminToken, body: { requirement_id: requirement.id } });
    assert.equal(linked.status, 201);
    assert.equal(linked.body.relationship.relationship_type, "VALIDATED_BY");
  });

  test("requires authentication for the API", async () => {
    const res = await request(port, "GET", "/api/v1/verification-validation/test-cases");
    assert.equal(res.status, 401);
  });
});
