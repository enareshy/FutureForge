process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
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
import * as Configuration from "../services/migration/configuration.js";
import * as Foundation from "../services/migration/foundation.js";
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

describe("migration async twins mirror the sync layer", () => {
  let db;
  let tenantId;
  let actor;
  let seq = 0;
  const nextCode = (prefix) => {
    seq += 1;
    return `${prefix}_ASY${String(seq).padStart(3, "0")}`;
  };

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    actor = { id: row.id, username: row.username };
  });

  after(() => db?.close());

  describe("source adapters & configurations", () => {
    test("catalogue stays in-memory while configurations round-trip asynchronously", async () => {
      const adapters = SourceAdapters.Registry.listSourceAdapters();
      assert.ok(adapters.length >= 10);

      const code = nextCode("SRC");
      const created = await SourceConfigurations.createSourceConfigurationAsync(
        db,
        tenantId,
        { code, name: "Legacy DB", adapter_type: "DATABASE", settings: { records: RECORDS } },
        actor
      );
      assert.equal(created.code, code);

      const fetched = await SourceConfigurations.getSourceConfigurationAsync(db, tenantId, code);
      assert.equal(fetched.id, created.id);

      const listed = await SourceConfigurations.listSourceConfigurationsAsync(db, { tenantId, adapterType: "DATABASE" });
      assert.ok(listed.items.some((item) => item.code === code));

      const updated = await SourceConfigurations.updateSourceConfigurationAsync(db, tenantId, code, { name: "Renamed" }, actor);
      assert.equal(updated.name, "Renamed");

      const inactive = await SourceConfigurations.setSourceConfigurationStatusAsync(db, tenantId, code, "inactive", actor);
      assert.equal(inactive.status, "inactive");

      const tested = await SourceConfigurations.testSourceConfigurationAsync(db, tenantId, code, actor);
      assert.equal(tested.code, code);
      assert.equal(typeof tested.connected, "boolean");

      const discovered = await SourceConfigurations.discoverSourceConfigurationSchemaAsync(db, tenantId, code, {}, actor);
      assert.equal(discovered.code, code);
      assert.ok(Array.isArray(discovered.fields));

      await assert.rejects(
        () => SourceConfigurations.createSourceConfigurationAsync(db, tenantId, { code, adapter_type: "DATABASE" }, actor),
        (error) => isMigrationError(error, 409, "MIGRATION_SOURCE_CONFLICT")
      );
      await assert.rejects(
        () => SourceConfigurations.createSourceConfigurationAsync(db, tenantId, { code: nextCode("BAD"), adapter_type: "NOPE" }, actor),
        (error) => isMigrationError(error, 400, "INVALID_MIGRATION_SOURCE")
      );
    });
  });

  describe("projects", () => {
    test("creates, reads, lists, updates and transitions asynchronously", async () => {
      const code = nextCode("PROJ");
      const created = await Projects.createProjectAsync(db, tenantId, { code, name: "Onboard", source_system: "Teamcenter" }, actor);
      assert.equal(created.code, code);
      assert.equal(created.status, "DRAFT");

      const fetched = await Projects.getProjectAsync(db, tenantId, code);
      assert.equal(fetched.id, created.id);

      const listed = await Projects.listProjectsAsync(db, { tenantId, status: "DRAFT" });
      assert.ok(listed.items.some((item) => item.code === code));

      const updated = await Projects.updateProjectAsync(db, tenantId, code, { description: "desc", scope: { mode: "FULL" } }, actor);
      assert.equal(updated.description, "desc");

      const ready = await Projects.setProjectStatusAsync(db, tenantId, code, "READY", actor);
      assert.equal(ready.status, "READY");

      assert.equal(await Projects.getProjectAsync(db, tenantId, "MISSING"), null);
      await assert.rejects(
        () => Projects.createProjectAsync(db, tenantId, { code, name: "Dup" }, actor),
        (error) => isMigrationError(error, 409, "MIGRATION_PROJECT_CONFLICT")
      );
      await assert.rejects(
        () => Projects.setProjectStatusAsync(db, tenantId, code, "NOT_A_STATUS", actor),
        (error) => error instanceof MigrationError
      );
    });
  });

  describe("packages, dependencies & planning", () => {
    test("creates packages, wires dependencies, topological order and plans asynchronously", async () => {
      const project = await Projects.createProjectAsync(db, tenantId, { code: nextCode("PROJ"), name: "Dep project" }, actor);
      const baseCode = nextCode("PKG");
      const base = await Packages.createPackageAsync(
        db,
        tenantId,
        {
          project_id: project.id,
          code: baseCode,
          name: "Base",
          target_object_type: "product",
          mappings: MAPPINGS,
          source: { adapter_type: "DATABASE", settings: { records: RECORDS } },
        },
        actor
      );
      const childCode = nextCode("PKG");
      await Packages.createPackageAsync(
        db,
        tenantId,
        { project_id: project.id, code: childCode, name: "Child", target_object_type: "product", dependencies: [{ depends_on: baseCode }] },
        actor
      );

      const dependencies = await Dependencies.listPackageDependenciesAsync(db, tenantId, base.id);
      assert.ok(Array.isArray(dependencies));

      const topology = await Dependencies.topologicalOrderAsync(db, tenantId, project.id);
      assert.equal(topology.hasCycle, false);
      assert.equal(topology.order.length, 2);
      assert.equal(topology.order[0].code, baseCode);

      const readiness = await Planning.evaluatePackageReadinessAsync(db, tenantId, await Packages.getPackageRowAsync(db, tenantId, childCode));
      assert.ok(["ready", "blocked", "warning"].includes(readiness.readiness));

      const plan = await Planning.generatePlanAsync(db, tenantId, project.id, { actor });
      assert.ok(["READY", "BLOCKED"].includes(plan.status));
      assert.equal(plan.steps.length, 2);

      const report = await Planning.readinessReportAsync(db, tenantId, project.id);
      assert.ok(["READY", "BLOCKED", "WARNING"].includes(report.status));

      await assert.rejects(
        () => Packages.createPackageAsync(db, tenantId, { project_id: project.id, code: baseCode, name: "Dup" }, actor),
        (error) => isMigrationError(error, 409, "MIGRATION_PACKAGE_CONFLICT")
      );
    });
  });

  describe("definitions", () => {
    test("creates, validates, transitions and versions a definition asynchronously", async () => {
      const code = nextCode("DEF");
      const created = await Definitions.createDefinitionAsync(
        db,
        tenantId,
        {
          code,
          name: "Part def",
          source_object_type: "Part",
          target_object_type: "product",
          mappings: MAPPINGS,
          validation_rules: [{ target_field: "part.number", rule_type: "REQUIRED" }],
        },
        actor
      );
      assert.equal(created.code, code);
      assert.ok(created.mappings.length >= 1);

      const validation = await Definitions.validateDefinitionAsync(db, tenantId, code);
      assert.equal(validation.valid, true, JSON.stringify(validation.errors));

      const active = await Definitions.setDefinitionStatusAsync(db, tenantId, code, "ACTIVE", actor);
      assert.equal(active.status, "ACTIVE");

      await assert.rejects(
        () => Definitions.updateDefinitionAsync(db, tenantId, code, { name: "nope" }, actor),
        (error) => isMigrationError(error, 409, "MIGRATION_DEFINITION_IMMUTABLE")
      );

      const versioned = await Definitions.createDefinitionVersionAsync(db, tenantId, code, { changeSummary: "tweak", actor });
      assert.ok(versioned.version > 1);
      const versions = await Definitions.listDefinitionVersionsAsync(db, tenantId, code);
      assert.ok(versions.total >= 2);
    });
  });

  describe("identifier & relationship mapping", () => {
    test("maps identifiers idempotently and rejects conflicting targets asynchronously", async () => {
      const first = await IdentifierMapping.mapIdentifierAsync(db, tenantId, {
        source_system: "Teamcenter",
        source_object_type: "Part",
        source_object_id: "ASYNC-SRC-A",
        target_object_type: "product",
        target_object_id: "ASYNC-TGT-A",
      }, actor);
      assert.equal(first.created, true);
      assert.equal(first.mapping.status, "MAPPED");

      const again = await IdentifierMapping.mapIdentifierAsync(db, tenantId, {
        source_system: "Teamcenter",
        source_object_type: "Part",
        source_object_id: "ASYNC-SRC-A",
        target_object_id: "ASYNC-TGT-A",
      }, actor);
      assert.equal(again.created, false);

      await assert.rejects(
        () => IdentifierMapping.mapIdentifierAsync(db, tenantId, { source_system: "Teamcenter", source_object_type: "Part", source_object_id: "ASYNC-SRC-A", target_object_id: "ASYNC-TGT-OTHER" }, actor),
        (error) => isMigrationError(error, 409, "MIGRATION_IDENTIFIER_CONFLICT")
      );

      const resolved = await IdentifierMapping.resolveIdentifierAsync(db, tenantId, { sourceSystem: "Teamcenter", sourceObjectType: "Part", sourceObjectId: "ASYNC-SRC-A" });
      assert.equal(resolved.target_object_id, "ASYNC-TGT-A");

      const bulk = await IdentifierMapping.bulkMapIdentifiersAsync(db, tenantId, [
        { source_system: "Teamcenter", source_object_type: "Part", source_object_id: "ASYNC-SRC-B", target_object_id: "ASYNC-TGT-B" },
        { source_system: "Teamcenter", source_object_type: "Part", source_object_id: "ASYNC-SRC-B", target_object_id: "ASYNC-TGT-B" },
      ], actor);
      assert.equal(bulk.created, 1);
      assert.equal(bulk.updated, 1);
    });

    test("migrates relationships through a real relationship type asynchronously", async () => {
      const relType = queryOne(db, "SELECT code FROM relationship_types ORDER BY id LIMIT 1");
      if (!relType) return;
      await IdentifierMapping.mapIdentifierAsync(db, tenantId, { source_system: "TCASY", source_object_type: "Part", source_object_id: "RA", target_object_type: "product", target_object_id: "ASY-OBJ-A" }, actor);
      await IdentifierMapping.mapIdentifierAsync(db, tenantId, { source_system: "TCASY", source_object_type: "Part", source_object_id: "RB", target_object_type: "product", target_object_id: "ASY-OBJ-B" }, actor);

      const missing = await Relationships.migrateRelationshipAsync(db, tenantId, {
        source_system: "TCASY",
        parent_source_type: "Part",
        child_source_type: "Part",
        source_parent_id: "RA",
        source_child_id: "UNKNOWN",
        relationship_type: relType.code,
      }, actor);
      assert.equal(missing.status, "MISSING");

      const dryRun = await Relationships.migrateRelationshipAsync(db, tenantId, {
        source_system: "TCASY",
        parent_source_type: "Part",
        child_source_type: "Part",
        source_parent_id: "RA",
        source_child_id: "RB",
        relationship_type: relType.code,
      }, actor, null, { dryRun: true });
      assert.equal(dryRun.status, "MAPPED");
      assert.equal(dryRun.relationship.source_parent_id, "ASY-OBJ-A");
    });
  });

  describe("execution", () => {
    test("previews and validates a package without writing asynchronously", async () => {
      const project = await Projects.createProjectAsync(db, tenantId, { code: nextCode("PROJ"), name: "Exec project" }, actor);
      const code = nextCode("PKG");
      await Packages.createPackageAsync(db, tenantId, {
        project_id: project.id,
        code,
        name: "Exec",
        source_object_type: "Part",
        target_object_type: "product",
        source: { adapter_type: "DATABASE", settings: { records: RECORDS } },
        mappings: MAPPINGS,
        duplicate_strategy: "UPSERT",
      }, actor);
      const packageRow = await Packages.getPackageRowAsync(db, tenantId, code);

      const preview = await Execution.previewMigrationAsync(db, tenantId, { packageRow }, { limit: 2 }, actor);
      assert.equal(preview.record_count, 2);
      assert.equal(preview.valid, 2);
      assert.equal(preview.invalid, 0);

      const validation = await Execution.validateMigrationAsync(db, tenantId, { packageRow }, {}, actor);
      assert.equal(validation.valid, true, JSON.stringify(validation.errors));
      assert.equal(validation.sample.valid, 2);

      const plan = await Planning.generatePlanAsync(db, tenantId, project.id, { actor });
      assert.equal(plan.status, "READY");
      const approved = await Planning.approvePlanAsync(db, tenantId, plan.id, actor);
      assert.equal(approved.status, "APPROVED");
    });

    test("runs a migration job, records results and reconciles cleanly asynchronously", async () => {
      const packageRow = await Packages.getPackageRowAsync(db, tenantId, "PART_MASTER");
      assert.ok(packageRow, "seeded PART_MASTER package must exist");

      const { job, existing } = await Execution.createMigrationJobAsync(db, { tenantId, package: packageRow, mode: "EXECUTE", actor });
      assert.equal(existing, false);
      assert.equal(job.mode, "EXECUTE");

      const again = await Execution.createMigrationJobAsync(db, { tenantId, package: packageRow, mode: "EXECUTE", actor, idempotencyKey: `async-${job.id}` });
      assert.equal(typeof again.existing, "boolean");

      const result = await Execution.runMigrationJobAsync(db, { jobId: job.id, actor });
      assert.ok(["COMPLETED", "PARTIALLY_COMPLETED"].includes(result.status));
      assert.ok(result.success_count >= 1);

      const results = await Execution.listObjectResultsAsync(db, { tenantId, jobId: job.id });
      assert.equal(results.total, result.success_count);

      const errors = await Execution.listErrorsAsync(db, { tenantId, jobId: job.id });
      assert.equal(typeof errors.total, "number");

      const checkpoints = await Execution.listCheckpointsAsync(db, { tenantId, jobId: job.id });
      assert.ok(Array.isArray(checkpoints.items));

      const reconciliation = await Reconciliation.reconcileJobAsync(db, { tenantId, jobId: job.id, strategy: "COUNT" });
      assert.equal(reconciliation.status, "COMPLETED");
      assert.equal(reconciliation.variance, 0);

      const listed = await Reconciliation.listReconciliationsAsync(db, { tenantId, jobId: job.id });
      assert.ok(listed.total >= 1);

      const lineage = await Audit.listMigrationAuditAsync(db, { tenantId, jobId: job.id });
      assert.ok(lineage.total >= 1);
    });

    test("supports cancel, pause and resume lifecycle transitions asynchronously", async () => {
      const packageRow = await Packages.getPackageRowAsync(db, tenantId, "PART_MASTER");
      const { job } = await Execution.createMigrationJobAsync(db, { tenantId, package: packageRow, mode: "EXECUTE", actor });
      const paused = await Execution.pauseMigrationJobAsync(db, tenantId, job.id, actor);
      assert.equal(paused.status, "PAUSED");
      const resumed = await Execution.resumeMigrationJobAsync(db, tenantId, job.id, actor);
      assert.equal(resumed.status, "QUEUED");
      const cancelled = await Execution.cancelMigrationJobAsync(db, tenantId, job.id, actor);
      assert.equal(cancelled.status, "CANCELLED");
    });
  });

  describe("statistics, metrics, files and audit", () => {
    test("records statistics and reports metrics & health asynchronously", async () => {
      const job = queryOne(db, "SELECT id FROM mig_jobs WHERE tenant_id = ? ORDER BY id LIMIT 1", [tenantId]);
      const statisticId = await Statistics.recordJobStatisticsAsync(db, { tenantId, jobId: job?.id ?? null, snapshot: { migrated: 5 } });
      assert.ok(Number(statisticId) > 0);

      const listed = await Statistics.listStatisticsAsync(db, { tenantId });
      assert.ok(listed.total >= 1);

      const metrics = await Statistics.metricsSnapshotAsync(db, { tenantId });
      assert.equal(metrics.source_module, "migration");
      assert.equal(typeof metrics.projects, "number");
      assert.ok(metrics.projects >= 2);

      const health = await Statistics.healthCheckAsync(db, { tenantId });
      assert.equal(health.status, "healthy");
      assert.ok(health.checks.every((check) => check.status === "ok"));
    });

    test("lists file migrations and audit entries asynchronously", async () => {
      const files = await Files.listFileMigrationsAsync(db, { tenantId });
      assert.ok(Array.isArray(files.items));
      const audit = await Audit.listMigrationAuditAsync(db, { tenantId, pageSize: 50 });
      assert.ok(audit.total >= 1);
      assert.ok(audit.items.every((entry) => typeof entry.action === "string"));
    });
  });

  describe("configuration, foundation & health", () => {
    test("round-trips configuration and exposes foundation health asynchronously", async () => {
      const key = "preview_limit";
      await Configuration.setConfigAsync(db, tenantId, key, 7, actor);
      assert.equal(Number(await Configuration.getConfigAsync(db, tenantId, key)), 7);
      const all = await Configuration.listConfigAsync(db, tenantId);
      assert.equal(Number(all[key]), 7);

      const foundation = await Foundation.ensureMigrationFoundationAsync(db);
      assert.ok(foundation);
      const asyncHealth = await Foundation.migrationHealthAsync(db, tenantId);
      const syncHealth = Foundation.migrationHealth(db, tenantId);
      assert.equal(asyncHealth.source_module, "migration");
      assert.deepEqual(asyncHealth.counts, syncHealth.counts);
    });
  });

  describe("execution contract", () => {
    test("resolves a package contract and parses its mapping_json asynchronously", async () => {
      const packageRow = await Packages.getPackageRowAsync(db, tenantId, "PART_MASTER");
      const contract = await Execution.resolveExecutionContractAsync(db, tenantId, { packageRow });
      assert.equal(contract.target_object_type, "product");
      assert.ok(contract.mappings.length >= 6);
      assert.equal(contract.duplicate_strategy, "UPSERT");
    });

    test("reports a missing migration job as null rather than throwing asynchronously", async () => {
      assert.equal(await Execution.getMigrationJobAsync(db, tenantId, "MISSING-REF"), null);
      assert.equal(await Execution.getJobRowAsync(db, tenantId, "MISSING-REF"), null);
    });
  });

  describe("background jobs & seed", () => {
    test("submits a platform migration job asynchronously", async () => {
      const packageRow = await Packages.getPackageRowAsync(db, tenantId, "PART_MASTER");
      const { job } = await Execution.createMigrationJobAsync(db, { tenantId, package: packageRow, mode: "EXECUTE", actor });
      const platformJob = await Jobs.submitMigrationJobAsync(db, { tenantId, migrationJobId: job.id, actor });
      assert.ok(platformJob);
      assert.equal(platformJob.job_type_code || platformJob.job_type, "DATA_MIGRATION");
    });

    test("async seed is idempotent and ensureMigrationSeedAsync skips when present", async () => {
      const result = await Seed.seedMigrationAsync(db, tenantId);
      assert.equal(result.seeded, true);
      const ensured = await Seed.ensureMigrationSeedAsync(db, tenantId);
      assert.equal(ensured.seeded, false);
      assert.equal(queryOne(db, "SELECT COUNT(*) AS c FROM mig_projects WHERE tenant_id = ? AND code = 'LEGACY_TC_ONBOARD'", [tenantId]).c, 1);
    });
  });
});
