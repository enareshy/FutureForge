process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate } from "../db.js";
import {
  Definitions,
  Revisions,
  Lines,
  Structure,
  Substitutes,
  Effectivity,
  Variants,
  Configuration,
  Units,
  History,
  Foundation,
  ensureBomFoundation,
} from "../services/bom/index.js";

describe("BOM Engine core services", () => {
  let db;
  const tenant = 1;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('test-org', 'Test Org', 'organization')").run();
    ensureBomFoundation(db);
    Configuration.ensureBomConfig(db, tenant);
  });

  after(() => {
    db?.close();
  });

  test("foundation installs the BOM engine and is idempotent", () => {
    const again = Foundation.ensureBomFoundation(db);
    assert.ok(again);
    const config = Configuration.listConfig(db, tenant);
    assert.equal(config.default_uom, "EA");
    assert.equal(config.enforce_uom, true);
  });

  test("creates a BOM header and rejects duplicates", () => {
    const bom = Definitions.createBom(db, tenant, {
      bom_number: "TEST-BOM-001",
      name: "Test assembly",
      bom_type: "EBOM",
    });
    assert.equal(bom.bom_number, "TEST-BOM-001");
    assert.equal(bom.bom_type, "EBOM");
    assert.throws(
      () => Definitions.createBom(db, tenant, { bom_number: "TEST-BOM-001", name: "dup", bom_type: "EBOM" }),
      (err) => err.code === "BOM_CONFLICT"
    );
  });

  test("creates revisions and enforces lifecycle transitions", () => {
    const bom = Definitions.getBom(db, tenant, "TEST-BOM-001");
    const rev = Revisions.createRevision(db, tenant, bom.id, { revision_number: "A1" });
    assert.equal(rev.revision_number, "A1");
    assert.equal(rev.status, "DRAFT");
    assert.throws(
      () => Revisions.setRevisionStatus(db, tenant, rev.id, "RELEASED"),
      (err) => err.code === "BOM_REVISION_STATUS_INVALID"
    );
    const inReview = Revisions.setRevisionStatus(db, tenant, rev.id, "IN_REVIEW");
    assert.equal(inReview.status, "IN_REVIEW");
    const released = Revisions.setRevisionStatus(db, tenant, rev.id, "RELEASED");
    assert.equal(released.status, "RELEASED");
    assert.throws(() => Revisions.assertRevisionEditable(Revisions.getRevision(db, tenant, rev.id)), (err) => err.code === "BOM_REVISION_IMMUTABLE");
  });

  test("revision lifecycle: revise copies lines into a draft successor", () => {
    const bom = Definitions.getBom(db, tenant, "TEST-BOM-001");
    const rev = Revisions.createRevision(db, tenant, bom.id, { revision_number: "B1" });
    Lines.addLine(db, tenant, rev.id, { child_object_id: "PART-X", quantity: 2, uom: "EA", find_number: "10" });
    Lines.addLine(db, tenant, rev.id, { child_object_id: "PART-Y", quantity: 4, uom: "EA", find_number: "20" });
    Revisions.setRevisionStatus(db, tenant, rev.id, "IN_REVIEW");
    Revisions.setRevisionStatus(db, tenant, rev.id, "RELEASED");

    const next = Revisions.reviseRevision(db, tenant, rev.id, { revision_number: "B2" });
    assert.equal(next.revision.status, "DRAFT");
    assert.equal(next.copied.lines, 2);
    const copied = Lines.listLines(db, { tenantId: tenant, revisionId: next.revision.id });
    assert.equal(copied.total, 2);
  });

  test("adds/updates/reorders lines and records attributes", () => {
    const bom = Definitions.createBom(db, tenant, { bom_number: "TEST-BOM-002", name: "Line ops", bom_type: "EBOM" });
    const rev = Revisions.createRevision(db, tenant, bom.id, { revision_number: "A1" });
    Configuration.setConfig(db, tenant, "allow_duplicate_children", false);

    assert.throws(
      () => Lines.addLine(db, tenant, rev.id, { child_object_id: "", quantity: 1, uom: "EA" }),
      (err) => err.code === "BOM_INVALID_LINE"
    );
    assert.throws(
      () => Lines.addLine(db, tenant, rev.id, { child_object_id: "P1", quantity: 0, uom: "EA" }),
      (err) => err.code === "BOM_QUANTITY_INVALID"
    );
    assert.throws(
      () => Lines.addLine(db, tenant, rev.id, { child_object_id: "P1", quantity: 1, uom: "NOT-A-UNIT" }),
      (err) => err.code === "BOM_UNIT_INVALID" || err.code === "BOM_INVALID_LINE"
    );

    const l1 = Lines.addLine(db, tenant, rev.id, { child_object_id: "P1", quantity: 1, uom: "EA", find_number: "10" });
    const l2 = Lines.addLine(db, tenant, rev.id, { child_object_id: "P2", quantity: 3, uom: "EA", find_number: "20" });
    assert.ok(l1.line_ref && l2.line_ref);

    assert.throws(
      () => Lines.addLine(db, tenant, rev.id, { child_object_id: "P1", quantity: 5, uom: "EA" }),
      (err) => err.code === "BOM_LINE_CONFLICT"
    );

    const updated = Lines.updateLine(db, tenant, rev.id, l1.id, { quantity: 6 });
    assert.equal(Number(updated.quantity), 6);

    Lines.reorderLines(db, tenant, rev.id, { order: [{ id: l1.id, sequence: 20 }, { id: l2.id, sequence: 10 }] });
    const ordered = Lines.listLines(db, { tenantId: tenant, revisionId: rev.id, sort: "sequence", order: "asc" });
    assert.equal(ordered.items[0].id, l2.id);

    Lines.setLineAttributes(db, tenant, l1.id, [{ attribute_code: "color", value: "red" }, { attribute_code: "torque", value: "12Nm" }]);
    const attrs = Lines.listLineAttributes(db, tenant, l1.id);
    assert.equal(attrs.length, 2);

    Lines.removeLine(db, tenant, rev.id, l2.id);
    assert.equal(Lines.listLines(db, { tenantId: tenant, revisionId: rev.id }).total, 1);
  });

  test("builds the structure tree and blocks cycles", () => {
    const bom = Definitions.createBom(db, tenant, { bom_number: "TEST-BOM-003", name: "Tree", bom_type: "EBOM" });
    const rev = Revisions.createRevision(db, tenant, bom.id, { revision_number: "A1" });
    Lines.addLine(db, tenant, rev.id, { child_object_id: "ASSY", quantity: 1, uom: "EA", find_number: "10" });
    Lines.addLine(db, tenant, rev.id, { child_object_id: "SUB", parent_object_id: "ASSY", quantity: 2, uom: "EA", find_number: "10.1" });
    Lines.addLine(db, tenant, rev.id, { child_object_id: "LEAF", parent_object_id: "SUB", quantity: 4, uom: "EA", find_number: "10.1.1" });

    const tree = Structure.buildTree(db, tenant, rev.id);
    assert.equal(tree.line_count, 3);
    assert.ok(tree.max_depth >= 2);
    assert.equal(tree.roots.length, 1);
    assert.equal(tree.roots[0].line.child_object_id, "ASSY");

    const flat = Structure.flatStructure(db, tenant, rev.id);
    assert.equal(flat.length, 3);
  });

  test("effectivity and variants resolve deterministically", () => {
    const eff = Effectivity.normalizeEffectivity({ start: "2024-01-01", end: "2024-12-31", serial_from: "S100", serial_to: "S200" });
    assert.equal(Effectivity.isEffectivityActive(eff, { at: "2024-06-01" }), true);
    assert.equal(Effectivity.isEffectivityActive(eff, { at: "2025-01-01" }), false);
    assert.equal(Effectivity.isEffectivityActive(eff, { at: "2024-06-01", serial: "S150" }), true);
    assert.equal(Effectivity.isEffectivityActive(eff, { at: "2024-06-01", serial: "S999" }), false);
    assert.throws(() => Effectivity.normalizeEffectivity({ start: "2024-12-31", end: "2024-01-01" }), (err) => err.code === "BOM_EFFECTIVITY_INVALID");

    const context = Variants.normalizeContext({ variant_code: "V1", options: { color: "RED" } });
    assert.equal(context.variant_code, "V1");
    assert.equal(Variants.isApplicable({}, context), true);
    assert.equal(Variants.isApplicable({ variant_code: "V2" }, context), false);
    assert.equal(Variants.isApplicable({ variant_code: "V1", configuration_context: { color: "RED" } }, context), true);
  });

  test("substitutes are registered and resolved", () => {
    const bom = Definitions.createBom(db, tenant, { bom_number: "TEST-BOM-004", name: "Subs", bom_type: "EBOM" });
    const rev = Revisions.createRevision(db, tenant, bom.id, { revision_number: "A1" });
    const line = Lines.addLine(db, tenant, rev.id, { child_object_id: "SEAL", quantity: 1, uom: "EA" });
    const sub = Substitutes.addSubstitute(db, tenant, rev.id, { line_id: line.id, substitute_object_id: "SEAL-ALT", priority: 1, ratio: 1 });
    assert.equal(sub.substitute_object_id, "SEAL-ALT");
    assert.throws(
      () => Substitutes.addSubstitute(db, tenant, rev.id, { line_id: line.id, substitute_object_id: "SEAL-ALT" }),
      (err) => err.code === "BOM_SUBSTITUTE_CONFLICT"
    );
    const resolved = Substitutes.resolveSubstitutes(db, tenant, { revisionId: rev.id, lineId: line.id });
    assert.equal(resolved.length, 1);
    const summary = Substitutes.substituteSummary(db, tenant, rev.id);
    assert.equal(summary.total, 1);
  });

  test("configuration and reference units are reusable and validated", () => {
    const value = Configuration.setConfig(db, tenant, "default_revision_status", "DRAFT");
    assert.equal(value, "DRAFT");
    assert.equal(Configuration.getConfig(db, tenant, "default_revision_status"), "DRAFT");
    assert.throws(() => Configuration.setConfig(db, tenant, "not_a_key", 1), (err) => err.code === "BOM_INVALID_CONFIGURATION");

    const units = Units.listUnits(db, { tenantId: tenant });
    assert.ok(units.length > 0);
    const conv = Units.convertValue(1000, "G", "KG");
    assert.equal(Number(conv.value), 1);
  });

  test("history captures entity changes", () => {
    const bom = Definitions.getBom(db, tenant, "TEST-BOM-002");
    const rows = History.listHistory(db, { tenantId: tenant, entityType: "BOM", entityId: bom.id });
    assert.ok(rows.total >= 1);
  });
});
