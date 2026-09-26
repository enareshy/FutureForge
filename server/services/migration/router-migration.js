// REST router for the Migration & Onboarding Framework. Built as a factory so it
// reuses the application's auth, authorization and error middleware. Mounted at
// /api/migration and /api/v1/migration.
//
// Every route is authorized against an IAM permission resource; the client is
// never trusted to declare its own authorization.
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

export function createMigrationRouter({ express, db, auth, can, wrap }) {
  const router = express.Router();
  const tenantOf = (req) => req.tenantId ?? null;
  const idem = (req) => req.get("Idempotency-Key") || req.body?.idempotency_key || req.body?.idempotencyKey || "";

  const canOverview = (a) => can(R.overview, a);
  const canProjects = (a) => can(R.projects, a);
  const canPackages = (a) => can(R.packages, a);
  const canDefinitions = (a) => can(R.definitions, a);
  const canSources = (a) => can(R.sources, a);
  const canMapping = (a) => can(R.mapping, a);
  const canValidation = (a) => can(R.validation, a);
  const canDependencies = (a) => can(R.dependencies, a);
  const canPlanning = (a) => can(R.planning, a);
  const canExecution = (a) => can(R.execution, a);
  const canReconciliation = (a) => can(R.reconciliation, a);
  const canIdentifiers = (a) => can(R.identifiers, a);
  const canRelationships = (a) => can(R.relationships, a);
  const canFiles = (a) => can(R.files, a);
  const canAudit = (a) => can(R.auditTrail, a);
  const canStatistics = (a) => can(R.statistics, a);
  const canMetrics = (a) => can(R.metrics, a);
  const canAdmin = (a) => can(R.admin, a);

  const packageOf = (req) => Packages.getPackageRow(db, tenantOf(req), req.params.ref);
  const definitionOf = (req) => Definitions.getDefinitionRow(db, tenantOf(req), req.params.ref);
  const projectOf = (req) => Projects.getProjectRow(db, tenantOf(req), req.params.ref);

  // ── Meta, health, metrics ─────────────────────────────────────────────────
  router.get(
    "/meta",
    auth,
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
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json({ ...Statistics.healthCheck(db, { tenantId: tenantOf(req) }), ...Foundation.migrationHealth(db, tenantOf(req)) }))
  );

  router.get(
    "/metrics",
    auth,
    canMetrics("read"),
    wrap((req, res) => res.json(Statistics.metricsSnapshot(db, { tenantId: tenantOf(req) })))
  );

  // ── Source adapters & configurations ──────────────────────────────────────
  router.get(
    "/source-adapters",
    auth,
    canSources("read"),
    wrap((_req, res) => res.json({ items: SourceAdapters.Registry.listSourceAdapters() }))
  );

  router.get(
    "/source-configurations",
    auth,
    canSources("read"),
    wrap((req, res) => res.json(SourceConfigurations.listSourceConfigurations(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/source-configurations",
    auth,
    canSources("create"),
    wrap((req, res) => res.status(201).json(SourceConfigurations.createSourceConfiguration(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/source-configurations/:ref",
    auth,
    canSources("read"),
    wrap((req, res) => res.json(SourceConfigurations.getSourceConfiguration(db, tenantOf(req), req.params.ref)))
  );
  const updateSource = wrap((req, res) => res.json(SourceConfigurations.updateSourceConfiguration(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/source-configurations/:ref", auth, canSources("update"), updateSource);
  router.patch("/source-configurations/:ref", auth, canSources("update"), updateSource);
  router.post(
    "/source-configurations/:ref/status",
    auth,
    canSources("update"),
    wrap((req, res) => res.json(SourceConfigurations.setSourceConfigurationStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/source-configurations/:ref/test",
    auth,
    canSources("read"),
    wrap(async (req, res) => res.json(await SourceConfigurations.testSourceConfiguration(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/source-configurations/:ref/discover",
    auth,
    canSources("read"),
    wrap(async (req, res) => res.json(await SourceConfigurations.discoverSourceConfigurationSchema(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)))
  );

  // ── Projects ──────────────────────────────────────────────────────────────
  router.get(
    "/projects",
    auth,
    canProjects("read"),
    wrap((req, res) => res.json(Projects.listProjects(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/projects",
    auth,
    canProjects("create"),
    wrap((req, res) => res.status(201).json(Projects.createProject(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/projects/:ref",
    auth,
    canProjects("read"),
    wrap((req, res) => res.json(Projects.getProject(db, tenantOf(req), req.params.ref)))
  );
  const updateProject = wrap((req, res) => res.json(Projects.updateProject(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/projects/:ref", auth, canProjects("update"), updateProject);
  router.patch("/projects/:ref", auth, canProjects("update"), updateProject);
  router.post(
    "/projects/:ref/status",
    auth,
    canProjects("update"),
    wrap((req, res) => res.json(Projects.setProjectStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.get(
    "/projects/:ref/packages",
    auth,
    canProjects("read"),
    wrap((req, res) => res.json(Projects.listProjectPackages(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/projects/:ref/dependencies",
    auth,
    canDependencies("read"),
    wrap((req, res) => {
      const row = projectOf(req);
      if (!row) return res.status(404).json({ error: "Migration project not found" });
      res.json({ items: Dependencies.listProjectDependencies(db, tenantOf(req), row.id) });
    })
  );
  router.get(
    "/projects/:ref/topology",
    auth,
    canDependencies("read"),
    wrap((req, res) => {
      const row = projectOf(req);
      if (!row) return res.status(404).json({ error: "Migration project not found" });
      res.json(Dependencies.topologicalOrder(db, tenantOf(req), row.id));
    })
  );
  router.get(
    "/projects/:ref/readiness",
    auth,
    canPlanning("read"),
    wrap((req, res) => res.json(Planning.readinessReport(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/projects/:ref/plans",
    auth,
    canPlanning("read"),
    wrap((req, res) => {
      const row = projectOf(req);
      if (!row) return res.status(404).json({ error: "Migration project not found" });
      res.json(Planning.listPlans(db, tenantOf(req), { projectId: row.id, ...req.query }));
    })
  );
  router.post(
    "/projects/:ref/plans",
    auth,
    canPlanning("create"),
    wrap((req, res) => res.status(201).json(Planning.generatePlan(db, tenantOf(req), req.params.ref, { actor: req.actor, packageId: req.body?.package_id, ip: req.ip })))
  );

  // ── Plans ─────────────────────────────────────────────────────────────────
  router.get(
    "/plans",
    auth,
    canPlanning("read"),
    wrap((req, res) => res.json(Planning.listPlans(db, tenantOf(req), req.query)))
  );
  router.get(
    "/plans/:ref",
    auth,
    canPlanning("read"),
    wrap((req, res) => res.json(Planning.getPlan(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/plans/:ref/approve",
    auth,
    canPlanning("update"),
    wrap((req, res) => res.json(Planning.approvePlan(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );

  // ── Packages ──────────────────────────────────────────────────────────────
  router.get(
    "/packages",
    auth,
    canPackages("read"),
    wrap((req, res) => res.json(Packages.listPackages(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/packages",
    auth,
    canPackages("create"),
    wrap((req, res) => res.status(201).json(Packages.createPackage(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/packages/:ref",
    auth,
    canPackages("read"),
    wrap((req, res) => res.json(Packages.getPackage(db, tenantOf(req), req.params.ref)))
  );
  const updatePackage = wrap((req, res) => res.json(Packages.updatePackage(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/packages/:ref", auth, canPackages("update"), updatePackage);
  router.patch("/packages/:ref", auth, canPackages("update"), updatePackage);
  router.post(
    "/packages/:ref/status",
    auth,
    canPackages("update"),
    wrap((req, res) => res.json(Packages.setPackageStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.get(
    "/packages/:ref/dependencies",
    auth,
    canDependencies("read"),
    wrap((req, res) => {
      const row = packageOf(req);
      if (!row) return res.status(404).json({ error: "Migration package not found" });
      res.json({ items: Dependencies.listPackageDependencies(db, tenantOf(req), row.id) });
    })
  );
  router.get(
    "/packages/:ref/readiness",
    auth,
    canPlanning("read"),
    wrap((req, res) => {
      const row = packageOf(req);
      if (!row) return res.status(404).json({ error: "Migration package not found" });
      res.json(Planning.evaluatePackageReadiness(db, tenantOf(req), row));
    })
  );
  router.post(
    "/packages/:ref/preview",
    auth,
    canValidation("read"),
    wrap(async (req, res) => {
      const row = packageOf(req);
      if (!row) return res.status(404).json({ error: "Migration package not found" });
      res.json(await Execution.previewMigration(db, tenantOf(req), { packageRow: row }, req.body || {}, req.actor, req.ip));
    })
  );
  router.post(
    "/packages/:ref/validate",
    auth,
    canValidation("read"),
    wrap(async (req, res) => {
      const row = packageOf(req);
      if (!row) return res.status(404).json({ error: "Migration package not found" });
      res.json(await Execution.validateMigration(db, tenantOf(req), { packageRow: row }, req.body || {}, req.actor, req.ip));
    })
  );
  router.post(
    "/packages/:ref/jobs",
    auth,
    canExecution("create"),
    wrap((req, res) => {
      const packageRow = packageOf(req);
      if (!packageRow) return res.status(404).json({ error: "Migration package not found" });
      const project = packageRow.project_id ? Projects.getProjectRow(db, tenantOf(req), packageRow.project_id) : null;
      const { job, existing } = Execution.createMigrationJob(db, {
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
        ? Jobs.submitMigrationJob(db, { tenantId: tenantOf(req), migrationJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })
        : job.mode === "VALIDATE"
          ? Jobs.submitValidateJob(db, { tenantId: tenantOf(req), migrationJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })
          : null;
      res.status(existing ? 200 : 202).json({ job: Execution.getMigrationJob(db, tenantOf(req), job.id), platform_job: platformJob, existing });
    })
  );

  // ── Definitions ───────────────────────────────────────────────────────────
  router.get(
    "/definitions",
    auth,
    canDefinitions("read"),
    wrap((req, res) => res.json(Definitions.listDefinitions(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/definitions",
    auth,
    canDefinitions("create"),
    wrap((req, res) => res.status(201).json(Definitions.createDefinition(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.get(
    "/definitions/:ref",
    auth,
    canDefinitions("read"),
    wrap((req, res) => res.json(Definitions.getDefinition(db, tenantOf(req), req.params.ref)))
  );
  const updateDefinition = wrap((req, res) => res.json(Definitions.updateDefinition(db, tenantOf(req), req.params.ref, req.body || {}, req.actor, req.ip)));
  router.put("/definitions/:ref", auth, canDefinitions("update"), updateDefinition);
  router.patch("/definitions/:ref", auth, canDefinitions("update"), updateDefinition);
  router.post(
    "/definitions/:ref/status",
    auth,
    canDefinitions("update"),
    wrap((req, res) => res.json(Definitions.setDefinitionStatus(db, tenantOf(req), req.params.ref, req.body?.status, req.actor, req.ip)))
  );
  router.post(
    "/definitions/:ref/validate",
    auth,
    canValidation("read"),
    wrap((req, res) => res.json(Definitions.validateDefinition(db, tenantOf(req), req.params.ref)))
  );
  router.post(
    "/definitions/:ref/versions",
    auth,
    canDefinitions("update"),
    wrap((req, res) => res.status(201).json(Definitions.createDefinitionVersion(db, tenantOf(req), req.params.ref, { changeSummary: req.body?.change_summary || req.body?.changeSummary || "", actor: req.actor })))
  );
  router.get(
    "/definitions/:ref/versions",
    auth,
    canDefinitions("read"),
    wrap((req, res) => res.json(Definitions.listDefinitionVersions(db, tenantOf(req), req.params.ref, req.query)))
  );
  router.post(
    "/definitions/:ref/jobs",
    auth,
    canExecution("create"),
    wrap((req, res) => {
      const definitionRow = definitionOf(req);
      if (!definitionRow) return res.status(404).json({ error: "Migration definition not found" });
      const { job, existing } = Execution.createMigrationJob(db, {
        tenantId: tenantOf(req),
        definition: definitionRow,
        mode: req.body?.mode,
        params: req.body?.params || {},
        actor: req.actor,
        ip: req.ip,
        idempotencyKey: idem(req),
      });
      const platformJob = job.mode === "VALIDATE"
        ? Jobs.submitValidateJob(db, { tenantId: tenantOf(req), migrationJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })
        : Jobs.submitMigrationJob(db, { tenantId: tenantOf(req), migrationJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
      res.status(existing ? 200 : 202).json({ job: Execution.getMigrationJob(db, tenantOf(req), job.id), platform_job: platformJob, existing });
    })
  );

  // ── Jobs ──────────────────────────────────────────────────────────────────
  router.get(
    "/jobs",
    auth,
    canExecution("read"),
    wrap((req, res) => res.json(Execution.listMigrationJobs(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/jobs/:ref",
    auth,
    canExecution("read"),
    wrap((req, res) => res.json(Execution.getMigrationJob(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/jobs/:ref/batches",
    auth,
    canExecution("read"),
    wrap((req, res) => {
      const job = Execution.getJobRow(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      res.json(Execution.listBatches(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query }));
    })
  );
  router.get(
    "/jobs/:ref/results",
    auth,
    canExecution("read"),
    wrap((req, res) => {
      const job = Execution.getJobRow(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      res.json(Execution.listObjectResults(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query }));
    })
  );
  router.get(
    "/jobs/:ref/errors",
    auth,
    canExecution("read"),
    wrap((req, res) => {
      const job = Execution.getJobRow(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      res.json(Execution.listErrors(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query }));
    })
  );
  router.get(
    "/jobs/:ref/checkpoints",
    auth,
    canExecution("read"),
    wrap((req, res) => {
      const job = Execution.getJobRow(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      res.json(Execution.listCheckpoints(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query }));
    })
  );
  router.get(
    "/jobs/:ref/lineage",
    auth,
    canAudit("read"),
    wrap((req, res) => {
      const job = Execution.getJobRow(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      res.json({ items: Audit.listMigrationAudit(db, { tenantId: tenantOf(req), jobId: job.id, ...req.query }).items });
    })
  );
  router.post(
    "/jobs/:ref/cancel",
    auth,
    canExecution("update"),
    wrap((req, res) => res.json(Execution.cancelMigrationJob(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/jobs/:ref/pause",
    auth,
    canExecution("update"),
    wrap((req, res) => res.json(Execution.pauseMigrationJob(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/jobs/:ref/resume",
    auth,
    canExecution("update"),
    wrap((req, res) => res.json(Execution.resumeMigrationJob(db, tenantOf(req), req.params.ref, req.actor, req.ip)))
  );
  router.post(
    "/jobs/:ref/retry",
    auth,
    canExecution("execute"),
    wrap(async (req, res) => {
      const job = Execution.getJobRow(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      const platformJob = Jobs.submitRetryJob(db, { tenantId: tenantOf(req), migrationJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
      res.status(202).json({ job: Execution.getMigrationJob(db, tenantOf(req), job.id), platform_job: platformJob });
    })
  );
  router.post(
    "/jobs/:ref/execute",
    auth,
    canExecution("execute"),
    wrap((req, res) => {
      const job = Execution.getJobRow(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      const platformJob = job.mode === "VALIDATE"
        ? Jobs.submitValidateJob(db, { tenantId: tenantOf(req), migrationJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) })
        : Jobs.submitMigrationJob(db, { tenantId: tenantOf(req), migrationJobId: job.id, actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
      res.status(202).json({ job: Execution.getMigrationJob(db, tenantOf(req), job.id), platform_job: platformJob });
    })
  );
  router.post(
    "/jobs/:ref/reconcile",
    auth,
    canReconciliation("execute"),
    wrap((req, res) => {
      const job = Execution.getJobRow(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      res.status(201).json(Reconciliation.reconcileJob(db, { tenantId: tenantOf(req), jobId: job.id, strategy: req.body?.strategy || "COUNT" }));
    })
  );
  router.post(
    "/jobs/:ref/submit-reconcile",
    auth,
    canReconciliation("execute"),
    wrap((req, res) => {
      const job = Execution.getJobRow(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      const platformJob = Jobs.submitReconcileJob(db, { tenantId: tenantOf(req), migrationJobId: job.id, strategy: req.body?.strategy || "COUNT", actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
      res.status(202).json({ platform_job: platformJob });
    })
  );
  router.post(
    "/jobs/:ref/files/retry",
    auth,
    canFiles("execute"),
    wrap((req, res) => {
      const job = Execution.getJobRow(db, tenantOf(req), req.params.ref);
      if (!job) return res.status(404).json({ error: "Migration job not found" });
      res.status(202).json(Files.retryFailedFiles(db, tenantOf(req), { jobId: job.id, actor: req.actor, ip: req.ip }));
    })
  );

  // ── Platform job submission helpers ───────────────────────────────────────
  router.post(
    "/maintenance",
    auth,
    canAdmin("execute"),
    wrap((req, res) => {
      const platformJob = Jobs.submitMaintenanceJob(db, { tenantId: tenantOf(req), actor: req.actor, ip: req.ip, idempotencyKey: idem(req) });
      res.status(202).json({ platform_job: platformJob });
    })
  );

  // ── Identifier mappings ───────────────────────────────────────────────────
  router.get(
    "/identifier-mappings",
    auth,
    canIdentifiers("read"),
    wrap((req, res) => res.json(IdentifierMapping.listIdentifierMappings(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/identifier-mappings",
    auth,
    canIdentifiers("create"),
    wrap((req, res) => res.status(201).json(IdentifierMapping.mapIdentifier(db, tenantOf(req), req.body || {}, req.actor, req.ip)))
  );
  router.post(
    "/identifier-mappings/bulk",
    auth,
    canIdentifiers("create"),
    wrap((req, res) => res.json(IdentifierMapping.bulkMapIdentifiers(db, tenantOf(req), req.body?.mappings || [], req.actor, req.ip)))
  );
  router.get(
    "/identifier-mappings/resolve",
    auth,
    canIdentifiers("read"),
    wrap((req, res) => res.json(IdentifierMapping.resolveIdentifier(db, tenantOf(req), {
      sourceSystem: req.query.source_system ?? req.query.sourceSystem,
      sourceObjectType: req.query.source_object_type ?? req.query.sourceObjectType,
      sourceObjectId: req.query.source_object_id ?? req.query.sourceObjectId,
    }) || null))
  );

  // ── Relationship mappings ─────────────────────────────────────────────────
  router.get(
    "/relationship-mappings",
    auth,
    canRelationships("read"),
    wrap((req, res) => res.json(Relationships.listRelationshipMappings(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.post(
    "/relationships",
    auth,
    canRelationships("create"),
    wrap((req, res) => res.status(201).json(Relationships.migrateRelationship(db, tenantOf(req), req.body || {}, req.actor, req.ip, { dryRun: Boolean(req.body?.dry_run) })))
  );
  router.post(
    "/relationships/bulk",
    auth,
    canRelationships("create"),
    wrap((req, res) => res.json(Relationships.bulkMigrateRelationships(db, tenantOf(req), req.body?.relationships || [], req.actor, req.ip, { dryRun: Boolean(req.body?.dry_run) })))
  );
  router.post(
    "/relationships/retry",
    auth,
    canRelationships("execute"),
    wrap((req, res) => res.json(Relationships.retryMissingRelationships(db, tenantOf(req), { jobId: req.body?.job_id ?? null, actor: req.actor, ip: req.ip })))
  );

  // ── File migrations ───────────────────────────────────────────────────────
  router.get(
    "/file-migrations",
    auth,
    canFiles("read"),
    wrap((req, res) => res.json(Files.listFileMigrations(db, { tenantId: tenantOf(req), ...req.query })))
  );

  // ── Reconciliation ────────────────────────────────────────────────────────
  router.get(
    "/reconciliations",
    auth,
    canReconciliation("read"),
    wrap((req, res) => res.json(Reconciliation.listReconciliations(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/reconciliations/:ref",
    auth,
    canReconciliation("read"),
    wrap((req, res) => res.json(Reconciliation.getReconciliation(db, tenantOf(req), req.params.ref)))
  );
  router.get(
    "/reconciliations/:ref/exceptions",
    auth,
    canReconciliation("read"),
    wrap((req, res) => {
      const row = Reconciliation.getReconciliationRow(db, tenantOf(req), req.params.ref);
      if (!row) return res.status(404).json({ error: "Reconciliation not found" });
      res.json(Reconciliation.listExceptions(db, { tenantId: tenantOf(req), reconciliationId: row.id, ...req.query }));
    })
  );

  // ── Statistics ────────────────────────────────────────────────────────────
  router.get(
    "/statistics",
    auth,
    canStatistics("read"),
    wrap((req, res) => res.json(Statistics.listStatistics(db, { tenantId: tenantOf(req), ...req.query })))
  );

  // ── Audit ─────────────────────────────────────────────────────────────────
  router.get(
    "/audit",
    auth,
    canAudit("read"),
    wrap((req, res) => res.json(Audit.listMigrationAudit(db, { tenantId: tenantOf(req), ...req.query })))
  );
  router.get(
    "/object-lineage",
    auth,
    canAudit("read"),
    wrap((req, res) => {
      const targetObjectId = req.query.target_object_id ?? req.query.targetObjectId;
      if (!targetObjectId) return res.status(400).json({ error: "target_object_id is required" });
      res.json({ items: Audit.objectLineage(db, tenantOf(req), targetObjectId) });
    })
  );

  // ── Configuration & admin ─────────────────────────────────────────────────
  router.get(
    "/configuration",
    auth,
    canAdmin("read"),
    wrap((req, res) => res.json({ config: Configuration.listConfig(db, tenantOf(req)) }))
  );
  router.get(
    "/configuration/:key",
    auth,
    canAdmin("read"),
    wrap((req, res) => res.json({ key: req.params.key, value: Configuration.getConfig(db, tenantOf(req), req.params.key) }))
  );
  router.put(
    "/configuration/:key",
    auth,
    canAdmin("update"),
    wrap((req, res) => res.json({ key: req.params.key, value: Configuration.setConfig(db, tenantOf(req), req.params.key, req.body?.value, req.actor, req.ip) }))
  );
  router.post(
    "/seed",
    auth,
    canAdmin("create"),
    wrap((req, res) => res.status(201).json(Seed.seedMigration(db, tenantOf(req))))
  );

  void canMapping;
  void Errors;
  void Security;
  return router;
}
