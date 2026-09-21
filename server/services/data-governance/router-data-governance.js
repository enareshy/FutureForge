// REST router for Data Governance (domains, ownership, catalogue, policies,
// configuration, dimensions, metrics and background runs). Built as a factory
// so it reuses the application's auth, authorization and error middleware.
// Mounted at /api/data-governance and /api/v1/data-governance.
import {
  constants,
  Validation,
  Domains,
  Ownership,
  Catalog,
  Policies,
  Configuration,
  Dimensions,
  Metrics,
  Jobs,
  Foundation,
} from "./index.js";

export function createDataGovernanceRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const canDomains = (action) => can("iam.data_governance.domains", action);
  const canOwnership = (action) => can("iam.data_governance.ownership", action);
  const canCatalog = (action) => can("iam.data_governance.catalog", action);
  const canPolicies = (action) => can("iam.data_governance.policies", action);
  const canConfiguration = (action) => can("iam.data_governance.configuration", action);
  const canDimensions = (action) => can("iam.data_governance.dimensions", action);
  const canMetrics = (action) => can("iam.data_governance.metrics", action);
  const canJobs = (action) => can("iam.data_governance.jobs", action);

  router.get(
    "/meta",
    auth,
    can("iam.data_governance", "read"),
    wrap((_req, res) => {
      res.json({
        source_module: constants.SOURCE_MODULE,
        vocabularies: Validation.vocabulary(),
        capabilities: {
          execution_modes: constants.EXECUTION_MODES,
          duplicate_strategies: constants.DUPLICATE_STRATEGIES,
          remediation_actions: constants.REMEDIATION_ACTIONS,
        },
      });
    })
  );

  // ── Domains ───────────────────────────────────────────────────────────────
  router.get(
    "/domains",
    auth,
    canDomains("read"),
    wrap((req, res) => res.json(Domains.listDomains(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/domains",
    auth,
    canDomains("create"),
    wrap((req, res) => res.status(201).json(Domains.createDomain(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/domains/tree",
    auth,
    canDomains("read"),
    wrap((req, res) => res.json({ items: Domains.domainTree(db, { tenantId: tenantOf(req), rootId: req.query.rootId }) }))
  );
  router.get(
    "/domains/:ref",
    auth,
    canDomains("read"),
    wrap((req, res) => res.json(Domains.getDomain(db, req.params.ref, { breadcrumb: Domains.breadcrumb(db, Domains.requireDomain(db, req.params.ref)) })))
  );
  const updateDomain = wrap((req, res) => res.json(Domains.updateDomain(db, req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/domains/:ref", auth, canDomains("update"), updateDomain);
  router.patch("/domains/:ref", auth, canDomains("update"), updateDomain);
  router.post(
    "/domains/:ref/status",
    auth,
    canDomains("execute"),
    wrap((req, res) => res.json(Domains.setDomainStatus(db, req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.delete(
    "/domains/:ref",
    auth,
    canDomains("delete"),
    wrap((req, res) => res.json(Domains.deleteDomain(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Ownership ─────────────────────────────────────────────────────────────
  router.get(
    "/ownership",
    auth,
    canOwnership("read"),
    wrap((req, res) => res.json(Ownership.listOwnership(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/ownership",
    auth,
    canOwnership("create"),
    wrap((req, res) => res.status(201).json(Ownership.createOwnership(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.patch(
    "/ownership/:id",
    auth,
    canOwnership("update"),
    wrap((req, res) => res.json(Ownership.updateOwnership(db, req.params.id, req.body || {}, req.actor)))
  );
  router.delete(
    "/ownership/:id",
    auth,
    canOwnership("delete"),
    wrap((req, res) => res.json(Ownership.deleteOwnership(db, req.params.id, req.actor, req.ip)))
  );
  router.get(
    "/ownership/resolve",
    auth,
    canOwnership("read"),
    wrap((req, res) =>
      res.json({
        items: Ownership.resolveOwnership(db, {
          tenantId: tenantOf(req),
          domainId: req.query.domainId || null,
          objectType: req.query.objectType || null,
          attributeName: req.query.attributeName || null,
          relationship: req.query.relationship || "owner",
        }),
      })
    )
  );

  // Convenience aliases: owners and stewards are ownership records filtered by
  // relationship. They exist so callers can use the vocabulary of the spec.
  const listOwners = wrap((req, res) =>
    res.json(Ownership.listOwnership(db, { ...req.query, relationship: "owner", tenantId: tenantOf(req) }))
  );
  const listStewards = wrap((req, res) =>
    res.json(Ownership.listOwnership(db, { ...req.query, relationship: "steward", tenantId: tenantOf(req) }))
  );
  router.get("/owners", auth, canOwnership("read"), listOwners);
  router.get("/stewards", auth, canOwnership("read"), listStewards);
  router.post(
    "/owners",
    auth,
    canOwnership("create"),
    wrap((req, res) =>
      res.status(201).json(Ownership.createOwnership(db, { ...(req.body || {}), relationship: "owner" }, req.actor, tenantOf(req), req.ip))
    )
  );
  router.post(
    "/stewards",
    auth,
    canOwnership("create"),
    wrap((req, res) =>
      res.status(201).json(Ownership.createOwnership(db, { ...(req.body || {}), relationship: "steward" }, req.actor, tenantOf(req), req.ip))
    )
  );

  // ── Catalogue ─────────────────────────────────────────────────────────────
  router.get(
    "/catalog",
    auth,
    canCatalog("read"),
    wrap((req, res) => res.json(Catalog.listCatalog(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/catalog",
    auth,
    canCatalog("create"),
    wrap((req, res) => res.status(201).json(Catalog.registerCatalogObject(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/catalog/:ref",
    auth,
    canCatalog("read"),
    wrap((req, res) => res.json(Catalog.getCatalog(db, req.params.ref, { includeAttributes: req.query.includeAttributes !== "false" })))
  );
  const updateCatalog = wrap((req, res) => res.json(Catalog.updateCatalogObject(db, req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/catalog/:ref", auth, canCatalog("update"), updateCatalog);
  router.patch("/catalog/:ref", auth, canCatalog("update"), updateCatalog);
  router.get(
    "/catalog/:ref/attributes",
    auth,
    canCatalog("read"),
    wrap((req, res) => res.json({ items: Catalog.listAttributes(db, Catalog.requireCatalog(db, req.params.ref).id) }))
  );
  router.post(
    "/catalog/:ref/attributes",
    auth,
    canCatalog("create"),
    wrap((req, res) => res.status(201).json(Catalog.registerAttribute(db, req.params.ref, req.body || {}, req.actor)))
  );
  router.patch(
    "/catalog/:ref/attributes/:attributeId",
    auth,
    canCatalog("update"),
    wrap((req, res) => res.json(Catalog.updateAttribute(db, req.params.ref, req.params.attributeId, req.body || {})))
  );

  // ── Policies ──────────────────────────────────────────────────────────────
  router.get(
    "/policies",
    auth,
    canPolicies("read"),
    wrap((req, res) => res.json(Policies.listPolicies(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/policies",
    auth,
    canPolicies("create"),
    wrap((req, res) => res.status(201).json(Policies.createPolicy(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/policies/:ref",
    auth,
    canPolicies("read"),
    wrap((req, res) => res.json(Policies.getPolicy(db, req.params.ref, { includeVersions: req.query.includeVersions === "true" })))
  );
  const updatePolicy = wrap((req, res) => res.json(Policies.updatePolicy(db, req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/policies/:ref", auth, canPolicies("update"), updatePolicy);
  router.patch("/policies/:ref", auth, canPolicies("update"), updatePolicy);
  router.post(
    "/policies/:ref/status",
    auth,
    canPolicies("execute"),
    wrap((req, res) => res.json(Policies.setPolicyStatus(db, req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.get(
    "/policies/:ref/versions",
    auth,
    canPolicies("read"),
    wrap((req, res) => res.json({ items: Policies.listPolicyVersions(db, req.params.ref) }))
  );
  router.post(
    "/policies/:ref/activate",
    auth,
    canPolicies("execute"),
    wrap((req, res) => res.json(Policies.setPolicyStatus(db, req.params.ref, "active", req.actor, req.ip)))
  );
  router.post(
    "/policies/:ref/retire",
    auth,
    canPolicies("execute"),
    wrap((req, res) => res.json(Policies.setPolicyStatus(db, req.params.ref, "retired", req.actor, req.ip)))
  );
  router.post(
    "/policies/:ref/suspend",
    auth,
    canPolicies("execute"),
    wrap((req, res) => res.json(Policies.setPolicyStatus(db, req.params.ref, "suspended", req.actor, req.ip)))
  );

  // ── Configuration & dimensions ────────────────────────────────────────────
  router.get(
    "/configuration",
    auth,
    canConfiguration("read"),
    wrap((req, res) => res.json(Configuration.listConfig(db, tenantOf(req))))
  );
  router.put(
    "/configuration",
    auth,
    canConfiguration("update"),
    wrap((req, res) => {
      const body = req.body || {};
      const results = {};
      for (const [key, value] of Object.entries(body)) {
        results[key] = Configuration.setConfig(db, tenantOf(req), key, value, req.actor, req.ip);
      }
      res.json({ updated: results, configuration: Configuration.listConfig(db, tenantOf(req)) });
    })
  );

  router.get(
    "/dimensions",
    auth,
    canDimensions("read"),
    wrap((req, res) => res.json({ items: Dimensions.listDimensions(db, tenantOf(req), { status: req.query.status }) }))
  );
  router.put(
    "/dimensions/:code",
    auth,
    canDimensions("update"),
    wrap((req, res) => res.json(Dimensions.upsertDimension(db, tenantOf(req), req.params.code, req.body || {}, req.actor, req.ip)))
  );

  // ── Metrics, health and background runs ───────────────────────────────────
  router.get(
    "/metrics",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Metrics.metricsSnapshot(db, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/health",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Metrics.healthCheck(db, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/jobs",
    auth,
    canJobs("read"),
    wrap((req, res) => res.json({ items: Jobs.listQualityJobs(db, { tenantId: tenantOf(req), status: req.query.status, limit: req.query.limit }) }))
  );
  router.post(
    "/jobs/evaluate",
    auth,
    canJobs("execute"),
    wrap((req, res) =>
      res.status(202).json(
        Jobs.submitBatchEvaluation(db, {
          tenantId: tenantOf(req),
          objectTypes: req.body?.object_types || [],
          objectIds: req.body?.object_ids || null,
          actor: req.actor,
          ip: req.ip,
        })
      )
    )
  );
  router.post(
    "/jobs/duplicates",
    auth,
    canJobs("execute"),
    wrap((req, res) =>
      res.status(202).json(
        Jobs.submitDuplicateScan(db, { tenantId: tenantOf(req), objectType: req.body?.object_type, actor: req.actor, ip: req.ip })
      )
    )
  );

  return router;
}

export { Foundation };
