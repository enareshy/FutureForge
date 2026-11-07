process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase } from "../db.js";
import "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { ensureRequirementsFoundation, Requirements } from "../services/requirements/index.js";
import { ensureChangeFoundation, Change } from "../services/change/index.js";
import { ensurePdmFoundation, Items, Revisions, RevisionRules } from "../services/pdm/index.js";
import {
  ensureBomFoundation,
  Definitions as BomDefinitions,
  Revisions as BomRevisions,
  Lines as BomLines,
  Transformation as BomTransformation,
} from "../services/bom/index.js";
import * as RPDM from "../services/requirement-pdm/index.js";

// End-to-end scenario (spec section 37): Requirement -> Product -> EBOM ->
// MBOM -> BOP -> Change Management, exercising the integration across the
// existing PDM, BOM, Change, Lifecycle, Thread, Content and Audit engines.
describe("Requirement -> PLM end-to-end scenario", () => {
  let db;
  let tenant;
  let actor;
  let owner;

  let requirement;
  let productItem;
  let productRevision;
  let ebomRevision;
  let mbomRevision;
  let bopRevision;
  let transformedRun;

  let changeRequest;
  let changeOrder;
  let changeNotice;

  const contentIds = [];

  function attach(objectType, objectId, fileName, role = "ATTACHMENT") {
    const stamp = `${Date.now()}-${contentIds.length}-${Math.floor(Math.random() * 1e6)}`;
    const contentId = `E2E-CNT-${stamp}`;
    db.prepare(
      "INSERT INTO content (content_id, content_key, tenant_id, file_name, object_type, object_id, status, security_status, content_type) VALUES (?, ?, ?, ?, ?, ?, 'available', 'clean', 'document')"
    ).run(contentId, `key-${stamp}`, tenant, fileName, objectType, String(objectId));
    const id = db.prepare("SELECT id FROM content WHERE content_id = ?").get(contentId).id;
    db.prepare(
      "INSERT INTO content_associations (association_ref, tenant_id, object_type, object_id, object_name, content_id, content_role, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')"
    ).run(`E2E-ASN-${stamp}`, tenant, objectType, String(objectId), fileName, id, role);
    contentIds.push(id);
    return id;
  }

  before(() => {
    db = openTestDatabase();
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('rplm-e2e', 'RPLM E2E', 'organization')").run();
    tenant = db.prepare("SELECT id FROM organizations WHERE code = 'rplm-e2e'").get().id;
    db.prepare("UPDATE organizations SET tenant_id = id WHERE id = ?").run(tenant);
    db.prepare(
      "INSERT INTO users (username, email, employee_id, display_name, organization_id, tenant_id, password_hash, password_salt) VALUES ('rplm-e2e-owner','rplm-e2e-owner@example.com','EMP-RPLME2E','RPLM E2E Owner',?,?,?,?)"
    ).run(tenant, tenant, "x", "y");
    owner = db.prepare("SELECT id FROM users WHERE username = 'rplm-e2e-owner'").get();
    actor = { id: owner.id, tenant_id: tenant };

    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureChangeFoundation(db);
    ensurePdmFoundation(db);
    ensureBomFoundation(db);
    RPDM.ensureRequirementPdmFoundation(db);

    // Steps 1-2: create the requirement and allocate it to a product.
    requirement = Requirements.createRequirement(
      db,
      tenant,
      { title: "R-1001 — product requirement", requirement_type: "product_requirement", priority: "HIGH", criticality: "CRITICAL" },
      actor,
      null
    );
    RPDM.ensureRequirementObject(db, tenant, Requirements.getRequirementRow(db, tenant, requirement.id), actor, null);

    productItem = Items.createItem(db, tenant, { item_number: "P-100", name: "Product P-100", item_type: "PRODUCT" });
    const rule = RevisionRules.createRevisionRule(db, tenant, { code: "E2E-LATEST", rule_type: "LATEST_WORKING", is_default: true });
    RevisionRules.activateRevisionRule(db, tenant, rule.id);
    productRevision = Revisions.createRevision(db, tenant, "P-100", { revision_number: "A1", description: "initial" });

    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "ALLOCATED_TO", target_type: "pdm_item", target_id: productItem.id, configuration_context: "CONFIG-A" }, actor, null);
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "IMPLEMENTED_BY", target_type: "pdm_revision", target_id: productRevision.id }, actor, null);

    // Step 3-5: engineering, manufacturing and process structures.
    const ebom = BomDefinitions.createBom(db, tenant, { bom_number: "EBOM-E2E-1000", name: "Engineering BOM", bom_type: "EBOM" }, actor, null);
    ebomRevision = BomRevisions.createRevision(db, tenant, ebom.id, { revision_number: "A1" }, actor, null);
    BomLines.addLine(db, tenant, ebomRevision.id, { child_object_id: "ASSY", quantity: 1, uom: "EA", find_number: "10" }, actor, null);
    BomLines.addLine(db, tenant, ebomRevision.id, { child_object_id: "SUB", parent_object_id: "ASSY", quantity: 2, uom: "EA", find_number: "10.1" }, actor, null);
    BomLines.addLine(db, tenant, ebomRevision.id, { child_object_id: "LEAF", parent_object_id: "SUB", quantity: 4, uom: "EA", find_number: "10.1.1" }, actor, null);
    BomLines.addLine(db, tenant, ebomRevision.id, { child_object_id: "FUTURE", quantity: 1, uom: "EA", effectivity: { start: "2030-01-01" } }, actor, null);

    // Step 4: transform EBOM -> MBOM through the existing BOM transformation engine.
    const definition = BomTransformation.createTransformationDefinition(
      db,
      tenant,
      { code: "E2E-EBOM-MBOM", name: "EBOM to MBOM", source_bom_type: "EBOM", target_bom_type: "MBOM", status: "ACTIVE", config: { allow_unmapped: true } },
      actor,
      null
    );
    transformedRun = BomTransformation.transform(
      db,
      tenant,
      { definition_id: definition.id, source_revision_id: ebomRevision.id, mode: "EXECUTE", target_bom_number: "MBOM-E2E-TRANSFORMED" },
      actor,
      null
    );

    const mbom = BomDefinitions.createBom(db, tenant, { bom_number: "MBOM-E2E-1000", name: "Manufacturing BOM", bom_type: "MBOM" }, actor, null);
    mbomRevision = BomRevisions.createRevision(db, tenant, mbom.id, { revision_number: "A1" }, actor, null);
    BomLines.addLine(db, tenant, mbomRevision.id, { child_object_id: "ASSY-M", quantity: 1, uom: "EA" }, actor, null);

    const bop = BomDefinitions.createBom(db, tenant, { bom_number: "BOP-E2E-1000", name: "Bill of Process", bom_type: "BOP" }, actor, null);
    bopRevision = BomRevisions.createRevision(db, tenant, bop.id, { revision_number: "A1" }, actor, null);
    BomLines.addLine(db, tenant, bopRevision.id, { child_object_id: "OP-10", quantity: 1, uom: "EA" }, actor, null);

    // Step 5: relate MBOM to BOP and both to the requirement.
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "SATISFIED_BY", target_type: "bom_revision", target_id: ebomRevision.id }, actor, null);
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "SATISFIED_BY", target_type: "bom_revision", target_id: mbomRevision.id, configuration_context: "CONFIG-A" }, actor, null);
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "REALIZED_BY", target_type: "bom_revision", target_id: bopRevision.id, effectivity_from: "2026-01-01" }, actor, null);

    // Step 6: link relevant documents across every source category.
    attach("requirement", requirement.id, "requirement-spec.pdf");
    attach("pdm_item", productItem.id, "product-drawing.pdf");
    attach("pdm_revision", productRevision.id, "released-model.step");
    attach("bom_revision", ebomRevision.id, "ebom-bom.pdf");
    attach("bom_revision", mbomRevision.id, "mbom-work-instruction.pdf");
    attach("bom_revision", bopRevision.id, "bop-process-sheet.pdf");

    // Step 8: release the product and the engineering BOM.
    Items.setItemStatus(db, tenant, productItem.id, "RELEASED", actor, null);
    BomRevisions.setRevisionStatus(db, tenant, ebomRevision.id, "IN_REVIEW", actor, null);
    BomRevisions.setRevisionStatus(db, tenant, ebomRevision.id, "RELEASED", actor, null);
  });

  after(() => {
    db?.close();
  });

  test("steps 1-8: requirement projects to product, EBOM/MBOM/BOP and documents", async () => {
    const products = await RPDM.listRequirementProductsAsync(db, tenant, requirement.id, {});
    assert.equal(products.product_count, 1);
    assert.equal(products.products[0].number, "P-100");
    assert.equal(products.products[0].is_released, true);
    assert.equal(products.realization.stage, "RELEASED");

    const lifecycle = await RPDM.productLifecycleAsync(db, tenant, productItem.id);
    assert.equal(lifecycle.is_released, true);
    assert.equal(lifecycle.lifecycle_category, "released");

    const structures = await RPDM.listRequirementStructuresAsync(db, tenant, requirement.id, {});
    assert.equal(structures.total, 3);
    assert.deepEqual(structures.counts_by_type, { EBOM: 1, MBOM: 1, BOP: 1, OTHER: 0 });
    assert.equal(structures.by_type.EBOM[0].structure.line_count, 4);
    assert.equal(structures.by_type.EBOM[0].is_released, true);
    assert.deepEqual(structures.coverage.covered_types.sort(), ["BOP", "EBOM", "MBOM"]);
    assert.equal(structures.coverage.missing_types.length, 0);

    const documents = await RPDM.requirementDocumentsAsync(db, tenant, requirement.id);
    assert.equal(documents.total, 6);
    assert.equal(documents.by_category.REQUIREMENT.length, 1);
    assert.equal(documents.by_category.PRODUCT.length, 2);
    assert.equal(documents.by_category.STRUCTURE.length, 3);
  });

  test("step 4: the EBOM -> MBOM transformation completed through the BOM engine", () => {
    assert.equal(transformedRun.run.status, "COMPLETED");
    assert.ok(transformedRun.run.target_revision_id, "transformation produced a target revision");
    assert.ok(transformedRun.summary.lines >= 3);
  });

  test("steps 11-16: impact analysis identifies product, EBOM, MBOM, BOP and evaluates configuration/effectivity", async () => {
    // Step 9-10: modify the requirement and publish a RequirementUpdated event.
    Requirements.updateRequirement(db, tenant, requirement.id, { title: "R-1001 — revised product requirement" }, actor, null);

    const revisedEvent = db.prepare("SELECT COUNT(*) AS c FROM event_outbox WHERE event_type_code = 'RequirementUpdated'").get().c;
    assert.ok(Number(revisedEvent) >= 1, "RequirementUpdated event must be published");

    const report = await RPDM.analyzeRequirementImpactAsync(db, tenant, requirement.id, {}, actor, null);
    assert.ok(report.impacted_count >= 4, `expected >=4 impacted, got ${report.impacted_count}`);
    assert.equal(report.recommendation.change_candidate, true);
    assert.ok(report.object_type_totals.pdm_item >= 1);
    assert.ok(report.object_type_totals.pdm_revision >= 1);
    assert.ok(report.object_type_totals.bom_revision >= 3);
    assert.ok(report.domain_totals.EBOM >= 1);
    assert.ok(report.domain_totals.MBOM >= 1);
    assert.ok(report.domain_totals.BOP >= 1);

    // Configuration context is projected onto the allocations.
    const allocations = await RPDM.listRequirementAllocationsAsync(db, tenant, requirement.id, {});
    const configured = allocations.items.filter((item) => item.configuration_context === "CONFIG-A");
    assert.ok(configured.length >= 2, "configuration context must be preserved on allocations");

    // Effectivity filtering on the structure projection: the future-dated EBOM
    // line is excluded when evaluating the structure as of an earlier date.
    const asOfNow = await RPDM.listRequirementStructuresAsync(db, tenant, requirement.id, {});
    const asOfPast = await RPDM.listRequirementStructuresAsync(db, tenant, requirement.id, { asOf: "2026-01-01" });
    assert.equal(asOfNow.by_type.EBOM[0].structure.line_count, 4);
    assert.equal(asOfPast.by_type.EBOM[0].structure.line_count, 3);
  });

  test("steps 17-24: applies change rules and drives the CR -> ECO -> ECN chain", () => {
    RPDM.setConfig(db, tenant, "auto_change_request", true);

    // Step 17-19: evaluate rules and auto-initiate an existing Change Request.
    const preview = RPDM.evaluateRequirementChangeInitiation(db, tenant, requirement.id, {}, actor, null);
    assert.equal(preview.decision.initiate, true);
    assert.equal(preview.decision.severity, "CRITICAL");
    assert.ok(preview.decision.matched_rules.includes("AUTO_CHANGE_REQUEST"));

    const initiated = RPDM.initiateChangeRequest(db, tenant, requirement.id, {}, actor, null);
    assert.equal(initiated.status, "CREATED");
    assert.equal(initiated.created, true);
    assert.match(initiated.change.request_number, /^ECR-/);
    changeRequest = initiated.change;

    // Idempotency: a repeated event must not create a duplicate change request.
    const repeat = RPDM.initiateChangeRequest(db, tenant, requirement.id, {}, actor, null);
    assert.equal(repeat.status, "EXISTING");
    assert.equal(repeat.change.id, changeRequest.id);
    assert.equal(RPDM.listRequirementChanges(db, tenant, requirement.id).total, 1);

    // Step 19: execute the Change Request workflow (submit -> screen/approve).
    Change.submitRequest(db, tenant, changeRequest.id, actor, null);
    const approvedRequest = Change.screenRequest(db, tenant, changeRequest.id, "APPROVED", "CCB approved", actor, null);
    assert.equal(approvedRequest.status, "APPROVED");

    // Step 20: promote the request to a Change Order.
    const promoted = Change.promoteRequest(db, tenant, changeRequest.id, {}, actor, null);
    changeOrder = promoted.order;
    assert.equal(changeOrder.status, "DRAFT");

    // Step 21: attach affected PLM items and execute the order lifecycle.
    Change.addAffectedItem(db, tenant, changeOrder.id, { object_type: "pdm_item", object_id: String(productItem.id), disposition: "NEW_REVISION" }, actor, null);
    Change.addAffectedItem(db, tenant, changeOrder.id, { object_type: "bom_revision", object_id: String(ebomRevision.id), disposition: "NEW_REVISION" }, actor, null);
    Change.submitOrder(db, tenant, changeOrder.id, actor, null);
    const decided = Change.decideOrder(db, tenant, changeOrder.id, "APPROVED", actor, null);
    assert.equal(decided.status, "APPROVED");
    const released = Change.releaseOrder(db, tenant, changeOrder.id, actor, null);
    assert.equal(released.order.status, "RELEASED");

    // Step 20/22: issue a Change Notice (existing ECN workflow).
    changeNotice = Change.createNotice(db, tenant, { notice_number: "ECN-E2E-1", title: "E2E notice", change_order_id: changeOrder.id }, actor, null);
    const issued = Change.issueNotice(db, tenant, changeNotice.id, actor, null);
    assert.equal(issued.status, "ISSUED");

    // The integration exposes the full CR -> ECO -> ECN chain.
    const chain = RPDM.requirementChangeChain(db, tenant, requirement.id);
    assert.equal(chain.change_request_count, 1);
    assert.equal(chain.order_count, 1);
    const entry = chain.items[0];
    assert.equal(entry.change_request.change_id, String(changeRequest.id));
    assert.equal(entry.orders.length, 1);
    assert.equal(entry.orders[0].status, "RELEASED");
    assert.equal(entry.orders[0].affected_item_count, 2);
    assert.equal(entry.orders[0].notices.length, 1);
    assert.equal(entry.orders[0].notices[0].number, "ECN-E2E-1");
  });

  test("steps 25-27: PLM release synchronizes back, records traceability and audit history", async () => {
    // Step 25: publishing a PLM release event synchronizes back to the requirement.
    const sync = await RPDM.synchronizeFromPlmAsync(db, tenant, { nodeType: "bom_revision", nodeId: ebomRevision.id, eventType: "BomRevisionReleased" }, actor, null);
    assert.equal(sync.direction, "PLM_TO_REQUIREMENT");
    assert.equal(sync.requirement_count >= 1, true);
    assert.equal(sync.status, "COMPLETED");

    const syncEvents = db.prepare("SELECT COUNT(*) AS c FROM event_outbox WHERE event_type_code = 'RequirementPLMChangeSynchronized'").get().c;
    assert.ok(Number(syncEvents) >= 1, "synchronization event must be published");

    // Step 26: reverse navigation from PLM nodes back to requirements.
    const reverse = RPDM.requirementsForPlmNode(db, tenant, "bom_revision", ebomRevision.id);
    assert.equal(reverse.total, 1);
    assert.equal(reverse.requirements[0].id, requirement.id);

    // Step 27: complete audit history.
    const audit = db.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action LIKE 'requirement-pdm.%'").get().c;
    assert.ok(Number(audit) >= 1, "requirement-pdm audit entries must be recorded");
    const history = db.prepare("SELECT COUNT(*) AS c FROM requirement_history").get().c;
    assert.ok(Number(history) >= 1, "requirement history must be recorded");

    const metrics = await RPDM.plmMetricsAsync(db, tenant);
    assert.ok(metrics.allocations.total >= 5);
    assert.ok(metrics.change_requests.total >= 1);
    assert.ok(metrics.change_orders.total >= 1);
    assert.ok(metrics.change_notices.total >= 1);
    assert.ok(metrics.events.synchronized >= 1);
    assert.ok(metrics.allowed_statuses.includes(metrics.status));
  });
});
