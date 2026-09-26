process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import { listHandlers } from "../services/job-execution/handlers.js";
import * as constants from "../services/migration/constants.js";
import * as Errors from "../services/migration/errors.js";
import * as Refs from "../services/migration/refs.js";
import * as Validation from "../services/migration/validation.js";
import * as Configuration from "../services/migration/configuration.js";
import * as Audit from "../services/migration/audit.js";
import * as Search from "../services/migration/search.js";
import * as Foundation from "../services/migration/foundation.js";
import * as Index from "../services/migration/index.js";

const TENANT = 1;

function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("Expected the function to throw");
}

function adminActor(db) {
  const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  return { id: row.id, username: row.username };
}

describe("migration constants", () => {
  test("declares the owning source module", () => {
    assert.equal(constants.SOURCE_MODULE, "migration");
  });

  test("exposes the expected vocabulary members as arrays", () => {
    assert.ok(constants.PROJECT_STATUSES.includes("DRAFT"));
    assert.ok(constants.PACKAGE_STATUSES.includes("READY"));
    assert.ok(constants.DEFINITION_STATUSES.includes("ACTIVE"));
    assert.deepEqual(constants.EXECUTION_MODES, ["DRY_RUN", "EXECUTE", "VALIDATE"]);
    assert.ok(constants.JOB_STATUSES.includes("QUEUED"));
    assert.ok(constants.BATCH_STATUSES.includes("COMPLETED"));
    assert.ok(constants.DUPLICATE_STRATEGIES.includes("UPSERT"));
    assert.ok(constants.DUPLICATE_KEY_TYPES.includes("BUSINESS_KEY"));
    assert.ok(constants.ERROR_STRATEGIES.includes("STOP_ON_ERROR"));
    assert.deepEqual(constants.DEPENDENCY_STRATEGIES, ["STRICT", "WARN", "IGNORE"]);
    assert.ok(constants.DEPENDENCY_TYPES.includes("PACKAGE"));
    assert.ok(constants.RECONCILIATION_STRATEGIES.includes("COUNT"));
    assert.ok(constants.SOURCE_ADAPTER_TYPES.includes("LEGACY_TEAMCENTER"));
    assert.ok(constants.SOURCE_ADAPTER_CAPABILITIES.includes("SCHEMA_DISCOVERY"));
    assert.ok(constants.MIGRATION_SCOPES.includes("FULL"));
    assert.ok(constants.PIPELINE_STAGES.includes("RECONCILE"));
    assert.ok(constants.ERROR_CATEGORIES.includes("MAPPING_ERROR"));
    for (const key of ["SOURCE_ADAPTER_TYPES", "PIPELINE_STAGES", "MIGRATION_SCOPES", "SECURITY_ACTIONS"]) {
      assert.ok(Array.isArray(constants[key]), `${key} must be an array`);
    }
    assert.ok(constants.SOURCE_ADAPTER_TYPES.length >= 10);
  });

  test("freezes the tuning/reference objects", () => {
    for (const key of ["CONFIG_DEFAULTS", "CONFIG_BOUNDS", "MIGRATION_RESOURCES", "MIGRATION_HANDLER_CODES"]) {
      assert.ok(Object.isFrozen(constants[key]), `${key} must be frozen`);
    }
    assert.equal(constants.MIGRATION_HANDLER_CODES.EXECUTE, "migration.execute");
    assert.equal(constants.MIGRATION_HANDLER_CODES.MAINTENANCE, "migration.maintenance");
    assert.equal(constants.MIGRATION_RESOURCES.module, "iam.migration");
    assert.equal(constants.MIGRATION_RESOURCES.admin, "iam.migration.admin");
  });

  test("describes CONFIG_BOUNDS consistently with CONFIG_DEFAULTS", () => {
    assert.deepEqual(constants.CONFIG_BOUNDS.quality_min_score, { min: 0, max: 100 });
    assert.deepEqual(constants.CONFIG_BOUNDS.reconciliation_tolerance, { min: 0, max: 1 });
    for (const [key, bounds] of Object.entries(constants.CONFIG_BOUNDS)) {
      assert.equal(typeof bounds.min, "number", key);
      assert.equal(typeof bounds.max, "number", key);
      assert.ok(bounds.max >= bounds.min, key);
      assert.ok(Object.prototype.hasOwnProperty.call(constants.CONFIG_DEFAULTS, key), `${key} has no default`);
      const value = constants.CONFIG_DEFAULTS[key];
      assert.ok(value >= bounds.min && value <= bounds.max, `${key} default is out of bounds`);
    }
  });

  test("registers job types and event types owned by the module", () => {
    assert.ok(constants.MIGRATION_JOB_TYPES.length >= 6);
    for (const job of constants.MIGRATION_JOB_TYPES) {
      assert.equal(job.source_module, constants.SOURCE_MODULE);
      assert.equal(typeof job.code, "string");
      assert.ok(Object.values(constants.MIGRATION_HANDLER_CODES).includes(job.handler));
    }
    for (const code of ["DATA_MIGRATION", "DATA_MIGRATION_VALIDATE", "DATA_MIGRATION_RECONCILE", "DATA_MIGRATION_RETRY", "DATA_MIGRATION_REPLAN", "DATA_MIGRATION_MAINTENANCE"]) {
      assert.ok(constants.MIGRATION_JOB_TYPES.some((job) => job.code === code), `missing job type ${code}`);
    }
    assert.ok(constants.MIGRATION_EVENT_TYPES.some((event) => event.code === "MigrationStarted"));
    assert.ok(constants.MIGRATION_EVENT_TYPES.some((event) => event.code === "MigrationCompleted"));
  });
});

