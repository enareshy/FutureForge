// REST router for the Effectivity & Versioning Kernel. Built as a factory so it
// can reuse the application's auth, authorization and error-wrapping
// middleware. Mounted at /api/versioning and /api/v1/versioning.
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

export function createVersioningRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const canRevisions = (action) => can("iam.versioning.revisions", action);
  const canVersions = (action) => can("iam.versioning.versions", action);
  const canEffectivities = (action) => can("iam.versioning.effectivities", action);
  const canResolve = (action) => can("iam.versioning.resolve", action);
  const canBaselines = (action) => can("iam.versioning.baselines", action);
  const canSnapshots = (action) => can("iam.versioning.snapshots", action);
  const canVariants = (action) => can("iam.versioning.variants", action);
  const canConfigurations = (action) => can("iam.versioning.configurations", action);
  const canPolicies = (action) => can("iam.versioning.policies", action);
  const canMetrics = (action) => can("iam.versioning.metrics", action);

  router.get(
    "/meta",
    auth,
    can("iam.versioning", "read"),
    wrap((_req, res) => {
      res.json({
        ...Foundation.vocabulary(),
        effectivity_types: Effectivities.listEffectivityTypes(db),
      });
    })
  );

  router.get(
    "/effectivity-types",
    auth,
    can("iam.versioning", "read"),
    wrap((req, res) => res.json({ items: Effectivities.listEffectivityTypes(db, { dimension: req.query.dimension, status: req.query.status }) }))
  );

  // ── Revisions ─────────────────────────────────────────────────────────────
  router.get(
    "/revisions",
    auth,
    canRevisions("read"),
    wrap((req, res) => res.json(Revisions.listRevisions(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/revisions",
    auth,
    canRevisions("create"),
    wrap((req, res) => res.status(201).json(Revisions.createRevision(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/revisions/:ref",
    auth,
    canRevisions("read"),
    wrap((req, res) => res.json(Revisions.getRevision(db, req.params.ref, { objectType: req.query.objectType })))
  );
  const updateRevisionHandler = wrap((req, res) =>
    res.json(Revisions.updateRevision(db, req.params.ref, req.body || {}, req.actor, req.ip))
  );
  router.put("/revisions/:ref", auth, canRevisions("update"), updateRevisionHandler);
  router.patch("/revisions/:ref", auth, canRevisions("update"), updateRevisionHandler);
  router.delete(
    "/revisions/:ref",
    auth,
    canRevisions("delete"),
    wrap((req, res) => res.json(Revisions.deleteRevision(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/revisions/:ref/activate",
    auth,
    canRevisions("execute"),
    wrap((req, res) => res.json(Revisions.activateRevision(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/revisions/:ref/supersede",
    auth,
    canRevisions("execute"),
    wrap((req, res) => res.json(Revisions.supersedeRevision(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/revisions/:ref/retire",
    auth,
    canRevisions("execute"),
    wrap((req, res) => res.json(Revisions.retireRevision(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/revisions/:ref/default",
    auth,
    canRevisions("execute"),
    wrap((req, res) => res.json(Revisions.setDefaultRevision(db, req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/revisions/:ref/history",
    auth,
    canRevisions("read"),
    wrap((req, res) => res.json(Revisions.revisionHistory(db, req.params.ref, { limit: req.query.limit })))
  );
  router.get(
    "/revisions/:ref/compare/:other",
    auth,
    canRevisions("read"),
    wrap((req, res) => res.json(Revisions.compareRevisions(db, req.params.ref, req.params.other)))
  );
  router.get(
    "/revisions/:ref/relationships",
    auth,
    canRevisions("read"),
    wrap((req, res) => res.json({ items: Revisions.listRelationships(db, req.params.ref, { direction: req.query.direction, type: req.query.type }) }))
  );
  router.post(
    "/revisions/:ref/relationships",
    auth,
    canRevisions("update"),
    wrap((req, res) => res.status(201).json(Revisions.createRelationship(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.delete(
    "/revisions/:ref/relationships/:id",
    auth,
    canRevisions("update"),
    wrap((req, res) => res.json(Revisions.deleteRelationship(db, req.params.ref, req.params.id, req.actor, req.ip)))
  );

  // ── Versions ──────────────────────────────────────────────────────────────
  router.get(
    "/revisions/:ref/versions",
    auth,
    canVersions("read"),
    wrap((req, res) => res.json(Versions.listVersions(db, req.params.ref, { status: req.query.status })))
  );
  router.post(
    "/revisions/:ref/versions",
    auth,
    canVersions("create"),
    wrap((req, res) => res.status(201).json(Versions.createVersion(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/versions/:ref",
    auth,
    canVersions("read"),
    wrap((req, res) => res.json(Versions.getVersion(db, req.params.ref)))
  );
  const updateVersionHandler = wrap((req, res) =>
    res.json(Versions.updateVersion(db, req.params.ref, req.body || {}, req.actor, req.ip))
  );
  router.put("/versions/:ref", auth, canVersions("update"), updateVersionHandler);
  router.patch("/versions/:ref", auth, canVersions("update"), updateVersionHandler);
  router.delete(
    "/versions/:ref",
    auth,
    canVersions("delete"),
    wrap((req, res) => res.json(Versions.deleteVersion(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/versions/:ref/activate",
    auth,
    canVersions("execute"),
    wrap((req, res) => res.json(Versions.activateVersion(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/versions/:ref/supersede",
    auth,
    canVersions("execute"),
    wrap((req, res) => res.json(Versions.supersedeVersion(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/versions/:ref/default",
    auth,
    canVersions("execute"),
    wrap((req, res) => res.json(Versions.setDefaultVersion(db, req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/versions/:ref/history",
    auth,
    canVersions("read"),
    wrap((req, res) => res.json(Versions.versionHistory(db, req.params.ref, { limit: req.query.limit })))
  );
  router.get(
    "/versions/:ref/compare/:other",
    auth,
    canVersions("read"),
    wrap((req, res) => res.json(Versions.compareVersions(db, req.params.ref, req.params.other)))
  );

  // ── Effectivities ─────────────────────────────────────────────────────────
  router.get(
    "/effectivities",
    auth,
    canEffectivities("read"),
    wrap((req, res) => res.json(Effectivities.listDefinitions(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/effectivities",
    auth,
    canEffectivities("create"),
    wrap((req, res) => res.status(201).json(Effectivities.createDefinition(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.post(
    "/effectivities/validate",
    auth,
    canEffectivities("read"),
    wrap((req, res) => res.json(Effectivities.validateDefinition(db, req.body || {})))
  );
  router.get(
    "/effectivities/:ref",
    auth,
    canEffectivities("read"),
    wrap((req, res) => res.json(Effectivities.getDefinition(db, req.params.ref)))
  );
  const updateEffectivityHandler = wrap((req, res) =>
    res.json(Effectivities.updateDefinition(db, req.params.ref, req.body || {}, req.actor, req.ip))
  );
  router.put("/effectivities/:ref", auth, canEffectivities("update"), updateEffectivityHandler);
  router.patch("/effectivities/:ref", auth, canEffectivities("update"), updateEffectivityHandler);
  router.delete(
    "/effectivities/:ref",
    auth,
    canEffectivities("delete"),
    wrap((req, res) => res.json(Effectivities.deleteDefinition(db, req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/effectivities/:ref/assignments",
    auth,
    canEffectivities("read"),
    wrap((req, res) => {
      const definition = Effectivities.getDefinition(db, req.params.ref);
      res.json({ items: Effectivities.listAssignments(db, { definitionId: definition.id, ...req.query, tenantId: tenantOf(req) }) });
    })
  );
  router.post(
    "/effectivities/:ref/assignments",
    auth,
    canEffectivities("update"),
    wrap((req, res) => res.status(201).json(Effectivities.createAssignment(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/assignments",
    auth,
    canEffectivities("read"),
    wrap((req, res) => res.json({ items: Effectivities.listAssignments(db, { ...req.query, tenantId: tenantOf(req) }) }))
  );
  router.delete(
    "/assignments/:ref",
    auth,
    canEffectivities("delete"),
    wrap((req, res) => res.json(Effectivities.deleteAssignment(db, req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/effectivity/inspect",
    auth,
    canEffectivities("read"),
    wrap((req, res) => res.json(Effectivities.inspectObject(db, { objectType: req.query.objectType, objectId: req.query.objectId, asOf: req.query.asOf })))
  );

  // ── Resolution ────────────────────────────────────────────────────────────
  router.post(
    "/effectivity/resolve",
    auth,
    canResolve("execute"),
    wrap((req, res) => {
      const result = Engine.EffectivityResolver.resolve(db, req.body || {}, {
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
    auth,
    canResolve("execute"),
    wrap((req, res) => {
      const result = Engine.EffectivityResolver.resolveBulk(db, req.body || {}, {
        actor: req.actor,
        tenantId: tenantOf(req),
        correlationId: req.get("X-Correlation-Id") || null,
      });
      res.json(result);
    })
  );
  router.post(
    "/effectivity/validate",
    auth,
    canEffectivities("read"),
    wrap((req, res) => res.json(Effectivities.validateDefinition(db, req.body || {})))
  );

  // ── Resolution policies ───────────────────────────────────────────────────
  router.get(
    "/resolution-policies",
    auth,
    canPolicies("read"),
    wrap((req, res) => res.json({ items: Policies.listResolutionPolicies(db, { status: req.query.status, tenantId: tenantOf(req) }) }))
  );
  router.post(
    "/resolution-policies",
    auth,
    canPolicies("create"),
    wrap((req, res) => res.status(201).json(Policies.createResolutionPolicy(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/resolution-policies/:ref",
    auth,
    canPolicies("read"),
    wrap((req, res) => res.json(Policies.getResolutionPolicy(db, req.params.ref)))
  );
  const updatePolicyHandler = wrap((req, res) =>
    res.json(Policies.updateResolutionPolicy(db, req.params.ref, req.body || {}, req.actor, req.ip))
  );
  router.put("/resolution-policies/:ref", auth, canPolicies("update"), updatePolicyHandler);
  router.patch("/resolution-policies/:ref", auth, canPolicies("update"), updatePolicyHandler);
  router.delete(
    "/resolution-policies/:ref",
    auth,
    canPolicies("delete"),
    wrap((req, res) => res.json(Policies.deleteResolutionPolicy(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Baselines ─────────────────────────────────────────────────────────────
  router.get(
    "/baselines",
    auth,
    canBaselines("read"),
    wrap((req, res) => res.json(Baselines.listBaselines(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/baselines",
    auth,
    canBaselines("create"),
    wrap((req, res) => res.status(201).json(Baselines.createBaseline(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/baselines/:ref",
    auth,
    canBaselines("read"),
    wrap((req, res) => res.json(Baselines.getBaseline(db, req.params.ref)))
  );
  router.delete(
    "/baselines/:ref",
    auth,
    canBaselines("delete"),
    wrap((req, res) => res.json(Baselines.deleteBaseline(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/baselines/:ref/objects",
    auth,
    canBaselines("update"),
    wrap((req, res) => res.json(Baselines.addBaselineObjects(db, req.params.ref, req.body?.objects || [], req.actor, req.ip)))
  );
  router.delete(
    "/baselines/:ref/objects/:objectType/:objectId",
    auth,
    canBaselines("update"),
    wrap((req, res) => res.json(Baselines.removeBaselineObject(db, req.params.ref, req.params.objectType, req.params.objectId, req.actor, req.ip)))
  );
  router.post(
    "/baselines/:ref/freeze",
    auth,
    canBaselines("execute"),
    wrap((req, res) => res.json(Baselines.freezeBaseline(db, req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/baselines/:ref/compare/:other",
    auth,
    canBaselines("read"),
    wrap((req, res) => res.json(Baselines.compareBaselines(db, req.params.ref, req.params.other)))
  );
  router.get(
    "/baselines/:ref/restore",
    auth,
    canBaselines("read"),
    wrap((req, res) => res.json(Baselines.restoreBaseline(db, req.params.ref)))
  );

  // ── Snapshots ─────────────────────────────────────────────────────────────
  router.get(
    "/snapshots",
    auth,
    canSnapshots("read"),
    wrap((req, res) => res.json(Snapshots.listSnapshots(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/snapshots",
    auth,
    canSnapshots("create"),
    wrap((req, res) => res.status(201).json(Snapshots.createSnapshot(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/snapshots/:ref",
    auth,
    canSnapshots("read"),
    wrap((req, res) => res.json(Snapshots.getSnapshot(db, req.params.ref)))
  );
  router.delete(
    "/snapshots/:ref",
    auth,
    canSnapshots("delete"),
    wrap((req, res) => res.json(Snapshots.deleteSnapshot(db, req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/snapshots/:ref/archive",
    auth,
    canSnapshots("update"),
    wrap((req, res) => res.json(Snapshots.archiveSnapshot(db, req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/snapshots/:ref/compare/:other",
    auth,
    canSnapshots("read"),
    wrap((req, res) => res.json(Snapshots.compareSnapshots(db, req.params.ref, req.params.other)))
  );
  router.get(
    "/snapshots/:ref/reconstruct",
    auth,
    canSnapshots("read"),
    wrap((req, res) => res.json(Snapshots.reconstructSnapshot(db, req.params.ref)))
  );

  // ── Variants ──────────────────────────────────────────────────────────────
  router.get(
    "/variants",
    auth,
    canVariants("read"),
    wrap((req, res) => res.json(Variants.listVariants(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/variants",
    auth,
    canVariants("create"),
    wrap((req, res) => res.status(201).json(Variants.createVariant(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/variants/:ref",
    auth,
    canVariants("read"),
    wrap((req, res) => res.json(Variants.getVariant(db, req.params.ref)))
  );
  const updateVariantHandler = wrap((req, res) =>
    res.json(Variants.updateVariant(db, req.params.ref, req.body || {}, req.actor, req.ip))
  );
  router.put("/variants/:ref", auth, canVariants("update"), updateVariantHandler);
  router.patch("/variants/:ref", auth, canVariants("update"), updateVariantHandler);
  router.post(
    "/variants/:ref/options",
    auth,
    canVariants("update"),
    wrap((req, res) => res.status(201).json(Variants.addOption(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/variants/:ref/rules",
    auth,
    canVariants("update"),
    wrap((req, res) => res.status(201).json(Variants.addRule(db, req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/variants/:ref/evaluate",
    auth,
    canVariants("read"),
    wrap((req, res) => res.json(Variants.evaluateVariant(db, req.params.ref, req.body || {})))
  );
  router.get(
    "/variants/:ref/history",
    auth,
    canVariants("read"),
    wrap((req, res) => res.json(Variants.variantHistory(db, req.params.ref, { limit: req.query.limit })))
  );

  // ── Configuration contexts ────────────────────────────────────────────────
  router.get(
    "/configuration-contexts",
    auth,
    canConfigurations("read"),
    wrap((req, res) => res.json(ConfigurationContexts.listConfigurationContexts(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/configuration-contexts",
    auth,
    canConfigurations("create"),
    wrap((req, res) => res.status(201).json(ConfigurationContexts.createConfigurationContext(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/configuration-contexts/:ref",
    auth,
    canConfigurations("read"),
    wrap((req, res) => res.json(ConfigurationContexts.getConfigurationContext(db, req.params.ref)))
  );
  const updateContextHandler = wrap((req, res) =>
    res.json(ConfigurationContexts.updateConfigurationContext(db, req.params.ref, req.body || {}, req.actor, req.ip))
  );
  router.put("/configuration-contexts/:ref", auth, canConfigurations("update"), updateContextHandler);
  router.patch("/configuration-contexts/:ref", auth, canConfigurations("update"), updateContextHandler);
  router.delete(
    "/configuration-contexts/:ref",
    auth,
    canConfigurations("delete"),
    wrap((req, res) => res.json(ConfigurationContexts.deleteConfigurationContext(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Metrics ───────────────────────────────────────────────────────────────
  router.get(
    "/metrics",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Metrics.metricsSnapshot(db, { tenantId: tenantOf(req), from: req.query.from, to: req.query.to })))
  );
  router.get(
    "/dashboard",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Metrics.dashboardSummary(db, { tenantId: tenantOf(req), from: req.query.from, to: req.query.to })))
  );
  router.get("/health/live", wrap((_req, res) => res.json({ status: "ok", live: true })));
  router.get(
    "/health/ready",
    wrap((req, res) => {
      const health = Metrics.healthCheck(db, { tenantId: tenantOf(req) });
      res.status(health.ready ? 200 : 503).json(health);
    })
  );

  return router;
}

export { Validation };
