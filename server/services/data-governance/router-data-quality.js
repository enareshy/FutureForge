// REST router for Data Quality (rules, evaluation, results, scores, exceptions,
// duplicate detection and remediation). Mounted at /api/data-quality and
// /api/v1/data-quality.
import { Rules, Engine, Results, Exceptions, Duplicates, Remediation, Validation } from "./index.js";

export function createDataQualityRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const canRules = (action) => can("iam.data_quality.rules", action);
  const canEvaluate = (action) => can("iam.data_quality.evaluation", action);
  const canResults = (action) => can("iam.data_quality.results", action);
  const canExceptions = (action) => can("iam.data_quality.exceptions", action);
  const canDuplicates = (action) => can("iam.data_quality.duplicates", action);
  const canRemediation = (action) => can("iam.data_quality.remediation", action);

  router.get(
    "/meta",
    auth,
    can("iam.data_quality", "read"),
    wrap((_req, res) => res.json({ vocabularies: Validation.vocabulary(), evaluators: Engine.listEvaluators(), duplicate_strategies: Duplicates.listDuplicateStrategies() }))
  );

  // ── Rules ─────────────────────────────────────────────────────────────────
  router.get(
    "/rules",
    auth,
    canRules("read"),
    wrap((req, res) => res.json(Rules.listRules(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/rules",
    auth,
    canRules("create"),
    wrap((req, res) => res.status(201).json(Rules.createRule(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.post(
    "/rules/validate",
    auth,
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
    auth,
    canRules("read"),
    wrap((req, res) => res.json(Rules.getRule(db, req.params.ref, { includeVersions: req.query.includeVersions === "true" })))
  );
  router.post(
    "/rules/:ref/validate",
    auth,
    canRules("read"),
    wrap((req, res) => {
      const rule = Rules.getRule(db, req.params.ref);
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
    auth,
    canRules("execute"),
    wrap((req, res) => res.json(Rules.setRuleStatus(db, req.params.ref, "active", req.actor, req.ip)))
  );
  const updateRule = wrap((req, res) => res.json(Rules.updateRule(db, req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/rules/:ref", auth, canRules("update"), updateRule);
  router.patch("/rules/:ref", auth, canRules("update"), updateRule);
  router.post(
    "/rules/:ref/status",
    auth,
    canRules("execute"),
    wrap((req, res) => res.json(Rules.setRuleStatus(db, req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.get(
    "/rules/:ref/versions",
    auth,
    canRules("read"),
    wrap((req, res) => res.json({ items: Rules.listRuleVersions(db, req.params.ref) }))
  );

  // ── Evaluation ────────────────────────────────────────────────────────────
  router.post(
    "/evaluate",
    auth,
    canEvaluate("execute"),
    wrap((req, res) => {
      const body = req.body || {};
      const result = Engine.evaluateObject(db, {
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
    auth,
    canEvaluate("execute"),
    wrap((req, res) => {
      const body = req.body || {};
      res.json(
        Engine.evaluateType(db, {
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
    auth,
    canResults("read"),
    wrap((req, res) => res.json(Results.listResults(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.get(
    "/results/:objectType/:objectId",
    auth,
    canResults("read"),
    wrap((req, res) =>
      res.json(
        Results.getResult(db, {
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
    auth,
    canResults("read"),
    wrap((req, res) =>
      res.json({
        items: Results.objectHistory(db, {
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
    auth,
    canResults("read"),
    wrap((req, res) => res.json(Results.listViolations(db, { ...req.query, tenantId: tenantOf(req) })))
  );

  // ── Scores & dashboards ───────────────────────────────────────────────────
  router.get(
    "/scores",
    auth,
    canResults("read"),
    wrap((req, res) => res.json(Results.scoreSummary(db, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/scores/domains",
    auth,
    canResults("read"),
    wrap((req, res) => res.json({ items: Results.domainScores(db, { tenantId: tenantOf(req) }) }))
  );
  router.get(
    "/scores/domains/:domainId",
    auth,
    canResults("read"),
    wrap((req, res) => res.json({ items: Results.domainScores(db, { tenantId: tenantOf(req), domainId: req.params.domainId }) }))
  );
  router.get(
    "/scores/object-types",
    auth,
    canResults("read"),
    wrap((req, res) => res.json({ items: Results.typeScores(db, { tenantId: tenantOf(req), objectType: req.query.objectType }) }))
  );
  router.get(
    "/scores/trend",
    auth,
    canResults("read"),
    wrap((req, res) => res.json({ items: Results.trend(db, { tenantId: tenantOf(req), objectType: req.query.objectType || null, days: req.query.days }) }))
  );
  router.get(
    "/scores/objects/:objectType/:objectId",
    auth,
    canResults("read"),
    wrap((req, res) =>
      res.json(Results.getResult(db, { tenantId: tenantOf(req), objectType: req.params.objectType, objectId: req.params.objectId }))
    )
  );

  // ── Exceptions ────────────────────────────────────────────────────────────
  router.get(
    "/exceptions",
    auth,
    canExceptions("read"),
    wrap((req, res) => res.json(Exceptions.listExceptions(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/exceptions",
    auth,
    canExceptions("create"),
    wrap((req, res) => res.status(201).json(Exceptions.createException(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/exceptions/summary",
    auth,
    canExceptions("read"),
    wrap((req, res) => res.json(Exceptions.exceptionSummary(db, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/exceptions/:ref",
    auth,
    canExceptions("read"),
    wrap((req, res) => res.json(Exceptions.getException(db, req.params.ref, { includeComments: req.query.includeComments !== "false" })))
  );
  const updateException = wrap((req, res) =>
    res.json(Exceptions.updateException(db, req.params.ref, req.body || {}, req.actor, req.ip))
  );
  router.put("/exceptions/:ref", auth, canExceptions("update"), updateException);
  router.patch("/exceptions/:ref", auth, canExceptions("update"), updateException);
  router.post(
    "/exceptions/:ref/assign",
    auth,
    canExceptions("execute"),
    wrap((req, res) => res.json(Exceptions.assignException(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/exceptions/:ref/status",
    auth,
    canExceptions("execute"),
    wrap((req, res) => res.json(Exceptions.transitionException(db, req.params.ref, req.body?.status, req.body || {}, req.actor, req.ip)))
  );
  const exceptionAction = (status) =>
    wrap((req, res) => res.json(Exceptions.transitionException(db, req.params.ref, status, req.body || {}, req.actor, req.ip)));
  router.post("/exceptions/:ref/resolve", auth, canExceptions("execute"), exceptionAction("resolved"));
  router.post("/exceptions/:ref/verify", auth, canExceptions("execute"), exceptionAction("verified"));
  router.post("/exceptions/:ref/close", auth, canExceptions("execute"), exceptionAction("closed"));
  router.post("/exceptions/:ref/waive", auth, canExceptions("execute"), exceptionAction("waived"));
  router.post("/exceptions/:ref/reject", auth, canExceptions("execute"), exceptionAction("rejected"));
  router.get(
    "/exceptions/:ref/comments",
    auth,
    canExceptions("read"),
    wrap((req, res) => res.json({ items: Exceptions.listExceptionComments(db, req.params.ref) }))
  );
  router.post(
    "/exceptions/:ref/comments",
    auth,
    canExceptions("update"),
    wrap((req, res) => res.status(201).json(Exceptions.addExceptionComment(db, req.params.ref, req.body || {}, req.actor)))
  );

  // ── Duplicate detection ───────────────────────────────────────────────────
  router.get(
    "/duplicates",
    auth,
    canDuplicates("read"),
    wrap((req, res) =>
      res.json({
        match_rules: Duplicates.listMatchRules(db, { tenantId: tenantOf(req), objectType: req.query.objectType, status: req.query.status }),
        candidates: Duplicates.listCandidates(db, { ...req.query, tenantId: tenantOf(req) }),
      })
    )
  );
  router.get(
    "/duplicates/match-rules",
    auth,
    canDuplicates("read"),
    wrap((req, res) => res.json({ items: Duplicates.listMatchRules(db, { tenantId: tenantOf(req), objectType: req.query.objectType, status: req.query.status }) }))
  );
  router.post(
    "/duplicates/match-rules",
    auth,
    canDuplicates("create"),
    wrap((req, res) => res.status(201).json(Duplicates.createMatchRule(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.patch(
    "/duplicates/match-rules/:ref",
    auth,
    canDuplicates("update"),
    wrap((req, res) => res.json(Duplicates.updateMatchRule(db, req.params.ref, req.body || {}, req.actor)))
  );
  router.get(
    "/duplicates/candidates",
    auth,
    canDuplicates("read"),
    wrap((req, res) => res.json(Duplicates.listCandidates(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/duplicates/detect",
    auth,
    canDuplicates("execute"),
    wrap((req, res) => res.json(Duplicates.detectDuplicates(db, { tenantId: tenantOf(req), objectType: req.body?.object_type, matchRuleId: req.body?.match_rule_id, actor: req.actor, ip: req.ip })))
  );
  router.post(
    "/duplicates/candidates/:ref/resolve",
    auth,
    canDuplicates("execute"),
    wrap((req, res) => res.json(Duplicates.resolveCandidate(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/duplicates/:ref/resolve",
    auth,
    canDuplicates("execute"),
    wrap((req, res) => res.json(Duplicates.resolveCandidate(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/duplicates/summary",
    auth,
    canDuplicates("read"),
    wrap((req, res) => res.json(Duplicates.duplicateSummary(db, { tenantId: tenantOf(req) })))
  );

  // ── Remediation ───────────────────────────────────────────────────────────
  router.get(
    "/remediations",
    auth,
    canRemediation("read"),
    wrap((req, res) => res.json({ items: Remediation.listRemediations(db, { ...req.query, tenantId: tenantOf(req) }) }))
  );
  router.post(
    "/remediations",
    auth,
    canRemediation("execute"),
    wrap((req, res) => res.status(201).json(Remediation.applyRemediation(db, { ...(req.body || {}), tenant_id: tenantOf(req) }, req.actor, req.ip)))
  );
  router.get(
    "/remediations/summary",
    auth,
    canRemediation("read"),
    wrap((req, res) => res.json(Remediation.remediationSummary(db, { tenantId: tenantOf(req) })))
  );

  return router;
}
