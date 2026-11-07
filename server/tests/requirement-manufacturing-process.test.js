process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { ensureRequirementsFoundation } from "../services/requirements/index.js";
import { Definitions as BomDefinitions, Revisions as BomRevisions, Lines as BomLines, ensureBomFoundation } from "../services/bom/index.js";
import { createObject } from "../services/objects.js";
import {
  ensureRequirementManufacturingFoundation,
  createManufacturingObject,
  setConfig,
  addOperationToBop,
  bopOperations,
  bopOperationsAsync,
  linkOperationToWorkCenter,
  operationWorkCenters,
  workCenterOperations,
  linkOperationToMbomItem,
  operationMbomItems,
  mbomItemOperations,
  listBopMboms,
  listMbomBops,
  linkOperationPrecedence,
  bopProcessSequence,
  bopProcessCoverage,
  mbomProcessCoverage,
} from "../services/requirement-manufacturing/index.js";

const IP = "127.0.0.1";

function expectCode(fn, code) {
  assert.throws(fn, (err) => err.code === code);
}

describe("Requirement -> Manufacturing BOP / operation / work-center linkage", () => {
  let db;
  let tenant;
  let actor;
  let bopRevision;
  let mbomRevision;
  let op1;
  let op2;
  let op3;
  let op4;
  let wc1;
  let wc2;
  let part1;
  let part2;

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

    const bop = BomDefinitions.createBom(db, tenant, { bom_number: "MFG-BOP", name: "Process plan", bom_type: "BOP" }, actor, IP);
    bopRevision = BomRevisions.createRevision(db, tenant, bop.id, { revision_number: "A1" }, actor, IP);

    const mbom = BomDefinitions.createBom(db, tenant, { bom_number: "MFG-MBOM-2", name: "Manufacturing BOM", bom_type: "MBOM" }, actor, IP);
    mbomRevision = BomRevisions.createRevision(db, tenant, mbom.id, { revision_number: "A1" }, actor, IP);

    op1 = createManufacturingObject(db, tenant, { object_type: "operation", code: "OP-10", name: "Cut" }, actor, IP);
    op2 = createManufacturingObject(db, tenant, { object_type: "operation", code: "OP-20", name: "Weld" }, actor, IP);
    op3 = createManufacturingObject(db, tenant, { object_type: "operation", code: "OP-30", name: "Paint" }, actor, IP);
    op4 = createManufacturingObject(db, tenant, { object_type: "operation", code: "OP-40", name: "Inspect" }, actor, IP);
    wc1 = createManufacturingObject(db, tenant, { object_type: "work_center", code: "WC-10", name: "Line 1" }, actor, IP);
    wc2 = createManufacturingObject(db, tenant, { object_type: "work_center", code: "WC-20", name: "Line 2" }, actor, IP);

    part1 = createObject(db, { type: "part", code: "PART-A", name: "Housing", status: "released", data: { "part.number": "PART-A", "part.name": "Housing", "part.category": "mechanical", "part.status": "released" } }, actor, tenant, IP);
    part2 = createObject(db, { type: "part", code: "PART-B", name: "Bracket", status: "released", data: { "part.number": "PART-B", "part.name": "Bracket", "part.category": "mechanical", "part.status": "released" } }, actor, tenant, IP);
    BomLines.addLine(db, tenant, mbomRevision.id, { child_object_id: String(part1.id), child_object_type: "part", quantity: 1, uom: "EA", find_number: "10" }, actor, IP);
    BomLines.addLine(db, tenant, mbomRevision.id, { child_object_id: String(part2.id), child_object_type: "part", quantity: 1, uom: "EA", find_number: "20" }, actor, IP);
  });

  after(() => {
    db?.close();
  });

  test("adds operations to a BOP in sequence and reads them back ordered", () => {
    addOperationToBop(db, tenant, bopRevision.id, { operation_id: op1.id, sequence: 10, find_number: "10" }, actor, IP);
    addOperationToBop(db, tenant, bopRevision.id, { operation_id: op2.id, sequence: 20, find_number: "20" }, actor, IP);
    addOperationToBop(db, tenant, bopRevision.id, { operation_id: op3.id, sequence: 30, find_number: "30" }, actor, IP);

    const result = bopOperations(db, tenant, bopRevision.id);
    assert.equal(result.direction, "BOP_TO_OPERATION");
    assert.equal(result.bop_revision.bom_type, "BOP");
    assert.equal(result.summary.operations, 3);
    assert.deepEqual(result.items.map((item) => item.operation.code), ["OP-10", "OP-20", "OP-30"]);
    assert.deepEqual(result.items.map((item) => item.sequence), [10, 20, 30]);
  });

  test("supports the async twin", async () => {
    const result = await bopOperationsAsync(db, tenant, bopRevision.id);
    assert.equal(result.summary.operations, 3);
  });

  test("links operations to work centers and reads both directions", () => {
    linkOperationToWorkCenter(db, tenant, op1.id, { work_center_id: wc1.id }, actor, IP);
    linkOperationToWorkCenter(db, tenant, op2.id, { work_center_id: wc2.id }, actor, IP);
    linkOperationToWorkCenter(db, tenant, op3.id, { work_center_id: wc1.id }, actor, IP);

    const ofOp1 = operationWorkCenters(db, tenant, op1.id);
    assert.equal(ofOp1.operation.code, "OP-10");
    assert.deepEqual(ofOp1.items.map((wc) => wc.code), ["WC-10"]);

    const ofWc1 = workCenterOperations(db, tenant, wc1.id);
    assert.equal(ofWc1.work_center.code, "WC-10");
    assert.deepEqual(ofWc1.items.map((item) => item.operation.code).sort(), ["OP-10", "OP-30"]);
    assert.ok(ofWc1.items.every((item) => item.bops.some((bop) => bop.bom_number === "MFG-BOP")));
  });

  test("links MBOM items consumed by operations and navigates BOP <-> MBOM", () => {
    linkOperationToMbomItem(db, tenant, op1.id, { mbom_item_id: part1.id }, actor, IP);

    const items = operationMbomItems(db, tenant, op1.id);
    assert.deepEqual(items.items.map((entry) => entry.item.code), ["PART-A"]);
    assert.ok(items.items[0].mboms.some((bom) => bom.bom_number === "MFG-MBOM-2"));

    const operations = mbomItemOperations(db, tenant, part1.id);
    assert.deepEqual(operations.items.map((entry) => entry.operation.code), ["OP-10"]);
    assert.ok(operations.items[0].bops.some((bom) => bom.bom_number === "MFG-BOP"));

    const bops = listMbomBops(db, tenant, mbomRevision.id);
    assert.deepEqual(bops.items.map((bom) => bom.bom_number), ["MFG-BOP"]);

    const mboms = listBopMboms(db, tenant, bopRevision.id);
    assert.deepEqual(mboms.items.map((bom) => bom.bom_number), ["MFG-MBOM-2"]);
  });

  test("validates process sequence and detects conflicts", () => {
    linkOperationPrecedence(db, tenant, op2.id, { predecessor_id: op1.id }, actor, IP);
    linkOperationPrecedence(db, tenant, op3.id, { predecessor_id: op2.id }, actor, IP);
    const ok = bopProcessSequence(db, tenant, bopRevision.id);
    assert.equal(ok.valid, true);
    assert.deepEqual(ok.items.map((item) => item.operation_object_id), [String(op1.id), String(op2.id), String(op3.id)]);

    // Reverse precedence creates a cycle against the existing chain.
    linkOperationPrecedence(db, tenant, op1.id, { predecessor_id: op3.id }, actor, IP);
    const conflicted = bopProcessSequence(db, tenant, bopRevision.id);
    assert.equal(conflicted.valid, false);
    assert.ok(conflicted.conflicts.some((conflict) => conflict.type === "SEQUENCE_CONFLICT"));
    assert.ok(conflicted.conflicts.some((conflict) => conflict.type === "SEQUENCE_CYCLE"));
  });

  test("reports process coverage and missing assignments", () => {
    setConfig(db, tenant, "require_operation_work_center", true);
    addOperationToBop(db, tenant, bopRevision.id, { operation_id: op4.id, sequence: 40 }, actor, IP);
    const coverage = bopProcessCoverage(db, tenant, bopRevision.id);
    assert.equal(coverage.summary.operations, 4);
    assert.equal(coverage.summary.missing_work_center, 1);
    assert.equal(coverage.missing_work_centers[0].operation_object_id, String(op4.id));
    assert.equal(coverage.coverage, "PARTIAL");
    setConfig(db, tenant, "require_operation_work_center", false);

    setConfig(db, tenant, "require_mbom_bop_assignment", true);
    const mbomCoverage = mbomProcessCoverage(db, tenant, mbomRevision.id);
    assert.equal(mbomCoverage.summary.items, 2);
    assert.equal(mbomCoverage.summary.assigned, 1);
    assert.equal(mbomCoverage.summary.unassigned, 1);
    assert.equal(mbomCoverage.unassigned_items[0].object_id, String(part2.id));
    assert.equal(mbomCoverage.coverage, "PARTIAL");
    setConfig(db, tenant, "require_mbom_bop_assignment", false);
  });

  test("rejects wrong revision and object types", () => {
    expectCode(() => bopOperations(db, tenant, mbomRevision.id), "REQUIREMENT_MANUFACTURING_INVALID_PROCESS");
    expectCode(() => listMbomBops(db, tenant, bopRevision.id), "REQUIREMENT_MANUFACTURING_INVALID_PROCESS");
    expectCode(() => operationWorkCenters(db, tenant, wc1.id), "REQUIREMENT_MANUFACTURING_OPERATION_NOT_FOUND");
    expectCode(() => workCenterOperations(db, tenant, op1.id), "REQUIREMENT_MANUFACTURING_WORK_CENTER_NOT_FOUND");
    expectCode(() => linkOperationToWorkCenter(db, tenant, op1.id, { work_center_id: op2.id }, actor, IP), "REQUIREMENT_MANUFACTURING_WORK_CENTER_NOT_FOUND");
  });
});
