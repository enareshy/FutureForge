// REST router for the P2 Standards & Exchange capability. Built as a factory so
// it reuses the application's async auth, authorization and error middleware.
// Mounted at /api/standards-exchange and /api/v1/standards-exchange.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization. The whole request path runs on
// the async `pg` layer so a slow query never stalls the process; only the pure
// meta/registration handlers stay synchronous.
import {
  Constants,
  Formats,
  Detection,
  Definitions,
  Mappings,
  Transformations,
  Validation,
  Processor,
  Reconciliation,
  History,
  Jobs,
  Metrics,
  Configuration,
  Search,
  Foundation,
  Seed,
  Integrations,
  Adapters,
} from "./index.js";

const R = Constants.EXCHANGE_RESOURCES;

export function createExchangeRouter({ express, db, auth, authAsync, can, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";
  const guard = authAsync || auth;
  const gate = canAsync || can;

  const canFormats = (a) => gate(R.formats, a);
  const canDefinitions = (a) => gate(R.definitions, a);
  const canImport = (a) => gate(R.importRun, a);
  const canExport = (a) => gate(R.exportRun, a);
  const canMappings = (a) => gate(R.mappings, a);
  const canTransformations = (a) => gate(R.transformations, a);
  const canValidation = (a) => gate(R.validation, a);
  const canJobs = (a) => gate(R.jobs, a);
  const canHistory = (a) => gate(R.history, a);
  const canSearch = (a) => gate(R.search, a);
  const canMetrics = (a) => gate(R.metrics, a);
  const canAudit = (a) => gate(R.audit, a);
  const canAdmin = (a) => gate(R.admin, a);

  const runOperation = (direction, operation) =>
    wrap(async (req, res) => {
      const input = { ...(req.body || {}), direction, operation };
      res.status(201).json(await Processor.executeAsync(db, tenantOf(req), input, req.actor, { ip: req.ip }));
    });

  // ── Meta, health, metrics ─────────────────────────────────────────────────
  router.get(
    "/meta",
    guard,
    canMetrics("read"),
    wrap((_req, res) => {
      res.json({
        source_module: Constants.SOURCE_MODULE,
        resources: R,
        capabilities: {
          formats: Constants.FORMAT_CATALOG.map((entry) => entry.code),
          adapters: Adapters.adapterCatalog(),
          directions: Constants.DIRECTIONS,
          operations: Constants.OPERATIONS,
          transaction_statuses: Constants.TRANSACTION_STATUSES,
          job_statuses: Constants.JOB_STATUSES,
          validation_levels: Constants.VALIDATION_LEVELS,
          severities: Constants.SEVERITIES,
          validation_statuses: Constants.VALIDATION_STATUSES,
          duplicate_strategies: Constants.DUPLICATE_STRATEGIES,
          error_strategies: Constants.ERROR_STRATEGIES,
          integrations: Integrations.listIntegrations(),
          config_defaults: Constants.CONFIG_DEFAULTS,
          limits: {
            max_payload_bytes: Constants.MAX_PAYLOAD_BYTES,
            max_records: Constants.MAX_RECORDS,
            max_batch_size: Constants.MAX_BATCH_SIZE,
          },
          job_types: Constants.EXCHANGE_JOB_TYPES.map((job) => job.code),
          handler_codes: Constants.EXCHANGE_HANDLER_CODES,
          search_types: Constants.SEARCH_OBJECT_TYPES.map((entry) => entry.code),
        },
      });
    })
  );

  router.get("/health", guard, canMetrics("read"), wrap(async (req, res) => res.json({ ...(await Metrics.healthCheckAsync(db, tenantOf(req))), ...(await Foundation.exchangeHealthAsync(db, tenantOf(req))) })));
  router.get("/metrics", guard, canMetrics("read"), wrap(async (req, res) => res.json(await Metrics.metricsSnapshotAsync(db, tenantOf(req)))));
  router.get("/throughput", guard, canMetrics("read"), wrap(async (req, res) => res.json(await Metrics.throughputAsync(db, tenantOf(req), { limit: req.query.limit }))));

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get("/config", guard, canAdmin("read"), wrap(async (req, res) => res.json(await Configuration.listConfigAsync(db, tenantOf(req)))));
  const setConfig = wrap(async (req, res) => res.json({ key: req.params.key, value: await Configuration.setConfigAsync(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip) }));
  router.put("/config/:key", guard, canAdmin("update"), setConfig);
  router.patch("/config/:key", guard, canAdmin("update"), setConfig);

  // ── Adapters ──────────────────────────────────────────────────────────────
  router.get("/adapters", guard, canFormats("read"), wrap((_req, res) => res.json({ items: Adapters.adapterCatalog(), source_module: Constants.SOURCE_MODULE })));
  router.get("/adapters/:code", guard, canFormats("read"), wrap(async (req, res) => res.json({ item: await Formats.getAdapterAsync(db, tenantOf(req), req.params.code), source_module: Constants.SOURCE_MODULE })));
  router.get("/integrations", guard, canFormats("read"), wrap((_req, res) => res.json({ items: Integrations.listIntegrations(), source_module: Constants.SOURCE_MODULE })));

  // ── Format registry ───────────────────────────────────────────────────────
  router.get("/formats", guard, canFormats("read"), wrap(async (req, res) => res.json(await Formats.listFormatsAsync(db, tenantOf(req), { ...req.query }))));
  router.post("/formats", guard, canFormats("create"), wrap(async (req, res) => res.status(201).json(await Formats.createFormatAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/formats/:ref", guard, canFormats("read"), wrap(async (req, res) => res.json(await Formats.getFormatAsync(db, tenantOf(req), req.params.ref))));
  const updateFormat = wrap(async (req, res) => res.json(await Formats.updateFormatAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor)));
  router.put("/formats/:ref", guard, canFormats("update"), updateFormat);
  router.patch("/formats/:ref", guard, canFormats("update"), updateFormat);
  router.post("/formats/:ref/status", guard, canFormats("update"), wrap(async (req, res) => res.json(await Formats.setFormatStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor))));
  router.delete("/formats/:ref", guard, canFormats("delete"), wrap(async (req, res) => res.json(await Formats.deleteFormatAsync(db, tenantOf(req), req.params.ref))));
  router.get("/formats/:ref/versions", guard, canFormats("read"), wrap(async (req, res) => res.json(await Formats.listFormatVersionsAsync(db, tenantOf(req), req.params.ref))));
  router.post("/formats/:ref/versions", guard, canFormats("create"), wrap(async (req, res) => res.status(201).json(await Formats.createFormatVersionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor))));

  // ── Detection ─────────────────────────────────────────────────────────────
  router.post(
    "/detect",
    guard,
    canImport("read"),
    wrap(async (req, res) => {
      const body = req.body || {};
      res.json(await Detection.detectFormatAsync(db, tenantOf(req), { payload: body.payload, fileName: body.file_name || body.fileName || "", mimeType: body.mime_type || body.mimeType || "", formatHint: body.format_code || body.formatCode || "" }));
    })
  );

  // ── Exchange definitions ──────────────────────────────────────────────────
  router.get("/definitions", guard, canDefinitions("read"), wrap(async (req, res) => res.json(await Definitions.listDefinitionsAsync(db, tenantOf(req), { ...req.query }))));
  router.post("/definitions", guard, canDefinitions("create"), wrap(async (req, res) => res.status(201).json(await Definitions.createDefinitionAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/definitions/summary", guard, canDefinitions("read"), wrap(async (req, res) => res.json(await Definitions.definitionSummaryAsync(db, tenantOf(req)))));
  router.get("/definitions/:ref", guard, canDefinitions("read"), wrap(async (req, res) => res.json(await Definitions.getDefinitionAsync(db, tenantOf(req), req.params.ref))));
  const updateDefinition = wrap(async (req, res) => res.json(await Definitions.updateDefinitionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor)));
  router.put("/definitions/:ref", guard, canDefinitions("update"), updateDefinition);
  router.patch("/definitions/:ref", guard, canDefinitions("update"), updateDefinition);
  router.post("/definitions/:ref/publish", guard, canDefinitions("update"), wrap(async (req, res) => res.json(await Definitions.publishDefinitionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor))));
  router.post("/definitions/:ref/status", guard, canDefinitions("update"), wrap(async (req, res) => res.json(await Definitions.setDefinitionStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor))));
  router.delete("/definitions/:ref", guard, canDefinitions("delete"), wrap(async (req, res) => res.json(await Definitions.deleteDefinitionAsync(db, tenantOf(req), req.params.ref))));
  router.get("/definitions/:ref/versions", guard, canDefinitions("read"), wrap(async (req, res) => res.json(await Definitions.listDefinitionVersionsAsync(db, tenantOf(req), req.params.ref))));
  router.get("/definitions/:ref/versions/:version", guard, canDefinitions("read"), wrap(async (req, res) => res.json(await Definitions.getDefinitionVersionAsync(db, tenantOf(req), req.params.ref, req.params.version))));

  // ── Mappings ──────────────────────────────────────────────────────────────
  router.get("/mappings", guard, canMappings("read"), wrap(async (req, res) => res.json(await Mappings.listMappingsAsync(db, tenantOf(req), { ...req.query }))));
  router.post("/mappings", guard, canMappings("create"), wrap(async (req, res) => res.status(201).json(await Mappings.createMappingAsync(db, tenantOf(req), req.body || {}, req.actor))));
  router.get("/mappings/:ref", guard, canMappings("read"), wrap(async (req, res) => res.json(await Mappings.getMappingAsync(db, tenantOf(req), req.params.ref))));
  const updateMapping = wrap(async (req, res) => res.json(await Mappings.updateMappingAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor)));
  router.put("/mappings/:ref", guard, canMappings("update"), updateMapping);
  router.patch("/mappings/:ref", guard, canMappings("update"), updateMapping);
  router.post("/mappings/:ref/publish", guard, canMappings("update"), wrap(async (req, res) => res.json(await Mappings.publishMappingAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor))));
  router.get("/mappings/:ref/versions", guard, canMappings("read"), wrap(async (req, res) => res.json(await Mappings.listMappingVersionsAsync(db, tenantOf(req), req.params.ref))));
  router.post("/mappings/:ref/validate", guard, canMappings("read"), wrap(async (req, res) => res.json(await Mappings.validateMappingAsync(db, tenantOf(req), req.params.ref, req.body || {}))));
  router.post("/mappings/:ref/apply", guard, canMappings("read"), wrap(async (req, res) => res.json(await Mappings.applyMappingRecordAsync(db, tenantOf(req), req.params.ref, req.body?.record || {}))));
  router.delete("/mappings/:ref", guard, canMappings("delete"), wrap(async (req, res) => res.json(await Mappings.deleteMappingAsync(db, tenantOf(req), req.params.ref))));

  // ── Transformations ───────────────────────────────────────────────────────
  router.get("/transformations", guard, canTransformations("read"), wrap(async (req, res) => res.json(await Transformations.listTransformationsAsync(db, tenantOf(req), { ...req.query }))));
  router.post("/transformations", guard, canTransformations("create"), wrap(async (req, res) => res.status(201).json(await Transformations.createTransformationAsync(db, tenantOf(req), req.body || {}, req.actor))));
  router.get("/transformations/:ref", guard, canTransformations("read"), wrap(async (req, res) => res.json(await Transformations.getTransformationAsync(db, tenantOf(req), req.params.ref))));
  const updateTransformation = wrap(async (req, res) => res.json(await Transformations.updateTransformationAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor)));
  router.put("/transformations/:ref", guard, canTransformations("update"), updateTransformation);
  router.patch("/transformations/:ref", guard, canTransformations("update"), updateTransformation);
  router.post("/transformations/:ref/publish", guard, canTransformations("update"), wrap(async (req, res) => res.json(await Transformations.publishTransformationAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor))));
  router.get("/transformations/:ref/versions", guard, canTransformations("read"), wrap(async (req, res) => res.json(await Transformations.listTransformationVersionsAsync(db, tenantOf(req), req.params.ref))));
  router.post("/transformations/:ref/validate", guard, canTransformations("read"), wrap(async (req, res) => res.json(await Transformations.validateTransformationAsync(db, tenantOf(req), req.params.ref))));
  router.post("/transformations/:ref/apply", guard, canTransformations("read"), wrap(async (req, res) => res.json(await Transformations.applyTransformationProfileAsync(db, tenantOf(req), req.params.ref, req.body?.record || {}, { context: req.body?.context || {} }))));
  router.delete("/transformations/:ref", guard, canTransformations("delete"), wrap(async (req, res) => res.json(await Transformations.deleteTransformationAsync(db, tenantOf(req), req.params.ref))));

  // ── Validation profiles ───────────────────────────────────────────────────
  router.get("/validation-profiles", guard, canValidation("read"), wrap(async (req, res) => res.json(await Validation.listValidationProfilesAsync(db, tenantOf(req), { ...req.query }))));
  router.post("/validation-profiles", guard, canValidation("create"), wrap(async (req, res) => res.status(201).json(await Validation.createValidationProfileAsync(db, tenantOf(req), req.body || {}, req.actor))));
  router.get("/validation-profiles/:ref", guard, canValidation("read"), wrap(async (req, res) => res.json(await Validation.getValidationProfileAsync(db, tenantOf(req), req.params.ref))));
  const updateValidationProfile = wrap(async (req, res) => res.json(await Validation.updateValidationProfileAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor)));
  router.put("/validation-profiles/:ref", guard, canValidation("update"), updateValidationProfile);
  router.patch("/validation-profiles/:ref", guard, canValidation("update"), updateValidationProfile);
  router.post("/validation-profiles/:ref/rules", guard, canValidation("update"), wrap(async (req, res) => res.status(201).json(await Validation.addValidationRuleAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor))));
  router.delete("/validation-profiles/:ref/rules/:ruleId", guard, canValidation("update"), wrap(async (req, res) => res.json(await Validation.deleteValidationRuleAsync(db, tenantOf(req), req.params.ref, req.params.ruleId))));
  router.post("/validation-profiles/:ref/status", guard, canValidation("update"), wrap(async (req, res) => res.json(await Validation.setValidationProfileStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor))));
  router.delete("/validation-profiles/:ref", guard, canValidation("delete"), wrap(async (req, res) => res.json(await Validation.deleteValidationProfileAsync(db, tenantOf(req), req.params.ref))));

  // ── Exchange operations ───────────────────────────────────────────────────
  router.post("/import", guard, canImport("execute"), runOperation("IMPORT", "EXECUTE"));
  router.post("/import/preview", guard, canImport("read"), runOperation("IMPORT", "PREVIEW"));
  router.post("/import/dry-run", guard, canImport("read"), runOperation("IMPORT", "DRY_RUN"));
  router.post("/validate", guard, canValidation("execute"), wrap(async (req, res) => res.status(201).json(await Processor.executeAsync(db, tenantOf(req), { ...(req.body || {}), operation: "VALIDATE_ONLY" }, req.actor, { ip: req.ip }))));
  router.post("/export", guard, canExport("execute"), runOperation("EXPORT", "EXPORT"));
  router.post("/export/preview", guard, canExport("read"), runOperation("EXPORT", "PREVIEW"));

  // ── Transactions ──────────────────────────────────────────────────────────
  router.get("/transactions", guard, canHistory("read"), wrap(async (req, res) => res.json(await Processor.listTransactionsAsync(db, tenantOf(req), { ...req.query }))));
  router.get("/transactions/summary", guard, canHistory("read"), wrap(async (req, res) => res.json(await Processor.transactionSummaryAsync(db, tenantOf(req)))));
  router.get("/transactions/:ref", guard, canHistory("read"), wrap(async (req, res) => res.json(await Processor.getTransactionAsync(db, tenantOf(req), req.params.ref))));
  router.post("/transactions/:ref/cancel", guard, canImport("execute"), wrap(async (req, res) => res.json(await Processor.cancelTransactionAsync(db, tenantOf(req), req.params.ref, req.actor))));
  router.post("/transactions/:ref/reconcile", guard, canHistory("read"), wrap(async (req, res) => res.json(await Reconciliation.reconcileTransactionAsync(db, tenantOf(req), req.params.ref, { actor: req.actor, ip: req.ip }))));

  // ── Reconciliation ────────────────────────────────────────────────────────
  router.get("/reconciliations", guard, canHistory("read"), wrap(async (req, res) => res.json(await Reconciliation.listReconciliationsAsync(db, tenantOf(req), { ...req.query }))));
  router.get("/reconciliations/:ref", guard, canHistory("read"), wrap(async (req, res) => res.json(await Reconciliation.getReconciliationAsync(db, tenantOf(req), req.params.ref))));

  // ── Errors, history & audit ───────────────────────────────────────────────
  router.get("/errors", guard, canHistory("read"), wrap(async (req, res) => res.json(await History.listErrorsAsync(db, { tenantId: tenantOf(req), ...req.query }))));
  router.get("/errors/summary", guard, canHistory("read"), wrap(async (req, res) => res.json(await History.errorSummaryAsync(db, tenantOf(req), req.query.transaction_ref || null))));
  router.post("/errors/:id/status", guard, canHistory("update"), wrap(async (req, res) => res.json(await History.setErrorStatusAsync(db, tenantOf(req), req.params.id, req.body?.status))));
  router.get("/history", guard, canAudit("read"), wrap(async (req, res) => res.json(await History.listHistoryAsync(db, { tenantId: tenantOf(req), ...req.query }))));
  router.get("/history/:transactionRef", guard, canAudit("read"), wrap(async (req, res) => res.json({ items: await History.transactionTimelineAsync(db, tenantOf(req), req.params.transactionRef) })));

  // ── Search & discovery ────────────────────────────────────────────────────
  router.post("/search/reindex", guard, canSearch("execute"), wrap((_req, res) => res.json({ registered: Search.registerExchangeSources() })));
  router.get("/search-meta", guard, canSearch("read"), wrap((_req, res) => res.json({ object_types: Constants.SEARCH_OBJECT_TYPES })));

  // ── Background jobs ───────────────────────────────────────────────────────
  router.get("/jobs", guard, canJobs("read"), wrap(async (req, res) => res.json(await Jobs.listExchangeJobsAsync(db, tenantOf(req), { ...req.query }))));
  router.get("/jobs/:ref", guard, canJobs("read"), wrap(async (req, res) => res.json(await Jobs.getExchangeJobAsync(db, tenantOf(req), req.params.ref))));
  router.post("/jobs/import", guard, canImport("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitImportJobAsync(db, { tenantId: tenantOf(req), body: req.body || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/export", guard, canExport("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitExportJobAsync(db, { tenantId: tenantOf(req), body: req.body || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/validate", guard, canValidation("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitValidateJobAsync(db, { tenantId: tenantOf(req), body: req.body || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/reconcile", guard, canHistory("read"), wrap(async (req, res) => res.status(202).json(await Jobs.submitReconcileJobAsync(db, { tenantId: tenantOf(req), transactionRef: req.body?.transaction_ref || req.body?.transactionRef, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/maintenance", guard, canAdmin("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitMaintenanceJobAsync(db, { tenantId: tenantOf(req), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));

  // ── Foundation & demo seed ────────────────────────────────────────────────
  router.post("/foundation/ensure", guard, canAdmin("execute"), wrap(async (_req, res) => res.json(await Foundation.ensureExchangeFoundationAsync(db))));
  router.post("/seed", guard, canAdmin("execute"), wrap(async (req, res) => res.json(await Seed.seedExchangeAsync(db, tenantOf(req)))));

  return router;
}
