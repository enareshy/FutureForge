// REST router for the Effectivity & Versioning Kernel. Built as a factory so it
// can reuse the application's auth, authorization and error-wrapping
// middleware. Mounted at /api/versioning and /api/v1/versioning.
//
// Data routes are served entirely from the asynchronous pool (`authAsync`/
// `canAsync` + `*Async` service twins); only the pure `/health/live` liveness
// probe stays synchronous.
import {
  Revisions,
  Versions,
  Effectivities,
  Variants,
  ConfigurationContexts,
  Policies,
  Baselines,
  Snapshots,
  Engine,
  Foundation,
  Metrics,
  Validation,
  Errors,
} from "../versioning.js";

function codeForStatus(status) {
  switch (status) {
    case "NOT_FOUND":
      return Errors.VERSIONING_ERROR_CODES.NO_APPLICABLE_REVISION;
    case "AMBIGUOUS":
      return Errors.VERSIONING_ERROR_CODES.AMBIGUOUS_RESOLUTION;
    case "CONFLICT":
      return Errors.VERSIONING_ERROR_CODES.EFFECTIVITY_CONFLICT;
    case "INVALID_CONTEXT":
      return Errors.VERSIONING_ERROR_CODES.INVALID_EFFECTIVITY_CONTEXT;
    default:
      return null;
  }
}