describe("migration error factories", () => {
  const CASES = [
    ["projectNotFound", "MIGRATION_PROJECT_NOT_FOUND", 404, ["P1"]],
    ["projectConflict", "MIGRATION_PROJECT_CONFLICT", 409, ["P1"]],
    ["invalidProject", "INVALID_MIGRATION_PROJECT", 400, ["bad", {}]],
    ["projectImmutable", "MIGRATION_PROJECT_IMMUTABLE", 409, ["P1", "RUNNING"]],
    ["packageNotFound", "MIGRATION_PACKAGE_NOT_FOUND", 404, ["K1"]],
    ["packageConflict", "MIGRATION_PACKAGE_CONFLICT", 409, ["K1"]],
    ["invalidPackage", "INVALID_MIGRATION_PACKAGE", 400, ["bad", {}]],
    ["definitionNotFound", "MIGRATION_DEFINITION_NOT_FOUND", 404, ["D1"]],
    ["definitionConflict", "MIGRATION_DEFINITION_CONFLICT", 409, ["D1"]],
    ["invalidDefinition", "INVALID_MIGRATION_DEFINITION", 400, ["bad", {}]],
    ["definitionImmutable", "MIGRATION_DEFINITION_IMMUTABLE", 409, ["D1", "ACTIVE"]],
    ["definitionBlocked", "MIGRATION_DEFINITION_BLOCKED", 422, [{}]],
    ["invalidMapping", "MIGRATION_MAPPING_INVALID", 400, ["bad", {}]],
    ["invalidTransformation", "MIGRATION_TRANSFORMATION_INVALID", 400, ["bad", {}]],
    ["invalidValidation", "MIGRATION_VALIDATION_INVALID", 400, ["bad", {}]],
    ["sourceNotFound", "MIGRATION_SOURCE_NOT_FOUND", 404, ["S1"]],
    ["sourceConflict", "MIGRATION_SOURCE_CONFLICT", 409, ["S1"]],
    ["invalidSource", "INVALID_MIGRATION_SOURCE", 400, ["bad", {}]],
    ["adapterNotFound", "MIGRATION_ADAPTER_NOT_FOUND", 404, ["NOPE"]],
    ["adapterUnsupported", "MIGRATION_ADAPTER_UNSUPPORTED", 400, ["DATABASE", "STREAMING"]],
    ["adapterFailed", "MIGRATION_ADAPTER_FAILED", 502, ["boom", {}]],
    ["dependencyNotFound", "MIGRATION_DEPENDENCY_NOT_FOUND", 404, ["X"]],
    ["dependencyUnsatisfied", "MIGRATION_DEPENDENCY_UNSATISFIED", 409, [{}]],
    ["dependencyCircular", "MIGRATION_DEPENDENCY_CIRCULAR", 409, [{}]],
    ["invalidDependency", "INVALID_MIGRATION_DEPENDENCY", 400, ["bad", {}]],
    ["planNotFound", "MIGRATION_PLAN_NOT_FOUND", 404, ["PL1"]],
    ["planBlocked", "MIGRATION_PLAN_BLOCKED", 422, [{}]],
    ["invalidPlan", "INVALID_MIGRATION_PLAN", 400, ["bad", {}]],
    ["jobNotFound", "MIGRATION_JOB_NOT_FOUND", 404, ["J1"]],
    ["jobConflict", "MIGRATION_JOB_CONFLICT", 409, ["bad", {}]],
    ["jobFailed", "MIGRATION_JOB_FAILED", 500, ["bad", {}]],
    ["jobNotCancellable", "MIGRATION_JOB_NOT_CANCELLABLE", 409, ["J1", "COMPLETED"]],
    ["jobNotRetryable", "MIGRATION_JOB_NOT_RETRYABLE", 409, ["J1", "COMPLETED"]],
    ["jobNotPausable", "MIGRATION_JOB_NOT_PAUSABLE", 409, ["J1", "COMPLETED"]],
    ["invalidMode", "INVALID_MIGRATION_MODE", 400, ["NOPE"]],
    ["invalidDuplicateStrategy", "INVALID_MIGRATION_DUPLICATE_STRATEGY", 400, ["NOPE"]],
    ["duplicateRecord", "MIGRATION_DUPLICATE_RECORD", 409, [{}]],
    ["recordFailed", "MIGRATION_RECORD_FAILED", 422, ["bad", {}]],
    ["batchFailed", "MIGRATION_BATCH_FAILED", 500, ["bad", {}]],
    ["checkpointNotFound", "MIGRATION_CHECKPOINT_NOT_FOUND", 404, ["C1"]],
    ["reconciliationNotFound", "MIGRATION_RECONCILIATION_NOT_FOUND", 404, ["R1"]],
    ["invalidReconciliation", "INVALID_MIGRATION_RECONCILIATION", 400, ["bad", {}]],
    ["identifierNotFound", "MIGRATION_IDENTIFIER_NOT_FOUND", 404, ["I1"]],
    ["identifierConflict", "MIGRATION_IDENTIFIER_CONFLICT", 409, [{}]],
    ["invalidIdentifier", "INVALID_MIGRATION_IDENTIFIER", 400, ["bad", {}]],
    ["relationshipFailed", "MIGRATION_RELATIONSHIP_FAILED", 422, ["bad", {}]],
    ["fileMigrationFailed", "MIGRATION_FILE_MIGRATION_FAILED", 422, ["bad", {}]],
    ["storageFailed", "MIGRATION_STORAGE_FAILED", 502, ["bad", {}]],
    ["securityBlocked", "MIGRATION_SECURITY_BLOCKED", 403, [{}]],
    ["lifecycleBlocked", "MIGRATION_LIFECYCLE_BLOCKED", 409, [{}]],
    ["qualityBlocked", "MIGRATION_QUALITY_BLOCKED", 422, [{}]],
    ["invalidConfiguration", "INVALID_MIGRATION_CONFIGURATION", 400, ["bad", {}]],
    ["auditNotFound", "MIGRATION_AUDIT_NOT_FOUND", 404, ["A1"]],
    ["migrationConflict", "MIGRATION_CONFLICT", 409, ["bad", {}]],
  ];

  test("every factory produces a MigrationError with the documented code and status", () => {
    for (const [name, code, status, args] of CASES) {
      assert.equal(typeof Errors[name], "function", `${name} must be exported`);
      const error = Errors[name](...args);
      assert.ok(error instanceof Errors.MigrationError, `${name} must build a MigrationError`);
      assert.equal(error.code, code, name);
      assert.equal(error.status, status, name);
      assert.ok(error.message, `${name} must carry a message`);
      const serialized = Validation.publicError(error);
      assert.equal(serialized.error, error.message);
      assert.equal(serialized.code, code);
    }
  });
});

