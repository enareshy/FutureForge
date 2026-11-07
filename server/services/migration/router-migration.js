// REST router for the Migration & Onboarding Framework. Built as a factory so it
// reuses the application's auth, authorization and error middleware. Mounted at
// /api/migration and /api/v1/migration.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization. The whole request path runs on
// the async `pg` layer so a slow query never stalls the process; only the pure
// in-memory `/meta` and `/source-adapters` handlers stay synchronous.
import {
  constants,
  Validation,
  Errors,
  Security,
  SourceConfigurations,
  SourceAdapters,
  Definitions,
  Projects,
  Packages,
  Dependencies,
  Planning,
  IdentifierMapping,
  Relationships,
  Execution,
  Reconciliation,
  Statistics,
  Files,
  Jobs,
  Configuration,
  Audit,
  Foundation,
  Seed,
} from "./index.js";

const R = constants.MIGRATION_RESOURCES;

export function createMigrationRouter({ express, db, auth, authAsync, can, canAsync, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";

  const guard = authAsync || auth;
  const gate = (resource, action) => (canAsync || can)(resource, action);

  const canOverview = (a) => gate(R.overview, a);
  const canProjects = (a) => gate(R.projects, a);
  const canPackages = (a) => gate(R.packages, a);
  const canDefinitions = (a) => gate(R.definitions, a);
  const canSources = (a) => gate(R.sources, a);
  const canMapping = (a) => gate(R.mapping, a);
  const canValidation = (a) => gate(R.validation, a);
  const canDependencies = (a) => gate(R.dependencies, a);
  const canPlanning = (a) => gate(R.planning, a);
  const canExecution = (a) => gate(R.execution, a);
  const canReconciliation = (a) => gate(R.reconciliation, a);
  const canIdentifiers = (a) => gate(R.identifiers, a);
  const canRelationships = (a) => gate(R.relationships, a);
  const canFiles = (a) => gate(R.files, a);
  const canAudit = (a) => gate(R.auditTrail, a);
  const canStatistics = (a) => gate(R.statistics, a);
  const canMetrics = (a) => gate(R.metrics, a);
  const canAdmin = (a) => gate(R.admin, a);

  const packageOf = async (req) => Packages.getPackageRowAsync(db, tenantOf(req), req.params.ref);
  const definitionOf = async (req) => Definitions.getDefinitionRowAsync(db, tenantOf(req), req.params.ref);
  const projectOf = async (req) => Projects.getProjectRowAsync(db, tenantOf(req), req.params.ref);

  // ── Meta, health, metrics ─────────────────────────────────────────────────
  router.get(
    "/meta",
    guard,
    canOverview("read"),
    wrap((_req, res) => {
      res.json({
        source_module: constants.SOURCE_MODULE,
        vocabularies: Validation.vocabulary(),
        security_actions: constants.SECURITY_ACTIONS,
        resources: R,
        capabilities: {
          pipeline_stages: constants.PIPELINE_STAGES,
          migration_scopes: constants.MIGRATION_SCOPES,
          source_adapter_types: constants.SOURCE_ADAPTER_TYPES,
          source_adapter_capabilities: constants.SOURCE_ADAPTER_CAPABILITIES,
          job_types: constants.MIGRATION_JOB_TYPES.map((job) => job.code),
          source_adapters: SourceAdapters.Registry.listSourceAdapters().map((adapter) => adapter.adapter_type),
          search_types: constants.SEARCH_OBJECT_TYPES.map((entry) => entry.code),
        },
      });
    })
  );

  router.get(
    "/health",
    guard,
    canMetrics("read"),
    wrap(async (req, res) =>
      res.json({
        ...(await Statistics.healthCheckAsync(db, { tenantId: tenantOf(req) })),
        ...(await Foundation.migrationHealthAsync(db, tenantOf(req))),
      })
    )
  );

  router.get(
    "/metrics",
    guard,
    canMetrics("read"),
    wrap(async (req, res) => res.json(await Statistics.metricsSnapshotAsync(db, { tenantId: tenantOf(req) })))
  );

  // ── Source adapters & configurations ──────────────────────────────────────
  router.get(
    "/source-adapters",
    guard,
    canSources("read"),
    wrap((_req, res) => res.json({ items: SourceAdapters.Registry.listSourceAdapters() }))
  );

  router.get(
    "/source-configurations",
    guard,
    canSources("read"),
    wrap(async (req, res) => res.json(await SourceConfigurations.listSourceConfigurationsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/source-configurations",
    guard,
    canSources("create"),
    wrap(async (req, res) => res.status(201).json(await SourceConfigurations.createSourceConfigurationAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/source-configurations/:ref",
    guard,
    canSources("read"),
    wrap(async (req, res) => res.json(await SourceConfigurations.getSourceConfigurationAsync(db, tenantOf(req), req.params.ref)))
  );
  const updateSource = wrap(async (req, res) => res.json(await SourceConfigurations.updateSourceConfigurationAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/source-configurations/:ref", guard, canSources("update"), updateSource);
  router.patch("/source-configurations/:ref", guard, canSources("update"), updateSource);
  router.post(
    "/source-configurations/:ref/status",
    guard,
    canSources("update"),
    wrap(async (req, res) => res.json(await SourceConfigurations.setSourceConfigurationStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/source-configurations/:ref/test",
    guard,
    canSources("read"),
    wrap(async (req, res) => res.json(await SourceConfigurations.testSourceConfigurationAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/source-configurations/:ref/discover",
    guard,
    canSources("read"),
    wrap(async (req, res) => res.json(await SourceConfigurations.discoverSourceConfigurationSchemaAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );

  // ── Projects ──────────────────────────────────────────────────────────────
  router.get(
    "/projects",
    guard,
    canProjects("read"),
    wrap(async (req, res) => res.json(await Projects.listProjectsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/projects",
    guard,
    canProjects("create"),
    wrap(async (req, res) => res.status(201).json(await Projects.createProjectAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/projects/:ref",
    guard,
    canProjects("read"),
    wrap(async (req, res) => res.json(await Projects.getProjectAsync(db, tenantOf(req), req.params.ref)))
  );
  const updateProject = wrap(async (req, res) => res.json(await Projects.updateProjectAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/projects/:ref", guard, canProjects("update"), updateProject);
  router.patch("/projects/:ref", guard, canProjects("update"), updateProject);
  router.post(
    "/projects/:ref/status",
    guard,
    canProjects("update"),
    wrap(async (req, res) => res.json(await Projects.setProjectStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.get(
    "/projects/:ref/packages",
    guard,
    canProjects("read"),
    wrap(async (req, res) => res.json(await Projects.listProjectPackagesAsync(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/projects/:ref/dependencies",
    guard,
    canDependencies("read"),
    wrap(async (req, res) => {
      const row = await projectOf(req);
      if (!row) return res.status(404).json({ error: "Migration project not found" });
      res.json({ items: await Dependencies.listProjectDependenciesAsync(db, tenantOf(req), row.id) });
    })
  );
  router.get(
    "/projects/:ref/topology",
    guard,
    canDependencies("read"),
    wrap(async (req, res) => {
      const row = await projectOf(req);
      if (!row) return res.status(404).json({ error: "Migration project not found" });
      res.json(await Dependencies.topologicalOrderAsync(db, tenantOf(req), row.id));
    })
  );
  router.get(
    "/projects/:ref/readiness",
    guard,
    canPlanning("read"),
    wrap(async (req, res) => res.json(await Planning.readinessReportAsync(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/projects/:ref/plans",
    guard,
    canPlanning("read"),
    wrap(async (req, res) => {
      const row = await projectOf(req);
      if (!row) return res.status(404).json({ error: "Migration project not found" });
      res.json(await Planning.listPlansAsync(db, tenantOf(req), { projectId: row.id, ...req.query }));
    })
  );
  router.post(
    "/projects/:ref/plans",
    guard,
    canPlanning("create"),
    wrap(async (req, res) => res.status(201).json(await Planning.generatePlanAsync(db, tenantOf(req), req.params.ref, { actor: req.actor, packageId: req.body?.package_id, ip: req.ip })))
  );

  // ── Plans ─────────────────────────────────────────────────────────────────
  router.get(
    "/plans",
    guard,
    canPlanning("read"),
    wrap(async (req, res) => res.json(await Planning.listPlansAsync(db, tenantOf(req), req.query)))
  );
  router.get(
    "/plans/:ref",
    guard,
    canPlanning("read"),
    wrap(async (req, res) => res.json(await Planning.getPlanAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/plans/:ref/approve",
    guard,
    canPlanning("update"),
    wrap(async (req, res) => res.json(await Planning.approvePlanAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );

  // ── Packages ──────────────────────────────────────────────────────────────
  router.get(
    "/packages",
    guard,
    canPackages("read"),
    wrap(async (req, res) => res.json(await Packages.listPackagesAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/packages",
    guard,
    canPackages("create"),
    wrap(async (req, res) => res.status(201).json(await Packages.createPackageAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/packages/:ref",
    guard,
    canPackages("read"),
    wrap(async (req, res) => res.json(await Packages.getPackageAsync(db, tenantOf(req), req.params.ref)))
  );
  const updatePackage = wrap(async (req, res) => res.json(await Packages.updatePackageAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/packages/:ref", guard, canPackages("update"), updatePackage);
  router.patch("/packages/:ref", guard, canPackages("update"), updatePackage);
  router.post(
    "/packages/:ref/status",
    guard,
    canPackages("update"),
    wrap(async (req, res) => res.json(await Packages.setPackageStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.get(
    "/packages/:ref/dependencies",
    guard,
    canDependencies("read"),
    wrap(async (req, res) => {
      const row = await packageOf(req);
      if (!row) return res.status(404).json({ error: "Migration package not found" });
      res.json({ items: await Dependencies.listPackageDependenciesAsync(db, tenantOf(req), row.id) });
    })
  );
  router.get(
    "/packages/:ref/readiness",
    guard,
    canPlanning("read"),
    wrap(async (req, res) => {
      const row = await packageOf(req);
      if (!row) return res.status(404).json({ error: "Migration package not found" });
      res.json(await Planning.evaluatePackageReadinessAsync(db, tenantOf(req), row));
    })
  );
  router.post(
    "/packages/:ref/preview",
    guard,
    canValidation("read"),
    wrap(async (req, res) => {
      const row = await packageOf(req);
      if (!row) return res.status(404).json({ error: "Migration package not found" });
      res.json(await Execution.previewMigrationAsync(db, tenantOf(req), { packageRow: row }, req.body || {}, req.actor, req.ip));
    })
  );
  router.post(
    "/packages/:ref/validate",
    guard,
    canValidation("read"),
    wrap(async (req, res) => {
      const row = await packageOf(req);
      if (!row) return res.status(404).json({ error: "Migration package not found" });
      res.json(await Execution.validateMigrationAsync(db, tenantOf(req), { packageRow: row }, req.body || {}, req.actor, req.ip));
    })
  );
  router.post(
    "/packages/:ref/jobs",
    guard,
    canExecution("create"),
    wrap(async (req, res) => {
      const packageRow = await packageOf(req);
      if (!packageRow) return res.status(404).json({ error: "Migration package not found" });
      const project = packageRow.project_id ? await Projects.getProjectRowAsync(db, tenantOf(req), packageRow.project_id) : null;
      const { job, existing } = await Execution.createMigrationJobAsync(db, {
        tenantId: tenantOf(req),
        project,
        package: packageRow,
        mode: req.body?.mode,
        params: req.body?.params || {},
        actor: req.actor,
        ip: req.ip,
        idempotencyKey: idem(req),
      });
      const submit = req.body?.submit !== false && job.mode !== "VALIDATE";
      const platformJob = submit
        ? await Jobs.submitMigrationJobAsync(db, { tenantId: tenantOf(req), migrationJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })
        : job.mode === "VALIDATE"
          ? await Jobs.submitValidateJobAsync(db, { tenantId: tenantOf(req), migrationJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })
          : null;
      res.status(existing ? 200 : 202).json({ job: await Execution.getMigrationJobAsync(db, tenantOf(req), job.id), platform_job: platformJob, existing });
    })
  );

  // ── Definitions ───────────────────────────────────────────────────────────
  router.get(
    "/definitions",
    guard,
    canDefinitions("read"),
    wrap(async (req, res) => res.json(await Definitions.listDefinitionsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/definitions",
    guard,
    canDefinitions("create"),
    wrap(async (req, res) => res.status(201).json(await Definitions.createDefinitionAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/definitions/:ref",
    guard,
    canDefinitions("read"),
    wrap(async (req, res) => res.json(await Definitions.getDefinitionAsync(db, tenantOf(req), req.params.ref)))
  );
  const updateDefinition = wrap(async (req, res) => res.json(await Definitions.updateDefinitionAsync(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/definitions/:ref", guard, canDefinitions("update"), updateDefinition);
  router.patch("/definitions/:ref", guard, canDefinitions("update"), updateDefinition);
  router.post(
    "/definitions/:ref/status",
    guard,
    canDefinitions("update"),
    wrap(async (req, res) => res.json(await Definitions.setDefinitionStatusAsync(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/definitions/:ref/validate",
    guard,
    canValidation("read"),
    wrap(async (req, res) => res.json(await Definitions.validateDefinitionAsync(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/definitions/:ref/versions",
    guard,
    canDefinitions("update"),
    wrap(async (req, res) => res.status(201).json(await Definitions.createDefinitionVersionAsync(db, tenantOf(req), req.params.ref, { changeSummary: req.body?.change_summary || req.body?.changeSummary || "", actor: req.actor })))
  );
  router.get(
    "/definitions/:ref/versions",
    guard,
    canDefinitions("read"),
    wrap(async (req, res) => res.json(await Definitions.listDefinitionVersionsAsync(db, tenantOf(req), req.params.ref, req.query)))
  );
  router.post(
    "/definitions/:ref/jobs",
    guard,
    canExecution("create"),
    wrap(async (req, res) => {
      const definitionRow = await definitionOf(req);
      if (!definitionRow) return res.status(404).json({ error: "Migration definition not found" });
      const { job, existing } = await Execution.createMigrationJobAsync(db, {
        tenantId: tenantOf(req),
        definition: definitionRow,
        mode: req.body?.mode,
        params: req.body?.params || {},
        actor: req.actor,
        ip: req.ip,
        idempotencyKey: idem(req),
      });
      const platformJob = job.mode === "VALIDATE"
        ? await Jobs.submitValidateJobAsync(db, { tenantId: tenantOf(req), migrationJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })
        : await Jobs.submitMigrationJobAsync(db, { tenantId: tenantOf(req), migrationJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
      res.status(existing ? 200 : 202).json({ job: await Execution.getMigrationJobAsync(db, tenantOf(req), job.id), platform_job: platformJob, existing });
    })
  );

  // ── Jobs ──────────────────────────────────────────────────────────────────
  router.get(
    "/jobs",
    guard,
    canExecution("read"),
    wrap(async (req, res) => res.json(await Execution.listMigrationJobsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/jobs/:ref",
    guard,
    canExecution("read"),
    wrap(async (req, res) => res.json(await Execution.getMigrationJobAsync(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/jobs/:ref/batches",
    guard,
    canExecution("read"),
    wrap(async (req, res) => {
      const job = await Execution.getJobRowAsync(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      res.json(await Execution.listBatchesAsync(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query }));
    })
  );
  router.get(
    "/jobs/:ref/results",
    guard,
    canExecution("read"),
    wrap(async (req, res) => {
      const job = await Execution.getJobRowAsync(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      res.json(await Execution.listObjectResultsAsync(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query }));
    })
  );
  router.get(
    "/jobs/:ref/errors",
    guard,
    canExecution("read"),
    wrap(async (req, res) => {
      const job = await Execution.getJobRowAsync(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      res.json(await Execution.listErrorsAsync(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query }));
    })
  );
  router.get(
    "/jobs/:ref/checkpoints",
    guard,
    canExecution("read"),
    wrap(async (req, res) => {
      const job = await Execution.getJobRowAsync(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      res.json(await Execution.listCheckpointsAsync(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query }));
    })
  );
  router.get(
    "/jobs/:ref/lineage",
    guard,
    canAudit("read"),
    wrap(async (req, res) => {
      const job = await Execution.getJobRowAsync(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      res.json({ items: (await Audit.listMigrationAuditAsync(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query })).items });
    })
  );
  router.post(
    "/jobs/:ref/cancel",
    guard,
    canExecution("update"),
    wrap(async (req, res) => res.json(await Execution.cancelMigrationJobAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/jobs/:ref/pause",
    guard,
    canExecution("update"),
    wrap(async (req, res) => res.json(await Execution.pauseMigrationJobAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/jobs/:ref/resume",
    guard,
    canExecution("update"),
    wrap(async (req, res) => res.json(await Execution.resumeMigrationJobAsync(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/jobs/:ref/retry",
    guard,
    canExecution("execute"),
    wrap(async (req, res) => {
      const job = await Execution.getJobRowAsync(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      const platformJob = await Jobs.submitRetryJobAsync(db, { tenantId: tenantOf(req), migrationJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
      res.status(202).json({ job: await Execution.getMigrationJobAsync(db, tenantOf(req), job.id), platform_job: platformJob });
    })
  );
  router.post(
    "/jobs/:ref/execute",
    guard,
    canExecution("execute"),
    wrap(async (req, res) => {
      const job = await Execution.getJobRowAsync(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      const platformJob = job.mode === "VALIDATE"
        ? await Jobs.submitValidateJobAsync(db, { tenantId: tenantOf(req), migrationJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })
        : await Jobs.submitMigrationJobAsync(db, { tenantId: tenantOf(req), migrationJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
      res.status(202).json({ job: await Execution.getMigrationJobAsync(db, tenantOf(req), job.id), platform_job: platformJob });
    })
  );
  router.post(
    "/jobs/:ref/reconcile",
    guard,
    canReconciliation("execute"),
    wrap(async (req, res) => {
      const job = await Execution.getJobRowAsync(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      res.status(201).json(await Reconciliation.reconcileJobAsync(db, { tenantId: tenantOf(req), jobId: job.id, strategy: req.body?.strategy || "COUNT" }));
    })
  );
  router.post(
    "/jobs/:ref/submit-reconcile",
    guard,
    canReconciliation("execute"),
    wrap(async (req, res) => {
      const job = await Execution.getJobRowAsync(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      const platformJob = await Jobs.submitReconcileJobAsync(db, { tenantId: tenantOf(req), migrationJobId: job.id, strategy: req.body?.strategy || "COUNT", actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
      res.status(202).json({ platform_job: platformJob });
    })
  );
  router.post(
    "/jobs/:ref/files/retry",
    guard,
    canFiles("execute"),
    wrap(async (req, res) => {
      const job = await Execution.getJobRowAsync(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      res.status(202).json(await Files.retryFailedFilesAsync(db, tenantOf(req), { jobId: job.id, actor: req.actor, ip: req.ip }));
    })
  );

  // ── Platform job submission helpers ───────────────────────────────────────
  router.post(
    "/maintenance",
    guard,
    canAdmin("execute"),
    wrap(async (req, res) => {
      const platformJob = await Jobs.submitMaintenanceJobAsync(db, { tenantId: tenantOf(req), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
      res.status(202).json({ platform_job: platformJob });
    })
  );

  // ── Identifier mappings ───────────────────────────────────────────────────
  router.get(
    "/identifier-mappings",
    guard,
    canIdentifiers("read"),
    wrap(async (req, res) => res.json(await IdentifierMapping.listIdentifierMappingsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/identifier-mappings",
    guard,
    canIdentifiers("create"),
    wrap(async (req, res) => res.status(201).json(await IdentifierMapping.mapIdentifierAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/identifier-mappings/bulk",
    guard,
    canIdentifiers("create"),
    wrap(async (req, res) => res.json(await IdentifierMapping.bulkMapIdentifiersAsync(db, tenantOf(req), req.body?.mappings || [], req.actor, req.ip)))
  );
  router.get(
    "/identifier-mappings/resolve",
    guard,
    canIdentifiers("read"),
    wrap(async (req, res) => res.json(await IdentifierMapping.resolveIdentifierAsync(db, tenantOf(req), {
      sourceSystem: req.query.source_system ?? req.query.sourceSystem,
      sourceObjectType: req.query.source_object_type ?? req.query.sourceObjectType,
      sourceObjectId: req.query.source_object_id ?? req.query.sourceObjectId,
    }) || null))
  );

  // ── Relationship mappings ─────────────────────────────────────────────────
  router.get(
    "/relationship-mappings",
    guard,
    canRelationships("read"),
    wrap(async (req, res) => res.json(await Relationships.listRelationshipMappingsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/relationships",
    guard,
    canRelationships("create"),
    wrap(async (req, res) => res.status(201).json(await Relationships.migrateRelationshipAsync(db, tenantOf(req), req.body || {}, req.actor, req.ip, { dryRun: Boolean(req.body?.dry_run) })))
  );
  router.post(
    "/relationships/bulk",
    guard,
    canRelationships("create"),
    wrap(async (req, res) => res.json(await Relationships.bulkMigrateRelationshipsAsync(db, tenantOf(req), req.body?.relationships || [], req.actor, req.ip, { dryRun: Boolean(req.body?.dry_run) })))
  );
  router.post(
    "/relationships/retry",
    guard,
    canRelationships("execute"),
    wrap(async (req, res) => res.json(await Relationships.retryMissingRelationshipsAsync(db, tenantOf(req), { jobId: req.body?.job_id ?? null, actor: req.actor, ip: req.ip })))
  );

  // ── File migrations ───────────────────────────────────────────────────────
  router.get(
    "/file-migrations",
    guard,
    canFiles("read"),
    wrap(async (req, res) => res.json(await Files.listFileMigrationsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );

  // ── Reconciliation ────────────────────────────────────────────────────────
  router.get(
    "/reconciliations",
    guard,
    canReconciliation("read"),
    wrap(async (req, res) => res.json(await Reconciliation.listReconciliationsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/reconciliations/:ref",
    guard,
    canReconciliation("read"),
    wrap(async (req, res) => res.json(await Reconciliation.getReconciliationAsync(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/reconciliations/:ref/exceptions",
    guard,
    canReconciliation("read"),
    wrap(async (req, res) => {
      const row = await Reconciliation.getReconciliationRowAsync(db, tenantOf(req), req.params.ref);
      if (!row) return res.status(404).json({ error: "Reconciliation not found" });
      res.json(await Reconciliation.listExceptionsAsync(db, { tenantId: tenantOf(req), reconciliationId: row.id, ...req.query }));
    })
  );

  // ── Statistics ────────────────────────────────────────────────────────────
  router.get(
    "/statistics",
    guard,
    canStatistics("read"),
    wrap(async (req, res) => res.json(await Statistics.listStatisticsAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );

  // ── Audit ─────────────────────────────────────────────────────────────────
  router.get(
    "/audit",
    guard,
    canAudit("read"),
    wrap(async (req, res) => res.json(await Audit.listMigrationAuditAsync(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/object-lineage",
    guard,
    canAudit("read"),
    wrap(async (req, res) => {
      const targetObjectId = req.query.target_object_id ?? req.query.targetObjectId;
      if (!targetObjectId) return res.status(400).json({ error: "target_object_id is required" });
      res.json({ items: await Audit.objectLineageAsync(db, tenantOf(req), targetObjectId) });
    })
  );

  // ── Configuration & admin ─────────────────────────────────────────────────
  router.get(
    "/configuration",
    guard,
    canAdmin("read"),
    wrap(async (req, res) => res.json({ config: await Configuration.listConfigAsync(db, tenantOf(req)) }))
  );
  router.get(
    "/configuration/:key",
    guard,
    canAdmin("read"),
    wrap(async (req, res) => res.json({ key: req.params.key, value: await Configuration.getConfigAsync(db, tenantOf(req), req.params.key) }))
  );
  router.put(
    "/configuration/:key",
    guard,
    canAdmin("update"),
    wrap(async (req, res) => res.json({ key: req.params.key, value: await Configuration.setConfigAsync(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip) }))
  );
  router.post(
    "/seed",
    guard,
    canAdmin("create"),
    wrap(async (req, res) => res.status(201).json(await Seed.seedMigrationAsync(db, tenantOf(req))))
  );

  void canMapping;
  void Errors;
  void Security;
  return router;
}
