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

// Failure/recovery coverage for the Requirement -> PLM integration (spec section
// 38: failure tests). Each permutation exercises a real integration seam and
// verifies that the failure is surfaced, leaves no partial state, and recovers on
// retry using the existing (reused) engines.
describe("Requirement -> PLM failure and recovery coverage", () => {
  let db;
  let tenant;
  let actor;
  let productItem;
  let ebomRevision;
  let counter = 0;

  const nextNumber = (prefix) => `${prefix}-${Date.now()}-${(counter += 1)}`;

  function report(overrides = {}) {
    return {
      impacted_count: 5,
      released_count: 2,
      released_impacted: true,
      category_totals: { DIRECT: 1, RELEASED: 2 },
      recommendation: { change_candidate: true, reasons: ["released_object_impacted"] },
      ...overrides,
    };
  }

  function throwingImpact(message) {
    const options = {};
    Object.defineProperty(options, "impact", {
      get() {
        throw new Error(message);
      },
    });
    return options;
  }

  function newRequirement(overrides = {}) {
    const requirement = Requirements.createRequirement(
      db,
      tenant,
      { title: `Failure requirement ${counter += 1}`, requirement_type: "product_requirement", priority: "HIGH", ...overrides },
      actor,
      null
    );
    RPDM.ensureRequirementObject(db, tenant, Requirements.getRequirementRow(db, tenant, requirement.id), actor, null);
    return Requirements.getRequirementRow(db, tenant, requirement.id);
  }

  function approvedRequestFor(requirement) {
    const initiated = RPDM.initiateChangeRequest(db, tenant, requirement.id, { force: true, impact: report() }, actor, null);
    assert.equal(initiated.status, "CREATED");
    Change.submitRequest(db, tenant, initiated.change.id, actor, null);
    const approved = Change.screenRequest(db, tenant, initiated.change.id, "APPROVED", "CCB approved", actor, null);
    assert.equal(approved.status, "APPROVED");
    return initiated.change;
  }

  before(() => {
    db = openTestDatabase();
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('rplm-fail', 'RPLM Fail', 'organization')").run();
    tenant = db.prepare("SELECT id FROM organizations WHERE code = 'rplm-fail'").get().id;
    db.prepare("UPDATE organizations SET tenant_id = id WHERE id = ?").run(tenant);
    db.prepare(
      "INSERT INTO users (username, email, employee_id, display_name, organization_id, tenant_id, password_hash, password_salt) VALUES ('rplm-fail-owner','rplm-fail-owner@example.com','EMP-RPLMFAIL','RPLM Fail Owner',?,?,?,?)"
    ).run(tenant, tenant, "x", "y");
    db.prepare(
      "INSERT INTO users (username, email, employee_id, display_name, organization_id, tenant_id, password_hash, password_salt) VALUES ('rplm-fail-nobody','rplm-fail-nobody@example.com','EMP-RPLMFAILN','RPLM Fail Nobody',?,?,?,?)"
    ).run(tenant, tenant, "x", "y");
    const owner = db.prepare("SELECT id FROM users WHERE username = 'rplm-fail-owner'").get();
    actor = { id: owner.id, tenant_id: tenant };

    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureChangeFoundation(db);
    ensurePdmFoundation(db);
    ensureBomFoundation(db);
    RPDM.ensureRequirementPdmFoundation(db);
    RPDM.setConfig(db, tenant, "auto_change_request", true);

    productItem = Items.createItem(db, tenant, { item_number: "FAIL-1000", name: "Failure Product", item_type: "PRODUCT" });
    const header = BomDefinitions.createBom(db, tenant, { bom_number: "EBOM-FAIL-1000", name: "Failure EBOM", bom_type: "EBOM" }, actor, null);
    ebomRevision = BomRevisions.createRevision(db, tenant, header.id, { revision_number: "A1" }, actor, null);
    BomLines.addLine(db, tenant, ebomRevision.id, { child_object_id: "BASE", quantity: 1, uom: "EA" }, actor, null);
    BomLines.addLine(db, tenant, ebomRevision.id, { child_object_id: "CFG-A-PART", quantity: 1, uom: "EA", configuration_context: "CONFIG-A" }, actor, null);
    BomLines.addLine(db, tenant, ebomRevision.id, { child_object_id: "FUTURE-PART", quantity: 1, uom: "EA", effectivity: { start: "2030-01-01" } }, actor, null);
  });

  after(() => {
    db?.close();
  });

  test("event failure during PLM->Requirement sync is captured and retries without duplicates", () => {
    const requirement = newRequirement();
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "ALLOCATED_TO", target_type: "pdm_item", target_id: productItem.id }, actor, null);

    const failed = RPDM.synchronizeFromPlm(
      db,
      tenant,
      { nodeType: "pdm_item", nodeId: productItem.id, analyze: true, impact: () => { throw new Error("simulated event delivery failure"); } },
      actor,
      null
    );
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.requirements[0].analysis_status, "FAILED");
    assert.match(String(failed.requirements[0].error || ""), /event delivery failure/);
    assert.ok(Number(db.prepare("SELECT COUNT(*) AS c FROM event_outbox WHERE event_type_code = 'RequirementPLMSynchronizationFailed'").get().c) >= 1);

    const relationshipsBefore = Number(db.prepare("SELECT COUNT(*) AS c FROM requirement_relationships WHERE tenant_id = ?").get(tenant).c);

    const recovered = RPDM.synchronizeFromPlm(db, tenant, { nodeType: "pdm_item", nodeId: productItem.id, analyze: true, impact: report() }, actor, null);
    assert.equal(recovered.status, "COMPLETED");
    assert.equal(recovered.requirements[0].analysis_status, "ANALYZED");
    assert.equal(RPDM.listRequirementChanges(db, tenant, requirement.id).total, 0, "no change request is created by synchronization");
    assert.equal(Number(db.prepare("SELECT COUNT(*) AS c FROM requirement_relationships WHERE tenant_id = ?").get(tenant).c), relationshipsBefore, "a failed sync must not leave partial relationships");
  });

  test("API timeout during change initiation is surfaced and retried idempotently", () => {
    const requirement = newRequirement();
    assert.throws(() => RPDM.initiateChangeRequest(db, tenant, requirement.id, throwingImpact("ETIMEDOUT: impact analyzer timed out"), actor, null), /ETIMEDOUT/);
    assert.equal(RPDM.listRequirementChanges(db, tenant, requirement.id).total, 0, "no partial change request on timeout");

    const first = RPDM.initiateChangeRequest(db, tenant, requirement.id, { force: true, impact: report() }, actor, null);
    assert.equal(first.status, "CREATED");
    const retry = RPDM.initiateChangeRequest(db, tenant, requirement.id, { force: true, impact: report() }, actor, null);
    assert.equal(retry.status, "EXISTING");
    assert.equal(retry.change.id, first.change.id);
    assert.equal(RPDM.listRequirementChanges(db, tenant, requirement.id).total, 1);
  });

  test("database failure is surfaced, leaves no partial state and recovers", () => {
    const requirement = newRequirement();
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "ALLOCATED_TO", target_type: "pdm_item", target_id: productItem.id }, actor, null);

    const failed = RPDM.synchronizeFromPlm(
      db,
      tenant,
      { nodeType: "pdm_item", nodeId: productItem.id, analyze: true, impact: () => { throw new Error("SQLSTATE 08006: database connection failure"); } },
      actor,
      null
    );
    assert.equal(failed.status, "FAILED");
    assert.match(String(failed.requirements[0].error || ""), /database connection failure/);

    const recovered = RPDM.synchronizeFromPlm(db, tenant, { nodeType: "pdm_item", nodeId: productItem.id, analyze: true, impact: report() }, actor, null);
    assert.equal(recovered.status, "COMPLETED");
    assert.equal(RPDM.requirementDocuments(db, tenant, requirement.id).total, 0);
    assert.equal(RPDM.listRequirementChanges(db, tenant, requirement.id).total, 0);
  });

  test("workflow failure: an invalid Change Request transition is rejected", () => {
    const requirement = newRequirement();
    const initiated = RPDM.initiateChangeRequest(db, tenant, requirement.id, { force: true, impact: report() }, actor, null);
    assert.equal(initiated.status, "CREATED");

    assert.throws(
      () => Change.screenRequest(db, tenant, initiated.change.id, "APPROVED", "skip submit", actor, null),
      /transition|state|status|invalid/i,
      "screening a DRAFT request must be rejected by the existing workflow"
    );

    Change.submitRequest(db, tenant, initiated.change.id, actor, null);
    const approved = Change.screenRequest(db, tenant, initiated.change.id, "APPROVED", "now valid", actor, null);
    assert.equal(approved.status, "APPROVED");
    assert.equal(RPDM.listRequirementChanges(db, tenant, requirement.id).total, 1);
  });

  test("approval failure: a rejected Change Order cannot be released and a fresh chain recovers", () => {
    const requirement = newRequirement();
    const request = approvedRequestFor(requirement);
    const order = Change.promoteRequest(db, tenant, request.id, {}, actor, null).order;
    Change.submitOrder(db, tenant, order.id, actor, null);
    const rejected = Change.decideOrder(db, tenant, order.id, "REJECTED", actor, null);
    assert.equal(rejected.status, "REJECTED");
    assert.throws(() => Change.releaseOrder(db, tenant, order.id, actor, null), /release|approved|state|status/i);

    // Recovery: a new approved order in the same product can be released.
    const request2 = approvedRequestFor(newRequirement());
    const order2 = Change.promoteRequest(db, tenant, request2.id, {}, actor, null).order;
    Change.addAffectedItem(db, tenant, order2.id, { object_type: "pdm_item", object_id: String(productItem.id), disposition: "NEW_REVISION" }, actor, null);
    Change.submitOrder(db, tenant, order2.id, actor, null);
    Change.decideOrder(db, tenant, order2.id, "APPROVED", actor, null);
    const released = Change.releaseOrder(db, tenant, order2.id, actor, null);
    assert.equal(released.order.status, "RELEASED");
  });

  test("release failure: a Change Notice cannot be issued before the Change Order is released", () => {
    const requirement = newRequirement();
    const request = approvedRequestFor(requirement);
    const order = Change.promoteRequest(db, tenant, request.id, {}, actor, null).order;
    Change.addAffectedItem(db, tenant, order.id, { object_type: "pdm_item", object_id: String(productItem.id), disposition: "NEW_REVISION" }, actor, null);
    Change.submitOrder(db, tenant, order.id, actor, null);
    Change.decideOrder(db, tenant, order.id, "APPROVED", actor, null);

    assert.throws(
      () => Change.createNotice(db, tenant, { notice_number: nextNumber("ECN"), title: "early notice", change_order_id: order.id }, actor, null),
      /release|state|status|approved/i,
      "a notice must not be created for an unreleased order"
    );

    const released = Change.releaseOrder(db, tenant, order.id, actor, null);
    assert.equal(released.order.status, "RELEASED");
    const notice = Change.createNotice(db, tenant, { notice_number: nextNumber("ECN"), title: "valid notice", change_order_id: order.id }, actor, null);
    const issued = Change.issueNotice(db, tenant, notice.id, actor, null);
    assert.equal(issued.status, "ISSUED");
  });

  test("permission failure: change actions are rejected without grants and write nothing", () => {
    const requirement = newRequirement();
    const nobody = db.prepare("SELECT id, tenant_id FROM users WHERE username = 'rplm-fail-nobody'").get();

    assert.throws(
      () => RPDM.requireRequirementPdmAction(db, null, { resource: RPDM.REQUIREMENT_PDM_RESOURCES.changeInitiation, action: "execute" }),
      /Not authorized/
    );
    assert.throws(
      () => RPDM.requireRequirementPdmAction(db, nobody, { resource: RPDM.REQUIREMENT_PDM_RESOURCES.changeInitiation, action: "execute" }),
      /Not authorized/
    );
    assert.equal(RPDM.listRequirementChanges(db, tenant, requirement.id).total, 0, "no change request is written when authorization fails");
  });

  test("configuration mismatch: structures are scoped by configuration context", () => {
    const requirement = newRequirement();
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "SATISFIED_BY", target_type: "bom_revision", target_id: ebomRevision.id }, actor, null);

    const matching = RPDM.listRequirementStructures(db, tenant, requirement.id, { configuration: "CONFIG-A" });
    assert.equal(matching.by_type.EBOM[0].structure.line_count, 3, "matching context keeps the base, CONFIG-A and context-free lines");
    const mismatched = RPDM.listRequirementStructures(db, tenant, requirement.id, { configuration: "CONFIG-B" });
    assert.equal(mismatched.by_type.EBOM[0].structure.line_count, 2, "mismatched context drops the CONFIG-A-only line");
  });

  test("effectivity mismatch: future-dated lines are excluded now and included in the future", () => {
    const requirement = newRequirement();
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "SATISFIED_BY", target_type: "bom_revision", target_id: ebomRevision.id }, actor, null);

    const past = RPDM.listRequirementStructures(db, tenant, requirement.id, { asOf: "2026-01-01" });
    const future = RPDM.listRequirementStructures(db, tenant, requirement.id, { asOf: "2031-01-01" });
    assert.equal(past.by_type.EBOM[0].structure.line_count, 2, "the 2030 line is not yet effective");
    assert.equal(future.by_type.EBOM[0].structure.line_count, 3, "the 2030 line becomes effective");
  });
});
