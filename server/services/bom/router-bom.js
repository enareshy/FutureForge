// REST router for the P1 BOM Engine. Built as a factory so it reuses the
// application's auth, authorization and error middleware. Mounted at /api/bom and
// /api/v1/bom.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization.
//
// Read and write routes run on the asynchronous data path
// (`authAsync`/`*Async`). The shared Reference Data unit conversion helper and
// the search-meta route stay on the synchronous worker path. A single route
// never mixes the two layers except for those documented cross-module unit
// reads.
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

export function createBomRouter({ express, db, auth, can, authAsync, canAsync, wrap }) {
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

  const canOverviewAsync = (a) => canAsync(R.overview, a);
  const canBomsAsync = (a) => canAsync(R.boms, a);
  const canRevisionsAsync = (a) => canAsync(R.revisions, a);
  const canLinesAsync = (a) => canAsync(R.lines, a);
  const canStructureAsync = (a) => canAsync(R.structure, a);
  const canCompareAsync = (a) => canAsync(R.compare, a);
  const canWhereUsedAsync = (a) => canAsync(R.whereUsed, a);
  const canRollupAsync = (a) => canAsync(R.rollup, a);
  const canTransformationAsync = (a) => canAsync(R.transformation, a);
  const canValidationAsync = (a) => canAsync(R.validation, a);
  const canBaselineAsync = (a) => canAsync(R.baseline, a);
  const canAuditAsync = (a) => canAsync(R.auditTrail, a);
  const canMetricsAsync = (a) => canAsync(R.metrics, a);
  const canSearchAsync = (a) => canAsync(R.search, a);
  const canAdminAsync = (a) => canAsync(R.admin, a);

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
    authAsync,
    canMetricsAsync("read"),
    wrap(async (req, res) =>
      res.json({
        ...(await Metrics.healthCheckAsync(db, { tenantId: tenantOf(req) })),
        ...(await Foundation.bomHealthAsync(db, tenantOf(req))),
      })
    )
  );

  router.get(
    "/metrics",
    authAsync,
    canMetricsAsync("read"),
    wrap(async (req, res) => res.json(await Metrics.metricsSnapshotAsync(db, { tenantId: tenantOf(req), bomType: req.query.bom_type || req.query.bomType })))
  );

  router.get(
    "/compare-summary",
    authAsync,
    canMetricsAsync("read"),
    wrap(async (req, res) => res.json(await Metrics.compareSummaryAsync(db, { tenantId: tenantOf(req) })))
  );

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get(
    "/config",
    authAsync,
    canAsync(R.admin, "read"),
    wrap(async (req, res) => res.json(await Configuration.listConfigAsync(db, tenantOf(req))))
  );
  const setConfig = wrap(async (req, res) => res.json(await Configuration.setConfigAsync(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip)));
  router.put("/config/:key", authAsync, canAsync(R.admin, "update"), setConfig);
  router.patch("/config/:key", authAsync, canAsync(R.admin, "update"), setConfig);

  // ── Units (shared Reference Data domain) ──────────────────────────────────
  router.get(
    "/units",
    authAsync,
    canStructureAsync("read"),
    wrap(async (req, res) => res.json({ items: await Units.listUnitsAsync(db, { tenantId: tenantOf(req), q: req.query.q || null, limit: req.query.limit }) }))
  );
  router.get(
    "/units/convert",
    auth,
    canStructure("read"),
    wrap((req, res) => res.json(Units.convertValue(Number(req.query.value ?? 0), req.query.from, req.query.to)))
  );

  // ── BOM headers ───────────────────────────────────────────────────────────
  router.get("/boms", authAsync, canBomsAsync("read"), wrap(async (req, res) => res.json(await Definitions.listBomsAsync(db, query(req)))));
  router.post("/boms", authAsync, canBomsAsync("create"), wrap(async (req, res) => res.status(201).json(await Definitions.createBomAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/boms/:ref", authAsync, canBomsAsync("read"), wrap(async (req, res) => res.json(await Definitions.getBomAsync(db, tenantOf(req), req.params.ref))));
  const updateBom = wrap(async (req, res) => res.json(await Definitions.updateBomAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/boms/:ref", authAsync, canBomsAsync("update"), updateBom);
  router.patch("/boms/:ref", authAsync, canBomsAsync("update"), updateBom);
  router.post("/boms/:ref/status", authAsync, canBomsAsync("update"), wrap(async (req, res) => res.json(await Definitions.setBomStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.delete("/boms/:ref", authAsync, canBomsAsync("delete"), wrap(async (req, res) => res.json(await Definitions.deleteBomAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get(
    "/boms/:ref/audit",
    authAsync,
    canAuditAsync("read"),
    wrap(async (req, res) => {
      const ref = req.params.ref;
      const numeric = Number(ref);
      const scope = Number.isInteger(numeric) && String(numeric) === String(ref).trim() ? { entityId: numeric } : { entityRef: ref };
      return res.json(await Definitions.listBomAuditAsync(db, { tenantId: tenantOf(req), ...scope, ...req.query }));
    })
  );
  router.get("/boms/:ref/revisions", authAsync, canRevisionsAsync("read"), wrap(async (req, res) => res.json(await Revisions.listRevisionsAsync(db, { tenantId: tenantOf(req), bomRef: req.params.ref, ...req.query }))));
  router.post("/boms/:ref/revisions", authAsync, canRevisionsAsync("create"), wrap(async (req, res) => res.status(201).json(await Revisions.createRevisionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));

  // ── Revisions ─────────────────────────────────────────────────────────────
  router.get("/revisions", authAsync, canRevisionsAsync("read"), wrap(async (req, res) => res.json(await Revisions.listRevisionsAsync(db, query(req)))));
  router.get("/revisions/:ref", authAsync, canRevisionsAsync("read"), wrap(async (req, res) => res.json(await Revisions.getRevisionAsync(db, tenantOf(req), req.params.ref))));
  const updateRevision = wrap(async (req, res) => res.json(await Revisions.updateRevisionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/revisions/:ref", authAsync, canRevisionsAsync("update"), updateRevision);
  router.patch("/revisions/:ref", authAsync, canRevisionsAsync("update"), updateRevision);
  router.post("/revisions/:ref/status", authAsync, canRevisionsAsync("update"), wrap(async (req, res) => res.json(await Revisions.setRevisionStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.post("/revisions/:ref/revise", authAsync, canRevisionsAsync("create"), wrap(async (req, res) => res.status(201).json(await Revisions.reviseRevisionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));
  router.delete("/revisions/:ref", authAsync, canRevisionsAsync("delete"), wrap(async (req, res) => res.json(await Revisions.deleteRevisionAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  router.get("/revisions/:ref/tree", authAsync, canStructureAsync("read"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Structure.buildTreeAsync(db, tenantOf(req), revision.id, { includeInactive: req.query.include_inactive !== "false", maxDepth: req.query.max_depth }));
  }));
  router.get("/revisions/:ref/structure", authAsync, canStructureAsync("read"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.json({ items: await Structure.flatStructureAsync(db, tenantOf(req), revision.id, { includeInactive: req.query.include_inactive !== "false" }) });
  }));
  router.get("/revisions/:ref/lines", authAsync, canLinesAsync("read"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Lines.listLinesAsync(db, { tenantId: tenantOf(req), revisionId: revision.id, ...req.query }));
  }));
  router.post("/revisions/:ref/lines", authAsync, canLinesAsync("create"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.status(201).json(await Lines.addLineAsync(db, tenantOf(req), revision.id, req.body || {}, req.actor, req.ip));
  }));
  router.post("/revisions/:ref/lines/reorder", authAsync, canLinesAsync("update"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Lines.reorderLinesAsync(db, tenantOf(req), revision.id, req.body || {}, req.actor, req.ip));
  }));
  router.get("/revisions/:ref/substitutes", authAsync, canLinesAsync("read"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Substitutes.listSubstitutesAsync(db, { tenantId: tenantOf(req), revisionId: revision.id, ...req.query }));
  }));
  router.post("/revisions/:ref/substitutes", authAsync, canLinesAsync("create"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.status(201).json(await Substitutes.addSubstituteAsync(db, tenantOf(req), revision.id, req.body || {}, req.actor, req.ip));
  }));
  router.get("/revisions/:ref/substitutes/summary", authAsync, canLinesAsync("read"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Substitutes.substituteSummaryAsync(db, tenantOf(req), revision.id));
  }));

  router.post("/revisions/:ref/rollup", authAsync, canRollupAsync("execute"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Rollup.rollupAsync(db, tenantOf(req), revision.id, req.body || {}));
  }));
  router.get("/revisions/:ref/rollup", authAsync, canRollupAsync("execute"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Rollup.rollupAsync(db, tenantOf(req), revision.id, { includeOptional: req.query.include_optional === "true" }));
  }));
  router.post("/revisions/:ref/validate", authAsync, canValidationAsync("execute"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Validator.validateRevisionAsync(db, tenantOf(req), revision.id, { ...(req.body || {}), actor: req.actor }));
  }));
  router.get("/revisions/:ref/validation-results", authAsync, canValidationAsync("read"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Validator.listValidationResultsAsync(db, { tenantId: tenantOf(req), revisionId: revision.id, ...req.query }));
  }));

  // ── Lines ─────────────────────────────────────────────────────────────────
  router.get("/lines", authAsync, canLinesAsync("read"), wrap(async (req, res) => res.json(await Lines.listLinesAsync(db, query(req)))));
  router.get("/lines/:ref", authAsync, canLinesAsync("read"), wrap(async (req, res) => res.json(await Lines.getLineAsync(db, tenantOf(req), req.params.ref))));
  const updateLine = wrap(async (req, res) => {
    const row = await Lines.requireLineRowAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Lines.updateLineAsync(db, tenantOf(req), row.bom_revision_id, row.id, req.body || {}, req.actor, req.ip));
  });
  router.put("/lines/:ref", authAsync, canLinesAsync("update"), updateLine);
  router.patch("/lines/:ref", authAsync, canLinesAsync("update"), updateLine);
  router.delete("/lines/:ref", authAsync, canLinesAsync("delete"), wrap(async (req, res) => {
    const row = await Lines.requireLineRowAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Lines.removeLineAsync(db, tenantOf(req), row.bom_revision_id, row.id, req.actor, req.ip));
  }));
  router.get("/lines/:ref/attributes", authAsync, canLinesAsync("read"), wrap(async (req, res) => res.json({ items: await Lines.listLineAttributesAsync(db, tenantOf(req), req.params.ref) })));
  router.put("/lines/:ref/attributes", authAsync, canLinesAsync("update"), wrap(async (req, res) => {
    const attributes = Array.isArray(req.body) ? req.body : req.body?.attributes || req.body?.attributes_list || [];
    return res.json(await Lines.setLineAttributesAsync(db, tenantOf(req), req.params.ref, attributes, req.actor));
  }));

  // ── Substitutes ───────────────────────────────────────────────────────────
  router.get("/substitutes", authAsync, canLinesAsync("read"), wrap(async (req, res) => res.json(await Substitutes.listSubstitutesAsync(db, query(req)))));
  const updateSubstitute = wrap(async (req, res) => res.json(await Substitutes.updateSubstituteAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/substitutes/:ref", authAsync, canLinesAsync("update"), updateSubstitute);
  router.patch("/substitutes/:ref", authAsync, canLinesAsync("update"), updateSubstitute);
  router.delete("/substitutes/:ref", authAsync, canLinesAsync("delete"), wrap(async (req, res) => res.json(await Substitutes.removeSubstituteAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Where-used / uses ─────────────────────────────────────────────────────
  router.get("/where-used", authAsync, canWhereUsedAsync("read"), wrap(async (req, res) => res.json(await WhereUsed.whereUsedAsync(db, query(req)))));
  router.get("/where-used/:objectId", authAsync, canWhereUsedAsync("read"), wrap(async (req, res) => res.json(await WhereUsed.whereUsedAsync(db, { tenantId: tenantOf(req), objectId: req.params.objectId, ...req.query }))));
  router.post("/where-used/:objectId/multi-level", authAsync, canWhereUsedAsync("read"), wrap(async (req, res) => res.json(await WhereUsed.multiLevelWhereUsedAsync(db, tenantOf(req), req.params.objectId, req.body || {}))));
  router.get("/where-used/:objectId/summary", authAsync, canWhereUsedAsync("read"), wrap(async (req, res) => res.json(await WhereUsed.componentUsageSummaryAsync(db, tenantOf(req), req.params.objectId, { bomType: req.query.bom_type || req.query.bomType }))));
  router.get("/uses", authAsync, canWhereUsedAsync("read"), wrap(async (req, res) => res.json(await WhereUsed.usesAsync(db, query(req)))));

  // ── Comparisons ───────────────────────────────────────────────────────────
  router.post("/compare", authAsync, canCompareAsync("execute"), wrap(async (req, res) => res.status(201).json(await Compare.compareAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/comparisons", authAsync, canCompareAsync("read"), wrap(async (req, res) => res.json(await Compare.listComparisonsAsync(db, query(req)))));
  router.get("/comparisons/:ref", authAsync, canCompareAsync("read"), wrap(async (req, res) => res.json(await Compare.getComparisonAsync(db, tenantOf(req), req.params.ref))));
  router.get("/comparisons/:ref/results", authAsync, canCompareAsync("read"), wrap(async (req, res) => {
    const comparison = await Compare.getComparisonAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Compare.listComparisonResultsAsync(db, tenantOf(req), comparison.id, req.query));
  }));

  // ── Transformations ───────────────────────────────────────────────────────
  router.get("/transformations", authAsync, canTransformationAsync("read"), wrap(async (req, res) => res.json(await Transformation.listTransformationDefinitionsAsync(db, query(req)))));
  router.post("/transformations", authAsync, canTransformationAsync("create"), wrap(async (req, res) => res.status(201).json(await Transformation.createTransformationDefinitionAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/transformations/:ref", authAsync, canTransformationAsync("read"), wrap(async (req, res) => res.json(await Transformation.getTransformationDefinitionAsync(db, tenantOf(req), req.params.ref))));
  const updateTransformation = wrap(async (req, res) => res.json(await Transformation.updateTransformationDefinitionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/transformations/:ref", authAsync, canTransformationAsync("update"), updateTransformation);
  router.patch("/transformations/:ref", authAsync, canTransformationAsync("update"), updateTransformation);
  router.delete("/transformations/:ref", authAsync, canTransformationAsync("delete"), wrap(async (req, res) => res.json(await Transformation.deleteTransformationDefinitionAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get("/transformations/:ref/mappings", authAsync, canTransformationAsync("read"), wrap(async (req, res) => {
    const definition = await Transformation.requireTransformationDefinitionAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Transformation.listMappingsAsync(db, tenantOf(req), definition.id, req.query));
  }));
  router.post("/transformations/:ref/mappings", authAsync, canTransformationAsync("create"), wrap(async (req, res) => {
    const definition = await Transformation.requireTransformationDefinitionAsync(db, tenantOf(req), req.params.ref);
    return res.status(201).json(await Transformation.createMappingAsync(db, tenantOf(req), definition.id, req.body || {}, req.actor, req.ip));
  }));
  const updateMapping = wrap(async (req, res) => {
    const definition = await Transformation.requireTransformationDefinitionAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Transformation.updateMappingAsync(db, tenantOf(req), definition.id, req.params.mappingId, req.body || {}, req.actor, req.ip));
  });
  router.put("/transformations/:ref/mappings/:mappingId", authAsync, canTransformationAsync("update"), updateMapping);
  router.patch("/transformations/:ref/mappings/:mappingId", authAsync, canTransformationAsync("update"), updateMapping);
  router.delete("/transformations/:ref/mappings/:mappingId", authAsync, canTransformationAsync("delete"), wrap(async (req, res) => {
    const definition = await Transformation.requireTransformationDefinitionAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Transformation.deleteMappingAsync(db, tenantOf(req), definition.id, req.params.mappingId));
  }));
  router.post("/transform", authAsync, canTransformationAsync("execute"), wrap(async (req, res) => res.status(201).json(await Transformation.transformAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/transformation-runs", authAsync, canTransformationAsync("read"), wrap(async (req, res) => res.json(await Transformation.listTransformationRunsAsync(db, query(req)))));
  router.get("/transformation-runs/:ref", authAsync, canTransformationAsync("read"), wrap(async (req, res) => res.json(await Transformation.getTransformationRunAsync(db, tenantOf(req), req.params.ref))));

  // ── Validation rules & results ────────────────────────────────────────────
  router.get("/validation-rules", authAsync, canValidationAsync("read"), wrap(async (req, res) => res.json(await Validator.listValidationRulesAsync(db, query(req)))));
  router.post("/validation-rules", authAsync, canValidationAsync("create"), wrap(async (req, res) => res.status(201).json(await Validator.createValidationRuleAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  const updateRule = wrap(async (req, res) => res.json(await Validator.updateValidationRuleAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/validation-rules/:ref", authAsync, canValidationAsync("update"), updateRule);
  router.patch("/validation-rules/:ref", authAsync, canValidationAsync("update"), updateRule);
  router.delete("/validation-rules/:ref", authAsync, canValidationAsync("delete"), wrap(async (req, res) => res.json(await Validator.deleteValidationRuleAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get("/validation-results", authAsync, canValidationAsync("read"), wrap(async (req, res) => res.json(await Validator.listValidationResultsAsync(db, query(req)))));
  router.get("/validation-results/:ref", authAsync, canValidationAsync("read"), wrap(async (req, res) => {
    const result = await Validator.getValidationResultAsync(db, tenantOf(req), req.params.ref);
    if (!result) throw Errors.validationFailed({ ref: req.params.ref });
    return res.json({ ...result, issues: (await Validator.listValidationIssuesAsync(db, tenantOf(req), result.id, { pageSize: 10000 })).items });
  }));
  router.get("/validation-results/:ref/issues", authAsync, canValidationAsync("read"), wrap(async (req, res) => {
    const result = await Validator.getValidationResultAsync(db, tenantOf(req), req.params.ref);
    if (!result) throw Errors.validationFailed({ ref: req.params.ref });
    return res.json(await Validator.listValidationIssuesAsync(db, tenantOf(req), result.id, req.query));
  }));

  // ── Baselines ─────────────────────────────────────────────────────────────
  router.get("/baselines", authAsync, canBaselineAsync("read"), wrap(async (req, res) => res.json(await Baselines.listBaselinesAsync(db, query(req)))));
  router.post("/baselines", authAsync, canBaselineAsync("create"), wrap(async (req, res) => res.status(201).json(await Baselines.createBaselineAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/baselines/:ref", authAsync, canBaselineAsync("read"), wrap(async (req, res) => res.json(await Baselines.getBaselineAsync(db, tenantOf(req), req.params.ref))));
  router.get("/baselines/:ref/lines", authAsync, canBaselineAsync("read"), wrap(async (req, res) => res.json(await Baselines.listBaselineLinesAsync(db, tenantOf(req), req.params.ref, req.query))));
  router.get("/baselines/:ref/snapshot", authAsync, canBaselineAsync("read"), wrap(async (req, res) => res.json(await Baselines.baselineSnapshotAsync(db, tenantOf(req), req.params.ref))));
  router.post("/baselines/:ref/freeze", authAsync, canBaselineAsync("update"), wrap(async (req, res) => res.json(await Baselines.freezeBaselineAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.delete("/baselines/:ref", authAsync, canBaselineAsync("delete"), wrap(async (req, res) => res.json(await Baselines.deleteBaselineAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── History ───────────────────────────────────────────────────────────────
  router.get("/history", authAsync, canAuditAsync("read"), wrap(async (req, res) => res.json(await History.listHistoryAsync(db, query(req)))));
  router.get("/history/:objectType/:objectId", authAsync, canAuditAsync("read"), wrap(async (req, res) => res.json({ items: await History.objectLineageAsync(db, tenantOf(req), req.params.objectType, req.params.objectId) })));

  // ── Background jobs ───────────────────────────────────────────────────────
  router.post("/jobs/rollup", authAsync, canRollupAsync("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitRollupJobAsync(db, { tenantId: tenantOf(req), revisionId: req.body?.revision_id ?? req.body?.revisionId ?? req.body?.revision, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/where-used", authAsync, canWhereUsedAsync("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitWhereUsedJobAsync(db, { tenantId: tenantOf(req), objectId: req.body?.object_id ?? req.body?.objectId, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/transform", authAsync, canTransformationAsync("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitTransformJobAsync(db, { tenantId: tenantOf(req), body: req.body || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/validate", authAsync, canValidationAsync("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitValidateJobAsync(db, { tenantId: tenantOf(req), revisionId: req.body?.revision_id ?? req.body?.revisionId ?? req.body?.revision, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/compare", authAsync, canCompareAsync("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitCompareJobAsync(db, { tenantId: tenantOf(req), body: req.body || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/maintenance", authAsync, canAdminAsync("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitMaintenanceJobAsync(db, { tenantId: tenantOf(req), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));

  // ── Foundation & demo seed ────────────────────────────────────────────────
  router.post("/foundation/ensure", authAsync, canAdminAsync("execute"), wrap(async (_req, res) => res.json(await Foundation.ensureBomFoundationAsync(db))));
  router.post("/seed", authAsync, canAdminAsync("execute"), wrap(async (req, res) => res.json(await Seed.seedBomAsync(db, tenantOf(req)))));
  router.post("/search/reindex", authAsync, canSearchAsync("execute"), wrap((_req, res) => res.json({ registered: Search.registerBomSources() })));
  router.get("/search-meta", auth, canSearch("read"), wrap((_req, res) => res.json({ object_types: Constants.SEARCH_OBJECT_TYPES })));

  return router;
}
