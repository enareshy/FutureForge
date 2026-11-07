// REST router for Data Governance (domains, ownership, catalogue, policies,
// configuration, dimensions, metrics and background runs). Built as a factory
// so it reuses the application's async auth, authorization and error middleware.
// Mounted at /api/data-governance and /api/v1/data-governance.
//
// Every route is authorized against an IAM permission resource. The whole
// request path runs on the async `pg` layer so a slow query never stalls the
// process; only the pure `/meta` handler stays synchronous.
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

export function createDataGovernanceRouter({ express, db, auth, authAsync, can, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const guard = authAsync || auth;
  const gate = canAsync || can;

  const canDomains = (action) => gate("iam.data_governance.domains", action);
  const canOwnership = (action) => gate("iam.data_governance.ownership", action);
  const canCatalog = (action) => gate("iam.data_governance.catalog", action);
  const canPolicies = (action) => gate("iam.data_governance.policies", action);
  const canConfiguration = (action) => gate("iam.data_governance.configuration", action);
  const canDimensions = (action) => gate("iam.data_governance.dimensions", action);
  const canMetrics = (action) => gate("iam.data_governance.metrics", action);
  const canJobs = (action) => gate("iam.data_governance.jobs", action);

  router.get(
    "/meta",
    guard,
    gate("iam.data_governance", "read"),
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
    guard,
    canDomains("read"),
    wrap(async (req, res) => res.json(await Domains.listDomainsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/domains",
    guard,
    canDomains("create"),
    wrap(async (req, res) => res.status(201).json(await Domains.createDomainAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/domains/tree",
    guard,
    canDomains("read"),
    wrap(async (req, res) => res.json({ items: await Domains.domainTreeAsync(db, { tenantId: tenantOf(req), rootId: req.query.rootId }) }))
  );
  router.get(
    "/domains/:ref",
    guard,
    canDomains("read"),
    wrap(async (req, res) => {
      const row = await Domains.requireDomainAsync(db, req.params.ref);
      res.json(await Domains.getDomainAsync(db, req.params.ref, { breadcrumb: await Domains.breadcrumbAsync(db, row) }));
    })
  );
  const updateDomain = wrap(async (req, res) => res.json(await Domains.updateDomainAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/domains/:ref", guard, canDomains("update"), updateDomain);
  router.patch("/domains/:ref", guard, canDomains("update"), updateDomain);
  router.post(
    "/domains/:ref/status",
    guard,
    canDomains("execute"),
    wrap(async (req, res) => res.json(await Domains.setDomainStatusAsync(db, req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.delete(
    "/domains/:ref",
    guard,
    canDomains("delete"),
    wrap(async (req, res) => res.json(await Domains.deleteDomainAsync(db, req.params.ref, req.actor, req.ip)))
  );

  // ── Ownership ─────────────────────────────────────────────────────────────
  router.get(
    "/ownership",
    guard,
    canOwnership("read"),
    wrap(async (req, res) => res.json(await Ownership.listOwnershipAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/ownership",
    guard,
    canOwnership("create"),
    wrap(async (req, res) => res.status(201).json(await Ownership.createOwnershipAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.patch(
    "/ownership/:id",
    guard,
    canOwnership("update"),
    wrap(async (req, res) => res.json(await Ownership.updateOwnershipAsync(db, req.params.id, req.body || {}, req.actor)))
  );
  router.delete(
    "/ownership/:id",
    guard,
    canOwnership("delete"),
    wrap(async (req, res) => res.json(await Ownership.deleteOwnershipAsync(db, req.params.id, req.actor, req.ip)))
  );
  router.get(
    "/ownership/resolve",
    guard,
    canOwnership("read"),
    wrap(async (req, res) =>
      res.json({
        items: await Ownership.resolveOwnershipAsync(db, {
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
  const listOwners = wrap(async (req, res) =>
    res.json(await Ownership.listOwnershipAsync(db, { ...req.query, relationship: "owner", tenantId: tenantOf(req) }))
  );
  const listStewards = wrap(async (req, res) =>
    res.json(await Ownership.listOwnershipAsync(db, { ...req.query, relationship: "steward", tenantId: tenantOf(req) }))
  );
  router.get("/owners", guard, canOwnership("read"), listOwners);
  router.get("/stewards", guard, canOwnership("read"), listStewards);
  router.post(
    "/owners",
    guard,
    canOwnership("create"),
    wrap(async (req, res) =>
      res.status(201).json(await Ownership.createOwnershipAsync(db, { ...(req.body || {}), relationship: "owner" }, req.actor, tenantOf(req), req.ip))
    )
  );
  router.post(
    "/stewards",
    guard,
    canOwnership("create"),
    wrap(async (req, res) =>
      res.status(201).json(await Ownership.createOwnershipAsync(db, { ...(req.body || {}), relationship: "steward" }, req.actor, tenantOf(req), req.ip))
    )
  );

  // ── Catalogue ─────────────────────────────────────────────────────────────
  router.get(
    "/catalog",
    guard,
    canCatalog("read"),
    wrap(async (req, res) => res.json(await Catalog.listCatalogAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/catalog",
    guard,
    canCatalog("create"),
    wrap(async (req, res) => res.status(201).json(await Catalog.registerCatalogObjectAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/catalog/:ref",
    guard,
    canCatalog("read"),
    wrap(async (req, res) => res.json(await Catalog.getCatalogAsync(db, req.params.ref, { includeAttributes: req.query.includeAttributes !== "false" })))
  );
  const updateCatalog = wrap(async (req, res) => res.json(await Catalog.updateCatalogObjectAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/catalog/:ref", guard, canCatalog("update"), updateCatalog);
  router.patch("/catalog/:ref", guard, canCatalog("update"), updateCatalog);
  router.get(
    "/catalog/:ref/attributes",
    guard,
    canCatalog("read"),
    wrap(async (req, res) => {
      const row = await Catalog.requireCatalogAsync(db, req.params.ref);
      res.json({ items: await Catalog.listAttributesAsync(db, row.id) });
    })
  );
  router.post(
    "/catalog/:ref/attributes",
    guard,
    canCatalog("create"),
    wrap(async (req, res) => res.status(201).json(await Catalog.registerAttributeAsync(db, req.params.ref, req.body || {}, req.actor)))
  );
  router.patch(
    "/catalog/:ref/attributes/:attributeId",
    guard,
    canCatalog("update"),
    wrap(async (req, res) => res.json(await Catalog.updateAttributeAsync(db, req.params.ref, req.params.attributeId, req.body || {})))
  );

  // ── Policies ──────────────────────────────────────────────────────────────
  router.get(
    "/policies",
    guard,
    canPolicies("read"),
    wrap(async (req, res) => res.json(await Policies.listPoliciesAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/policies",
    guard,
    canPolicies("create"),
    wrap(async (req, res) => res.status(201).json(await Policies.createPolicyAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/policies/:ref",
    guard,
    canPolicies("read"),
    wrap(async (req, res) => res.json(await Policies.getPolicyAsync(db, req.params.ref, { includeVersions: req.query.includeVersions === "true" })))
  );
  const updatePolicy = wrap(async (req, res) => res.json(await Policies.updatePolicyAsync(db, req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/policies/:ref", guard, canPolicies("update"), updatePolicy);
  router.patch("/policies/:ref", guard, canPolicies("update"), updatePolicy);
  router.post(
    "/policies/:ref/status",
    guard,
    canPolicies("execute"),
    wrap(async (req, res) => res.json(await Policies.setPolicyStatusAsync(db, req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.get(
    "/policies/:ref/versions",
    guard,
    canPolicies("read"),
    wrap(async (req, res) => res.json({ items: await Policies.listPolicyVersionsAsync(db, req.params.ref) }))
  );
  router.post(
    "/policies/:ref/activate",
    guard,
    canPolicies("execute"),
    wrap(async (req, res) => res.json(await Policies.setPolicyStatusAsync(db, req.params.ref, "active", req.actor, req.ip)))
  );
  router.post(
    "/policies/:ref/retire",
    guard,
    canPolicies("execute"),
    wrap(async (req, res) => res.json(await Policies.setPolicyStatusAsync(db, req.params.ref, "retired", req.actor, req.ip)))
  );
  router.post(
    "/policies/:ref/suspend",
    guard,
    canPolicies("execute"),
    wrap(async (req, res) => res.json(await Policies.setPolicyStatusAsync(db, req.params.ref, "suspended", req.actor, req.ip)))
  );

  // ── Configuration & dimensions ────────────────────────────────────────────
  router.get(
    "/configuration",
    guard,
    canConfiguration("read"),
    wrap(async (req, res) => res.json(await Configuration.listConfigAsync(db, tenantOf(req))))
  );
  router.put(
    "/configuration",
    guard,
    canConfiguration("update"),
    wrap(async (req, res) => {
      const body = req.body || {};
      const results = {};
      for (const [key, value] of Object.entries(body)) {
        results[key] = await Configuration.setConfigAsync(db, tenantOf(req), key, value, req.actor, req.ip);
      }
      res.json({ updated: results, configuration: await Configuration.listConfigAsync(db, tenantOf(req)) });
    })
  );

  router.get(
    "/dimensions",
    guard,
    canDimensions("read"),
    wrap(async (req, res) => res.json({ items: await Dimensions.listDimensionsAsync(db, tenantOf(req), { status: req.query.status }) }))
  );
  router.put(
    "/dimensions/:code",
    guard,
    canDimensions("update"),
    wrap(async (req, res) => res.json(await Dimensions.upsertDimensionAsync(db, tenantOf(req), req.params.code, req.body || {}, req.actor, req.ip)))
  );

  // ── Metrics, health and background runs ───────────────────────────────────
  router.get(
    "/metrics",
    guard,
    canMetrics("read"),
    wrap(async (req, res) => res.json(await Metrics.metricsSnapshotAsync(db, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/health",
    guard,
    canMetrics("read"),
    wrap(async (req, res) => res.json(await Metrics.healthCheckAsync(db, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/jobs",
    guard,
    canJobs("read"),
    wrap(async (req, res) => res.json({ items: await Jobs.listQualityJobsAsync(db, { tenantId: tenantOf(req), status: req.query.status, limit: req.query.limit }) }))
  );
  router.post(
    "/jobs/evaluate",
    guard,
    canJobs("execute"),
    wrap(async (req, res) =>
      res.status(202).json(
        await Jobs.submitBatchEvaluationAsync(db, {
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
    guard,
    canJobs("execute"),
    wrap(async (req, res) =>
      res.status(202).json(
        await Jobs.submitDuplicateScanAsync(db, { tenantId: tenantOf(req), objectType: req.body?.object_type, actor: req.actor, ip: req.ip })
      )
    )
  );

  return router;
}

export { Foundation };
