process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate } from "../db.js";
import {
  Definitions,
  Revisions,
  Lines,
  Structure,
  Rollup,
  WhereUsed,
  Compare,
  Transformation,
  Validator,
  Baselines,
  Metrics,
  Jobs,
  Seed,
  ensureBomFoundation,
  Configuration,
} from "../services/bom/index.js";

describe("BOM Engine analytical services", () => {
  let db;
  const tenant = 1;
  let seededRevision;
  let seededBom;
  let seededBaseline;
  let seededDefinition;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('helix', 'Helix', 'organization')").run();
    db.prepare("UPDATE organizations SET tenant_id = id WHERE code = 'helix'").run();
    ensureBomFoundation(db);
    Configuration.ensureBomConfig(db, tenant);
    const result = Seed.seedBom(db, tenant);
    assert.equal(result.seeded, true);
    seededBom = Definitions.getBom(db, tenant, "DEMO-EBOM-PUMP");
    seededRevision = Revisions.listRevisions(db, { tenantId: tenant, bomId: seededBom.id }).items[0];
    seededBaseline = Baselines.listBaselines(db, { tenantId: tenant, bomId: seededBom.id }).items[0];
    seededDefinition = Transformation.listTransformationDefinitions(db, { tenantId: tenant }).items[0];
  });

  after(() => {
    db?.close();
  });

  test("rolls quantities up across the structure", () => {
    const result = Rollup.rollup(db, tenant, seededRevision.id, { includeOptional: true });
    assert.equal(result.line_count, 6);
    const bolt = result.totals.objects.find((row) => row.object_id === "DEMO-BOLT-M8");
    assert.equal(Number(bolt.quantity), 8);
    const seal = result.totals.objects.find((row) => row.object_id === "DEMO-SEAL-004");
    assert.equal(Number(seal.quantity), 2);
    assert.ok(result.totals.by_usage.DESIGN >= 14);
  });

  test("resolves where-used and usage summaries", () => {
    const used = WhereUsed.whereUsed(db, { tenantId: tenant, objectId: "DEMO-SEAL-004" });
    assert.equal(used.total, 1);
    assert.equal(used.items[0].line.child_object_id, "DEMO-SEAL-004");

    const multilevel = WhereUsed.multiLevelWhereUsed(db, tenant, "DEMO-SEAL-004", { maxDepth: 5 });
    assert.ok(multilevel.total >= 1);

    const summary = WhereUsed.componentUsageSummary(db, tenant, "DEMO-SEAL-004");
    assert.equal(summary.object_id, "DEMO-SEAL-004");
    assert.ok(summary.total_usages >= 1);

    const uses = WhereUsed.uses(db, { tenantId: tenant, revisionId: seededRevision.id });
    assert.equal(uses.total, 6);
  });

  test("compares revisions and baselines with stable summaries", () => {
    const custom = Definitions.createBom(db, tenant, { bom_number: "CMP-BOM", name: "Compare", bom_type: "EBOM" });
    const left = Revisions.createRevision(db, tenant, custom.id, { revision_number: "A1" });
    Lines.addLine(db, tenant, left.id, { child_object_id: "C1", quantity: 1, uom: "EA", find_number: "10" });
    Lines.addLine(db, tenant, left.id, { child_object_id: "C2", quantity: 2, uom: "EA", find_number: "20" });
    const right = Revisions.createRevision(db, tenant, custom.id, { revision_number: "A2" });
    Lines.addLine(db, tenant, right.id, { child_object_id: "C1", quantity: 5, uom: "EA", find_number: "10" });
    Lines.addLine(db, tenant, right.id, { child_object_id: "C3", quantity: 1, uom: "EA", find_number: "30" });

    const result = Compare.compare(db, tenant, { left_kind: "REVISION", left_id: left.id, right_kind: "REVISION", right_id: right.id });
    assert.equal(result.comparison.summary.added, 1);
    assert.equal(result.comparison.summary.removed, 1);
    assert.equal(result.comparison.summary.modified, 1);
    assert.equal(result.results.length, 3);

    const baselineCompare = Compare.compare(db, tenant, {
      left_kind: "BASELINE", left_id: seededBaseline.id, right_kind: "REVISION", right_id: seededRevision.id,
    });
    assert.equal(baselineCompare.comparison.summary.unchanged, 6);
  });

  test("validates a revision and surfaces configurable issues", () => {
    const rules = Validator.listValidationRules(db, { tenantId: tenant });
    assert.ok(rules.total >= 8);

    const clean = Validator.validateRevision(db, tenant, seededRevision.id, { persist: false });
    assert.equal(clean.status, "PASS");
    assert.equal(clean.issue_count, 0);

    const dirty = Definitions.createBom(db, tenant, { bom_number: "VAL-BOM", name: "Validate", bom_type: "EBOM" });
    const dirtyRev = Revisions.createRevision(db, tenant, dirty.id, { revision_number: "A1" });
    Lines.addLine(db, tenant, dirtyRev.id, { child_object_id: "D1", quantity: 1, uom: "EA", find_number: "10" });
    Lines.addLine(db, tenant, dirtyRev.id, { child_object_id: "D2", quantity: 1, uom: "EA", find_number: "10" });
    const result = Validator.validateRevision(db, tenant, dirtyRev.id, { persist: true });
    assert.equal(result.status, "WARNING");
    assert.ok(result.issue_count >= 1);
    assert.ok(result.issues.some((issue) => issue.rule_type === "DUPLICATE_FIND_NUMBER"));

    const results = Validator.listValidationResults(db, { tenantId: tenant, revisionId: dirtyRev.id });
    assert.ok(results.total >= 1);
  });

  test("runs a controlled EBOM to MBOM transformation", () => {
    const dry = Transformation.transform(db, tenant, { definition_id: seededDefinition.id, source_revision_id: seededRevision.id, mode: "DRY_RUN" });
    assert.equal(dry.summary.mode, "DRY_RUN");
    assert.equal(dry.summary.mapped, 6);
    assert.equal(dry.preview.length, 6);

    const executed = Transformation.transform(db, tenant, { definition_id: seededDefinition.id, source_revision_id: seededRevision.id, mode: "EXECUTE" });
    assert.equal(executed.run.status, "COMPLETED");
    assert.equal(executed.summary.mapped, 6);
    const targetRevision = Revisions.getRevision(db, tenant, executed.run.target_revision_id);
    assert.equal(targetRevision.bom_id, executed.run.target_bom_id);
    const targetLines = Lines.listLines(db, { tenantId: tenant, revisionId: targetRevision.id });
    assert.equal(targetLines.total, 6);
    assert.equal(targetLines.items[0].usage, "MANUFACTURING");

    const runs = Transformation.listTransformationRuns(db, { tenantId: tenant, definitionId: seededDefinition.id });
    assert.ok(runs.total >= 2);
  });

  test("captures and compares frozen baselines immutably", () => {
    assert.equal(seededBaseline.status, "FROZEN");
    assert.equal(seededBaseline.line_count, 6);
    const snapshot = Baselines.baselineSnapshot(db, tenant, seededBaseline.id);
    assert.equal(snapshot.baseline.baseline_number, seededBaseline.baseline_number);
    assert.equal(snapshot.lines.length, 6);
    assert.throws(() => Baselines.deleteBaseline(db, tenant, seededBaseline.id, null, null), (err) => err.code === "BOM_BASELINE_IMMUTABLE");
  });

  test("exposes metrics and submits background jobs", () => {
    const health = Metrics.healthCheck(db, { tenantId: tenant });
    assert.ok(health);
    const snapshot = Metrics.metricsSnapshot(db, { tenantId: tenant });
    assert.ok(snapshot.totals.boms >= 1);

    const job = Jobs.submitRollupJob(db, { tenantId: tenant, revisionId: seededRevision.id });
    assert.ok(job && (job.job_ref || job.id));

    const bulk = Jobs.bulkValidate(db, tenant, { revisionIds: [seededRevision.id] });
    assert.equal(bulk.requested, 1);
    assert.equal(bulk.passed, 1);
  });
});
