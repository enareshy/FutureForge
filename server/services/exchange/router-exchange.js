// REST router for the P2 Standards & Exchange capability. Built as a factory so
// it reuses the application's auth, authorization and error middleware. Mounted
// at /api/standards-exchange and /api/v1/standards-exchange.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization.
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

export function createExchangeRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";

  const canFormats = (a) => can(R.formats, a);
  const canDefinitions = (a) => can(R.definitions, a);
  const canImport = (a) => can(R.importRun, a);
  const canExport = (a) => can(R.exportRun, a);
  const canMappings = (a) => can(R.mappings, a);
  const canTransformations = (a) => can(R.transformations, a);
  const canValidation = (a) => can(R.validation, a);
  const canJobs = (a) => can(R.jobs, a);
  const canHistory = (a) => can(R.history, a);
  const canSearch = (a) => can(R.search, a);
  const canMetrics = (a) => can(R.metrics, a);
  const canAudit = (a) => can(R.audit, a);
  const canAdmin = (a) => can(R.admin, a);

  const runOperation = (direction, operation) =>
    wrap((req, res) => {
      const input = { ...(req.body || {}), direction, operation };
      res.status(201).json(Processor.execute(db, tenantOf(req), input, req.actor, { ip: req.ip }));
    });

  // ── Meta, health, metrics ─────────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
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

  router.get("/health", auth, canMetrics("read"), wrap((req, res) => res.json({ ...Metrics.healthCheck(db, tenantOf(req)), ...Foundation.exchangeHealth(db, tenantOf(req)) })));
  router.get("/metrics", auth, canMetrics("read"), wrap((req, res) => res.json(Metrics.metricsSnapshot(db, tenantOf(req)))));
  router.get("/throughput", auth, canMetrics("read"), wrap((req, res) => res.json(Metrics.throughput(db, tenantOf(req), { limit: req.query.limit }))));

  // ── Configuration ─────────────────────────────────────────────────────────
  router.get("/config", auth, canAdmin("read"), wrap((req, res) => res.json(Configuration.listConfig(db, tenantOf(req)))));
  const setConfig = wrap((req, res) => res.json({ key: req.params.key, value: Configuration.setConfig(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip) }));
  router.put("/config/:key", auth, canAdmin("update"), setConfig);
  router.patch("/config/:key", auth, canAdmin("update"), setConfig);

  // ── Adapters ──────────────────────────────────────────────────────────────
  router.get("/adapters", auth, canFormats("read"), wrap((_req, res) => res.json({ items: Adapters.adapterCatalog(), source_module: Constants.SOURCE_MODULE })));
  router.get("/adapters/:code", auth, canFormats("read"), wrap((req, res) => res.json({ item: Formats.getAdapter(db, tenantOf(req), req.params.code), source_module: Constants.SOURCE_MODULE })));
  router.get("/integrations", auth, canFormats("read"), wrap((_req, res) => res.json({ items: Integrations.listIntegrations(), source_module: Constants.SOURCE_MODULE })));

  // ── Format registry ───────────────────────────────────────────────────────
  router.get("/formats", auth, canFormats("read"), wrap((req, res) => res.json(Formats.listFormats(db, tenantOf(req), { ...req.query }))));
  router.post("/formats", auth, canFormats("create"), wrap((req, res) => res.status(201).json(Formats.createFormat(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/formats/:ref", auth, canFormats("read"), wrap((req, res) => res.json(Formats.getFormat(db, tenantOf(req), req.params.ref))));
  const updateFormat = wrap((req, res) => res.json(Formats.updateFormat(db, tenantOf(req), req.params.ref, req.body || {}, req.actor)));
  router.put("/formats/:ref", auth, canFormats("update"), updateFormat);
  router.patch("/formats/:ref", auth, canFormats("update"), updateFormat);
  router.post("/formats/:ref/status", auth, canFormats("update"), wrap((req, res) => res.json(Formats.setFormatStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor))));
  router.delete("/formats/:ref", auth, canFormats("delete"), wrap((req, res) => res.json(Formats.deleteFormat(db, tenantOf(req), req.params.ref))));
  router.get("/formats/:ref/versions", auth, canFormats("read"), wrap((req, res) => res.json(Formats.listFormatVersions(db, tenantOf(req), req.params.ref))));
  router.post("/formats/:ref/versions", auth, canFormats("create"), wrap((req, res) => res.status(201).json(Formats.createFormatVersion(db, tenantOf(req), req.params.ref, req.body || {}, req.actor))));

  // ── Detection ─────────────────────────────────────────────────────────────
  router.post(
    "/detect",
    auth,
    canImport("read"),
    wrap((req, res) => {
      const body = req.body || {};
      res.json(Detection.detectFormat(db, tenantOf(req), { payload: body.payload, fileName: body.file_name || body.fileName || "", mimeType: body.mime_type || body.mimeType || "", formatHint: body.format_code || body.formatCode || "" }));
    })
  );

  // ── Exchange definitions ──────────────────────────────────────────────────
  router.get("/definitions", auth, canDefinitions("read"), wrap((req, res) => res.json(Definitions.listDefinitions(db, tenantOf(req), { ...req.query }))));
  router.post("/definitions", auth, canDefinitions("create"), wrap((req, res) => res.status(201).json(Definitions.createDefinition(db, tenantOf(req), req.body || {}, req.actor, req.ip))));
  router.get("/definitions/summary", auth, canDefinitions("read"), wrap((req, res) => res.json(Definitions.definitionSummary(db, tenantOf(req)))));
  router.get("/definitions/:ref", auth, canDefinitions("read"), wrap((req, res) => res.json(Definitions.getDefinition(db, tenantOf(req), req.params.ref))));
  const updateDefinition = wrap((req, res) => res.json(Definitions.updateDefinition(db, tenantOf(req), req.params.ref, req.body || {}, req.actor)));
  router.put("/definitions/:ref", auth, canDefinitions("update"), updateDefinition);
  router.patch("/definitions/:ref", auth, canDefinitions("update"), updateDefinition);
  router.post("/definitions/:ref/publish", auth, canDefinitions("update"), wrap((req, res) => res.json(Definitions.publishDefinition(db, tenantOf(req), req.params.ref, req.body || {}, req.actor))));
  router.post("/definitions/:ref/status", auth, canDefinitions("update"), wrap((req, res) => res.json(Definitions.setDefinitionStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor))));
  router.delete("/definitions/:ref", auth, canDefinitions("delete"), wrap((req, res) => res.json(Definitions.deleteDefinition(db, tenantOf(req), req.params.ref))));
  router.get("/definitions/:ref/versions", auth, canDefinitions("read"), wrap((req, res) => res.json(Definitions.listDefinitionVersions(db, tenantOf(req), req.params.ref))));
  router.get("/definitions/:ref/versions/:version", auth, canDefinitions("read"), wrap((req, res) => res.json(Definitions.getDefinitionVersion(db, tenantOf(req), req.params.ref, req.params.version))));

  // ── Mappings ──────────────────────────────────────────────────────────────
  router.get("/mappings", auth, canMappings("read"), wrap((req, res) => res.json(Mappings.listMappings(db, tenantOf(req), { ...req.query }))));
  router.post("/mappings", auth, canMappings("create"), wrap((req, res) => res.status(201).json(Mappings.createMapping(db, tenantOf(req), req.body || {}, req.actor))));
  router.get("/mappings/:ref", auth, canMappings("read"), wrap((req, res) => res.json(Mappings.getMapping(db, tenantOf(req), req.params.ref))));
  const updateMapping = wrap((req, res) => res.json(Mappings.updateMapping(db, tenantOf(req), req.params.ref, req.body || {}, req.actor)));
  router.put("/mappings/:ref", auth, canMappings("update"), updateMapping);
  router.patch("/mappings/:ref", auth, canMappings("update"), updateMapping);
  router.post("/mappings/:ref/publish", auth, canMappings("update"), wrap((req, res) => res.json(Mappings.publishMapping(db, tenantOf(req), req.params.ref, req.body || {}, req.actor))));
  router.get("/mappings/:ref/versions", auth, canMappings("read"), wrap((req, res) => res.json(Mappings.listMappingVersions(db, tenantOf(req), req.params.ref))));
  router.post("/mappings/:ref/validate", auth, canMappings("read"), wrap((req, res) => res.json(Mappings.validateMapping(db, tenantOf(req), req.params.ref, req.body || {}))));
  router.post("/mappings/:ref/apply", auth, canMappings("read"), wrap((req, res) => res.json(Mappings.applyMappingRecord(db, tenantOf(req), req.params.ref, req.body?.record || {}))));
  router.delete("/mappings/:ref", auth, canMappings("delete"), wrap((req, res) => res.json(Mappings.deleteMapping(db, tenantOf(req), req.params.ref))));

  // ── Transformations ───────────────────────────────────────────────────────
  router.get("/transformations", auth, canTransformations("read"), wrap((req, res) => res.json(Transformations.listTransformations(db, tenantOf(req), { ...req.query }))));
  router.post("/transformations", auth, canTransformations("create"), wrap((req, res) => res.status(201).json(Transformations.createTransformation(db, tenantOf(req), req.body || {}, req.actor))));
  router.get("/transformations/:ref", auth, canTransformations("read"), wrap((req, res) => res.json(Transformations.getTransformation(db, tenantOf(req), req.params.ref))));
  const updateTransformation = wrap((req, res) => res.json(Transformations.updateTransformation(db, tenantOf(req), req.params.ref, req.body || {}, req.actor)));
  router.put("/transformations/:ref", auth, canTransformations("update"), updateTransformation);
  router.patch("/transformations/:ref", auth, canTransformations("update"), updateTransformation);
  router.post("/transformations/:ref/publish", auth, canTransformations("update"), wrap((req, res) => res.json(Transformations.publishTransformation(db, tenantOf(req), req.params.ref, req.body || {}, req.actor))));
  router.get("/transformations/:ref/versions", auth, canTransformations("read"), wrap((req, res) => res.json(Transformations.listTransformationVersions(db, tenantOf(req), req.params.ref))));
  router.post("/transformations/:ref/validate", auth, canTransformations("read"), wrap((req, res) => res.json(Transformations.validateTransformation(db, tenantOf(req), req.params.ref))));
  router.post("/transformations/:ref/apply", auth, canTransformations("read"), wrap((req, res) => res.json(Transformations.applyTransformationProfile(db, tenantOf(req), req.params.ref, req.body?.record || {}, { context: req.body?.context || {} }))));
  router.delete("/transformations/:ref", auth, canTransformations("delete"), wrap((req, res) => res.json(Transformations.deleteTransformation(db, tenantOf(req), req.params.ref))));

  // ── Validation profiles ───────────────────────────────────────────────────
  router.get("/validation-profiles", auth, canValidation("read"), wrap((req, res) => res.json(Validation.listValidationProfiles(db, tenantOf(req), { ...req.query }))));
  router.post("/validation-profiles", auth, canValidation("create"), wrap((req, res) => res.status(201).json(Validation.createValidationProfile(db, tenantOf(req), req.body || {}, req.actor))));
  router.get("/validation-profiles/:ref", auth, canValidation("read"), wrap((req, res) => res.json(Validation.getValidationProfile(db, tenantOf(req), req.params.ref))));
  const updateValidationProfile = wrap((req, res) => res.json(Validation.updateValidationProfile(db, tenantOf(req), req.params.ref, req.body || {}, req.actor)));
  router.put("/validation-profiles/:ref", auth, canValidation("update"), updateValidationProfile);
  router.patch("/validation-profiles/:ref", auth, canValidation("update"), updateValidationProfile);
  router.post("/validation-profiles/:ref/rules", auth, canValidation("update"), wrap((req, res) => res.status(201).json(Validation.addValidationRule(db, tenantOf(req), req.params.ref, req.body || {}, req.actor))));
  router.delete("/validation-profiles/:ref/rules/:ruleId", auth, canValidation("update"), wrap((req, res) => res.json(Validation.deleteValidationRule(db, tenantOf(req), req.params.ref, req.params.ruleId))));
  router.post("/validation-profiles/:ref/status", auth, canValidation("update"), wrap((req, res) => res.json(Validation.setValidationProfileStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor))));
  router.delete("/validation-profiles/:ref", auth, canValidation("delete"), wrap((req, res) => res.json(Validation.deleteValidationProfile(db, tenantOf(req), req.params.ref))));

  // ── Exchange operations ───────────────────────────────────────────────────
  router.post("/import", auth, canImport("execute"), runOperation("IMPORT", "EXECUTE"));
  router.post("/import/preview", auth, canImport("read"), runOperation("IMPORT", "PREVIEW"));
  router.post("/import/dry-run", auth, canImport("read"), runOperation("IMPORT", "DRY_RUN"));
  router.post("/validate", auth, canValidation("execute"), wrap((req, res) => res.status(201).json(Processor.execute(db, tenantOf(req), { ...(req.body || {}), operation: "VALIDATE_ONLY" }, req.actor, { ip: req.ip }))));
  router.post("/export", auth, canExport("execute"), runOperation("EXPORT", "EXPORT"));
  router.post("/export/preview", auth, canExport("read"), runOperation("EXPORT", "PREVIEW"));

  // ── Transactions ──────────────────────────────────────────────────────────
  router.get("/transactions", auth, canHistory("read"), wrap((req, res) => res.json(Processor.listTransactions(db, tenantOf(req), { ...req.query }))));
  router.get("/transactions/summary", auth, canHistory("read"), wrap((req, res) => res.json(Processor.transactionSummary(db, tenantOf(req)))));
  router.get("/transactions/:ref", auth, canHistory("read"), wrap((req, res) => res.json(Processor.getTransaction(db, tenantOf(req), req.params.ref))));
  router.post("/transactions/:ref/cancel", auth, canImport("execute"), wrap((req, res) => res.json(Processor.cancelTransaction(db, tenantOf(req), req.params.ref, req.actor))));
  router.post("/transactions/:ref/reconcile", auth, canHistory("read"), wrap((req, res) => res.json(Reconciliation.reconcileTransaction(db, tenantOf(req), req.params.ref, { actor: req.actor, ip: req.ip }))));

  // ── Reconciliation ────────────────────────────────────────────────────────
  router.get("/reconciliations", auth, canHistory("read"), wrap((req, res) => res.json(Reconciliation.listReconciliations(db, tenantOf(req), { ...req.query }))));
  router.get("/reconciliations/:ref", auth, canHistory("read"), wrap((req, res) => res.json(Reconciliation.getReconciliation(db, tenantOf(req), req.params.ref))));

  // ── Errors, history & audit ───────────────────────────────────────────────
  router.get("/errors", auth, canHistory("read"), wrap((req, res) => res.json(History.listErrors(db, { tenantId: tenantOf(req), ...req.query }))));
  router.get("/errors/summary", auth, canHistory("read"), wrap((req, res) => res.json(History.errorSummary(db, tenantOf(req), req.query.transaction_ref || null))));
  router.post("/errors/:id/status", auth, canHistory("update"), wrap((req, res) => res.json(History.setErrorStatus(db, tenantOf(req), req.params.id, req.body?.status))));
  router.get("/history", auth, canAudit("read"), wrap((req, res) => res.json(History.listHistory(db, { tenantId: tenantOf(req), ...req.query }))));
  router.get("/history/:transactionRef", auth, canAudit("read"), wrap((req, res) => res.json({ items: History.transactionTimeline(db, tenantOf(req), req.params.transactionRef) })));

  // ── Search & discovery ────────────────────────────────────────────────────
  router.post("/search/reindex", auth, canSearch("execute"), wrap((_req, res) => res.json({ registered: Search.registerExchangeSources() })));
  router.get("/search-meta", auth, canSearch("read"), wrap((_req, res) => res.json({ object_types: Constants.SEARCH_OBJECT_TYPES })));

  // ── Background jobs ───────────────────────────────────────────────────────
  router.get("/jobs", auth, canJobs("read"), wrap((req, res) => res.json(Jobs.listExchangeJobs(db, tenantOf(req), { ...req.query }))));
  router.get("/jobs/:ref", auth, canJobs("read"), wrap((req, res) => res.json(Jobs.getExchangeJob(db, tenantOf(req), req.params.ref))));
  router.post("/jobs/import", auth, canImport("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitImportJob(db, { tenantId: tenantOf(req), body: req.body || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/export", auth, canExport("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitExportJob(db, { tenantId: tenantOf(req), body: req.body || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/validate", auth, canValidation("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitValidateJob(db, { tenantId: tenantOf(req), body: req.body || {}, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/reconcile", auth, canHistory("read"), wrap(async (req, res) => res.status(202).json(await Jobs.submitReconcileJob(db, { tenantId: tenantOf(req), transactionRef: req.body?.transaction_ref || req.body?.transactionRef, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));
  router.post("/jobs/maintenance", auth, canAdmin("execute"), wrap(async (req, res) => res.status(202).json(await Jobs.submitMaintenanceJob(db, { tenantId: tenantOf(req), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) }))));

  // ── Foundation & demo seed ────────────────────────────────────────────────
  router.post("/foundation/ensure", auth, canAdmin("execute"), wrap((_req, res) => res.json(Foundation.ensureExchangeFoundation(db))));
  router.post("/seed", auth, canAdmin("execute"), wrap((req, res) => res.json(Seed.seedExchange(db, tenantOf(req)))));

  return router;
}
