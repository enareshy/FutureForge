process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { RequirementsManager, ensureRequirementsFoundation } from "../services/requirements/index.js";
import { ensureRequirementObject, ensureRequirementPdmFoundation } from "../services/requirement-pdm/index.js";
import { Definitions as BomDefinitions, Revisions as BomRevisions, Lines as BomLines, ensureBomFoundation } from "../services/bom/index.js";
import { createObject } from "../services/objects.js";
import { Characteristics } from "../services/classification/index.js";
import {
  ensureRequirementManufacturingFoundation,
  createManufacturingObject,
  createAllocation,
  designateCtq,
  setConfig,
  manufacturingMatrix,
  manufacturingMatrixAsync,
  manufacturingCoverage,
  manufacturingCoverageAsync,
  manufacturingGaps,
  manufacturingGapsAsync,
  manufacturingTrace,
  manufacturingTraceAsync,
  manufacturingTraceMatrix,
  manufacturingTraceMatrixAsync,
} from "../services/requirement-manufacturing/index.js";

const IP = "127.0.0.1";
const DEFAULT_COVERAGE_RULES = "MUST:EBOM_MBOM_MAPPING,MUST:REQUIREMENT_IMPLEMENTATION,SHOULD:MBOM_BOP_ASSIGNMENT,SHOULD:CTQ_COVERAGE";

