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
  TestExecutions,
  TestResults,
  Coverage,
  Waivers,
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

describe("Verification & Validation waivers & exceptions", () => {
  test("validates waiver status and expiry", () => {
    assert.equal(Waivers.isWaiverValid({ status: "APPROVED", expires_at: null }), true);
    assert.equal(Waivers.isWaiverValid({ status: "REQUESTED", expires_at: null }), false);
    assert.equal(Waivers.isWaiverValid({ status: "REVOKED", expires_at: null }), false);
    assert.equal(Waivers.isWaiverValid({ status: "APPROVED", expires_at: "2000-01-01 00:00:00" }), false);
    assert.equal(Waivers.isWaiverExpired({ expires_at: "2000-01-01 00:00:00" }), true);
    assert.equal(Waivers.isWaiverExpired({ expires_at: "" }), false);
  });

  describe("integration with failures, coverage and the API", () => {
    let db;
    let server;
    let port;
    let adminToken;
    let tenant;
    let actor;
    let requirement;
    let execution;

    before(async () => {
      db = openTestDatabase();
      migrate(db);
      seedDatabase(db);
      ensureRequirementsFoundation(db);
      Foundation.ensureVvFoundation(db);
      tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
      actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");

      requirement = RequirementsManager.createRequirement(db, tenant, { title: "Waived requirement", requirement_type: "business_requirement" }, actor, IP);
      TestCases.createTestCase(db, tenant, { code: "VV-TC-WV", name: "Waiver case", method_code: "TEST" }, actor, IP);
      TestCases.transitionTestCase(db, tenant, "VV-TC-WV", "IN_REVIEW", { actor, ip: IP });
      TestCases.transitionTestCase(db, tenant, "VV-TC-WV", "APPROVED", { actor, ip: IP });
      TestCases.linkRequirement(db, tenant, "VV-TC-WV", { requirement_id: requirement.id }, actor, IP);

      execution = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-WV" }, actor, IP);
      TestExecutions.startExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
      const result = TestResults.recordResult(db, tenant, execution.execution_ref, { actual_value: "45", acceptance_criteria: { operator: "lte", value: 40 } }, actor, IP);
      TestResults.evaluateResult(db, tenant, result.result_ref, {}, actor, IP);
      TestExecutions.completeExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
      TestResults.evaluateExecution(db, tenant, execution.execution_ref, {}, actor, IP);

      const started = await listen(createApp(db));
      server = started.server;
      port = started.port;
      adminToken = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
    });

    after(() => {
      server?.close();
      db?.close();
    });

    test("reports FAILED for a requirement with no valid waiver", () => {
      const coverage = Coverage.computeRequirementCoverage(db, tenant, requirement.id);
      assert.equal(coverage.vnv_status, "FAILED");
      assert.equal(coverage.verification_status, "FAILED");
    });

    test("requests and approves a waiver, driving the requirement to WAIVED", () => {
      const waiver = Waivers.createWaiver(db, tenant, { requirement_id: requirement.id, test_case_id: "VV-TC-WV", execution_ref: execution.execution_ref, justification: "Acceptable engineering risk", risk_assessment: "Low" }, actor, IP);
      assert.equal(waiver.status, "REQUESTED");
      assert.match(waiver.waiver_ref, /^VW-/);

      const approved = Waivers.approveWaiver(db, tenant, waiver.waiver_ref, { actor, ip: IP, reason: "Approved by CCB" });
      assert.equal(approved.status, "APPROVED");
      assert.equal(approved.decision_notes, "Approved by CCB");

      const coverage = Coverage.computeRequirementCoverage(db, tenant, requirement.id);
      assert.equal(coverage.vnv_status, "WAIVED");
      assert.equal(coverage.verification_status, "WAIVED");
      assert.notEqual(coverage.vnv_status, "VERIFIED");

      const active = Waivers.listActiveWaiversForRequirement(db, tenant, requirement.id);
      assert.equal(active.length, 1);
    });

    test("rejects an invalid waiver transition", () => {
      const waiver = Waivers.createWaiver(db, tenant, { requirement_id: requirement.id, justification: "Second waiver" }, actor, IP);
      assert.throws(() => Waivers.transitionWaiver(db, tenant, waiver.waiver_ref, "REVOKED", { actor, ip: IP }), /Invalid transition/i);
      Waivers.rejectWaiver(db, tenant, waiver.waiver_ref, { actor, ip: IP, reason: "Not needed" });
      const rejected = Waivers.getWaiver(db, tenant, waiver.waiver_ref);
      assert.equal(rejected.status, "REJECTED");
      assert.equal(Waivers.isWaiverValid(rejected), false);
    });

    test("revoking a waiver restores the underlying failure", () => {
      for (const active of Waivers.listActiveWaiversForRequirement(db, tenant, requirement.id)) {
        Waivers.revokeWaiver(db, tenant, active.waiver_ref, { actor, ip: IP, reason: "Customer rejected" });
      }
      const waiver = Waivers.createWaiver(db, tenant, { requirement_id: requirement.id, test_case_id: "VV-TC-WV", justification: "Temporary waiver" }, actor, IP);
      Waivers.approveWaiver(db, tenant, waiver.waiver_ref, { actor, ip: IP });
      assert.equal(Coverage.computeRequirementCoverage(db, tenant, requirement.id).vnv_status, "WAIVED");
      Waivers.revokeWaiver(db, tenant, waiver.waiver_ref, { actor, ip: IP, reason: "Customer rejected" });
      const coverage = Coverage.computeRequirementCoverage(db, tenant, requirement.id);
      assert.equal(coverage.vnv_status, "FAILED");
      assert.equal(coverage.verification_status, "FAILED");
    });

    test("expires overdue waivers and removes them from coverage", () => {
      const other = RequirementsManager.createRequirement(db, tenant, { title: "Expiring requirement", requirement_type: "business_requirement" }, actor, IP);
      const waiver = Waivers.createWaiver(db, tenant, { requirement_id: other.id, justification: "Time-boxed waiver", expires_at: "2000-01-01 00:00:00" }, actor, IP);
      Waivers.approveWaiver(db, tenant, waiver.waiver_ref, { actor, ip: IP });
      assert.equal(Waivers.isWaiverValid(Waivers.getWaiver(db, tenant, waiver.waiver_ref)), false);

      const swept = Waivers.expireOverdueWaivers(db, tenant, actor, IP);
      assert.ok(swept.expired >= 1);
      assert.equal(Waivers.getWaiver(db, tenant, waiver.waiver_ref).status, "EXPIRED");
      assert.equal(Waivers.listActiveWaiversForRequirement(db, tenant, other.id).length, 0);
    });

    test("exposes waivers over the API", async () => {
      const created = await request(port, "POST", "/api/v1/verification-validation/waivers", { token: adminToken, body: { requirement_id: requirement.id, justification: "API waiver" } });
      assert.equal(created.status, 201);
      assert.equal(created.body.status, "REQUESTED");

      const approved = await request(port, "POST", `/api/v1/verification-validation/waivers/${created.body.waiver_ref}/transition`, { token: adminToken, body: { status: "APPROVED", reason: "ok" } });
      assert.equal(approved.status, 200);
      assert.equal(approved.body.status, "APPROVED");

      const listed = await request(port, "GET", "/api/v1/verification-validation/waivers?status=APPROVED", { token: adminToken });
      assert.equal(listed.status, 200);
      assert.ok(listed.body.total >= 1);

      const summary = await request(port, "GET", "/api/v1/verification-validation/waivers/summary", { token: adminToken });
      assert.equal(summary.status, 200);
      assert.ok(summary.body.total >= 1);

      const unauth = await request(port, "GET", "/api/v1/verification-validation/waivers");
      assert.equal(unauth.status, 401);
    });
  });
});
