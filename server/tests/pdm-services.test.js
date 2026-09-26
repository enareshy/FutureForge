process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate } from "../db.js";
import {
  Items,
  Revisions,
  Datasets,
  Representations,
  DesignData,
  Cad,
  RevisionRules,
  ConfigurationRules,
  Baselines,
  Relationships,
  References,
  WhereUsed,
  WhereReferenced,
  Structure,
  Validator,
  Configuration,
  History,
  Metrics,
  Seed,
  ensurePdmFoundation,
} from "../services/pdm/index.js";

describe("PDM domain analytical services", () => {
  let db;
  const tenant = 1;
  let product;
  let productRevision;
  let baseline;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('pdm-org', 'PDM Org', 'organization')").run();
    db.prepare("UPDATE organizations SET tenant_id = id WHERE code = 'pdm-org'").run();
    ensurePdmFoundation(db);
    Configuration.ensurePdmConfig(db, tenant);
    const result = Seed.seedPdm(db, tenant);
    assert.equal(result.seeded, true);
    product = Items.getItem(db, tenant, "DEMO-PUMP-ASSY");
    productRevision = Revisions.listRevisions(db, { tenantId: tenant, itemRef: product.item_ref }).items[0];
    baseline = Baselines.getBaseline(db, tenant, "DEMO-PUMP-BL-A");
  });

  after(() => {
    db?.close();
  });

  test("seed installs a realistic product structure", () => {
    assert.equal(Items.listItems(db, { tenantId: tenant }).total, 5);
    assert.equal(Relationships.listRelationships(db, { tenantId: tenant, relationshipType: "PRODUCT_HAS_PART" }).total, 4);
    assert.equal(Datasets.listDatasets(db, { tenantId: tenant }).total, 1);
    assert.equal(Representations.listRepresentations(db, { tenantId: tenant }).total, 1);
    assert.equal(DesignData.listDesignData(db, { tenantId: tenant }).total, 1);
    assert.equal(Cad.listCadAssociations(db, { tenantId: tenant }).total, 1);
  });

  test("resolves product structure with revision selection", () => {
    const resolved = Structure.resolveStructure(db, tenant, { itemRef: "DEMO-PUMP-ASSY", ruleCode: "DEMO-LATEST-RELEASED" });
    assert.equal(resolved.node_count, 5);
    assert.equal(resolved.edge_count, 4);
    assert.equal(resolved.root.item_number, "DEMO-PUMP-ASSY");
    const leaf = resolved.nodes.find((node) => node.item_number === "DEMO-SEAL-004");
    assert.equal(Number(leaf.quantity), 2);
    assert.equal(leaf.revision_number, "A1");
  });

  test("validates the structure graph without false cycles", () => {
    const graph = Structure.validateStructureGraph(db, tenant, product.id);
    assert.equal(graph.has_cycle, false);
    assert.equal(graph.node_count, 5);
  });

  test("where-used walks the graph and reports top level", () => {
    const used = WhereUsed.whereUsed(db, tenant, "DEMO-SEAL-004");
    assert.equal(used.immediate_parent_count, 1);
    assert.ok(used.top_level.some((entry) => entry.item_number === "DEMO-PUMP-ASSY"));
  });

  test("where-referenced rebuilds and groups the reverse index", () => {
    const rebuilt = WhereReferenced.rebuildReferences(db, tenant);
    assert.ok(rebuilt.relationships >= 4);
    const references = References.listReferences(db, { tenantId: tenant, category: "RELATIONSHIP" });
    assert.ok(references.total >= 1);
    const first = references.items[0];
    const summary = WhereReferenced.referencesSummary(db, tenant, first.target_type, first.target_id);
    assert.ok(summary.total >= 1);
  });

  test("revision rule resolution selects the released revision", () => {
    const resolved = RevisionRules.resolveRevisionRule(db, tenant, { itemRef: "DEMO-PUMP-ASSY", ruleCode: "DEMO-LATEST-RELEASED" });
    assert.equal(resolved.revision.revision_number, "A1");
    assert.equal(resolved.revision.status, "RELEASED");
  });

  test("configuration rules evaluate against a context", () => {
    const result = ConfigurationRules.evaluateConfigurationRule(db, tenant, { ruleCode: "DEMO-VARIANT", context: { variant_code: "STANDARD" } });
    assert.equal(result.applicable, true);
    const notMatched = ConfigurationRules.evaluateConfigurationRule(db, tenant, { ruleCode: "DEMO-VARIANT", context: { variant_code: "OTHER" } });
    assert.equal(notMatched.applicable, false);
  });

  test("baselines snapshot released members and become immutable", () => {
    assert.equal(baseline.status, "RELEASED");
    const members = Baselines.listBaselineMembers(db, tenant, baseline.baseline_number);
    assert.ok(members.total >= 6);
    assert.throws(
      () => Baselines.addBaselineMember(db, tenant, baseline.baseline_number, { member_type: "ITEM", member_id: product.id }),
      (err) => err.code === "PDM_BASELINE_IMMUTABLE"
    );
  });

  test("validation runs are persisted and deduplicate issues", () => {
    const run = Validator.validateTenant(db, tenant, {});
    assert.ok(["PASS", "WARNING"].includes(run.status));
    assert.equal(run.error_count, 0);
    const detail = Validator.getValidationResult(db, tenant, run.id);
    const codes = new Set();
    let duplicates = 0;
    for (const issue of detail.issues) {
      const key = `${issue.rule_code}:${issue.item_id ?? issue.revision_id ?? issue.object_ref}:${issue.field}`;
      if (codes.has(key)) duplicates += 1;
      codes.add(key);
    }
    assert.equal(duplicates, 0);
  });

  test("history and metrics reflect the seeded activity", () => {
    const history = History.listHistory(db, { tenantId: tenant, pageSize: 500 });
    assert.ok(history.total > 0);
    const metrics = Metrics.metricsSnapshot(db, { tenantId: tenant });
    assert.ok(metrics.totals.items >= 5);
    assert.ok(metrics.totals.revisions >= 5);
  });
});
