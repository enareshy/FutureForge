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
import { createContent } from "../services/content.js";
import { providersForType } from "../services/thread/providers.js";
import {
  TestCases,
  TestProcedures,
  TestExecutions,
  TestResults,
  Evidence,
  Coverage,
  Waivers,
  Deviation,
  RevisionImpact,
  Foundation,
  Audit,
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

// End-to-end acceptance: the 12 canonical V&V scenarios, exercised through the
// real service layer and the REST API on a migrated + seeded database.
describe("Verification & Validation end-to-end acceptance", () => {
  let db;
  let server;
  let port;
  let token;
  let tenant;
  let actor;

  // Requirement A: happy path. Requirement B: failure -> retest. Requirement C: waiver.
  let reqA;
  let reqB;
  let reqC;

  let execA;
  let contentId;

  function makeRequirement(title) {
    const created = RequirementsManager.createRequirement(db, tenant, { title, requirement_type: "business_requirement" }, actor, IP);
    ensureRequirementObject(db, tenant, created, actor, IP);
    return queryOne(db, "SELECT * FROM requirements WHERE id = ?", [created.id]);
  }

  function approvedTestCase(code, name, kind = "VERIFICATION") {
    TestCases.createTestCase(db, tenant, { code, name, method_code: "TEST", verification_kind: kind }, actor, IP);
    TestCases.transitionTestCase(db, tenant, code, "IN_REVIEW", { actor, ip: IP });
    TestCases.transitionTestCase(db, tenant, code, "APPROVED", { actor, ip: IP });
    return queryOne(db, "SELECT * FROM vv_test_cases WHERE tenant_id = ? AND code = ?", [tenant, code]);
  }

  function passExecution(testCaseCode, requirement) {
    const execution = TestExecutions.createExecution(db, tenant, { test_case_id: testCaseCode, requirement_ids: [requirement.id] }, actor, IP);
    TestExecutions.startExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
    const result = TestResults.recordResult(db, tenant, execution.execution_ref, { requirement_id: requirement.id, requirement_revision: requirement.revision, actual_value: "1", acceptance_criteria: { operator: "eq", value: 1 } }, actor, IP);
    Evidence.attachEvidence(db, tenant, { result_ref: result.result_ref, content_id: contentId }, actor, IP);
    TestResults.evaluateResult(db, tenant, result.result_ref, {}, actor, IP);
    TestExecutions.completeExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
    TestResults.evaluateExecution(db, tenant, execution.execution_ref, {}, actor, IP);
    return queryOne(db, "SELECT * FROM vv_executions WHERE execution_ref = ?", [execution.execution_ref]);
  }

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureRequirementPdmFoundation(db);
    Foundation.ensureVvFoundation(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT * FROM users WHERE username = 'admin'");
    const content = await createContent(db, { fileName: "vv-e2e.txt", mimeType: "text/plain", buffer: Buffer.from("vv-e2e") }, { tenantId: tenant, actor, process: false });
    contentId = content.id;
    const started = await listen(createApp(db));
    server = started.server;
    port = started.port;
    token = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
  });

  after(() => {
    server?.close();
    db?.close();
  });

  test("Scenario 1 — foundation registers the V&V Digital Thread provider", () => {
    const providers = providersForType("test_case");
    assert.ok(providers.some((provider) => provider.code === "verification-validation"));
  });

  test("Scenario 2 — plan a requirement, approve a test case and link VERIFIED_BY", () => {
    reqA = makeRequirement("E2E requirement A");
    const tc = approvedTestCase("VV-E2E-A", "E2E case A");
    assert.equal(tc.status, "APPROVED");
    TestCases.linkRequirement(db, tenant, "VV-E2E-A", { requirement_id: reqA.id, relationship_type: "VERIFIED_BY" }, actor, IP);

    const coverage = Coverage.computeRequirementCoverage(db, tenant, reqA.requirement_ref);
    assert.ok(coverage.planning_coverage.total >= 1);
    assert.equal(coverage.planning_coverage.planned >= 1, true);
  });

  test("Scenario 3 — define a procedure with ordered steps", () => {
    TestProcedures.createProcedure(db, tenant, "VV-E2E-A", { code: "VV-E2E-TP-A", name: "E2E procedure A" }, actor, IP);
    TestProcedures.addStep(db, tenant, "VV-E2E-TP-A", { code: "S1", instruction: "Measure", sequence: 1 }, actor, IP);
    const procedure = TestProcedures.getProcedure(db, tenant, "VV-E2E-TP-A");
    const steps = TestProcedures.loadSteps(db, procedure.id);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].instruction, "Measure");
  });

  test("Scenario 4 — plan an execution that pins the approved definition revision and requirement scope", () => {
    const tc = queryOne(db, "SELECT * FROM vv_test_cases WHERE tenant_id = ? AND code = 'VV-E2E-A'", [tenant]);
    execA = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-E2E-A", requirement_ids: [reqA.id] }, actor, IP);
    assert.equal(execA.test_case_revision, tc.revision);
    assert.deepEqual(execA.requirement_ids, [reqA.id]);
    assert.equal(execA.status, "PLANNED");
  });

  test("Scenario 5 — execute, record a result, attach evidence and evaluate to PASS", () => {
    TestExecutions.startExecution(db, tenant, execA.execution_ref, { actor, ip: IP });
    const result = TestResults.recordResult(db, tenant, execA.execution_ref, { requirement_id: reqA.id, requirement_revision: reqA.revision, actual_value: "1", acceptance_criteria: { operator: "eq", value: 1 } }, actor, IP);
    Evidence.attachEvidence(db, tenant, { result_ref: result.result_ref, content_id: contentId }, actor, IP);
    const evaluated = TestResults.evaluateResult(db, tenant, result.result_ref, {}, actor, IP);
    assert.equal(evaluated.result.outcome, "PASS");
    TestExecutions.completeExecution(db, tenant, execA.execution_ref, { actor, ip: IP });
    const execution = TestResults.evaluateExecution(db, tenant, execA.execution_ref, {}, actor, IP);
    assert.equal(execution.execution.overall_outcome, "PASS");
  });

  test("Scenario 6 — coverage recalculation drives the requirement to VERIFIED", () => {
    const recalculated = Coverage.recalculateRequirement(db, tenant, reqA.requirement_ref, actor, IP);
    assert.equal(recalculated.vnv_status, "VERIFIED");
    const stored = queryOne(db, "SELECT verification_status, validation_status FROM requirements WHERE id = ?", [reqA.id]);
    assert.equal(stored.verification_status, "VERIFIED");
  });

  test("Scenario 7 — a result cannot PASS without supporting evidence", () => {
    const reqD = makeRequirement("E2E requirement D");
    approvedTestCase("VV-E2E-D", "E2E case D");
    TestCases.linkRequirement(db, tenant, "VV-E2E-D", { requirement_id: reqD.id }, actor, IP);
    const execution = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-E2E-D", requirement_ids: [reqD.id] }, actor, IP);
    TestExecutions.startExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
    const result = TestResults.recordResult(db, tenant, execution.execution_ref, { requirement_id: reqD.id, actual_value: "1", acceptance_criteria: { operator: "eq", value: 1 } }, actor, IP);
    assert.throws(
      () => TestResults.evaluateResult(db, tenant, result.result_ref, {}, actor, IP),
      (err) => err.code === "VERIFICATION_VALIDATION_EVIDENCE_REQUIRED"
    );
  });

  test("Scenario 8 — a failure drives the requirement to FAILED and raises a quality exception", () => {
    reqB = makeRequirement("E2E requirement B");
    approvedTestCase("VV-E2E-B", "E2E case B");
    TestCases.linkRequirement(db, tenant, "VV-E2E-B", { requirement_id: reqB.id }, actor, IP);

    const execution = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-E2E-B", requirement_ids: [reqB.id] }, actor, IP);
    TestExecutions.startExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
    const result = TestResults.recordResult(db, tenant, execution.execution_ref, { requirement_id: reqB.id, actual_value: "2", acceptance_criteria: { operator: "eq", value: 1 } }, actor, IP);
    const evaluated = TestResults.evaluateResult(db, tenant, result.result_ref, {}, actor, IP);
    assert.equal(evaluated.result.outcome, "FAIL");
    TestExecutions.completeExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
    const rolled = TestResults.evaluateExecution(db, tenant, execution.execution_ref, {}, actor, IP);
    assert.equal(rolled.execution.overall_outcome, "FAIL");

    const recalculated = Coverage.recalculateRequirement(db, tenant, reqB.requirement_ref, actor, IP);
    assert.equal(recalculated.vnv_status, "FAILED");

    const raised = Deviation.raiseQualityException(db, tenant, { execution_ref: execution.execution_ref, severity: "error", summary: "E2E failure" }, actor, IP);
    assert.ok(raised.exception && raised.exception.exception_ref);
  });

  test("Scenario 9 — a retest creates a linked new execution and can restore VERIFIED", () => {
    const source = queryOne(db, "SELECT execution_ref FROM vv_executions WHERE tenant_id = ? AND test_case_id = (SELECT id FROM vv_test_cases WHERE tenant_id = ? AND code = 'VV-E2E-B') ORDER BY id ASC LIMIT 1", [tenant, tenant]);
    const retest = TestExecutions.requestRetest(db, tenant, source.execution_ref, { reason: "rework" }, actor, IP);
    assert.ok(retest.previous_execution_id);
    const previousRef = queryOne(db, "SELECT execution_ref FROM vv_executions WHERE id = ?", [retest.previous_execution_id]);
    assert.equal(previousRef.execution_ref, source.execution_ref);

    TestExecutions.startExecution(db, tenant, retest.execution_ref, { actor, ip: IP });
    const result = TestResults.recordResult(db, tenant, retest.execution_ref, { requirement_id: reqB.id, actual_value: "1", acceptance_criteria: { operator: "eq", value: 1 } }, actor, IP);
    Evidence.attachEvidence(db, tenant, { result_ref: result.result_ref, content_id: contentId }, actor, IP);
    TestResults.evaluateResult(db, tenant, result.result_ref, {}, actor, IP);
    TestExecutions.completeExecution(db, tenant, retest.execution_ref, { actor, ip: IP });
    TestResults.evaluateExecution(db, tenant, retest.execution_ref, {}, actor, IP);

    const recalculated = Coverage.recalculateRequirement(db, tenant, reqB.requirement_ref, actor, IP);
    assert.equal(recalculated.vnv_status, "VERIFIED");
  });

  test("Scenario 10 — an approved waiver yields WAIVED; a revoked waiver does not count", () => {
    reqC = makeRequirement("E2E requirement C");
    approvedTestCase("VV-E2E-C", "E2E case C");
    TestCases.linkRequirement(db, tenant, "VV-E2E-C", { requirement_id: reqC.id }, actor, IP);

    const waiver = Waivers.createWaiver(db, tenant, { requirement_id: reqC.id, test_case_id: "VV-E2E-C", justification: "Accepted risk" }, actor, IP);
    assert.equal(waiver.status, "REQUESTED");
    Waivers.transitionWaiver(db, tenant, waiver.waiver_ref, "APPROVED", { actor, ip: IP });

    const waived = Coverage.recalculateRequirement(db, tenant, reqC.requirement_ref, actor, IP);
    assert.equal(waived.vnv_status, "WAIVED");

    Waivers.transitionWaiver(db, tenant, waiver.waiver_ref, "REVOKED", { actor, ip: IP, reason: "risk changed" });
    const afterRevoke = Coverage.recalculateRequirement(db, tenant, reqC.requirement_ref, actor, IP);
    assert.notEqual(afterRevoke.vnv_status, "WAIVED");
  });

  test("Scenario 11 — revising a definition flags potentially stale evidence without losing history", () => {
    const current = queryOne(db, "SELECT * FROM vv_test_cases WHERE tenant_id = ? AND code = 'VV-E2E-A'", [tenant]);
    TestCases.reviseTestCase(db, tenant, "VV-E2E-A", { version: current.version, reason: "design change" }, actor, IP);

    const assessment = RevisionImpact.assessExecutionApplicability(db, tenant, execA.execution_ref);
    assert.equal(assessment.status, "STALE");

    const scan = RevisionImpact.scanStaleEvidence(db, tenant, {}, actor, IP);
    assert.equal(scan.enabled, true);
    assert.equal(scan.auto_invalidate, false);
    assert.ok(scan.stale >= 1);

    const stillThere = queryOne(db, "SELECT id FROM vv_executions WHERE execution_ref = ?", [execA.execution_ref]);
    assert.ok(stillThere, "history is never deleted");

    // Revising a definition drops it out of approved planning coverage until it
    // is re-approved, then the requirement can be verified again.
    assert.equal(Coverage.computeRequirementCoverage(db, tenant, reqA.requirement_ref).planning_coverage.status, "NOT_PLANNED");
    TestCases.transitionTestCase(db, tenant, "VV-E2E-A", "IN_REVIEW", { actor, ip: IP });
    TestCases.transitionTestCase(db, tenant, "VV-E2E-A", "APPROVED", { actor, ip: IP });
    assert.equal(Coverage.recalculateRequirement(db, tenant, reqA.requirement_ref, actor, IP).vnv_status, "VERIFIED");
  });

  test("Scenario 12 — traceability, impact, audit and the REST API are wired end to end", async () => {
    const trace = RevisionImpact.traceRequirement(db, tenant, reqA.requirement_ref, { direction: "DOWNSTREAM" }, actor);
    assert.equal(trace.direction, "DOWNSTREAM");
    assert.ok(trace.node_count >= 1);

    const impact = RevisionImpact.analyzeRequirementImpact(db, tenant, reqA.requirement_ref, {}, actor, IP);
    assert.ok(impact.impacted_count >= 1);

    const audit = Audit.listVvAudit(db, { tenantId: tenant }, { pageSize: 5 });
    assert.ok(audit.total >= 1);

    const meta = await request(port, "GET", "/api/v1/verification-validation/meta", { token });
    assert.equal(meta.status, 200);

    const coverage = await request(port, "GET", `/api/v1/verification-validation/requirements/${reqA.requirement_ref}/coverage`, { token });
    assert.equal(coverage.status, 200);
    assert.equal(coverage.body.verification_status, "VERIFIED");

    const traceApi = await request(port, "GET", `/api/v1/verification-validation/requirements/${reqA.requirement_ref}/trace?direction=UPSTREAM`, { token });
    assert.equal(traceApi.status, 200);

    const unauth = await request(port, "GET", "/api/v1/verification-validation/meta");
    assert.equal(unauth.status, 401);
  });
});
