// REST router for the Predictive Intelligence & Recommendations layer (Stage 10).
// Built as a factory so it reuses the application's auth, authorization and
// error middleware. Mounted at /api/predictive-intelligence and
// /api/v1/predictive-intelligence (mirrors manufacturing-quality router).
//
// The /meta route stays on the sync auth/can layer; all data routes use
// authAsync/canAsync + the *Async service twins so a request never mixes layers.
import { Constants, Configuration, UseCases, Assessment, Predictions, Recommendations, Monitoring, Foundation } from "./index.js";

const R = Constants.PREDICTIVE_RESOURCES;

export function createPredictiveRouter({ express, db, auth, can, authAsync, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const query = (req) => req.query;
  const body = (req) => req.body ?? {};

  const canOverviewAsync = (a) => canAsync(R.overview, a);
  const canUseCasesAsync = (a) => canAsync(R.useCases, a);
  const canPredictionsAsync = (a) => canAsync(R.predictions, a);
  const canExplanationsAsync = (a) => canAsync(R.explanations, a);
  const canRecommendationsAsync = (a) => canAsync(R.recommendations, a);
  const canFeedbackAsync = (a) => canAsync(R.feedback, a);
  const canEvaluationsAsync = (a) => canAsync(R.evaluations, a);
  const canMonitoringAsync = (a) => canAsync(R.monitoring, a);
  const canAdminAsync = (a) => canAsync(R.admin, a);

  // ── Meta, health ────────────────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
    can(R.overview, "read"),
    wrap((_req, res) =>
      res.json({
        source_module: Constants.SOURCE_MODULE,
        methods: Constants.METHOD_VALUES.map((method) => ({ method, label: Constants.METHOD_LABELS[method] })),
        subject_types: { ...Constants.SUBJECT_TYPES },
        problem_types: [...Constants.PROBLEM_TYPES],
        use_case_statuses: [...Constants.USE_CASE_STATUSES],
        risk_categories: [...Constants.RISK_CATEGORIES],
        prediction_statuses: [...Constants.PREDICTION_STATUSES],
        recommendation_statuses: [...Constants.RECOMMENDATION_STATUSES],
        recommendation_transitions: { ...Constants.RECOMMENDATION_TRANSITIONS },
        built_in_use_cases: UseCases.builtInCatalog(),
        dataset_requirements: { ...Constants.DATASET_REQUIREMENTS },
        assessment: Assessment.assessmentMeta(),
        resources: { ...Constants.PREDICTIVE_RESOURCES },
        config_defaults: { ...Constants.CONFIG_DEFAULTS },
        config_bounds: { ...Constants.CONFIG_BOUNDS },
      })
    )
  );
  router.get("/health", authAsync, canOverviewAsync("read"), wrap(async (req, res) => res.json(await Monitoring.predictionsHealthAsync(db, tenantOf(req)))));

  // ── Configuration (platform config store) ───────────────────────────────
  router.get("/config", auth, can(R.admin, "read"), wrap((req, res) => res.json(Configuration.listConfig(db, tenantOf(req)))));
  router.put(
    "/config/:key",
    auth,
    can(R.admin, "update"),
    wrap((req, res) => res.json(Configuration.setConfig(db, tenantOf(req), req.params.key, body(req).value, req.actor, req.ip)))
  );

  // ── Bootstrap ───────────────────────────────────────────────────────────
  router.post("/foundation/ensure", authAsync, canAdminAsync("execute"), wrap(async (_req, res) => res.json(await Foundation.ensurePredictiveFoundationAsync(db))));
  router.post("/use-cases/seed", authAsync, canUseCasesAsync("execute"), wrap(async (req, res) => res.json(await UseCases.ensureBuiltInUseCasesAsync(db, tenantOf(req), req.actor))));

  // ── Use cases ───────────────────────────────────────────────────────────
  router.get(
    "/use-cases",
    authAsync,
    canUseCasesAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await UseCases.listUseCasesAsync(db, {
          tenantId: tenantOf(req),
          status: query(req).status,
          method: query(req).method,
          q: query(req).q,
          page: query(req).page,
          pageSize: query(req).pageSize ?? query(req).page_size,
        })
      )
    )
  );
  router.post("/use-cases", authAsync, canUseCasesAsync("create"), wrap(async (req, res) => res.status(201).json(await UseCases.createUseCaseAsync(db, tenantOf(req), body(req), req.actor, req.ip))));
  router.get("/use-cases/:ref", authAsync, canUseCasesAsync("read"), wrap(async (req, res) => res.json(await UseCases.getUseCaseAsync(db, tenantOf(req), req.params.ref))));
  router.put("/use-cases/:ref", authAsync, canUseCasesAsync("update"), wrap(async (req, res) => res.json(await UseCases.updateUseCaseAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip))));
  router.get("/use-cases/:ref/model", authAsync, canEvaluationsAsync("read"), wrap(async (req, res) => res.json(await Monitoring.modelStatusAsync(db, tenantOf(req), req.params.ref))));
  router.get(
    "/use-cases/:ref/evaluations",
    authAsync,
    canEvaluationsAsync("read"),
    wrap(async (req, res) => {
      const useCase = await UseCases.requireUseCaseRowAsync(db, tenantOf(req), req.params.ref);
      res.json(await Monitoring.listEvaluationsAsync(db, { tenantId: tenantOf(req), use_case_id: useCase.id, page: query(req).page, pageSize: query(req).pageSize ?? query(req).page_size }));
    })
  );
  router.post(
    "/use-cases/:ref/evaluations",
    authAsync,
    canEvaluationsAsync("create"),
    wrap(async (req, res) => res.status(201).json(await Monitoring.createEvaluationAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );

  // ── Evaluations (flat list) ─────────────────────────────────────────────
  router.get(
    "/evaluations",
    authAsync,
    canEvaluationsAsync("read"),
    wrap(async (req, res) => res.json(await Monitoring.listEvaluationsAsync(db, { tenantId: tenantOf(req), use_case_id: query(req).use_case_id ?? query(req).useCaseId, page: query(req).page, pageSize: query(req).pageSize ?? query(req).page_size })))
  );

  // ── Predictions ─────────────────────────────────────────────────────────
  router.get(
    "/predictions",
    authAsync,
    canPredictionsAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Predictions.listPredictionsAsync(db, {
          tenantId: tenantOf(req),
          use_case_code: query(req).use_case ?? query(req).useCase ?? query(req).use_case_code ?? query(req).useCaseCode,
          subject_type: query(req).subject_type ?? query(req).subjectType,
          subject_ref: query(req).subject_ref ?? query(req).subjectRef,
          status: query(req).status,
          risk_category: query(req).risk_category ?? query(req).riskCategory,
          q: query(req).q,
          page: query(req).page,
          pageSize: query(req).pageSize ?? query(req).page_size,
        })
      )
    )
  );
  router.post("/predictions", authAsync, canPredictionsAsync("create"), wrap(async (req, res) => res.json(await Predictions.executePredictionAsync(db, tenantOf(req), body(req), req.actor, req.ip))));
  router.get("/predictions/:ref", authAsync, canPredictionsAsync("read"), wrap(async (req, res) => res.json(await Predictions.getPredictionAsync(db, tenantOf(req), req.params.ref))));
  router.get("/predictions/:ref/explanation", authAsync, canExplanationsAsync("read"), wrap(async (req, res) => {
    const prediction = await Predictions.getPredictionAsync(db, tenantOf(req), req.params.ref);
    res.json({
      prediction_ref: prediction.prediction_ref,
      method: prediction.method,
      method_label: prediction.method_label,
      calibrated_probability: prediction.calibrated_probability,
      confidence: prediction.confidence,
      risk_category: prediction.risk_category,
      explanation: prediction.explanation,
      evidence: prediction.evidence,
      limitations: prediction.limitations,
      uncertainty: prediction.uncertainty,
      model_version: prediction.model_version,
      ruleset_version: prediction.ruleset_version,
    });
  }));
  router.post("/predictions/:ref/stale", authAsync, canPredictionsAsync("update"), wrap(async (req, res) => res.json(await Predictions.markPredictionStaleAsync(db, tenantOf(req), req.params.ref, { reason: body(req).reason }, req.actor, req.ip))));
  router.post("/predictions/:ref/feedback", authAsync, canFeedbackAsync("create"), wrap(async (req, res) => res.json(await Predictions.recordPredictionFeedbackAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip))));

  // ── Recommendations ─────────────────────────────────────────────────────
  router.get(
    "/recommendations",
    authAsync,
    canRecommendationsAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Recommendations.listRecommendationsAsync(db, {
          tenantId: tenantOf(req),
          status: query(req).status,
          prediction_id: query(req).prediction_id ?? query(req).predictionId,
          subject_type: query(req).subject_type ?? query(req).subjectType,
          subject_ref: query(req).subject_ref ?? query(req).subjectRef,
          q: query(req).q,
          page: query(req).page,
          pageSize: query(req).pageSize ?? query(req).page_size,
        })
      )
    )
  );
  router.post("/recommendations", authAsync, canRecommendationsAsync("create"), wrap(async (req, res) => res.status(201).json(await Recommendations.createRecommendationAsync(db, tenantOf(req), body(req), req.actor, req.ip))));
  router.post("/recommendations/generate", authAsync, canRecommendationsAsync("create"), wrap(async (req, res) => res.status(201).json(await Recommendations.generateRecommendationsAsync(db, tenantOf(req), body(req), req.actor, req.ip))));
  router.get("/recommendations/:ref", authAsync, canRecommendationsAsync("read"), wrap(async (req, res) => res.json(await Recommendations.getRecommendationAsync(db, tenantOf(req), req.params.ref))));
  router.post("/recommendations/:ref/transition", authAsync, canRecommendationsAsync("update"), wrap(async (req, res) => res.json(await Recommendations.transitionRecommendationAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip))));

  // ── Monitoring ──────────────────────────────────────────────────────────
  router.get("/monitoring", authAsync, canMonitoringAsync("read"), wrap(async (req, res) => res.json(await Monitoring.monitoringSummaryAsync(db, tenantOf(req)))));

  return router;
}
