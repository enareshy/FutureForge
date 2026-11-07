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
  Deviation,
  Retest,
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

describe("Verification & Validation failure, retest & deviation integration", () => {
  describe("integration with quality, change and retest", () => {
    let db;
    let server;
    let port;
    let adminToken;
    let tenant;
    let actor;
    let requirement;
    let failedExecution;
    let failedResult;
    let pendingResult;

    before(async () => {
      db = openTestDatabase();
      migrate(db);
      seedDatabase(db);
      ensureRequirementsFoundation(db);
      Foundation.ensureVvFoundation(db);
      tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
      actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");

      requirement = RequirementsManager.createRequirement(db, tenant, { title: "Failure requirement", requirement_type: "business_requirement" }, actor, IP);
      TestCases.createTestCase(db, tenant, { code: "VV-TC-FAIL", name: "Failure case", method_code: "TEST" }, actor, IP);
      TestCases.transitionTestCase(db, tenant, "VV-TC-FAIL", "IN_REVIEW", { actor, ip: IP });
      TestCases.transitionTestCase(db, tenant, "VV-TC-FAIL", "APPROVED", { actor, ip: IP });
      TestCases.linkRequirement(db, tenant, "VV-TC-FAIL", { requirement_id: requirement.id }, actor, IP);

      failedExecution = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-FAIL" }, actor, IP);
      TestExecutions.startExecution(db, tenant, failedExecution.execution_ref, { actor, ip: IP });
      failedResult = TestResults.recordResult(db, tenant, failedExecution.execution_ref, { actual_value: "45", acceptance_criteria: { operator: "lte", value: 40 } }, actor, IP);
      TestResults.evaluateResult(db, tenant, failedResult.result_ref, {}, actor, IP);
      TestExecutions.completeExecution(db, tenant, failedExecution.execution_ref, { actor, ip: IP });
      TestResults.evaluateExecution(db, tenant, failedExecution.execution_ref, {}, actor, IP);

      const pending = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-FAIL" }, actor, IP);
      TestExecutions.startExecution(db, tenant, pending.execution_ref, { actor, ip: IP });
      pendingResult = TestResults.recordResult(db, tenant, pending.execution_ref, { actual_value: "38", acceptance_criteria: { operator: "lte", value: 40 } }, actor, IP);

      const started = await listen(createApp(db));
      server = started.server;
      port = started.port;
      adminToken = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
    });

    after(() => {
      server?.close();
      db?.close();
    });

    test("raises an existing quality exception for a failed result and links it", () => {
      const raised = Deviation.raiseQualityException(db, tenant, { result_ref: failedResult.result_ref, severity: "critical", description: "Braking distance exceeds limit" }, actor, IP);
      assert.match(raised.exception.exception_ref, /^DG-EXC-/);
      assert.equal(raised.target.kind, "result");

      const row = queryOne(db, "SELECT quality_exception_ref, quality_exception_id FROM vv_results WHERE result_ref = ?", [failedResult.result_ref]);
      assert.equal(row.quality_exception_ref, raised.exception.exception_ref);
      assert.ok(row.quality_exception_id);

      const stored = queryOne(db, "SELECT * FROM dg_quality_exceptions WHERE id = ?", [row.quality_exception_id]);
      assert.equal(stored.object_type, "vv_test_result");
      assert.equal(stored.object_id, failedResult.result_ref);
      assert.equal(stored.severity, "critical");
    });

    test("refuses a duplicate open exception and a non-failed target", () => {
      assert.throws(() => Deviation.raiseQualityException(db, tenant, { result_ref: failedResult.result_ref }, actor, IP), /already exists|conflict/i);
      assert.throws(() => Deviation.raiseQualityException(db, tenant, { result_ref: pendingResult.result_ref }, actor, IP), /failed result/i);
    });

    test("raises a quality exception from the failed execution", () => {
      const raised = Deviation.raiseQualityException(db, tenant, { execution_ref: failedExecution.execution_ref, rule_code: "VV_EXECUTION_FAILED" }, actor, IP);
      assert.equal(raised.target.kind, "execution");
      const row = queryOne(db, "SELECT quality_exception_ref FROM vv_executions WHERE execution_ref = ?", [failedExecution.execution_ref]);
      assert.equal(row.quality_exception_ref, raised.exception.exception_ref);
    });

    test("links existing change and deviation references without creating them", () => {
      const linked = Deviation.linkIndependentRecords(db, tenant, { execution_ref: failedExecution.execution_ref, change_ref: "ECR-1001", deviation_ref: "DEV-77" }, actor, IP);
      assert.equal(linked.change_ref, "ECR-1001");
      const row = queryOne(db, "SELECT metadata_json FROM vv_executions WHERE execution_ref = ?", [failedExecution.execution_ref]);
      const metadata = JSON.parse(row.metadata_json);
      assert.deepEqual(metadata.change_references, ["ECR-1001"]);
      assert.deepEqual(metadata.deviation_references, ["DEV-77"]);
    });

    test("lists and summarizes failures", () => {
      const listed = Deviation.listFailures(db, tenant, { test_case_id: queryOne(db, "SELECT id FROM vv_test_cases WHERE code = 'VV-TC-FAIL' AND tenant_id = ?", [tenant]).id });
      assert.equal(listed.total, 1);
      assert.equal(listed.items[0].overall_outcome, "FAIL");

      const summary = Deviation.failureSummary(db, tenant);
      assert.ok(summary.failed_executions >= 1);
      assert.ok(summary.failed_results >= 1);
      assert.ok(summary.executions_with_quality_exception >= 1);
    });

    test("resolves retest policy and plans a retest", () => {
      assert.equal(Retest.resolveRetestPolicy(db, tenant), "FULL_TEST");
      assert.throws(() => Retest.resolveRetestPolicy(db, tenant, "NOPE"), /Invalid retest policy/i);
      const plan = Retest.planRetest(db, tenant, failedExecution.execution_ref, { policy: "FAILED_STEPS" });
      assert.equal(plan.policy, "FAILED_STEPS");
      assert.equal(plan.rerun_all_steps, false);
      assert.ok(plan.failed_result_refs.includes(failedResult.result_ref));
    });

    test("retest creates a new execution linked to the failed one and preserves history", () => {
      const retest = Retest.requestRetest(db, tenant, failedExecution.execution_ref, { reason: "corrected fixture" }, actor, IP);
      const chain = Retest.getRetestChain(db, tenant, retest.execution_ref);
      assert.equal(chain.ancestors.length, 1);
      assert.equal(chain.ancestors[0].execution_ref, failedExecution.execution_ref);
      assert.equal(chain.execution.previous_execution_id, failedExecution.id);

      const original = TestExecutions.getExecution(db, tenant, failedExecution.execution_ref);
      assert.equal(original.status, "REQUIRES_RETEST");
      const originalResult = TestResults.getResult(db, tenant, failedResult.result_ref);
      assert.equal(originalResult.outcome, "FAIL");
    });

    test("exposes failures, retest and quality integration over the API", async () => {
      const failures = await request(port, "GET", "/api/v1/verification-validation/failures", { token: adminToken });
      assert.equal(failures.status, 200);
      assert.ok(failures.body.total >= 1);

      const summary = await request(port, "GET", "/api/v1/verification-validation/failures/summary", { token: adminToken });
      assert.equal(summary.status, 200);

      const plan = await request(port, "GET", `/api/v1/verification-validation/executions/${failedExecution.execution_ref}/retest-plan`, { token: adminToken });
      assert.equal(plan.status, 200);
      assert.equal(plan.body.policy, "FULL_TEST");

      const chain = await request(port, "GET", `/api/v1/verification-validation/executions/${failedExecution.execution_ref}/retest-chain`, { token: adminToken });
      assert.equal(chain.status, 200);
      assert.ok(chain.body.descendants.length >= 1);

      const raised = await request(port, "POST", "/api/v1/verification-validation/quality-exceptions", { token: adminToken, body: { execution_ref: failedExecution.execution_ref, rule_code: "VV_API_FAILED" } });
      assert.equal(raised.status, 201);
      assert.ok(raised.body.exception.exception_ref);

      const linked = await request(port, "POST", "/api/v1/verification-validation/failures/link-records", { token: adminToken, body: { execution_ref: failedExecution.execution_ref, change_ref: "ECR-2002" } });
      assert.equal(linked.status, 200);
      assert.equal(linked.body.change_ref, "ECR-2002");
    });
  });
});
