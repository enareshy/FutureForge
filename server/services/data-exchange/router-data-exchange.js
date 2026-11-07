// REST router for the centralized Import & Export Framework. Built as a factory
// so it reuses the application's auth, authorization and error middleware.
// Mounted at /api/data-exchange and /api/v1/data-exchange.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization. The router runs entirely on
// the asynchronous PostgreSQL data-access layer.
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

export function createDataExchangeRouter({ express, db, auth, authAsync, can, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";

  const canOverview = (a) => canAsync(R.overview, a);
  const canImports = (a) => canAsync(R.imports, a);
  const canImportDefs = (a) => canAsync(R.importDefinitions, a);
  const canExports = (a) => canAsync(R.exports, a);
  const canExportDefs = (a) => canAsync(R.exportDefinitions, a);
  const canConnectors = (a) => canAsync(R.connectors, a);
  const canTemplates = (a) => canAsync(R.templates, a);
  const canHistory = (a) => canAsync(R.history, a);
  const canJobs = (a) => canAsync(R.jobs, a);
  const canMetrics = (a) => canAsync(R.metrics, a);
  const canAdmin = (a) => canAsync(R.admin, a);

  const withDefinition = (req) => ImportDefinitions.getImportDefinitionAsync(db, tenantOf(req), req.params.ref);

  // ── Meta, health, metrics, connectors ─────────────────────────────────────
  router.get(
    "/meta",
    authAsync,
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
    authAsync,
    canMetrics("read"),
    wrap(async (req, res) =>
      res.json({
        ...(await Metrics.healthCheckAsync(db, { tenantId: tenantOf(req) })),
        ...(await Foundation.exchangeHealthAsync(db, tenantOf(req))),
      })
    )
  );

  router.get(
    "/metrics",
    authAsync,
    canMetrics("read"),
    wrap(async (req, res) => res.json(await Metrics.metricsSnapshotAsync(db, { tenantId: tenantOf(req) })))
  );

  router.get(
    "/connectors",
    authAsync,
    canConnectors("read"),
    wrap((_req, res) => res.json({ items: Connectors.list(), types: constants.CONNECTOR_TYPES }))
  );

  // ── Connector configurations ──────────────────────────────────────────────
  router.get(
    "/connector-configurations",
    authAsync,
    canConnectors("read"),
    wrap(async (req, res) => res.json(await ConnectorConfigs.listConnectorConfigurationsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/connector-configurations",
    authAsync,
    canConnectors("create"),
    wrap(async (req, res) => res.status(201).json(await ConnectorConfigs.createConnectorConfigurationAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/connector-configurations/test",
    authAsync,
    canConnectors("read"),
    wrap(async (req, res) => res.json(await ConnectorConfigs.testConnectorConfigurationAsync(db, tenantOf(req), req.body?.ref || null, req.body || {})))
  );
  router.get(
    "/connector-configurations/:ref",
    authAsync,
    canConnectors("read"),
    wrap(async (req, res) => res.json(await ConnectorConfigs.getConnectorConfigurationAsync(db, tenantOf(req), req.params.ref)))
  );
  const updateConnector = wrap(async (req, res) => res.json(await ConnectorConfigs.updateConnectorConfigurationAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/connector-configurations/:ref", authAsync, canConnectors("update"), updateConnector);
  router.patch("/connector-configurations/:ref", authAsync, canConnectors("update"), updateConnector);
  router.post(
    "/connector-configurations/:ref/status",
    authAsync,
    canConnectors("update"),
    wrap(async (req, res) => res.json(await ConnectorConfigs.setConnectorConfigurationStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/connector-configurations/:ref/test",
    authAsync,
    canConnectors("read"),
    wrap(async (req, res) => res.json(await ConnectorConfigs.testConnectorConfigurationAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/connector-configurations/:ref/discover",
    authAsync,
    canConnectors("read"),
    wrap(async (req, res) => res.json(await ConnectorConfigs.discoverConnectorConfigurationSchemaAsync(db, tenantOf(req), req.params.ref, req.body || {})))
  );

  // ── Credential references (opaque secret_ref only) ────────────────────────
  router.get(
    "/credential-references",
    authAsync,
    canConnectors("read"),
    wrap(async (req, res) => res.json(await ConnectorConfigs.listCredentialReferencesAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/credential-references",
    authAsync,
    canConnectors("create"),
    wrap(async (req, res) => res.status(201).json(await ConnectorConfigs.createCredentialReferenceAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/credential-references/:ref/status",
    authAsync,
    canConnectors("update"),
    wrap(async (req, res) => res.json(await ConnectorConfigs.setCredentialReferenceStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );

  // ── Import definitions ────────────────────────────────────────────────────
  router.get(
    "/import-definitions",
    authAsync,
    canImportDefs("read"),
    wrap(async (req, res) => res.json(await ImportDefinitions.listImportDefinitionsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/import-definitions",
    authAsync,
    canImportDefs("create"),
    wrap(async (req, res) => res.status(201).json(await ImportDefinitions.createImportDefinitionAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/import-definitions/:ref",
    authAsync,
    canImportDefs("read"),
    wrap(async (req, res) => res.json(await ImportDefinitions.getImportDefinitionAsync(db, tenantOf(req), req.params.ref)))
  );
  const updateImportDef = wrap(async (req, res) => res.json(await ImportDefinitions.updateImportDefinitionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/import-definitions/:ref", authAsync, canImportDefs("update"), updateImportDef);
  router.patch("/import-definitions/:ref", authAsync, canImportDefs("update"), updateImportDef);
  router.post(
    "/import-definitions/:ref/status",
    authAsync,
    canImportDefs("update"),
    wrap(async (req, res) => res.json(await ImportDefinitions.setImportDefinitionStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/import-definitions/:ref/versions",
    authAsync,
    canImportDefs("update"),
    wrap(async (req, res) => res.status(201).json(await ImportDefinitions.createImportDefinitionVersionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/import-definitions/:ref/versions",
    authAsync,
    canImportDefs("read"),
    wrap(async (req, res) => res.json(await ImportDefinitions.listImportDefinitionVersionsAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/import-definitions/:ref/validate",
    authAsync,
    canImports("read"),
    wrap(async (req, res) => res.json(await ImportDefinitions.validateImportDefinitionAsync(db, tenantOf(req), req.params.ref, req.body || {})))
  );
  router.get(
    "/import-definitions/:ref/catalog",
    authAsync,
    canImportDefs("read"),
    wrap(async (req, res) => {
      const definition = await ImportDefinitions.getImportDefinitionAsync(db, tenantOf(req), req.params.ref);
      res.json(await Catalog.resolveCatalogRefsAsync(db, tenantOf(req), definition.catalog_refs || {}));
    })
  );
  router.post(
    "/import-definitions/:ref/preview",
    authAsync,
    canImports("read"),
    wrap(async (req, res) => res.json(await Importer.previewImportAsync(db, tenantOf(req), await withDefinition(req), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/import-definitions/:ref/run",
    authAsync,
    canImports("execute"),
    wrap(async (req, res) => runImport(req, res))
  );

  // ── Import jobs ───────────────────────────────────────────────────────────
  router.get(
    "/import-jobs",
    authAsync,
    canImports("read"),
    wrap(async (req, res) => res.json(await Importer.listImportJobsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/import-jobs/:ref",
    authAsync,
    canImports("read"),
    wrap(async (req, res) => res.json(await Importer.getImportJobAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/import-jobs/:ref/run",
    authAsync,
    canImports("execute"),
    wrap(async (req, res) => {
      const job = await Importer.getImportJobAsync(db, tenantOf(req), req.params.ref);
      if (req.body?.async) {
        const submitted = await Jobs.submitImportJobAsync(db, { tenantId: tenantOf(req), importJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
        return res.status(202).json({ job, platform_job: submitted });
      }
      res.json(await Importer.runImportJobAsync(db, { jobId: job.id, params: req.body?.params || {}, actor: req.actor, ip: req.ip }));
    })
  );
  router.post(
    "/import-jobs/:ref/reconcile",
    authAsync,
    canImports("execute"),
    wrap(async (req, res) => {
      const job = await Importer.getImportJobAsync(db, tenantOf(req), req.params.ref);
      res.json({ job_ref: job.job_ref, reconciliation: await Jobs.reconcileImportJobAsync(db, { tenantId: tenantOf(req), importJobId: job.id }) });
    })
  );
  router.post(
    "/import-jobs/:ref/retry",
    authAsync,
    canImports("execute"),
    wrap(async (req, res) => {
      const job = await Importer.getImportJobAsync(db, tenantOf(req), req.params.ref);
      res.json(await Jobs.retryImportJobAsync(db, { tenantId: tenantOf(req), importJobId: job.id, actor: req.actor, ip: req.ip }));
    })
  );
  router.post(
    "/import-jobs/:ref/cancel",
    authAsync,
    canImports("execute"),
    wrap(async (req, res) => res.json(await Importer.cancelImportJobAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/import-jobs/:ref/records",
    authAsync,
    canImports("read"),
    wrap(async (req, res) => {
      const job = await Importer.getImportJobAsync(db, tenantOf(req), req.params.ref);
      res.json(await Importer.listImportRecordResultsAsync(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query }));
    })
  );
  router.get(
    "/import-jobs/:ref/errors",
    authAsync,
    canImports("read"),
    wrap(async (req, res) => {
      const job = await Importer.getImportJobAsync(db, tenantOf(req), req.params.ref);
      res.json(await Importer.listImportErrorsAsync(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query }));
    })
  );
  router.get(
    "/import-errors",
    authAsync,
    canImports("read"),
    wrap(async (req, res) => res.json(await Importer.listImportErrorsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );

  // ── Export definitions ────────────────────────────────────────────────────
  router.get(
    "/export-definitions",
    authAsync,
    canExportDefs("read"),
    wrap(async (req, res) => res.json(await ExportDefinitions.listExportDefinitionsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/export-definitions",
    authAsync,
    canExportDefs("create"),
    wrap(async (req, res) => res.status(201).json(await ExportDefinitions.createExportDefinitionAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/export-definitions/:ref",
    authAsync,
    canExportDefs("read"),
    wrap(async (req, res) => res.json(await ExportDefinitions.getExportDefinitionAsync(db, tenantOf(req), req.params.ref)))
  );
  const updateExportDef = wrap(async (req, res) => res.json(await ExportDefinitions.updateExportDefinitionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/export-definitions/:ref", authAsync, canExportDefs("update"), updateExportDef);
  router.patch("/export-definitions/:ref", authAsync, canExportDefs("update"), updateExportDef);
  router.post(
    "/export-definitions/:ref/status",
    authAsync,
    canExportDefs("update"),
    wrap(async (req, res) => res.json(await ExportDefinitions.setExportDefinitionStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/export-definitions/:ref/versions",
    authAsync,
    canExportDefs("update"),
    wrap(async (req, res) => res.status(201).json(await ExportDefinitions.createExportDefinitionVersionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/export-definitions/:ref/versions",
    authAsync,
    canExportDefs("read"),
    wrap(async (req, res) => res.json(await ExportDefinitions.listExportDefinitionVersionsAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/export-definitions/:ref/validate",
    authAsync,
    canExports("read"),
    wrap(async (req, res) => res.json(await ExportDefinitions.validateExportDefinitionAsync(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/export-definitions/:ref/catalog",
    authAsync,
    canExportDefs("read"),
    wrap(async (req, res) => {
      const definition = await ExportDefinitions.getExportDefinitionAsync(db, tenantOf(req), req.params.ref);
      res.json(await Catalog.resolveCatalogRefsAsync(db, tenantOf(req), definition.catalog_refs || {}));
    })
  );
  router.post(
    "/export-definitions/:ref/preview",
    authAsync,
    canExports("read"),
    wrap(async (req, res) => res.json(await Exporter.previewExportAsync(db, tenantOf(req), await ExportDefinitions.getExportDefinitionAsync(db, tenantOf(req), req.params.ref), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/export-definitions/:ref/run",
    authAsync,
    canExports("execute"),
    wrap(async (req, res) => runExport(req, res))
  );

  // ── Export jobs ───────────────────────────────────────────────────────────
  router.get(
    "/export-jobs",
    authAsync,
    canExports("read"),
    wrap(async (req, res) => res.json(await Exporter.listExportJobsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/export-jobs/:ref",
    authAsync,
    canExports("read"),
    wrap(async (req, res) => res.json(await Exporter.getExportJobAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/export-jobs/:ref/run",
    authAsync,
    canExports("execute"),
    wrap(async (req, res) => {
      const job = await Exporter.getExportJobAsync(db, tenantOf(req), req.params.ref);
      if (req.body?.async) {
        const submitted = await Jobs.submitExportJobAsync(db, { tenantId: tenantOf(req), exportJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
        return res.status(202).json({ job, platform_job: submitted });
      }
      res.json(await Exporter.runExportJobAsync(db, { jobId: job.id, params: req.body?.params || {}, actor: req.actor, ip: req.ip }));
    })
  );
  router.post(
    "/export-jobs/:ref/cancel",
    authAsync,
    canExports("execute"),
    wrap(async (req, res) => res.json(await Exporter.cancelExportJobAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.get(
    "/export-jobs/:ref/results",
    authAsync,
    canExports("read"),
    wrap(async (req, res) => {
      const job = await Exporter.getExportJobAsync(db, tenantOf(req), req.params.ref);
      res.json(await Exporter.listExportResultsAsync(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query }));
    })
  );
  router.get(
    "/export-results",
    authAsync,
    canExports("read"),
    wrap(async (req, res) => res.json(await Exporter.listExportResultsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/export-results/:ref/download",
    authAsync,
    canExports("execute"),
    wrap(async (req, res) => {
      const result = await Exporter.downloadExportResultAsync(db, tenantOf(req), req.params.ref);
      res.setHeader("Content-Type", result.content_type || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${result.filename}"`);
      res.send(result.content);
    })
  );

  // ── Templates ─────────────────────────────────────────────────────────────
  router.get(
    "/templates",
    authAsync,
    canTemplates("read"),
    wrap(async (req, res) => res.json(await Templates.listTemplatesAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/templates",
    authAsync,
    canTemplates("create"),
    wrap(async (req, res) => res.status(201).json(await Templates.createTemplateAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/templates/:ref",
    authAsync,
    canTemplates("read"),
    wrap(async (req, res) => res.json(await Templates.getTemplateAsync(db, tenantOf(req), req.params.ref)))
  );
  const updateTemplate = wrap(async (req, res) => res.json(await Templates.updateTemplateAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/templates/:ref", authAsync, canTemplates("update"), updateTemplate);
  router.patch("/templates/:ref", authAsync, canTemplates("update"), updateTemplate);
  router.post(
    "/templates/:ref/status",
    authAsync,
    canTemplates("update"),
    wrap(async (req, res) => res.json(await Templates.setTemplateStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/templates/:ref/versions",
    authAsync,
    canTemplates("update"),
    wrap(async (req, res) => res.status(201).json(await Templates.createTemplateVersionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/templates/:ref/validate",
    authAsync,
    canTemplates("read"),
    wrap(async (req, res) => res.json(await Templates.validateTemplateAsync(db, tenantOf(req), req.params.ref)))
  );

  // ── Jobs, history, configuration ──────────────────────────────────────────
  router.get(
    "/jobs",
    authAsync,
    canJobs("read"),
    wrap(async (req, res) => res.json(await Jobs.listExchangeJobsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/history",
    authAsync,
    canHistory("read"),
    wrap(async (req, res) => res.json(await History.listHistoryAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
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
    const definition = await ImportDefinitions.getImportDefinitionAsync(db, tenantOf(req), req.params.ref);
    const params = inlineRunParams(req.body || {});
    const mode = (req.body?.mode || "IMPORT").toUpperCase();
    const { job, existing } = await Importer.createImportJobAsync(db, {
      tenantId: tenantOf(req),
      definition,
      mode,
      params,
      actor: req.actor,
      ip: req.ip,
      idempotencyKey: idem(req),
    });
    if (existing) return res.status(200).json(await Importer.getImportJobAsync(db, tenantOf(req), job.job_ref));
    if (req.body?.async && mode === "IMPORT") {
      const submitted = await Jobs.submitImportJobAsync(db, { tenantId: tenantOf(req), importJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
      return res.status(202).json({ job, platform_job: submitted });
    }
    return res.status(201).json(await Importer.runImportJobAsync(db, { jobId: job.id, params, actor: req.actor, ip: req.ip }));
  }

  async function runExport(req, res) {
    const definition = await ExportDefinitions.getExportDefinitionAsync(db, tenantOf(req), req.params.ref);
    const params = inlineRunParams(req.body || {});
    const { job, existing } = await Exporter.createExportJobAsync(db, {
      tenantId: tenantOf(req),
      definition,
      params,
      actor: req.actor,
      ip: req.ip,
      idempotencyKey: idem(req),
    });
    if (existing) return res.status(200).json(await Exporter.getExportJobAsync(db, tenantOf(req), job.job_ref));
    if (req.body?.async) {
      const submitted = await Jobs.submitExportJobAsync(db, { tenantId: tenantOf(req), exportJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
      return res.status(202).json({ job, platform_job: submitted });
    }
    return res.status(201).json(await Exporter.runExportJobAsync(db, { jobId: job.id, params, actor: req.actor, ip: req.ip }));
  }

  return router;
}