describe("migration refs", () => {
  test("builds URL-safe, prefixed references", () => {
    assert.equal(Refs.projectRef("legacy TC"), "MIG-PROJ-LEGACY_TC");
    assert.equal(Refs.packageRef("part master"), "MIG-PKG-PART_MASTER");
    assert.equal(Refs.definitionRef("part def"), "MIG-DEF-PART_DEF");
    assert.equal(Refs.sourceRef("source 1"), "MIG-SRC-SOURCE_1");
    assert.match(Refs.jobRef("PART_MASTER"), /^MIG-JOB-PART_MASTER-[a-z0-9]{12}$/);
    assert.match(Refs.planRef("P1"), /^MIG-PLAN-P1-[a-z0-9]{12}$/);
    assert.match(Refs.reconciliationRef("MIG-JOB-X-abcd"), /^MIG-REC-MIG-JOB-X-ABCD$/);
    assert.equal(Refs.slug("a/b c"), "A_B_C");
  });
});

describe("migration validation vocabulary", () => {
  test("exposes the meta vocabulary", () => {
    const vocab = Validation.vocabulary();
    assert.deepEqual(vocab.execution_modes, ["DRY_RUN", "EXECUTE", "VALIDATE"]);
    assert.ok(vocab.project_statuses.includes("READY"));
    assert.ok(vocab.pipeline_stages.includes("EXECUTE"));
    assert.ok(vocab.reconciliation_strategies.includes("COUNT"));
  });

  test("asserts enum members and rejects unknown values", () => {
    assert.equal(Validation.assertExecutionMode("execute"), "EXECUTE");
    assert.equal(Validation.assertProjectStatus("ready"), "READY");
    assert.equal(Validation.assertDuplicateStrategy("upsert"), "UPSERT");
    assert.equal(Validation.assertAdapterType("legacy_teamcenter"), "LEGACY_TEAMCENTER");
    assert.equal(Validation.assertDependencyStrategy("warn"), "WARN");
    assert.equal(Validation.assertReadiness("READY"), "ready");
    for (const fn of ["assertExecutionMode", "assertProjectStatus", "assertDuplicateStrategy", "assertAdapterType", "assertReconciliationStrategy"]) {
      const error = thrownBy(() => Validation[fn]("NOT_A_MEMBER"));
      assert.ok(error instanceof Errors.MigrationError, fn);
    }
  });

  test("normalizes mappings, transformations and validation rules", () => {
    const mappings = Validation.assertMappings([{ source_field: "a", target_field: "b", mapping_type: "direct", required: true }]);
    assert.equal(mappings.length, 1);
    assert.equal(mappings[0].mapping_type, "DIRECT");
    assert.equal(mappings[0].required, true);

    const transformations = Validation.assertTransformations([{ target_field: "b", transformation_type: "trim" }]);
    assert.equal(transformations[0].transformation_type, "TRIM");
    assert.equal(transformations[0].stage, "FIELD");

    const rules = Validation.assertValidationRules([{ target_field: "b", rule_type: "required" }]);
    assert.equal(rules[0].rule_type, "REQUIRED");
    assert.equal(rules[0].severity, "ERROR");

    assert.throws(() => Validation.assertMappings([{ mapping_type: "DIRECT" }]), (error) => error.code === "MIGRATION_MAPPING_INVALID");
    assert.throws(() => Validation.assertValidationRules([{}]), (error) => error.code === "MIGRATION_VALIDATION_INVALID");
  });

  test("normalizes dependency edges", () => {
    const dependency = Validation.normalizeDependency({ dependency_type: "package", depends_on: "other", required: true });
    assert.equal(dependency.dependency_type, "PACKAGE");
    assert.equal(dependency.depends_on, "OTHER");
    assert.equal(dependency.required, true);
  });
});

