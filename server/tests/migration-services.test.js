process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import { MigrationError } from "../services/migration/errors.js";
import * as SourceConfigurations from "../services/migration/source-configurations.js";
import * as SourceAdapters from "../services/migration/source-adapters/index.js";
import * as Projects from "../services/migration/projects.js";
import * as Packages from "../services/migration/packages.js";
import * as Definitions from "../services/migration/definitions.js";
import * as Dependencies from "../services/migration/dependencies.js";
import * as Planning from "../services/migration/planning.js";
import * as IdentifierMapping from "../services/migration/identifier-mapping.js";
import * as Relationships from "../services/migration/relationships.js";
import * as Execution from "../services/migration/execution.js";
import * as Reconciliation from "../services/migration/reconciliation.js";
import * as Statistics from "../services/migration/statistics.js";
import * as Files from "../services/migration/files.js";
import * as Audit from "../services/migration/audit.js";
import * as Jobs from "../services/migration/jobs.js";
import * as Seed from "../services/migration/seed.js";

const MAPPINGS = [
  { source_field: "part_number", target_field: "code", mapping_type: "DIRECT", required: true },
  { source_field: "part_number", target_field: "part.number", mapping_type: "DIRECT", required: true },
  { source_field: "part_name", target_field: "name", mapping_type: "DIRECT", required: true },
  { source_field: "part_name", target_field: "part.name", mapping_type: "DIRECT", required: true },
  { source_field: "part_category", target_field: "part.category", mapping_type: "DIRECT", required: true },
  { source_field: "part_status", target_field: "part.status", mapping_type: "DIRECT", required: true },
];

const RECORDS = [
  { source_id: "TC-2001", part_number: "P-2001", part_name: "Pump body", part_category: "hydraulic", part_status: "released" },
  { source_id: "TC-2002", part_number: "P-2002", part_name: "Valve block", part_category: "hydraulic", part_status: "released" },
];

function isMigrationError(err, status, code) {
  return err instanceof MigrationError && err.status === status && err.code === code;
}

