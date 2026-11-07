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
  TestProcedures,
  TestExecutions,
  TestResults,
  Evidence,
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

describe("Verification & Validation executions, results & evidence", () => {
  let db;
  let server;
  let port;
  let adminToken;
  let tenant;
  let actor;
  let requirement;
  let evidenceContentId;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureRequirementsFoundation(db);
    Foundation.ensureVvFoundation(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    requirement = RequirementsManager.createRequirement(db, tenant, { title: "Executable requirement", requirement_type: "business_requirement" }, actor, IP);

    TestCases.createTestCase(db, tenant, { code: "VV-TC-EXE", name: "Execution case", method_code: "TEST" }, actor, IP);
    TestCases.transitionTestCase(db, tenant, "VV-TC-EXE", "IN_REVIEW", { actor, ip: IP });
    TestCases.transitionTestCase(db, tenant, "VV-TC-EXE", "APPROVED", { actor, ip: IP });
    TestCases.createTestCase(db, tenant, { code: "VV-TC-DRAFT", name: "Draft case" }, actor, IP);

    TestProcedures.createProcedure(db, tenant, "VV-TC-EXE", { code: "VV-TP-EXE", name: "Execution procedure" }, actor, IP);
    TestProcedures.addStep(db, tenant, "VV-TP-EXE", { instruction: "Measure braking distance", expected_result: "<= 40" }, actor, IP);

    const content = await createContent(db, { fileName: "evidence.txt", mimeType: "text/plain", buffer: Buffer.from("evidence-bytes") }, { tenantId: tenant, actor, process: false });
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

  test("plans an execution with pinned definitions and requirement scope", () => {
    const execution = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-EXE", procedure_id: "VV-TP-EXE", requirement_ids: [requirement.id], effectivity: "Lot 1" }, actor, IP);
    assert.equal(execution.status, "PLANNED");
    assert.equal(execution.test_case_revision, "A");
    assert.equal(execution.procedure_revision, "A");
    assert.deepEqual(execution.requirement_ids, [Number(requirement.id)]);
    assert.equal(execution.effectivity, "Lot 1");
    assert.match(execution.execution_ref, /^TE-/);
  });

  test("refuses to execute a test case that is not approved", () => {
    assert.throws(() => TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-DRAFT" }, actor, IP), /approved/i);
  });

  test("runs start/complete lifecycle and guards completion without results", () => {
    const execution = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-EXE" }, actor, IP);
    const started = TestExecutions.startExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
    assert.equal(started.status, "IN_PROGRESS");
    assert.ok(started.actual_start_at);
    assert.throws(() => TestExecutions.completeExecution(db, tenant, execution.execution_ref, { actor, ip: IP }), /at least one recorded result/i);
  });

  test("records a measurement and evaluates objective acceptance criteria", () => {
    const execution = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-EXE" }, actor, IP);
    TestExecutions.startExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
    const result = TestResults.recordResult(db, tenant, execution.execution_ref, { result_level: "MEASUREMENT", actual_value: "38", unit: "m", acceptance_criteria: { operator: "lte", value: 40 } }, actor, IP);
    assert.equal(result.outcome, "PENDING");
    assert.equal(result.evidence_count, 0);
    assert.equal(TestResults.evaluateCriteria({ operator: "lte", value: 40 }, "38").outcome, "PASS");
    assert.equal(TestResults.evaluateCriteria({ operator: "lte", value: 40 }, "42").outcome, "FAIL");
  });

  test("blocks a PASS without evidence, then clears it once evidence is attached", () => {
    const execution = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-EXE" }, actor, IP);
    TestExecutions.startExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
    const result = TestResults.recordResult(db, tenant, execution.execution_ref, { actual_value: "38", acceptance_criteria: { operator: "lte", value: 40 } }, actor, IP);
    assert.throws(() => TestResults.evaluateResult(db, tenant, result.result_ref, {}, actor, IP), /evidence/i);

    const attached = Evidence.attachEvidence(db, tenant, { result_ref: result.result_ref, content_id: evidenceContentId, notes: "Test bench log" }, actor, IP);
    assert.equal(attached.evidence_count, 1);
    assert.equal(attached.association.role, "EVIDENCE");
    assert.equal(attached.association.content_role, "ATTACHMENT");

    const evaluated = TestResults.evaluateResult(db, tenant, result.result_ref, {}, actor, IP);
    assert.equal(evaluated.result.outcome, "PASS");
    assert.equal(evaluated.execution_outcome, "PASS");

    const listed = Evidence.listEvidence(db, tenant, { result_ref: result.result_ref });
    assert.equal(listed.total, 1);
    const detached = Evidence.detachEvidence(db, tenant, attached.association.association_ref, actor, IP);
    assert.equal(detached.removed, true);
    assert.equal(detached.evidence_count, 0);
  });

  test("rolls a failing result up to the execution and evaluates the execution", () => {
    const execution = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-EXE" }, actor, IP);
    TestExecutions.startExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
    const pass = TestResults.recordResult(db, tenant, execution.execution_ref, { actual_value: "38", acceptance_criteria: { operator: "lte", value: 40 } }, actor, IP);
    Evidence.attachEvidence(db, tenant, { result_ref: pass.result_ref, content_id: evidenceContentId }, actor, IP);
    TestResults.evaluateResult(db, tenant, pass.result_ref, {}, actor, IP);

    const fail = TestResults.recordResult(db, tenant, execution.execution_ref, { actual_value: "45", acceptance_criteria: { operator: "lte", value: 40 } }, actor, IP);
    const evaluatedFail = TestResults.evaluateResult(db, tenant, fail.result_ref, {}, actor, IP);
    assert.equal(evaluatedFail.result.outcome, "FAIL");
    assert.equal(evaluatedFail.execution_outcome, "FAIL");

    TestExecutions.completeExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
    const summary = TestResults.evaluateExecution(db, tenant, execution.execution_ref, {}, actor, IP);
    assert.equal(summary.execution.status, "EVALUATED");
    assert.equal(summary.execution_outcome, "FAIL");
    assert.equal(summary.result_count, 2);
  });

  test("supports a manual outcome when criteria cannot be computed", () => {
    const execution = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-EXE" }, actor, IP);
    TestExecutions.startExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
    const result = TestResults.recordResult(db, tenant, execution.execution_ref, { actual_value: "observed", acceptance_criteria: { operator: "custom" } }, actor, IP);
    const evaluated = TestResults.evaluateResult(db, tenant, result.result_ref, { outcome: "NOT_EVALUABLE", failure_reason: "subjective" }, actor, IP);
    assert.equal(evaluated.result.outcome, "NOT_EVALUABLE");
    assert.equal(evaluated.result.manual, true);
  });

  test("requests a retest that links to the previous execution", () => {
    const execution = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-EXE", requirement_ids: [requirement.id] }, actor, IP);
    TestExecutions.startExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
    const result = TestResults.recordResult(db, tenant, execution.execution_ref, { actual_value: "45", acceptance_criteria: { operator: "lte", value: 40 } }, actor, IP);
    TestResults.evaluateResult(db, tenant, result.result_ref, {}, actor, IP);
    TestExecutions.completeExecution(db, tenant, execution.execution_ref, { actor, ip: IP });

    const retest = TestExecutions.requestRetest(db, tenant, execution.execution_ref, { reason: "corrected fixture" }, actor, IP);
    assert.equal(retest.status, "PLANNED");
    assert.equal(retest.previous_execution_id, execution.id);
    assert.equal(retest.retest_reason, "corrected fixture");
    assert.deepEqual(retest.requirement_ids, [Number(requirement.id)]);
    assert.equal(TestExecutions.getExecution(db, tenant, execution.execution_ref).status, "REQUIRES_RETEST");
    const children = TestExecutions.listExecutions(db, { tenantId: tenant, previously_of: execution.id });
    assert.equal(children.total, 1);
  });

  test("exposes executions, results and evidence over the API", async () => {
    const created = await request(port, "POST", "/api/v1/verification-validation/executions", { token: adminToken, body: { test_case_id: "VV-TC-EXE" } });
    assert.equal(created.status, 201);
    const executionRef = created.body.execution_ref;

    const readied = await request(port, "POST", `/api/v1/verification-validation/executions/${executionRef}/transition`, { token: adminToken, body: { status: "READY" } });
    assert.equal(readied.status, 200);
    const started = await request(port, "POST", `/api/v1/verification-validation/executions/${executionRef}/transition`, { token: adminToken, body: { status: "IN_PROGRESS" } });
    assert.equal(started.status, 200);
    assert.equal(started.body.status, "IN_PROGRESS");

    const result = await request(port, "POST", `/api/v1/verification-validation/executions/${executionRef}/results`, { token: adminToken, body: { actual_value: "38", acceptance_criteria: { operator: "lte", value: 40 } } });
    assert.equal(result.status, 201);

    const evidence = await request(port, "POST", "/api/v1/verification-validation/evidence", { token: adminToken, body: { result_ref: result.body.result_ref, content_id: evidenceContentId } });
    assert.equal(evidence.status, 201);
    assert.equal(evidence.body.evidence_count, 1);

    const evaluated = await request(port, "POST", `/api/v1/verification-validation/results/${result.body.result_ref}/evaluate`, { token: adminToken, body: {} });
    assert.equal(evaluated.status, 200);
    assert.equal(evaluated.body.result.outcome, "PASS");

    const listed = await request(port, "GET", `/api/v1/verification-validation/results?execution_id=${created.body.id}`, { token: adminToken });
    assert.equal(listed.status, 200);
    assert.equal(listed.body.total, 1);
  });

  test("rejects an invalid execution transition and unknown execution", () => {
    const execution = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-EXE" }, actor, IP);
    assert.throws(() => TestExecutions.transitionExecution(db, tenant, execution.execution_ref, "EVALUATED", { actor, ip: IP }), /Invalid transition/i);
    assert.throws(() => TestExecutions.requireExecutionRow(db, tenant, "TE-NOPE"), /not found/i);
  });

  test("requires authentication for the API", async () => {
    const res = await request(port, "GET", "/api/v1/verification-validation/executions");
    assert.equal(res.status, 401);
  });
});
