// REST router for the P1 PDM domain. Built as a factory so it reuses the
// application's auth, authorization and error middleware. Mounted at /api/pdm
// and /api/v1/pdm.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization.
import {
  Constants,
  Validation,
  Items,
  Revisions,
  Datasets,
  Representations,
  DesignData,
  Cad,
  RevisionRules,
  ConfigurationRules,
  Baselines,
  Relationships,
  References,
  WhereUsed,
  WhereReferenced,
  Structure,
  Validator,
  Configuration,
  Metrics,
  Jobs,
  Search,
  History,
  Foundation,
  Seed,
} from "./index.js";

const R = Constants.PDM_RESOURCES;

export function createPdmRouter({ express, db, auth, can, authAsync, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";
  const query = (req) => ({ tenantId: tenantOf(req), ...req.query });

  const canOverview = (a) => can(R.overview, a);
  const canItems = (a) => can(R.items, a);
  const canRevisions = (a) => can(R.revisions, a);
  const canParts = (a) => can(R.parts, a);
  const canProducts = (a) => can(R.products, a);
  const canDatasets = (a) => can(R.datasets, a);
  const canRepresentations = (a) => can(R.representations, a);
  const canDesignData = (a) => can(R.designData, a);
  const canCad = (a) => can(R.cad, a);
  const canRevisionRules = (a) => can(R.revisionRules, a);
  const canConfigurationRules = (a) => can(R.configurationRules, a);
  const canBaseline = (a) => can(R.baselines, a);
  const canWhereUsed = (a) => can(R.whereUsed, a);
  const canWhereReferenced = (a) => can(R.whereReferenced, a);
  const canStructure = (a) => can(R.structure, a);
  const canValidation = (a) => can(R.validation, a);
  const canSearch = (a) => can(R.search, a);
  const canAudit = (a) => can(R.auditTrail, a);
  const canMetrics = (a) => can(R.metrics, a);
  const canAdmin = (a) => can(R.admin, a);

  const canOverviewAsync = (a) => canAsync(R.overview, a);
  const canItemsAsync = (a) => canAsync(R.items, a);
  const canRevisionsAsync = (a) => canAsync(R.revisions, a);
  const canPartsAsync = (a) => canAsync(R.parts, a);
  const canProductsAsync = (a) => canAsync(R.products, a);
  const canDatasetsAsync = (a) => canAsync(R.datasets, a);
  const canRepresentationsAsync = (a) => canAsync(R.representations, a);
  const canDesignDataAsync = (a) => canAsync(R.designData, a);
  const canCadAsync = (a) => canAsync(R.cad, a);
  const canRevisionRulesAsync = (a) => canAsync(R.revisionRules, a);
  const canConfigurationRulesAsync = (a) => canAsync(R.configurationRules, a);
  const canBaselineAsync = (a) => canAsync(R.baselines, a);
  const canWhereUsedAsync = (a) => canAsync(R.whereUsed, a);
  const canWhereReferencedAsync = (a) => canAsync(R.whereReferenced, a);
  const canStructureAsync = (a) => canAsync(R.structure, a);
  const canValidationAsync = (a) => canAsync(R.validation, a);
  const canSearchAsync = (a) => canAsync(R.search, a);
  const canAuditAsync = (a) => canAsync(R.auditTrail, a);
  const canMetricsAsync = (a) => canAsync(R.metrics, a);
  const canAdminAsync = (a) => canAsync(R.admin, a);

  // ── Meta, health, metrics ─────────────────────────────────────────────────
  router.get(
    "/meta",
    authAsync,
    canOverviewAsync("read"),
    wrap((_req, res) => {
      res.json({
        source_module: Constants.SOURCE_MODULE,
        vocabulary: Validation.vocabulary(),
        security_actions: Constants.SECURITY_ACTIONS,
        resources: R,
        capabilities: {
          item_types: Constants.ITEM_TYPES,
          item_statuses: Constants.ITEM_STATUSES,
          revision_statuses: Constants.REVISION_STATUSES,
          immutable_revision_statuses: Constants.IMMUTABLE_REVISION_STATUSES,
          dataset_types: Constants.DATASET_TYPES,
          dataset_statuses: Constants.DATASET_STATUSES,
          representation_types: Constants.REPRESENTATION_TYPES,
          design_data_types: Constants.DESIGN_DATA_TYPES,
          cad_association_types: Constants.CAD_ASSOCIATION_TYPES,
          cad_types: Constants.CAD_TYPES,
          cad_association_statuses: Constants.CAD_ASSOCIATION_STATUSES,
          revision_rule_types: Constants.REVISION_RULE_TYPES,
          configuration_rule_types: Constants.CONFIGURATION_RULE_TYPES,
          rule_statuses: Constants.RULE_STATUSES,
          configuration_operators: Constants.CONFIGURATION_OPERATORS,
          baseline_statuses: Constants.BASELINE_STATUSES,
          relationship_types: Constants.RELATIONSHIP_TYPES,
          relationship_statuses: Constants.RELATIONSHIP_STATUSES,
          relationship_directions: Constants.RELATIONSHIP_DIRECTIONS,
          reference_categories: Constants.REFERENCE_CATEGORIES,
          rule_types: Constants.RULE_TYPES,
          rule_severities: Constants.RULE_SEVERITIES,
          validation_scopes: Constants.VALIDATION_SCOPES,
          validation_statuses: Constants.VALIDATION_STATUSES,
          search_types: Constants.SEARCH_OBJECT_TYPES.map((entry) => entry.code),
          job_types: Constants.PDM_JOB_TYPES.map((job) => job.code),
          handler_codes: Constants.PDM_HANDLER_CODES,
          config_defaults: Constants.CONFIG_DEFAULTS,
        },
      });
    })
  );

  router.get(
    "/health",
    authAsync,
    canMetricsAsync("read"),
    wrap(async (req, res) => res.json({ ...(await Metrics.healthCheckAsync(db, { tenantId: tenantOf(req) })), ...(await Foundation.pdmHealthAsync(db, tenantOf(req))) }))
  );
  router.get("/metrics", authAsync, canMetricsAsync("read"), wrap(async (req, res) => res.json(await Metrics.metricsSnapshotAsync(db, { tenantId: tenantOf(req) }))));
  router.get("/rule-usage", authAsync, canMetricsAsync("read"), wrap(async (req, res) => res.json(await Metrics.ruleUsageStatsAsync(db, { tenantId: tenantOf(req) }))));

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get("/config", authAsync, canAdminAsync("read"), wrap(async (req, res) => res.json(await Configuration.listConfigAsync(db, tenantOf(req)))));
  const setConfig = wrap(async (req, res) => res.json(await Configuration.setConfigAsync(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip)));
  router.put("/config/:key", authAsync, canAdminAsync("update"), setConfig);
  router.patch("/config/:key", authAsync, canAdminAsync("update"), setConfig);

  // ── Items ─────────────────────────────────────────────────────────────────
  router.get("/items", authAsync, canItemsAsync("read"), wrap(async (req, res) => res.json(await Items.listItemsAsync(db, query(req)))));
  router.post("/items", authAsync, canItemsAsync("create"), wrap(async (req, res) => res.status(201).json(await Items.createItemAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/items/:ref", authAsync, canItemsAsync("read"), wrap(async (req, res) => res.json(await Items.getItemAsync(db, tenantOf(req), req.params.ref))));
  const updateItem = wrap(async (req, res) => res.json(await Items.updateItemAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/items/:ref", authAsync, canItemsAsync("update"), updateItem);
  router.patch("/items/:ref", authAsync, canItemsAsync("update"), updateItem);
  router.post("/items/:ref/status", authAsync, canItemsAsync("update"), wrap(async (req, res) => res.json(await Items.setItemStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.delete("/items/:ref", authAsync, canItemsAsync("delete"), wrap(async (req, res) => res.json(await Items.deleteItemAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get(
    "/items/:ref/audit",
    authAsync,
    canAuditAsync("read"),
    wrap(async (req, res) => {
      const ref = req.params.ref;
      const numeric = Number(ref);
      const scope = Number.isInteger(numeric) && String(numeric) === String(ref).trim() ? { entityId: numeric } : { entityRef: ref };
      return res.json(await Items.listItemAuditAsync(db, { tenantId: tenantOf(req), ...scope, ...req.query }));
    })
  );
  router.get("/items/:ref/revisions", authAsync, canRevisionsAsync("read"), wrap(async (req, res) => res.json(await Revisions.listRevisionsAsync(db, { tenantId: tenantOf(req), itemRef: req.params.ref, ...req.query }))));
  router.post("/items/:ref/revisions", authAsync, canRevisionsAsync("create"), wrap(async (req, res) => res.status(201).json(await Revisions.createRevisionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));
  router.get("/items/:ref/structure", authAsync, canStructureAsync("read"), wrap(async (req, res) => res.json(await Structure.resolveStructureAsync(db, tenantOf(req), { itemRef: req.params.ref, maxDepth: req.query.max_depth, revisionRuleId: req.query.revision_rule_id ?? null, ruleCode: req.query.rule_code ?? null, context: contextOf(req) }))));
  router.get("/items/:ref/where-used", authAsync, canWhereUsedAsync("read"), wrap(async (req, res) => res.json(await WhereUsed.whereUsedAsync(db, tenantOf(req), req.params.ref, { recursive: req.query.recursive !== "false", maxDepth: req.query.max_depth, actor: req.actor }))));
  router.get("/items/:ref/datasets", authAsync, canDatasetsAsync("read"), wrap(async (req, res) => {
    const item = await Items.requireItemRowAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Datasets.listDatasetsAsync(db, { tenantId: tenantOf(req), itemId: item.id, ...req.query }));
  }));

  // ── Parts & products (semantic views over items) ─────────────────────────
  router.get("/parts", authAsync, canPartsAsync("read"), wrap(async (req, res) => res.json(await Items.listItemsAsync(db, { tenantId: tenantOf(req), ...req.query, itemType: "PART" }))));
  router.post("/parts", authAsync, canPartsAsync("create"), wrap(async (req, res) => res.status(201).json(await Items.createItemAsync(db, tenantOf(req), { ...(req.body || {}), item_type: "PART" }, req.actor, req.ip))));
  router.get("/products", authAsync, canProductsAsync("read"), wrap(async (req, res) => res.json(await Items.listItemsAsync(db, { tenantId: tenantOf(req), ...req.query, itemType: "PRODUCT" }))));
  router.post("/products", authAsync, canProductsAsync("create"), wrap(async (req, res) => res.status(201).json(await Items.createItemAsync(db, tenantOf(req), { ...(req.body || {}), item_type: "PRODUCT" }, req.actor, req.ip))));

  // ── Revisions ─────────────────────────────────────────────────────────────
  router.get("/revisions", authAsync, canRevisionsAsync("read"), wrap(async (req, res) => res.json(await Revisions.listRevisionsAsync(db, query(req)))));
  router.get("/revisions/:ref", authAsync, canRevisionsAsync("read"), wrap(async (req, res) => res.json(await Revisions.getRevisionAsync(db, tenantOf(req), req.params.ref))));
  const updateRevision = wrap(async (req, res) => res.json(await Revisions.updateRevisionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/revisions/:ref", authAsync, canRevisionsAsync("update"), updateRevision);
  router.patch("/revisions/:ref", authAsync, canRevisionsAsync("update"), updateRevision);
  router.post("/revisions/:ref/status", authAsync, canRevisionsAsync("update"), wrap(async (req, res) => res.json(await Revisions.setRevisionStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.post("/revisions/:ref/revise", authAsync, canRevisionsAsync("create"), wrap(async (req, res) => res.status(201).json(await Revisions.reviseRevisionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));
  router.delete("/revisions/:ref", authAsync, canRevisionsAsync("delete"), wrap(async (req, res) => res.json(await Revisions.deleteRevisionAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/revisions/:ref/validate", authAsync, canValidationAsync("execute"), wrap(async (req, res) => res.json(await Validator.validateRevisionAsync(db, tenantOf(req), req.params.ref, { actor: req.actor }))));
  router.get("/revisions/:ref/validation-results", authAsync, canValidationAsync("read"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Validator.listValidationResultsAsync(db, { tenantId: tenantOf(req), revisionId: revision.id, ...req.query }));
  }));
  router.get("/revisions/:ref/datasets", authAsync, canDatasetsAsync("read"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.json({ items: await Datasets.datasetsForRevisionAsync(db, tenantOf(req), revision.id) });
  }));
  router.post("/revisions/:ref/datasets", authAsync, canDatasetsAsync("create"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.status(201).json(await Datasets.createDatasetAsync(db, tenantOf(req), { ...(req.body || {}), item_id: revision.item_id, revision_id: revision.id }, req.actor, req.ip));
  }));
  router.get("/revisions/:ref/representations", authAsync, canRepresentationsAsync("read"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.json({ items: await Representations.representationsForRevisionAsync(db, tenantOf(req), revision.id) });
  }));
  router.post("/revisions/:ref/representations", authAsync, canRepresentationsAsync("create"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.status(201).json(await Representations.createRepresentationAsync(db, tenantOf(req), { ...(req.body || {}), item_id: revision.item_id, revision_id: revision.id }, req.actor, req.ip));
  }));
  router.get("/revisions/:ref/design-data", authAsync, canDesignDataAsync("read"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.json({ items: await DesignData.designDataForRevisionAsync(db, tenantOf(req), revision.id) });
  }));
  router.post("/revisions/:ref/design-data", authAsync, canDesignDataAsync("create"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.status(201).json(await DesignData.createDesignDataAsync(db, tenantOf(req), { ...(req.body || {}), item_id: revision.item_id, revision_id: revision.id }, req.actor, req.ip));
  }));
  router.get("/revisions/:ref/cad", authAsync, canCadAsync("read"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.json({ items: await Cad.cadAssociationsForRevisionAsync(db, tenantOf(req), revision.id) });
  }));
  router.post("/revisions/:ref/cad", authAsync, canCadAsync("create"), wrap(async (req, res) => {
    const revision = await Revisions.requireRevisionRowAsync(db, tenantOf(req), req.params.ref);
    return res.status(201).json(await Cad.createCadAssociationAsync(db, tenantOf(req), { ...(req.body || {}), item_id: revision.item_id, source_revision_id: revision.id }, req.actor, req.ip));
  }));

  // ── Datasets ──────────────────────────────────────────────────────────────
  router.get("/datasets", authAsync, canDatasetsAsync("read"), wrap(async (req, res) => res.json(await Datasets.listDatasetsAsync(db, query(req)))));
  router.post("/datasets", authAsync, canDatasetsAsync("create"), wrap(async (req, res) => res.status(201).json(await Datasets.createDatasetAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/datasets/:ref", authAsync, canDatasetsAsync("read"), wrap(async (req, res) => res.json(await Datasets.getDatasetAsync(db, tenantOf(req), req.params.ref))));
  const updateDataset = wrap(async (req, res) => res.json(await Datasets.updateDatasetAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/datasets/:ref", authAsync, canDatasetsAsync("update"), updateDataset);
  router.patch("/datasets/:ref", authAsync, canDatasetsAsync("update"), updateDataset);
  router.post("/datasets/:ref/status", authAsync, canDatasetsAsync("update"), wrap(async (req, res) => res.json(await Datasets.setDatasetStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.post("/datasets/:ref/content", authAsync, canDatasetsAsync("update"), wrap(async (req, res) => res.json(await Datasets.linkDatasetContentAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));
  router.delete("/datasets/:ref", authAsync, canDatasetsAsync("delete"), wrap(async (req, res) => res.json(await Datasets.deleteDatasetAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Representations ───────────────────────────────────────────────────────
  router.get("/representations", authAsync, canRepresentationsAsync("read"), wrap(async (req, res) => res.json(await Representations.listRepresentationsAsync(db, query(req)))));
  router.post("/representations", authAsync, canRepresentationsAsync("create"), wrap(async (req, res) => res.status(201).json(await Representations.createRepresentationAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/representations/:ref", authAsync, canRepresentationsAsync("read"), wrap(async (req, res) => res.json(await Representations.getRepresentationAsync(db, tenantOf(req), req.params.ref))));
  const updateRepresentation = wrap(async (req, res) => res.json(await Representations.updateRepresentationAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/representations/:ref", authAsync, canRepresentationsAsync("update"), updateRepresentation);
  router.patch("/representations/:ref", authAsync, canRepresentationsAsync("update"), updateRepresentation);
  router.delete("/representations/:ref", authAsync, canRepresentationsAsync("delete"), wrap(async (req, res) => res.json(await Representations.deleteRepresentationAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Design data ───────────────────────────────────────────────────────────
  router.get("/design-data", authAsync, canDesignDataAsync("read"), wrap(async (req, res) => res.json(await DesignData.listDesignDataAsync(db, query(req)))));
  router.post("/design-data", authAsync, canDesignDataAsync("create"), wrap(async (req, res) => res.status(201).json(await DesignData.createDesignDataAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/design-data/:ref", authAsync, canDesignDataAsync("read"), wrap(async (req, res) => res.json(await DesignData.getDesignDataAsync(db, tenantOf(req), req.params.ref))));
  const updateDesignData = wrap(async (req, res) => res.json(await DesignData.updateDesignDataAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/design-data/:ref", authAsync, canDesignDataAsync("update"), updateDesignData);
  router.patch("/design-data/:ref", authAsync, canDesignDataAsync("update"), updateDesignData);
  router.delete("/design-data/:ref", authAsync, canDesignDataAsync("delete"), wrap(async (req, res) => res.json(await DesignData.deleteDesignDataAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── CAD associations ──────────────────────────────────────────────────────
  router.get("/cad-associations", authAsync, canCadAsync("read"), wrap(async (req, res) => res.json(await Cad.listCadAssociationsAsync(db, query(req)))));
  router.post("/cad-associations", authAsync, canCadAsync("create"), wrap(async (req, res) => res.status(201).json(await Cad.createCadAssociationAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/cad-associations/:ref", authAsync, canCadAsync("read"), wrap(async (req, res) => res.json(await Cad.getCadAssociationAsync(db, tenantOf(req), req.params.ref))));
  const updateCad = wrap(async (req, res) => res.json(await Cad.updateCadAssociationAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/cad-associations/:ref", authAsync, canCadAsync("update"), updateCad);
  router.patch("/cad-associations/:ref", authAsync, canCadAsync("update"), updateCad);
  router.delete("/cad-associations/:ref", authAsync, canCadAsync("delete"), wrap(async (req, res) => res.json(await Cad.deleteCadAssociationAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Revision rules ────────────────────────────────────────────────────────
  router.get("/revision-rules", authAsync, canRevisionRulesAsync("read"), wrap(async (req, res) => res.json(await RevisionRules.listRevisionRulesAsync(db, query(req)))));
  router.post("/revision-rules", authAsync, canRevisionRulesAsync("create"), wrap(async (req, res) => res.status(201).json(await RevisionRules.createRevisionRuleAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.post("/revision-rules/resolve", authAsync, canRevisionRulesAsync("read"), wrap(async (req, res) => res.json(await RevisionRules.resolveRevisionRuleAsync(db, tenantOf(req), { itemId: req.body?.item_id ?? req.body?.itemId ?? null, itemRef: req.body?.item_ref ?? req.body?.itemRef ?? null, ruleId: req.body?.rule_id ?? req.body?.ruleId ?? null, ruleCode: req.body?.rule_code ?? req.body?.ruleCode ?? null, context: req.body?.context || {} }))));
  router.get("/revision-rules/:ref", authAsync, canRevisionRulesAsync("read"), wrap(async (req, res) => res.json(await RevisionRules.getRevisionRuleAsync(db, tenantOf(req), req.params.ref))));
  const updateRevisionRule = wrap(async (req, res) => res.json(await RevisionRules.updateRevisionRuleAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/revision-rules/:ref", authAsync, canRevisionRulesAsync("update"), updateRevisionRule);
  router.patch("/revision-rules/:ref", authAsync, canRevisionRulesAsync("update"), updateRevisionRule);
  router.post("/revision-rules/:ref/activate", authAsync, canRevisionRulesAsync("update"), wrap(async (req, res) => res.json(await RevisionRules.activateRevisionRuleAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/revision-rules/:ref/status", authAsync, canRevisionRulesAsync("update"), wrap(async (req, res) => res.json(await RevisionRules.setRevisionRuleStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.get("/revision-rules/:ref/versions", authAsync, canRevisionRulesAsync("read"), wrap(async (req, res) => res.json({ items: await RevisionRules.listRevisionRuleVersionsAsync(db, tenantOf(req), req.params.ref) })));
  router.post("/revision-rules/:ref/versions", authAsync, canRevisionRulesAsync("update"), wrap(async (req, res) => res.status(201).json(await RevisionRules.publishRevisionRuleVersionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));
  router.delete("/revision-rules/:ref", authAsync, canRevisionRulesAsync("delete"), wrap(async (req, res) => res.json(await RevisionRules.deleteRevisionRuleAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Configuration rules ───────────────────────────────────────────────────
  router.get("/configuration-rules", authAsync, canConfigurationRulesAsync("read"), wrap(async (req, res) => res.json(await ConfigurationRules.listConfigurationRulesAsync(db, query(req)))));
  router.post("/configuration-rules", authAsync, canConfigurationRulesAsync("create"), wrap(async (req, res) => res.status(201).json(await ConfigurationRules.createConfigurationRuleAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.post("/configuration-rules/evaluate", authAsync, canConfigurationRulesAsync("read"), wrap(async (req, res) => res.json(await ConfigurationRules.evaluateConfigurationRulesAsync(db, tenantOf(req), req.body?.context || req.body || {}))));
  router.get("/configuration-rules/:ref", authAsync, canConfigurationRulesAsync("read"), wrap(async (req, res) => res.json(await ConfigurationRules.getConfigurationRuleAsync(db, tenantOf(req), req.params.ref))));
  const updateConfigurationRule = wrap(async (req, res) => res.json(await ConfigurationRules.updateConfigurationRuleAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/configuration-rules/:ref", authAsync, canConfigurationRulesAsync("update"), updateConfigurationRule);
  router.patch("/configuration-rules/:ref", authAsync, canConfigurationRulesAsync("update"), updateConfigurationRule);
  router.post("/configuration-rules/:ref/activate", authAsync, canConfigurationRulesAsync("update"), wrap(async (req, res) => res.json(await ConfigurationRules.activateConfigurationRuleAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/configuration-rules/:ref/status", authAsync, canConfigurationRulesAsync("update"), wrap(async (req, res) => res.json(await ConfigurationRules.setConfigurationRuleStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.get("/configuration-rules/:ref/versions", authAsync, canConfigurationRulesAsync("read"), wrap(async (req, res) => res.json({ items: await ConfigurationRules.listConfigurationRuleVersionsAsync(db, tenantOf(req), req.params.ref) })));
  router.post("/configuration-rules/:ref/versions", authAsync, canConfigurationRulesAsync("update"), wrap(async (req, res) => res.status(201).json(await ConfigurationRules.publishConfigurationRuleVersionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));
  router.delete("/configuration-rules/:ref", authAsync, canConfigurationRulesAsync("delete"), wrap(async (req, res) => res.json(await ConfigurationRules.deleteConfigurationRuleAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Baselines ─────────────────────────────────────────────────────────────
  router.get("/baselines", authAsync, canBaselineAsync("read"), wrap(async (req, res) => res.json(await Baselines.listBaselinesAsync(db, query(req)))));
  router.post("/baselines", authAsync, canBaselineAsync("create"), wrap(async (req, res) => res.status(201).json(await Baselines.createBaselineAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/baselines/:ref", authAsync, canBaselineAsync("read"), wrap(async (req, res) => res.json(await Baselines.getBaselineAsync(db, tenantOf(req), req.params.ref))));
  const updateBaseline = wrap(async (req, res) => res.json(await Baselines.updateBaselineAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/baselines/:ref", authAsync, canBaselineAsync("update"), updateBaseline);
  router.patch("/baselines/:ref", authAsync, canBaselineAsync("update"), updateBaseline);
  router.post("/baselines/:ref/release", authAsync, canBaselineAsync("update"), wrap(async (req, res) => res.json(await Baselines.releaseBaselineAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/baselines/:ref/freeze", authAsync, canBaselineAsync("update"), wrap(async (req, res) => res.json(await Baselines.freezeBaselineAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/baselines/:ref/retire", authAsync, canBaselineAsync("update"), wrap(async (req, res) => res.json(await Baselines.retireBaselineAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get("/baselines/:ref/snapshot", authAsync, canBaselineAsync("read"), wrap(async (req, res) => res.json(await Baselines.baselineSnapshotMetaAsync(db, tenantOf(req), req.params.ref))));
  router.get("/baselines/:ref/members", authAsync, canBaselineAsync("read"), wrap(async (req, res) => res.json(await Baselines.listBaselineMembersAsync(db, tenantOf(req), req.params.ref, req.query))));
  router.post("/baselines/:ref/members", authAsync, canBaselineAsync("update"), wrap(async (req, res) => res.status(201).json(await Baselines.addBaselineMemberAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));
  router.delete("/baselines/:ref/members/:memberId", authAsync, canBaselineAsync("update"), wrap(async (req, res) => res.json(await Baselines.removeBaselineMemberAsync(db, tenantOf(req), req.params.ref, req.params.memberId, req.actor, req.ip))));
  router.delete("/baselines/:ref", authAsync, canBaselineAsync("delete"), wrap(async (req, res) => res.json(await Baselines.deleteBaselineAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Relationships & references ────────────────────────────────────────────
  router.get("/relationships", authAsync, canItemsAsync("read"), wrap(async (req, res) => res.json(await Relationships.listRelationshipsAsync(db, query(req)))));
  router.post("/relationships", authAsync, canItemsAsync("update"), wrap(async (req, res) => res.status(201).json(await Relationships.createRelationshipAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/relationships/:ref", authAsync, canItemsAsync("read"), wrap(async (req, res) => res.json(await Relationships.getRelationshipAsync(db, tenantOf(req), req.params.ref))));
  const updateRelationship = wrap(async (req, res) => res.json(await Relationships.updateRelationshipAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/relationships/:ref", authAsync, canItemsAsync("update"), updateRelationship);
  router.patch("/relationships/:ref", authAsync, canItemsAsync("update"), updateRelationship);
  router.delete("/relationships/:ref", authAsync, canItemsAsync("update"), wrap(async (req, res) => res.json(await Relationships.deleteRelationshipAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get("/references", authAsync, canWhereReferencedAsync("read"), wrap(async (req, res) => res.json(await References.listReferencesAsync(db, query(req)))));
  router.post("/references", authAsync, canWhereReferencedAsync("update"), wrap(async (req, res) => res.status(201).json(await References.recordReferenceAsync(db, tenantOf(req), req.body || {}))));

  // ── Where-used / where-referenced ─────────────────────────────────────────
  router.get("/where-used", authAsync, canWhereUsedAsync("read"), wrap(async (req, res) => res.json(await WhereUsed.whereUsedAsync(db, tenantOf(req), req.query.item_ref ?? req.query.item ?? req.query.item_id, { recursive: req.query.recursive !== "false", maxDepth: req.query.max_depth, actor: req.actor }))));
  router.get("/where-used/:ref", authAsync, canWhereUsedAsync("read"), wrap(async (req, res) => res.json(await WhereUsed.whereUsedAsync(db, tenantOf(req), req.params.ref, { recursive: req.query.recursive !== "false", maxDepth: req.query.max_depth, actor: req.actor }))));
  router.get("/where-referenced", authAsync, canWhereReferencedAsync("read"), wrap(async (req, res) => res.json(await WhereReferenced.whereReferencedAsync(db, { tenantId: tenantOf(req), targetType: req.query.target_type ?? req.query.targetType, targetId: req.query.target_id ?? req.query.targetId, category: req.query.category, actor: req.actor }))));
  router.get("/where-referenced/:targetType/:targetId", authAsync, canWhereReferencedAsync("read"), wrap(async (req, res) => res.json(await WhereReferenced.whereReferencedAsync(db, { tenantId: tenantOf(req), targetType: req.params.targetType, targetId: req.params.targetId, category: req.query.category, actor: req.actor }))));
  router.get("/references/summary", authAsync, canWhereReferencedAsync("read"), wrap(async (req, res) => res.json(await WhereReferenced.referencesSummaryAsync(db, tenantOf(req), req.query.target_type ?? req.query.targetType, req.query.target_id ?? req.query.targetId))));

  // ── Structure ─────────────────────────────────────────────────────────────
  router.get("/structure/:ref", authAsync, canStructureAsync("read"), wrap(async (req, res) => res.json(await Structure.resolveStructureAsync(db, tenantOf(req), { itemRef: req.params.ref, maxDepth: req.query.max_depth, revisionRuleId: req.query.revision_rule_id ?? null, ruleCode: req.query.rule_code ?? null, context: contextOf(req) }))));
  router.get("/structure/:ref/validate", authAsync, canStructureAsync("read"), wrap(async (req, res) => {
    const item = await Items.requireItemRowAsync(db, tenantOf(req), req.params.ref);
    return res.json(await Structure.validateStructureGraphAsync(db, tenantOf(req), item.id));
  }));
  router.post("/structure/resolve", authAsync, canStructureAsync("execute"), wrap(async (req, res) => res.json(await Structure.resolveStructureAsync(db, tenantOf(req), { itemId: req.body?.item_id ?? req.body?.itemId ?? null, itemRef: req.body?.item_ref ?? req.body?.itemRef ?? null, revisionRuleId: req.body?.revision_rule_id ?? req.body?.revisionRuleId ?? null, ruleCode: req.body?.rule_code ?? req.body?.ruleCode ?? null, context: req.body?.context || {}, maxDepth: req.body?.max_depth ?? req.body?.maxDepth ?? null }))));

  // ── Validation rules & results ────────────────────────────────────────────
  router.get("/validation-rules", authAsync, canValidationAsync("read"), wrap(async (req, res) => res.json(await Validator.listValidationRulesAsync(db, query(req)))));
  router.post("/validation-rules", authAsync, canValidationAsync("create"), wrap(async (req, res) => res.status(201).json(await Validator.createValidationRuleAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  const updateRule = wrap(async (req, res) => res.json(await Validator.updateValidationRuleAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/validation-rules/:ref", authAsync, canValidationAsync("update"), updateRule);
  router.patch("/validation-rules/:ref", authAsync, canValidationAsync("update"), updateRule);
  router.delete("/validation-rules/:ref", authAsync, canValidationAsync("delete"), wrap(async (req, res) => res.json(await Validator.deleteValidationRuleAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/validation/run", authAsync, canValidationAsync("execute"), wrap(async (req, res) => res.json(await Validator.validateTenantAsync(db, tenantOf(req), { actor: req.actor, scope: req.body?.scope || "TENANT" }))));
  router.get("/validation-results", authAsync, canValidationAsync("read"), wrap(async (req, res) => res.json(await Validator.listValidationResultsAsync(db, query(req)))));
  router.get("/validation-results/:ref", authAsync, canValidationAsync("read"), wrap(async (req, res) => res.json(await Validator.getValidationResultAsync(db, tenantOf(req), req.params.ref))));

  // ── History ───────────────────────────────────────────────────────────────
  router.get("/history", authAsync, canAuditAsync("read"), wrap(async (req, res) => res.json(await History.listHistoryAsync(db, query(req)))));
  router.get("/history/:objectType/:objectId", authAsync, canAuditAsync("read"), wrap(async (req, res) => res.json({ items: await History.objectLineageAsync(db, tenantOf(req), req.params.objectType, req.params.objectId) })));

  // ── Background jobs ───────────────────────────────────────────────────────
  router.post("/jobs/structure", auth, canStructure("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitStructureResolveJob(db, { tenantId: tenantOf(req), itemId: req.body?.item_id ?? req.body?.itemId, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/where-used", auth, canWhereUsed("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitWhereUsedJob(db, { tenantId: tenantOf(req), itemId: req.body?.item_id ?? req.body?.itemId, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/where-referenced", auth, canWhereReferenced("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitWhereReferencedJob(db, { tenantId: tenantOf(req), targetType: req.body?.target_type ?? req.body?.targetType, targetId: req.body?.target_id ?? req.body?.targetId, options: req.body?.options || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/baseline", auth, canBaseline("create"), wrap(async (req, res) => res.status(202).json(await Jobs.submitBaselineJob(db, { tenantId: tenantOf(req), body: req.body || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/validate", auth, canValidation("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitValidateJob(db, { tenantId: tenantOf(req), scope: req.body?.scope || "TENANT", itemId: req.body?.item_id ?? req.body?.itemId ?? null, revisionId: req.body?.revision_id ?? req.body?.revisionId ?? null, datasetId: req.body?.dataset_id ?? req.body?.datasetId ?? null, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/reindex", auth, canSearch("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitReindexJob(db, { tenantId: tenantOf(req), objectTypes: req.body?.object_types ?? req.body?.objectTypes ?? null, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/maintenance", auth, canAdmin("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitMaintenanceJob(db, { tenantId: tenantOf(req), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));

  // ── Foundation & demo seed ────────────────────────────────────────────────
  router.post("/foundation/ensure", auth, canAdmin("execute"), wrap((_req, res) => res.json(Foundation.ensurePdmFoundation(db))));
  router.post("/seed", auth, canAdmin("execute"), wrap((req, res) => res.json(Seed.seedPdm(db, tenantOf(req)))));
  router.post("/search/reindex", auth, canSearch("execute"), wrap((_req, res) => res.json({ registered: Search.registerPdmSources() })));
  router.get("/search-meta", authAsync, canSearchAsync("read"), wrap((_req, res) => res.json({ object_types: Constants.SEARCH_OBJECT_TYPES })));

  return router;
}

function contextOf(req) {
  return {
    as_of: req.query.as_of ?? req.query.asOf ?? null,
    variant_code: req.query.variant_code ?? req.query.variantCode ?? null,
    configuration_context: req.query.configuration_context ?? req.query.configurationContext ?? null,
  };
}
