process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { RequirementsManager, ensureRequirementsFoundation } from "../services/requirements/index.js";
import { ensureRequirementObject, ensureRequirementPdmFoundation } from "../services/requirement-pdm/index.js";
import { getJobTypeRow } from "../services/jobs/types.js";
import { getSubscriptionRow } from "../services/events/subscriptions.js";
import { Characteristics } from "../services/classification/index.js";
import {
  ensureRequirementManufacturingFoundation,
  createManufacturingObject,
  createAllocation,
  designateCtq,
  analyzeRequirementImpact,
  analyzeRequirementImpactAsync,
  analyzeNodeImpact,
  analyzeNodeImpactAsync,
  sweepManufacturingGaps,
  ensureRequirementManufacturingJobTypes,
  ensureRequirementManufacturingNodeSubscriptions,
  ensureRequirementManufacturingTraceSubscriptions,
  REQUIREMENT_MANUFACTURING_JOB_TYPES,
  REQUIREMENT_MANUFACTURING_NODE_SUBSCRIPTIONS,
  REQUIREMENT_MANUFACTURING_TRACE_SUBSCRIPTIONS,
} from "../services/requirement-manufacturing/index.js";

const IP = "127.0.0.1";

describe("Requirement -> Manufacturing change impact, jobs & events", () => {
  let db;
  let tenant;
  let actor;
  let covered;
  let uncovered;
  let operation;
  let workCenter;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureRequirementPdmFoundation(db);
    ensureRequirementManufacturingFoundation(db);

    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");

    covered = RequirementsManager.createRequirement(db, tenant, { title: "Impacted requirement", requirement_type: "business_requirement", criticality: "HIGH" }, actor, IP);
    ensureRequirementObject(db, tenant, covered, actor, IP);
    covered = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [covered.id]);

    uncovered = RequirementsManager.createRequirement(db, tenant, { title: "Unallocated impact requirement", requirement_type: "business_requirement" }, actor, IP);
    ensureRequirementObject(db, tenant, uncovered, actor, IP);
    uncovered = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [uncovered.id]);

    operation = createManufacturingObject(db, tenant, { object_type: "operation", code: "IMP-OP-10", name: "Machining operation" }, actor, IP);
    workCenter = createManufacturingObject(db, tenant, { object_type: "work_center", code: "IMP-WC-10", name: "Machining cell" }, actor, IP);
    const ctq = Characteristics.createCharacteristic(db, tenant, { code: "IMP-CTQ-1", name: "Surface finish", data_type: "UNIT_NUMERIC", unit: "MM" }, actor, IP);
    designateCtq(db, tenant, ctq.id, { ctq: true, severity: "HIGH" }, actor, IP);

    createAllocation(db, tenant, { requirement_id: String(covered.id), target_type: "operation", relationship_type: "REALIZED_BY", target_id: String(operation.id) }, actor, IP);
    createAllocation(db, tenant, { requirement_id: String(covered.id), target_type: "work_center", relationship_type: "SATISFIED_BY", target_id: String(workCenter.id) }, actor, IP);
    createAllocation(db, tenant, { requirement_id: String(covered.id), target_type: "characteristic", relationship_type: "CONTROLLED_BY", target_id: String(ctq.id) }, actor, IP);
  });

  after(() => {
    db?.close();
  });

  test("classifies forward manufacturing impact for a requirement", () => {
    const report = analyzeRequirementImpact(db, tenant, covered.id, { includeInactive: true }, actor, IP);
    assert.equal(report.source_module, "requirement-manufacturing");
    assert.equal(report.requirement.id, covered.id);
    assert.ok(report.impacted_count >= 1, `expected impacted nodes, got ${report.impacted_count}`);
    assert.ok(report.items.every((item) => item.category));
    assert.ok(report.category_totals.PROCESS >= 1 || report.category_totals.DIRECT >= 1);

    const event = queryOne(db, "SELECT id FROM event_records WHERE event_type_code = 'RequirementManufacturingImpactDetected' ORDER BY id DESC LIMIT 1");
    assert.ok(event, "impact analysis must publish the impact event through the event framework");
  });

  test("sync and async forward impact agree", async () => {
    const sync = analyzeRequirementImpact(db, tenant, covered.id, { includeInactive: true }, actor, IP);
    const asyncReport = await analyzeRequirementImpactAsync(db, tenant, covered.id, { includeInactive: true }, actor, IP);
    assert.equal(sync.impacted_count, asyncReport.impacted_count);
    assert.equal(sync.root, asyncReport.root);
  });

  test("reverse analysis finds the requirements linked to a manufacturing node", async () => {
    const report = await analyzeNodeImpactAsync(db, tenant, { nodeType: "operation", nodeId: operation.id }, {}, actor, IP);
    assert.equal(report.node_type, "operation");
    assert.equal(report.requirement_count, 1);
    assert.equal(report.requirements[0].requirement_id, covered.id);
    assert.ok(report.impacted_count >= 1);

    const listed = analyzeNodeImpact(db, tenant, { nodeType: "work_center", nodeId: workCenter.id }, { analyze: false }, actor, IP);
    assert.equal(listed.requirement_count, 1);
    assert.equal(listed.analyzed, false);
    assert.equal(listed.impacted_count, 0);
  });

  test("ensures the background job types idempotently", () => {
    const first = ensureRequirementManufacturingJobTypes(db);
    assert.equal(first.created, 0, "job types are created by the foundation");
    const second = ensureRequirementManufacturingJobTypes(db);
    assert.equal(second.created, 0);
    for (const definition of REQUIREMENT_MANUFACTURING_JOB_TYPES) {
      assert.ok(getJobTypeRow(db, definition.code), `missing job type ${definition.code}`);
    }
  });

  test("sweeps gaps scoped to a requirement", async () => {
    const uncoveredSweep = await sweepManufacturingGaps(db, tenant, { requirementId: uncovered.id }, actor, IP);
    assert.equal(uncoveredSweep.status, "GAPS_FOUND");
    assert.ok(uncoveredSweep.total >= 1);

    const coveredSweep = await sweepManufacturingGaps(db, tenant, { requirementId: covered.id }, actor, IP);
    assert.equal(coveredSweep.status, "COMPLETED");
    assert.equal(coveredSweep.total, 0);
  });

  test("registers node and trace event subscriptions", () => {
    const nodes = ensureRequirementManufacturingNodeSubscriptions(db);
    assert.equal(nodes.total, REQUIREMENT_MANUFACTURING_NODE_SUBSCRIPTIONS.length);
    assert.equal(typeof nodes.created, "number");

    const traces = ensureRequirementManufacturingTraceSubscriptions(db);
    assert.equal(traces.total, REQUIREMENT_MANUFACTURING_TRACE_SUBSCRIPTIONS.length);
    assert.equal(typeof traces.created, "number");
    for (const definition of REQUIREMENT_MANUFACTURING_TRACE_SUBSCRIPTIONS) {
      const row = getSubscriptionRow(db, `req-mfg-trace-${String(definition.event_type_code).toLowerCase()}`);
      assert.ok(row, `missing trace subscription for ${definition.event_type_code}`);
    }
  });
});
