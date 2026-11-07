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
  Foundation,
  RevisionImpact,
  Provider,
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

describe("Verification & Validation revision applicability & change impact", () => {
  test("assesses pinned revisions against current revisions (pure)", () => {
    assert.equal(RevisionImpact.assessRevisionApplicability({ test_case_revision: "A" }, { test_case_revision: "A" }).status, "APPLICABLE");
    assert.equal(RevisionImpact.assessRevisionApplicability({ test_case_revision: "A" }, { test_case_revision: "A" }).stale, false);

    const stale = RevisionImpact.assessRevisionApplicability({ test_case_revision: "A" }, { test_case_revision: "B" });
    assert.equal(stale.status, "STALE");
    assert.equal(stale.stale, true);
    assert.ok(stale.reasons.includes("revision_changed"));

    const unknown = RevisionImpact.assessRevisionApplicability({ test_case_revision: "" }, { test_case_revision: "A" });
    assert.equal(unknown.status, "UNKNOWN");
    assert.equal(unknown.stale, false);

    const configMismatch = RevisionImpact.assessRevisionApplicability({ test_case_revision: "A", configuration_context: "CFG-1" }, { test_case_revision: "A", configuration: "CFG-2" });
    assert.equal(configMismatch.status, "STALE");
    assert.ok(configMismatch.reasons.includes("configuration_mismatch"));
  });

  describe("integration with requirements, thread provider and impact", () => {
    let db;
    let server;
    let port;
    let adminToken;
    let tenant;
    let actor;
    let requirement;
    let testCase;
    let execution;
    let contentId;

    before(async () => {
      db = openTestDatabase();
      migrate(db);
      seedDatabase(db);
      ensureNumberingFoundation(db);
      ensureRequirementsFoundation(db);
      ensureRequirementPdmFoundation(db);
      Foundation.ensureVvFoundation(db);
      tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
      actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");

      const created = RequirementsManager.createRequirement(db, tenant, { title: "Impact requirement", requirement_type: "business_requirement" }, actor, IP);
      ensureRequirementObject(db, tenant, created, actor, IP);
      requirement = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [created.id]);

      testCase = TestCases.createTestCase(db, tenant, { code: "VV-TC-IMP", name: "Impact case", method_code: "TEST" }, actor, IP);
      TestCases.transitionTestCase(db, tenant, "VV-TC-IMP", "IN_REVIEW", { actor, ip: IP });
      TestCases.transitionTestCase(db, tenant, "VV-TC-IMP", "APPROVED", { actor, ip: IP });
      TestCases.linkRequirement(db, tenant, "VV-TC-IMP", { requirement_id: requirement.id }, actor, IP);
      testCase = queryOne(db, "SELECT * FROM vv_test_cases WHERE tenant_id = ? AND code = 'VV-TC-IMP'", [tenant]);

      TestProcedures.createProcedure(db, tenant, "VV-TC-IMP", { code: "VV-TP-IMP", name: "Impact procedure" }, actor, IP);
      execution = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-IMP", requirement_ids: [requirement.id] }, actor, IP);
      TestExecutions.startExecution(db, tenant, execution.execution_ref, { actor, ip: IP });
      const result = TestResults.recordResult(db, tenant, execution.execution_ref, { requirement_id: requirement.id, requirement_revision: requirement.revision, actual_value: "1", acceptance_criteria: { operator: "eq", value: 1 } }, actor, IP);
      const content = await createContent(db, { fileName: "impact-evidence.txt", mimeType: "text/plain", buffer: Buffer.from("impact-evidence") }, { tenantId: tenant, actor, process: false });
      contentId = content.id;
      Evidence.attachEvidence(db, tenant, { result_ref: result.result_ref, content_id: contentId }, actor, IP);
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

    test("registers the V&V Digital Thread provider", () => {
      const providers = providersForType("test_case");
      assert.ok(providers.some((provider) => provider.code === "verification-validation"), "V&V provider must accept test_case nodes");

      const node = Provider.verificationValidationProvider.resolveMany(db, tenant, [{ objectType: "test_case", objectId: String(testCase.id) }])[0];
      assert.ok(node, "test case node must resolve");
      assert.equal(node.node_ref, `test_case:${testCase.id}`);
      assert.equal(node.domain, "QUALITY");
    });

    test("projects requirement -> test case edges through the provider", () => {
      const edges = Provider.verificationValidationProvider.neighbors(db, tenant, [{ objectType: "requirement", objectId: String(requirement.object_id) }]);
      const toCase = edges.filter((edge) => edge.target_node_ref === `test_case:${testCase.id}`);
      assert.ok(toCase.length >= 1, "requirement must link to its test case");
      assert.ok(toCase.some((edge) => edge.relationship_type === "VERIFIED_BY"));
    });

    test("reports an impact chain from a requirement to V&V nodes", async () => {
      const report = await RevisionImpact.analyzeRequirementImpactAsync(db, tenant, requirement.id, { includeInactive: true }, actor, IP);
      assert.equal(report.source_module, "verification-validation");
      assert.equal(report.root, `requirement:${requirement.object_id}`);
      assert.ok(report.impacted_count >= 1, `expected impacted nodes, got ${report.impacted_count}`);
      assert.ok(report.category_totals.TEST_CASE >= 1, "impact must classify test cases");
      assert.ok(report.items.some((item) => item.object_type === "test_case"));
    });

    test("assesses an execution as applicable before revisions diverge", () => {
      const assessment = RevisionImpact.assessExecutionApplicability(db, tenant, execution.execution_ref);
      assert.equal(assessment.status, "APPLICABLE");
      assert.equal(assessment.stale, false);
      assert.equal(assessment.flagged, false);
    });

    test("flags potentially stale evidence after the test case is revised (no history lost)", () => {
      const current = queryOne(db, "SELECT * FROM vv_test_cases WHERE id = ?", [testCase.id]);
      TestCases.reviseTestCase(db, tenant, "VV-TC-IMP", { version: current.version, reason: "design change" }, actor, IP);

      const assessment = RevisionImpact.assessExecutionApplicability(db, tenant, execution.execution_ref);
      assert.equal(assessment.status, "STALE");
      assert.ok(assessment.reasons.includes("revision_changed"));

      const listed = RevisionImpact.listStaleEvidence(db, tenant, {});
      assert.ok(listed.total >= 1);
      assert.ok(listed.items.some((item) => item.execution_ref === execution.execution_ref));

      const flagged = RevisionImpact.flagStaleEvidence(db, tenant, execution.execution_ref, { reason: "revision_changed", actor, ip: IP });
      assert.equal(flagged.flagged, true);
      const stored = queryOne(db, "SELECT metadata_json FROM vv_executions WHERE id = ?", [flagged.execution_id]);
      assert.ok(stored.metadata_json.includes("stale_evidence"), "flag is stored in metadata, not by deleting history");

      const scan = RevisionImpact.scanStaleEvidence(db, tenant, {}, actor, IP);
      assert.equal(scan.enabled, true);
      assert.equal(scan.auto_invalidate, false);
      assert.ok(scan.stale >= 1);
      assert.equal(scan.flagged, 0, "auto-invalidation is off by default so history stays intact");
    });

    test("exposes applicability, stale evidence and impact over the API", async () => {
      const applicability = await request(port, "GET", `/api/v1/verification-validation/executions/${execution.execution_ref}/applicability`, { token: adminToken });
      assert.equal(applicability.status, 200);
      assert.equal(applicability.body.status, "STALE");

      const staleList = await request(port, "GET", "/api/v1/verification-validation/stale-evidence", { token: adminToken });
      assert.equal(staleList.status, 200);
      assert.ok(staleList.body.total >= 1);

      const scan = await request(port, "POST", "/api/v1/verification-validation/stale-evidence/scan", { token: adminToken, body: {} });
      assert.equal(scan.status, 200);
      assert.equal(scan.body.enabled, true);

      const impact = await request(port, "GET", `/api/v1/verification-validation/requirements/${requirement.requirement_ref}/impact`, { token: adminToken });
      assert.equal(impact.status, 200);
      assert.ok(impact.body.category_totals.TEST_CASE >= 1);

      const unauth = await request(port, "GET", "/api/v1/verification-validation/stale-evidence");
      assert.equal(unauth.status, 401);
    });

    test("traces the requirement downstream and upstream through the Digital Thread", async () => {
      const down = await request(port, "GET", `/api/v1/verification-validation/requirements/${requirement.requirement_ref}/trace?direction=DOWNSTREAM`, { token: adminToken });
      assert.equal(down.status, 200);
      assert.equal(down.body.direction, "DOWNSTREAM");
      assert.equal(down.body.root, `requirement:${requirement.object_id}`);
      assert.ok(down.body.category_totals.TEST_CASE >= 1, "forward trace must reach the test case");
      assert.ok(down.body.nodes.some((node) => node.object_type === "test_case"));

      const up = await request(port, "GET", `/api/v1/verification-validation/requirements/${requirement.requirement_ref}/trace?direction=UPSTREAM`, { token: adminToken });
      assert.equal(up.status, 200);
      assert.equal(up.body.direction, "UPSTREAM");
      assert.equal(up.body.node_count >= 1, true, "backward trace still returns the root");
    });

    test("trace returns 404 for an unknown requirement and 401 without a token", async () => {
      const missing = await request(port, "GET", "/api/v1/verification-validation/requirements/REQ-DOES-NOT-EXIST/trace", { token: adminToken });
      assert.equal(missing.status, 404);

      const unauth = await request(port, "GET", `/api/v1/verification-validation/requirements/${requirement.requirement_ref}/trace`);
      assert.equal(unauth.status, 401);
    });
  });
});
