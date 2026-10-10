process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { RequirementsManager, ensureRequirementsFoundation } from "../services/requirements/index.js";
import { ensureRequirementObject } from "../services/requirement-pdm/index.js";
import { Characteristics, Definitions, Hierarchy, Assignments, ensureClassificationUnits } from "../services/classification/index.js";
import {
  ensureRequirementManufacturingFoundation,
  createManufacturingObject,
  createAllocation,
  designateCtq,
  setCharacteristicLimits,
  operationCharacteristics,
  operationCharacteristicsAsync,
  operationConstraints,
  characteristicOperations,
  characteristicRequirements,
  requirementCtqs,
  ctqCoverage,
  ctqCoverageAsync,
  validateConstraintCompatibility,
  setConfig,
} from "../services/requirement-manufacturing/index.js";

const IP = "127.0.0.1";

describe("Requirement -> Manufacturing characteristics, constraints & CTQ coverage", () => {
  let db;
  let tenant;
  let actor;
  let requirement;
  let ctqCharacteristic;
  let plainCharacteristic;
  let orphanCtq;
  let operation;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureRequirementManufacturingFoundation(db);
    ensureClassificationUnits(db);

    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");

    requirement = RequirementsManager.createRequirement(
      db,
      tenant,
      { title: "Weld quality governed", requirement_type: "business_requirement", criticality: "LOW" },
      actor,
      IP
    );
    ensureRequirementObject(db, tenant, requirement, actor, IP);
    requirement = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [requirement.id]);

    ctqCharacteristic = Characteristics.createCharacteristic(db, tenant, { code: "CTQ-WELD", name: "Weld depth", data_type: "UNIT_NUMERIC", unit: "MM" }, actor, IP);
    plainCharacteristic = Characteristics.createCharacteristic(db, tenant, { code: "PLAIN-LEN", name: "Overall length", data_type: "UNIT_NUMERIC", unit: "MM" }, actor, IP);
    orphanCtq = Characteristics.createCharacteristic(db, tenant, { code: "CTQ-ORPHAN", name: "Orphan CTQ", data_type: "UNIT_NUMERIC", unit: "MM" }, actor, IP);

    const classification = Definitions.createClassification(db, tenant, { code: "MFG-CLA", name: "Manufacturing" }, actor, IP);
    const cls = Hierarchy.createClass(db, tenant, { classification_id: classification.id, code: "MFG-ROOT", name: "Root" }, actor, IP);
    Hierarchy.setClassStatus(db, tenant, cls.id, "ACTIVE", actor, IP);
    Characteristics.addClassCharacteristic(db, tenant, cls.id, { characteristic_id: ctqCharacteristic.id }, actor, IP);
    Characteristics.addClassCharacteristic(db, tenant, cls.id, { characteristic_id: plainCharacteristic.id }, actor, IP);

    operation = createManufacturingObject(db, tenant, { object_type: "operation", code: "OP-WELD", name: "Weld operation" }, actor, IP);
    Assignments.assignClass(db, tenant, { class_id: cls.id, object_type: "operation", object_id: String(operation.id) }, actor, IP);

    designateCtq(db, tenant, ctqCharacteristic.id, { ctq: true, severity: "HIGH", rationale: "Safety critical" }, actor, IP);
    designateCtq(db, tenant, orphanCtq.id, { ctq: true, severity: "MEDIUM" }, actor, IP);
    setCharacteristicLimits(db, tenant, ctqCharacteristic.id, { min_value: 1.5, max_value: 3.5, min_inclusive: true, max_inclusive: false }, actor, IP);

    createAllocation(db, tenant, { requirement_id: String(requirement.id), target_type: "characteristic", relationship_type: "CONTROLLED_BY", target_id: String(ctqCharacteristic.id) }, actor, IP);
  });

  after(() => {
    db?.close();
  });

  test("lists the characteristics applicable to an operation (reusing classification)", () => {
    const result = operationCharacteristics(db, tenant, operation.id);
    const codes = result.items.map((item) => item.code).sort();
    assert.deepEqual(codes, ["CTQ-WELD", "PLAIN-LEN"]);
    const ctq = result.items.find((item) => item.code === "CTQ-WELD");
    assert.equal(ctq.ctq, true);
    assert.equal(ctq.has_limits, true);
    assert.equal(ctq.min_value, 1.5);
    assert.equal(ctq.max_value, 3.5);
    assert.equal(ctq.max_inclusive, false);
    const plain = result.items.find((item) => item.code === "PLAIN-LEN");
    assert.equal(plain.ctq, false);
    assert.equal(plain.has_limits, false);
  });

  test("lists only constrained characteristics for an operation", () => {
    const result = operationConstraints(db, tenant, operation.id);
    assert.deepEqual(result.items.map((item) => item.code), ["CTQ-WELD"]);
  });

  test("navigates characteristic -> operations and requirement <- characteristic", () => {
    const ops = characteristicOperations(db, tenant, ctqCharacteristic.id);
    assert.deepEqual(ops.items.map((item) => item.code), ["OP-WELD"]);

    const reqs = characteristicRequirements(db, tenant, ctqCharacteristic.id);
    assert.deepEqual(reqs.items.map((item) => item.requirement.requirement_id), [requirement.id]);
    assert.equal(reqs.items[0].relationship_type, "CONTROLLED_BY");
  });

  test("traces a requirement forward to its CTQ characteristics and operations", () => {
    const result = requirementCtqs(db, tenant, requirement.id);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].characteristic.code, "CTQ-WELD");
    assert.equal(result.items[0].has_operation, true);
    assert.equal(result.items[0].operation_count, 1);
  });

  test("validates machine-readable constraint compatibility", () => {
    const within = validateConstraintCompatibility(db, tenant, ctqCharacteristic.id, { value: 2 });
    assert.equal(within.status, "VALID");
    assert.equal(within.valid, true);

    const below = validateConstraintCompatibility(db, tenant, ctqCharacteristic.id, { value: 1.0 });
    assert.equal(below.status, "INVALID_LINK");
    assert.equal(below.reason, "BELOW_MIN");

    const exclusiveMax = validateConstraintCompatibility(db, tenant, ctqCharacteristic.id, { value: 3.5 });
    assert.equal(exclusiveMax.status, "INVALID_LINK");
    assert.equal(exclusiveMax.reason, "ABOVE_MAX");

    const missing = validateConstraintCompatibility(db, tenant, ctqCharacteristic.id, {});
    assert.equal(missing.status, "PENDING_VALIDATION");
    assert.equal(missing.reason, "NO_VALUE");

    const converted = validateConstraintCompatibility(db, tenant, ctqCharacteristic.id, { value: 0.2, unit: "CM" });
    assert.equal(converted.status, "VALID");
    assert.equal(converted.value, 2);

    const unitMismatch = validateConstraintCompatibility(db, tenant, ctqCharacteristic.id, { value: 1, unit: "KG" });
    assert.equal(unitMismatch.status, "CONFIGURATION_MISMATCH");
    assert.equal(unitMismatch.reason, "UNIT_MISMATCH");
  });

  test("reports CTQ coverage, gaps and operations", () => {
    const report = ctqCoverage(db, tenant);
    assert.ok(report.summary.ctq_total >= 2);
    assert.ok(report.ctq_without_requirement.some((c) => c.code === "CTQ-ORPHAN"));
    assert.ok(report.ctq_without_operation.some((c) => c.code === "CTQ-ORPHAN"));
    assert.ok(report.with_coverage.some((entry) => entry.requirement_id === requirement.id));
    assert.equal(report.rule.token, "CTQ_COVERAGE");
    assert.equal(report.rule.enabled, true);
  });

  test("reports requirements missing an expected CTQ when the critical rule is enabled", () => {
    const critical = RequirementsManager.createRequirement(
      db,
      tenant,
      { title: "Critical requirement without CTQ", requirement_type: "business_requirement", criticality: "HIGH" },
      actor,
      IP
    );
    ensureRequirementObject(db, tenant, critical, actor, IP);

    setConfig(db, tenant, "require_ctq_for_critical", true, actor, IP);
    const report = ctqCoverage(db, tenant);
    assert.ok(report.requirements_missing_ctq.some((entry) => entry.requirement_id === critical.id), "critical requirement must be reported missing CTQ");
    assert.ok(!report.requirements_missing_ctq.some((entry) => entry.requirement_id === requirement.id), "covered requirement must not be reported");
    setConfig(db, tenant, "require_ctq_for_critical", false, actor, IP);

    const disabled = ctqCoverage(db, tenant);
    assert.equal(disabled.rule.require_for_critical, false);
    assert.equal(disabled.summary.requirements_missing_ctq, 0);
  });

  test("supports the async twins", async () => {
    const chars = await operationCharacteristicsAsync(db, tenant, operation.id);
    assert.equal(chars.items.length, 2);
    const report = await ctqCoverageAsync(db, tenant);
    assert.ok(report.summary.ctq_total >= 2);
  });
});
