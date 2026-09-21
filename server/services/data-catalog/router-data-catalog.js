// REST router for the Data Catalog (asset registry, objects, attributes,
// sources, consumers, lineage, relationships, classifications, ownership,
// configuration, import/export, metrics). Built as a factory so it reuses the
// application's auth, authorization and error middleware. Mounted at
// /api/data-catalog and /api/v1/data-catalog.
import {
  constants,
  Validation,
  Entries,
  Objects,
  Sources,
  Consumers,
  Lineage,
  Relationships,
  Classifications,
  Ownership,
  Configuration,
  ImportExport,
  Metrics,
  Jobs,
  Foundation,
} from "./index.js";

const R = constants.CATALOG_RESOURCES;

export function createDataCatalogRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const canOverview = (a) => can(R.overview, a);
  const canObjects = (a) => can(R.objects, a);
  const canAttributes = (a) => can(R.attributes, a);
  const canSources = (a) => can(R.sources, a);
  const canConsumers = (a) => can(R.consumers, a);
  const canMappings = (a) => can(R.mappings, a);
  const canLineage = (a) => can(R.lineage, a);
  const canRelationships = (a) => can(R.relationships, a);
  const canClassifications = (a) => can(R.classifications, a);
  const canOwnership = (a) => can(R.ownership, a);
  const canImportExport = (a) => can(R.importExport, a);
  const canAdmin = (a) => can(R.admin, a);
  const canJobs = (a) => can(R.jobs, a);
  const canMetrics = (a) => can(R.metrics, a);

  router.get(
    "/meta",
    auth,
    canOverview("read"),
    wrap((_req, res) => {
      res.json({
        source_module: constants.SOURCE_MODULE,
        vocabularies: Validation.vocabulary(),
        capabilities: {
          catalog_statuses: constants.CATALOG_STATUSES,
          entry_types: constants.ENTRY_TYPES,
          source_types: constants.SOURCE_TYPES,
          consumer_types: constants.CONSUMER_TYPES,
          mapping_types: constants.MAPPING_TYPES,
          lineage_relationship_types: constants.LINEAGE_RELATIONSHIP_TYPES,
          ownership_kinds: constants.OWNERSHIP_KINDS,
          security_classifications: constants.SECURITY_CLASSIFICATIONS,
          importable_resources: ImportExport.IMPORTABLE_RESOURCES,
        },
      });
    })
  );

  router.get(
    "/health",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Foundation.catalogHealth(db, tenantOf(req))))
  );

  router.get(
    "/metrics",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Metrics.metricsSnapshot(db, { tenantId: tenantOf(req) })))
  );

  // ── Unified registry ──────────────────────────────────────────────────────
  router.get(
    "/entries",
    auth,
    canOverview("read"),
    wrap((req, res) => res.json(Entries.listEntries(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.get(
    "/entries/:ref",
    auth,
    canOverview("read"),
    wrap((req, res) => res.json(Entries.getEntry(db, req.params.ref, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/entries/:ref/versions",
    auth,
    canOverview("read"),
    wrap((req, res) => res.json({ items: Entries.listMetadataVersions(db, req.params.ref, { tenantId: tenantOf(req) }) }))
  );
  router.post(
    "/entries/:ref/status",
    auth,
    canAdmin("execute"),
    wrap((req, res) => res.json(Entries.setEntryStatus(db, req.params.ref, req.body?.status, req.actor, req.ip)))
  );

  // ── Data objects ──────────────────────────────────────────────────────────
  router.get(
    "/objects",
    auth,
    canObjects("read"),
    wrap((req, res) => res.json(Objects.listObjects(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/objects",
    auth,
    canObjects("create"),
    wrap((req, res) => res.status(201).json(Objects.createCatalogObject(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/objects/:ref",
    auth,
    canObjects("read"),
    wrap((req, res) => res.json(Objects.getObject(db, req.params.ref, { tenantId: tenantOf(req) })))
  );
  const updateObject = wrap((req, res) => res.json(Objects.updateCatalogObject(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/objects/:ref", auth, canObjects("update"), updateObject);
  router.patch("/objects/:ref", auth, canObjects("update"), updateObject);
  router.post(
    "/objects/:ref/status",
    auth,
    canObjects("execute"),
    wrap((req, res) => res.json(Objects.setObjectStatus(db, req.params.ref, req.body?.status, req.actor, tenantOf(req), req.ip)))
  );

  // ── Attributes ────────────────────────────────────────────────────────────
  router.get(
    "/objects/:ref/attributes",
    auth,
    canAttributes("read"),
    wrap((req, res) => res.json({ items: Objects.listAttributes(db, req.params.ref, { status: req.query.status, tenantId: tenantOf(req) }) }))
  );
  router.post(
    "/objects/:ref/attributes",
    auth,
    canAttributes("create"),
    wrap((req, res) => res.status(201).json(Objects.createAttribute(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/attributes/:ref",
    auth,
    canAttributes("read"),
    wrap((req, res) => res.json(Objects.publicCatalogAttribute(Objects.requireAttribute(db, req.params.ref, tenantOf(req)))))
  );
  const updateAttribute = wrap((req, res) => res.json(Objects.updateAttribute(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/attributes/:ref", auth, canAttributes("update"), updateAttribute);
  router.patch("/attributes/:ref", auth, canAttributes("update"), updateAttribute);
  router.post(
    "/attributes/:ref/status",
    auth,
    canAttributes("execute"),
    wrap((req, res) => res.json(Objects.setAttributeStatus(db, req.params.ref, req.body?.status, req.actor, tenantOf(req), req.ip)))
  );

  // ── Sources ───────────────────────────────────────────────────────────────
  router.get(
    "/sources",
    auth,
    canSources("read"),
    wrap((req, res) => res.json(Sources.listSources(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/sources",
    auth,
    canSources("create"),
    wrap((req, res) => res.status(201).json(Sources.createSource(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/sources/:ref",
    auth,
    canSources("read"),
    wrap((req, res) => res.json(Sources.getSource(db, req.params.ref, { tenantId: tenantOf(req) })))
  );
  const updateSource = wrap((req, res) => res.json(Sources.updateSource(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/sources/:ref", auth, canSources("update"), updateSource);
  router.patch("/sources/:ref", auth, canSources("update"), updateSource);
  router.post(
    "/sources/:ref/status",
    auth,
    canSources("execute"),
    wrap((req, res) => res.json(Sources.setSourceStatus(db, req.params.ref, req.body?.status, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/sources/:ref/mappings",
    auth,
    canMappings("read"),
    wrap((req, res) => {
      const source = Sources.requireSource(db, req.params.ref, tenantOf(req));
      res.json({ items: Sources.listSourceMappings(db, source.id, { status: req.query.status }) });
    })
  );
  router.post(
    "/sources/:ref/mappings",
    auth,
    canMappings("create"),
    wrap((req, res) => res.status(201).json(Sources.addSourceMapping(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  const updateSourceMapping = wrap((req, res) => res.json(Sources.updateSourceMapping(db, req.params.id, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/source-mappings/:id", auth, canMappings("update"), updateSourceMapping);
  router.patch("/source-mappings/:id", auth, canMappings("update"), updateSourceMapping);
  router.delete(
    "/source-mappings/:id",
    auth,
    canMappings("delete"),
    wrap((req, res) => res.json(Sources.removeSourceMapping(db, req.params.id, req.actor, tenantOf(req), req.ip)))
  );

  // ── Consumers ─────────────────────────────────────────────────────────────
  router.get(
    "/consumers",
    auth,
    canConsumers("read"),
    wrap((req, res) => res.json(Consumers.listConsumers(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/consumers",
    auth,
    canConsumers("create"),
    wrap((req, res) => res.status(201).json(Consumers.createConsumer(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/consumers/:ref",
    auth,
    canConsumers("read"),
    wrap((req, res) => res.json(Consumers.getConsumer(db, req.params.ref, { tenantId: tenantOf(req) })))
  );
  const updateConsumer = wrap((req, res) => res.json(Consumers.updateConsumer(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/consumers/:ref", auth, canConsumers("update"), updateConsumer);
  router.patch("/consumers/:ref", auth, canConsumers("update"), updateConsumer);
  router.post(
    "/consumers/:ref/status",
    auth,
    canConsumers("execute"),
    wrap((req, res) => res.json(Consumers.setConsumerStatus(db, req.params.ref, req.body?.status, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/consumers/:ref/mappings",
    auth,
    canMappings("read"),
    wrap((req, res) => {
      const consumer = Consumers.requireConsumer(db, req.params.ref, tenantOf(req));
      res.json({ items: Consumers.listConsumerMappings(db, consumer.id, { status: req.query.status }) });
    })
  );
  router.post(
    "/consumers/:ref/mappings",
    auth,
    canMappings("create"),
    wrap((req, res) => res.status(201).json(Consumers.addConsumerMapping(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  const updateConsumerMapping = wrap((req, res) => res.json(Consumers.updateConsumerMapping(db, req.params.id, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/consumer-mappings/:id", auth, canMappings("update"), updateConsumerMapping);
  router.patch("/consumer-mappings/:id", auth, canMappings("update"), updateConsumerMapping);
  router.delete(
    "/consumer-mappings/:id",
    auth,
    canMappings("delete"),
    wrap((req, res) => res.json(Consumers.removeConsumerMapping(db, req.params.id, req.actor, tenantOf(req), req.ip)))
  );

  // ── Lineage ───────────────────────────────────────────────────────────────
  router.get(
    "/lineage",
    auth,
    canLineage("read"),
    wrap((req, res) => res.json(Lineage.listLineage(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/lineage",
    auth,
    canLineage("create"),
    wrap((req, res) => res.status(201).json(Lineage.createLineage(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/lineage/graph",
    auth,
    canLineage("read"),
    wrap((req, res) =>
      res.json(
        Lineage.lineageGraph(db, {
          tenantId: tenantOf(req),
          rootType: req.query.root_type ?? req.query.rootType,
          rootId: req.query.root_id ?? req.query.rootId,
          direction: req.query.direction,
          maxDepth: req.query.max_depth ?? req.query.maxDepth,
          maxNodes: req.query.max_nodes ?? req.query.maxNodes,
        })
      )
    )
  );
  router.get(
    "/lineage/impact",
    auth,
    canLineage("read"),
    wrap((req, res) =>
      res.json(
        Lineage.impact(db, {
          tenantId: tenantOf(req),
          rootType: req.query.root_type ?? req.query.rootType,
          rootId: req.query.root_id ?? req.query.rootId,
          maxDepth: req.query.max_depth ?? req.query.maxDepth,
          maxNodes: req.query.max_nodes ?? req.query.maxNodes,
        })
      )
    )
  );
  router.get(
    "/lineage/:id",
    auth,
    canLineage("read"),
    wrap((req, res) => res.json(Lineage.getLineage(db, req.params.id, tenantOf(req))))
  );
  const updateLineage = wrap((req, res) => res.json(Lineage.updateLineage(db, req.params.id, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/lineage/:id", auth, canLineage("update"), updateLineage);
  router.patch("/lineage/:id", auth, canLineage("update"), updateLineage);
  router.delete(
    "/lineage/:id",
    auth,
    canLineage("delete"),
    wrap((req, res) => res.json(Lineage.removeLineage(db, req.params.id, req.actor, tenantOf(req), req.ip)))
  );

  // ── Relationships ─────────────────────────────────────────────────────────
  router.get(
    "/relationship-types",
    auth,
    canRelationships("read"),
    wrap((req, res) => res.json(Relationships.listRelationshipTypes(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/relationship-types",
    auth,
    canRelationships("create"),
    wrap((req, res) => res.status(201).json(Relationships.createRelationshipType(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  const updateRelationshipType = wrap((req, res) => res.json(Relationships.updateRelationshipType(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/relationship-types/:ref", auth, canRelationships("update"), updateRelationshipType);
  router.patch("/relationship-types/:ref", auth, canRelationships("update"), updateRelationshipType);
  router.get(
    "/relationships",
    auth,
    canRelationships("read"),
    wrap((req, res) => res.json(Relationships.listRelationships(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/relationships",
    auth,
    canRelationships("create"),
    wrap((req, res) => res.status(201).json(Relationships.createRelationship(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  const updateRelationship = wrap((req, res) => res.json(Relationships.updateRelationship(db, req.params.id, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/relationships/:id", auth, canRelationships("update"), updateRelationship);
  router.patch("/relationships/:id", auth, canRelationships("update"), updateRelationship);
  router.delete(
    "/relationships/:id",
    auth,
    canRelationships("delete"),
    wrap((req, res) => res.json(Relationships.removeRelationship(db, req.params.id, req.actor, tenantOf(req), req.ip)))
  );

  // ── Classifications ───────────────────────────────────────────────────────
  router.get(
    "/classifications",
    auth,
    canClassifications("read"),
    wrap((req, res) => res.json(Classifications.listClassifications(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/classifications",
    auth,
    canClassifications("create"),
    wrap((req, res) => res.status(201).json(Classifications.createClassification(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  const updateClassification = wrap((req, res) => res.json(Classifications.updateClassification(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/classifications/:ref", auth, canClassifications("update"), updateClassification);
  router.patch("/classifications/:ref", auth, canClassifications("update"), updateClassification);
  router.post(
    "/classifications/:ref/status",
    auth,
    canClassifications("execute"),
    wrap((req, res) => res.json(Classifications.setClassificationStatus(db, req.params.ref, req.body?.status, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/classification-assignments",
    auth,
    canClassifications("read"),
    wrap((req, res) => res.json({ items: Classifications.listClassificationAssignments(db, { ...req.query, tenantId: tenantOf(req) }) }))
  );

  // ── Ownership ─────────────────────────────────────────────────────────────
  router.get(
    "/ownership",
    auth,
    canOwnership("read"),
    wrap((req, res) => res.json(Ownership.listOwnership(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/ownership",
    auth,
    canOwnership("create"),
    wrap((req, res) => res.status(201).json(Ownership.assignOwnership(db, req.body?.entry_ref ?? req.body?.entry_id, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/ownership/gaps",
    auth,
    canOwnership("read"),
    wrap((req, res) => res.json({ items: Ownership.ownershipGaps(db, tenantOf(req), { limit: req.query.limit }) }))
  );
  router.get(
    "/ownership/resolve",
    auth,
    canOwnership("read"),
    wrap((req, res) => res.json({ items: Ownership.resolveOwnership(db, { entryId: req.query.entry_id ?? req.query.entryId, relationship: req.query.relationship, tenantId: tenantOf(req) }) }))
  );
  const updateOwnership = wrap((req, res) => res.json(Ownership.updateOwnership(db, req.params.id, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/ownership/:id", auth, canOwnership("update"), updateOwnership);
  router.patch("/ownership/:id", auth, canOwnership("update"), updateOwnership);
  router.delete(
    "/ownership/:id",
    auth,
    canOwnership("delete"),
    wrap((req, res) => res.json(Ownership.removeOwnership(db, req.params.id, req.actor, tenantOf(req), req.ip)))
  );

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get(
    "/configuration",
    auth,
    canAdmin("read"),
    wrap((req, res) => res.json(Configuration.listConfig(db, tenantOf(req))))
  );
  router.put(
    "/configuration/:key",
    auth,
    canAdmin("update"),
    wrap((req, res) => res.json({ key: req.params.key, value: Configuration.setConfig(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip) }))
  );

  // ── Import / export ───────────────────────────────────────────────────────
  router.get(
    "/import-runs",
    auth,
    canImportExport("read"),
    wrap((req, res) => res.json({ items: ImportExport.listImportRuns(db, { ...req.query, tenantId: tenantOf(req) }) }))
  );
  router.get(
    "/import-runs/:id",
    auth,
    canImportExport("read"),
    wrap((req, res) => res.json(ImportExport.getImportRun(db, req.params.id, tenantOf(req))))
  );
  router.post(
    "/import",
    auth,
    canImportExport("create"),
    wrap((req, res) => {
      const body = req.body || {};
      const records = Array.isArray(body.records) ? body.records : ImportExport.parseRecords(body.content, body.format || "json");
      res.status(202).json(
        ImportExport.importCatalog(db, {
          tenantId: tenantOf(req),
          resourceType: body.resource_type,
          records,
          dryRun: Boolean(body.dry_run),
          transferRef: body.transfer_ref || "",
          actor: req.actor,
          ip: req.ip,
        })
      );
    })
  );
  router.post(
    "/import/submit",
    auth,
    canJobs("execute"),
    wrap((req, res) => res.status(202).json(Jobs.submitCatalogImport(db, { tenantId: tenantOf(req), ...(req.body || {}), actor: req.actor, ip: req.ip })))
  );
  router.get(
    "/export",
    auth,
    canImportExport("read"),
    wrap((req, res) => {
      const resourceTypes = req.query.resources ? String(req.query.resources).split(",").filter(Boolean) : null;
      res.json(ImportExport.exportCatalog(db, { tenantId: tenantOf(req), resourceTypes, format: req.query.format || "json" }));
    })
  );
  router.post(
    "/export/submit",
    auth,
    canJobs("execute"),
    wrap((req, res) => res.status(202).json(Jobs.submitCatalogExport(db, { tenantId: tenantOf(req), ...(req.body || {}), actor: req.actor, ip: req.ip })))
  );
  router.post(
    "/lineage/maintenance",
    auth,
    canJobs("execute"),
    wrap((req, res) => res.status(202).json(Jobs.submitLineageMaintenance(db, { tenantId: tenantOf(req), actor: req.actor, ip: req.ip })))
  );
  router.post(
    "/reindex",
    auth,
    canJobs("execute"),
    wrap((req, res) => res.status(202).json(Jobs.submitCatalogReindex(db, { tenantId: tenantOf(req), ...(req.body || {}), actor: req.actor, ip: req.ip })))
  );

  return router;
}
