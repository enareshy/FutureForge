// REST router for the Verification & Validation (V&V) Engine. Built as a factory
// so it reuses the application's auth, authorization and error middleware.
// Mounted at /api/verification-validation and /api/v1/verification-validation
// (mirrors requirement-manufacturing router).
//
// Bootstrap and data routes use `authAsync`/`canAsync` + `*Async` service twins,
// while the pure-vocabulary `/meta` route stays on the sync `auth`/`can` path. A
// route uses either the sync or the async layer, never both.
import { Constants, Configuration, Foundation, Methods, TestCases, TestProcedures, TestExecutions, TestResults, Evidence, Coverage, Waivers, Retest, Deviation, RevisionImpact, Jobs, Subscriptions, Audit } from "./index.js";

const R = Constants.VV_RESOURCES;

export function createVerificationValidationRouter({ express, db, auth, can, authAsync, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const canOverviewAsync = (a) => canAsync(R.overview, a);
  const canAdminAsync = (a) => canAsync(R.admin, a);
  const canAdmin = (a) => can(R.admin, a);
  const canTestCasesAsync = (a) => canAsync(R.testCases, a);
  const canProceduresAsync = (a) => canAsync(R.procedures, a);
  const canExecutionsAsync = (a) => canAsync(R.executions, a);
  const canResultsAsync = (a) => canAsync(R.results, a);
  const canEvidenceAsync = (a) => canAsync(R.evidence, a);
  const canCoverageAsync = (a) => canAsync(R.coverage, a);
  const canWaiversAsync = (a) => canAsync(R.waivers, a);
  const canQualityAsync = (a) => canAsync(R.quality, a);
  const canImpactAsync = (a) => canAsync(R.impact, a);
  const canTraceAsync = (a) => canAsync(R.traceability, a);
  const query = (req) => req.query;
  const body = (req) => req.body ?? {};

  // ── Meta, health ────────────────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
    can(R.overview, "read"),
    wrap((_req, res) =>
      res.json({
        source_module: Constants.SOURCE_MODULE,
        node_types: { ...Constants.VV_NODE_TYPES },
        verification_kinds: [...Constants.VERIFICATION_KINDS],
        method_types: [...Constants.METHOD_TYPES],
        definition_statuses: [...Constants.DEFINITION_STATUSES],
        execution_statuses: [...Constants.EXECUTION_STATUSES],
        result_outcomes: [...Constants.RESULT_OUTCOMES],
        result_levels: [...Constants.RESULT_LEVELS],
        waiver_statuses: [...Constants.WAIVER_STATUSES],
        requirement_vnv_statuses: [...Constants.REQUIREMENT_VNV_STATUSES],
        coverage_statuses: [...Constants.COVERAGE_STATUSES],
        resources: { ...Constants.VV_RESOURCES },
        config_defaults: { ...Constants.CONFIG_DEFAULTS },
        config_bounds: { ...Constants.CONFIG_BOUNDS },
        quality_module: { ...Constants.QUALITY_MODULE },
      })
    )
  );
  router.get("/health", authAsync, canOverviewAsync("read"), wrap(async (req, res) => res.json(await Foundation.vvHealthAsync(db, tenantOf(req)))));

  // ── Audit & event subscriptions (module-scoped read views) ──────────────
  router.get(
    "/audit",
    authAsync,
    canOverviewAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Audit.listVvAuditAsync(
          db,
          { tenantId: tenantOf(req) },
          {
            action: query(req).action,
            resourceType: query(req).resource_type ?? query(req).resourceType,
            resourceId: query(req).resource_id ?? query(req).resourceId,
            actorUsername: query(req).actor ?? query(req).actor_username,
            from: query(req).from,
            to: query(req).to,
            status: query(req).status,
            q: query(req).q,
            page: query(req).page,
            pageSize: query(req).pageSize ?? query(req).page_size,
          }
        )
      )
    )
  );
  router.get("/subscriptions", authAsync, canAdminAsync("read"), wrap(async (req, res) => res.json(await Subscriptions.vvSubscriptionSummaryAsync(db))));

  // ── Configuration (platform config store) ───────────────────────────────
  router.get("/config", auth, canAdmin("read"), wrap((req, res) => res.json(Configuration.listConfig(db, tenantOf(req)))));
  router.put(
    "/config/:key",
    auth,
    canAdmin("update"),
    wrap((req, res) => res.json(Configuration.setConfig(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip)))
  );

  // ── Bootstrap ───────────────────────────────────────────────────────────
  router.post("/foundation/ensure", authAsync, canAdminAsync("execute"), wrap(async (_req, res) => res.json(await Foundation.ensureVvFoundationAsync(db))));

  // ── Verification / validation methods (registry) ─────────────────────────
  router.get(
    "/methods",
    authAsync,
    canTestCasesAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Methods.listMethodsAsync(db, {
          tenantId: tenantOf(req),
          status: req.query.status,
          verification_kind: req.query.verification_kind ?? req.query.verificationKind,
          q: req.query.q,
          page: req.query.page,
          pageSize: req.query.pageSize ?? req.query.page_size,
        })
      )
    )
  );
  router.post(
    "/methods",
    authAsync,
    canAdminAsync("create"),
    wrap(async (req, res) => res.status(201).json(await Methods.createMethodAsync(db, tenantOf(req), req.body, req.actor, req.ip)))
  );
  router.get(
    "/methods/:ref",
    authAsync,
    canTestCasesAsync("read"),
    wrap(async (req, res) => res.json(await Methods.getMethodAsync(db, tenantOf(req), req.params.ref)))
  );
  router.put(
    "/methods/:ref",
    authAsync,
    canAdminAsync("update"),
    wrap(async (req, res) => res.json(await Methods.updateMethodAsync(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip)))
  );

  // ── Test cases ────────────────────────────────────────────────────────
  router.get(
    "/test-cases",
    authAsync,
    canTestCasesAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await TestCases.listTestCasesAsync(db, {
          tenantId: tenantOf(req),
          status: query(req).status,
          verification_kind: query(req).verification_kind ?? query(req).verificationKind,
          method_code: query(req).method_code ?? query(req).methodCode,
          organization_id: query(req).organization_id,
          owner_user_id: query(req).owner_user_id,
          q: query(req).q,
          page: query(req).page,
          pageSize: query(req).pageSize ?? query(req).page_size,
        })
      )
    )
  );
  router.post(
    "/test-cases",
    authAsync,
    canTestCasesAsync("create"),
    wrap(async (req, res) => res.status(201).json(await TestCases.createTestCaseAsync(db, tenantOf(req), body(req), req.actor, req.ip)))
  );
  router.get("/test-cases/:ref", authAsync, canTestCasesAsync("read"), wrap(async (req, res) => res.json(await TestCases.getTestCaseAsync(db, tenantOf(req), req.params.ref))));
  router.put(
    "/test-cases/:ref",
    authAsync,
    canTestCasesAsync("update"),
    wrap(async (req, res) => res.json(await TestCases.updateTestCaseAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );
  router.post(
    "/test-cases/:ref/transition",
    authAsync,
    canTestCasesAsync("update"),
    wrap(async (req, res) => res.json(await TestCases.transitionTestCaseAsync(db, tenantOf(req), req.params.ref, body(req).status ?? body(req).target, { actor: req.actor, ip: req.ip, reason: body(req).reason })))
  );
  router.post(
    "/test-cases/:ref/revise",
    authAsync,
    canTestCasesAsync("create"),
    wrap(async (req, res) => res.json(await TestCases.reviseTestCaseAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );

  // ── Requirement coverage links (VERIFIED_BY / VALIDATED_BY edges) ────────
  router.get(
    "/test-cases/:ref/requirements",
    authAsync,
    canTestCasesAsync("read"),
    wrap(async (req, res) => res.json(await TestCases.listTestCaseRequirementsAsync(db, tenantOf(req), req.params.ref, { page: query(req).page, pageSize: query(req).pageSize ?? query(req).page_size })))
  );
  router.post(
    "/test-cases/:ref/requirements",
    authAsync,
    canTestCasesAsync("update"),
    wrap(async (req, res) => res.status(201).json(await TestCases.linkRequirementAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );
  router.delete(
    "/test-cases/:ref/requirements/:relationshipRef",
    authAsync,
    canTestCasesAsync("update"),
    wrap(async (req, res) => res.json(await TestCases.unlinkRequirementAsync(db, tenantOf(req), req.params.ref, req.params.relationshipRef, req.actor, req.ip)))
  );

  // ── Test procedures + steps ──────────────────────────────────────────────
  router.get(
    "/procedures",
    authAsync,
    canProceduresAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await TestProcedures.listProceduresAsync(db, tenantOf(req), {
          test_case_id: query(req).test_case_id ?? query(req).testCaseId,
          status: query(req).status,
          q: query(req).q,
          includeSteps: query(req).includeSteps !== "false",
          page: query(req).page,
          pageSize: query(req).pageSize ?? query(req).page_size,
        })
      )
    )
  );
  router.get(
    "/test-cases/:ref/procedures",
    authAsync,
    canProceduresAsync("read"),
    wrap(async (req, res) => res.json(await TestProcedures.listProceduresAsync(db, tenantOf(req), { test_case_id: (await TestCases.requireTestCaseRowAsync(db, tenantOf(req), req.params.ref)).id, includeSteps: query(req).includeSteps !== "false", page: query(req).page, pageSize: query(req).pageSize ?? query(req).page_size })))
  );
  router.post(
    "/test-cases/:ref/procedures",
    authAsync,
    canProceduresAsync("create"),
    wrap(async (req, res) => res.status(201).json(await TestProcedures.createProcedureAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );
  router.get("/procedures/:ref", authAsync, canProceduresAsync("read"), wrap(async (req, res) => res.json(await TestProcedures.getProcedureAsync(db, tenantOf(req), req.params.ref))));
  router.put(
    "/procedures/:ref",
    authAsync,
    canProceduresAsync("update"),
    wrap(async (req, res) => res.json(await TestProcedures.updateProcedureAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );
  router.post(
    "/procedures/:ref/transition",
    authAsync,
    canProceduresAsync("update"),
    wrap(async (req, res) => res.json(await TestProcedures.transitionProcedureAsync(db, tenantOf(req), req.params.ref, body(req).status ?? body(req).target, { actor: req.actor, ip: req.ip, reason: body(req).reason })))
  );
  router.get("/procedures/:ref/steps", authAsync, canProceduresAsync("read"), wrap(async (req, res) => res.json(await TestProcedures.loadStepsAsync(db, (await TestProcedures.requireProcedureRowAsync(db, tenantOf(req), req.params.ref)).id))));
  router.post(
    "/procedures/:ref/steps",
    authAsync,
    canProceduresAsync("update"),
    wrap(async (req, res) => res.status(201).json(await TestProcedures.addStepAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );
  router.put(
    "/procedures/:ref/steps/:stepRef",
    authAsync,
    canProceduresAsync("update"),
    wrap(async (req, res) => res.json(await TestProcedures.updateStepAsync(db, tenantOf(req), req.params.ref, req.params.stepRef, body(req), req.actor, req.ip)))
  );
  router.delete(
    "/procedures/:ref/steps/:stepRef",
    authAsync,
    canProceduresAsync("update"),
    wrap(async (req, res) => res.json(await TestProcedures.removeStepAsync(db, tenantOf(req), req.params.ref, req.params.stepRef, req.actor, req.ip)))
  );

  // ── Test executions ──────────────────────────────────────────────────────
  router.get(
    "/executions",
    authAsync,
    canExecutionsAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await TestExecutions.listExecutionsAsync(db, {
          tenantId: tenantOf(req),
          status: query(req).status,
          overall_outcome: query(req).overall_outcome ?? query(req).overallOutcome,
          test_case_id: query(req).test_case_id ?? query(req).testCaseId,
          procedure_id: query(req).procedure_id ?? query(req).procedureId,
          previously_of: query(req).previously_of ?? query(req).previouslyOf,
          q: query(req).q,
          page: query(req).page,
          pageSize: query(req).pageSize ?? query(req).page_size,
        })
      )
    )
  );
  router.post(
    "/executions",
    authAsync,
    canExecutionsAsync("create"),
    wrap(async (req, res) => res.status(201).json(await TestExecutions.createExecutionAsync(db, tenantOf(req), body(req), req.actor, req.ip)))
  );
  router.get("/executions/:ref", authAsync, canExecutionsAsync("read"), wrap(async (req, res) => res.json(await TestExecutions.getExecutionAsync(db, tenantOf(req), req.params.ref))));
  router.put(
    "/executions/:ref",
    authAsync,
    canExecutionsAsync("update"),
    wrap(async (req, res) => res.json(await TestExecutions.updateExecutionAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );
  router.post(
    "/executions/:ref/transition",
    authAsync,
    canExecutionsAsync("update"),
    wrap(async (req, res) => res.json(await TestExecutions.transitionExecutionAsync(db, tenantOf(req), req.params.ref, body(req).status ?? body(req).target, { actor: req.actor, ip: req.ip, reason: body(req).reason })))
  );
  router.post(
    "/executions/:ref/retest",
    authAsync,
    canExecutionsAsync("create"),
    wrap(async (req, res) => res.status(201).json(await TestExecutions.requestRetestAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );
  router.get("/executions/:ref/requirements", authAsync, canExecutionsAsync("read"), wrap(async (req, res) => res.json(await TestExecutions.listExecutionRequirementsAsync(db, tenantOf(req), req.params.ref))));
  router.post(
    "/executions/:ref/evaluate",
    authAsync,
    canResultsAsync("update"),
    wrap(async (req, res) => res.json(await TestResults.evaluateExecutionAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );

  // ── Test results ────────────────────────────────────────────────────────
  router.get(
    "/results",
    authAsync,
    canResultsAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await TestResults.listResultsAsync(db, tenantOf(req), {
          execution_id: query(req).execution_id ?? query(req).executionId,
          result_level: query(req).result_level ?? query(req).resultLevel,
          outcome: query(req).outcome,
          requirement_id: query(req).requirement_id ?? query(req).requirementId,
          page: query(req).page,
          pageSize: query(req).pageSize ?? query(req).page_size,
        })
      )
    )
  );
  router.get("/results/:ref", authAsync, canResultsAsync("read"), wrap(async (req, res) => res.json(await TestResults.getResultAsync(db, tenantOf(req), req.params.ref))));
  router.post(
    "/executions/:ref/results",
    authAsync,
    canResultsAsync("create"),
    wrap(async (req, res) => res.status(201).json(await TestResults.recordResultAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );
  router.put(
    "/results/:ref",
    authAsync,
    canResultsAsync("update"),
    wrap(async (req, res) => res.json(await TestResults.updateResultAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );
  router.post(
    "/results/:ref/evaluate",
    authAsync,
    canResultsAsync("update"),
    wrap(async (req, res) => res.json(await TestResults.evaluateResultAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );

  // ── Evidence (content associations) ──────────────────────────────────────
  router.get("/evidence", authAsync, canEvidenceAsync("read"), wrap(async (req, res) => res.json(await Evidence.listEvidenceAsync(db, tenantOf(req), { ...query(req) }))));
  router.post(
    "/evidence",
    authAsync,
    canEvidenceAsync("create"),
    wrap(async (req, res) => res.status(201).json(await Evidence.attachEvidenceAsync(db, tenantOf(req), body(req), req.actor, req.ip)))
  );
  router.delete(
    "/evidence/:associationRef",
    authAsync,
    canEvidenceAsync("update"),
    wrap(async (req, res) => res.json(await Evidence.detachEvidenceAsync(db, tenantOf(req), req.params.associationRef, req.actor, req.ip)))
  );

  // ── Requirement V&V coverage & status ────────────────────────────────────
  router.get(
    "/coverage/requirements",
    authAsync,
    canCoverageAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Coverage.listRequirementCoverageAsync(db, tenantOf(req), {
          status: query(req).status,
          verification_status: query(req).verification_status ?? query(req).verificationStatus,
          validation_status: query(req).validation_status ?? query(req).validationStatus,
          page: query(req).page,
          pageSize: query(req).pageSize ?? query(req).page_size,
        })
      )
    )
  );
  router.get("/coverage/summary", authAsync, canCoverageAsync("read"), wrap(async (req, res) => res.json(await Coverage.coverageSummaryAsync(db, tenantOf(req)))));
  router.get(
    "/requirements/:ref/coverage",
    authAsync,
    canCoverageAsync("read"),
    wrap(async (req, res) => res.json(await Coverage.computeRequirementCoverageAsync(db, tenantOf(req), req.params.ref, { rule: query(req).rule })))
  );
  router.post(
    "/requirements/:ref/coverage/recalculate",
    authAsync,
    canCoverageAsync("update"),
    wrap(async (req, res) => res.json(await Coverage.recalculateRequirementAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/coverage/recalculate/job",
    authAsync,
    canCoverageAsync("create"),
    wrap(async (req, res) => res.status(202).json(await Jobs.submitCoverageRecalcAsync(db, tenantOf(req), body(req), req.actor, req.ip)))
  );

  // ── Waivers & exceptions ─────────────────────────────────────────────────
  router.get(
    "/waivers",
    authAsync,
    canWaiversAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Waivers.listWaiversAsync(db, tenantOf(req), {
          status: query(req).status,
          requirement_id: query(req).requirement_id ?? query(req).requirementId,
          test_case_id: query(req).test_case_id ?? query(req).testCaseId,
          execution_id: query(req).execution_id ?? query(req).executionId,
          result_id: query(req).result_id ?? query(req).resultId,
          valid_only: ["1", "true", "yes"].includes(String(query(req).valid_only ?? query(req).validOnly ?? "").toLowerCase()),
          page: query(req).page,
          pageSize: query(req).pageSize ?? query(req).page_size,
        })
      )
    )
  );
  router.get("/waivers/summary", authAsync, canWaiversAsync("read"), wrap(async (req, res) => res.json(await Waivers.waiverSummaryAsync(db, tenantOf(req)))));
  router.post("/waivers/expire-overdue", authAsync, canWaiversAsync("update"), wrap(async (req, res) => res.json(await Waivers.expireOverdueWaiversAsync(db, tenantOf(req), req.actor, req.ip))));
  router.post(
    "/waivers",
    authAsync,
    canWaiversAsync("create"),
    wrap(async (req, res) => res.status(201).json(await Waivers.createWaiverAsync(db, tenantOf(req), body(req), req.actor, req.ip)))
  );
  router.get("/waivers/:ref", authAsync, canWaiversAsync("read"), wrap(async (req, res) => res.json(await Waivers.getWaiverAsync(db, tenantOf(req), req.params.ref))));
  router.put(
    "/waivers/:ref",
    authAsync,
    canWaiversAsync("update"),
    wrap(async (req, res) => res.json(await Waivers.updateWaiverAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );
  router.post(
    "/waivers/:ref/transition",
    authAsync,
    canWaiversAsync("update"),
    wrap(async (req, res) => res.json(await Waivers.transitionWaiverAsync(db, tenantOf(req), req.params.ref, body(req).status ?? body(req).target, { actor: req.actor, ip: req.ip, reason: body(req).reason, conditions: body(req).conditions })))
  );

  // ── Retest policy, chain & plan ──────────────────────────────────────────
  router.get("/executions/:ref/retest-chain", authAsync, canExecutionsAsync("read"), wrap(async (req, res) => res.json(await Retest.getRetestChainAsync(db, tenantOf(req), req.params.ref))));
  router.get(
    "/executions/:ref/retest-plan",
    authAsync,
    canExecutionsAsync("read"),
    wrap(async (req, res) => res.json(await Retest.planRetestAsync(db, tenantOf(req), req.params.ref, { policy: query(req).policy })))
  );

  // ── Failure → quality / change / deviation integration ───────────────────
  router.get(
    "/failures",
    authAsync,
    canQualityAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Deviation.listFailuresAsync(db, tenantOf(req), {
          test_case_id: query(req).test_case_id ?? query(req).testCaseId,
          execution_id: query(req).execution_id ?? query(req).executionId,
          requirement_id: query(req).requirement_id ?? query(req).requirementId,
          page: query(req).page,
          pageSize: query(req).pageSize ?? query(req).page_size,
        })
      )
    )
  );
  router.get("/failures/summary", authAsync, canQualityAsync("read"), wrap(async (req, res) => res.json(await Deviation.failureSummaryAsync(db, tenantOf(req)))));
  router.post(
    "/quality-exceptions",
    authAsync,
    canQualityAsync("create"),
    wrap(async (req, res) => res.status(201).json(await Deviation.raiseQualityExceptionAsync(db, tenantOf(req), body(req), req.actor, req.ip)))
  );
  router.post(
    "/failures/link-records",
    authAsync,
    canQualityAsync("update"),
    wrap(async (req, res) => res.json(await Deviation.linkIndependentRecordsAsync(db, tenantOf(req), body(req), req.actor, req.ip)))
  );

  // ── Revision / configuration applicability & stale evidence ───────────────
  router.get("/executions/:ref/applicability", authAsync, canTraceAsync("read"), wrap(async (req, res) => res.json(await RevisionImpact.assessExecutionApplicabilityAsync(db, tenantOf(req), req.params.ref))));
  router.post(
    "/executions/:ref/flag-stale",
    authAsync,
    canTraceAsync("update"),
    wrap(async (req, res) => res.json(await RevisionImpact.flagStaleEvidenceAsync(db, tenantOf(req), req.params.ref, { reason: body(req).reason ?? query(req).reason, actor: req.actor, ip: req.ip })))
  );
  router.get(
    "/stale-evidence",
    authAsync,
    canTraceAsync("read"),
    wrap(async (req, res) => res.json(await RevisionImpact.listStaleEvidenceAsync(db, tenantOf(req), { page: query(req).page, pageSize: query(req).pageSize ?? query(req).page_size })))
  );
  router.post("/stale-evidence/scan", authAsync, canTraceAsync("update"), wrap(async (req, res) => res.json(await RevisionImpact.scanStaleEvidenceAsync(db, tenantOf(req), { limit: body(req).limit }, req.actor, req.ip))));
  router.post(
    "/stale-evidence/scan/job",
    authAsync,
    canTraceAsync("create"),
    wrap(async (req, res) => res.status(202).json(await Jobs.submitStaleEvidenceScanAsync(db, tenantOf(req), body(req), req.actor, req.ip)))
  );

  // ── Change impact & traceability (reuse the Digital Thread engine) ────────
  router.get(
    "/requirements/:ref/impact",
    authAsync,
    canImpactAsync("read"),
    wrap(async (req, res) => res.json(await RevisionImpact.analyzeRequirementImpactAsync(db, tenantOf(req), req.params.ref, { maxDepth: query(req).maxDepth ?? query(req).max_depth, asOf: query(req).asOf }, req.actor, req.ip)))
  );
  router.get(
    "/requirements/:ref/trace",
    authAsync,
    canTraceAsync("read"),
    wrap(async (req, res) => res.json(await RevisionImpact.traceRequirementAsync(db, tenantOf(req), req.params.ref, { direction: query(req).direction, maxDepth: query(req).maxDepth ?? query(req).max_depth, asOf: query(req).asOf }, req.actor)))
  );

  return router;
}
