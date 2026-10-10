// REST router for the Requirement -> Manufacturing traceability layer. Built as
// a factory so it reuses the application's auth, authorization and error
// middleware. Mounted at /api/requirement-manufacturing and
// /api/v1/requirement-manufacturing (mirrors requirement-pdm router).
//
// Bootstrap and data routes use `authAsync`/`canAsync` + `*Async` service
// twins, while the pure-vocabulary `/meta` route stays on the sync `auth`/`can`
// path. A route uses either the sync or the async layer, never both.
import { Constants, Foundation, Configuration, Allocations, Targets, TransformationTrace, ProcessLinkage, Coverage, Matrix, Impact, Jobs } from "./index.js";

const R = Constants.REQUIREMENT_MANUFACTURING_RESOURCES;

export function createRequirementManufacturingRouter({ express, db, auth, can, authAsync, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const canOverviewAsync = (a) => canAsync(R.overview, a);
  const canAdminAsync = (a) => canAsync(R.admin, a);
  const canAdmin = (a) => can(R.admin, a);
  const canAllocationsAsync = (a) => canAsync(R.allocations, a);
  const canCoverageAsync = (a) => canAsync(R.coverage, a);
  const canTransformationsAsync = (a) => canAsync(R.transformations, a);
  const canOperationsAsync = (a) => canAsync(R.operations, a);
  const canWorkCentersAsync = (a) => canAsync(R.workCenters, a);
  const canCharacteristicsAsync = (a) => canAsync(R.characteristics, a);
  const canCtqAsync = (a) => canAsync(R.ctq, a);
  const canTraceabilityAsync = (a) => canAsync(R.traceability, a);
  const canImpactAsync = (a) => canAsync(R.impact, a);

  // ── Meta, health ────────────────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
    can(R.overview, "read"),
    wrap((_req, res) => res.json(Foundation.requirementManufacturingMeta()))
  );
  router.get("/health", authAsync, canOverviewAsync("read"), wrap(async (req, res) => res.json(await Foundation.requirementManufacturingHealthAsync(db, tenantOf(req)))));

  // ── Configuration (sync vocabulary + platform config store) ─────────────
  router.get("/config", auth, canAdmin("read"), wrap((req, res) => res.json(Configuration.listConfig(db, tenantOf(req)))));
  router.put(
    "/config/:key",
    auth,
    canAdmin("update"),
    wrap((req, res) => res.json(Configuration.setConfig(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip)))
  );

  // ── Bootstrap ───────────────────────────────────────────────────────────
  router.post("/foundation/ensure", authAsync, canAdminAsync("execute"), wrap(async (_req, res) => res.json(await Foundation.ensureRequirementManufacturingFoundationAsync(db))));

  // ── Vocabulary ──────────────────────────────────────────────────────────
  router.get(
    "/targets",
    auth,
    can(R.allocations, "read"),
    wrap((_req, res) => {
      const meta = Foundation.requirementManufacturingMeta();
      return res.json({ target_types: meta.target_types, node_types: meta.node_types, allocation_types: meta.allocation_types });
    })
  );
  router.get(
    "/targets/resolve",
    authAsync,
    canAllocationsAsync("read"),
    wrap(async (req, res) =>
      res.json(await Targets.requireTargetAsync(db, tenantOf(req), req.query.target_type ?? req.query.targetType, req.query.target_id ?? req.query.targetId ?? req.query.ref))
    )
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
  router.post(
    "/allocations/batch",
    authAsync,
    canAllocationsAsync("create"),
    wrap(async (req, res) => res.status(201).json(await Allocations.createAllocationsAsync(db, tenantOf(req), req.body, req.actor, req.ip)))
  );
  router.get("/allocations/:ref", authAsync, canAllocationsAsync("read"), wrap(async (req, res) => res.json(await Allocations.getAllocationAsync(db, tenantOf(req), req.params.ref))));
  router.delete("/allocations/:ref", authAsync, canAllocationsAsync("delete"), wrap(async (req, res) => res.json(await Allocations.removeAllocationAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Forward / reverse navigation ────────────────────────────────────────
  router.get("/requirements/:ref/allocations", authAsync, canAllocationsAsync("read"), wrap(async (req, res) => res.json(await Allocations.listRequirementAllocationsAsync(db, tenantOf(req), req.params.ref))));
  router.get("/requirements/:ref/coverage", authAsync, canCoverageAsync("read"), wrap(async (req, res) => res.json(await Allocations.allocationCoverageAsync(db, tenantOf(req), req.params.ref))));
  router.get(
    "/targets/requirements",
    authAsync,
    canAllocationsAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Allocations.listTargetRequirementsAsync(
          db,
          tenantOf(req),
          req.query.target_type ?? req.query.targetType,
          req.query.target_id ?? req.query.targetId ?? req.query.ref
        )
      )
    )
  );

  // ── EBOM -> MBOM transformation trace (Boundary 3) ──────────────────────
  router.get(
    "/ebom/:ref/mbom-mappings",
    authAsync,
    canTransformationsAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await TransformationTrace.ebomMbomMappingsAsync(db, tenantOf(req), req.params.ref, {
          page: req.query.page,
          pageSize: req.query.pageSize ?? req.query.page_size,
          sort: req.query.sort,
        })
      )
    )
  );
  router.get(
    "/mbom/:ref/ebom-sources",
    authAsync,
    canTransformationsAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await TransformationTrace.mbomEbomSourcesAsync(db, tenantOf(req), req.params.ref, {
          page: req.query.page,
          pageSize: req.query.pageSize ?? req.query.page_size,
          sort: req.query.sort,
        })
      )
    )
  );
  router.get(
    "/bom-revisions/:ref/transformations",
    authAsync,
    canTransformationsAsync("read"),
    wrap(async (req, res) => res.json(await TransformationTrace.listTransformationsForRevisionAsync(db, tenantOf(req), req.params.ref)))
  );

  // ── BOP -> Operation -> Work-center linkage (Boundary 4) ────────────────
  router.get(
    "/bop/:ref/operations",
    authAsync,
    canOperationsAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await ProcessLinkage.bopOperationsAsync(db, tenantOf(req), req.params.ref, {
          page: req.query.page,
          pageSize: req.query.pageSize ?? req.query.page_size,
          includeInactive: req.query.includeInactive !== "false",
        })
      )
    )
  );
  router.get(
    "/bop/:ref/sequence",
    authAsync,
    canOperationsAsync("read"),
    wrap(async (req, res) => res.json(await ProcessLinkage.bopProcessSequenceAsync(db, tenantOf(req), req.params.ref, { page: req.query.page, pageSize: req.query.pageSize ?? req.query.page_size })))
  );
  router.get(
    "/bop/:ref/coverage",
    authAsync,
    canCoverageAsync("read"),
    wrap(async (req, res) => res.json(await ProcessLinkage.bopProcessCoverageAsync(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/bop/:ref/mboms",
    authAsync,
    canOperationsAsync("read"),
    wrap(async (req, res) => res.json(await ProcessLinkage.listBopMbomsAsync(db, tenantOf(req), req.params.ref, { page: req.query.page, pageSize: req.query.pageSize ?? req.query.page_size })))
  );
  router.post(
    "/bop/:ref/operations",
    authAsync,
    canOperationsAsync("create"),
    wrap(async (req, res) => res.status(201).json(await ProcessLinkage.addOperationToBopAsync(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip)))
  );

  router.get(
    "/mbom/:ref/bops",
    authAsync,
    canOperationsAsync("read"),
    wrap(async (req, res) => res.json(await ProcessLinkage.listMbomBopsAsync(db, tenantOf(req), req.params.ref, { page: req.query.page, pageSize: req.query.pageSize ?? req.query.page_size })))
  );
  router.get(
    "/mbom/:ref/process-coverage",
    authAsync,
    canCoverageAsync("read"),
    wrap(async (req, res) => res.json(await ProcessLinkage.mbomProcessCoverageAsync(db, tenantOf(req), req.params.ref, { page: req.query.page, pageSize: req.query.pageSize ?? req.query.page_size })))
  );

  router.get(
    "/operations/:ref/work-centers",
    authAsync,
    canOperationsAsync("read"),
    wrap(async (req, res) => res.json(await ProcessLinkage.operationWorkCentersAsync(db, tenantOf(req), req.params.ref, { page: req.query.page, pageSize: req.query.pageSize ?? req.query.page_size })))
  );
  router.post(
    "/operations/:ref/work-centers",
    authAsync,
    canWorkCentersAsync("create"),
    wrap(async (req, res) => res.status(201).json(await ProcessLinkage.linkOperationToWorkCenterAsync(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip)))
  );
  router.get(
    "/operations/:ref/mbom-items",
    authAsync,
    canOperationsAsync("read"),
    wrap(async (req, res) => res.json(await ProcessLinkage.operationMbomItemsAsync(db, tenantOf(req), req.params.ref, { page: req.query.page, pageSize: req.query.pageSize ?? req.query.page_size })))
  );
  router.post(
    "/operations/:ref/mbom-items",
    authAsync,
    canOperationsAsync("create"),
    wrap(async (req, res) => res.status(201).json(await ProcessLinkage.linkOperationToMbomItemAsync(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip)))
  );
  router.post(
    "/operations/:ref/predecessors",
    authAsync,
    canOperationsAsync("create"),
    wrap(async (req, res) => res.status(201).json(await ProcessLinkage.linkOperationPrecedenceAsync(db, tenantOf(req), req.params.ref, req.body, req.actor, req.ip)))
  );

  router.get(
    "/work-centers/:ref/operations",
    authAsync,
    canWorkCentersAsync("read"),
    wrap(async (req, res) => res.json(await ProcessLinkage.workCenterOperationsAsync(db, tenantOf(req), req.params.ref, { page: req.query.page, pageSize: req.query.pageSize ?? req.query.page_size })))
  );
  router.get(
    "/mbom-items/:ref/operations",
    authAsync,
    canOperationsAsync("read"),
    wrap(async (req, res) => res.json(await ProcessLinkage.mbomItemOperationsAsync(db, tenantOf(req), req.params.ref, { page: req.query.page, pageSize: req.query.pageSize ?? req.query.page_size })))
  );

  // ── Characteristics, process constraints & CTQ coverage (Boundary 5) ─────
  router.get(
    "/operations/:ref/characteristics",
    authAsync,
    canCharacteristicsAsync("read"),
    wrap(async (req, res) => res.json(await Coverage.operationCharacteristicsAsync(db, tenantOf(req), req.params.ref, { page: req.query.page, pageSize: req.query.pageSize ?? req.query.page_size })))
  );
  router.get(
    "/operations/:ref/constraints",
    authAsync,
    canCharacteristicsAsync("read"),
    wrap(async (req, res) => res.json(await Coverage.operationConstraintsAsync(db, tenantOf(req), req.params.ref, { page: req.query.page, pageSize: req.query.pageSize ?? req.query.page_size })))
  );
  router.get(
    "/characteristics/:ref/operations",
    authAsync,
    canCharacteristicsAsync("read"),
    wrap(async (req, res) => res.json(await Coverage.characteristicOperationsAsync(db, tenantOf(req), req.params.ref, { page: req.query.page, pageSize: req.query.pageSize ?? req.query.page_size })))
  );
  router.get(
    "/characteristics/:ref/requirements",
    authAsync,
    canCharacteristicsAsync("read"),
    wrap(async (req, res) => res.json(await Coverage.characteristicRequirementsAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/characteristics/:ref/validate",
    authAsync,
    canCharacteristicsAsync("read"),
    wrap(async (req, res) => res.json(await Coverage.validateConstraintCompatibilityAsync(db, tenantOf(req), req.params.ref, req.body ?? {})))
  );
  router.get(
    "/requirements/:ref/ctq",
    authAsync,
    canCtqAsync("read"),
    wrap(async (req, res) => res.json(await Coverage.requirementCtqsAsync(db, tenantOf(req), req.params.ref, { includeNonCtq: req.query.includeNonCtq === "true" })))
  );
  router.get(
    "/ctq/coverage",
    authAsync,
    canCoverageAsync("read"),
    wrap(async (req, res) => res.json(await Coverage.ctqCoverageAsync(db, tenantOf(req), { page: req.query.page, pageSize: req.query.pageSize ?? req.query.page_size })))
  );

  // ── Matrix, coverage, gaps & bidirectional navigation (Boundary 6) ──────
  router.get(
    "/matrix",
    authAsync,
    canCoverageAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Matrix.manufacturingMatrixAsync(db, tenantOf(req), {
          requirementId: req.query.requirement_id ?? req.query.requirementId,
          criticality: req.query.criticality,
          page: req.query.page,
          pageSize: req.query.pageSize ?? req.query.page_size,
        })
      )
    )
  );
  router.get("/coverage", authAsync, canCoverageAsync("read"), wrap(async (req, res) => res.json(await Matrix.manufacturingCoverageAsync(db, tenantOf(req)))));
  router.get(
    "/gaps",
    authAsync,
    canTraceabilityAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Matrix.manufacturingGapsAsync(db, tenantOf(req), {
          rules: req.query.rules ? String(req.query.rules).split(",").map((rule) => rule.trim()).filter(Boolean) : null,
          mbomScanLimit: req.query.mbomScanLimit ?? req.query.mbom_scan_limit,
          page: req.query.page,
          pageSize: req.query.pageSize ?? req.query.page_size,
        })
      )
    )
  );
  router.get(
    "/trace",
    authAsync,
    canTraceabilityAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Matrix.manufacturingTraceAsync(
          db,
          tenantOf(req),
          {
            objectType: req.query.objectType ?? req.query.object_type,
            objectId: req.query.objectId ?? req.query.object_id,
            direction: req.query.direction,
            maxDepth: req.query.maxDepth ?? req.query.max_depth,
          },
          req.actor
        )
      )
    )
  );
  router.get(
    "/trace/matrix",
    authAsync,
    canTraceabilityAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Matrix.manufacturingTraceMatrixAsync(
          db,
          tenantOf(req),
          {
            objectType: req.query.objectType ?? req.query.object_type,
            objectId: req.query.objectId ?? req.query.object_id,
            direction: req.query.direction,
            maxDepth: req.query.maxDepth ?? req.query.max_depth,
          },
          req.actor
        )
      )
    )
  );

  // ── Change impact integration (Boundary 7) ──────────────────────────────
  router.post(
    "/impact-analysis",
    authAsync,
    canImpactAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Impact.analyzeRequirementImpactAsync(
          db,
          tenantOf(req),
          req.body?.requirement_id ?? req.body?.requirementId ?? req.body?.requirement_ref ?? req.body?.requirementRef,
          { maxDepth: req.body?.max_depth ?? req.body?.maxDepth, asOf: req.body?.as_of ?? req.body?.asOf },
          req.actor,
          req.ip
        )
      )
    )
  );
  router.get(
    "/requirements/:ref/impact",
    authAsync,
    canImpactAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Impact.analyzeRequirementImpactAsync(
          db,
          tenantOf(req),
          req.params.ref,
          { maxDepth: req.query.maxDepth ?? req.query.max_depth, asOf: req.query.asOf ?? req.query.as_of },
          req.actor,
          req.ip
        )
      )
    )
  );
  router.post(
    "/node-impact",
    authAsync,
    canImpactAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Impact.analyzeNodeImpactAsync(
          db,
          tenantOf(req),
          { nodeType: req.body?.node_type ?? req.body?.nodeType, nodeId: req.body?.node_id ?? req.body?.nodeId },
          { maxDepth: req.body?.max_depth ?? req.body?.maxDepth, analyze: req.body?.analyze },
          req.actor,
          req.ip
        )
      )
    )
  );
  router.post(
    "/impact-analysis/jobs",
    authAsync,
    canImpactAsync("create"),
    wrap(async (req, res) => res.status(202).json(await Jobs.submitImpactAnalysisAsync(db, tenantOf(req), req.body ?? {}, req.actor, req.ip)))
  );
  router.get(
    "/requirements/:ref/gaps",
    authAsync,
    canTraceabilityAsync("read"),
    wrap(async (req, res) =>
      res.json(
        await Matrix.manufacturingGapsAsync(db, tenantOf(req), {
          requirementId: req.params.ref,
          rules: req.query.rules ? String(req.query.rules).split(",").map((rule) => rule.trim()).filter(Boolean) : null,
          page: req.query.page,
          pageSize: req.query.pageSize ?? req.query.page_size,
        })
      )
    )
  );
  router.post(
    "/gaps/sweep",
    authAsync,
    canTraceabilityAsync("create"),
    wrap(async (req, res) => res.status(202).json(await Jobs.submitGapSweepAsync(db, tenantOf(req), req.body ?? {}, req.actor, req.ip)))
  );

  return router;
}