describe("migration configuration", () => {
  let db;
  let actor;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
  });
  after(() => db?.close());

  test("returns defaults and enforces bounds", () => {
    assert.equal(Configuration.getConfig(db, TENANT, "default_batch_size"), constants.CONFIG_DEFAULTS.default_batch_size);
    const config = Configuration.listConfig(db, TENANT);
    assert.equal(typeof config.checkpoint_interval, "number");
    assert.equal(typeof config.migrate_files, "boolean");

    assert.equal(Configuration.setConfig(db, TENANT, "default_batch_size", 250, actor), 250);
    assert.equal(Configuration.getConfig(db, TENANT, "default_batch_size"), 250);

    assert.throws(() => Configuration.setConfig(db, TENANT, "default_batch_size", -1, actor), (error) => error.code === "INVALID_MIGRATION_CONFIGURATION");
    assert.throws(() => Configuration.setConfig(db, TENANT, "unknown_key", 1, actor), (error) => error.code === "INVALID_MIGRATION_CONFIGURATION");
  });

  test("ensureMigrationConfig is idempotent", () => {
    const first = Configuration.ensureMigrationConfig(db, TENANT);
    const second = Configuration.ensureMigrationConfig(db, TENANT);
    assert.equal(typeof first.created, "number");
    assert.equal(second.created, 0);
  });
});

