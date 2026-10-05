process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import {
  Configuration,
  Definitions,
  Hierarchy,
  Characteristics,
  Inheritance,
  Assignments,
  Rules,
  ValidationService,
  Duplicates,
  Metrics,
  Jobs,
  History,
  Foundation,
} from "../services/classification/index.js";

// Async parity for the P2 Enterprise Classification module. The synchronous
// service is the reference; async read twins must return the same data and async
// write twins must mirror the same semantics.

const VOLATILE = new Set(["created_at", "updated_at", "generated_at", "assigned_at", "effective_date", "obsolete_date"]);

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (VOLATILE.has(key)) continue;
      out[key] = normalize(entry);
    }
    return out;
  }
  return value;
}

describe("async classification twins mirror the synchronous service", () => {
  let db;
  let tenant;
  let admin;
  let leaf;
  let material;
  let flow;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    Foundation.ensureClassificationFoundation(db);

    const classification = await Definitions.createClassificationAsync(db, tenant, { code: "P2_CLA", name: "Parity" }, admin);
    const root = await Hierarchy.createClassAsync(db, tenant, { classification_id: classification.id, code: "P2_ROOT", name: "Root" }, admin);
    leaf = await Hierarchy.createClassAsync(db, tenant, { classification_id: classification.id, parent_class_id: root.id, code: "P2_LEAF", name: "Leaf" }, admin);
    material = await Characteristics.createCharacteristicAsync(db, tenant, { code: "P2_MAT", name: "Material", data_type: "ENUMERATION" }, admin);
    flow = await Characteristics.createCharacteristicAsync(db, tenant, { code: "P2_FLOW", name: "Flow", data_type: "UNIT_NUMERIC", unit: "L/MIN", base_unit: "L/MIN" }, admin);
    await Characteristics.createAllowedValueAsync(db, tenant, material.id, { code: "SS" }, admin);
    await Characteristics.createAllowedValueAsync(db, tenant, material.id, { code: "CS" }, admin);
    await Characteristics.addClassCharacteristicAsync(db, tenant, root.id, { characteristic_id: material.id, required: true }, admin);
    await Characteristics.addClassCharacteristicAsync(db, tenant, leaf.id, { characteristic_id: flow.id, required: true }, admin);

    await Definitions.setClassificationStatusAsync(db, tenant, classification.id, "ACTIVE", admin);
    await Hierarchy.setClassStatusAsync(db, tenant, root.id, "ACTIVE", admin);
    await Hierarchy.setClassStatusAsync(db, tenant, leaf.id, "ACTIVE", admin);
  });

  after(() => db?.close());

  test("write twins: definition, class, characteristic, allowed value", async () => {
    const asyncDef = await Definitions.createClassificationAsync(db, tenant, { code: "P2_DEF_A", name: "Async def" }, admin);
    const syncDef = Definitions.createClassification(db, tenant, { code: "P2_DEF_S", name: "Sync def" }, admin);
    for (const field of ["status", "version", "approval_status"]) {
      assert.equal(asyncDef[field], syncDef[field], `definition field mismatch: ${field}`);
    }
    assert.equal(asyncDef.code, "P2_DEF_A");
    assert.equal(syncDef.code, "P2_DEF_S");

    const asyncChar = await Characteristics.createCharacteristicAsync(db, tenant, { code: "P2_CH_A", name: "Async char", data_type: "STRING" }, admin);
    const syncChar = Characteristics.createCharacteristic(db, tenant, { code: "P2_CH_S", name: "Sync char", data_type: "STRING" }, admin);
    for (const field of ["data_type", "status", "version", "required", "multi_valued"]) {
      assert.equal(asyncChar[field], syncChar[field], `characteristic field mismatch: ${field}`);
    }

    const asyncValue = await Characteristics.createAllowedValueAsync(db, tenant, asyncChar.id, { code: "A1" }, admin);
    assert.equal(asyncValue.code, "A1");
    const values = await Characteristics.listAllowedValuesAsync(db, tenant, asyncChar.id);
    assert.deepEqual(values, Characteristics.listAllowedValues(db, tenant, asyncChar.id));
    assert.equal(values.items.length, 1);
  });

  test("read parity: effective characteristics and validation", async () => {
    assert.deepEqual(normalize(await Inheritance.resolveEffectiveCharacteristicsAsync(db, tenant, leaf.id)), normalize(Inheritance.resolveEffectiveCharacteristics(db, tenant, leaf.id)));

    const input = { [material.code]: "SS", [flow.code]: { value: 10, unit: "L/MIN" } };
    assert.deepEqual(normalize(await ValidationService.validateClassValuesAsync(db, tenant, leaf.id, input)), normalize(ValidationService.validateClassValues(db, tenant, leaf.id, input)));
  });

  test("write/read parity: assignment, values, object projections", async () => {
    const asyncResult = await Assignments.assignClassAsync(db, tenant, {
      object_type: "part",
      object_id: "P2-ASYNC-1",
      class_id: leaf.id,
      values: { [material.code]: "SS", [flow.code]: { value: 12.5, unit: "L/MIN" } },
    }, admin);
    const syncResult = Assignments.assignClass(db, tenant, {
      object_type: "part",
      object_id: "P2-SYNC-1",
      class_id: leaf.id,
      values: { [material.code]: "SS", [flow.code]: { value: 12.5, unit: "L/MIN" } },
    }, admin);
    assert.equal(asyncResult.created, true);
    assert.equal(syncResult.created, true);
    assert.equal(asyncResult.values.length, syncResult.values.length);
    for (const field of ["object_type", "class_id", "status", "version"]) {
      assert.equal(asyncResult.assignment[field], syncResult.assignment[field], `assignment field mismatch: ${field}`);
    }

    assert.deepEqual(normalize(await Assignments.objectClassificationsAsync(db, tenant, "part", "P2-ASYNC-1")), normalize(Assignments.objectClassifications(db, tenant, "part", "P2-ASYNC-1")));
    assert.deepEqual(normalize(await Assignments.resolveObjectValuesAsync(db, tenant, "part", "P2-ASYNC-1")), normalize(Assignments.resolveObjectValues(db, tenant, "part", "P2-ASYNC-1")));
    assert.deepEqual(normalize(await Assignments.validateAssignmentAsync(db, tenant, asyncResult.assignment.id)), normalize(Assignments.validateAssignment(db, tenant, asyncResult.assignment.id)));
  });

  test("read parity: classifications, classes, rules, history, metrics, health, coverage", async () => {
    assert.deepEqual(normalize(await Definitions.listClassificationsAsync(db, { tenantId: tenant })), normalize(Definitions.listClassifications(db, { tenantId: tenant })));
    assert.deepEqual(normalize(await Hierarchy.listClassesAsync(db, { tenantId: tenant })), normalize(Hierarchy.listClasses(db, { tenantId: tenant })));
    assert.deepEqual(normalize(await Rules.listRulesAsync(db, tenant, {})), normalize(Rules.listRules(db, tenant, {})));
    assert.deepEqual(normalize(await History.listHistoryAsync(db, { tenantId: tenant, entityType: "CLASSIFICATION", pageSize: 5 })), normalize(History.listHistory(db, { tenantId: tenant, entityType: "CLASSIFICATION", pageSize: 5 })));
    assert.deepEqual(normalize(await Characteristics.listClassCharacteristicsAsync(db, tenant, leaf.id)), normalize(Characteristics.listClassCharacteristics(db, tenant, leaf.id)));
    assert.deepEqual(normalize(await Metrics.metricsSnapshotAsync(db, { tenantId: tenant })), normalize(Metrics.metricsSnapshot(db, { tenantId: tenant })));
    assert.deepEqual(normalize(await Metrics.healthCheckAsync(db, { tenantId: tenant })), normalize(Metrics.healthCheck(db, { tenantId: tenant })));
    assert.deepEqual(normalize(await Metrics.coverageReportAsync(db, { tenantId: tenant, objectType: "part" })), normalize(Metrics.coverageReport(db, { tenantId: tenant, objectType: "part" })));
    assert.deepEqual(normalize(await Foundation.classificationHealthAsync(db, tenant)), normalize(Foundation.classificationHealth(db, tenant)));
    assert.deepEqual(normalize(await Duplicates.duplicateSummaryAsync(db, { tenantId: tenant })), normalize(Duplicates.duplicateSummary(db, { tenantId: tenant })));
  });

  test("configuration twins read the same layered values", async () => {
    assert.deepEqual(await Configuration.listConfigAsync(db, tenant), Configuration.listConfig(db, tenant));
    assert.equal(await Configuration.getConfigAsync(db, tenant, "allow_multiple_classification"), Configuration.getConfig(db, tenant, "allow_multiple_classification"));
    const set = await Configuration.setConfigAsync(db, tenant, "duplicate_similarity_threshold", 0.9, admin);
    assert.equal(set, 0.9);
    assert.equal(await Configuration.getConfigAsync(db, tenant, "duplicate_similarity_threshold"), 0.9);
  });

  test("job submission twins return a durable job", async () => {
    const asyncJob = await Jobs.submitBulkValidateJobAsync(db, { tenantId: tenant, objectType: "part", objectIds: ["P2-ASYNC-1"], actor: admin });
    const syncJob = Jobs.submitBulkValidateJob(db, { tenantId: tenant, objectType: "part", objectIds: ["P2-SYNC-1"], actor: admin });
    assert.ok(asyncJob && Number.isInteger(Number(asyncJob.id)));
    assert.ok(syncJob && Number.isInteger(Number(syncJob.id)));
    assert.equal(asyncJob.job_type_code, syncJob.job_type_code);
  });

  test("write twins: rule, group membership, reclassify and status transitions", async () => {
    const asyncRule = await Rules.createRuleAsync(db, tenant, { rule_type: "RANGE", severity: "ERROR", characteristic_id: flow.id, config: { min: 0, max: 100 } }, admin);
    const syncRule = Rules.createRule(db, tenant, { rule_type: "RANGE", severity: "ERROR", characteristic_id: flow.id, config: { min: 0, max: 100 } }, admin);
    for (const field of ["rule_type", "severity", "status"]) {
      assert.equal(asyncRule[field], syncRule[field], `rule field mismatch: ${field}`);
    }
    const updatedRule = await Rules.updateRuleAsync(db, tenant, asyncRule.rule_ref || asyncRule.id, { severity: "WARNING" }, admin);
    assert.equal(updatedRule.severity, "WARNING");
    assert.deepEqual(normalize(await Rules.listRulesAsync(db, tenant, {})), normalize(Rules.listRules(db, tenant, {})));
    assert.equal((await Rules.deleteRuleAsync(db, tenant, asyncRule.rule_ref || asyncRule.id, admin)).deleted, true);

    const group = await Characteristics.createGroupAsync(db, tenant, { code: "P2_GRP", name: "Group" }, admin);
    const member = await Characteristics.addGroupMemberAsync(db, tenant, group.id, material.id, {}, admin);
    assert.ok(member);
    assert.deepEqual(normalize(await Characteristics.listGroupMembersAsync(db, tenant, group.id)), normalize(Characteristics.listGroupMembers(db, tenant, group.id)));

    const asyncClass = await Hierarchy.createClassAsync(db, tenant, { classification_id: leaf.classification_id, code: "P2_MOVE_A", name: "Move A" }, admin);
    const moved = await Hierarchy.moveClassAsync(db, tenant, asyncClass.id, { parentClassId: leaf.id }, admin);
    assert.equal(moved.parent_class_id, leaf.id);
    assert.equal((await Hierarchy.setClassStatusAsync(db, tenant, asyncClass.id, "SUPERSEDED", admin)).status, "SUPERSEDED");
    assert.equal((await Hierarchy.deleteClassAsync(db, tenant, asyncClass.id, admin)).deleted, true);

    const assignment = await Assignments.assignClassAsync(db, tenant, { object_type: "part", object_id: "P2-RECLASS", class_id: leaf.id, values: { [material.code]: "SS", [flow.code]: { value: 3, unit: "L/MIN" } } }, admin);
    const reclassified = await Assignments.reclassifyAsync(db, tenant, assignment.assignment.id, { classId: leaf.id, values: { [material.code]: "CS", [flow.code]: { value: 4, unit: "L/MIN" } } }, admin);
    assert.ok(reclassified);
    assert.equal((await Assignments.setAssignmentStatusAsync(db, tenant, assignment.assignment.id, "INACTIVE", admin)).status, "INACTIVE");
    assert.equal((await Assignments.unassignAsync(db, tenant, assignment.assignment.id, admin)).deleted, true);
  });

  test("async error parity for missing entities", async () => {
    await assert.rejects(() => Definitions.getClassificationAsync(db, tenant, "NOPE"), /not found/i);
    assert.throws(() => Definitions.getClassification(db, tenant, "NOPE"), /not found/i);
    await assert.rejects(() => Hierarchy.getClassAsync(db, tenant, "NOPE"), /not found/i);
    await assert.rejects(() => Characteristics.getCharacteristicAsync(db, tenant, "NOPE"), /not found/i);
  });
});
