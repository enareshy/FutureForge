process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createApp } from "../app.js";
import { RequirementsManager, ensureRequirementsFoundation } from "../services/requirements/index.js";
import { createContent } from "../services/content.js";
import {
  TestCases,
  TestExecutions,
  TestResults,
  Evidence,
  Coverage,
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

describe("Verification & Validation coverage aggregation", () => {
  test("aggregates outcomes under each rule", () => {
    const pass = { outcome: "PASS" };
    const fail = { outcome: "FAIL" };
    const pending = { outcome: "PENDING" };
    const blocked = { outcome: "BLOCKED" };
    const waived = { outcome: "WAIVED" };

    assert.equal(Coverage.aggregateOutcomes([], "ALL_MANDATORY").outcome, "NOT_STARTED");
    assert.equal(Coverage.aggregateOutcomes([pass, pass], "ALL_MANDATORY").outcome, "PASS");
    assert.equal(Coverage.aggregateOutcomes([pass, waived], "ALL_MANDATORY").outcome, "PASS");
    assert.equal(Coverage.aggregateOutcomes([pass, fail], "ALL_MANDATORY").outcome, "FAIL");
    assert.equal(Coverage.aggregateOutcomes([pass, pending], "ALL_MANDATORY").outcome, "PENDING");
    assert.equal(Coverage.aggregateOutcomes([pass, blocked], "ALL_MANDATORY").outcome, "BLOCKED");

    assert.equal(Coverage.aggregateOutcomes([pass, fail, fail], "ANY").outcome, "PASS");
    assert.equal(Coverage.aggregateOutcomes([fail, fail, pending], "ANY").outcome, "FAIL");
    assert.equal(Coverage.aggregateOutcomes([pass, pass, fail], "MAJORITY").outcome, "PASS");
    assert.equal(Coverage.aggregateOutcomes([pass, fail, fail], "MAJORITY").outcome, "FAIL");

    const summary = Coverage.aggregateOutcomes([pass, fail, waived], "ALL_MANDATORY");
    assert.deepEqual({ total: summary.total, pass: summary.pass, fail: summary.fail, waived: summary.waived }, { total: 3, pass: 1, fail: 1, waived: 1 });
  });

  test("derives planning and execution coverage", () => {
    assert.equal(Coverage.planningCoverage([]).status, "NOT_PLANNED");
    assert.equal(Coverage.planningCoverage([{ status: "APPROVED" }, { status: "RELEASED" }]).status, "PLANNED");
    assert.equal(Coverage.planningCoverage([{ status: "APPROVED" }, { status: "DRAFT" }]).status, "PARTIAL");

    assert.equal(Coverage.executionCoverage({ total: 0, not_started: 0, pass: 0, fail: 0, waived: 0, blocked: 0 }), "NOT_STARTED");
    assert.equal(Coverage.executionCoverage({ total: 2, not_started: 2, pass: 0, fail: 0, waived: 0, blocked: 0 }), "NOT_STARTED");
    assert.equal(Coverage.executionCoverage({ total: 2, not_started: 1, pass: 1, fail: 0, waived: 0, blocked: 0 }), "IN_PROGRESS");
    assert.equal(Coverage.executionCoverage({ total: 2, not_started: 0, pass: 1, fail: 0, waived: 1, blocked: 0 }), "COMPLETE");
  });

  test("composites verification and validation status without a false PASS", () => {
    assert.equal(Coverage.compositeStatus({ verification: { total: 0 }, validation: { total: 0 }, planning: { status: "NOT_PLANNED" } }), "NOT_PLANNED");
    assert.equal(Coverage.compositeStatus({ verification: { total: 1, outcome: "PASS" }, validation: { total: 0 }, planning: { status: "PLANNED" } }), "VERIFIED");
    assert.equal(Coverage.compositeStatus({ verification: { total: 1, outcome: "PASS" }, validation: { total: 1, outcome: "PASS" }, planning: { status: "PLANNED" } }), "VALIDATION_COMPLETE");
    assert.equal(Coverage.compositeStatus({ verification: { total: 1, outcome: "FAIL" }, validation: { total: 1, outcome: "PASS" }, planning: { status: "PLANNED" } }), "FAILED");
    assert.equal(Coverage.compositeStatus({ verification: { total: 1, outcome: "PASS", pass: 1 }, validation: { total: 1, outcome: "PENDING" }, planning: { status: "PLANNED" } }), "PARTIALLY_VERIFIED");
  });

  test("maps V&V status onto the existing requirement vocabularies", () => {
    assert.deepEqual(Coverage.mapRequirementStatuses("VERIFIED", { outcome: "NOT_STARTED" }), { verification_status: "VERIFIED", validation_status: "NOT_VALIDATED" });
    assert.equal(Coverage.mapRequirementStatuses("FAILED", { outcome: "FAIL" }).verification_status, "FAILED");
    assert.equal(Coverage.mapRequirementStatuses("WAIVED", { outcome: "PASS" }).verification_status, "WAIVED");
    assert.equal(Coverage.mapRequirementStatuses("VALIDATION_COMPLETE", { outcome: "PASS" }).validation_status, "VALIDATED");
  });

  describe("integration with requirements, executions and evidence", () => {
    let db;
    let server;
    let port;
    let adminToken;
    let tenant;
    let actor;
    let evidenceContentId;
    let verifiedRequirement;
    let unplannedRequirement;

    before(async () => {
      db = openTestDatabase();
      migrate(db);
      seedDatabase(db);
      ensureRequirementsFoundation(db);
      Foundation.ensureVvFoundation(db);
      tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
      actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");

      verifiedRequirement = RequirementsManager.createRequirement(db, tenant, { title: "Verifiable requirement", requirement_type: "business_requirement" }, actor, IP);
      unplannedRequirement = RequirementsManager.createRequirement(db, tenant, { title: "Unplanned requirement", requirement_type: "business_requirement" }, actor, IP);

      TestCases.createTestCase(db, tenant, { code: "VV-TC-COV", name: "Coverage case", method_code: "TEST" }, actor, IP);
      TestCases.transitionTestCase(db, tenant, "VV-TC-COV", "IN_REVIEW", { actor, ip: IP });
      TestCases.transitionTestCase(db, tenant, "VV-TC-COV", "APPROVED", { actor, ip: IP });
      TestCases.linkRequirement(db, tenant, "VV-TC-COV", { requirement_id: verifiedRequirement.id }, actor, IP);

      TestCases.createTestCase(db, tenant, { code: "VV-TC-DRAFT-COV", name: "Draft coverage case", verification_kind: "VALIDATION" }, actor, IP);
      TestCases.linkRequirement(db, tenant, "VV-TC-DRAFT-COV", { requirement_id: unplannedRequirement.id }, actor, IP);

      const content = await createContent(db, { fileName: "evidence.txt", mimeType: "text/plain", buffer: Buffer.from("coverage-evidence") }, { tenantId: tenant, actor, process: false });
      evidenceContentId = content.id;

      const started = await listen(createApp(db));
      server = started.server;
      port = started.port;
      adminToken = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
    });

    after(() => {
      server?.close();
      db?.close();
    });

    test("reports NOT_PLANNED before any approved test case is linked", () => {
      const coverage = Coverage.computeRequirementCoverage(db, tenant, unplannedRequirement.id);
      assert.equal(coverage.planning_coverage.status, "NOT_PLANNED");
      assert.equal(coverage.execution_coverage.validation, "NOT_STARTED");
      assert.equal(coverage.vnv_status, "NOT_PLANNED");
      assert.equal(coverage.verification_status, "NOT_VERIFIED");
      assert.equal(coverage.gaps.length, 1);
    });

    test("verifies a requirement once its execution passes with evidence", () => {
      const execution = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-COV" }, actor, IP);
      TestExecutions.startExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
      const result = TestResults.recordResult(db, tenant, execution.execution_ref, { actual_value: "38", acceptance_criteria: { operator: "lte", value: 40 } }, actor, IP);
      Evidence.attachEvidence(db, tenant, { result_ref: result.result_ref, content_id: evidenceContentId }, actor, IP);
      TestResults.evaluateResult(db, tenant, result.result_ref, {}, actor, IP);
      TestExecutions.completeExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
      TestResults.evaluateExecution(db, tenant, execution.execution_ref, {}, actor, IP);

      const coverage = Coverage.computeRequirementCoverage(db, tenant, verifiedRequirement.id);
      assert.equal(coverage.planning_coverage.status, "PLANNED");
      assert.equal(coverage.execution_coverage.verification, "COMPLETE");
      assert.equal(coverage.verification.outcome, "PASS");
      assert.equal(coverage.vnv_status, "VERIFIED");
    });

    test("recalculates and persists the requirement verification status idempotently", () => {
      const first = Coverage.recalculateRequirement(db, tenant, verifiedRequirement.id, actor, IP);
      assert.equal(first.changed, true);
      assert.equal(first.verification_status, "VERIFIED");
      const refreshed = queryOne(db, "SELECT verification_status FROM requirements WHERE id = ?", [verifiedRequirement.id]);
      assert.equal(refreshed.verification_status, "VERIFIED");

      const second = Coverage.recalculateRequirement(db, tenant, verifiedRequirement.id, actor, IP);
      assert.equal(second.changed, false);
    });

    test("recalculates downstream requirements from a changed test case", () => {
      const result = Coverage.recalculateForTestCases(db, tenant, [queryOne(db, "SELECT id FROM vv_test_cases WHERE tenant_id = ? AND code = 'VV-TC-COV'", [tenant]).id], actor, IP);
      assert.equal(result.count, 1);
    });

    test("lists coverage and summarizes by status", () => {
      const listed = Coverage.listRequirementCoverage(db, tenant, {});
      assert.ok(listed.total >= 2);
      assert.ok(listed.items.every((item) => item.source_module === "verification-validation"));

      const summary = Coverage.coverageSummary(db, tenant);
      assert.ok(summary.total >= 2);
      assert.ok(summary.by_verification_status.VERIFIED >= 1);
    });

    test("exposes coverage over the API", async () => {
      const direct = await request(port, "GET", `/api/v1/verification-validation/requirements/${verifiedRequirement.requirement_ref}/coverage`, { token: adminToken });
      assert.equal(direct.status, 200);
      assert.equal(direct.body.vnv_status, "VERIFIED");

      const recalculated = await request(port, "POST", `/api/v1/verification-validation/requirements/${verifiedRequirement.requirement_ref}/coverage/recalculate`, { token: adminToken, body: {} });
      assert.equal(recalculated.status, 200);

      const list = await request(port, "GET", "/api/v1/verification-validation/coverage/requirements", { token: adminToken });
      assert.equal(list.status, 200);
      assert.ok(list.body.total >= 2);

      const summary = await request(port, "GET", "/api/v1/verification-validation/coverage/summary", { token: adminToken });
      assert.equal(summary.status, 200);

      const unauth = await request(port, "GET", "/api/v1/verification-validation/coverage/summary");
      assert.equal(unauth.status, 401);
    });
  });
});
