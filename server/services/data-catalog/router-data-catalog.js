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

export function createDataCatalogRouter({ express, db, auth, authAsync, can, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;

  const canOverview = (a) => canAsync(R.overview, a);
  const canObjects = (a) => canAsync(R.objects, a);
  const canAttributes = (a) => canAsync(R.attributes, a);
  const canSources = (a) => canAsync(R.sources, a);
  const canConsumers = (a) => canAsync(R.consumers, a);
  const canMappings = (a) => canAsync(R.mappings, a);
  const canLineage = (a) => canAsync(R.lineage, a);
  const canRelationships = (a) => canAsync(R.relationships, a);
  const canClassifications = (a) => canAsync(R.classifications, a);
  const canOwnership = (a) => canAsync(R.ownership, a);
  const canImportExport = (a) => canAsync(R.importExport, a);
  const canAdmin = (a) => canAsync(R.admin, a);
  const canJobs = (a) => canAsync(R.jobs, a);
  const canMetrics = (a) => canAsync(R.metrics, a);

  router.get(
    "/meta",
    authAsync,
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
    authAsync,
    canMetrics("read"),
    wrap(async (req, res) => res.json(await Foundation.catalogHealthAsync(db, tenantOf(req))))
  );

  router.get(
    "/metrics",
    authAsync,
    canMetrics("read"),
    wrap(async (req, res) => res.json(await Metrics.metricsSnapshotAsync(db, { tenantId: tenantOf(req) })))
  );

  // ── Unified registry ──────────────────────────────────────────────────────
  router.get(
    "/entries",
    authAsync,
    canOverview("read"),
    wrap(async (req, res) => res.json(await Entries.listEntriesAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.get(
    "/entries/:ref",
    authAsync,
    canOverview("read"),
    wrap(async (req, res) => res.json(await Entries.getEntryAsync(db, req.params.ref, { tenantId: tenantOf(req) })))
  );
  router.get(
    "/entries/:ref/versions",
    authAsync,
    canOverview("read"),
    wrap(async (req, res) => res.json({ items: await Entries.listMetadataVersionsAsync(db, req.params.ref, { tenantId: tenantOf(req) }) }))
  );
  router.post(
    "/entries/:ref/status",
    authAsync,
    canAdmin("execute"),
    wrap(async (req, res) => res.json(await Entries.setEntryStatusAsync(db, req.params.ref, req.body?.status, req.actor, req.ip)))
  );

  // ── Data objects ──────────────────────────────────────────────────────────
  router.get(
    "/objects",
    authAsync,
    canObjects("read"),
    wrap(async (req, res) => res.json(await Objects.listObjectsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/objects",
    authAsync,
    canObjects("create"),
    wrap(async (req, res) => res.status(201).json(await Objects.createCatalogObjectAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/objects/:ref",
    authAsync,
    canObjects("read"),
    wrap(async (req, res) => res.json(await Objects.getObjectAsync(db, req.params.ref, { tenantId: tenantOf(req) })))
  );
  const updateObject = wrap(async (req, res) => res.json(await Objects.updateCatalogObjectAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/objects/:ref", authAsync, canObjects("update"), updateObject);
  router.patch("/objects/:ref", authAsync, canObjects("update"), updateObject);
  router.post(
    "/objects/:ref/status",
    authAsync,
    canObjects("execute"),
    wrap(async (req, res) => res.json(await Objects.setObjectStatusAsync(db, req.params.ref, req.body?.status, req.actor, tenantOf(req), req.ip)))
  );

  // ── Attributes ────────────────────────────────────────────────────────────
  router.get(
    "/objects/:ref/attributes",
    authAsync,
    canAttributes("read"),
    wrap(async (req, res) => res.json({ items: await Objects.listAttributesAsync(db, req.params.ref, { status: req.query.status, tenantId: tenantOf(req) }) }))
  );
  router.post(
    "/objects/:ref/attributes",
    authAsync,
    canAttributes("create"),
    wrap(async (req, res) => res.status(201).json(await Objects.createAttributeAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/attributes/:ref",
    authAsync,
    canAttributes("read"),
    wrap(async (req, res) => res.json(Objects.publicCatalogAttribute(await Objects.requireAttributeAsync(db, req.params.ref, tenantOf(req)))))
  );
  const updateAttribute = wrap(async (req, res) => res.json(await Objects.updateAttributeAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/attributes/:ref", authAsync, canAttributes("update"), updateAttribute);
  router.patch("/attributes/:ref", authAsync, canAttributes("update"), updateAttribute);
  router.post(
    "/attributes/:ref/status",
    authAsync,
    canAttributes("execute"),
    wrap(async (req, res) => res.json(await Objects.setAttributeStatusAsync(db, req.params.ref, req.body?.status, req.actor, tenantOf(req), req.ip)))
  );

  // ── Sources ───────────────────────────────────────────────────────────────
  router.get(
    "/sources",
    authAsync,
    canSources("read"),
    wrap(async (req, res) => res.json(await Sources.listSourcesAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/sources",
    authAsync,
    canSources("create"),
    wrap(async (req, res) => res.status(201).json(await Sources.createSourceAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/sources/:ref",
    authAsync,
    canSources("read"),
    wrap(async (req, res) => res.json(await Sources.getSourceAsync(db, req.params.ref, { tenantId: tenantOf(req) })))
  );
  const updateSource = wrap(async (req, res) => res.json(await Sources.updateSourceAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/sources/:ref", authAsync, canSources("update"), updateSource);
  router.patch("/sources/:ref", authAsync, canSources("update"), updateSource);
  router.post(
    "/sources/:ref/status",
    authAsync,
    canSources("execute"),
    wrap(async (req, res) => res.json(await Sources.setSourceStatusAsync(db, req.params.ref, req.body?.status, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/sources/:ref/mappings",
    authAsync,
    canMappings("read"),
    wrap(async (req, res) => {
      const source = await Sources.requireSourceAsync(db, req.params.ref, tenantOf(req));
      res.json({ items: await Sources.listSourceMappingsAsync(db, source.id, { status: req.query.status }) });
    })
  );
  router.post(
    "/sources/:ref/mappings",
    authAsync,
    canMappings("create"),
    wrap(async (req, res) => res.status(201).json(await Sources.addSourceMappingAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  const updateSourceMapping = wrap(async (req, res) => res.json(await Sources.updateSourceMappingAsync(db, req.params.id, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/source-mappings/:id", authAsync, canMappings("update"), updateSourceMapping);
  router.patch("/source-mappings/:id", authAsync, canMappings("update"), updateSourceMapping);
  router.delete(
    "/source-mappings/:id",
    authAsync,
    canMappings("delete"),
    wrap(async (req, res) => res.json(await Sources.removeSourceMappingAsync(db, req.params.id, req.actor, tenantOf(req), req.ip)))
  );

  // ── Consumers ─────────────────────────────────────────────────────────────
  router.get(
    "/consumers",
    authAsync,
    canConsumers("read"),
    wrap(async (req, res) => res.json(await Consumers.listConsumersAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/consumers",
    authAsync,
    canConsumers("create"),
    wrap(async (req, res) => res.status(201).json(await Consumers.createConsumerAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/consumers/:ref",
    authAsync,
    canConsumers("read"),
    wrap(async (req, res) => res.json(await Consumers.getConsumerAsync(db, req.params.ref, { tenantId: tenantOf(req) })))
  );
  const updateConsumer = wrap(async (req, res) => res.json(await Consumers.updateConsumerAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/consumers/:ref", authAsync, canConsumers("update"), updateConsumer);
  router.patch("/consumers/:ref", authAsync, canConsumers("update"), updateConsumer);
  router.post(
    "/consumers/:ref/status",
    authAsync,
    canConsumers("execute"),
    wrap(async (req, res) => res.json(await Consumers.setConsumerStatusAsync(db, req.params.ref, req.body?.status, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/consumers/:ref/mappings",
    authAsync,
    canMappings("read"),
    wrap(async (req, res) => {
      const consumer = await Consumers.requireConsumerAsync(db, req.params.ref, tenantOf(req));
      res.json({ items: await Consumers.listConsumerMappingsAsync(db, consumer.id, { status: req.query.status }) });
    })
  );
  router.post(
    "/consumers/:ref/mappings",
    authAsync,
    canMappings("create"),
    wrap(async (req, res) => res.status(201).json(await Consumers.addConsumerMappingAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  const updateConsumerMapping = wrap(async (req, res) => res.json(await Consumers.updateConsumerMappingAsync(db, req.params.id, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/consumer-mappings/:id", authAsync, canMappings("update"), updateConsumerMapping);
  router.patch("/consumer-mappings/:id", authAsync, canMappings("update"), updateConsumerMapping);
  router.delete(
    "/consumer-mappings/:id",
    authAsync,
    canMappings("delete"),
    wrap(async (req, res) => res.json(await Consumers.removeConsumerMappingAsync(db, req.params.id, req.actor, tenantOf(req), req.ip)))
  );

  // ── Lineage ───────────────────────────────────────────────────────────────
  router.get(
    "/lineage",
    authAsync,
    canLineage("read"),
    wrap(async (req, res) => res.json(await Lineage.listLineageAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/lineage",
    authAsync,
    canLineage("create"),
    wrap(async (req, res) => res.status(201).json(await Lineage.createLineageAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/lineage/graph",
    authAsync,
    canLineage("read"),
    wrap(async (req, res) =>
      res.json(
        await Lineage.lineageGraphAsync(db, {
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
    authAsync,
    canLineage("read"),
    wrap(async (req, res) =>
      res.json(
        await Lineage.impactAsync(db, {
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
    authAsync,
    canLineage("read"),
    wrap(async (req, res) => res.json(await Lineage.getLineageAsync(db, req.params.id, tenantOf(req))))
  );
  const updateLineage = wrap(async (req, res) => res.json(await Lineage.updateLineageAsync(db, req.params.id, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/lineage/:id", authAsync, canLineage("update"), updateLineage);
  router.patch("/lineage/:id", authAsync, canLineage("update"), updateLineage);
  router.delete(
    "/lineage/:id",
    authAsync,
    canLineage("delete"),
    wrap(async (req, res) => res.json(await Lineage.removeLineageAsync(db, req.params.id, req.actor, tenantOf(req), req.ip)))
  );

  // ── Relationships ─────────────────────────────────────────────────────────
  router.get(
    "/relationship-types",
    authAsync,
    canRelationships("read"),
    wrap(async (req, res) => res.json(await Relationships.listRelationshipTypesAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/relationship-types",
    authAsync,
    canRelationships("create"),
    wrap(async (req, res) => res.status(201).json(await Relationships.createRelationshipTypeAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  const updateRelationshipType = wrap(async (req, res) => res.json(await Relationships.updateRelationshipTypeAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/relationship-types/:ref", authAsync, canRelationships("update"), updateRelationshipType);
  router.patch("/relationship-types/:ref", authAsync, canRelationships("update"), updateRelationshipType);
  router.get(
    "/relationships",
    authAsync,
    canRelationships("read"),
    wrap(async (req, res) => res.json(await Relationships.listRelationshipsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/relationships",
    authAsync,
    canRelationships("create"),
    wrap(async (req, res) => res.status(201).json(await Relationships.createRelationshipAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  const updateRelationship = wrap(async (req, res) => res.json(await Relationships.updateRelationshipAsync(db, req.params.id, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/relationships/:id", authAsync, canRelationships("update"), updateRelationship);
  router.patch("/relationships/:id", authAsync, canRelationships("update"), updateRelationship);
  router.delete(
    "/relationships/:id",
    authAsync,
    canRelationships("delete"),
    wrap(async (req, res) => res.json(await Relationships.removeRelationshipAsync(db, req.params.id, req.actor, tenantOf(req), req.ip)))
  );

  // ── Classifications ───────────────────────────────────────────────────────
  router.get(
    "/classifications",
    authAsync,
    canClassifications("read"),
    wrap(async (req, res) => res.json(await Classifications.listClassificationsAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/classifications",
    authAsync,
    canClassifications("create"),
    wrap(async (req, res) => res.status(201).json(await Classifications.createClassificationAsync(db, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  const updateClassification = wrap(async (req, res) => res.json(await Classifications.updateClassificationAsync(db, req.params.ref, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/classifications/:ref", authAsync, canClassifications("update"), updateClassification);
  router.patch("/classifications/:ref", authAsync, canClassifications("update"), updateClassification);
  router.post(
    "/classifications/:ref/status",
    authAsync,
    canClassifications("execute"),
    wrap(async (req, res) => res.json(await Classifications.setClassificationStatusAsync(db, req.params.ref, req.body?.status, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/classification-assignments",
    authAsync,
    canClassifications("read"),
    wrap(async (req, res) => res.json({ items: await Classifications.listClassificationAssignmentsAsync(db, { ...req.query, tenantId: tenantOf(req) }) }))
  );

  // ── Ownership ─────────────────────────────────────────────────────────────
  router.get(
    "/ownership",
    authAsync,
    canOwnership("read"),
    wrap(async (req, res) => res.json(await Ownership.listOwnershipAsync(db, { ...req.query, tenantId: tenantOf(req) })))
  );
  router.post(
    "/ownership",
    authAsync,
    canOwnership("create"),
    wrap(async (req, res) => res.status(201).json(await Ownership.assignOwnershipAsync(db, req.body?.entry_ref ?? req.body?.entry_id, req.body || {}, req.actor, tenantOf(req), req.ip)))
  );
  router.get(
    "/ownership/gaps",
    authAsync,
    canOwnership("read"),
    wrap(async (req, res) => res.json({ items: await Ownership.ownershipGapsAsync(db, tenantOf(req), { limit: req.query.limit }) }))
  );
  router.get(
    "/ownership/resolve",
    authAsync,
    canOwnership("read"),
    wrap(async (req, res) => res.json({ items: await Ownership.resolveOwnershipAsync(db, { entryId: req.query.entry_id ?? req.query.entryId, relationship: req.query.relationship, tenantId: tenantOf(req) }) }))
  );
  const updateOwnership = wrap(async (req, res) => res.json(await Ownership.updateOwnershipAsync(db, req.params.id, req.body || {}, req.actor, tenantOf(req), req.ip)));
  router.put("/ownership/:id", authAsync, canOwnership("update"), updateOwnership);
  router.patch("/ownership/:id", authAsync, canOwnership("update"), updateOwnership);
  router.delete(
    "/ownership/:id",
    authAsync,
    canOwnership("delete"),
    wrap(async (req, res) => res.json(await Ownership.removeOwnershipAsync(db, req.params.id, req.actor, tenantOf(req), req.ip)))
  );

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get(
    "/configuration",
    authAsync,
    canAdmin("read"),
    wrap(async (req, res) => res.json(await Configuration.listConfigAsync(db, tenantOf(req))))
  );
  router.put(
    "/configuration/:key",
    authAsync,
    canAdmin("update"),
    wrap(async (req, res) => res.json({ key: req.params.key, value: await Configuration.setConfigAsync(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip) }))
  );

  // ── Import / export ───────────────────────────────────────────────────────
  router.get(
    "/import-runs",
    authAsync,
    canImportExport("read"),
    wrap(async (req, res) => res.json({ items: await ImportExport.listImportRunsAsync(db, { ...req.query, tenantId: tenantOf(req) }) }))
  );
  router.get(
    "/import-runs/:id",
    authAsync,
    canImportExport("read"),
    wrap(async (req, res) => res.json(await ImportExport.getImportRunAsync(db, req.params.id, tenantOf(req))))
  );
  router.post(
    "/import",
    authAsync,
    canImportExport("create"),
    wrap(async (req, res) => {
      const body = req.body || {};
      const records = Array.isArray(body.records) ? body.records : ImportExport.parseRecords(body.content, body.format || "json");
      res.status(202).json(
        await ImportExport.importCatalogAsync(db, {
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
    authAsync,
    canJobs("execute"),
    wrap(async (req, res) => res.status(202).json(await Jobs.submitCatalogImportAsync(db, { tenantId: tenantOf(req), ...(req.body || {}), actor: req.actor, ip: req.ip })))
  );
  router.get(
    "/export",
    authAsync,
    canImportExport("read"),
    wrap(async (req, res) => {
      const resourceTypes = req.query.resources ? String(req.query.resources).split(",").filter(Boolean) : null;
      res.json(await ImportExport.exportCatalogAsync(db, { tenantId: tenantOf(req), resourceTypes, format: req.query.format || "json" }));
    })
  );
  router.post(
    "/export/submit",
    authAsync,
    canJobs("execute"),
    wrap(async (req, res) => res.status(202).json(await Jobs.submitCatalogExportAsync(db, { tenantId: tenantOf(req), ...(req.body || {}), actor: req.actor, ip: req.ip })))
  );
  router.post(
    "/lineage/maintenance",
    authAsync,
    canJobs("execute"),
    wrap(async (req, res) => res.status(202).json(await Jobs.submitLineageMaintenanceAsync(db, { tenantId: tenantOf(req), actor: req.actor, ip: req.ip })))
  );
  router.post(
    "/reindex",
    authAsync,
    canJobs("execute"),
    wrap(async (req, res) => res.status(202).json(await Jobs.submitCatalogReindexAsync(db, { tenantId: tenantOf(req), ...(req.body || {}), actor: req.actor, ip: req.ip })))
  );

  return router;
}
