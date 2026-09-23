process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import { ClassificationError } from "../services/classification/errors.js";
import * as Definitions from "../services/classification/definitions.js";
import * as Hierarchy from "../services/classification/hierarchy.js";
import * as Characteristics from "../services/classification/characteristics.js";
import * as Inheritance from "../services/classification/inheritance.js";
import * as Assignments from "../services/classification/assignments.js";
import * as ValidationService from "../services/classification/validation-service.js";
import * as Rules from "../services/classification/rules.js";
import * as Duplicates from "../services/classification/duplicates.js";
import * as Metrics from "../services/classification/metrics.js";
import * as Jobs from "../services/classification/jobs.js";
import * as Search from "../services/classification/search.js";
import * as History from "../services/classification/history.js";
import * as Seed from "../services/classification/seed.js";

function isClassificationError(error, status, code) {
  return error instanceof ClassificationError && error.status === status && error.code === code;
}

function thrownBy(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail("Expected the function to throw");
}

describe("classification services", () => {
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

  describe("definitions", () => {
    test("creates, reads, updates and lists a classification", () => {
      const code = nextCode("MECH");
      const created = Definitions.createClassification(db, tenantId, { code, name: "Mechanical", description: "d" }, actor);
      assert.equal(created.code, code);
      assert.equal(created.status, "DRAFT");
      assert.equal(created.approval_status, "PENDING");
      assert.match(created.classification_ref, /^CLA-/);

      const fetched = Definitions.getClassification(db, tenantId, code);
      assert.equal(fetched.id, created.id);

      const updated = Definitions.updateClassification(db, tenantId, created.id, { name: "Mechanical components" }, actor);
      assert.equal(updated.name, "Mechanical components");

      const list = Definitions.listClassifications(db, { tenantId, q: code });
      assert.ok(list.items.some((entry) => entry.id === created.id));

      assert.equal(thrownBy(() => Definitions.createClassification(db, tenantId, { code, name: "dup" }, actor)).status, 409);
    });

    test("transitions status, approves and versions", () => {
      const code = nextCode("STATUS");
      const created = Definitions.createClassification(db, tenantId, { code, name: "Status" }, actor);
      const active = Definitions.setClassificationStatus(db, tenantId, created.id, "ACTIVE", actor);
      assert.equal(active.status, "ACTIVE");
      const approved = Definitions.approveClassification(db, tenantId, created.id, actor);
      assert.equal(approved.approval_status, "APPROVED");

      const versioned = Definitions.createClassificationVersion(db, tenantId, created.id, { changeReason: "baseline", actor });
      assert.equal(versioned.version, 2);
      const versions = Definitions.listClassificationVersions(db, tenantId, created.id);
      assert.ok(versions.total >= 1);

      const audit = Definitions.listClassificationAudit(db, { tenantId, entityId: created.id });
      assert.ok(audit.total >= 1);
      assert.ok(audit.items.every((entry) => entry.entity_type === "CLASSIFICATION"));
    });
  });

  describe("hierarchy", () => {
    test("builds a parent/child hierarchy with materialized paths and levels", () => {
      const classification = Definitions.createClassification(db, tenantId, { code: nextCode("HIER"), name: "Hierarchy" }, actor);
      const root = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, code: "ROOT", name: "Root" }, actor);
      const child = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, parent_class_id: root.id, code: "CHILD", name: "Child" }, actor);
      const grand = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, parent_class_id: child.id, code: "GRAND", name: "Grand" }, actor);

      assert.equal(root.level, 0);
      assert.equal(root.path, "ROOT");
      assert.equal(child.level, 1);
      assert.equal(child.path, "ROOT/CHILD");
      assert.equal(grand.path, "ROOT/CHILD/GRAND");

      assert.equal(Hierarchy.classAncestors(db, tenantId, grand.id).total, 2);
      assert.equal(Hierarchy.classDescendants(db, tenantId, root.id).total, 2);
      assert.equal(Hierarchy.classChildren(db, tenantId, root.id).total, 1);

      const tree = Hierarchy.classTree(db, tenantId, classification.code);
      assert.equal(tree.total, 3);
      assert.equal(tree.nodes.length, 1);
    });

    test("rejects duplicates, cross-classification parents and cycles", () => {
      const classification = Definitions.createClassification(db, tenantId, { code: nextCode("CYC"), name: "Cycle" }, actor);
      const other = Definitions.createClassification(db, tenantId, { code: nextCode("OTH"), name: "Other" }, actor);
      const a = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, code: "CA", name: "A" }, actor);
      const b = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, parent_class_id: a.id, code: "CB", name: "B" }, actor);
      const foreign = Hierarchy.createClass(db, tenantId, { classification_id: other.id, code: "CF", name: "F" }, actor);

      assert.ok(isClassificationError(thrownBy(() => Hierarchy.createClass(db, tenantId, { classification_id: classification.id, code: "CA", name: "dup" }, actor)), 409, "CLASSIFICATION_CLASS_CONFLICT"));
      assert.equal(thrownBy(() => Hierarchy.createClass(db, tenantId, { classification_id: classification.id, parent_class_id: foreign.id, code: "CX", name: "X" }, actor)).status, 400);
      assert.ok(isClassificationError(thrownBy(() => Hierarchy.moveClass(db, tenantId, a.id, { parentClassId: b.id }, actor)), 409, "CLASSIFICATION_CLASS_CYCLE"));
    });

    test("copies a class subtree and deletes an empty class", () => {
      const classification = Definitions.createClassification(db, tenantId, { code: nextCode("COPY"), name: "Copy" }, actor);
      const root = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, code: "ROOT", name: "Root" }, actor);
      const copy = Hierarchy.copyClass(db, tenantId, root.id, { codeSuffix: "_CP" }, actor);
      assert.match(copy.code, /_CP$/);
      assert.notEqual(copy.id, root.id);

      const empty = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, code: "TMP", name: "Tmp" }, actor);
      assert.equal(Hierarchy.deleteClass(db, tenantId, empty.id, actor).deleted, true);
    });
  });

  describe("characteristics, groups and allowed values", () => {
    test("creates typed characteristics and enforces type requirements", () => {
      const enumChar = Characteristics.createCharacteristic(db, tenantId, { code: nextCode("MAT"), name: "Material", data_type: "ENUMERATION", required: true }, actor);
      assert.equal(enumChar.data_type, "ENUMERATION");
      assert.equal(enumChar.required, true);

      const unitChar = Characteristics.createCharacteristic(db, tenantId, { code: nextCode("FLOW"), name: "Flow", data_type: "UNIT_NUMERIC", unit: "L/MIN" }, actor);
      assert.equal(unitChar.base_unit, "L/MIN");

      assert.equal(thrownBy(() => Characteristics.createCharacteristic(db, tenantId, { code: nextCode("BAD"), name: "Bad", data_type: "UNIT_NUMERIC" }, actor)).status, 400);
      assert.equal(thrownBy(() => Characteristics.createCharacteristic(db, tenantId, { code: unitChar.code, name: "dup", data_type: "STRING" }, actor)).status, 409);

      const updated = Characteristics.updateCharacteristic(db, tenantId, unitChar.id, { description: "Measured flow" }, actor);
      assert.equal(updated.description, "Measured flow");
    });

    test("manages allowed values", () => {
      const characteristic = Characteristics.createCharacteristic(db, tenantId, { code: nextCode("ENUMVAL"), name: "Colour", data_type: "ENUMERATION" }, actor);
      const red = Characteristics.createAllowedValue(db, tenantId, characteristic.id, { code: "RED", display_name: "Red" }, actor);
      Characteristics.createAllowedValue(db, tenantId, characteristic.id, { code: "BLUE", display_name: "Blue" }, actor);

      const values = Characteristics.listAllowedValues(db, tenantId, characteristic.id);
      assert.equal(values.total, 2);

      const renamed = Characteristics.updateAllowedValue(db, tenantId, red.id, { display_name: "Crimson" }, actor);
      assert.equal(renamed.display_name, "Crimson");

      assert.equal(thrownBy(() => Characteristics.createAllowedValue(db, tenantId, characteristic.id, { code: "RED" }, actor)).status, 409);
      assert.equal(Characteristics.deleteAllowedValue(db, tenantId, red.id, actor).deleted, true);
    });

    test("manages characteristic groups", () => {
      const group = Characteristics.createGroup(db, tenantId, { code: nextCode("GRP"), name: "Mechanical", description: "g" }, actor);
      const characteristic = Characteristics.createCharacteristic(db, tenantId, { code: nextCode("GRPMEM"), name: "Member", data_type: "STRING" }, actor);
      Characteristics.addGroupMember(db, tenantId, group.id, characteristic.id, {}, actor);
      assert.equal(Characteristics.listGroupMembers(db, tenantId, group.id).total, 1);
      assert.equal(Characteristics.removeGroupMember(db, tenantId, group.id, characteristic.id).removed, true);
    });
  });

  describe("inheritance", () => {
    test("resolves inherited and local characteristics with origins", () => {
      const classification = Definitions.createClassification(db, tenantId, { code: nextCode("INH"), name: "Inherit" }, actor);
      const root = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, code: "ROOT", name: "Root" }, actor);
      const pump = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, parent_class_id: root.id, code: "PUMP", name: "Pump" }, actor);
      const material = Characteristics.createCharacteristic(db, tenantId, { code: nextCode("MAT"), name: "Material", data_type: "STRING" }, actor);
      const flow = Characteristics.createCharacteristic(db, tenantId, { code: nextCode("FLOW"), name: "Flow", data_type: "DECIMAL" }, actor);

      Characteristics.addClassCharacteristic(db, tenantId, root.id, { characteristic_id: material.id, required: true }, actor);
      Characteristics.addClassCharacteristic(db, tenantId, pump.id, { characteristic_id: flow.id, required: true }, actor);

      const resolved = Inheritance.resolveEffectiveCharacteristics(db, tenantId, pump.id);
      assert.equal(resolved.total, 2);
      const inherited = resolved.items.find((entry) => entry.code === material.code);
      const local = resolved.items.find((entry) => entry.code === flow.code);
      assert.equal(inherited.origin, "INHERITED");
      assert.equal(inherited.source_class_code, "ROOT");
      assert.equal(local.origin, "LOCAL");
      assert.equal(local.required, true);
      assert.equal(resolved.chain.length, 2);
    });

    test("local definitions override inherited ones", () => {
      const classification = Definitions.createClassification(db, tenantId, { code: nextCode("OVR"), name: "Override" }, actor);
      const root = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, code: "ROOT", name: "Root" }, actor);
      const leaf = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, parent_class_id: root.id, code: "LEAF", name: "Leaf" }, actor);
      const material = Characteristics.createCharacteristic(db, tenantId, { code: nextCode("MAT"), name: "Material", data_type: "STRING" }, actor);

      Characteristics.addClassCharacteristic(db, tenantId, root.id, { characteristic_id: material.id, required: true, sequence: 0 }, actor);
      Characteristics.addClassCharacteristic(db, tenantId, leaf.id, { characteristic_id: material.id, required: false, sequence: 1 }, actor);

      const resolved = Inheritance.resolveEffectiveCharacteristics(db, tenantId, leaf.id);
      const entry = resolved.items.find((item) => item.code === material.code);
      assert.equal(entry.origin, "OVERRIDDEN");
      assert.equal(entry.required, false);
      assert.equal(resolved.overridden_count, 1);
    });
  });

  describe("assignments and validation", () => {
    let classification;
    let root;
    let pump;
    let material;
    let flow;

    before(() => {
      classification = Definitions.createClassification(db, tenantId, { code: nextCode("ASN"), name: "Assignment" }, actor);
      root = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, code: "ROOT", name: "Root" }, actor);
      pump = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, parent_class_id: root.id, code: "PUMP", name: "Pump" }, actor);
      material = Characteristics.createCharacteristic(db, tenantId, { code: nextCode("MAT"), name: "Material", data_type: "ENUMERATION" }, actor);
      flow = Characteristics.createCharacteristic(db, tenantId, { code: nextCode("FLOW"), name: "Flow", data_type: "UNIT_NUMERIC", unit: "L/MIN", base_unit: "L/MIN" }, actor);
      Characteristics.createAllowedValue(db, tenantId, material.id, { code: "SS" }, actor);
      Characteristics.createAllowedValue(db, tenantId, material.id, { code: "CS" }, actor);
      Characteristics.addClassCharacteristic(db, tenantId, root.id, { characteristic_id: material.id, required: true }, actor);
      Characteristics.addClassCharacteristic(db, tenantId, pump.id, { characteristic_id: flow.id, required: true }, actor);
      Definitions.setClassificationStatus(db, tenantId, classification.id, "ACTIVE", actor);
      Hierarchy.setClassStatus(db, tenantId, root.id, "ACTIVE", actor);
      Hierarchy.setClassStatus(db, tenantId, pump.id, "ACTIVE", actor);
    });

    test("validates required, enum and unit constraints", () => {
      const valid = ValidationService.validateClassValues(db, tenantId, pump.id, { [material.code]: "SS", [flow.code]: { value: 10, unit: "L/MIN" } });
      assert.equal(valid.valid, true);

      const missing = ValidationService.validateClassValues(db, tenantId, pump.id, { [flow.code]: 10 });
      assert.equal(missing.valid, false);
      assert.ok(missing.missing_required.some((entry) => entry.characteristic_code === material.code));

      const badEnum = ValidationService.validateClassValues(db, tenantId, pump.id, { [material.code]: "GOLD", [flow.code]: 10 });
      assert.equal(badEnum.valid, false);

      const partial = ValidationService.validateClassValues(db, tenantId, pump.id, { [flow.code]: 10 }, { partial: true });
      assert.equal(partial.valid, true);
    });

    test("assigns, updates, validates and unassigns an object", () => {
      const result = Assignments.assignClass(db, tenantId, {
        object_type: "part",
        object_id: "SVC-PART-001",
        class_id: pump.id,
        values: { [material.code]: "SS", [flow.code]: { value: 12.5, unit: "L/MIN" } },
      }, actor);
      assert.equal(result.created, true);
      assert.equal(result.values.length, 2);

      assert.equal(thrownBy(() => Assignments.assignClass(db, tenantId, { object_type: "part", object_id: "SVC-PART-001", class_id: pump.id }, actor)).status, 409);

      const validation = Assignments.validateAssignment(db, tenantId, result.assignment.id);
      assert.equal(validation.validation.valid, true);

      const updated = Assignments.setAssignmentValues(db, tenantId, result.assignment.id, { values: { [material.code]: "CS", [flow.code]: { value: 9, unit: "L/MIN" } } }, actor);
      assert.equal(updated.assignment.version >= 2, true);

      const resolved = Assignments.resolveObjectValues(db, tenantId, "part", "SVC-PART-001");
      assert.ok(resolved);

      const classifications = Assignments.objectClassifications(db, tenantId, "part", "SVC-PART-001");
      assert.ok(classifications);

      const inactive = Assignments.setAssignmentStatus(db, tenantId, result.assignment.id, "INACTIVE", actor);
      assert.equal(inactive.status, "INACTIVE");

      assert.equal(Assignments.unassign(db, tenantId, result.assignment.id, actor).deleted, true);
    });

    test("rejects invalid values at assignment time", () => {
      const error = thrownBy(() => Assignments.assignClass(db, tenantId, {
        object_type: "part",
        object_id: "SVC-PART-BAD",
        class_id: pump.id,
        values: { [material.code]: "GOLD", [flow.code]: 5 },
      }, actor));
      assert.equal(error.status, 422);
    });
  });

  describe("rules", () => {
    test("creates rules and applies them during validation", () => {
      const classification = Definitions.createClassification(db, tenantId, { code: nextCode("RULE"), name: "Rules" }, actor);
      const klass = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, code: "CLS", name: "Class" }, actor);
      const pressure = Characteristics.createCharacteristic(db, tenantId, { code: nextCode("PRESS"), name: "Pressure", data_type: "DECIMAL", unit: "BAR" }, actor);

      Characteristics.addClassCharacteristic(db, tenantId, klass.id, { characteristic_id: pressure.id }, actor);
      const rule = Rules.createRule(db, tenantId, { class_id: klass.id, characteristic_id: pressure.id, rule_type: "RANGE", config: { min: 1, max: 100 }, severity: "ERROR", message: "out of range" }, actor);
      assert.equal(rule.rule_type, "RANGE");

      const inRange = ValidationService.validateClassValues(db, tenantId, klass.id, { [pressure.code]: 50 });
      assert.equal(inRange.valid, true);

      const outOfRange = ValidationService.validateClassValues(db, tenantId, klass.id, { [pressure.code]: 500 });
      assert.equal(outOfRange.valid, false);
      assert.ok(outOfRange.errors.some((entry) => entry.rule_type === "RANGE"));

      assert.equal(Rules.listRules(db, tenantId, { classId: klass.id }).total, 1);
      const updated = Rules.updateRule(db, tenantId, rule.id, { config: { min: 1, max: 1000 } }, actor);
      assert.equal(updated.config.max, 1000);
      assert.equal(Rules.deleteRule(db, tenantId, rule.id, actor).deleted, true);
    });

    test("REQUIRED rules fire when a value is absent", () => {
      const classification = Definitions.createClassification(db, tenantId, { code: nextCode("RULEREQ"), name: "Required rule" }, actor);
      const klass = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, code: "CLS", name: "Class" }, actor);
      const note = Characteristics.createCharacteristic(db, tenantId, { code: nextCode("NOTE"), name: "Note", data_type: "STRING" }, actor);
      Characteristics.addClassCharacteristic(db, tenantId, klass.id, { characteristic_id: note.id }, actor);
      Rules.createRule(db, tenantId, { class_id: klass.id, characteristic_id: note.id, rule_type: "REQUIRED", severity: "WARNING" }, actor);
      const result = ValidationService.validateClassValues(db, tenantId, klass.id, {});
      assert.ok(result.warnings.some((entry) => entry.code === "RULE_REQUIRED"));
      assert.equal(result.valid, true);
    });
  });

  describe("duplicates", () => {
    test("builds signatures and detects exact duplicate objects", () => {
      const classification = Definitions.createClassification(db, tenantId, { code: nextCode("DUP"), name: "Duplicates" }, actor);
      const klass = Hierarchy.createClass(db, tenantId, { classification_id: classification.id, code: "CLS", name: "Class" }, actor);
      const material = Characteristics.createCharacteristic(db, tenantId, { code: nextCode("MAT"), name: "Material", data_type: "ENUMERATION" }, actor);
      Characteristics.createAllowedValue(db, tenantId, material.id, { code: "SS" }, actor);
      Characteristics.addClassCharacteristic(db, tenantId, klass.id, { characteristic_id: material.id }, actor);
      Definitions.setClassificationStatus(db, tenantId, classification.id, "ACTIVE", actor);
      Hierarchy.setClassStatus(db, tenantId, klass.id, "ACTIVE", actor);

      for (const objectId of ["DUP-A", "DUP-B"]) {
        Assignments.assignClass(db, tenantId, { object_type: "part", object_id: objectId, class_id: klass.id, values: { [material.code]: "SS" } }, actor);
      }

      const assignments = Assignments.listAssignments(db, { tenantId, classId: klass.id });
      const signature = Duplicates.classificationSignature(db, tenantId, queryOne(db, "SELECT * FROM cla_assignments WHERE id = ?", [assignments.items[0].id]));
      assert.match(signature, new RegExp(material.code));

      const scan = Duplicates.detectClassificationDuplicates(db, { tenantId, classRef: klass.id });
      assert.equal(scan.detected >= 1, true);
      assert.ok(scan.candidates.some((entry) => entry.match_type === "EXACT"));

      const summary = Duplicates.duplicateSummary(db, { tenantId });
      assert.equal(typeof summary.groups, "number");
    });
  });

  describe("metrics, search, history and jobs", () => {
    test("metrics and coverage report classification adoption", () => {
      const snapshot = Metrics.metricsSnapshot(db, { tenantId });
      assert.ok(snapshot.totals.classifications >= 1);
      assert.ok(snapshot.totals.classes >= 1);
      const coverage = Metrics.coverageReport(db, { tenantId, objectType: "part", totalObjects: 10 });
      assert.equal(typeof coverage.classified_objects, "number");
      const health = Metrics.healthCheck(db, { tenantId });
      assert.ok(["healthy", "degraded"].includes(health.status));
    });

    test("registers search sources and object types", () => {
      const result = Search.ensureClassificationSearch(db);
      assert.equal(typeof result.created, "number");
      assert.ok(Search.SEARCH_REGISTRATIONS.length >= 3);
    });

    test("records history and reconstructs object lineage", () => {
      const classification = Definitions.createClassification(db, tenantId, { code: nextCode("HIST"), name: "History" }, actor);
      const history = History.listHistory(db, { tenantId, entityId: classification.id });
      assert.ok(history.total >= 1);
      const lineage = History.objectLineage(db, tenantId, "part", "SVC-PART-001");
      assert.ok(lineage);
    });

    test("installs job types, registers handlers and runs bulk jobs", () => {
      const types = Jobs.ensureClassificationJobTypes(db);
      assert.equal(typeof types.created, "number");
      assert.ok(Jobs.registerClassificationHandlers().length >= 4);
      const maintenance = Jobs.runMaintenance(db, { tenantId });
      assert.equal(maintenance.tenants, 1);
    });
  });

  describe("seed", () => {
    test("installs the demonstration classification idempotently", () => {
      const first = Seed.seedClassification(db, tenantId);
      assert.equal(first.seeded, true);
      assert.ok(queryOne(db, "SELECT id FROM cla_classifications WHERE tenant_id = ? AND code = 'MECH_COMPONENTS'", [tenantId]));
      assert.ok(queryOne(db, "SELECT id FROM cla_assignments WHERE tenant_id = ? AND object_id = 'DEMO-PUMP-001'", [tenantId]));

      const second = Seed.ensureClassificationSeed(db, tenantId);
      assert.equal(second.seeded, false);
      assert.equal(second.reason, "already_present");
    });
  });
});