export function createVersioningRouter({ express, db, auth, authAsync, can, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const canRevisions = (action) => canAsync("iam.versioning.revisions", action);
  const canVersions = (action) => canAsync("iam.versioning.versions", action);
  const canEffectivities = (action) => canAsync("iam.versioning.effectivities", action);
  const canResolve = (action) => canAsync("iam.versioning.resolve", action);
  const canBaselines = (action) => canAsync("iam.versioning.baselines", action);
  const canSnapshots = (action) => canAsync("iam.versioning.snapshots", action);
  const canVariants = (action) => canAsync("iam.versioning.variants", action);
  const canConfigurations = (action) => canAsync("iam.versioning.configurations", action);
  const canPolicies = (action) => canAsync("iam.versioning.policies", action);
  const canMetrics = (action) => canAsync("iam.versioning.metrics", action);
  const canMeta = (action) => canAsync("iam.versioning", action);

  router.get(
    "/meta",
    authAsync,
    canMeta("read"),
    wrap(async (_req, res) => {
      res.json({
        ...Foundation.vocabulary(),
        effectivity_types: await Effectivities.listEffectivityTypesAsync(db),
      });
    })
  );

  router.get(
    "/effectivity-types",
    authAsync,
    canMeta("read"),
    wrap(async (req, res) => res.json({ items: await Effectivities.listEffectivityTypesAsync(db, { dimension: req.query.dimension, status: req.query.status }) }))
  );

  // ── Revisions ─────────────────────────────────────────────────────────────
  router.get(
    "/revisions",
    authAsync,
    canRevisions("read"),
    wrap(async (req, res) => res.json(await Revisions.listRevisionsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/revisions",
    authAsync,
    canRevisions("create"),
    wrap(async (req, res) => res.status(201).json(await Revisions.createRevisionAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/revisions/:ref",
    authAsync,
    canRevisions("read"),
    wrap(async (req, res) => res.json(await Revisions.getRevisionAsync(db, req.params.ref, { objectType: req.query.objectType })))
  );
  const updateRevisionHandler = wrap(async (req, res) =>
    res.json(await Revisions.updateRevisionAsync(db, req.params.ref, req.body || {}, req.actor, req.ip))
  );
  router.put("/revisions/:ref", authAsync, canRevisions("update"), updateRevisionHandler);
  router.patch("/revisions/:ref", authAsync, canRevisions("update"), updateRevisionHandler);
  router.delete(
    "/revisions/:ref",
    authAsync,
    canRevisions("delete"),
    wrap(async (req, res) => res.json(await Revisions.deleteRevisionAsync(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/revisions/:ref/activate",
    authAsync,
    canRevisions("execute"),
    wrap(async (req, res) => res.json(await Revisions.activateRevisionAsync(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/revisions/:ref/supersede",
    authAsync,
    canRevisions("execute"),
    wrap(async (req, res) => res.json(await Revisions.supersedeRevisionAsync(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/revisions/:ref/retire",
    authAsync,
    canRevisions("execute"),
    wrap(async (req, res) => res.json(await Revisions.retireRevisionAsync(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/revisions/:ref/default",
    authAsync,
    canRevisions("execute"),
    wrap(async (req, res) => res.json(await Revisions.setDefaultRevisionAsync(db, req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/revisions/:ref/history",
    authAsync,
    canRevisions("read"),
    wrap(async (req, res) => res.json(await Revisions.revisionHistoryAsync(db, req.params.ref, { limit: req.query.limit })))
  );
  router.get(
    "/revisions/:ref/compare/:other",
    authAsync,
    canRevisions("read"),
    wrap(async (req, res) => res.json(await Revisions.compareRevisionsAsync(db, req.params.ref, req.params.other)))
  );
  router.get(
    "/revisions/:ref/relationships",
    authAsync,
    canRevisions("read"),
    wrap(async (req, res) => res.json({ items: await Revisions.listRelationshipsAsync(db, req.params.ref, { direction: req.query.direction, type: req.query.type }) }))
  );
  router.post(
    "/revisions/:ref/relationships",
    authAsync,
    canRevisions("update"),
    wrap(async (req, res) => res.status(201).json(await Revisions.createRelationshipAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.delete(
    "/revisions/:ref/relationships/:id",
    authAsync,
    canRevisions("update"),
    wrap(async (req, res) => res.json(await Revisions.deleteRelationshipAsync(db, req.params.ref, req.params.id, req.actor, req.ip)))
  );

  // ── Versions ──────────────────────────────────────────────────────────────
  router.get(
    "/revisions/:ref/versions",
    authAsync,
    canVersions("read"),
    wrap(async (req, res) => res.json(await Versions.listVersionsAsync(db, req.params.ref, { status: req.query.status })))
  );
  router.post(
    "/revisions/:ref/versions",
    authAsync,
    canVersions("create"),
    wrap(async (req, res) => res.status(201).json(await Versions.createVersionAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/versions/:ref",
    authAsync,
    canVersions("read"),
    wrap(async (req, res) => res.json(await Versions.getVersionAsync(db, req.params.ref)))
  );
  const updateVersionHandler = wrap(async (req, res) =>
    res.json(await Versions.updateVersionAsync(db, req.params.ref, req.body || {}, req.actor, req.ip))
  );
  router.put("/versions/:ref", authAsync, canVersions("update"), updateVersionHandler);
  router.patch("/versions/:ref", authAsync, canVersions("update"), updateVersionHandler);
  router.delete(
    "/versions/:ref",
    authAsync,
    canVersions("delete"),
    wrap(async (req, res) => res.json(await Versions.deleteVersionAsync(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/versions/:ref/activate",
    authAsync,
    canVersions("execute"),
    wrap(async (req, res) => res.json(await Versions.activateVersionAsync(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/versions/:ref/supersede",
    authAsync,
    canVersions("execute"),
    wrap(async (req, res) => res.json(await Versions.supersedeVersionAsync(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/versions/:ref/default",
    authAsync,
    canVersions("execute"),
    wrap(async (req, res) => res.json(await Versions.setDefaultVersionAsync(db, req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/versions/:ref/history",
    authAsync,
    canVersions("read"),
    wrap(async (req, res) => res.json(await Versions.versionHistoryAsync(db, req.params.ref, { limit: req.query.limit })))
  );
  router.get(
    "/versions/:ref/compare/:other",
    authAsync,
    canVersions("read"),
    wrap(async (req, res) => res.json(await Versions.compareVersionsAsync(db, req.params.ref, req.params.other)))
  );

  // ── Effectivities ─────────────────────────────────────────────────────────
  router.get(
    "/effectivities",
    authAsync,
    canEffectivities("read"),
    wrap(async (req, res) => res.json(await Effectivities.listDefinitionsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/effectivities",
    authAsync,
    canEffectivities("create"),
    wrap(async (req, res) => res.status(201).json(await Effectivities.createDefinitionAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.post(
    "/effectivities/validate",
    authAsync,
    canEffectivities("read"),
    wrap(async (req, res) => res.json(Effectivities.validateDefinition(db, req.body || {})))
  );
  router.get(
    "/effectivities/:ref",
    authAsync,
    canEffectivities("read"),
    wrap(async (req, res) => res.json(await Effectivities.getDefinitionAsync(db, req.params.ref)))
  );
  const updateEffectivityHandler = wrap(async (req, res) =>
    res.json(await Effectivities.updateDefinitionAsync(db, req.params.ref, req.body || {}, req.actor, req.ip))
  );
  router.put("/effectivities/:ref", authAsync, canEffectivities("update"), updateEffectivityHandler);
  router.patch("/effectivities/:ref", authAsync, canEffectivities("update"), updateEffectivityHandler);
  router.delete(
    "/effectivities/:ref",
    authAsync,
    canEffectivities("delete"),
    wrap(async (req, res) => res.json(await Effectivities.deleteDefinitionAsync(db, req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/effectivities/:ref/assignments",
    authAsync,
    canEffectivities("read"),
    wrap(async (req, res) => {
      const definition = await Effectivities.getDefinitionAsync(db, req.params.ref);
      res.json({ items: await Effectivities.listAssignmentsAsync(db, { definitionId: definition.id, ...req.query, tenantId: tenantOf(req) }) });
    })
  );
  router.post(
    "/effectivities/:ref/assignments",
    authAsync,
    canEffectivities("update"),
    wrap(async (req, res) => res.status(201).json(await Effectivities.createAssignmentAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/assignments",
    authAsync,
    canEffectivities("read"),
    wrap(async (req, res) => res.json({ items: await Effectivities.listAssignmentsAsync(db, { ...req.query, tenantId: tenantOf(req) }) }))
  );
  router.delete(
    "/assignments/:ref",
    authAsync,
    canEffectivities("delete"),
    wrap(async (req, res) => res.json(await Effectivities.deleteAssignmentAsync(db, req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/effectivity/inspect",
    authAsync,
    canEffectivities("read"),
    wrap(async (req, res) => res.json(await Effectivities.inspectObjectAsync(db, { objectType: req.query.objectType, objectId: req.query.objectId, asOf: req.query.asOf })))
  );

  // ── Resolution ────────────────────────────────────────────────────────────
  router.post(
    "/effectivity/resolve",
    authAsync,
    canResolve("execute"),
    wrap(async (req, res) => {
      const result = await Engine.EffectivityResolver.resolveAsync(db, req.body || {}, {
        actor: req.actor,
        tenantId: tenantOf(req),
        requestId: req.get("X-Request-Id") || req.id || null,
        correlationId: req.get("X-Correlation-Id") || null,
      });
      const code = codeForStatus(result.resolutionStatus);
      res.json(code ? { ...result, code } : result);
    })
  );
  router.post(
    "/effectivity/resolve/bulk",
    authAsync,
    canResolve("execute"),
    wrap(async (req, res) => {
      const result = await Engine.EffectivityResolver.resolveBulkAsync(db, req.body || {}, {
        actor: req.actor,
        tenantId: tenantOf(req),
        correlationId: req.get("X-Correlation-Id") || null,
      });
      res.json(result);
    })
  );
  router.post(
    "/effectivity/validate",
    authAsync,
    canEffectivities("read"),
    wrap(async (req, res) => res.json(Effectivities.validateDefinition(db, req.body || {})))
  );

  // ── Resolution policies ───────────────────────────────────────────────────
  router.get(
    "/resolution-policies",
    authAsync,
    canPolicies("read"),
    wrap(async (req, res) => res.json({ items: await Policies.listResolutionPoliciesAsync(db, { status: req.query.status, tenantId: tenantOf(req) }) }))
  );
  router.post(
    "/resolution-policies",
    authAsync,
    canPolicies("create"),
    wrap(async (req, res) => res.status(201).json(await Policies.createResolutionPolicyAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/resolution-policies/:ref",
    authAsync,
    canPolicies("read"),
    wrap(async (req, res) => res.json(await Policies.getResolutionPolicyAsync(db, req.params.ref)))
  );
  const updatePolicyHandler = wrap(async (req, res) =>
    res.json(await Policies.updateResolutionPolicyAsync(db, req.params.ref, req.body || {}, req.actor, req.ip))
  );
  router.put("/resolution-policies/:ref", authAsync, canPolicies("update"), updatePolicyHandler);
  router.patch("/resolution-policies/:ref", authAsync, canPolicies("update"), updatePolicyHandler);
  router.delete(
    "/resolution-policies/:ref",
    authAsync,
    canPolicies("delete"),
    wrap(async (req, res) => res.json(await Policies.deleteResolutionPolicyAsync(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Baselines ─────────────────────────────────────────────────────────────
  router.get(
    "/baselines",
    authAsync,
    canBaselines("read"),
    wrap(async (req, res) => res.json(await Baselines.listBaselinesAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/baselines",
    authAsync,
    canBaselines("create"),
    wrap(async (req, res) => res.status(201).json(await Baselines.createBaselineAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/baselines/:ref",
    authAsync,
    canBaselines("read"),
    wrap(async (req, res) => res.json(await Baselines.getBaselineAsync(db, req.params.ref)))
  );
  router.delete(
    "/baselines/:ref",
    authAsync,
    canBaselines("delete"),
    wrap(async (req, res) => res.json(await Baselines.deleteBaselineAsync(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/baselines/:ref/objects",
    authAsync,
    canBaselines("update"),
    wrap(async (req, res) => res.json(await Baselines.addBaselineObjectsAsync(db, req.params.ref, req.body?.objects || [], req.actor, req.ip)))
  );
  router.delete(
    "/baselines/:ref/objects/:objectType/:objectId",
    authAsync,
    canBaselines("update"),
    wrap(async (req, res) => res.json(await Baselines.removeBaselineObjectAsync(db, req.params.ref, req.params.objectType, req.params.objectId, req.actor, req.ip)))
  );
  router.post(
    "/baselines/:ref/freeze",
    authAsync,
    canBaselines("execute"),
    wrap(async (req, res) => res.json(await Baselines.freezeBaselineAsync(db, req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/baselines/:ref/compare/:other",
    authAsync,
    canBaselines("read"),
    wrap(async (req, res) => res.json(await Baselines.compareBaselinesAsync(db, req.params.ref, req.params.other)))
  );
  router.get(
    "/baselines/:ref/restore",
    authAsync,
    canBaselines("read"),
    wrap(async (req, res) => res.json(await Baselines.restoreBaselineAsync(db, req.params.ref)))
  );

  // ── Snapshots ─────────────────────────────────────────────────────────────
  router.get(
    "/snapshots",
    authAsync,
    canSnapshots("read"),
    wrap(async (req, res) => res.json(await Snapshots.listSnapshotsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/snapshots",
    authAsync,
    canSnapshots("create"),
    wrap(async (req, res) => res.status(201).json(await Snapshots.createSnapshotAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/snapshots/:ref",
    authAsync,
    canSnapshots("read"),
    wrap(async (req, res) => res.json(await Snapshots.getSnapshotAsync(db, req.params.ref)))
  );
  router.delete(
    "/snapshots/:ref",
    authAsync,
    canSnapshots("delete"),
    wrap(async (req, res) => res.json(await Snapshots.deleteSnapshotAsync(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/snapshots/:ref/archive",
    authAsync,
    canSnapshots("update"),
    wrap(async (req, res) => res.json(await Snapshots.archiveSnapshotAsync(db, req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/snapshots/:ref/compare/:other",
    authAsync,
    canSnapshots("read"),
    wrap(async (req, res) => res.json(await Snapshots.compareSnapshotsAsync(db, req.params.ref, req.params.other)))
  );
  router.get(
    "/snapshots/:ref/reconstruct",
    authAsync,
    canSnapshots("read"),
    wrap(async (req, res) => res.json(await Snapshots.reconstructSnapshotAsync(db, req.params.ref)))
  );

  // ── Variants ──────────────────────────────────────────────────────────────
  router.get(
    "/variants",
    authAsync,
    canVariants("read"),
    wrap(async (req, res) => res.json(await Variants.listVariantsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/variants",
    authAsync,
    canVariants("create"),
    wrap(async (req, res) => res.status(201).json(await Variants.createVariantAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/variants/:ref",
    authAsync,
    canVariants("read"),
    wrap(async (req, res) => res.json(await Variants.getVariantAsync(db, req.params.ref)))
  );
  const updateVariantHandler = wrap(async (req, res) =>
    res.json(await Variants.updateVariantAsync(db, req.params.ref, req.body || {}, req.actor, req.ip))
  );
  router.put("/variants/:ref", authAsync, canVariants("update"), updateVariantHandler);
  router.patch("/variants/:ref", authAsync, canVariants("update"), updateVariantHandler);
  router.post(
    "/variants/:ref/options",
    authAsync,
    canVariants("update"),
    wrap(async (req, res) => res.status(201).json(await Variants.addOptionAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/variants/:ref/rules",
    authAsync,
    canVariants("update"),
    wrap(async (req, res) => res.status(201).json(await Variants.addRuleAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/variants/:ref/evaluate",
    authAsync,
    canVariants("read"),
    wrap(async (req, res) => res.json(await Variants.evaluateVariantAsync(db, req.params.ref, req.body || {})))
  );
  router.get(
    "/variants/:ref/history",
    authAsync,
    canVariants("read"),
    wrap(async (req, res) => res.json(await Variants.variantHistoryAsync(db, req.params.ref, { limit: req.query.limit })))
  );

  // ── Configuration contexts ────────────────────────────────────────────────
  router.get(
    "/configuration-contexts",
    authAsync,
    canConfigurations("read"),
    wrap(async (req, res) => res.json(await ConfigurationContexts.listConfigurationContextsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/configuration-contexts",
    authAsync,
    canConfigurations("create"),
    wrap(async (req, res) => res.status(201).json(await ConfigurationContexts.createConfigurationContextAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/configuration-contexts/:ref",
    authAsync,
    canConfigurations("read"),
    wrap(async (req, res) => res.json(await ConfigurationContexts.getConfigurationContextAsync(db, req.params.ref)))
  );
  const updateContextHandler = wrap(async (req, res) =>
    res.json(await ConfigurationContexts.updateConfigurationContextAsync(db, req.params.ref, req.body || {}, req.actor, req.ip))
  );
  router.put("/configuration-contexts/:ref", authAsync, canConfigurations("update"), updateContextHandler);
  router.patch("/configuration-contexts/:ref", authAsync, canConfigurations("update"), updateContextHandler);
  router.delete(
    "/configuration-contexts/:ref",
    authAsync,
    canConfigurations("delete"),
    wrap(async (req, res) => res.json(await ConfigurationContexts.deleteConfigurationContextAsync(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Metrics ───────────────────────────────────────────────────────────────
  router.get(
    "/metrics",
    authAsync,
    canMetrics("read"),
    wrap(async (req, res) => res.json(await Metrics.metricsSnapshotAsync(db, { tenantId: tenantOf(req), from: req.query.from, to: req.query.to })))
  );
  router.get(
    "/dashboard",
    authAsync,
    canMetrics("read"),
    wrap(async (req, res) => res.json(await Metrics.dashboardSummaryAsync(db, { tenantId: tenantOf(req), from: req.query.from, to: req.query.to })))
  );
  router.get("/health/live", wrap((_req, res) => res.json({ status: "ok", live: true })));
  router.get(
    "/health/ready",
    wrap(async (req, res) => {
      const health = await Metrics.healthCheckAsync(db, { tenantId: tenantOf(req) });
      res.status(health.ready ? 200 : 503).json(health);
    })
  );

  return router;
}

export { Validation };
