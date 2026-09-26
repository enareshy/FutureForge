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

export function createPdmRouter({ express, db, auth, can, wrap }) {
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

  // ── Meta, health, metrics ─────────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
    canOverview("read"),
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
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json({ ...Metrics.healthCheck(db, { tenantId: tenantOf(req) }), ...Foundation.pdmHealth(db, tenantOf(req)) }))
  );
  router.get("/metrics", auth, canMetrics("read"), wrap((req, res) => res.json(Metrics.metricsSnapshot(db, { tenantId: tenantOf(req) }))));
  router.get("/rule-usage", auth, canMetrics("read"), wrap((req, res) => res.json(Metrics.ruleUsageStats(db, { tenantId: tenantOf(req) }))));

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get("/config", auth, canAdmin("read"), wrap((req, res) => res.json(Configuration.listConfig(db, tenantOf(req)))));
  const setConfig = wrap((req, res) => res.json(Configuration.setConfig(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip)));
  router.put("/config/:key", auth, canAdmin("update"), setConfig);
  router.patch("/config/:key", auth, canAdmin("update"), setConfig);

  // ── Items ─────────────────────────────────────────────────────────────────
  router.get("/items", auth, canItems("read"), wrap((req, res) => res.json(Items.listItems(db, query(req)))));
  router.post("/items", auth, canItems("create"), wrap((req, res) => res.status(201).json(Items.createItem(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/items/:ref", auth, canItems("read"), wrap((req, res) => res.json(Items.getItem(db, tenantOf(req), req.params.ref))));
  const updateItem = wrap((req, res) => res.json(Items.updateItem(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/items/:ref", auth, canItems("update"), updateItem);
  router.patch("/items/:ref", auth, canItems("update"), updateItem);
  router.post("/items/:ref/status", auth, canItems("update"), wrap((req, res) => res.json(Items.setItemStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.delete("/items/:ref", auth, canItems("delete"), wrap((req, res) => res.json(Items.deleteItem(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get(
    "/items/:ref/audit",
    auth,
    canAudit("read"),
    wrap((req, res) => {
      const ref = req.params.ref;
      const numeric = Number(ref);
      const scope = Number.isInteger(numeric) && String(numeric) === String(ref).trim() ? { entityId: numeric } : { entityRef: ref };
      return res.json(Items.listItemAudit(db, { tenantId: tenantOf(req), ...scope, ...req.query }));
    })
  );
  router.get("/items/:ref/revisions", auth, canRevisions("read"), wrap((req, res) => res.json(Revisions.listRevisions(db, { tenantId: tenantOf(req), itemRef: req.params.ref, ...req.query }))));
  router.post("/items/:ref/revisions", auth, canRevisions("create"), wrap((req, res) => res.status(201).json(Revisions.createRevision(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));
  router.get("/items/:ref/structure", auth, canStructure("read"), wrap((req, res) => res.json(Structure.resolveStructure(db, tenantOf(req), { itemRef: req.params.ref, maxDepth: req.query.max_depth, revisionRuleId: req.query.revision_rule_id ?? null, ruleCode: req.query.rule_code ?? null, context: contextOf(req) }))));
  router.get("/items/:ref/where-used", auth, canWhereUsed("read"), wrap((req, res) => res.json(WhereUsed.whereUsed(db, tenantOf(req), req.params.ref, { recursive: req.query.recursive !== "false", maxDepth: req.query.max_depth, actor: req.actor }))));
  router.get("/items/:ref/datasets", auth, canDatasets("read"), wrap((req, res) => {
    const item = Items.requireItemRow(db, tenantOf(req), req.params.ref);
    return res.json(Datasets.listDatasets(db, { tenantId: tenantOf(req), itemId: item.id, ...req.query }));
  }));

  // ── Parts & products (semantic views over items) ─────────────────────────
  router.get("/parts", auth, canParts("read"), wrap((req, res) => res.json(Items.listItems(db, { tenantId: tenantOf(req), ...req.query, itemType: "PART" }))));
  router.post("/parts", auth, canParts("create"), wrap((req, res) => res.status(201).json(Items.createItem(db, tenantOf(req), { ...(req.body || {}), item_type: "PART" }, req.actor, req.ip))));
  router.get("/products", auth, canProducts("read"), wrap((req, res) => res.json(Items.listItems(db, { tenantId: tenantOf(req), ...req.query, itemType: "PRODUCT" }))));
  router.post("/products", auth, canProducts("create"), wrap((req, res) => res.status(201).json(Items.createItem(db, tenantOf(req), { ...(req.body || {}), item_type: "PRODUCT" }, req.actor, req.ip))));

  // ── Revisions ─────────────────────────────────────────────────────────────
  router.get("/revisions", auth, canRevisions("read"), wrap((req, res) => res.json(Revisions.listRevisions(db, query(req)))));
  router.get("/revisions/:ref", auth, canRevisions("read"), wrap((req, res) => res.json(Revisions.getRevision(db, tenantOf(req), req.params.ref))));
  const updateRevision = wrap((req, res) => res.json(Revisions.updateRevision(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/revisions/:ref", auth, canRevisions("update"), updateRevision);
  router.patch("/revisions/:ref", auth, canRevisions("update"), updateRevision);
  router.post("/revisions/:ref/status", auth, canRevisions("update"), wrap((req, res) => res.json(Revisions.setRevisionStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.post("/revisions/:ref/revise", auth, canRevisions("create"), wrap((req, res) => res.status(201).json(Revisions.reviseRevision(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));
  router.delete("/revisions/:ref", auth, canRevisions("delete"), wrap((req, res) => res.json(Revisions.deleteRevision(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/revisions/:ref/validate", auth, canValidation("execute"), wrap((req, res) => res.json(Validator.validateRevision(db, tenantOf(req), req.params.ref, { actor: req.actor }))));
  router.get("/revisions/:ref/validation-results", auth, canValidation("read"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.json(Validator.listValidationResults(db, { tenantId: tenantOf(req), revisionId: revision.id, ...req.query }));
  }));
  router.get("/revisions/:ref/datasets", auth, canDatasets("read"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.json({ items: Datasets.datasetsForRevision(db, tenantOf(req), revision.id) });
  }));
  router.post("/revisions/:ref/datasets", auth, canDatasets("create"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.status(201).json(Datasets.createDataset(db, tenantOf(req), { ...(req.body || {}), item_id: revision.item_id, revision_id: revision.id }, req.actor, req.ip));
  }));
  router.get("/revisions/:ref/representations", auth, canRepresentations("read"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.json({ items: Representations.representationsForRevision(db, tenantOf(req), revision.id) });
  }));
  router.post("/revisions/:ref/representations", auth, canRepresentations("create"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.status(201).json(Representations.createRepresentation(db, tenantOf(req), { ...(req.body || {}), item_id: revision.item_id, revision_id: revision.id }, req.actor, req.ip));
  }));
  router.get("/revisions/:ref/design-data", auth, canDesignData("read"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.json({ items: DesignData.designDataForRevision(db, tenantOf(req), revision.id) });
  }));
  router.post("/revisions/:ref/design-data", auth, canDesignData("create"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.status(201).json(DesignData.createDesignData(db, tenantOf(req), { ...(req.body || {}), item_id: revision.item_id, revision_id: revision.id }, req.actor, req.ip));
  }));
  router.get("/revisions/:ref/cad", auth, canCad("read"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.json({ items: Cad.cadAssociationsForRevision(db, tenantOf(req), revision.id) });
  }));
  router.post("/revisions/:ref/cad", auth, canCad("create"), wrap((req, res) => {
    const revision = Revisions.requireRevisionRow(db, tenantOf(req), req.params.ref);
    return res.status(201).json(Cad.createCadAssociation(db, tenantOf(req), { ...(req.body || {}), item_id: revision.item_id, source_revision_id: revision.id }, req.actor, req.ip));
  }));

  // ── Datasets ──────────────────────────────────────────────────────────────
  router.get("/datasets", auth, canDatasets("read"), wrap((req, res) => res.json(Datasets.listDatasets(db, query(req)))));
  router.post("/datasets", auth, canDatasets("create"), wrap((req, res) => res.status(201).json(Datasets.createDataset(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/datasets/:ref", auth, canDatasets("read"), wrap((req, res) => res.json(Datasets.getDataset(db, tenantOf(req), req.params.ref))));
  const updateDataset = wrap((req, res) => res.json(Datasets.updateDataset(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/datasets/:ref", auth, canDatasets("update"), updateDataset);
  router.patch("/datasets/:ref", auth, canDatasets("update"), updateDataset);
  router.post("/datasets/:ref/status", auth, canDatasets("update"), wrap((req, res) => res.json(Datasets.setDatasetStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.post("/datasets/:ref/content", auth, canDatasets("update"), wrap((req, res) => res.json(Datasets.linkDatasetContent(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));
  router.delete("/datasets/:ref", auth, canDatasets("delete"), wrap((req, res) => res.json(Datasets.deleteDataset(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Representations ───────────────────────────────────────────────────────
  router.get("/representations", auth, canRepresentations("read"), wrap((req, res) => res.json(Representations.listRepresentations(db, query(req)))));
  router.post("/representations", auth, canRepresentations("create"), wrap((req, res) => res.status(201).json(Representations.createRepresentation(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/representations/:ref", auth, canRepresentations("read"), wrap((req, res) => res.json(Representations.getRepresentation(db, tenantOf(req), req.params.ref))));
  const updateRepresentation = wrap((req, res) => res.json(Representations.updateRepresentation(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/representations/:ref", auth, canRepresentations("update"), updateRepresentation);
  router.patch("/representations/:ref", auth, canRepresentations("update"), updateRepresentation);
  router.delete("/representations/:ref", auth, canRepresentations("delete"), wrap((req, res) => res.json(Representations.deleteRepresentation(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Design data ───────────────────────────────────────────────────────────
  router.get("/design-data", auth, canDesignData("read"), wrap((req, res) => res.json(DesignData.listDesignData(db, query(req)))));
  router.post("/design-data", auth, canDesignData("create"), wrap((req, res) => res.status(201).json(DesignData.createDesignData(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/design-data/:ref", auth, canDesignData("read"), wrap((req, res) => res.json(DesignData.getDesignData(db, tenantOf(req), req.params.ref))));
  const updateDesignData = wrap((req, res) => res.json(DesignData.updateDesignData(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/design-data/:ref", auth, canDesignData("update"), updateDesignData);
  router.patch("/design-data/:ref", auth, canDesignData("update"), updateDesignData);
  router.delete("/design-data/:ref", auth, canDesignData("delete"), wrap((req, res) => res.json(DesignData.deleteDesignData(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── CAD associations ──────────────────────────────────────────────────────
  router.get("/cad-associations", auth, canCad("read"), wrap((req, res) => res.json(Cad.listCadAssociations(db, query(req)))));
  router.post("/cad-associations", auth, canCad("create"), wrap((req, res) => res.status(201).json(Cad.createCadAssociation(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/cad-associations/:ref", auth, canCad("read"), wrap((req, res) => res.json(Cad.getCadAssociation(db, tenantOf(req), req.params.ref))));
  const updateCad = wrap((req, res) => res.json(Cad.updateCadAssociation(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/cad-associations/:ref", auth, canCad("update"), updateCad);
  router.patch("/cad-associations/:ref", auth, canCad("update"), updateCad);
  router.delete("/cad-associations/:ref", auth, canCad("delete"), wrap((req, res) => res.json(Cad.deleteCadAssociation(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Revision rules ────────────────────────────────────────────────────────
  router.get("/revision-rules", auth, canRevisionRules("read"), wrap((req, res) => res.json(RevisionRules.listRevisionRules(db, query(req)))));
  router.post("/revision-rules", auth, canRevisionRules("create"), wrap((req, res) => res.status(201).json(RevisionRules.createRevisionRule(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.post("/revision-rules/resolve", auth, canRevisionRules("read"), wrap((req, res) => res.json(RevisionRules.resolveRevisionRule(db, tenantOf(req), { itemId: req.body?.item_id ?? req.body?.itemId ?? null, itemRef: req.body?.item_ref ?? req.body?.itemRef ?? null, ruleId: req.body?.rule_id ?? req.body?.ruleId ?? null, ruleCode: req.body?.rule_code ?? req.body?.ruleCode ?? null, context: req.body?.context || {} }))));
  router.get("/revision-rules/:ref", auth, canRevisionRules("read"), wrap((req, res) => res.json(RevisionRules.getRevisionRule(db, tenantOf(req), req.params.ref))));
  const updateRevisionRule = wrap((req, res) => res.json(RevisionRules.updateRevisionRule(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/revision-rules/:ref", auth, canRevisionRules("update"), updateRevisionRule);
  router.patch("/revision-rules/:ref", auth, canRevisionRules("update"), updateRevisionRule);
  router.post("/revision-rules/:ref/activate", auth, canRevisionRules("update"), wrap((req, res) => res.json(RevisionRules.activateRevisionRule(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/revision-rules/:ref/status", auth, canRevisionRules("update"), wrap((req, res) => res.json(RevisionRules.setRevisionRuleStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.get("/revision-rules/:ref/versions", auth, canRevisionRules("read"), wrap((req, res) => res.json({ items: RevisionRules.listRevisionRuleVersions(db, tenantOf(req), req.params.ref) })));
  router.post("/revision-rules/:ref/versions", auth, canRevisionRules("update"), wrap((req, res) => res.status(201).json(RevisionRules.publishRevisionRuleVersion(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));
  router.delete("/revision-rules/:ref", auth, canRevisionRules("delete"), wrap((req, res) => res.json(RevisionRules.deleteRevisionRule(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Configuration rules ───────────────────────────────────────────────────
  router.get("/configuration-rules", auth, canConfigurationRules("read"), wrap((req, res) => res.json(ConfigurationRules.listConfigurationRules(db, query(req)))));
  router.post("/configuration-rules", auth, canConfigurationRules("create"), wrap((req, res) => res.status(201).json(ConfigurationRules.createConfigurationRule(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.post("/configuration-rules/evaluate", auth, canConfigurationRules("read"), wrap((req, res) => res.json(ConfigurationRules.evaluateConfigurationRules(db, tenantOf(req), req.body?.context || req.body || {}))));
  router.get("/configuration-rules/:ref", auth, canConfigurationRules("read"), wrap((req, res) => res.json(ConfigurationRules.getConfigurationRule(db, tenantOf(req), req.params.ref))));
  const updateConfigurationRule = wrap((req, res) => res.json(ConfigurationRules.updateConfigurationRule(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/configuration-rules/:ref", auth, canConfigurationRules("update"), updateConfigurationRule);
  router.patch("/configuration-rules/:ref", auth, canConfigurationRules("update"), updateConfigurationRule);
  router.post("/configuration-rules/:ref/activate", auth, canConfigurationRules("update"), wrap((req, res) => res.json(ConfigurationRules.activateConfigurationRule(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/configuration-rules/:ref/status", auth, canConfigurationRules("update"), wrap((req, res) => res.json(ConfigurationRules.setConfigurationRuleStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip))));
  router.get("/configuration-rules/:ref/versions", auth, canConfigurationRules("read"), wrap((req, res) => res.json({ items: ConfigurationRules.listConfigurationRuleVersions(db, tenantOf(req), req.params.ref) })));
  router.post("/configuration-rules/:ref/versions", auth, canConfigurationRules("update"), wrap((req, res) => res.status(201).json(ConfigurationRules.publishConfigurationRuleVersion(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));
  router.delete("/configuration-rules/:ref", auth, canConfigurationRules("delete"), wrap((req, res) => res.json(ConfigurationRules.deleteConfigurationRule(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Baselines ─────────────────────────────────────────────────────────────
  router.get("/baselines", auth, canBaseline("read"), wrap((req, res) => res.json(Baselines.listBaselines(db, query(req)))));
  router.post("/baselines", auth, canBaseline("create"), wrap((req, res) => res.status(201).json(Baselines.createBaseline(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/baselines/:ref", auth, canBaseline("read"), wrap((req, res) => res.json(Baselines.getBaseline(db, tenantOf(req), req.params.ref))));
  const updateBaseline = wrap((req, res) => res.json(Baselines.updateBaseline(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/baselines/:ref", auth, canBaseline("update"), updateBaseline);
  router.patch("/baselines/:ref", auth, canBaseline("update"), updateBaseline);
  router.post("/baselines/:ref/release", auth, canBaseline("update"), wrap((req, res) => res.json(Baselines.releaseBaseline(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/baselines/:ref/freeze", auth, canBaseline("update"), wrap((req, res) => res.json(Baselines.freezeBaseline(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/baselines/:ref/retire", auth, canBaseline("update"), wrap((req, res) => res.json(Baselines.retireBaseline(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get("/baselines/:ref/snapshot", auth, canBaseline("read"), wrap((req, res) => res.json(Baselines.baselineSnapshotMeta(db, tenantOf(req), req.params.ref))));
  router.get("/baselines/:ref/members", auth, canBaseline("read"), wrap((req, res) => res.json(Baselines.listBaselineMembers(db, tenantOf(req), req.params.ref, req.query))));
  router.post("/baselines/:ref/members", auth, canBaseline("update"), wrap((req, res) => res.status(201).json(Baselines.addBaselineMember(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip))));
  router.delete("/baselines/:ref/members/:memberId", auth, canBaseline("update"), wrap((req, res) => res.json(Baselines.removeBaselineMember(db, tenantOf(req), req.params.ref, req.params.memberId, req.actor, req.ip))));
  router.delete("/baselines/:ref", auth, canBaseline("delete"), wrap((req, res) => res.json(Baselines.deleteBaseline(db, tenantOf(req), req.params.ref, req.actor, req.ip))));

  // ── Relationships & references ────────────────────────────────────────────
  router.get("/relationships", auth, canItems("read"), wrap((req, res) => res.json(Relationships.listRelationships(db, query(req)))));
  router.post("/relationships", auth, canItems("update"), wrap((req, res) => res.status(201).json(Relationships.createRelationship(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/relationships/:ref", auth, canItems("read"), wrap((req, res) => res.json(Relationships.getRelationship(db, tenantOf(req), req.params.ref))));
  const updateRelationship = wrap((req, res) => res.json(Relationships.updateRelationship(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/relationships/:ref", auth, canItems("update"), updateRelationship);
  router.patch("/relationships/:ref", auth, canItems("update"), updateRelationship);
  router.delete("/relationships/:ref", auth, canItems("update"), wrap((req, res) => res.json(Relationships.deleteRelationship(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.get("/references", auth, canWhereReferenced("read"), wrap((req, res) => res.json(References.listReferences(db, query(req)))));
  router.post("/references", auth, canWhereReferenced("update"), wrap((req, res) => res.status(201).json(References.recordReference(db, tenantOf(req), req.body || {}))));

  // ── Where-used / where-referenced ─────────────────────────────────────────
  router.get("/where-used", auth, canWhereUsed("read"), wrap((req, res) => res.json(WhereUsed.whereUsed(db, tenantOf(req), req.query.item_ref ?? req.query.item ?? req.query.item_id, { recursive: req.query.recursive !== "false", maxDepth: req.query.max_depth, actor: req.actor }))));
  router.get("/where-used/:ref", auth, canWhereUsed("read"), wrap((req, res) => res.json(WhereUsed.whereUsed(db, tenantOf(req), req.params.ref, { recursive: req.query.recursive !== "false", maxDepth: req.query.max_depth, actor: req.actor }))));
  router.get("/where-referenced", auth, canWhereReferenced("read"), wrap((req, res) => res.json(WhereReferenced.whereReferenced(db, { tenantId: tenantOf(req), targetType: req.query.target_type ?? req.query.targetType, targetId: req.query.target_id ?? req.query.targetId, category: req.query.category, actor: req.actor }))));
  router.get("/where-referenced/:targetType/:targetId", auth, canWhereReferenced("read"), wrap((req, res) => res.json(WhereReferenced.whereReferenced(db, { tenantId: tenantOf(req), targetType: req.params.targetType, targetId: req.params.targetId, category: req.query.category, actor: req.actor }))));
  router.get("/references/summary", auth, canWhereReferenced("read"), wrap((req, res) => res.json(WhereReferenced.referencesSummary(db, tenantOf(req), req.query.target_type ?? req.query.targetType, req.query.target_id ?? req.query.targetId))));

  // ── Structure ─────────────────────────────────────────────────────────────
  router.get("/structure/:ref", auth, canStructure("read"), wrap((req, res) => res.json(Structure.resolveStructure(db, tenantOf(req), { itemRef: req.params.ref, maxDepth: req.query.max_depth, revisionRuleId: req.query.revision_rule_id ?? null, ruleCode: req.query.rule_code ?? null, context: contextOf(req) }))));
  router.get("/structure/:ref/validate", auth, canStructure("read"), wrap((req, res) => {
    const item = Items.requireItemRow(db, tenantOf(req), req.params.ref);
    return res.json(Structure.validateStructureGraph(db, tenantOf(req), item.id));
  }));
  router.post("/structure/resolve", auth, canStructure("execute"), wrap((req, res) => res.json(Structure.resolveStructure(db, tenantOf(req), { itemId: req.body?.item_id ?? req.body?.itemId ?? null, itemRef: req.body?.item_ref ?? req.body?.itemRef ?? null, revisionRuleId: req.body?.revision_rule_id ?? req.body?.revisionRuleId ?? null, ruleCode: req.body?.rule_code ?? req.body?.ruleCode ?? null, context: req.body?.context || {}, maxDepth: req.body?.max_depth ?? req.body?.maxDepth ?? null }))));

  // ── Validation rules & results ────────────────────────────────────────────
  router.get("/validation-rules", auth, canValidation("read"), wrap((req, res) => res.json(Validator.listValidationRules(db, query(req)))));
  router.post("/validation-rules", auth, canValidation("create"), wrap((req, res) => res.status(201).json(Validator.createValidationRule(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  const updateRule = wrap((req, res) => res.json(Validator.updateValidationRule(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/validation-rules/:ref", auth, canValidation("update"), updateRule);
  router.patch("/validation-rules/:ref", auth, canValidation("update"), updateRule);
  router.delete("/validation-rules/:ref", auth, canValidation("delete"), wrap((req, res) => res.json(Validator.deleteValidationRule(db, tenantOf(req), req.params.ref, req.actor, req.ip))));
  router.post("/validation/run", auth, canValidation("execute"), wrap((req, res) => res.json(Validator.validateTenant(db, tenantOf(req), { actor: req.actor, scope: req.body?.scope || "TENANT" }))));
  router.get("/validation-results", auth, canValidation("read"), wrap((req, res) => res.json(Validator.listValidationResults(db, query(req)))));
  router.get("/validation-results/:ref", auth, canValidation("read"), wrap((req, res) => res.json(Validator.getValidationResult(db, tenantOf(req), req.params.ref))));

  // ── History ───────────────────────────────────────────────────────────────
  router.get("/history", auth, canAudit("read"), wrap((req, res) => res.json(History.listHistory(db, query(req)))));
  router.get("/history/:objectType/:objectId", auth, canAudit("read"), wrap((req, res) => res.json({ items: History.objectLineage(db, tenantOf(req), req.params.objectType, req.params.objectId) })));

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
  router.get("/search-meta", auth, canSearch("read"), wrap((_req, res) => res.json({ object_types: Constants.SEARCH_OBJECT_TYPES })));

  return router;
}

function contextOf(req) {
  return {
    as_of: req.query.as_of ?? req.query.asOf ?? null,
    variant_code: req.query.variant_code ?? req.query.variantCode ?? null,
    configuration_context: req.query.configuration_context ?? req.query.configurationContext ?? null,
  };
}
