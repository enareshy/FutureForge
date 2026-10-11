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
import { getHandler } from "../services/events/handlers.js";
import { getHandler as getJobHandler } from "../services/job-execution/handlers.js";
import { getSubscriptionRow } from "../services/events/subscriptions.js";
import { getJobTypeRow } from "../services/jobs/types.js";
import {
  TestCases,
  TestProcedures,
  TestExecutions,
  TestResults,
  Foundation,
  Jobs,
  Subscriptions,
  Audit,
  VV_INTEGRATION,
  VV_HANDLER_CODES,
  VV_JOB_TYPES,
  VV_EVENT_SUBSCRIPTIONS,
  VV_REQUIREMENT_SUBSCRIPTIONS,
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

describe("Verification & Validation events, jobs, subscriptions & audit", () => {
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
    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureRequirementPdmFoundation(db);
    Foundation.ensureVvFoundation(db);

    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT * FROM users WHERE username = 'admin'");

    const createdReq = RequirementsManager.createRequirement(db, tenant, { title: "Event requirement", requirement_type: "business_requirement" }, actor, IP);
    ensureRequirementObject(db, tenant, createdReq, actor, IP);
    requirement = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [createdReq.id]);

    TestCases.createTestCase(db, tenant, { code: "VV-TC-EVT", name: "Event case", method_code: "TEST" }, actor, IP);
    TestCases.transitionTestCase(db, tenant, "VV-TC-EVT", "IN_REVIEW", { actor, ip: IP });
    TestCases.transitionTestCase(db, tenant, "VV-TC-EVT", "APPROVED", { actor, ip: IP });
    TestCases.linkRequirement(db, tenant, "VV-TC-EVT", { requirement_id: requirement.id }, actor, IP);

    TestProcedures.createProcedure(db, tenant, "VV-TC-EVT", { code: "VV-TP-EVT", name: "Event procedure" }, actor, IP);

    const created = TestExecutions.createExecution(db, tenant, { test_case_id: "VV-TC-EVT", requirement_ids: [requirement.id] }, actor, IP);
    TestExecutions.startExecution(db, tenant, created.execution_ref, { actor, ip: IP });
    TestResults.recordResult(db, tenant, created.execution_ref, { requirement_id: requirement.id, requirement_revision: requirement.revision, actual_value: "1", acceptance_criteria: { operator: "eq", value: 1 } }, actor, IP);
    TestExecutions.completeExecution(db, tenant, created.execution_ref, { actor, ip: IP });
    execution = queryOne(db, "SELECT * FROM vv_executions WHERE execution_ref = ?", [created.execution_ref]);

    const started = await listen(createApp(db));
    server = started.server;
    port = started.port;
    adminToken = (await request(port, "POST", "/api/auth/login", { body: { username: "admin", password: "HelixAdmin!42" } })).body.token;
  });

  after(() => {
    server?.close();
    db?.close();
  });

  test("ensures the V&V background job types idempotently", () => {
    const first = Jobs.ensureVvJobTypes(db);
    assert.equal(first.total, VV_JOB_TYPES.length);
    const second = Jobs.ensureVvJobTypes(db);
    assert.equal(second.created, 0, "job types are created once by the foundation");
    for (const definition of VV_JOB_TYPES) {
      assert.ok(getJobTypeRow(db, definition.code), `missing job type ${definition.code}`);
    }
  });

  test("registers the V&V job handlers", () => {
    assert.equal(typeof getJobHandler(VV_HANDLER_CODES.COVERAGE_RECALC)?.handler, "function", "coverage recalculation handler must be registered");
    assert.equal(typeof getJobHandler(VV_HANDLER_CODES.STALE_EVIDENCE_SCAN)?.handler, "function", "stale evidence scan handler must be registered");
  });

  test("registers coverage and requirement event subscriptions", () => {
    const coverage = Subscriptions.ensureVvEventSubscriptions(db);
    assert.equal(coverage.total, VV_EVENT_SUBSCRIPTIONS.length);
    const requirements = Subscriptions.ensureVvRequirementSubscriptions(db);
    assert.equal(requirements.total, VV_REQUIREMENT_SUBSCRIPTIONS.length);

    for (const definition of VV_EVENT_SUBSCRIPTIONS) {
      assert.ok(getSubscriptionRow(db, `vv-event-${String(definition.event_type_code).toLowerCase()}`), `missing coverage subscription for ${definition.event_type_code}`);
    }
    assert.ok(getSubscriptionRow(db, "vv-req-requirementrevised"), "missing requirement revision subscription");

    const summary = Subscriptions.vvSubscriptionSummary(db);
    assert.ok(summary.subscriptions.length >= VV_EVENT_SUBSCRIPTIONS.length);
    assert.ok(summary.subscriptions.every((row) => row.registered), "every V&V subscription must be registered");
  });

  test("recalculates coverage for the requirement affected by an execution event", async () => {
    const handler = getHandler(VV_INTEGRATION.coverageHandler).handler;
    const outcome = await handler({
      db,
      event: { event_type_code: "TestExecutionCompleted", tenant_id: tenant, source_object_type: "test_execution", source_object_id: String(execution.id) },
      payload: {},
    });
    assert.equal(outcome.scope, "test_cases");
    assert.ok(outcome.requirement_count >= 1, "the linked requirement's coverage must be recalculated");
  });

  test("recalculates the requirement directly when the payload carries its reference", async () => {
    const handler = getHandler(VV_INTEGRATION.coverageHandler).handler;
    const outcome = await handler({
      db,
      event: { event_type_code: "WaiverApproved", tenant_id: tenant, source_object_type: "waiver", source_object_id: "1" },
      payload: { requirement_ref: requirement.requirement_ref },
    });
    assert.equal(outcome.scope, "requirement");
    assert.equal(outcome.requirement_ref, requirement.requirement_ref);
  });

  test("flags stale evidence and recalculates coverage on a requirement revision event", async () => {
    const current = queryOne(db, "SELECT * FROM vv_test_cases WHERE tenant_id = ? AND code = 'VV-TC-EVT'", [tenant]);
    TestCases.reviseTestCase(db, tenant, "VV-TC-EVT", { version: current.version, reason: "event test revision" }, actor, IP);
    assert.equal(
      queryOne(db, "SELECT COUNT(*) AS c FROM vv_executions WHERE tenant_id = ? AND id = ?", [tenant, execution.id]).c,
      1,
      "history is never deleted"
    );

    const handler = getHandler(VV_INTEGRATION.requirementEventHandler).handler;
    const outcome = await handler({
      db,
      event: { event_type_code: "RequirementRevised", tenant_id: tenant, source_object_type: "requirement", source_object_id: String(requirement.object_id) },
      payload: { requirement_ref: requirement.requirement_ref },
    });
    assert.equal(outcome.requirement_ref, requirement.requirement_ref);
    assert.ok(outcome.stale >= 1, "the requirement's pinned execution must be detected as stale");
    assert.equal(outcome.flagged, 0, "auto-invalidation is off by default");
  });

  test("runs a tenant-wide coverage recalculation through the job operation", async () => {
    const summary = await Jobs.runCoverageRecalcAsync(db, tenant, {}, actor, IP);
    assert.ok(summary.processed >= 1, "the tenant-wide recalculation must process at least one requirement");
    const sync = Jobs.runCoverageRecalc(db, tenant, {}, actor, IP);
    assert.ok(sync.processed >= 1);
  });

  test("lists module-scoped audit entries", async () => {
    const listed = await Audit.listVvAuditAsync(db, { tenantId: tenant }, { page: 1, pageSize: 50 });
    assert.ok(listed.total >= 1, "V&V operations must be audited through the shared audit store");
    assert.ok(listed.items.every((item) => String(item.action || "").includes("verification-validation")));
  });

  test("exposes jobs, subscriptions and audit over the API", async () => {
    const coverageJob = await request(port, "POST", "/api/v1/verification-validation/coverage/recalculate/job", { token: adminToken, body: { requirement_id: requirement.requirement_ref } });
    assert.equal(coverageJob.status, 202);
    assert.ok(coverageJob.body.id || coverageJob.body.job_ref, "a job record must be returned");

    const staleJob = await request(port, "POST", "/api/v1/verification-validation/stale-evidence/scan/job", { token: adminToken, body: {} });
    assert.equal(staleJob.status, 202);

    const audit = await request(port, "GET", "/api/v1/verification-validation/audit", { token: adminToken });
    assert.equal(audit.status, 200);
    assert.ok(Array.isArray(audit.body.items));

    const subscriptions = await request(port, "GET", "/api/v1/verification-validation/subscriptions", { token: adminToken });
    assert.equal(subscriptions.status, 200);
    assert.ok(subscriptions.body.subscriptions.length >= 1);

    const unauth = await request(port, "GET", "/api/v1/verification-validation/audit");
    assert.equal(unauth.status, 401);
  });
});
