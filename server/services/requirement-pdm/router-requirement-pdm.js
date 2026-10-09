// REST router for the Requirement -> PDM integration. Built as a factory so it
// reuses the application's auth, authorization and error middleware. Mounted at
// /api/requirement-pdm and /api/v1/requirement-pdm (mirrors
// server/services/requirements/router-requirements.js).
//
// Every data route and bootstrap use `authAsync`/`canAsync` + `*Async` service
// twins, while the pure-vocabulary `/meta` route stays on the sync `auth`/`can`
// path. A route uses either the sync or the async layer, never both.
import { Constants, Foundation, Configuration, Targets, Allocations, Changes, ChangeInitiation, Products, BomProjection, Documents, Compatibility, Impact, PlmSync, PlmMetrics, Synchronization, Jobs, Integration } from "./index.js";

const R = Constants.REQUIREMENT_PDM_RESOURCES;

export function createRequirementPdmRouter({ express, db, auth, can, authAsync, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const canOverviewAsync = (a) => canAsync(R.overview, a);
  const canAllocationsAsync = (a) => canAsync(R.allocations, a);
  const canCoverageAsync = (a) => canAsync(R.coverage, a);
  const canCompatibilityAsync = (a) => canAsync(R.compatibility, a);
  const canImpactAsync = (a) => canAsync(R.impact, a);
  const canSynchronizationAsync = (a) => canAsync(R.synchronization, a);
  const canPlmAsync = (a) => canAsync(R.plm, a);
  const canChangesAsync = (a) => canAsync(R.changes, a);
  const canChangeInitiationAsync = (a) => canAsync(R.changeInitiation, a);
  const canDocumentsAsync = (a) => canAsync(R.documents, a);
  const canMetricsAsync = (a) => canAsync(R.metrics, a);
  const canAdminAsync = (a) => canAsync(R.admin, a);
  const canAdmin = (a) => can(R.admin, a);

  // ── Meta, health ────────────────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
    can(R.overview, "read"),
    wrap((_req, res) => res.json(Foundation.requirementPdmMeta()))
  );
  router.get("/health", authAsync, canOverviewAsync("read"), wrap(async (req, res) => res.json(await Foundation.requirementPdmHealthAsync(db, tenantOf(req)))));

  // ── Configuration (sync vocabulary + platform config store) ─────────────
  router.get("/config", auth, canAdmin("read"), wrap((req, res) => res.json(Configuration.listConfig(db, tenantOf(req)))));
  router.put(
    "/config/:key",
    auth,
    canAdmin("update"),
    wrap((req, res) => res.json(Configuration.setConfig(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip)))
  );

  // ── Bootstrap ───────────────────────────────────────────────────────────
  router.post("/foundation/ensure", authAsync, canAdminAsync("execute"), wrap(async (_req, res) => res.json(await Foundation.ensureRequirementPdmFoundationAsync(db))));

  // ── Targets ─────────────────────────────────────────────────────────────
  router.get(
    "/targets",
    auth,
    can(R.allocations, "read"),
    wrap((_req, res) => {
      const meta = Foundation.requirementPdmMeta();
      return res.json({ target_types: meta.target_types, node_types: meta.node_types });
    })
  );
  router.get(
    "/targets/resolve",
    authAsync,
    canAllocationsAsync("read"),
    wrap(async (req, res) => res.json(await Targets.requireTargetAsync(db, tenantOf(req), req.query.target_type || req.query.targetType, req.query.target_id ?? req.query.targetId ?? req.query.ref)))
  );

  // ── Allocations ─────────────────────────────────────────────────────────
  router.get(
    "/allocations",
    authAsync,
    canAllocationsAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Allocations.listAllocationsAsync(db, tenantOf(req), {
          requirementId: req.query.requirement_id ?? req.query.requirementId,
          relationship_type: req.query.relationship_type ?? req.query.relationshipType,
          target_type: req.query.target_type ?? req.query.targetType,
          target_id: req.query.target_id ?? req.query.targetId,
          status: req.query.status,
          page: req.query.page,
          pageSize: req.query.pageSize ?? req.query.page_size,
          withTargets: req.query.withTargets !== "false",
        })
      )
    )
  );
  router.post(
    "/allocations",
    authAsync,
    canAllocationsAsync("create"),
    wrap(async (req, res) => {
      const result = await Allocations.createAllocationAsync(db, tenantOf(req), req.body, req.actor, req.ip);
      res.status(201).json({ ...result.allocation, created: result.created, reactivated: result.reactivated });
    })
  );
  router.get("/allocations/:ref", authAsync, canAllocationsAsync("read"), wrap(async (req, res) => res.json(await Allocations.getAllocationAsync(db, tenantOf(req), req.params.ref))));
  router.delete("/allocations/:ref", authAsync, canAllocationsAsync("delete"), wrap(async (req, res) => res.json(await Allocations.removeAllocationAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/allocations/:ref/check", authAsync, canCompatibilityAsync("execute"), wrap(async (req, res) => res.json(await Compatibility.checkAllocationAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));
  router.post("/allocations/:ref/synchronize", authAsync, canSynchronizationAsync("execute"), wrap(async (req, res) => res.json(await Synchronization.synchronizeAllocationAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));

  // ── Requirement-scoped views ────────────────────────────────────────────
  router.get("/requirements/:ref/allocations", authAsync, canAllocationsAsync("read"), wrap(async (req, res) => res.json(await Allocations.listRequirementAllocationsAsync(db, tenantOf(req), req.params.ref))));
  router.get("/requirements/:ref/coverage", authAsync, canCoverageAsync("read"), wrap(async (req, res) => res.json(await Allocations.allocationCoverageAsync(db, tenantOf(req), req.params.ref))));
  router.get("/requirements/:ref/compatibilities", authAsync, canCompatibilityAsync("read"), wrap(async (req, res) => res.json(await Compatibility.checkRequirementCompatibilitiesAsync(db, tenantOf(req), req.params.ref, req.query, req.actor, req.ip))));

  // ── Requirement -> Product / Lifecycle projections ──────────────────────
  router.get(
    "/requirements/:ref/products",
    authAsync,
    canAllocationsAsync("read"),
    wrap(async (req, res) =>
      res.json(await Products.listRequirementProductsAsync(db, tenantOf(req), req.params.ref, { status: req.query.status }))
    )
  );
  router.get(
    "/products/:ref/lifecycle",
    authAsync,
    canPlmAsync("read"),
    wrap(async (req, res) => res.json(await Products.productLifecycleAsync(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/products/:ref/requirements",
    authAsync,
    canPlmAsync("read"),
    wrap(async (req, res) =>
      res.json(await Products.listProductRequirementsAsync(db, tenantOf(req), req.params.ref, { status: req.query.status }))
    )
  );

  // ── Requirement -> EBOM / MBOM / BOP structures ─────────────────────────
  router.get(
    "/requirements/:ref/structures",
    authAsync,
    canPlmAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await BomProjection.listRequirementStructuresAsync(db, tenantOf(req), req.params.ref, {
          status: req.query.status,
          asOf: req.query.as_of ?? req.query.asOf,
          variant: req.query.variant ?? req.query.variant_code ?? req.query.variantCode,
          configuration: req.query.configuration ?? req.query.configuration_context ?? req.query.configurationContext,
          includeStructure: req.query.include_structure !== "false",
        })
      )
    )
  );
  router.get(
    "/requirements/:ref/structure-coverage",
    authAsync,
    canPlmAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await BomProjection.structureCoverageAsync(db, tenantOf(req), req.params.ref, {
          asOf: req.query.as_of ?? req.query.asOf,
          variant: req.query.variant ?? req.query.variant_code ?? req.query.variantCode,
          configuration: req.query.configuration ?? req.query.configuration_context ?? req.query.configurationContext,
        })
      )
    )
  );
  router.get(
    "/structures/:ref/trace",
    authAsync,
    canPlmAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await BomProjection.bomRevisionStructureAsync(db, tenantOf(req), req.params.ref, {
          asOf: req.query.as_of ?? req.query.asOf,
          variant: req.query.variant ?? req.query.variant_code ?? req.query.variantCode,
          configuration: req.query.configuration ?? req.query.configuration_context ?? req.query.configurationContext,
        })
      )
    )
  );
  router.get(
    "/structures/:ref/requirements",
    authAsync,
    canPlmAsync("read"),
    wrap(async (req, res) =>
      res.json(await BomProjection.listStructureRequirementsAsync(db, tenantOf(req), req.params.ref, { status: req.query.status }))
    )
  );

  // ── Requirement -> PLM documents ────────────────────────────────────────
  router.get(
    "/requirements/:ref/documents",
    authAsync,
    canDocumentsAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Documents.requirementDocumentsAsync(db, tenantOf(req), req.params.ref, {
          category: req.query.category,
          page: req.query.page,
          pageSize: req.query.page_size ?? req.query.pageSize,
        })
      )
    )
  );

  // ── Requirement -> PLM impact analysis ──────────────────────────────────
  router.post(
    "/requirements/:ref/impact-analysis",
    authAsync,
    canImpactAsync("execute"),
    wrap(async (req, res) => res.json(await Impact.analyzeRequirementImpactAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/requirements/:ref/impact-analysis",
    authAsync,
    canImpactAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Impact.analyzeRequirementImpactAsync(
          db,
          tenantOf(req),
          req.params.ref,
          { maxDepth: req.query.max_depth ?? req.query.maxDepth, asOf: req.query.as_of ?? req.query.asOf },
          req.actor,
          req.ip
        )
      )
    )
  );
  router.post(
    "/requirements/:ref/impact-analysis/job",
    authAsync,
    canImpactAsync("execute"),
    wrap(async (req, res) => res.status(202).json(await Jobs.submitImpactAnalysisAsync(db, tenantOf(req), { ...(req.body || {}), requirement_id: req.params.ref }, req.actor, req.ip)))
  );

  // ── Requirement <-> Change Management links ─────────────────────────────
  router.get(
    "/requirements/:ref/changes",
    authAsync,
    canChangesAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Changes.listRequirementChangesAsync(db, tenantOf(req), req.params.ref, {
          change_type: req.query.change_type ?? req.query.changeType,
          page: req.query.page,
          pageSize: req.query.pageSize ?? req.query.page_size,
        })
      )
    )
  );
  router.post(
    "/requirements/:ref/changes",
    authAsync,
    canChangesAsync("create"),
    wrap(async (req, res) => {
      const result = await Changes.linkChangeAsync(db, tenantOf(req), { ...req.body, requirement_id: req.params.ref }, req.actor, req.ip);
      res.status(result.created ? 201 : 200).json({ ...result.link, created: result.created, reactivated: result.reactivated });
    })
  );
  router.get("/changes/:type/:id", authAsync, canChangesAsync("read"), wrap(async (req, res) => res.json(await Changes.requireChangeAsync(db, tenantOf(req), req.params.type, req.params.id))));
  router.get(
    "/changes/:type/:id/requirements",
    authAsync,
    canChangesAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Changes.listChangeRequirementsAsync(db, tenantOf(req), req.params.type, req.params.id, {
          page: req.query.page,
          pageSize: req.query.pageSize ?? req.query.page_size,
        })
      )
    )
  );
  router.delete("/change-links/:ref", authAsync, canChangesAsync("delete"), wrap(async (req, res) => res.json(await Changes.unlinkChangeAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Requirement -> automatic change initiation ──────────────────────────
  router.get(
    "/requirements/:ref/change-initiation",
    authAsync,
    canChangeInitiationAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await ChangeInitiation.evaluateRequirementChangeInitiationAsync(db, tenantOf(req), req.params.ref, {
          maxDepth: req.query.max_depth ?? req.query.maxDepth,
          asOf: req.query.as_of ?? req.query.asOf,
          severity: req.query.severity,
        }, req.actor, req.ip)
      )
    )
  );
  router.post(
    "/requirements/:ref/change-initiation",
    authAsync,
    canChangeInitiationAsync("execute"),
    wrap(async (req, res) => {
      const result = await ChangeInitiation.initiateChangeRequestAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip);
      res.status(result.created ? 201 : 200).json(result);
    })
  );
  router.post(
    "/requirements/:ref/change-initiation/job",
    authAsync,
    canChangeInitiationAsync("execute"),
    wrap(async (req, res) =>
      res.status(202).json(await Jobs.submitChangeInitiationAsync(db, tenantOf(req), { ...(req.body || {}), requirement_id: req.params.ref }, req.actor, req.ip))
    )
  );
  router.get(
    "/requirements/:ref/change-chain",
    authAsync,
    canChangeInitiationAsync("read"),
    wrap(async (req, res) => res.json(await ChangeInitiation.requirementChangeChainAsync(db, tenantOf(req), req.params.ref)))
  );

  // ── Coverage ────────────────────────────────────────────────────────────
  router.get(
    "/coverage",
    authAsync,
    canCoverageAsync("read"),
    wrap(async (req, res) => {
      const requirementRef = req.query.requirement_id ?? req.query.requirementId ?? req.query.requirement_ref;
      if (!requirementRef) return res.status(400).json({ error: "requirement_id is required" });
      return res.json(await Allocations.allocationCoverageAsync(db, tenantOf(req), requirementRef));
    })
  );

  // ── Impact ──────────────────────────────────────────────────────────────
  router.get(
    "/impact",
    authAsync,
    canImpactAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Synchronization.impactedRequirementsAsync(db, tenantOf(req), {
          targetType: req.query.target_type ?? req.query.targetType,
          targetId: req.query.target_id ?? req.query.targetId,
          limit: req.query.limit,
        })
      )
    )
  );
  router.get(
    "/impact/allocations",
    authAsync,
    canImpactAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Synchronization.impactedAllocationsAsync(db, tenantOf(req), {
          targetType: req.query.target_type ?? req.query.targetType,
          targetId: req.query.target_id ?? req.query.targetId,
          requirementId: req.query.requirement_id ?? req.query.requirementId,
          status: req.query.status,
          limit: req.query.limit,
        })
      )
    )
  );

  // ── Synchronization ─────────────────────────────────────────────────────
  router.post(
    "/synchronize",
    authAsync,
    canSynchronizationAsync("execute"),
    wrap(async (req, res) =>
      res.json(
        await Synchronization.synchronizeAsync(
          db,
          tenantOf(req),
          {
            requirementId: req.body?.requirement_id ?? req.body?.requirementId,
            targetType: req.body?.target_type ?? req.body?.targetType,
            targetId: req.body?.target_id ?? req.body?.targetId,
            limit: req.body?.limit,
            notify: req.body?.notify,
          },
          req.actor,
          req.ip
        )
      )
    )
  );
  router.post("/synchronize/job", authAsync, canSynchronizationAsync("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitSynchronizationAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.post("/impact/sweep", authAsync, canImpactAsync("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitImpactSweepAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.post("/synchronize/enqueue", authAsync, canSynchronizationAsync("execute"), wrap(async (req, res) => res.status(202).json(await Integration.enqueueSynchronizationAsync(db, tenantOf(req), req.body || {}, req.actor))));

  // ── PLM -> Requirement reverse navigation & synchronization ─────────────
  router.get(
    "/plm-nodes/:type/:id/requirements",
    authAsync,
    canPlmAsync("read"),
    wrap(async (req, res) =>
      res.json(await PlmSync.requirementsForPlmNodeAsync(db, tenantOf(req), req.params.type, req.params.id))
    )
  );
  router.post(
    "/plm-sync",
    authAsync,
    canSynchronizationAsync("execute"),
    wrap(async (req, res) =>
      res.json(
        await PlmSync.synchronizeFromPlmAsync(
          db,
          tenantOf(req),
          {
            nodeType: req.body?.node_type ?? req.body?.nodeType,
            nodeId: req.body?.node_id ?? req.body?.nodeId,
            eventType: req.body?.event_type ?? req.body?.eventType,
            analyze: req.body?.analyze,
            notify: req.body?.notify,
            maxDepth: req.body?.max_depth ?? req.body?.maxDepth,
            correlationId: req.body?.correlation_id ?? req.body?.correlationId,
          },
          req.actor,
          req.ip
        )
      )
    )
  );
  router.post("/plm-sync/job", authAsync, canSynchronizationAsync("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitPlmSynchronizationAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.post("/plm-sync/enqueue", authAsync, canSynchronizationAsync("execute"), wrap(async (req, res) => res.status(202).json(await Integration.enqueuePlmSynchronizationAsync(db, tenantOf(req), req.body || {}, req.actor))));

  // ── Metrics ─────────────────────────────────────────────────────────────
  router.get("/integration/summary", authAsync, canMetricsAsync("read"), wrap(async (req, res) => res.json(await Integration.integrationSummaryAsync(db, tenantOf(req)))));
  router.get("/plm-metrics", authAsync, canMetricsAsync("read"), wrap(async (req, res) => res.json(await PlmMetrics.plmMetricsAsync(db, tenantOf(req)))));
  router.get("/metrics/plm", authAsync, canMetricsAsync("read"), wrap(async (req, res) => res.json(await PlmMetrics.plmMetricsAsync(db, tenantOf(req)))));
  router.get("/metrics", authAsync, canMetricsAsync("read"), wrap(async (req, res) => res.json(await Integration.integrationSummaryAsync(db, tenantOf(req)))));

  return router;
}