describe("migration audit", () => {
  let db;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
  });
  after(() => db?.close());

  test("records and lists audit entries with lineage", () => {
    const id = Audit.recordMigrationAudit(db, {
      tenantId: TENANT,
      jobId: null,
      projectId: null,
      packageId: null,
      targetObjectId: "OBJ-1",
      sourceObjectId: "SRC-1",
      action: "migration.record.migrated",
      resourceType: "mig_object_results",
      status: "SUCCESS",
      details: { ok: true },
    });
    assert.ok(Number(id) > 0);
    const listed = Audit.listMigrationAudit(db, { tenantId: TENANT, action: "migration.record.migrated" });
    assert.ok(listed.items.some((entry) => entry.target_object_id === "OBJ-1"));
    const lineage = Audit.objectLineage(db, TENANT, "OBJ-1");
    assert.ok(Array.isArray(lineage));
    assert.ok(lineage.length >= 1);
  });
});

describe("migration foundation", () => {
  let db;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
  });
  after(() => db?.close());

  test("boots the foundation idempotently and exposes health", () => {
    const first = Foundation.ensureMigrationFoundation(db);
    assert.equal(first.source_module, "migration");
    assert.ok(first.adapters.length >= 10);
    assert.equal(typeof first.job_types, "number");
    assert.ok(first.tenants >= 1);

    const second = Foundation.ensureMigrationFoundation(db);
    assert.equal(second.job_types, 0);

    const registered = listHandlers();
    const codes = registered.map((entry) => entry.code);
    for (const code of Object.values(constants.MIGRATION_HANDLER_CODES)) {
      assert.ok(codes.includes(code.toUpperCase()), `handler ${code} must be registered`);
    }

    const health = Foundation.migrationHealth(db, TENANT);
    assert.equal(health.source_module, "migration");
    assert.equal(typeof health.counts.projects, "number");
  });

  test("registers search sources and the job types", () => {
    const search = Search.ensureMigrationSearch(db);
    assert.equal(typeof search, "object");
    for (const entry of constants.SEARCH_OBJECT_TYPES) {
      const row = queryOne(db, "SELECT id FROM search_object_types WHERE code = ? AND tenant_id = ?", [entry.code, TENANT]);
      assert.ok(row, `missing search source ${entry.code}`);
    }
    for (const job of constants.MIGRATION_JOB_TYPES) {
      assert.ok(queryOne(db, "SELECT id FROM job_types WHERE code = ?", [job.code]), `missing job type ${job.code}`);
    }
  });
});

describe("migration facade", () => {
  test("exposes a stable flat SDK surface", () => {
    assert.equal(typeof Index.ensureMigrationFoundation, "function");
    assert.equal(typeof Index.seedMigration, "function");
    assert.equal(typeof Index.registerMigrationHandlers, "function");
    assert.equal(typeof Index.Migration, "object");
    for (const name of ["createProject", "createPackage", "createDefinition", "generatePlan", "previewMigration", "createMigrationJob", "runMigrationJob", "reconcileJob", "mapIdentifier", "migrateRelationship", "listStatistics", "metrics", "health"]) {
      assert.equal(typeof Index.Migration[name], "function", `Migration.${name} must be a function`);
    }
    for (const name of ["constants", "Validation", "Errors", "Refs", "Repository", "Configuration", "Events", "Audit", "Security", "SourceConfigurations", "SourceAdapters", "Definitions", "Projects", "Packages", "Dependencies", "Planning", "IdentifierMapping", "Relationships", "Execution", "Reconciliation", "Statistics", "Files", "Jobs", "Foundation", "Seed", "Search"]) {
      assert.equal(typeof Index[name], "object", `${name} module must be exported`);
    }
  });
});
