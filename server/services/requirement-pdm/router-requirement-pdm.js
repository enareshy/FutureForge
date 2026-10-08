// REST router for the Requirement -> PDM integration. Built as a factory so it
// reuses the application's auth, authorization and error middleware. Mounted at
// /api/requirement-pdm and /api/v1/requirement-pdm (mirrors
// server/services/requirements/router-requirements.js).
//
// Every data route and bootstrap use `authAsync`/`canAsync` + `*Async` service
// twins, while the pure-vocabulary `/meta` route stays on the sync `auth`/`can`
// path. A route uses either the sync or the async layer, never both.
import { Constants, Foundation, Configuration, Targets, Allocations, Compatibility, Synchronization, Jobs, Integration } from "./index.js";

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

  // ── Metrics ─────────────────────────────────────────────────────────────
  router.get("/integration/summary", authAsync, canMetricsAsync("read"), wrap(async (req, res) => res.json(await Integration.integrationSummaryAsync(db, tenantOf(req)))));
  router.get("/metrics", authAsync, canMetricsAsync("read"), wrap(async (req, res) => res.json(await Integration.integrationSummaryAsync(db, tenantOf(req)))));

  return router;
}
