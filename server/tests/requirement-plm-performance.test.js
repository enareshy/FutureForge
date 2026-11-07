process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase } from "../db.js";
import "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { ensureRequirementsFoundation, Requirements } from "../services/requirements/index.js";
import { ensureChangeFoundation, Change } from "../services/change/index.js";
import { ensurePdmFoundation, Items } from "../services/pdm/index.js";
import { ensureBomFoundation, Definitions as BomDefinitions, Revisions as BomRevisions, Lines as BomLines } from "../services/bom/index.js";
import * as RPDM from "../services/requirement-pdm/index.js";

// Bounded performance smoke tests (spec section 38: performance tests). These
// build non-trivial structures/graphs and assert the integration projects them
// completely within a generous wall-clock budget, guarding against N+1 reads and
// accidental full-table materialisation. Counts are kept moderate for the 2 vCPU
// CI environment while still crossing the batch/pagination boundaries.
const EBOM_LINE_COUNT = 250;
const REQUIREMENT_COUNT = 150;
const ITEM_COUNT = 120;
const EVENT_COUNT = 400;
const CHANGE_COUNT = 60;
const BUDGET_MS = 60_000;

describe("Requirement -> PLM performance smoke", () => {
  let db;
  let tenant;
  let actor;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('rplm-perf', 'RPLM Perf', 'organization')").run();
    tenant = db.prepare("SELECT id FROM organizations WHERE code = 'rplm-perf'").get().id;
    db.prepare("UPDATE organizations SET tenant_id = id WHERE id = ?").run(tenant);
    db.prepare(
      "INSERT INTO users (username, email, employee_id, display_name, organization_id, tenant_id, password_hash, password_salt) VALUES ('rplm-perf-owner','rplm-perf-owner@example.com','EMP-RPLMPERF','RPLM Perf Owner',?,?,?,?)"
    ).run(tenant, tenant, "x", "y");
    const owner = db.prepare("SELECT id FROM users WHERE username = 'rplm-perf-owner'").get();
    actor = { id: owner.id, tenant_id: tenant };

    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureChangeFoundation(db);
    ensurePdmFoundation(db);
    ensureBomFoundation(db);
    RPDM.ensureRequirementPdmFoundation(db);
  });

  after(() => {
    db?.close();
  });

  test("traverses a large EBOM without exploding", async () => {
    const requirement = Requirements.createRequirement(db, tenant, { title: "Large EBOM requirement", requirement_type: "product_requirement" }, actor, null);
    RPDM.ensureRequirementObject(db, tenant, Requirements.getRequirementRow(db, tenant, requirement.id), actor, null);

    const header = BomDefinitions.createBom(db, tenant, { bom_number: "EBOM-PERF-BIG", name: "Large EBOM", bom_type: "EBOM" }, actor, null);
    const revision = BomRevisions.createRevision(db, tenant, header.id, { revision_number: "A1" }, actor, null);
    for (let i = 0; i < EBOM_LINE_COUNT; i += 1) {
      BomLines.addLine(db, tenant, revision.id, { child_object_id: `PART-${i}`, quantity: 1, uom: "EA" }, actor, null);
    }
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "SATISFIED_BY", target_type: "bom_revision", target_id: revision.id }, actor, null);

    const started = Date.now();
    const trace = await RPDM.bomRevisionStructureAsync(db, tenant, revision.id, {});
    const view = await RPDM.listRequirementStructuresAsync(db, tenant, requirement.id, {});
    const elapsed = Date.now() - started;

    assert.equal(trace.nodes.length, EBOM_LINE_COUNT);
    assert.equal(trace.line_count, EBOM_LINE_COUNT);
    assert.equal(view.by_type.EBOM[0].structure.line_count, EBOM_LINE_COUNT);
    assert.ok(elapsed < BUDGET_MS, `large EBOM projection took ${elapsed}ms`);
  });

  test("projects many requirements through paginated allocations", async () => {
    const started = Date.now();
    const rows = [];
    for (let i = 0; i < REQUIREMENT_COUNT; i += 1) {
      const requirement = Requirements.createRequirement(db, tenant, { title: `Perf requirement ${i}`, requirement_type: "product_requirement" }, actor, null);
      rows.push(requirement);
    }
    // Allocate a single product to every requirement.
    const product = Items.createItem(db, tenant, { item_number: "PERF-PROD", name: "Perf Product", item_type: "PRODUCT" });
    for (const requirement of rows) {
      RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "ALLOCATED_TO", target_type: "pdm_item", target_id: product.id }, actor, null);
    }

    const page = await RPDM.listAllocationsAsync(db, tenant, { relationship_type: "ALLOCATED_TO", page: 1, pageSize: 50 });
    assert.equal(page.total, REQUIREMENT_COUNT);
    assert.equal(page.items.length, 50);
    assert.equal(page.page, 1);
    assert.ok(page.page_size <= page.total);

    const second = await RPDM.listAllocationsAsync(db, tenant, { relationship_type: "ALLOCATED_TO", page: 2, pageSize: 50 });
    assert.equal(second.items.length, 50);
    assert.equal(second.page, 2);

    const elapsed = Date.now() - started;
    assert.ok(elapsed < BUDGET_MS, `many requirements took ${elapsed}ms`);
  });

  test("analyzes impact over a wide allocation graph", async () => {
    const requirement = Requirements.createRequirement(db, tenant, { title: "Wide impact requirement", requirement_type: "product_requirement" }, actor, null);
    RPDM.ensureRequirementObject(db, tenant, Requirements.getRequirementRow(db, tenant, requirement.id), actor, null);
    for (let i = 0; i < ITEM_COUNT; i += 1) {
      const item = Items.createItem(db, tenant, { item_number: `PERF-ITEM-${i}`, name: `Perf item ${i}`, item_type: "PART" });
      RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "ALLOCATED_TO", target_type: "pdm_item", target_id: item.id }, actor, null);
    }

    const started = Date.now();
    const report = await RPDM.analyzeRequirementImpactAsync(db, tenant, requirement.id, { maxDepth: 3 }, actor, null);
    const elapsed = Date.now() - started;

    assert.ok(report.impacted_count >= ITEM_COUNT, `expected >= ${ITEM_COUNT} impacted, got ${report.impacted_count}`);
    assert.ok(report.node_count >= report.impacted_count);
    assert.equal(report.items.length, report.impacted_count);
    assert.ok(elapsed < BUDGET_MS, `wide impact analysis took ${elapsed}ms`);
  });

  test("handles a high event volume", () => {
    const started = Date.now();
    for (let i = 0; i < EVENT_COUNT; i += 1) {
      RPDM.publishRequirementPdmEvent(
        db,
        { eventType: "RequirementPDMTraceCreated", objectType: "requirement", objectId: String(i + 1), tenantId: tenant, payload: { i } },
        actor
      );
    }
    const emitted = Number(db.prepare("SELECT COUNT(*) AS c FROM event_outbox WHERE event_type_code = 'RequirementPDMTraceCreated'").get().c);
    const elapsed = Date.now() - started;
    assert.ok(emitted >= EVENT_COUNT, `expected >= ${EVENT_COUNT} events, got ${emitted}`);
    assert.ok(elapsed < BUDGET_MS, `high event volume took ${elapsed}ms`);
  });

  test("initiates one change request per requirement under repeated evaluation", () => {
    RPDM.setConfig(db, tenant, "auto_change_request", true);
    const started = Date.now();
    let created = 0;
    let existing = 0;
    for (let i = 0; i < CHANGE_COUNT; i += 1) {
      const requirement = Requirements.createRequirement(db, tenant, { title: `Change requirement ${i}`, requirement_type: "product_requirement", priority: "HIGH" }, actor, null);
      RPDM.ensureRequirementObject(db, tenant, Requirements.getRequirementRow(db, tenant, requirement.id), actor, null);
      const first = RPDM.initiateChangeRequest(db, tenant, requirement.id, { force: true }, actor, null);
      const second = RPDM.initiateChangeRequest(db, tenant, requirement.id, { force: true }, actor, null);
      if (first.status === "CREATED") created += 1;
      if (second.status === "EXISTING") existing += 1;
      assert.equal(second.change.id, first.change.id);
      assert.equal(RPDM.listRequirementChanges(db, tenant, requirement.id).total, 1);
    }
    const elapsed = Date.now() - started;
    assert.equal(created, CHANGE_COUNT);
    assert.equal(existing, CHANGE_COUNT);
    assert.ok(elapsed < BUDGET_MS, `change initiation took ${elapsed}ms`);
  });

  test("traverses large MBOM and BOP structures", async () => {
    const requirement = Requirements.createRequirement(db, tenant, { title: "Large MBOM/BOP requirement", requirement_type: "product_requirement" }, actor, null);

    const mbom = BomDefinitions.createBom(db, tenant, { bom_number: "MBOM-PERF-BIG", name: "Large MBOM", bom_type: "MBOM" }, actor, null);
    const mbomRevision = BomRevisions.createRevision(db, tenant, mbom.id, { revision_number: "A1" }, actor, null);
    const bop = BomDefinitions.createBom(db, tenant, { bom_number: "BOP-PERF-BIG", name: "Large BOP", bom_type: "BOP" }, actor, null);
    const bopRevision = BomRevisions.createRevision(db, tenant, bop.id, { revision_number: "A1" }, actor, null);
    for (let i = 0; i < EBOM_LINE_COUNT; i += 1) {
      BomLines.addLine(db, tenant, mbomRevision.id, { child_object_id: `M-${i}`, quantity: 1, uom: "EA" }, actor, null);
      BomLines.addLine(db, tenant, bopRevision.id, { child_object_id: `OP-${i}`, quantity: 1, uom: "EA" }, actor, null);
    }
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "SATISFIED_BY", target_type: "bom_revision", target_id: mbomRevision.id }, actor, null);
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "REALIZED_BY", target_type: "bom_revision", target_id: bopRevision.id }, actor, null);

    const started = Date.now();
    const view = await RPDM.listRequirementStructuresAsync(db, tenant, requirement.id, {});
    const elapsed = Date.now() - started;

    assert.equal(view.by_type.MBOM[0].structure.line_count, EBOM_LINE_COUNT);
    assert.equal(view.by_type.BOP[0].structure.line_count, EBOM_LINE_COUNT);
    assert.ok(elapsed < BUDGET_MS, `large MBOM/BOP projection took ${elapsed}ms`);
  });

  test("resolves a large reverse traceability graph", () => {
    const header = BomDefinitions.createBom(db, tenant, { bom_number: "EBOM-PERF-TRACE", name: "Traceable EBOM", bom_type: "EBOM" }, actor, null);
    const revision = BomRevisions.createRevision(db, tenant, header.id, { revision_number: "A1" }, actor, null);
    for (let i = 0; i < REQUIREMENT_COUNT; i += 1) {
      const requirement = Requirements.createRequirement(db, tenant, { title: `Trace requirement ${i}`, requirement_type: "product_requirement" }, actor, null);
      RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "SATISFIED_BY", target_type: "bom_revision", target_id: revision.id }, actor, null);
    }

    const started = Date.now();
    const reverse = RPDM.listStructureRequirements(db, tenant, revision.id, {});
    const elapsed = Date.now() - started;

    assert.equal(reverse.total, REQUIREMENT_COUNT);
    assert.ok(reverse.items.length > 0 && reverse.items.length <= reverse.total, "reverse traceability is paginated, not fully materialised");
    assert.ok(elapsed < BUDGET_MS, `large reverse traceability took ${elapsed}ms`);
  });

  test("initiates concurrent change requests without duplicates", async () => {
    RPDM.setConfig(db, tenant, "auto_change_request", true);
    const report = { impacted_count: 3, released_impacted: true, recommendation: { change_candidate: true, reasons: ["released_object_impacted"] } };
    const requirements = [];
    for (let i = 0; i < 8; i += 1) {
      const requirement = Requirements.createRequirement(db, tenant, { title: `Concurrent change ${i}`, requirement_type: "product_requirement", priority: "HIGH" }, actor, null);
      RPDM.ensureRequirementObject(db, tenant, Requirements.getRequirementRow(db, tenant, requirement.id), actor, null);
      requirements.push(requirement);
    }

    const started = Date.now();
    const results = await Promise.all(
      requirements.map((requirement) => RPDM.initiateChangeRequestAsync(db, tenant, requirement.id, { force: true, impact: report }, actor, null))
    );
    const elapsed = Date.now() - started;

    assert.equal(new Set(results.map((result) => result.change.id)).size, requirements.length, "each requirement gets its own change request");
    assert.ok(results.every((result) => result.status === "CREATED"));
    for (const requirement of requirements) {
      assert.equal(RPDM.listRequirementChanges(db, tenant, requirement.id).total, 1);
    }
    assert.ok(elapsed < BUDGET_MS, `concurrent change initiation took ${elapsed}ms`);
  });
});
