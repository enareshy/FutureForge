// REST router for the Manufacturing & Quality Intelligence layer (Stage 9).
// Built as a factory so it reuses the application's auth, authorization and
// error middleware. Mounted at /api/manufacturing-quality and
// /api/v1/manufacturing-quality (mirrors verification-validation router).
//
// Bootstrap and data routes use `authAsync`/`canAsync` + `*Async` service twins,
// while the pure-vocabulary `/meta` route stays on the sync `auth`/`can` path. A
// route uses either the sync or the async layer, never both.
import { Constants, Configuration, Foundation, Quality, Readiness } from "./index.js";

const R = Constants.MANUFACTURING_QUALITY_RESOURCES;

export function createManufacturingQualityRouter({ express, db, auth, can, authAsync, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const query = (req) => req.query;
  const body = (req) => req.body ?? {};

  const canOverviewAsync = (a) => canAsync(R.overview, a);
  const canAdminAsync = (a) => canAsync(R.admin, a);
  const canAdmin = (a) => can(R.admin, a);
  const canIssuesAsync = (a) => canAsync(R.issues, a);
  const canInspectionsAsync = (a) => canAsync(R.inspections, a);
  const canActionsAsync = (a) => canAsync(R.correctiveActions, a);
  const canReadinessAsync = (a) => canAsync(R.readiness, a);
  const canSummariesAsync = (a) => canAsync(R.summaries, a);
  const canMetricsAsync = (a) => canAsync(R.metrics, a);

  // ── Meta, health ────────────────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
    can(R.overview, "read"),
    wrap((_req, res) =>
      res.json({
        source_module: Constants.SOURCE_MODULE,
        subject_types: { ...Constants.SUBJECT_TYPES },
        issue_types: [...Constants.ISSUE_TYPES],
        issue_severities: [...Constants.ISSUE_SEVERITIES],
        issue_statuses: [...Constants.ISSUE_STATUSES],
        issue_dispositions: [...Constants.ISSUE_DISPOSITIONS],
        inspection_types: [...Constants.INSPECTION_TYPES],
        inspection_statuses: [...Constants.INSPECTION_STATUSES],
        action_types: [...Constants.ACTION_TYPES],
        action_statuses: [...Constants.ACTION_STATUSES],
        action_effectiveness: [...Constants.ACTION_EFFECTIVENESS],
        readiness: Readiness.readinessMeta(),
        resources: { ...Constants.MANUFACTURING_QUALITY_RESOURCES },
        config_defaults: { ...Constants.CONFIG_DEFAULTS },
        config_bounds: { ...Constants.CONFIG_BOUNDS },
      })
    )
  );
  router.get("/health", authAsync, canOverviewAsync("read"), wrap(async (req, res) => res.json(await Foundation.manufacturingQualityHealthAsync(db, tenantOf(req)))));

  // ── Configuration (platform config store) ───────────────────────────────
  router.get("/config", auth, canAdmin("read"), wrap((req, res) => res.json(Configuration.listConfig(db, tenantOf(req)))));
  router.put(
    "/config/:key",
    auth,
    canAdmin("update"),
    wrap((req, res) => res.json(Configuration.setConfig(db, tenantOf(req), req.params.key, body(req).value, req.actor, req.ip)))
  );

  // ── Bootstrap ───────────────────────────────────────────────────────────
  router.post("/foundation/ensure", authAsync, canAdminAsync("execute"), wrap(async (_req, res) => res.json(await Foundation.ensureManufacturingQualityFoundationAsync(db))));

  // ── Quality issues / non-conformances ───────────────────────────────────
  router.get(
    "/issues",
    authAsync,
    canIssuesAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Quality.listQualityIssuesAsync(db, {
          tenantId: tenantOf(req),
          status: query(req).status,
          severity: query(req).severity,
          issue_type: query(req).issue_type ?? query(req).issueType,
          product_object_id: query(req).product_object_id ?? query(req).productObjectId,
          operation_object_id: query(req).operation_object_id ?? query(req).operationObjectId,
          supplier_object_id: query(req).supplier_object_id ?? query(req).supplierObjectId,
          q: query(req).q,
          page: query(req).page,
          pageSize: query(req).pageSize ?? query(req).page_size,
        })
      )
    )
  );
  router.post(
    "/issues",
    authAsync,
    canIssuesAsync("create"),
    wrap(async (req, res) => res.status(201).json(await Quality.createQualityIssueAsync(db, tenantOf(req), body(req), req.actor, req.ip)))
  );
  router.get("/issues/:ref", authAsync, canIssuesAsync("read"), wrap(async (req, res) => res.json(await Quality.getQualityIssueAsync(db, tenantOf(req), req.params.ref))));
  router.put(
    "/issues/:ref",
    authAsync,
    canIssuesAsync("update"),
    wrap(async (req, res) => res.json(await Quality.updateQualityIssueAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );

  // ── Inspections ─────────────────────────────────────────────────────────
  router.get(
    "/inspections",
    authAsync,
    canInspectionsAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Quality.listInspectionsAsync(db, {
          tenantId: tenantOf(req),
          status: query(req).status,
          inspection_type: query(req).inspection_type ?? query(req).inspectionType,
          product_object_id: query(req).product_object_id ?? query(req).productObjectId,
          operation_object_id: query(req).operation_object_id ?? query(req).operationObjectId,
          quality_issue_id: query(req).quality_issue_id ?? query(req).qualityIssueId,
          page: query(req).page,
          pageSize: query(req).pageSize ?? query(req).page_size,
        })
      )
    )
  );
  router.post(
    "/inspections",
    authAsync,
    canInspectionsAsync("create"),
    wrap(async (req, res) => res.status(201).json(await Quality.createInspectionAsync(db, tenantOf(req), body(req), req.actor, req.ip)))
  );

  // ── Corrective actions ──────────────────────────────────────────────────
  router.get(
    "/corrective-actions",
    authAsync,
    canActionsAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Quality.listCorrectiveActionsAsync(db, {
          tenantId: tenantOf(req),
          status: query(req).status,
          action_type: query(req).action_type ?? query(req).actionType,
          quality_issue_id: query(req).quality_issue_id ?? query(req).qualityIssueId,
          page: query(req).page,
          pageSize: query(req).pageSize ?? query(req).page_size,
        })
      )
    )
  );
  router.post(
    "/corrective-actions",
    authAsync,
    canActionsAsync("create"),
    wrap(async (req, res) => res.status(201).json(await Quality.createCorrectiveActionAsync(db, tenantOf(req), body(req), req.actor, req.ip)))
  );
  router.put(
    "/corrective-actions/:ref",
    authAsync,
    canActionsAsync("update"),
    wrap(async (req, res) => res.json(await Quality.updateCorrectiveActionAsync(db, tenantOf(req), req.params.ref, body(req), req.actor, req.ip)))
  );

  // ── Release readiness ───────────────────────────────────────────────────
  router.post(
    "/readiness/evaluate",
    authAsync,
    canReadinessAsync("execute"),
    wrap(async (req, res) => res.status(201).json(await Readiness.evaluateReadinessAsync(db, tenantOf(req), body(req), req.actor, req.ip)))
  );
  router.get(
    "/readiness",
    authAsync,
    canReadinessAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Readiness.listReadinessEvaluationsAsync(db, {
          tenantId: tenantOf(req),
          subject_type: query(req).subject_type ?? query(req).subjectType,
          subject_ref: query(req).subject_ref ?? query(req).subjectRef,
          overall_result: query(req).overall_result ?? query(req).overallResult,
          stale: query(req).stale,
          page: query(req).page,
          pageSize: query(req).pageSize ?? query(req).page_size,
        })
      )
    )
  );
  router.get("/readiness/:ref", authAsync, canReadinessAsync("read"), wrap(async (req, res) => res.json(await Readiness.getReadinessEvaluationAsync(db, tenantOf(req), req.params.ref))));
  router.post(
    "/readiness/:ref/stale",
    authAsync,
    canReadinessAsync("update"),
    wrap(async (req, res) => {
      const evaluation = await Readiness.requireEvaluationRowAsync(db, tenantOf(req), req.params.ref);
      const result = await Readiness.markReadinessStaleAsync(
        db,
        tenantOf(req),
        { subjectType: evaluation.subject_type, subjectRef: evaluation.subject_ref, reason: body(req).reason },
        req.actor,
        req.ip
      );
      return res.json(result);
    })
  );

  // ── Summaries & analytics ───────────────────────────────────────────────
  router.get(
    "/summaries/product/:ref",
    authAsync,
    canSummariesAsync("read"),
    wrap(async (req, res) => res.json(await Quality.productQualitySummaryAsync(db, tenantOf(req), req.params.ref, { limit: query(req).limit })))
  );
  router.get(
    "/summaries/recurrence",
    authAsync,
    canSummariesAsync("read"),
    wrap(async (req, res) => res.json(await Quality.detectRecurrenceAsync(db, tenantOf(req), { windowDays: query(req).windowDays ?? query(req).window_days, limit: query(req).limit })))
  );
  router.get("/summaries/gaps", authAsync, canSummariesAsync("read"), wrap(async (req, res) => res.json(await Quality.detectQualityGapsAsync(db, tenantOf(req), { limit: query(req).limit }))));
  router.get("/metrics", authAsync, canMetricsAsync("read"), wrap(async (req, res) => res.json(await Quality.issueMetricsAsync(db, tenantOf(req)))));

  return router;
}