describe("Requirement -> Manufacturing traceability matrix, coverage, gaps & navigation", () => {
  let db;
  let tenant;
  let actor;
  let covered;
  let uncovered;
  let operation;
  let workCenter;
  let ctqCharacteristic;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureRequirementPdmFoundation(db);
    ensureBomFoundation(db);
    ensureRequirementManufacturingFoundation(db);

    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");

    covered = RequirementsManager.createRequirement(
      db,
      tenant,
      { title: "Fully covered requirement", requirement_type: "business_requirement", criticality: "HIGH" },
      actor,
      IP
    );
    ensureRequirementObject(db, tenant, covered, actor, IP);
    covered = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [covered.id]);

    uncovered = RequirementsManager.createRequirement(
      db,
      tenant,
      { title: "Unallocated requirement", requirement_type: "business_requirement" },
      actor,
      IP
    );
    ensureRequirementObject(db, tenant, uncovered, actor, IP);
    uncovered = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [uncovered.id]);

    operation = createManufacturingObject(db, tenant, { object_type: "operation", code: "MTX-OP-10", name: "Weld operation" }, actor, IP);
    workCenter = createManufacturingObject(db, tenant, { object_type: "work_center", code: "MTX-WC-10", name: "Welding cell" }, actor, IP);
    ctqCharacteristic = Characteristics.createCharacteristic(db, tenant, { code: "MTX-CTQ-1", name: "Weld depth", data_type: "UNIT_NUMERIC", unit: "MM" }, actor, IP);
    designateCtq(db, tenant, ctqCharacteristic.id, { ctq: true, severity: "HIGH" }, actor, IP);

    createAllocation(db, tenant, { requirement_id: String(covered.id), target_type: "operation", relationship_type: "REALIZED_BY", target_id: String(operation.id) }, actor, IP);
    createAllocation(db, tenant, { requirement_id: String(covered.id), target_type: "work_center", relationship_type: "SATISFIED_BY", target_id: String(workCenter.id) }, actor, IP);
    createAllocation(db, tenant, { requirement_id: String(covered.id), target_type: "characteristic", relationship_type: "CONTROLLED_BY", target_id: String(ctqCharacteristic.id) }, actor, IP);

    const mbom = BomDefinitions.createBom(db, tenant, { bom_number: "MTX-MBOM", name: "Manufacturing BOM", bom_type: "MBOM" }, actor, IP);
    const mbomRevision = BomRevisions.createRevision(db, tenant, mbom.id, { revision_number: "A1" }, actor, IP);
    const part = createObject(db, { type: "part", code: "MTX-PART-A", name: "Housing", status: "released", data: { "part.number": "MTX-PART-A", "part.name": "Housing", "part.category": "mechanical", "part.status": "released" } }, actor, tenant, IP);
    BomLines.addLine(db, tenant, mbomRevision.id, { child_object_id: String(part.id), child_object_type: "part", quantity: 1, uom: "EA", find_number: "10" }, actor, IP);
  });

  after(() => {
    db?.close();
  });

  test("builds a matrix with columns, per-requirement coverage and gaps", () => {
    const matrix = manufacturingMatrix(db, tenant, { pageSize: 500 });
    assert.equal(matrix.source_module, "requirement-manufacturing");
    assert.ok(matrix.columns.includes("operation"));
    assert.ok(matrix.columns.includes("work_center"));
    assert.ok(matrix.columns.includes("ctq"));

    const coveredRow = matrix.items.find((item) => item.requirement.requirement_id === covered.id);
    assert.ok(coveredRow, "covered requirement must appear in the matrix");
    assert.equal(coveredRow.coverage_status, "COVERED");
    assert.equal(coveredRow.counts.operation, 1);
    assert.equal(coveredRow.counts.work_center, 1);
    assert.equal(coveredRow.counts.ctq, 1);
    assert.deepEqual(coveredRow.gaps, []);
    assert.ok(coveredRow.columns.operation.some((target) => target.target_id === String(operation.id)));
    assert.ok(coveredRow.rule_results.every((entry) => entry.met));

    const uncoveredRow = matrix.items.find((item) => item.requirement.requirement_id === uncovered.id);
    assert.ok(uncoveredRow, "unallocated requirement must appear in the matrix");
    assert.equal(uncoveredRow.coverage_status, "UNALLOCATED");
    assert.ok(uncoveredRow.gaps.some((gap) => gap.rule === "REQUIREMENT_IMPLEMENTATION" && gap.severity === "ERROR"));

    assert.ok(matrix.summary.COVERED >= 1);
    assert.ok(matrix.summary.requirements >= 2);
    assert.equal(typeof matrix.summary.coverage_pct, "number");
  });

  test("aggregates manufacturing coverage across requirements and CTQs", () => {
    const coverage = manufacturingCoverage(db, tenant);
    assert.ok(coverage.requirements.requirements >= 2);
    assert.ok(coverage.requirements.COVERED >= 1);
    assert.equal(typeof coverage.overall_coverage, "number");
    assert.ok(coverage.ctq.total >= 1);
    assert.equal(coverage.source_module, "requirement-manufacturing");
  });

  test("reports requirement, MBOM/BOP structure and unmapped EBOM gaps", () => {
    const gaps = manufacturingGaps(db, tenant);
    assert.equal(gaps.source_module, "requirement-manufacturing");
    assert.ok(gaps.summary.total >= 1);

    assert.ok(
      gaps.items.some((gap) => gap.object.type === "requirement" && gap.object.id === uncovered.id && gap.rule === "REQUIREMENT_IMPLEMENTATION" && gap.severity === "ERROR"),
      "unallocated requirement must be reported as an implementation gap"
    );
    assert.ok(
      !gaps.items.some((gap) => gap.object.type === "requirement" && gap.object.id === covered.id),
      "covered requirement must not be reported as a gap"
    );
    assert.ok(gaps.items.some((gap) => gap.rule === "MBOM_BOP_ASSIGNMENT" && gap.object.type === "bom_revision"), "MBOM without a BOP must be reported");
    assert.ok(gaps.items.some((gap) => gap.rule === "EBOM_MBOM_MAPPING" && gap.object.type === "bom_revision"), "unmapped MBOM line must be reported");
  });

  test("filters gaps by requested rules", () => {
    const filtered = manufacturingGaps(db, tenant, { rules: ["REQUIREMENT_IMPLEMENTATION"] });
    assert.deepEqual(filtered.enabled_rules, ["REQUIREMENT_IMPLEMENTATION"]);
    assert.ok(filtered.items.length >= 1);
    assert.ok(filtered.items.every((gap) => gap.rule === "REQUIREMENT_IMPLEMENTATION"));
  });

  test("honours configurable coverage rules", () => {
    setConfig(db, tenant, "coverage_rules", "SHOULD:REQUIREMENT_IMPLEMENTATION");
    const relaxed = manufacturingMatrix(db, tenant, { pageSize: 500 });
    const relaxedUncovered = relaxed.items.find((item) => item.requirement.requirement_id === uncovered.id);
    assert.equal(relaxedUncovered.coverage_status, "UNALLOCATED", "an unallocated requirement stays unallocated");
    setConfig(db, tenant, "coverage_rules", "MUST:CTQ_COVERAGE");
    const ctqOnly = manufacturingMatrix(db, tenant, { pageSize: 500 });
    const ctqCovered = ctqOnly.items.find((item) => item.requirement.requirement_id === covered.id);
    assert.equal(ctqCovered.coverage_status, "COVERED", "covered requirement owns a CTQ");
    setConfig(db, tenant, "coverage_rules", DEFAULT_COVERAGE_RULES);
  });

  test("supports the async twins", async () => {
    const matrix = await manufacturingMatrixAsync(db, tenant, { pageSize: 500 });
    assert.ok(matrix.items.length >= 2);
    const coverage = await manufacturingCoverageAsync(db, tenant);
    assert.ok(coverage.requirements.requirements >= 2);
    const gaps = await manufacturingGapsAsync(db, tenant);
    assert.ok(gaps.summary.total >= 1);
  });

  test("navigates the digital thread bidirectionally", async () => {
    const forward = await manufacturingTraceAsync(db, tenant, { objectType: "requirement", objectId: String(covered.object_id), direction: "forward", includeInactive: true }, actor);
    const forwardKeys = forward.nodes.map((node) => `${node.object_type}:${node.object_id}`);
    assert.ok(forwardKeys.includes(`requirement:${covered.object_id}`), `root missing: ${forwardKeys.join(",")}`);
    assert.ok(forwardKeys.includes(`operation:${operation.id}`), `operation missing: ${forwardKeys.join(",")}`);

    const backward = await manufacturingTraceAsync(db, tenant, { objectType: "operation", objectId: String(operation.id), direction: "backward", includeInactive: true }, actor);
    const backwardKeys = backward.nodes.map((node) => `${node.object_type}:${node.object_id}`);
    assert.ok(backwardKeys.includes(`requirement:${covered.object_id}`), `reverse requirement missing: ${backwardKeys.join(",")}`);

    const traceMatrix = await manufacturingTraceMatrixAsync(db, tenant, { objectType: "requirement", objectId: String(covered.object_id), includeInactive: true }, actor);
    assert.ok(traceMatrix, "trace matrix must be delegated to the traceability engine");
  });

  test("exposes synchronous navigation and rejects unknown node types", () => {
    const graph = manufacturingTrace(db, tenant, { objectType: "requirement", objectId: String(covered.object_id), direction: "forward", includeInactive: true }, actor);
    assert.ok(Array.isArray(graph.nodes));
    assert.ok(graph.nodes.some((node) => node.object_type === "operation"));

    assert.throws(() => manufacturingTrace(db, tenant, { objectType: "widget", objectId: "1" }, actor), (err) => err.code === "REQUIREMENT_MANUFACTURING_INVALID_TARGET");
    assert.throws(() => manufacturingTraceMatrix(db, tenant, { objectType: "widget", objectId: "1" }, actor), (err) => err.code === "REQUIREMENT_MANUFACTURING_INVALID_TARGET");
  });
});
