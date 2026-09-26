// REST router for the centralized Import & Export Framework. Built as a factory
// so it reuses the application's auth, authorization and error middleware.
// Mounted at /api/data-exchange and /api/v1/data-exchange.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization.
import {
  constants,
  Validation,
  Connectors,
  ConnectorConfigs,
  ImportDefinitions,
  ExportDefinitions,
  Importer,
  Exporter,
  Templates,
  Jobs,
  History,
  Configuration,
  Metrics,
  Foundation,
  Catalog,
} from "./index.js";

const R = constants.EXCHANGE_RESOURCES;

export function createDataExchangeRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";

  const canOverview = (a) => can(R.overview, a);
  const canImports = (a) => can(R.imports, a);
  const canImportDefs = (a) => can(R.importDefinitions, a);
  const canExports = (a) => can(R.exports, a);
  const canExportDefs = (a) => can(R.exportDefinitions, a);
  const canConnectors = (a) => can(R.connectors, a);
  const canTemplates = (a) => can(R.templates, a);
  const canHistory = (a) => can(R.history, a);
  const canJobs = (a) => can(R.jobs, a);
  const canMetrics = (a) => can(R.metrics, a);
  const canAdmin = (a) => can(R.admin, a);

  const withDefinition = (req) => ImportDefinitions.getImportDefinition(db, tenantOf(req), req.params.ref);

  // ── Meta, health, metrics, connectors ─────────────────────────────────────
  router.get(
    "/meta",
    auth,
    canOverview("read"),
    wrap((_req, res) => {
      res.json({
        source_module: constants.SOURCE_MODULE,
        vocabularies: Validation.vocabulary(),
        security_actions: constants.SECURITY_ACTIONS,
        capabilities: {
          directions: constants.DIRECTIONS,
          connector_types: constants.CONNECTOR_TYPES,
          connector_capabilities: constants.CONNECTOR_CAPABILITIES,
          import_formats: constants.IMPORT_FORMATS,
          export_formats: constants.EXPORT_FORMATS,
          export_destinations: constants.EXPORT_DESTINATIONS,
          execution_modes: constants.EXECUTION_MODES,
          duplicate_strategies: constants.DUPLICATE_STRATEGIES,
          mapping_types: constants.MAPPING_TYPES,
          transformation_types: constants.TRANSFORMATION_TYPES,
          validation_levels: constants.VALIDATION_LEVELS,
          filter_operators: constants.FILTER_OPERATORS,
          job_types: constants.EXCHANGE_JOB_TYPES.map((job) => job.code),
          connectors: Connectors.list().map((connector) => connector.code ?? connector.type),
        },
      });
    })
  );

  router.get(
    "/health",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json({ ...Metrics.healthCheck(db, { tenantId: tenantOf(req) }), ...Foundation.exchangeHealth(db, tenantOf(req)) }))
  );

  router.get(
    "/metrics",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Metrics.metricsSnapshot(db, { tenantId: tenantOf(req) })))
  );

  router.get(
    "/connectors",
    auth,
    canConnectors("read"),
    wrap((_req, res) => res.json({ items: Connectors.list(), types: constants.CONNECTOR_TYPES }))
  );

  // ── Connector configurations ──────────────────────────────────────────────
  router.get(
    "/connector-configurations",
    auth,
    canConnectors("read"),
    wrap((req, res) => res.json(ConnectorConfigs.listConnectorConfigurations(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/connector-configurations",
    auth,
    canConnectors("create"),
    wrap((req, res) => res.status(201).json(ConnectorConfigs.createConnectorConfiguration(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/connector-configurations/test",
    auth,
    canConnectors("read"),
    wrap(async (req, res) => res.json(await ConnectorConfigs.testConnectorConfiguration(db, tenantOf(req), req.body?.ref || null, req.body || {})))
  );
  router.get(
    "/connector-configurations/:ref",
    auth,
    canConnectors("read"),
    wrap((req, res) => res.json(ConnectorConfigs.getConnectorConfiguration(db, tenantOf(req), req.params.ref)))
  );
  const updateConnector = wrap((req, res) => res.json(ConnectorConfigs.updateConnectorConfiguration(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/connector-configurations/:ref", auth, canConnectors("update"), updateConnector);
  router.patch("/connector-configurations/:ref", auth, canConnectors("update"), updateConnector);
  router.post(
    "/connector-configurations/:ref/status",
    auth,
    canConnectors("update"),
    wrap((req, res) => res.json(ConnectorConfigs.setConnectorConfigurationStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/connector-configurations/:ref/test",
    auth,
    canConnectors("read"),
    wrap(async (req, res) => res.json(await ConnectorConfigs.testConnectorConfiguration(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/connector-configurations/:ref/discover",
    auth,
    canConnectors("read"),
    wrap(async (req, res) => res.json(await ConnectorConfigs.discoverConnectorConfigurationSchema(db, tenantOf(req), req.params.ref, req.body || {})))
  );

  // ── Credential references (opaque secret_ref only) ────────────────────────
  router.get(
    "/credential-references",
    auth,
    canConnectors("read"),
    wrap((req, res) => res.json(ConnectorConfigs.listCredentialReferences(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/credential-references",
    auth,
    canConnectors("create"),
    wrap((req, res) => res.status(201).json(ConnectorConfigs.createCredentialReference(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/credential-references/:ref/status",
    auth,
    canConnectors("update"),
    wrap((req, res) => res.json(ConnectorConfigs.setCredentialReferenceStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );

  // ── Import definitions ────────────────────────────────────────────────────
  router.get(
    "/import-definitions",
    auth,
    canImportDefs("read"),
    wrap((req, res) => res.json(ImportDefinitions.listImportDefinitions(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/import-definitions",
    auth,
    canImportDefs("create"),
    wrap((req, res) => res.status(201).json(ImportDefinitions.createImportDefinition(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/import-definitions/:ref",
    auth,
    canImportDefs("read"),
    wrap((req, res) => res.json(ImportDefinitions.getImportDefinition(db, tenantOf(req), req.params.ref)))
  );
  const updateImportDef = wrap((req, res) => res.json(ImportDefinitions.updateImportDefinition(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/import-definitions/:ref", auth, canImportDefs("update"), updateImportDef);
  router.patch("/import-definitions/:ref", auth, canImportDefs("update"), updateImportDef);
  router.post(
    "/import-definitions/:ref/status",
    auth,
    canImportDefs("update"),
    wrap((req, res) => res.json(ImportDefinitions.setImportDefinitionStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/import-definitions/:ref/versions",
    auth,
    canImportDefs("update"),
    wrap((req, res) => res.status(201).json(ImportDefinitions.createImportDefinitionVersion(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/import-definitions/:ref/versions",
    auth,
    canImportDefs("read"),
    wrap((req, res) => res.json(ImportDefinitions.listImportDefinitionVersions(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/import-definitions/:ref/validate",
    auth,
    canImports("read"),
    wrap((req, res) => res.json(ImportDefinitions.validateImportDefinition(db, tenantOf(req), req.params.ref, req.body || {})))
  );
  router.get(
    "/import-definitions/:ref/catalog",
    auth,
    canImportDefs("read"),
    wrap((req, res) => {
      const definition = ImportDefinitions.getImportDefinition(db, tenantOf(req), req.params.ref);
      res.json(Catalog.resolveCatalogRefs(db, tenantOf(req), definition.catalog_refs || {}));
    })
  );
  router.post(
    "/import-definitions/:ref/preview",
    auth,
    canImports("read"),
    wrap(async (req, res) => res.json(await Importer.previewImport(db, tenantOf(req), withDefinition(req), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/import-definitions/:ref/run",
    auth,
    canImports("execute"),
    wrap(async (req, res) => runImport(req, res))
  );

  // ── Import jobs ───────────────────────────────────────────────────────────
  router.get(
    "/import-jobs",
    auth,
    canImports("read"),
    wrap((req, res) => res.json(Importer.listImportJobs(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/import-jobs/:ref",
    auth,
    canImports("read"),
    wrap((req, res) => res.json(Importer.getImportJob(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/import-jobs/:ref/run",
    auth,
    canImports("execute"),
    wrap(async (req, res) => {
      const job = Importer.getImportJob(db, tenantOf(req), req.params.ref);
      if (req.body?.async) {
        const submitted = Jobs.submitImportJob(db, { tenantId: tenantOf(req), importJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
        return res.status(202).json({ job, platform_job: submitted });
      }
      res.json(await Importer.runImportJob(db, { jobId: job.id, params: req.body?.params || {}, actor: req.actor, ip: req.ip }));
    })
  );
  router.post(
    "/import-jobs/:ref/reconcile",
    auth,
    canImports("execute"),
    wrap((req, res) => {
      const job = Importer.getImportJob(db, tenantOf(req), req.params.ref);
      res.json({ job_ref: job.job_ref, reconciliation: Jobs.reconcileImportJob(db, { tenantId: tenantOf(req), importJobId: job.id }) });
    })
  );
  router.post(
    "/import-jobs/:ref/retry",
    auth,
    canImports("execute"),
    wrap(async (req, res) => res.json(await Jobs.retryImportJob(db, { tenantId: tenantOf(req), importJobId: Importer.getImportJob(db, tenantOf(req), req.params.ref).id, actor: req.actor, ip: req.ip })))
  );
  router.post(
    "/import-jobs/:ref/cancel",
    auth,
    canImports("execute"),
    wrap((req, res) => res.json(Importer.cancelImportJob(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/import-jobs/:ref/records",
    auth,
    canImports("read"),
    wrap((req, res) => {
      const job = Importer.getImportJob(db, tenantOf(req), req.params.ref);
      res.json(Importer.listImportRecordResults(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query }));
    })
  );
  router.get(
    "/import-jobs/:ref/errors",
    auth,
    canImports("read"),
    wrap((req, res) => {
      const job = Importer.getImportJob(db, tenantOf(req), req.params.ref);
      res.json(Importer.listImportErrors(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query }));
    })
  );
  router.get(
    "/import-errors",
    auth,
    canImports("read"),
    wrap((req, res) => res.json(Importer.listImportErrors(db, { tenantId: tenantOf(req), ...req.query })))
  );

  // ── Export definitions ────────────────────────────────────────────────────
  router.get(
    "/export-definitions",
    auth,
    canExportDefs("read"),
    wrap((req, res) => res.json(ExportDefinitions.listExportDefinitions(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/export-definitions",
    auth,
    canExportDefs("create"),
    wrap((req, res) => res.status(201).json(ExportDefinitions.createExportDefinition(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/export-definitions/:ref",
    auth,
    canExportDefs("read"),
    wrap((req, res) => res.json(ExportDefinitions.getExportDefinition(db, tenantOf(req), req.params.ref)))
  );
  const updateExportDef = wrap((req, res) => res.json(ExportDefinitions.updateExportDefinition(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/export-definitions/:ref", auth, canExportDefs("update"), updateExportDef);
  router.patch("/export-definitions/:ref", auth, canExportDefs("update"), updateExportDef);
  router.post(
    "/export-definitions/:ref/status",
    auth,
    canExportDefs("update"),
    wrap((req, res) => res.json(ExportDefinitions.setExportDefinitionStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/export-definitions/:ref/versions",
    auth,
    canExportDefs("update"),
    wrap((req, res) => res.status(201).json(ExportDefinitions.createExportDefinitionVersion(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/export-definitions/:ref/versions",
    auth,
    canExportDefs("read"),
    wrap((req, res) => res.json(ExportDefinitions.listExportDefinitionVersions(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/export-definitions/:ref/validate",
    auth,
    canExports("read"),
    wrap((req, res) => res.json(ExportDefinitions.validateExportDefinition(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/export-definitions/:ref/catalog",
    auth,
    canExportDefs("read"),
    wrap((req, res) => {
      const definition = ExportDefinitions.getExportDefinition(db, tenantOf(req), req.params.ref);
      res.json(Catalog.resolveCatalogRefs(db, tenantOf(req), definition.catalog_refs || {}));
    })
  );
  router.post(
    "/export-definitions/:ref/preview",
    auth,
    canExports("read"),
    wrap((req, res) => res.json(Exporter.previewExport(db, tenantOf(req), ExportDefinitions.getExportDefinition(db, tenantOf(req), req.params.ref), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/export-definitions/:ref/run",
    auth,
    canExports("execute"),
    wrap(async (req, res) => runExport(req, res))
  );

  // ── Export jobs ───────────────────────────────────────────────────────────
  router.get(
    "/export-jobs",
    auth,
    canExports("read"),
    wrap((req, res) => res.json(Exporter.listExportJobs(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/export-jobs/:ref",
    auth,
    canExports("read"),
    wrap((req, res) => res.json(Exporter.getExportJob(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/export-jobs/:ref/run",
    auth,
    canExports("execute"),
    wrap(async (req, res) => {
      const job = Exporter.getExportJob(db, tenantOf(req), req.params.ref);
      if (req.body?.async) {
        const submitted = Jobs.submitExportJob(db, { tenantId: tenantOf(req), exportJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
        return res.status(202).json({ job, platform_job: submitted });
      }
      res.json(await Exporter.runExportJob(db, { jobId: job.id, params: req.body?.params || {}, actor: req.actor, ip: req.ip }));
    })
  );
  router.post(
    "/export-jobs/:ref/cancel",
    auth,
    canExports("execute"),
    wrap((req, res) => res.json(Exporter.cancelExportJob(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/export-jobs/:ref/results",
    auth,
    canExports("read"),
    wrap((req, res) => {
      const job = Exporter.getExportJob(db, tenantOf(req), req.params.ref);
      res.json(Exporter.listExportResults(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query }));
    })
  );
  router.get(
    "/export-results",
    auth,
    canExports("read"),
    wrap((req, res) => res.json(Exporter.listExportResults(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/export-results/:ref/download",
    auth,
    canExports("execute"),
    wrap((req, res) => {
      const result = Exporter.downloadExportResult(db, tenantOf(req), req.params.ref);
      res.setHeader("Content-Type", result.content_type || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
      res.send(result.content);
    })
  );

  // ── Templates ─────────────────────────────────────────────────────────────
  router.get(
    "/templates",
    auth,
    canTemplates("read"),
    wrap((req, res) => res.json(Templates.listTemplates(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/templates",
    auth,
    canTemplates("create"),
    wrap((req, res) => res.status(201).json(Templates.createTemplate(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/templates/:ref",
    auth,
    canTemplates("read"),
    wrap((req, res) => res.json(Templates.getTemplate(db, tenantOf(req), req.params.ref)))
  );
  const updateTemplate = wrap((req, res) => res.json(Templates.updateTemplate(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/templates/:ref", auth, canTemplates("update"), updateTemplate);
  router.patch("/templates/:ref", auth, canTemplates("update"), updateTemplate);
  router.post(
    "/templates/:ref/status",
    auth,
    canTemplates("update"),
    wrap((req, res) => res.json(Templates.setTemplateStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/templates/:ref/versions",
    auth,
    canTemplates("update"),
    wrap((req, res) => res.status(201).json(Templates.createTemplateVersion(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/templates/:ref/validate",
    auth,
    canTemplates("read"),
    wrap((req, res) => res.json(Templates.validateTemplate(db, tenantOf(req), req.params.ref)))
  );

  // ── Jobs, history, configuration ──────────────────────────────────────────
  router.get(
    "/jobs",
    auth,
    canJobs("read"),
    wrap((req, res) => res.json(Jobs.listExchangeJobs(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/history",
    auth,
    canHistory("read"),
    wrap((req, res) => res.json(History.listHistory(db, { tenantId: tenantOf(req), ...req.query })))
  );
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

  // ── Internal run helpers ──────────────────────────────────────────────────
  function inlineRunParams(body = {}) {
    const params = { ...(body.params || {}) };
    if (body.content !== undefined) params.content = body.content;
    if (body.buffer !== undefined) params.buffer = body.buffer;
    if (body.settings !== undefined) params.settings = body.settings;
    if (body.limit !== undefined) params.limit = body.limit;
    return params;
  }

  async function runImport(req, res) {
    const definition = ImportDefinitions.getImportDefinition(db, tenantOf(req), req.params.ref);
    const params = inlineRunParams(req.body || {});
    const mode = (req.body?.mode || "IMPORT").toUpperCase();
    const { job, existing } = Importer.createImportJob(db, {
      tenantId: tenantOf(req),
      definition,
      mode,
      params,
      actor: req.actor,
      ip: req.ip,
      idempotencyKey: idem(req),
    });
    if (existing) return res.status(200).json(Importer.getImportJob(db, tenantOf(req), job.job_ref));
    if (req.body?.async && mode === "IMPORT") {
      const submitted = Jobs.submitImportJob(db, { tenantId: tenantOf(req), importJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
      return res.status(202).json({ job, platform_job: submitted });
    }
    return res.status(201).json(await Importer.runImportJob(db, { jobId: job.id, params, actor: req.actor, ip: req.ip }));
  }

  async function runExport(req, res) {
    const definition = ExportDefinitions.getExportDefinition(db, tenantOf(req), req.params.ref);
    const params = inlineRunParams(req.body || {});
    const { job, existing } = Exporter.createExportJob(db, {
      tenantId: tenantOf(req),
      definition,
      params,
      actor: req.actor,
      ip: req.ip,
      idempotencyKey: idem(req),
    });
    if (existing) return res.status(200).json(Exporter.getExportJob(db, tenantOf(req), job.job_ref));
    if (req.body?.async) {
      const submitted = Jobs.submitExportJob(db, { tenantId: tenantOf(req), exportJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
      return res.status(202).json({ job, platform_job: submitted });
    }
    return res.status(201).json(await Exporter.runExportJob(db, { jobId: job.id, params, actor: req.actor, ip: req.ip }));
  }

  return router;
}
