// REST router for the P1 Digital Thread. Built as a factory so it reuses the
// application's auth, authorization and error middleware. Mounted at
// /api/digital-thread and /api/v1/digital-thread.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization.
//
// This router runs entirely on the asynchronous PostgreSQL data-access layer:
// the async `authAsync`/`canAsync` middleware and the `*Async` service twins.
// Only the pure vocabulary endpoints (`/meta`, `/providers`, `/search-meta`) and
// the synchronous search-source registration (`/search/reindex`) stay sync.
import {
  Constants,
  Domains,
  Providers,
  Definitions,
  Rules,
  Engine,
  Traceability,
  Impact,
  Dependency,
  Paths,
  Completeness,
  Snapshots,
  Baselines,
  Compare,
  Projection,
  Configuration,
  Metrics,
  History,
  Jobs,
  Search,
  Foundation,
  Seed,
} from "./index.js";

const R = Constants.THREAD_RESOURCES;

export function createThreadRouter({ express, db, auth, authAsync, can, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";
  const query = (req) => ({ tenantId: tenantOf(req), ...req.query });

  const canOverview = (a) => canAsync(R.overview, a);
  const canExplorer = (a) => canAsync(R.explorer, a);
  const canTraceability = (a) => canAsync(R.traceability, a);
  const canImpact = (a) => canAsync(R.impact, a);
  const canPaths = (a) => canAsync(R.paths, a);
  const canDefinitions = (a) => canAsync(R.definitions, a);
  const canSnapshots = (a) => canAsync(R.snapshots, a);
  const canBaselines = (a) => canAsync(R.baselines, a);
  const canCompare = (a) => canAsync(R.compare, a);
  const canCompleteness = (a) => canAsync(R.completeness, a);
  const canSearch = (a) => canAsync(R.search, a);
  const canAudit = (a) => canAsync(R.auditTrail, a);
  const canMetrics = (a) => canAsync(R.metrics, a);
  const canAdmin = (a) => canAsync(R.admin, a);

  // ── Meta, health, metrics ─────────────────────────────────────────────────
  router.get(
    "/meta",
    authAsync,
    canOverview("read"),
    wrap((_req, res) => {
      res.json({
        source_module: Constants.SOURCE_MODULE,
        resources: R,
        capabilities: {
          thread_statuses: Constants.THREAD_STATUSES,
          thread_types: Constants.THREAD_TYPES,
          directions: Constants.DIRECTIONS,
          link_directions: Constants.LINK_DIRECTIONS,
          severities: Constants.SEVERITIES,
          snapshot_statuses: Constants.SNAPSHOT_STATUSES,
          baseline_statuses: Constants.BASELINE_STATUSES,
          compare_result_types: Constants.COMPARE_RESULT_TYPES,
          completeness_states: Constants.COMPLETENESS_STATES,
          domains: Constants.DOMAIN_TYPES,
          traceability_links: Constants.TRACEABILITY_LINKS,
          providers: Providers.listProviders(),
          config_defaults: Constants.CONFIG_DEFAULTS,
          limits: {
            max_depth: Constants.MAX_DEPTH,
            max_nodes: Constants.MAX_NODES,
            max_paths: Constants.MAX_PATHS,
            max_path_depth: Constants.MAX_PATH_DEPTH,
          },
          job_types: Constants.THREAD_JOB_TYPES.map((job) => job.code),
          handler_codes: Constants.THREAD_HANDLER_CODES,
          search_types: Constants.SEARCH_OBJECT_TYPES.map((entry) => entry.code),
        },
      });
    })
  );

  router.get("/health", authAsync, canMetrics("read"), wrap(async (req, res) => res.json({ ...(await Metrics.healthCheckAsync(db, tenantOf(req))), ...(await Foundation.threadHealthAsync(db, tenantOf(req))) })));
  router.get("/metrics", authAsync, canMetrics("read"), wrap(async (req, res) => res.json(await Metrics.metricsSnapshotAsync(db, tenantOf(req)))));
  router.get("/activity", authAsync, canMetrics("read"), wrap(async (req, res) => res.json(await Metrics.activitySummaryAsync(db, tenantOf(req), { limit: req.query.limit }))));

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get("/config", authAsync, canAdmin("read"), wrap(async (req, res) => res.json(await Configuration.listConfigAsync(db, tenantOf(req)))));
  const setConfig = wrap(async (req, res) => res.json(await Configuration.setConfigAsync(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip)));
  router.put("/config/:key", authAsync, canAdmin("update"), setConfig);
  router.patch("/config/:key", authAsync, canAdmin("update"), setConfig);

  // ── Domains & providers ───────────────────────────────────────────────────
  router.get("/domains", authAsync, canOverview("read"), wrap(async (req, res) => res.json({ items: Domains.domainCatalog(req.query.definition_code ? await Definitions.getDefinitionAsync(db, tenantOf(req), req.query.definition_code) : null), source_module: Constants.SOURCE_MODULE })));
  router.get("/providers", authAsync, canOverview("read"), wrap((_req, res) => res.json({ items: Providers.listProviders(), source_module: Constants.SOURCE_MODULE })));

  // ── Definitions ───────────────────────────────────────────────────────────
  router.get("/definitions", authAsync, canDefinitions("read"), wrap(async (req, res) => res.json(await Definitions.listDefinitionsAsync(db, tenantOf(req), query(req)))));
  router.post("/definitions", authAsync, canDefinitions("create"), wrap(async (req, res) => res.status(201).json(await Definitions.createDefinitionAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/definitions/summary", authAsync, canDefinitions("read"), wrap(async (req, res) => res.json(await Definitions.definitionSummaryAsync(db, tenantOf(req)))));
  router.get("/definitions/:ref", authAsync, canDefinitions("read"), wrap(async (req, res) => res.json(await Definitions.getDefinitionAsync(db, tenantOf(req), req.params.ref))));
  const updateDefinition = wrap(async (req, res) => res.json(await Definitions.updateDefinitionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/definitions/:ref", authAsync, canDefinitions("update"), updateDefinition);
  router.patch("/definitions/:ref", authAsync, canDefinitions("update"), updateDefinition);
  router.post("/definitions/:ref/status", authAsync, canDefinitions("update"), wrap(async (req, res) => res.json(await Definitions.setDefinitionStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.delete("/definitions/:ref", authAsync, canDefinitions("delete"), wrap(async (req, res) => res.json(await Definitions.deleteDefinitionAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Traceability rules ────────────────────────────────────────────────────
  router.get("/rules", authAsync, canDefinitions("read"), wrap(async (req, res) => res.json(await Rules.listRulesAsync(db, tenantOf(req), query(req)))));
  router.post("/rules", authAsync, canDefinitions("create"), wrap(async (req, res) => res.status(201).json(await Rules.createRuleAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/rules/summary", authAsync, canDefinitions("read"), wrap(async (req, res) => res.json(await Rules.ruleSummaryAsync(db, tenantOf(req)))));
  router.get("/rules/:ref", authAsync, canDefinitions("read"), wrap(async (req, res) => res.json(await Rules.getRuleAsync(db, tenantOf(req), req.params.ref))));
  const updateRule = wrap(async (req, res) => res.json(await Rules.updateRuleAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/rules/:ref", authAsync, canDefinitions("update"), updateRule);
  router.patch("/rules/:ref", authAsync, canDefinitions("update"), updateRule);
  router.post("/rules/:ref/status", authAsync, canDefinitions("update"), wrap(async (req, res) => res.json(await Rules.setRuleStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.delete("/rules/:ref", authAsync, canDefinitions("delete"), wrap(async (req, res) => res.json(await Rules.deleteRuleAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Explorer / traversal ──────────────────────────────────────────────────
  const traverse = wrap(async (req, res) => {
    const options = optionsOf(req.body || {}, req);
    const { result, definition } = await Engine.executeTraversalAsync(db, tenantOf(req), options, req.actor, { action: "TRAVERSAL" });
    res.json(Engine.publicGraph(result, definition));
  });
  router.post("/traverse", authAsync, canExplorer("execute"), traverse);
  router.get(
    "/traverse",
    authAsync,
    canExplorer("read"),
    wrap(async (req, res) => {
      const { result, definition } = await Engine.executeTraversalAsync(db, tenantOf(req), optionsOf(req.query, req), req.actor, { action: "TRAVERSAL" });
      res.json(Engine.publicGraph(result, definition));
    })
  );

  // ── Traceability ──────────────────────────────────────────────────────────
  const traceability = (matrix) =>
    wrap(async (req, res) => {
      const options = optionsOf(req.body || req.query, req);
      const output = matrix ? await Traceability.traceabilityMatrixAsync(db, tenantOf(req), options, req.actor) : await Traceability.traceabilityGraphAsync(db, tenantOf(req), options, req.actor);
      res.json(output);
    });
  router.post("/traceability", authAsync, canTraceability("read"), traceability(false));
  router.get("/traceability", authAsync, canTraceability("read"), traceability(false));
  router.post("/traceability/matrix", authAsync, canTraceability("read"), traceability(true));

  // ── Impact & dependency ───────────────────────────────────────────────────
  const impact = (direct) =>
    wrap(async (req, res) => {
      const options = optionsOf(req.body || req.query, req);
      res.json(direct ? await Impact.directImpactAsync(db, tenantOf(req), options, req.actor) : await Impact.impactAnalysisAsync(db, tenantOf(req), options, req.actor));
    });
  router.post("/impact", authAsync, canImpact("execute"), impact(false));
  router.get("/impact", authAsync, canImpact("read"), impact(false));
  router.post("/impact/direct", authAsync, canImpact("read"), impact(true));
  const dependency = (direct) =>
    wrap(async (req, res) => {
      const options = optionsOf(req.body || req.query, req);
      res.json(direct ? await Dependency.directDependencyAnalysisAsync(db, tenantOf(req), options, req.actor) : await Dependency.dependencyAnalysisAsync(db, tenantOf(req), options, req.actor));
    });
  router.post("/dependency", authAsync, canExplorer("execute"), dependency(false));
  router.get("/dependency", authAsync, canExplorer("read"), dependency(false));
  router.post("/dependency/direct", authAsync, canExplorer("read"), dependency(true));

  // ── Paths ─────────────────────────────────────────────────────────────────
  const paths = wrap(async (req, res) => {
    const source = req.body?.source ?? req.body?.from ?? req.query.source ?? req.query.from;
    const target = req.body?.target ?? req.body?.to ?? req.query.target ?? req.query.to;
    const options = { ...optionsOf(req.body || req.query, req), source, target };
    res.json(await Paths.findPathsAsync(db, tenantOf(req), options, req.actor));
  });
  router.post("/paths", authAsync, canPaths("execute"), paths);
  router.get("/paths", authAsync, canPaths("read"), paths);

  // ── Completeness ──────────────────────────────────────────────────────────
  const completeness = wrap(async (req, res) => res.json(await Completeness.evaluateCompletenessAsync(db, tenantOf(req), optionsOf(req.body || req.query, req), req.actor)));
  router.post("/completeness", authAsync, canCompleteness("execute"), completeness);
  router.get("/completeness", authAsync, canCompleteness("read"), completeness);

  // ── Snapshots ─────────────────────────────────────────────────────────────
  router.get("/snapshots", authAsync, canSnapshots("read"), wrap(async (req, res) => res.json(await Snapshots.listSnapshotsAsync(db, tenantOf(req), query(req)))));
  router.post("/snapshots", authAsync, canSnapshots("create"), wrap(async (req, res) => res.status(201).json(await Snapshots.createSnapshotAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/snapshots/summary", authAsync, canSnapshots("read"), wrap(async (req, res) => res.json(await Snapshots.snapshotSummaryAsync(db, tenantOf(req)))));
  router.get("/snapshots/:ref", authAsync, canSnapshots("read"), wrap(async (req, res) => res.json(await Snapshots.getSnapshotAsync(db, tenantOf(req), req.params.ref, { includeNodes: req.query.include_nodes !== "false", includeEdges: req.query.include_edges !== "false" }))));
  router.get("/snapshots/:ref/graph", authAsync, canSnapshots("read"), wrap(async (req, res) => res.json(await Snapshots.snapshotGraphAsync(db, tenantOf(req), req.params.ref))));
  router.post("/snapshots/:ref/status", authAsync, canSnapshots("update"), wrap(async (req, res) => res.json(await Snapshots.setSnapshotStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.delete("/snapshots/:ref", authAsync, canSnapshots("delete"), wrap(async (req, res) => res.json(await Snapshots.deleteSnapshotAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Baselines ─────────────────────────────────────────────────────────────
  router.get("/baselines", authAsync, canBaselines("read"), wrap(async (req, res) => res.json(await Baselines.listBaselinesAsync(db, tenantOf(req), query(req)))));
  router.post("/baselines", authAsync, canBaselines("create"), wrap(async (req, res) => res.status(201).json(await Baselines.createBaselineAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/baselines/summary", authAsync, canBaselines("read"), wrap(async (req, res) => res.json(await Baselines.baselineSummaryAsync(db, tenantOf(req)))));
  router.get("/baselines/:ref", authAsync, canBaselines("read"), wrap(async (req, res) => res.json(await Baselines.getBaselineAsync(db, tenantOf(req), req.params.ref, { includeMembers: req.query.include_members !== "false" }))));
  router.get("/baselines/:ref/members", authAsync, canBaselines("read"), wrap(async (req, res) => res.json({ items: await Baselines.baselineMembersAsync(db, (await Baselines.requireBaselineRowAsync(db, tenantOf(req), req.params.ref)).id) })));
  router.post("/baselines/:ref/release", authAsync, canBaselines("update"), wrap(async (req, res) => res.json(await Baselines.releaseBaselineAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/baselines/:ref/freeze", authAsync, canBaselines("update"), wrap(async (req, res) => res.json(await Baselines.freezeBaselineAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  const updateBaseline = wrap(async (req, res) => res.json(await Baselines.updateBaselineAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/baselines/:ref", authAsync, canBaselines("update"), updateBaseline);
  router.patch("/baselines/:ref", authAsync, canBaselines("update"), updateBaseline);
  router.delete("/baselines/:ref", authAsync, canBaselines("delete"), wrap(async (req, res) => res.json(await Baselines.deleteBaselineAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Compare ───────────────────────────────────────────────────────────────
  router.post(
    "/compare",
    authAsync,
    canCompare("read"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(
        await Compare.compareProjectionsAsync(
          db,
          tenantOf(req),
          {
            left: body.left ?? body.left_ref,
            right: body.right ?? body.right_ref,
            leftKind: String(body.left_kind || body.leftKind || "SNAPSHOT").toUpperCase(),
            rightKind: String(body.right_kind || body.rightKind || "SNAPSHOT").toUpperCase(),
          },
          req.actor
        )
      );
    })
  );
  router.post("/compare/snapshots", authAsync, canCompare("read"), wrap(async (req, res) => res.json(await Compare.compareSnapshotsAsync(db, tenantOf(req), req.body || {}, req.actor))));
  router.post("/compare/baselines", authAsync, canCompare("read"), wrap(async (req, res) => res.json(await Compare.compareBaselinesAsync(db, tenantOf(req), req.body || {}, req.actor))));

  // ── Projection ────────────────────────────────────────────────────────────
  router.get("/projections", authAsync, canOverview("read"), wrap(async (req, res) => res.json(await Projection.listProjectionsAsync(db, tenantOf(req), query(req)))));
  router.get("/projections/state", authAsync, canOverview("read"), wrap(async (req, res) => res.json(await Projection.projectionStateAsync(db, tenantOf(req)))));
  router.get("/projections/health", authAsync, canMetrics("read"), wrap(async (req, res) => res.json(await Projection.projectionHealthAsync(db, tenantOf(req)))));
  router.get("/projections/:objectType/:objectId", authAsync, canOverview("read"), wrap(async (req, res) => res.json(await Projection.getProjectionAsync(db, tenantOf(req), req.params.objectType, req.params.objectId))));
  router.post("/projections/rebuild", authAsync, canAdmin("execute"), wrap(async (req, res) => res.json(await Projection.rebuildProjectionAsync(db, tenantOf(req), { objectTypes: req.body?.object_types ?? req.body?.objectTypes ?? null, actor: req.actor }))));

  // ── Search ────────────────────────────────────────────────────────────────
  router.post("/search/reindex", authAsync, canSearch("execute"), wrap((_req, res) => res.json({ registered: Search.registerThreadSources() })));
  router.get("/search-meta", authAsync, canSearch("read"), wrap((_req, res) => res.json({ object_types: Constants.SEARCH_OBJECT_TYPES })));

  // ── History & audit ───────────────────────────────────────────────────────
  router.get("/history", authAsync, canAudit("read"), wrap(async (req, res) => res.json(await History.listHistoryAsync(db, query(req)))));
  router.get("/query-history", authAsync, canAudit("read"), wrap(async (req, res) => res.json(await History.listQueryHistoryAsync(db, query(req)))));
  router.get("/history/:objectType/:objectId", authAsync, canAudit("read"), wrap(async (req, res) => res.json({ items: await History.objectLineageAsync(db, tenantOf(req), req.params.objectType, req.params.objectId) })));

  // ── Background jobs ───────────────────────────────────────────────────────
  router.post("/jobs/traverse", authAsync, canExplorer("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitTraversalJobAsync(db, { tenantId: tenantOf(req), root: req.body?.root, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/impact", authAsync, canImpact("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitImpactJobAsync(db, { tenantId: tenantOf(req), root: req.body?.root, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/paths", authAsync, canPaths("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitPathJobAsync(db, { tenantId: tenantOf(req), source: req.body?.source, target: req.body?.target, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/snapshot", authAsync, canSnapshots("create"), wrap(async (req, res) => res.status(202).json(await Jobs.submitSnapshotJobAsync(db, { tenantId: tenantOf(req), body: req.body || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/baseline", authAsync, canBaselines("create"), wrap(async (req, res) => res.status(202).json(await Jobs.submitBaselineJobAsync(db, { tenantId: tenantOf(req), body: req.body || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/completeness", authAsync, canCompleteness("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitCompletenessJobAsync(db, { tenantId: tenantOf(req), root: req.body?.root, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/reindex", authAsync, canSearch("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitReindexJobAsync(db, { tenantId: tenantOf(req), objectTypes: req.body?.object_types ?? req.body?.objectTypes ?? null, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/projection-rebuild", authAsync, canAdmin("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitProjectionRebuildJobAsync(db, { tenantId: tenantOf(req), objectTypes: req.body?.object_types ?? req.body?.objectTypes ?? null, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/maintenance", authAsync, canAdmin("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitMaintenanceJobAsync(db, { tenantId: tenantOf(req), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));

  // ── Foundation & demo seed ────────────────────────────────────────────────
  router.post("/foundation/ensure", authAsync, canAdmin("execute"), wrap(async (_req, res) => res.json(await Foundation.ensureThreadFoundationAsync(db))));
  router.post("/seed", authAsync, canAdmin("execute"), wrap(async (req, res) => res.json(await Seed.seedThreadAsync(db, tenantOf(req)))));

  return router;
}

function optionsOf(input = {}, req) {
  const root = input.root ?? input.node ?? input.node_ref ?? input.nodeRef ?? null;
  return {
    root,
    direction: input.direction,
    maxDepth: input.max_depth ?? input.maxDepth,
    maxNodes: input.max_nodes ?? input.maxNodes,
    includeDomains: input.include_domains ?? input.includeDomains,
    excludeDomains: input.exclude_domains ?? input.excludeDomains,
    definitionCode: input.definition_code ?? input.definitionCode,
    definitionId: input.definition_id ?? input.definitionId,
    revision: input.revision ?? input.revision_rule ?? input.revisionRule,
    asOf: input.as_of ?? input.asOf,
    serialNumber: input.serial_number ?? input.serialNumber,
    lot: input.lot,
    change: input.change,
    variant: input.variant ?? input.variant_code ?? input.variantCode,
    configuration: input.configuration ?? input.configuration_id ?? input.configurationId,
    includeInactive: input.include_inactive ?? input.includeInactive,
    allowCrossDomain: input.allow_cross_domain ?? input.allowCrossDomain,
    organizationId: input.organization_id ?? input.organizationId,
    relationshipTypes: input.relationship_types ?? input.relationshipTypes,
    ip: req?.ip,
  };
}
