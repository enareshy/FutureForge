// REST router for the P1 BOM Engine. Built as a factory so it reuses the
// application's auth, authorization and error middleware. Mounted at /api/bom and
// /api/v1/bom.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization.
import {
  Constants,
  Validation,
  Units,
  Configuration,
  Definitions,
  Revisions,
  Lines,
  Structure,
  Substitutes,
  WhereUsed,
  Rollup,
  Compare,
  Transformation,
  Validator,
  Baselines,
  Metrics,
  Jobs,
  Search,
  History,
  Foundation,
  Seed,
  Errors,
} from "./index.js";

const R = Constants.BOM_RESOURCES;

export function createBomRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";
  const query = (req) => ({ tenantId: tenantOf(req), ...req.query });

  const canOverview = (a) => can(R.overview, a);
  const canBoms = (a) => can(R.boms, a);
  const canRevisions = (a) => can(R.revisions, a);
  const canLines = (a) => can(R.lines, a);
  const canStructure = (a) => can(R.structure, a);
  const canCompare = (a) => can(R.compare, a);
  const canWhereUsed = (a) => can(R.whereUsed, a);
  const canRollup = (a) => can(R.rollup, a);
  const canTransformation = (a) => can(R.transformation, a);
  const canValidation = (a) => can(R.validation, a);
  const canBaseline = (a) => can(R.baseline, a);
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
        vocabularies: Validation.vocabulary(),
        security_actions: Constants.SECURITY_ACTIONS,
        resources: R,
        capabilities: {
          bom_types: Constants.BOM_TYPES,
          bom_statuses: Constants.BOM_STATUSES,
          revision_statuses: Constants.REVISION_STATUSES,
          revision_transitions: Constants.DEFAULT_REVISION_TRANSITIONS,
          line_statuses: Constants.LINE_STATUSES,
          usages: Constants.USAGES,
          baseline_statuses: Constants.BASELINE_STATUSES,
          mapping_types: Constants.MAPPING_TYPES,
          transformation_modes: Constants.TRANSFORMATION_MODES,
          transformation_statuses: Constants.TRANSFORMATION_STATUSES,
          transformation_definition_statuses: Constants.TRANSFORMATION_DEFINITION_STATUSES,
          change_types: Constants.CHANGE_TYPES,
          comparison_scopes: Constants.COMPARISON_SCOPES,
          comparison_kinds: Constants.COMPARISON_KINDS,
          rule_types: Constants.RULE_TYPES,
          rule_severities: Constants.RULE_SEVERITIES,
          validation_statuses: Constants.VALIDATION_STATUSES,
          search_types: Constants.SEARCH_OBJECT_TYPES.map((entry) => entry.code),
          job_types: Constants.BOM_JOB_TYPES.map((job) => job.code),
          handler_codes: Constants.BOM_HANDLER_CODES,
          config_defaults: Constants.CONFIG_DEFAULTS,
        },
      });
    })
  );

  router.get(
    "/health",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json({ ...Metrics.healthCheck(db, { tenantId: tenantOf(req) }), ...Foundation.bomHealth(db, tenantOf(req)) }))
  );

  router.get(
    "/metrics",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Metrics.metricsSnapshot(db, { tenantId: tenantOf(req), bomType: req.query.bom_type || req.query.bomType })))
  );

  router.get(
    "/compare-summary",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Metrics.compareSummary(db, { tenantId: tenantOf(req) })))
  );

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get(
    "/config",
    auth,
    canAdmin("read"),
    wrap((req, res) => res.json(Configuration.listConfig(db, tenantOf(req))))
  );
  const setConfig = wrap((req, res) => res.json(Configuration.setConfig(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip)));
  router.put("/config/:key", auth, canAdmin("update"), setConfig);
  router.patch("/config/:key", auth, canAdmin("update"), setConfig);

  // ── Units (shared Reference Data domain) ──────────────────────────────────
  router.get(
    "/units",
    auth,
    canStructure("read"),
    wrap((req, res) => res.json({ items: Units.listUnits(db, { tenantId: tenantOf(req), q: req.query.q || null, limit: req.query.limit }) }))
  );
  router.get(
    "/units/convert",
    auth,
    canStructure("read"),
    wrap((req, res) => res.json(Units.convertValue(Number(req.query.value ?? 0), req.query.from, req.query.to)))
  );

  // ── BOM headers ───────────────────────────────────────────────────────────
  router.get("/boms", auth, canBoms("read"), wrap((req, res) => res.json(Definitions.listBoms(db, query(req)))));
  router.post("/boms", auth, canBoms("create"), wrap((req, res) => res.status(201).json(Definitions.createBom(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/boms/:ref", auth, canBoms("read"), wrap((req, res) => res.json(Definitions.getBom(db, tenantOf(req), req.params.ref))));
  const updateBom = wrap((req, res) => res.json(Definitions.updateBom(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/boms/:ref", auth, canBoms("update"), updateBom);
  router.patch("/boms/:ref", auth, canBoms("update"), updateBom);
  router.post("/boms/:ref/status", auth, canBoms("update"), wrap((req, res) => res.json(Definitions.setBomStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.delete("/boms/:ref", auth, canBoms("delete"), wrap((req, res) => res.json(Definitions.deleteBom(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get(
    "/boms/:ref/audit",
    auth,
    canAudit("read"),
    wrap((req, res) => {
      const ref = req.params.ref;
      const numeric = Number(ref);
      const scope = Number.isInteger(numeric) && String(numeric) === String(ref).trim() ? { entityId: numeric } : { entityRef: ref };
      return res.json(Definitions.listBomAudit(db, { tenantId: tenantOf(req), ...scope, ...req.query }));
    })
  );
  router.get("/boms/:ref/revisions", auth, canRevisions("read"), wrap((req, res) => res.json(Revisions.listRevisions(db, { tenantId: tenantOf(req), bomRef: req.params.ref, ...req.query }))));
  router.post("/boms/:ref/revisions", auth, canRevisions("create"), wrap((req, res) => res.status(201).json(Revisions.createRevision(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));

  // ── Revisions ─────────────────────────────────────────────────────────────
  router.get("/revisions", auth, canRevisions("read"), wrap((req, res) => res.json(Revisions.listRevisions(db, query(req)))));
  router.get("/revisions/:ref", auth, canRevisions("read"), wrap((req, res) => res.json(Revisions.getRevision(db, tenantOf(req), req.params.ref))));
  const updateRevision = wrap((req, res) => res.json(Revisions.updateRevision(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/revisions/:ref", auth, canRevisions("update"), updateRevision);
  router.patch("/revisions/:ref", auth, canRevisions("update"), updateRevision);
  router.post("/revisions/:ref/status", auth, canRevisions("update"), wrap((req, res) => res.json(Revisions.setRevisionStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.post("/revisions/:ref/revise", auth, canRevisions("create"), wrap((req, res) => res.status(201).json(Revisions.reviseRevision(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));
  router.delete("/revisions/:ref", auth, canRevisions("delete"), wrap((req, res) => res.json(Revisions.deleteRevision(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  router.get("/revisions/:ref/tree", auth, canStructure("read"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.json(Structure.buildTree(db, tenantOf(req), revision.id, { includeInactive: req.query.include_inactive !== "false", maxDepth: req.query.max_depth }));
  }));
  router.get("/revisions/:ref/structure", auth, canStructure("read"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.json({ items: Structure.flatStructure(db, tenantOf(req), revision.id, { includeInactive: req.query.include_inactive !== "false" }) });
  }));
  router.get("/revisions/:ref/lines", auth, canLines("read"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.json(Lines.listLines(db, { tenantId: tenantOf(req), revisionId: revision.id, ...req.query }));
  }));
  router.post("/revisions/:ref/lines", auth, canLines("create"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.status(201).json(Lines.addLine(db, tenantOf(req), revision.id, req.body || {}, req.actor, req.ip));
  }));
  router.post("/revisions/:ref/lines/reorder", auth, canLines("update"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.json(Lines.reorderLines(db, tenantOf(req), revision.id, req.body || {}, req.actor, req.ip));
  }));
  router.get("/revisions/:ref/substitutes", auth, canLines("read"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.json(Substitutes.listSubstitutes(db, { tenantId: tenantOf(req), revisionId: revision.id, ...req.query }));
  }));
  router.post("/revisions/:ref/substitutes", auth, canLines("create"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.status(201).json(Substitutes.addSubstitute(db, tenantOf(req), revision.id, req.body || {}, req.actor, req.ip));
  }));
  router.get("/revisions/:ref/substitutes/summary", auth, canLines("read"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.json(Substitutes.substituteSummary(db, tenantOf(req), revision.id));
  }));

  router.post("/revisions/:ref/rollup", auth, canRollup("execute"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.json(Rollup.rollup(db, tenantOf(req), revision.id, req.body || {}));
  }));
  router.get("/revisions/:ref/rollup", auth, canRollup("execute"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.json(Rollup.rollup(db, tenantOf(req), revision.id, { includeOptional: req.query.include_optional === "true" }));
  }));
  router.post("/revisions/:ref/validate", auth, canValidation("execute"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.json(Validator.validateRevision(db, tenantOf(req), revision.id, { ...(req.body || {}), actor: req.actor }));
  }));
  router.get("/revisions/:ref/validation-results", auth, canValidation("read"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.json(Validator.listValidationResults(db, { tenantId: tenantOf(req), revisionId: revision.id, ...req.query }));
  }));

  // ── Lines ─────────────────────────────────────────────────────────────────
  router.get("/lines", auth, canLines("read"), wrap((req, res) => res.json(Lines.listLines(db, query(req)))));
  router.get("/lines/:ref", auth, canLines("read"), wrap((req, res) => res.json(Lines.getLine(db, tenantOf(req), req.params.ref))));
  const updateLine = wrap((req, res) => {
    const row = Lines.requireLineRow(db, tenantOf(req), req.params.ref);
    return res.json(Lines.updateLine(db, tenantOf(req), row.bom_revision_id, row.id, req.body || {}, req.actor, req.ip));
  });
  router.put("/lines/:ref", auth, canLines("update"), updateLine);
  router.patch("/lines/:ref", auth, canLines("update"), updateLine);
  router.delete("/lines/:ref", auth, canLines("delete"), wrap((req, res) => {
    const row = Lines.requireLineRow(db, tenantOf(req), req.params.ref);
    return res.json(Lines.removeLine(db, tenantOf(req), row.bom_revision_id, row.id, req.actor, req.ip));
  }));
  router.get("/lines/:ref/attributes", auth, canLines("read"), wrap((req, res) => res.json({ items: Lines.listLineAttributes(db, tenantOf(req), req.params.ref) })));
  router.put("/lines/:ref/attributes", auth, canLines("update"), wrap((req, res) => {
    const attributes = Array.isArray(req.body) ? req.body : req.body?.attributes || req.body?.attributes_list || [];
    return res.json(Lines.setLineAttributes(db, tenantOf(req), req.params.ref, attributes, req.actor));
  }));

  // ── Substitutes ───────────────────────────────────────────────────────────
  router.get("/substitutes", auth, canLines("read"), wrap((req, res) => res.json(Substitutes.listSubstitutes(db, query(req)))));
  const updateSubstitute = wrap((req, res) => res.json(Substitutes.updateSubstitute(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/substitutes/:ref", auth, canLines("update"), updateSubstitute);
  router.patch("/substitutes/:ref", auth, canLines("update"), updateSubstitute);
  router.delete("/substitutes/:ref", auth, canLines("delete"), wrap((req, res) => res.json(Substitutes.removeSubstitute(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Where-used / uses ─────────────────────────────────────────────────────
  router.get("/where-used", auth, canWhereUsed("read"), wrap((req, res) => res.json(WhereUsed.whereUsed(db, query(req)))));
  router.get("/where-used/:objectId", auth, canWhereUsed("read"), wrap((req, res) => res.json(WhereUsed.whereUsed(db, { tenantId: tenantOf(req), objectId: req.params.objectId, ...req.query }))));
  router.post("/where-used/:objectId/multi-level", auth, canWhereUsed("read"), wrap((req, res) => res.json(WhereUsed.multiLevelWhereUsed(db, tenantOf(req), req.params.objectId, req.body || {}))));
  router.get("/where-used/:objectId/summary", auth, canWhereUsed("read"), wrap((req, res) => res.json(WhereUsed.componentUsageSummary(db, tenantOf(req), req.params.objectId, { bomType: req.query.bom_type || req.query.bomType }))));
  router.get("/uses", auth, canWhereUsed("read"), wrap((req, res) => res.json(WhereUsed.uses(db, query(req)))));

  // ── Comparisons ───────────────────────────────────────────────────────────
  router.post("/compare", auth, canCompare("execute"), wrap((req, res) => res.status(201).json(Compare.compare(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/comparisons", auth, canCompare("read"), wrap((req, res) => res.json(Compare.listComparisons(db, query(req)))));
  router.get("/comparisons/:ref", auth, canCompare("read"), wrap((req, res) => res.json(Compare.getComparison(db, tenantOf(req), req.params.ref))));
  router.get("/comparisons/:ref/results", auth, canCompare("read"), wrap((req, res) => {
    const comparison = Compare.getComparison(db, tenantOf(req), req.params.ref);
    return res.json(Compare.listComparisonResults(db, tenantOf(req), comparison.id, req.query));
  }));

  // ── Transformations ───────────────────────────────────────────────────────
  router.get("/transformations", auth, canTransformation("read"), wrap((req, res) => res.json(Transformation.listTransformationDefinitions(db, query(req)))));
  router.post("/transformations", auth, canTransformation("create"), wrap((req, res) => res.status(201).json(Transformation.createTransformationDefinition(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/transformations/:ref", auth, canTransformation("read"), wrap((req, res) => res.json(Transformation.getTransformationDefinition(db, tenantOf(req), req.params.ref))));
  const updateTransformation = wrap((req, res) => res.json(Transformation.updateTransformationDefinition(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/transformations/:ref", auth, canTransformation("update"), updateTransformation);
  router.patch("/transformations/:ref", auth, canTransformation("update"), updateTransformation);
  router.delete("/transformations/:ref", auth, canTransformation("delete"), wrap((req, res) => res.json(Transformation.deleteTransformationDefinition(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get("/transformations/:ref/mappings", auth, canTransformation("read"), wrap((req, res) => {
    const definition = Transformation.requireTransformationDefinition(db, tenantOf(req), req.params.ref);
    return res.json(Transformation.listMappings(db, tenantOf(req), definition.id, req.query));
  }));
  router.post("/transformations/:ref/mappings", auth, canTransformation("create"), wrap((req, res) => {
    const definition = Transformation.requireTransformationDefinition(db, tenantOf(req), req.params.ref);
    return res.status(201).json(Transformation.createMapping(db, tenantOf(req), definition.id, req.body || {}, req.actor, req.ip));
  }));
  const updateMapping = wrap((req, res) => {
    const definition = Transformation.requireTransformationDefinition(db, tenantOf(req), req.params.ref);
    return res.json(Transformation.updateMapping(db, tenantOf(req), definition.id, req.params.mappingId, req.body || {}, req.actor, req.ip));
  });
  router.put("/transformations/:ref/mappings/:mappingId", auth, canTransformation("update"), updateMapping);
  router.patch("/transformations/:ref/mappings/:mappingId", auth, canTransformation("update"), updateMapping);
  router.delete("/transformations/:ref/mappings/:mappingId", auth, canTransformation("delete"), wrap((req, res) => {
    const definition = Transformation.requireTransformationDefinition(db, tenantOf(req), req.params.ref);
    return res.json(Transformation.deleteMapping(db, tenantOf(req), definition.id, req.params.mappingId));
  }));
  router.post("/transform", auth, canTransformation("execute"), wrap((req, res) => res.status(201).json(Transformation.transform(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/transformation-runs", auth, canTransformation("read"), wrap((req, res) => res.json(Transformation.listTransformationRuns(db, query(req)))));
  router.get("/transformation-runs/:ref", auth, canTransformation("read"), wrap((req, res) => res.json(Transformation.getTransformationRun(db, tenantOf(req), req.params.ref))));

  // ── Validation rules & results ────────────────────────────────────────────
  router.get("/validation-rules", auth, canValidation("read"), wrap((req, res) => res.json(Validator.listValidationRules(db, query(req)))));
  router.post("/validation-rules", auth, canValidation("create"), wrap((req, res) => res.status(201).json(Validator.createValidationRule(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  const updateRule = wrap((req, res) => res.json(Validator.updateValidationRule(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/validation-rules/:ref", auth, canValidation("update"), updateRule);
  router.patch("/validation-rules/:ref", auth, canValidation("update"), updateRule);
  router.delete("/validation-rules/:ref", auth, canValidation("delete"), wrap((req, res) => res.json(Validator.deleteValidationRule(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get("/validation-results", auth, canValidation("read"), wrap((req, res) => res.json(Validator.listValidationResults(db, query(req)))));
  router.get("/validation-results/:ref", auth, canValidation("read"), wrap((req, res) => {
    const result = Validator.getValidationResult(db, tenantOf(req), req.params.ref);
    if (!result) throw Errors.validationFailed({ ref: req.params.ref });
    return res.json({ ...result, issues: Validator.listValidationIssues(db, tenantOf(req), result.id, { pageSize: 10000 }).items });
  }));
  router.get("/validation-results/:ref/issues", auth, canValidation("read"), wrap((req, res) => {
    const result = Validator.getValidationResult(db, tenantOf(req), req.params.ref);
    if (!result) throw Errors.validationFailed({ ref: req.params.ref });
    return res.json(Validator.listValidationIssues(db, tenantOf(req), result.id, req.query));
  }));

  // ── Baselines ─────────────────────────────────────────────────────────────
  router.get("/baselines", auth, canBaseline("read"), wrap((req, res) => res.json(Baselines.listBaselines(db, query(req)))));
  router.post("/baselines", auth, canBaseline("create"), wrap((req, res) => res.status(201).json(Baselines.createBaseline(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/baselines/:ref", auth, canBaseline("read"), wrap((req, res) => res.json(Baselines.getBaseline(db, tenantOf(req), req.params.ref))));
  router.get("/baselines/:ref/lines", auth, canBaseline("read"), wrap((req, res) => res.json(Baselines.listBaselineLines(db, tenantOf(req), req.params.ref, req.query))));
  router.get("/baselines/:ref/snapshot", auth, canBaseline("read"), wrap((req, res) => res.json(Baselines.baselineSnapshot(db, tenantOf(req), req.params.ref))));
  router.post("/baselines/:ref/freeze", auth, canBaseline("update"), wrap((req, res) => res.json(Baselines.freezeBaseline(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.delete("/baselines/:ref", auth, canBaseline("delete"), wrap((req, res) => res.json(Baselines.deleteBaseline(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── History ───────────────────────────────────────────────────────────────
  router.get("/history", auth, canAudit("read"), wrap((req, res) => res.json(History.listHistory(db, query(req)))));
  router.get("/history/:objectType/:objectId", auth, canAudit("read"), wrap((req, res) => res.json({ items: History.objectLineage(db, tenantOf(req), req.params.objectType, req.params.objectId) })));

  // ── Background jobs ───────────────────────────────────────────────────────
  router.post("/jobs/rollup", auth, canRollup("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitRollupJob(db, { tenantId: tenantOf(req), revisionId: req.body?.revision_id ?? req.body?.revisionId ?? req.body?.revision, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/where-used", auth, canWhereUsed("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitWhereUsedJob(db, { tenantId: tenantOf(req), objectId: req.body?.object_id ?? req.body?.objectId, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/transform", auth, canTransformation("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitTransformJob(db, { tenantId: tenantOf(req), body: req.body || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/validate", auth, canValidation("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitValidateJob(db, { tenantId: tenantOf(req), revisionId: req.body?.revision_id ?? req.body?.revisionId ?? req.body?.revision, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/compare", auth, canCompare("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitCompareJob(db, { tenantId: tenantOf(req), body: req.body || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/maintenance", auth, canAdmin("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitMaintenanceJob(db, { tenantId: tenantOf(req), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));

  // ── Foundation & demo seed ────────────────────────────────────────────────
  router.post("/foundation/ensure", auth, canAdmin("execute"), wrap((_req, res) => res.json(Foundation.ensureBomFoundation(db))));
  router.post("/seed", auth, canAdmin("execute"), wrap((req, res) => res.json(Seed.seedBom(db, tenantOf(req)))));
  router.post("/search/reindex", auth, canSearch("execute"), wrap((_req, res) => res.json({ registered: Search.registerBomSources() })));
  router.get("/search-meta", auth, canSearch("read"), wrap((_req, res) => res.json({ object_types: Constants.SEARCH_OBJECT_TYPES })));

  return router;
}
