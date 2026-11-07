process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase } from "../db.js";
import {
  Definitions,
  Revisions,
  Lines,
  Structure,
  Substitutes,
  WhereUsed,
  Rollup,
  Compare,
  Transformation,
  Validator,
  Baselines,
  Metrics,
  History,
  Configuration,
  Seed,
  ensureBomFoundation,
} from "../services/bom/index.js";

describe("async BOM read twins mirror the synchronous service", () => {
  let db;
  const tenant = 1;
  let seededBom;
  let seededRevision;
  let seededBaseline;
  let seededDefinition;

  before(() => {
    db = openTestDatabase();
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

  test("definition reads match", async () => {
    assert.deepEqual(await Definitions.listBomsAsync(db, { tenantId: tenant }), Definitions.listBoms(db, { tenantId: tenant }));
    assert.deepEqual(await Definitions.getBomAsync(db, tenant, "DEMO-EBOM-PUMP"), seededBom);
    assert.deepEqual(
      await Definitions.listBomAuditAsync(db, { tenantId: tenant, entityRef: seededBom.bom_ref }),
      Definitions.listBomAudit(db, { tenantId: tenant, entityRef: seededBom.bom_ref })
    );
  });

  test("revision reads match", async () => {
    assert.deepEqual(
      await Revisions.listRevisionsAsync(db, { tenantId: tenant, bomId: seededBom.id }),
      Revisions.listRevisions(db, { tenantId: tenant, bomId: seededBom.id })
    );
    assert.deepEqual(await Revisions.getRevisionAsync(db, tenant, seededRevision.revision_ref), Revisions.getRevision(db, tenant, seededRevision.revision_ref));
    const row = await Revisions.requireRevisionRowAsync(db, tenant, seededRevision.revision_ref);
    assert.equal(Number(row.id), Number(seededRevision.id));
  });

  test("line reads match", async () => {
    const sync = Lines.listLines(db, { tenantId: tenant, revisionId: seededRevision.id });
    const asyn = await Lines.listLinesAsync(db, { tenantId: tenant, revisionId: seededRevision.id });
    assert.deepEqual(asyn, sync);
    const first = sync.items[0];
    assert.deepEqual(await Lines.getLineAsync(db, tenant, first.line_ref), Lines.getLine(db, tenant, first.line_ref));
    assert.deepEqual(
      await Lines.listLineAttributesAsync(db, tenant, first.line_ref),
      Lines.listLineAttributes(db, tenant, first.line_ref)
    );
  });

  test("structure and rollup reads match", async () => {
    assert.deepEqual(
      await Structure.buildTreeAsync(db, tenant, seededRevision.id, { includeInactive: true }),
      Structure.buildTree(db, tenant, seededRevision.id, { includeInactive: true })
    );
    assert.deepEqual(
      await Structure.flatStructureAsync(db, tenant, seededRevision.id, { includeInactive: true }),
      Structure.flatStructure(db, tenant, seededRevision.id, { includeInactive: true })
    );
    assert.deepEqual(
      await Rollup.rollupAsync(db, tenant, seededRevision.id, { includeOptional: true }),
      Rollup.rollup(db, tenant, seededRevision.id, { includeOptional: true })
    );
  });

  test("substitute reads match", async () => {
    assert.deepEqual(
      await Substitutes.listSubstitutesAsync(db, { tenantId: tenant, revisionId: seededRevision.id }),
      Substitutes.listSubstitutes(db, { tenantId: tenant, revisionId: seededRevision.id })
    );
    assert.deepEqual(
      await Substitutes.substituteSummaryAsync(db, tenant, seededRevision.id),
      Substitutes.substituteSummary(db, tenant, seededRevision.id)
    );
  });

  test("where-used reads match", async () => {
    const child = "DEMO-SEAL-004";
    assert.deepEqual(
      await WhereUsed.whereUsedAsync(db, { tenantId: tenant, objectId: child }),
      WhereUsed.whereUsed(db, { tenantId: tenant, objectId: child })
    );
    assert.deepEqual(
      await WhereUsed.multiLevelWhereUsedAsync(db, tenant, child, { maxDepth: 5 }),
      WhereUsed.multiLevelWhereUsed(db, tenant, child, { maxDepth: 5 })
    );
    assert.deepEqual(
      await WhereUsed.componentUsageSummaryAsync(db, tenant, child, {}),
      WhereUsed.componentUsageSummary(db, tenant, child, {})
    );
    assert.deepEqual(
      await WhereUsed.usesAsync(db, { tenantId: tenant, revisionId: seededRevision.id }),
      WhereUsed.uses(db, { tenantId: tenant, revisionId: seededRevision.id })
    );
  });

  test("comparison reads match after a sync comparison", async () => {
    Compare.compare(db, tenant, { left_kind: "REVISION", left_id: seededRevision.id, right_kind: "BASELINE", right_id: seededBaseline.id });
    assert.deepEqual(await Compare.listComparisonsAsync(db, { tenantId: tenant }), Compare.listComparisons(db, { tenantId: tenant }));
    const latest = Compare.listComparisons(db, { tenantId: tenant }).items[0];
    assert.deepEqual(await Compare.getComparisonAsync(db, tenant, latest.comparison_ref), Compare.getComparison(db, tenant, latest.comparison_ref));
    assert.deepEqual(
      await Compare.listComparisonResultsAsync(db, tenant, latest.id, {}),
      Compare.listComparisonResults(db, tenant, latest.id, {})
    );
  });

  test("transformation reads match", async () => {
    assert.deepEqual(
      await Transformation.listTransformationDefinitionsAsync(db, { tenantId: tenant }),
      Transformation.listTransformationDefinitions(db, { tenantId: tenant })
    );
    assert.deepEqual(
      await Transformation.getTransformationDefinitionAsync(db, tenant, seededDefinition.definition_ref),
      Transformation.getTransformationDefinition(db, tenant, seededDefinition.definition_ref)
    );
    assert.deepEqual(
      await Transformation.listTransformationRunsAsync(db, { tenantId: tenant }),
      Transformation.listTransformationRuns(db, { tenantId: tenant })
    );
  });

  test("validation reads match after a sync run", async () => {
    const run = Validator.validateRevision(db, tenant, seededRevision.id, { scope: "REVISION" });
    assert.deepEqual(
      await Validator.listValidationRulesAsync(db, { tenantId: tenant }),
      Validator.listValidationRules(db, { tenantId: tenant })
    );
    assert.deepEqual(
      await Validator.listValidationResultsAsync(db, { tenantId: tenant }),
      Validator.listValidationResults(db, { tenantId: tenant })
    );
    assert.deepEqual(await Validator.getValidationResultAsync(db, tenant, run.id), Validator.getValidationResult(db, tenant, run.id));
    assert.deepEqual(
      await Validator.listValidationIssuesAsync(db, tenant, run.id, {}),
      Validator.listValidationIssues(db, tenant, run.id, {})
    );
  });

  test("baseline reads match", async () => {
    assert.deepEqual(
      await Baselines.listBaselinesAsync(db, { tenantId: tenant, bomId: seededBom.id }),
      Baselines.listBaselines(db, { tenantId: tenant, bomId: seededBom.id })
    );
    assert.deepEqual(await Baselines.getBaselineAsync(db, tenant, seededBaseline.baseline_ref), seededBaseline);
    assert.deepEqual(
      await Baselines.listBaselineLinesAsync(db, tenant, seededBaseline.baseline_ref, {}),
      Baselines.listBaselineLines(db, tenant, seededBaseline.baseline_ref, {})
    );
    assert.deepEqual(
      await Baselines.baselineSnapshotAsync(db, tenant, seededBaseline.baseline_ref),
      Baselines.baselineSnapshot(db, tenant, seededBaseline.baseline_ref)
    );
  });

  test("metrics, configuration and history reads match", async () => {
    const syncMetrics = Metrics.metricsSnapshot(db, { tenantId: tenant });
    const asyncMetrics = await Metrics.metricsSnapshotAsync(db, { tenantId: tenant });
    assert.deepEqual(asyncMetrics.totals, syncMetrics.totals);
    assert.deepEqual(asyncMetrics.quality, syncMetrics.quality);
    assert.equal((await Metrics.healthCheckAsync(db, { tenantId: tenant })).status, Metrics.healthCheck(db, { tenantId: tenant }).status);
    assert.deepEqual(
      await Metrics.compareSummaryAsync(db, { tenantId: tenant }),
      Metrics.compareSummary(db, { tenantId: tenant })
    );
    assert.deepEqual(await Configuration.listConfigAsync(db, tenant), Configuration.listConfig(db, tenant));
    assert.deepEqual(
      await History.listHistoryAsync(db, { tenantId: tenant }),
      History.listHistory(db, { tenantId: tenant })
    );
    assert.deepEqual(
      await History.objectLineageAsync(db, tenant, "BOM", seededBom.bom_ref),
      History.objectLineage(db, tenant, "BOM", seededBom.bom_ref)
    );
  });
});

describe("async BOM write twins mirror the synchronous service", () => {
  let db;
  const tenant = 1;
  let seededRevision;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('helix', 'Helix', 'organization')").run();
    db.prepare("UPDATE organizations SET tenant_id = id WHERE code = 'helix'").run();
    ensureBomFoundation(db);
    Configuration.ensureBomConfig(db, tenant);
    const result = Seed.seedBom(db, tenant);
    assert.equal(result.seeded, true);
    const seededBom = Definitions.getBom(db, tenant, "DEMO-EBOM-PUMP");
    seededRevision = Revisions.listRevisions(db, { tenantId: tenant, bomId: seededBom.id }).items[0];
  });

  after(() => {
    db?.close();
  });

  test("header writes create, update, transition and delete", async () => {
    const created = await Definitions.createBomAsync(db, tenant, { bom_number: "ASYNC-BOM-1", name: "Async one", bom_type: "EBOM" });
    assert.equal(created.bom_number, "ASYNC-BOM-1");
    assert.equal(Definitions.getBom(db, tenant, "ASYNC-BOM-1").name, "Async one");
    const updated = await Definitions.updateBomAsync(db, tenant, created.id, { name: "Async one v2" });
    assert.equal(updated.name, "Async one v2");
    const transitioned = await Definitions.setBomStatusAsync(db, tenant, created.id, "IN_REVIEW");
    assert.equal(transitioned.status, "IN_REVIEW");
    const removed = await Definitions.deleteBomAsync(db, tenant, created.id);
    assert.equal(removed.deleted, true);
    assert.equal(Definitions.listBoms(db, { tenantId: tenant, q: "ASYNC-BOM-1" }).total, 0);
  });

  test("revision, line and substitute writes round-trip", async () => {
    const bom = await Definitions.createBomAsync(db, tenant, { bom_number: "ASYNC-BOM-2", name: "Async two", bom_type: "EBOM" });
    const revision = await Revisions.createRevisionAsync(db, tenant, bom.id, { revision_number: "A1" });
    assert.equal(revision.revision_number, "A1");

    const line = await Lines.addLineAsync(db, tenant, revision.id, { child_object_id: "DEMO-HOUSING-001", child_object_type: "part", quantity: 2, uom: "EA", find_number: "10" });
    assert.equal(line.child_object_id, "DEMO-HOUSING-001");
    assert.equal(Lines.listLines(db, { tenantId: tenant, revisionId: revision.id }).total, 1);
    const edited = await Lines.updateLineAsync(db, tenant, revision.id, line.id, { quantity: 3 });
    assert.equal(Number(edited.quantity), 3);
    await Lines.setLineAttributesAsync(db, tenant, line.id, [{ code: "COLOR", value: "RED" }]);
    assert.equal(Lines.listLineAttributes(db, tenant, line.id).length, 1);
    await Lines.reorderLinesAsync(db, tenant, revision.id, { lines: [{ id: line.id, sequence: 50 }] });
    assert.equal(Number(Lines.getLine(db, tenant, line.id).sequence), 50);

    const substitute = await Substitutes.addSubstituteAsync(db, tenant, revision.id, { substitute_object_id: "DEMO-SEAL-ALT", substitute_group: "SEAL" });
    assert.ok(substitute.id);
    const updatedSub = await Substitutes.updateSubstituteAsync(db, tenant, substitute.id, { priority: 2 });
    assert.equal(Number(updatedSub.priority), 2);

    const revised = await Revisions.reviseRevisionAsync(db, tenant, revision.id, { revision_number: "A2" });
    assert.equal(revised.copied.lines, 1);
    assert.equal(revised.copied.substitutes, 1);

    await Revisions.updateRevisionAsync(db, tenant, revision.id, { configuration_context: "ASYNC-CTX" });
    assert.equal(Revisions.getRevision(db, tenant, revision.id).configuration_context, "ASYNC-CTX");
    const inReview = await Revisions.setRevisionStatusAsync(db, tenant, revision.id, "IN_REVIEW");
    assert.equal(inReview.status, "IN_REVIEW");

    await Substitutes.removeSubstituteAsync(db, tenant, substitute.id);
    await Lines.removeLineAsync(db, tenant, revision.id, line.id);
    assert.equal(Lines.listLines(db, { tenantId: tenant, revisionId: revision.id }).total, 0);

    assert.equal((await Revisions.deleteRevisionAsync(db, tenant, revised.revision.id)).deleted, true);
    assert.equal((await Revisions.deleteRevisionAsync(db, tenant, revision.id)).deleted, true);
    assert.equal((await Definitions.deleteBomAsync(db, tenant, bom.id)).deleted, true);
  });

  test("baseline and comparison writes round-trip", async () => {
    const bom = await Definitions.createBomAsync(db, tenant, { bom_number: "ASYNC-BOM-3", name: "Async three", bom_type: "EBOM" });
    const revision = await Revisions.createRevisionAsync(db, tenant, bom.id, { revision_number: "A1" });
    await Lines.addLineAsync(db, tenant, revision.id, { child_object_id: "DEMO-BEARING-005", child_object_type: "part", quantity: 2, uom: "EA", find_number: "10" });

    const baseline = await Baselines.createBaselineAsync(db, tenant, { bom_id: bom.id, revision_id: revision.id, baseline_number: "ASYNC-BL-1" });
    assert.equal(baseline.status, "DRAFT");
    const frozen = await Baselines.freezeBaselineAsync(db, tenant, baseline.id);
    assert.equal(frozen.status, "FROZEN");

    const compared = await Compare.compareAsync(db, tenant, { left_kind: "REVISION", left_id: revision.id, right_kind: "BASELINE", right_id: baseline.id });
    assert.equal(compared.comparison.status, "COMPLETED");
    assert.equal(compared.results.length, 1);

    const draft = await Baselines.createBaselineAsync(db, tenant, { bom_id: bom.id, revision_id: revision.id, baseline_number: "ASYNC-BL-2" });
    assert.equal((await Baselines.deleteBaselineAsync(db, tenant, draft.id)).deleted, true);
    await assert.rejects(() => Baselines.deleteBaselineAsync(db, tenant, baseline.id), /frozen|immutable/i);
  });

  test("transformation writes round-trip", async () => {
    const definition = await Transformation.createTransformationDefinitionAsync(db, tenant, {
      code: "ASYNC-TRANS-1",
      name: "Async transformation",
      status: "ACTIVE",
      config: { usage_map: { DESIGN: "MANUFACTURING" } },
    });
    const mapping = await Transformation.createMappingAsync(db, tenant, definition.id, { mapping_type: "LINE", source_path: "DESIGN", target_path: "usage" });
    assert.ok(mapping.id);
    assert.equal(Transformation.getTransformationDefinition(db, tenant, definition.definition_ref).mappings.length, 1);

    const run = await Transformation.transformAsync(db, tenant, { definition_id: definition.id, source_revision_id: seededRevision.id, mode: "DRY_RUN" });
    assert.equal(run.summary.mode, "DRY_RUN");
    assert.ok(run.preview.length > 0);

    await Transformation.updateMappingAsync(db, tenant, definition.id, mapping.id, { sequence: 99 });
    assert.equal((await Transformation.deleteMappingAsync(db, tenant, definition.id, mapping.id)).deleted, true);
    const updated = await Transformation.updateTransformationDefinitionAsync(db, tenant, definition.id, { name: "Async transformation v2" });
    assert.equal(updated.name, "Async transformation v2");
    assert.equal((await Transformation.deleteTransformationDefinitionAsync(db, tenant, definition.id)).deleted, true);
  });

  test("validation writes round-trip", async () => {
    const rule = await Validator.createValidationRuleAsync(db, tenant, { code: "ASYNC-RULE-1", rule_type: "MISSING_UOM", severity: "ERROR" });
    assert.equal(rule.code, "ASYNC-RULE-1");
    const result = await Validator.validateRevisionAsync(db, tenant, seededRevision.id, { scope: "REVISION" });
    assert.ok(["PASS", "WARNING", "ERROR"].includes(result.status));
    const updated = await Validator.updateValidationRuleAsync(db, tenant, rule.id, { severity: "WARNING" });
    assert.equal(updated.severity, "WARNING");
    assert.equal((await Validator.deleteValidationRuleAsync(db, tenant, rule.id)).deleted, true);
  });

  test("structure cycle guard rejects a self-referencing line", async () => {
    const bom = await Definitions.createBomAsync(db, tenant, { bom_number: "ASYNC-BOM-4", name: "Async four", bom_type: "EBOM" });
    const revision = await Revisions.createRevisionAsync(db, tenant, bom.id, { revision_number: "A1" });
    await assert.rejects(
      () => Lines.addLineAsync(db, tenant, revision.id, { child_object_id: "DEMO-HOUSING-001", parent_object_id: "DEMO-HOUSING-001", child_object_type: "part", quantity: 1, uom: "EA" }),
      /circular|cycle/i
    );
  });
});