describe("migration services", () => {
  let db;
  let tenantId;
  let actor;
  let seq = 0;
  const nextCode = (prefix) => {
    seq += 1;
    return `${prefix}_SVC${String(seq).padStart(3, "0")}`;
  };

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    actor = { id: row.id, username: row.username };
  });

  after(() => db?.close());

  describe("source adapters & configurations", () => {
    test("exposes the built-in legacy adapter catalogue", () => {
      const adapters = SourceAdapters.Registry.listSourceAdapters();
      assert.ok(adapters.length >= 10);
      for (const type of ["DATABASE", "FILE", "REST", "OBJECT_STORAGE", "LEGACY_TEAMCENTER", "LEGACY_PLM", "PDM", "ERP", "MES", "CUSTOM"]) {
        assert.ok(adapters.some((adapter) => adapter.adapter_type === type), `missing adapter ${type}`);
      }
      assert.ok(SourceAdapters.Registry.sourceAdapterTypes().includes("LEGACY_PLM"));
    });

    test("creates, gets, lists, updates and toggles a source configuration", async () => {
      const code = nextCode("SRC");
      const created = SourceConfigurations.createSourceConfiguration(
        db,
        tenantId,
        { code, name: "Legacy DB", adapter_type: "DATABASE", settings: { records: RECORDS } },
        actor
      );
      assert.equal(created.code, code);
      assert.equal(created.adapter_type, "DATABASE");

      const fetched = SourceConfigurations.getSourceConfiguration(db, tenantId, code);
      assert.equal(fetched.id, created.id);

      const listed = SourceConfigurations.listSourceConfigurations(db, { tenantId, adapterType: "DATABASE" });
      assert.ok(listed.items.some((item) => item.code === code));

      const updated = SourceConfigurations.updateSourceConfiguration(db, tenantId, code, { name: "Renamed" }, actor);
      assert.equal(updated.name, "Renamed");

      const inactive = SourceConfigurations.setSourceConfigurationStatus(db, tenantId, code, "inactive", actor);
      assert.equal(inactive.status, "inactive");

      const tested = await SourceConfigurations.testSourceConfiguration(db, tenantId, code, actor);
      assert.equal(tested.code, code);
      assert.equal(typeof tested.connected, "boolean");

      const discovered = await SourceConfigurations.discoverSourceConfigurationSchema(db, tenantId, code, {}, actor);
      assert.equal(discovered.code, code);
      assert.ok(Array.isArray(discovered.fields));

      assert.throws(
        () => SourceConfigurations.createSourceConfiguration(db, tenantId, { code, adapter_type: "DATABASE" }, actor),
        (error) => isMigrationError(error, 409, "MIGRATION_SOURCE_CONFLICT")
      );
      assert.throws(
        () => SourceConfigurations.createSourceConfiguration(db, tenantId, { code: nextCode("BAD"), adapter_type: "NOPE" }, actor),
        (error) => isMigrationError(error, 400, "INVALID_MIGRATION_SOURCE")
      );
    });
  });

  describe("projects", () => {
    test("creates, gets, lists, updates and transitions a project", () => {
      const code = nextCode("PROJ");
      const created = Projects.createProject(db, tenantId, { code, name: "Onboard", source_system: "Teamcenter" }, actor);
      assert.equal(created.code, code);
      assert.equal(created.status, "DRAFT");

      const fetched = Projects.getProject(db, tenantId, code);
      assert.equal(fetched.id, created.id);

      const listed = Projects.listProjects(db, { tenantId, status: "DRAFT" });
      assert.ok(listed.items.some((item) => item.code === code));

      const updated = Projects.updateProject(db, tenantId, code, { description: "desc", scope: { mode: "FULL" } }, actor);
      assert.equal(updated.description, "desc");
      assert.deepEqual(updated.scope, { mode: "FULL" });

      const ready = Projects.setProjectStatus(db, tenantId, code, "READY", actor);
      assert.equal(ready.status, "READY");

      assert.equal(Projects.getProject(db, tenantId, "MISSING"), null);
      assert.throws(
        () => Projects.createProject(db, tenantId, { code, name: "Dup" }, actor),
        (error) => isMigrationError(error, 409, "MIGRATION_PROJECT_CONFLICT")
      );
      assert.throws(() => Projects.setProjectStatus(db, tenantId, code, "NOT_A_STATUS", actor), (error) => error instanceof MigrationError);
    });
  });

  describe("packages & dependencies", () => {
    test("creates packages, wires dependencies and topologically orders them", () => {
      const project = Projects.createProject(db, tenantId, { code: nextCode("PROJ"), name: "Dep project" }, actor);
      const baseCode = nextCode("PKG");
      const base = Packages.createPackage(
        db,
        tenantId,
        { project_id: project.id, code: baseCode, name: "Base", target_object_type: "product", mappings: MAPPINGS, source: { adapter_type: "DATABASE", settings: { records: RECORDS } } },
        actor
      );
      const childCode = nextCode("PKG");
      Packages.createPackage(
        db,
        tenantId,
        { project_id: project.id, code: childCode, name: "Child", target_object_type: "product", dependencies: [{ depends_on: baseCode }] },
        actor
      );

      const dependencies = Dependencies.listPackageDependencies(db, tenantId, base.id);
      assert.ok(Array.isArray(dependencies));

      const topology = Dependencies.topologicalOrder(db, tenantId, project.id);
      assert.equal(topology.hasCycle, false);
      assert.equal(topology.order.length, 2);
      assert.equal(topology.order[0].code, baseCode);

      const readiness = Planning.evaluatePackageReadiness(db, tenantId, Packages.getPackageRow(db, tenantId, childCode));
      assert.ok(["ready", "blocked", "warning"].includes(readiness.readiness));
      assert.ok(Array.isArray(readiness.checks));

      const plan = Planning.generatePlan(db, tenantId, project.id, { actor });
      assert.ok(["READY", "BLOCKED"].includes(plan.status));
      assert.equal(plan.steps.length, 2);

      const report = Planning.readinessReport(db, tenantId, project.id);
      assert.ok(["READY", "BLOCKED", "WARNING"].includes(report.status));

      assert.throws(
        () => Packages.createPackage(db, tenantId, { project_id: project.id, code: baseCode, name: "Dup" }, actor),
        (error) => isMigrationError(error, 409, "MIGRATION_PACKAGE_CONFLICT")
      );
    });
  });

  describe("definitions", () => {
    test("creates, validates, transitions and versions a definition", () => {
      const code = nextCode("DEF");
      const created = Definitions.createDefinition(
        db,
        tenantId,
        { code, name: "Part def", source_object_type: "Part", target_object_type: "product", mappings: MAPPINGS, validation_rules: [{ target_field: "part.number", rule_type: "REQUIRED" }] },
        actor
      );
      assert.equal(created.code, code);
      assert.ok(created.mappings.length >= 1);
      assert.ok(created.validation_rules.length >= 1);

      const validation = Definitions.validateDefinition(db, tenantId, code);
      assert.equal(validation.valid, true, JSON.stringify(validation.errors));

      const active = Definitions.setDefinitionStatus(db, tenantId, code, "ACTIVE", actor);
      assert.equal(active.status, "ACTIVE");

      assert.throws(
        () => Definitions.updateDefinition(db, tenantId, code, { name: "nope" }, actor),
        (error) => isMigrationError(error, 409, "MIGRATION_DEFINITION_IMMUTABLE")
      );

      const versioned = Definitions.createDefinitionVersion(db, tenantId, code, { changeSummary: "tweak", actor });
      assert.ok(versioned.version > 1);
      const versions = Definitions.listDefinitionVersions(db, tenantId, code);
      assert.ok(versions.total >= 2);
    });
  });

  describe("identifier & relationship mapping", () => {
    test("maps identifiers idempotently and rejects conflicting targets", () => {
      const first = IdentifierMapping.mapIdentifier(db, tenantId, {
        source_system: "Teamcenter",
        source_object_type: "Part",
        source_object_id: "SRC-A",
        target_object_type: "product",
        target_object_id: "TGT-A",
      }, actor);
      assert.equal(first.created, true);
      assert.equal(first.mapping.status, "MAPPED");

      const again = IdentifierMapping.mapIdentifier(db, tenantId, {
        source_system: "Teamcenter",
        source_object_type: "Part",
        source_object_id: "SRC-A",
        target_object_id: "TGT-A",
      }, actor);
      assert.equal(again.created, false);

      assert.throws(
        () => IdentifierMapping.mapIdentifier(db, tenantId, { source_system: "Teamcenter", source_object_type: "Part", source_object_id: "SRC-A", target_object_id: "TGT-OTHER" }, actor),
        (error) => isMigrationError(error, 409, "MIGRATION_IDENTIFIER_CONFLICT")
      );

      const resolved = IdentifierMapping.resolveIdentifier(db, tenantId, { sourceSystem: "Teamcenter", sourceObjectType: "Part", sourceObjectId: "SRC-A" });
      assert.equal(resolved.target_object_id, "TGT-A");

      const bulk = IdentifierMapping.bulkMapIdentifiers(db, tenantId, [
        { source_system: "Teamcenter", source_object_type: "Part", source_object_id: "SRC-B", target_object_id: "TGT-B" },
        { source_system: "Teamcenter", source_object_type: "Part", source_object_id: "SRC-B", target_object_id: "TGT-B" },
      ], actor);
      assert.equal(bulk.created, 1);
      assert.equal(bulk.updated, 1);
    });

    test("migrates relationships through a real relationship type", () => {
      const relTypes = queryOne(db, "SELECT code FROM relationship_types ORDER BY id LIMIT 1");
      if (!relTypes) return;
      IdentifierMapping.mapIdentifier(db, tenantId, { source_system: "TC", source_object_type: "Part", source_object_id: "RA", target_object_type: "product", target_object_id: "OBJ-A" }, actor);
      IdentifierMapping.mapIdentifier(db, tenantId, { source_system: "TC", source_object_type: "Part", source_object_id: "RB", target_object_type: "product", target_object_id: "OBJ-B" }, actor);

      const missing = Relationships.migrateRelationship(db, tenantId, {
        source_system: "TC",
        parent_source_type: "Part",
        child_source_type: "Part",
        source_parent_id: "RA",
        source_child_id: "UNKNOWN",
        relationship_type: relTypes.code,
      }, actor);
      assert.equal(missing.status, "MISSING");
      assert.ok(missing.missing.some((entry) => entry.endpoint === "child"));

      const dryRun = Relationships.migrateRelationship(db, tenantId, {
        source_system: "TC",
        parent_source_type: "Part",
        child_source_type: "Part",
        source_parent_id: "RA",
        source_child_id: "RB",
        relationship_type: relTypes.code,
      }, actor, null, { dryRun: true });
      assert.equal(dryRun.status, "MAPPED");
      assert.equal(dryRun.relationship.source_parent_id, "OBJ-A");
    });
  });

  describe("execution", () => {
    test("previews and validates a package without writing", async () => {
      const project = Projects.createProject(db, tenantId, { code: nextCode("PROJ"), name: "Exec project" }, actor);
      const code = nextCode("PKG");
      Packages.createPackage(db, tenantId, {
        project_id: project.id,
        code,
        name: "Exec",
        source_object_type: "Part",
        target_object_type: "product",
        source: { adapter_type: "DATABASE", settings: { records: RECORDS } },
        mappings: MAPPINGS,
        duplicate_strategy: "UPSERT",
      }, actor);
      const packageRow = Packages.getPackageRow(db, tenantId, code);

      const preview = await Execution.previewMigration(db, tenantId, { packageRow }, { limit: 2 }, actor);
      assert.equal(preview.record_count, 2);
      assert.equal(preview.valid, 2);
      assert.equal(preview.invalid, 0);

      const validation = await Execution.validateMigration(db, tenantId, { packageRow }, {}, actor);
      assert.equal(validation.valid, true, JSON.stringify(validation.errors));
      assert.equal(validation.sample.valid, 2);

      const plan = Planning.generatePlan(db, tenantId, project.id, { actor });
      assert.equal(plan.status, "READY");
      const approved = Planning.approvePlan(db, tenantId, plan.id, actor);
      assert.equal(approved.status, "APPROVED");
    });

    test("runs a migration job, records results and reconciles cleanly", async () => {
      const packageRow = Packages.getPackageRow(db, tenantId, "PART_MASTER");
      assert.ok(packageRow, "seeded PART_MASTER package must exist");

      const { job, existing } = Execution.createMigrationJob(db, { tenantId, package: packageRow, mode: "EXECUTE", actor });
      assert.equal(existing, false);
      assert.equal(job.mode, "EXECUTE");

      const again = Execution.createMigrationJob(db, { tenantId, package: packageRow, mode: "EXECUTE", actor, idempotencyKey: `svc-${job.id}` });
      assert.equal(typeof again.existing, "boolean");

      const result = await Execution.runMigrationJob(db, { jobId: job.id, actor });
      assert.ok(["COMPLETED", "PARTIALLY_COMPLETED"].includes(result.status));
      assert.ok(result.success_count >= 1);

      const results = Execution.listObjectResults(db, { tenantId, jobId: job.id });
      assert.equal(results.total, result.success_count);

      const errors = Execution.listErrors(db, { tenantId, jobId: job.id });
      assert.equal(typeof errors.total, "number");

      const checkpoints = Execution.listCheckpoints(db, { tenantId, jobId: job.id });
      assert.ok(Array.isArray(checkpoints.items));

      const reconciliation = Reconciliation.reconcileJob(db, { tenantId, jobId: job.id, strategy: "COUNT" });
      assert.equal(reconciliation.status, "COMPLETED");
      assert.equal(reconciliation.variance, 0);

      const listed = Reconciliation.listReconciliations(db, { tenantId, jobId: job.id });
      assert.ok(listed.total >= 1);

      const lineage = Audit.listMigrationAudit(db, { tenantId, jobId: job.id });
      assert.ok(lineage.total >= 1);
    });

    test("supports cancel, pause and resume lifecycle transitions", () => {
      const packageRow = Packages.getPackageRow(db, tenantId, "PART_MASTER");
      const { job } = Execution.createMigrationJob(db, { tenantId, package: packageRow, mode: "EXECUTE", actor });
      const paused = Execution.pauseMigrationJob(db, tenantId, job.id, actor);
      assert.equal(paused.status, "PAUSED");
      const resumed = Execution.resumeMigrationJob(db, tenantId, job.id, actor);
      assert.equal(resumed.status, "QUEUED");
      const cancelled = Execution.cancelMigrationJob(db, tenantId, job.id, actor);
      assert.equal(cancelled.status, "CANCELLED");
    });
  });

  describe("statistics, metrics, files and audit", () => {
    test("records statistics and reports metrics & health", () => {
      const job = queryOne(db, "SELECT id FROM mig_jobs WHERE tenant_id = ? ORDER BY id LIMIT 1", [tenantId]);
      const statisticId = Statistics.recordJobStatistics(db, { tenantId, jobId: job?.id ?? null, snapshot: { migrated: 5 } });
      assert.ok(Number(statisticId) > 0);

      const listed = Statistics.listStatistics(db, { tenantId });
      assert.ok(listed.total >= 1);

      const metrics = Statistics.metricsSnapshot(db, { tenantId });
      assert.equal(metrics.source_module, "migration");
      assert.equal(typeof metrics.projects, "number");
      assert.ok(metrics.projects >= 2);

      const health = Statistics.healthCheck(db, { tenantId });
      assert.equal(health.status, "healthy");
      assert.ok(health.checks.every((check) => check.status === "ok"));
    });

    test("lists file migrations and audit entries", () => {
      const files = Files.listFileMigrations(db, { tenantId });
      assert.ok(Array.isArray(files.items));
      const audit = Audit.listMigrationAudit(db, { tenantId, pageSize: 50 });
      assert.ok(audit.total >= 1);
      assert.ok(audit.items.every((entry) => typeof entry.action === "string"));
    });
  });

  describe("background jobs & seed", () => {
    test("submits a platform migration job and resolves it", () => {
      const packageRow = Packages.getPackageRow(db, tenantId, "PART_MASTER");
      const { job } = Execution.createMigrationJob(db, { tenantId, package: packageRow, mode: "EXECUTE", actor });
      const platformJob = Jobs.submitMigrationJob(db, { tenantId, migrationJobId: job.id, actor });
      assert.ok(platformJob);
      assert.equal(platformJob.job_type_code || platformJob.job_type, "DATA_MIGRATION");
    });

    test("seed is idempotent and ensureMigrationSeed skips when present", () => {
      const result = Seed.seedMigration(db, tenantId);
      assert.equal(result.seeded, true);
      const ensured = Seed.ensureMigrationSeed(db, tenantId);
      assert.equal(ensured.seeded, false);
      assert.equal(queryOne(db, "SELECT COUNT(*) AS c FROM mig_projects WHERE tenant_id = ? AND code = 'LEGACY_TC_ONBOARD'", [tenantId]).c, 1);
    });
  });

  describe("execution contract", () => {
    test("resolves a package contract and parses its mapping_json", () => {
      const packageRow = Packages.getPackageRow(db, tenantId, "PART_MASTER");
      const contract = Execution.resolveExecutionContract(db, tenantId, { packageRow });
      assert.equal(contract.target_object_type, "product");
      assert.ok(contract.mappings.length >= 6, "package mappings must be parsed from mapping_json");
      assert.equal(contract.duplicate_strategy, "UPSERT");
      assert.equal(typeof contract.source, "object");
    });

    test("resolves a definition contract including its child mappings", () => {
      const definitionRow = queryOne(db, "SELECT * FROM mig_definitions WHERE tenant_id = ? AND code = 'PART_MASTER_DEF'", [tenantId]);
      assert.ok(definitionRow);
      const contract = Execution.resolveExecutionContract(db, tenantId, { definitionRow });
      assert.equal(contract.target_object_type, "product");
      assert.ok(contract.mappings.length >= 6);
      assert.ok(contract.validation_rules.length >= 2);
    });

    test("reports a missing migration job as null rather than throwing", () => {
      assert.equal(Execution.getMigrationJob(db, tenantId, "MISSING-REF"), null);
      assert.equal(Execution.getJobRow(db, tenantId, "MISSING-REF"), null);
    });
  });
});
