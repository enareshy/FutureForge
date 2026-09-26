// REST router for the P1 Digital Thread. Built as a factory so it reuses the
// application's auth, authorization and error middleware. Mounted at
// /api/digital-thread and /api/v1/digital-thread.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization.
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

export function createThreadRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";
  const query = (req) => ({ tenantId: tenantOf(req), ...req.query });

  const canOverview = (a) => can(R.overview, a);
  const canExplorer = (a) => can(R.explorer, a);
  const canTraceability = (a) => can(R.traceability, a);
  const canImpact = (a) => can(R.impact, a);
  const canPaths = (a) => can(R.paths, a);
  const canDefinitions = (a) => can(R.definitions, a);
  const canSnapshots = (a) => can(R.snapshots, a);
  const canBaselines = (a) => can(R.baselines, a);
  const canCompare = (a) => can(R.compare, a);
  const canCompleteness = (a) => can(R.completeness, a);
  const canSearch = (a) => can(R.search, a);
  const canAudit = (a) => can(R.auditTrail, a);
  const canMetrics = (a) => can(R.metrics, a);
  const canAdmin = (a) => can(R.admin, a);

  // ── Meta, health, metrics ─────────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
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

  router.get("/health", auth, canMetrics("read"), wrap((req, res) => res.json({ ...Metrics.healthCheck(db, tenantOf(req)), ...Foundation.threadHealth(db, tenantOf(req)) })));
  router.get("/metrics", auth, canMetrics("read"), wrap((req, res) => res.json(Metrics.metricsSnapshot(db, tenantOf(req)))));
  router.get("/activity", auth, canMetrics("read"), wrap((req, res) => res.json(Metrics.activitySummary(db, tenantOf(req), { limit: req.query.limit }))));

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get("/config", auth, canAdmin("read"), wrap((req, res) => res.json(Configuration.listConfig(db, tenantOf(req)))));
  const setConfig = wrap((req, res) => res.json(Configuration.setConfig(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip)));
  router.put("/config/:key", auth, canAdmin("update"), setConfig);
  router.patch("/config/:key", auth, canAdmin("update"), setConfig);

  // ── Domains & providers ───────────────────────────────────────────────────
  router.get("/domains", auth, canOverview("read"), wrap((req, res) => res.json({ items: Domains.domainCatalog(req.query.definition_code ? Definitions.getDefinition(db, tenantOf(req), req.query.definition_code) : null), source_module: Constants.SOURCE_MODULE })));
  router.get("/providers", auth, canOverview("read"), wrap((_req, res) => res.json({ items: Providers.listProviders(), source_module: Constants.SOURCE_MODULE })));

  // ── Definitions ───────────────────────────────────────────────────────────
  router.get("/definitions", auth, canDefinitions("read"), wrap((req, res) => res.json(Definitions.listDefinitions(db, tenantOf(req), query(req)))));
  router.post("/definitions", auth, canDefinitions("create"), wrap((req, res) => res.status(201).json(Definitions.createDefinition(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/definitions/summary", auth, canDefinitions("read"), wrap((req, res) => res.json(Definitions.definitionSummary(db, tenantOf(req)))));
  router.get("/definitions/:ref", auth, canDefinitions("read"), wrap((req, res) => res.json(Definitions.getDefinition(db, tenantOf(req), req.params.ref))));
  const updateDefinition = wrap((req, res) => res.json(Definitions.updateDefinition(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/definitions/:ref", auth, canDefinitions("update"), updateDefinition);
  router.patch("/definitions/:ref", auth, canDefinitions("update"), updateDefinition);
  router.post("/definitions/:ref/status", auth, canDefinitions("update"), wrap((req, res) => res.json(Definitions.setDefinitionStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.delete("/definitions/:ref", auth, canDefinitions("delete"), wrap((req, res) => res.json(Definitions.deleteDefinition(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Traceability rules ────────────────────────────────────────────────────
  router.get("/rules", auth, canDefinitions("read"), wrap((req, res) => res.json(Rules.listRules(db, tenantOf(req), query(req)))));
  router.post("/rules", auth, canDefinitions("create"), wrap((req, res) => res.status(201).json(Rules.createRule(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/rules/summary", auth, canDefinitions("read"), wrap((req, res) => res.json(Rules.ruleSummary(db, tenantOf(req)))));
  router.get("/rules/:ref", auth, canDefinitions("read"), wrap((req, res) => res.json(Rules.getRule(db, tenantOf(req), req.params.ref))));
  const updateRule = wrap((req, res) => res.json(Rules.updateRule(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/rules/:ref", auth, canDefinitions("update"), updateRule);
  router.patch("/rules/:ref", auth, canDefinitions("update"), updateRule);
  router.post("/rules/:ref/status", auth, canDefinitions("update"), wrap((req, res) => res.json(Rules.setRuleStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.delete("/rules/:ref", auth, canDefinitions("delete"), wrap((req, res) => res.json(Rules.deleteRule(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Explorer / traversal ──────────────────────────────────────────────────
  const traverse = wrap((req, res) => {
    const options = optionsOf(req.body || {}, req);
    const { result, definition } = Engine.executeTraversal(db, tenantOf(req), options, req.actor, { action: "TRAVERSAL" });
    res.json(Engine.publicGraph(result, definition));
  });
  router.post("/traverse", auth, canExplorer("execute"), traverse);
  router.get(
    "/traverse",
    auth,
    canExplorer("read"),
    wrap((req, res) => {
      const { result, definition } = Engine.executeTraversal(db, tenantOf(req), optionsOf(req.query, req), req.actor, { action: "TRAVERSAL" });
      res.json(Engine.publicGraph(result, definition));
    })
  );

  // ── Traceability ──────────────────────────────────────────────────────────
  const traceability = (matrix) =>
    wrap((req, res) => {
      const options = optionsOf(req.body || req.query, req);
      const output = matrix ? Traceability.traceabilityMatrix(db, tenantOf(req), options, req.actor) : Traceability.traceabilityGraph(db, tenantOf(req), options, req.actor);
      res.json(output);
    });
  router.post("/traceability", auth, canTraceability("read"), traceability(false));
  router.get("/traceability", auth, canTraceability("read"), traceability(false));
  router.post("/traceability/matrix", auth, canTraceability("read"), traceability(true));

  // ── Impact & dependency ───────────────────────────────────────────────────
  const impact = (direct) =>
    wrap((req, res) => {
      const options = optionsOf(req.body || req.query, req);
      res.json(direct ? Impact.directImpact(db, tenantOf(req), options, req.actor) : Impact.impactAnalysis(db, tenantOf(req), options, req.actor));
    });
  router.post("/impact", auth, canImpact("execute"), impact(false));
  router.get("/impact", auth, canImpact("read"), impact(false));
  router.post("/impact/direct", auth, canImpact("read"), impact(true));
  const dependency = (direct) =>
    wrap((req, res) => {
      const options = optionsOf(req.body || req.query, req);
      res.json(direct ? Dependency.directDependencyAnalysis(db, tenantOf(req), options, req.actor) : Dependency.dependencyAnalysis(db, tenantOf(req), options, req.actor));
    });
  router.post("/dependency", auth, canExplorer("execute"), dependency(false));
  router.get("/dependency", auth, canExplorer("read"), dependency(false));
  router.post("/dependency/direct", auth, canExplorer("read"), dependency(true));

  // ── Paths ─────────────────────────────────────────────────────────────────
  const paths = wrap((req, res) => {
    const source = req.body?.source ?? req.body?.from ?? req.query.source ?? req.query.from;
    const target = req.body?.target ?? req.body?.to ?? req.query.target ?? req.query.to;
    const options = { ...optionsOf(req.body || req.query, req), source, target };
    res.json(Paths.findPaths(db, tenantOf(req), options, req.actor));
  });
  router.post("/paths", auth, canPaths("execute"), paths);
  router.get("/paths", auth, canPaths("read"), paths);

  // ── Completeness ──────────────────────────────────────────────────────────
  const completeness = wrap((req, res) => res.json(Completeness.evaluateCompleteness(db, tenantOf(req), optionsOf(req.body || req.query, req), req.actor)));
  router.post("/completeness", auth, canCompleteness("execute"), completeness);
  router.get("/completeness", auth, canCompleteness("read"), completeness);

  // ── Snapshots ─────────────────────────────────────────────────────────────
  router.get("/snapshots", auth, canSnapshots("read"), wrap((req, res) => res.json(Snapshots.listSnapshots(db, tenantOf(req), query(req)))));
  router.post("/snapshots", auth, canSnapshots("create"), wrap((req, res) => res.status(201).json(Snapshots.createSnapshot(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/snapshots/summary", auth, canSnapshots("read"), wrap((req, res) => res.json(Snapshots.snapshotSummary(db, tenantOf(req)))));
  router.get("/snapshots/:ref", auth, canSnapshots("read"), wrap((req, res) => res.json(Snapshots.getSnapshot(db, tenantOf(req), req.params.ref, { includeNodes: req.query.include_nodes !== "false", includeEdges: req.query.include_edges !== "false" }))));
  router.get("/snapshots/:ref/graph", auth, canSnapshots("read"), wrap((req, res) => res.json(Snapshots.snapshotGraph(db, tenantOf(req), req.params.ref))));
  router.post("/snapshots/:ref/status", auth, canSnapshots("update"), wrap((req, res) => res.json(Snapshots.setSnapshotStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.delete("/snapshots/:ref", auth, canSnapshots("delete"), wrap((req, res) => res.json(Snapshots.deleteSnapshot(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Baselines ─────────────────────────────────────────────────────────────
  router.get("/baselines", auth, canBaselines("read"), wrap((req, res) => res.json(Baselines.listBaselines(db, tenantOf(req), query(req)))));
  router.post("/baselines", auth, canBaselines("create"), wrap((req, res) => res.status(201).json(Baselines.createBaseline(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/baselines/summary", auth, canBaselines("read"), wrap((req, res) => res.json(Baselines.baselineSummary(db, tenantOf(req)))));
  router.get("/baselines/:ref", auth, canBaselines("read"), wrap((req, res) => res.json(Baselines.getBaseline(db, tenantOf(req), req.params.ref, { includeMembers: req.query.include_members !== "false" }))));
  router.get("/baselines/:ref/members", auth, canBaselines("read"), wrap((req, res) => res.json({ items: Baselines.baselineMembers(db, Baselines.requireBaselineRow(db, tenantOf(req), req.params.ref).id) })));
  router.post("/baselines/:ref/release", auth, canBaselines("update"), wrap((req, res) => res.json(Baselines.releaseBaseline(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/baselines/:ref/freeze", auth, canBaselines("update"), wrap((req, res) => res.json(Baselines.freezeBaseline(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  const updateBaseline = wrap((req, res) => res.json(Baselines.updateBaseline(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/baselines/:ref", auth, canBaselines("update"), updateBaseline);
  router.patch("/baselines/:ref", auth, canBaselines("update"), updateBaseline);
  router.delete("/baselines/:ref", auth, canBaselines("delete"), wrap((req, res) => res.json(Baselines.deleteBaseline(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Compare ───────────────────────────────────────────────────────────────
  router.post(
    "/compare",
    auth,
    canCompare("read"),
    wrap((req, res) => {
      const body = req.body || {};
      res.json(
        Compare.compareProjections(
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
  router.post("/compare/snapshots", auth, canCompare("read"), wrap((req, res) => res.json(Compare.compareSnapshots(db, tenantOf(req), req.body || {}, req.actor))));
  router.post("/compare/baselines", auth, canCompare("read"), wrap((req, res) => res.json(Compare.compareBaselines(db, tenantOf(req), req.body || {}, req.actor))));

  // ── Projection ────────────────────────────────────────────────────────────
  router.get("/projections", auth, canOverview("read"), wrap((req, res) => res.json(Projection.listProjections(db, tenantOf(req), query(req)))));
  router.get("/projections/state", auth, canOverview("read"), wrap((req, res) => res.json(Projection.projectionState(db, tenantOf(req)))));
  router.get("/projections/health", auth, canMetrics("read"), wrap((req, res) => res.json(Projection.projectionHealth(db, tenantOf(req)))));
  router.get("/projections/:objectType/:objectId", auth, canOverview("read"), wrap((req, res) => res.json(Projection.getProjection(db, tenantOf(req), req.params.objectType, req.params.objectId))));
  router.post("/projections/rebuild", auth, canAdmin("execute"), wrap((req, res) => res.json(Projection.rebuildProjection(db, tenantOf(req), { objectTypes: req.body?.object_types ?? req.body?.objectTypes ?? null, actor: req.actor }))));

  // ── Search ────────────────────────────────────────────────────────────────
  router.post("/search/reindex", auth, canSearch("execute"), wrap((_req, res) => res.json({ registered: Search.registerThreadSources() })));
  router.get("/search-meta", auth, canSearch("read"), wrap((_req, res) => res.json({ object_types: Constants.SEARCH_OBJECT_TYPES })));

  // ── History & audit ───────────────────────────────────────────────────────
  router.get("/history", auth, canAudit("read"), wrap((req, res) => res.json(History.listHistory(db, query(req)))));
  router.get("/query-history", auth, canAudit("read"), wrap((req, res) => res.json(History.listQueryHistory(db, query(req)))));
  router.get("/history/:objectType/:objectId", auth, canAudit("read"), wrap((req, res) => res.json({ items: History.objectLineage(db, tenantOf(req), req.params.objectType, req.params.objectId) })));

  // ── Background jobs ───────────────────────────────────────────────────────
  router.post("/jobs/traverse", auth, canExplorer("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitTraversalJob(db, { tenantId: tenantOf(req), root: req.body?.root, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/impact", auth, canImpact("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitImpactJob(db, { tenantId: tenantOf(req), root: req.body?.root, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/paths", auth, canPaths("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitPathJob(db, { tenantId: tenantOf(req), source: req.body?.source, target: req.body?.target, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/snapshot", auth, canSnapshots("create"), wrap(async (req, res) => res.status(202).json(await Jobs.submitSnapshotJob(db, { tenantId: tenantOf(req), body: req.body || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/baseline", auth, canBaselines("create"), wrap(async (req, res) => res.status(202).json(await Jobs.submitBaselineJob(db, { tenantId: tenantOf(req), body: req.body || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/completeness", auth, canCompleteness("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitCompletenessJob(db, { tenantId: tenantOf(req), root: req.body?.root, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/reindex", auth, canSearch("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitReindexJob(db, { tenantId: tenantOf(req), objectTypes: req.body?.object_types ?? req.body?.objectTypes ?? null, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/projection-rebuild", auth, canAdmin("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitProjectionRebuildJob(db, { tenantId: tenantOf(req), objectTypes: req.body?.object_types ?? req.body?.objectTypes ?? null, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/maintenance", auth, canAdmin("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitMaintenanceJob(db, { tenantId: tenantOf(req), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));

  // ── Foundation & demo seed ────────────────────────────────────────────────
  router.post("/foundation/ensure", auth, canAdmin("execute"), wrap((_req, res) => res.json(Foundation.ensureThreadFoundation(db))));
  router.post("/seed", auth, canAdmin("execute"), wrap((req, res) => res.json(Seed.seedThread(db, tenantOf(req)))));

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
