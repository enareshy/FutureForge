// REST router for Data Quality (rules, evaluation, results, scores, exceptions,
// duplicate detection and remediation). Mounted at /api/data-quality and
// /api/v1/data-quality.
//
// Every route is authorized against an IAM permission resource. The whole
// request path runs on the async `pg` layer so a slow query never stalls the
// process; only the pure `/meta` handler stays synchronous.
import { Rules, Engine, Results, Exceptions, Duplicates, Remediation, Validation } from "./index.js";

export function createDataQualityRouter({ express, db, auth, authAsync, can, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const guard = authAsync || auth;
  const gate = canAsync || can;

  const canRules = (action) => gate("iam.data_quality.rules", action);
  const canEvaluate = (action) => gate("iam.data_quality.evaluation", action);
  const canResults = (action) => gate("iam.data_quality.results", action);
  const canExceptions = (action) => gate("iam.data_quality.exceptions", action);
  const canDuplicates = (action) => gate("iam.data_quality.duplicates", action);
  const canRemediation = (action) => gate("iam.data_quality.remediation", action);

  router.get(
    "/meta",
    guard,
    gate("iam.data_quality", "read"),
    wrap((_req, res) => res.json({ vocabularies: Validation.vocabulary(), evaluators: Engine.listEvaluators(), duplicate_strategies: Duplicates.listDuplicateStrategies() }))
  );

  // ── Rules ─────────────────────────────────────────────────────────────────
  router.get(
    "/rules",
    guard,
    canRules("read"),
    wrap(async (req, res) => res.json(await Rules.listRulesAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/rules",
    guard,
    canRules("create"),
    wrap(async (req, res) => res.status(201).json(await Rules.createRuleAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.post(
    "/rules/validate",
    guard,
    canRules("read"),
    wrap((req, res) => {
      try {
        res.json({ valid: true, normalized: Rules.validateRuleInput(req.body || {}) });
      } catch (error) {
        res.status(error.status || 400).json({ valid: false, error: error.message, code: error.code || null, details: error.details || null });
      }
    })
  );
  router.get(
    "/rules/:ref",
    guard,
    canRules("read"),
    wrap(async (req, res) => res.json(await Rules.getRuleAsync(db, req.params.ref, { includeVersions: req.query.includeVersions === "true" })))
  );
  router.post(
    "/rules/:ref/validate",
    guard,
    canRules("read"),
    wrap(async (req, res) => {
      const rule = await Rules.getRuleAsync(db, req.params.ref);
      const normalized = Rules.validateRuleInput({
        rule_type: rule.rule_type,
        object_type: rule.object_type,
        attribute_name: rule.attribute_name,
        dimension: rule.dimension,
        severity: rule.severity,
        execution_mode: rule.execution_mode,
        weight: rule.weight,
        expression: rule.expression,
      });
      res.json({ valid: true, description: normalized.description });
    })
  );
  router.post(
    "/rules/:ref/activate",
    guard,
    canRules("execute"),
    wrap(async (req, res) => res.json(await Rules.setRuleStatusAsync(db, req.params.ref, "active", req.actor, req.ip)))
  );
  const updateRule = wrap(async (req, res) => res.json(await Rules.updateRuleAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/rules/:ref", guard, canRules("update"), updateRule);
  router.patch("/rules/:ref", guard, canRules("update"), updateRule);
  router.post(
    "/rules/:ref/status",
    guard,
    canRules("execute"),
    wrap(async (req, res) => res.json(await Rules.setRuleStatusAsync(db, req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.get(
    "/rules/:ref/versions",
    guard,
    canRules("read"),
    wrap(async (req, res) => res.json({ items: await Rules.listRuleVersionsAsync(db, req.params.ref) }))
  );

  // ── Evaluation ────────────────────────────────────────────────────────────
  router.post(
    "/evaluate",
    guard,
    canEvaluate("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      const result = await Engine.evaluateObjectAsync(db, {
        tenantId: tenantOf(req),
        objectType: body.object_type,
        objectId: body.object_id,
        actor: req.actor,
        trigger: body.trigger || "manual",
        policyId: body.policy_id ?? null,
        ip: req.ip,
      });
      res.json(result);
    })
  );
  router.post(
    "/evaluate/batch",
    guard,
    canEvaluate("execute"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(
        await Engine.evaluateTypeAsync(db, {
          tenantId: tenantOf(req),
          objectType: body.object_type,
          objectIds: body.object_ids || null,
          actor: req.actor,
          trigger: body.trigger || "batch",
          persist: body.persist !== false,
          limit: body.limit,
          ip: req.ip,
        })
      );
    })
  );

  // ── Results & violations ──────────────────────────────────────────────────
  router.get(
    "/results",
    guard,
    canResults("read"),
    wrap(async (req, res) => res.json(await Results.listResultsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.get(
    "/results/:objectType/:objectId",
    guard,
    canResults("read"),
    wrap(async (req, res) =>
      res.json(
        await Results.getResultAsync(db, {
          tenantId: tenantOf(req),
          objectType: req.params.objectType,
          objectId: req.params.objectId,
          includeViolations: req.query.includeViolations !== "false",
        })
      )
    )
  );
  router.get(
    "/results/:objectType/:objectId/history",
    guard,
    canResults("read"),
    wrap(async (req, res) =>
      res.json({
        items: await Results.objectHistoryAsync(db, {
          tenantId: tenantOf(req),
          objectType: req.params.objectType,
          objectId: req.params.objectId,
          limit: req.query.limit,
        }),
      })
    )
  );
  router.get(
    "/violations",
    guard,
    canResults("read"),
    wrap(async (req, res) => res.json(await Results.listViolationsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );

  // ── Scores & dashboards ───────────────────────────────────────────────────
  router.get(
    "/scores",
    guard,
    canResults("read"),
    wrap(async (req, res) => res.json(await Results.scoreSummaryAsync(db, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/scores/domains",
    guard,
    canResults("read"),
    wrap(async (req, res) => res.json({ items: await Results.domainScoresAsync(db, { tenantId: tenantOf(req) }) }))
  );
  router.get(
    "/scores/domains/:domainId",
    guard,
    canResults("read"),
    wrap(async (req, res) => res.json({ items: await Results.domainScoresAsync(db, { tenantId: tenantOf(req), domainId: req.params.domainId }) }))
  );
  router.get(
    "/scores/object-types",
    guard,
    canResults("read"),
    wrap(async (req, res) => res.json({ items: await Results.typeScoresAsync(db, { tenantId: tenantOf(req), objectType: req.query.objectType }) }))
  );
  router.get(
    "/scores/trend",
    guard,
    canResults("read"),
    wrap(async (req, res) => res.json({ items: await Results.trendAsync(db, { tenantId: tenantOf(req), objectType: req.query.objectType || null, days: req.query.days }) }))
  );
  router.get(
    "/scores/objects/:objectType/:objectId",
    guard,
    canResults("read"),
    wrap(async (req, res) =>
      res.json(await Results.getResultAsync(db, { tenantId: tenantOf(req), objectType: req.params.objectType, objectId: req.params.objectId }))
    )
  );

  // ── Exceptions ────────────────────────────────────────────────────────────
  router.get(
    "/exceptions",
    guard,
    canExceptions("read"),
    wrap(async (req, res) => res.json(await Exceptions.listExceptionsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/exceptions",
    guard,
    canExceptions("create"),
    wrap(async (req, res) => res.status(201).json(await Exceptions.createExceptionAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/exceptions/summary",
    guard,
    canExceptions("read"),
    wrap(async (req, res) => res.json(await Exceptions.exceptionSummaryAsync(db, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/exceptions/:ref",
    guard,
    canExceptions("read"),
    wrap(async (req, res) => res.json(await Exceptions.getExceptionAsync(db, req.params.ref, { includeComments: req.query.includeComments !== "false" })))
  );
  const updateException = wrap(async (req, res) =>
    res.json(await Exceptions.updateExceptionAsync(db, req.params.ref, req.body || {}, req.actor, req.ip))
  );
  router.put("/exceptions/:ref", guard, canExceptions("update"), updateException);
  router.patch("/exceptions/:ref", guard, canExceptions("update"), updateException);
  router.post(
    "/exceptions/:ref/assign",
    guard,
    canExceptions("execute"),
    wrap(async (req, res) => res.json(await Exceptions.assignExceptionAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/exceptions/:ref/status",
    guard,
    canExceptions("execute"),
    wrap(async (req, res) => res.json(await Exceptions.transitionExceptionAsync(db, req.params.ref, req.body?.status, req.body || {}, req.actor, req.ip)))
  );
  const exceptionAction = (status) =>
    wrap(async (req, res) => res.json(await Exceptions.transitionExceptionAsync(db, req.params.ref, status, req.body || {}, req.actor, req.ip)));
  router.post("/exceptions/:ref/resolve", guard, canExceptions("execute"), exceptionAction("resolved"));
  router.post("/exceptions/:ref/verify", guard, canExceptions("execute"), exceptionAction("verified"));
  router.post("/exceptions/:ref/close", guard, canExceptions("execute"), exceptionAction("closed"));
  router.post("/exceptions/:ref/waive", guard, canExceptions("execute"), exceptionAction("waived"));
  router.post("/exceptions/:ref/reject", guard, canExceptions("execute"), exceptionAction("rejected"));
  router.get(
    "/exceptions/:ref/comments",
    guard,
    canExceptions("read"),
    wrap(async (req, res) => res.json({ items: await Exceptions.listExceptionCommentsAsync(db, req.params.ref) }))
  );
  router.post(
    "/exceptions/:ref/comments",
    guard,
    canExceptions("update"),
    wrap(async (req, res) => res.status(201).json(await Exceptions.addExceptionCommentAsync(db, req.params.ref, req.body || {}, req.actor)))
  );

  // ── Duplicate detection ───────────────────────────────────────────────────
  router.get(
    "/duplicates",
    guard,
    canDuplicates("read"),
    wrap(async (req, res) =>
      res.json({
        match_rules: await Duplicates.listMatchRulesAsync(db, { tenantId: tenantOf(req), objectType: req.query.objectType, status: req.query.status }),
        candidates: await Duplicates.listCandidatesAsync(db, { ...req.query, tenantId: tenantOf(req) }),
      })
    )
  );
  router.get(
    "/duplicates/match-rules",
    guard,
    canDuplicates("read"),
    wrap(async (req, res) => res.json({ items: await Duplicates.listMatchRulesAsync(db, { tenantId: tenantOf(req), objectType: req.query.objectType, status: req.query.status }) }))
  );
  router.post(
    "/duplicates/match-rules",
    guard,
    canDuplicates("create"),
    wrap(async (req, res) => res.status(201).json(await Duplicates.createMatchRuleAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.patch(
    "/duplicates/match-rules/:ref",
    guard,
    canDuplicates("update"),
    wrap(async (req, res) => res.json(await Duplicates.updateMatchRuleAsync(db, req.params.ref, req.body || {}, req.actor)))
  );
  router.get(
    "/duplicates/candidates",
    guard,
    canDuplicates("read"),
    wrap(async (req, res) => res.json(await Duplicates.listCandidatesAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/duplicates/detect",
    guard,
    canDuplicates("execute"),
    wrap(async (req, res) => res.json(await Duplicates.detectDuplicatesAsync(db, { tenantId: tenantOf(req), objectType: req.body?.object_type, matchRuleId: req.body?.match_rule_id, actor: req.actor, ip: req.ip })))
  );
  router.post(
    "/duplicates/candidates/:ref/resolve",
    guard,
    canDuplicates("execute"),
    wrap(async (req, res) => res.json(await Duplicates.resolveCandidateAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/duplicates/:ref/resolve",
    guard,
    canDuplicates("execute"),
    wrap(async (req, res) => res.json(await Duplicates.resolveCandidateAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/duplicates/summary",
    guard,
    canDuplicates("read"),
    wrap(async (req, res) => res.json(await Duplicates.duplicateSummaryAsync(db, { tenantId: tenantOf(req) })))
  );

  // ── Remediation ───────────────────────────────────────────────────────────
  router.get(
    "/remediations",
    guard,
    canRemediation("read"),
    wrap(async (req, res) => res.json({ items: await Remediation.listRemediationsAsync(db, { ...req.query, tenantId: tenantOf(req) }) }))
  );
  router.post(
    "/remediations",
    guard,
    canRemediation("execute"),
    wrap(async (req, res) => res.status(201).json(await Remediation.applyRemediationAsync(db, { ...(req.body || {}), tenant_id: tenantOf(req) }, req.actor, req.ip)))
  );
  router.get(
    "/remediations/summary",
    guard,
    canRemediation("read"),
    wrap(async (req, res) => res.json(await Remediation.remediationSummaryAsync(db, { tenantId: tenantOf(req) })))
  );

  return router;
}
