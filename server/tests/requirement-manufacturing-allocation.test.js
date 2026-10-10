process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, run, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { RequirementsManager, ensureRequirementsFoundation } from "../services/requirements/index.js";
import { ensureRequirementObject } from "../services/requirement-pdm/index.js";
import { Definitions as BomDefinitions, Revisions as BomRevisions, ensureBomFoundation } from "../services/bom/index.js";
import { Characteristics } from "../services/classification/index.js";
import {
  ensureRequirementManufacturingFoundation,
  createManufacturingObject,
  createAllocation,
  createAllocations,
  getAllocation,
  removeAllocation,
  listRequirementAllocations,
  listAllocations,
  listTargetRequirements,
  allocationCoverage,
  resolveTarget,
} from "../services/requirement-manufacturing/index.js";

const IP = "127.0.0.1";

describe("Requirement -> Manufacturing allocation", () => {
  let db;
  let tenant;
  let actor;
  let requirement;
  let mbomRevision;
  let operation;
  let workCenter;
  let characteristic;
  let document;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureBomFoundation(db);
    ensureRequirementManufacturingFoundation(db);

    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");

    requirement = RequirementsManager.createRequirement(db, tenant, { title: "Allocated requirement", requirement_type: "business_requirement" }, actor, IP);
    ensureRequirementObject(db, tenant, requirement, actor, IP);
    requirement = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [requirement.id]);

    const bom = BomDefinitions.createBom(db, tenant, { bom_number: "MFG-MBOM", name: "Manufacturing BOM", bom_type: "MBOM" }, actor, IP);
    mbomRevision = BomRevisions.createRevision(db, tenant, bom.id, { revision_number: "A1" }, actor, IP);

    operation = createManufacturingObject(db, tenant, { object_type: "operation", code: "OP-1", name: "Assembly" }, actor, IP);
    workCenter = createManufacturingObject(db, tenant, { object_type: "work_center", code: "WC-1", name: "Line 1" }, actor, IP);
    characteristic = Characteristics.createCharacteristic(db, tenant, { code: "MFG-C-1", name: "Torque", data_type: "UNIT_NUMERIC", unit: "NM" }, actor, IP);
    const inserted = run(db, "INSERT INTO content (content_id, content_key, tenant_id, file_name, description) VALUES (?, ?, ?, ?, ?)", ["MFG-DOC-A", "MFG-DOC-A", Number(tenant), "assembly.pdf", "Assembly instruction"]);
    document = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(inserted.lastInsertId)]);
  });

  after(() => {
    db?.close();
  });

  test("resolves every manufacturing target type without copying", () => {
    assert.equal(resolveTarget(db, tenant, "bom_revision", mbomRevision.id).bom_type, "MBOM");
    assert.equal(resolveTarget(db, tenant, "operation", operation.id).target_id, String(operation.id));
    assert.equal(resolveTarget(db, tenant, "work_center", workCenter.id).target_id, String(workCenter.id));
    assert.equal(resolveTarget(db, tenant, "characteristic", characteristic.id).target_id, String(characteristic.id));
    assert.equal(resolveTarget(db, tenant, "content", document.id).target_id, String(document.id));
    assert.equal(resolveTarget(db, tenant, "operation", 999999), null);
  });

  test("creates allocations for each manufacturing target kind", () => {
    const mbom = createAllocation(db, tenant, { requirement_id: requirement.id, target_type: "bom_revision", target_id: mbomRevision.id }, actor, IP);
    assert.equal(mbom.created, true);
    assert.equal(mbom.allocation.relationship_type, "SATISFIED_BY");
    assert.equal(mbom.allocation.target.bom_type, "MBOM");

    const op = createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "REALIZED_BY", target_type: "operation", target_id: operation.id }, actor, IP);
    assert.equal(op.allocation.relationship_type, "REALIZED_BY");

    createAllocation(db, tenant, { requirement_id: requirement.id, target_type: "work_center", target_id: workCenter.id }, actor, IP);
    createAllocation(db, tenant, { requirement_id: requirement.id, target_type: "characteristic", target_id: characteristic.id }, actor, IP);
    createAllocation(db, tenant, { requirement_id: requirement.id, target_type: "content", target_id: document.id }, actor, IP);

    const listed = listRequirementAllocations(db, tenant, requirement.id);
    assert.equal(listed.total, 5);
    assert.equal(listed.source_module, "requirement-manufacturing");
  });

  test("is idempotent and reactivates an inactive allocation", () => {
    const again = createAllocation(db, tenant, { requirement_id: requirement.id, target_type: "operation", target_id: operation.id }, actor, IP);
    assert.equal(again.created, false);
    assert.equal(again.reactivated, false);

    const row = getAllocation(db, tenant, again.allocation.allocation_ref);
    assert.equal(row.relationship_type, "REALIZED_BY");
    removeAllocation(db, tenant, row.allocation_ref, actor, IP);
    const removed = listRequirementAllocations(db, tenant, requirement.id, { relationship_type: "REALIZED_BY" });
    assert.equal(removed.total, 0);

    const recreated = createAllocation(db, tenant, { requirement_id: requirement.id, target_type: "operation", target_id: operation.id }, actor, IP);
    assert.equal(recreated.created, true);
  });

  test("rejects an allocation whose relationship type does not allow the target", () => {
    assert.throws(
      () => createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "GOVERNED_BY", target_type: "operation", target_id: operation.id }, actor, IP),
      (err) => err.code === "REQUIREMENT_MANUFACTURING_INVALID_RELATIONSHIP"
    );
  });

  test("enforces effectivity windows", () => {
    assert.throws(
      () => createAllocation(db, tenant, { requirement_id: requirement.id, target_type: "operation", target_id: operation.id, effectivity_to: "2000-01-01" }, actor, IP),
      (err) => err.code === "REQUIREMENT_MANUFACTURING_EFFECTIVITY_INVALID"
    );
  });

  test("supports batch allocation and reports per-entry failures", () => {
    const result = createAllocations(db, tenant, {
      requirement_id: requirement.id,
      target_type: "operation",
      targets: [operation.id, 999999],
    }, actor, IP);
    assert.equal(result.total, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.created + result.existing, 1);
    assert.ok(result.results.some((entry) => entry.ok === false));
  });

  test("lists allocations by target and computes coverage", () => {
    const reverse = listTargetRequirements(db, tenant, "operation", operation.id);
    assert.ok(reverse.items.some((item) => item.requirement_id === requirement.id));

    const all = listAllocations(db, tenant, { target_type: "bom_revision" });
    assert.ok(all.total >= 1);

    const coverage = allocationCoverage(db, tenant, requirement.id);
    assert.equal(coverage.coverage, "SATISFIED");
    assert.ok(coverage.active >= 4);
  });
});
