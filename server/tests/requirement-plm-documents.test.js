process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase } from "../db.js";
import "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { ensureRequirementsFoundation, Requirements } from "../services/requirements/index.js";
import { ensureChangeFoundation, Change } from "../services/change/index.js";
import { ensurePdmFoundation, Items, Revisions, RevisionRules } from "../services/pdm/index.js";
import { ensureBomFoundation, Definitions as BomDefinitions, Revisions as BomRevisions } from "../services/bom/index.js";
import * as RPDM from "../services/requirement-pdm/index.js";

describe("Requirement -> PLM document projection", () => {
  let db;
  let tenant;
  let actor;
  let requirement;
  let productItem;
  let revision;
  let bomRevision;
  let changeRequest;
  let changeOrder;
  let changeNotice;

  const contentIds = [];

  function attach(objectType, objectId, fileName, { status = "available", security = "clean" } = {}) {
    const stamp = `${Date.now()}-${contentIds.length}-${Math.floor(Math.random() * 1e6)}`;
    const contentId = `CNT-${stamp}`;
    const inserted = db
      .prepare(
        "INSERT INTO content (content_id, content_key, tenant_id, file_name, object_type, object_id, status, security_status, content_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'document')"
      )
      .run(contentId, `key-${stamp}`, tenant, fileName, objectType, String(objectId), status, security);
    const id = db.prepare("SELECT id FROM content WHERE content_id = ?").get(contentId).id;
    db.prepare(
      "INSERT INTO content_associations (association_ref, tenant_id, object_type, object_id, object_name, content_id, content_role, status) VALUES (?, ?, ?, ?, ?, ?, 'ATTACHMENT', 'active')"
    ).run(`ASN-${stamp}`, tenant, objectType, String(objectId), fileName, id);
    contentIds.push(id);
    return id;
  }

  before(() => {
    db = openTestDatabase();
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('rplm-doc', 'RPLM Doc', 'organization')").run();
    tenant = db.prepare("SELECT id FROM organizations WHERE code = 'rplm-doc'").get().id;
    db.prepare("UPDATE organizations SET tenant_id = id WHERE id = ?").run(tenant);
    db.prepare(
      "INSERT INTO users (username, email, employee_id, display_name, organization_id, tenant_id, password_hash, password_salt) VALUES ('rplm-doc-owner','rplm-doc-owner@example.com','EMP-RPLMD','RPLM Doc Owner',?,?,?,?)"
    ).run(tenant, tenant, "x", "y");
    const owner = db.prepare("SELECT id FROM users WHERE username = 'rplm-doc-owner'").get();
    actor = { id: owner.id, tenant_id: tenant };

    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureChangeFoundation(db);
    ensurePdmFoundation(db);
    ensureBomFoundation(db);
    RPDM.ensureRequirementPdmFoundation(db);

    requirement = Requirements.createRequirement(db, tenant, { title: "Documented requirement", requirement_type: "product_requirement" }, actor, null);
    RPDM.ensureRequirementObject(db, tenant, Requirements.getRequirementRow(db, tenant, requirement.id), actor, null);

    productItem = Items.createItem(db, tenant, { item_number: "DOC-1000", name: "Documented Product", item_type: "PRODUCT" });
    const rule = RevisionRules.createRevisionRule(db, tenant, { code: "DOC-LATEST", rule_type: "LATEST_WORKING", is_default: true });
    RevisionRules.activateRevisionRule(db, tenant, rule.id);
    revision = Revisions.createRevision(db, tenant, "DOC-1000", { revision_number: "A1", description: "initial" });

    const header = BomDefinitions.createBom(db, tenant, { bom_number: "MBOM-DOC-1000", name: "Manufacturing BOM", bom_type: "MBOM" }, actor, null);
    bomRevision = BomRevisions.createRevision(db, tenant, header.bom_ref ?? "MBOM-DOC-1000", { revision_number: "A1" }, actor, null);

    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "ALLOCATED_TO", target_type: "pdm_item", target_id: productItem.id }, actor, null);
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "IMPLEMENTED_BY", target_type: "pdm_revision", target_id: revision.id }, actor, null);
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "SATISFIED_BY", target_type: "bom_revision", target_id: bomRevision.id }, actor, null);

    changeRequest = Change.createRequest(db, tenant, { request_number: "ECR-DOC-1", title: "Documented change" }, actor, null);
    RPDM.linkChange(db, tenant, { requirement_id: requirement.id, change_type: "change_request", change_id: changeRequest.id }, actor, null);
    changeOrder = Change.createOrder(db, tenant, { title: "Documented order", change_request_id: changeRequest.id }, actor, null);
    const noticeNumber = `ECN-DOC-${Date.now()}`;
    db.prepare("INSERT INTO change_notices (notice_ref, tenant_id, notice_number, title, change_order_id, status) VALUES (?, ?, ?, ?, ?, 'ISSUED')").run(
      noticeNumber,
      tenant,
      noticeNumber,
      "Documented notice",
      changeOrder.id
    );
    changeNotice = db.prepare("SELECT id FROM change_notices WHERE notice_number = ?").get(noticeNumber);

    attach("requirement", requirement.id, "specification.pdf");
    attach("pdm_item", productItem.id, "design-drawing.pdf");
    attach("pdm_revision", revision.id, "released-model.step");
    attach("bom_revision", bomRevision.id, "work-instruction.pdf");
    attach("change_request", changeRequest.id, "change-rationale.docx");
    attach("change_order", changeOrder.id, "manufacturing-plan.pdf");
    attach("change_notice", changeNotice.id, "compliance-notice.pdf");

    // Restricted content that must never be exposed by the projection.
    attach("requirement", requirement.id, "infected-attachment.bin", { status: "quarantined", security: "infected" });
    attach("requirement", requirement.id, "pending-scan.pdf", { status: "pending_security", security: "pending" });
  });

  after(() => {
    db?.close();
  });

  test("projects documents from the requirement, its products, structures and changes", () => {
    const result = RPDM.requirementDocuments(db, tenant, requirement.id);
    assert.equal(result.source_module, "requirement-pdm");
    assert.equal(result.total, 7);
    assert.equal(result.source_count, 7);
    assert.equal(result.requirement.id, requirement.id);
    assert.equal(result.by_category.REQUIREMENT.length, 1);
    assert.equal(result.by_category.PRODUCT.length, 2);
    assert.equal(result.by_category.STRUCTURE.length, 1);
    assert.equal(result.by_category.CHANGE.length, 3);

    const files = result.documents.map((doc) => doc.file_name).sort();
    assert.deepEqual(files, [
      "change-rationale.docx",
      "compliance-notice.pdf",
      "design-drawing.pdf",
      "manufacturing-plan.pdf",
      "released-model.step",
      "specification.pdf",
      "work-instruction.pdf",
    ]);

    const product = result.documents.find((doc) => doc.file_name === "design-drawing.pdf");
    assert.equal(product.source.category, "PRODUCT");
    assert.equal(product.source.object_type, "pdm_item");
    assert.equal(product.document_role, "ATTACHMENT");
    assert.equal(product.mime_type, "application/octet-stream");

    const notice = result.documents.find((doc) => doc.file_name === "compliance-notice.pdf");
    assert.equal(notice.source.category, "CHANGE");
    assert.equal(notice.source.object_type, "change_notice");
  });

  test("filters documents by source category", () => {
    const changes = RPDM.requirementDocuments(db, tenant, requirement.id, { category: "CHANGE" });
    assert.equal(changes.total, 3);
    assert.equal(changes.documents.every((doc) => doc.source.category === "CHANGE"), true);

    const products = RPDM.requirementDocuments(db, tenant, requirement.id, { category: "PRODUCT,STRUCTURE" });
    assert.equal(products.total, 3);
  });

  test("async projection matches the sync path", async () => {
    const result = await RPDM.requirementDocumentsAsync(db, tenant, requirement.id);
    assert.equal(result.total, 7);
    assert.equal(result.by_category.CHANGE.length, 3);
    assert.equal(result.sources.some((source) => source.object_type === "bom_revision"), true);
  });

  test("does not expose quarantined or non-downloadable content", () => {
    const result = RPDM.requirementDocuments(db, tenant, requirement.id);
    assert.equal(result.total, 7);
    const files = result.documents.map((doc) => doc.file_name);
    assert.equal(files.includes("infected-attachment.bin"), false);
    assert.equal(files.includes("pending-scan.pdf"), false);
  });

  test("throws for an unknown requirement", () => {
    assert.throws(() => RPDM.requirementDocuments(db, tenant, 999999), /not found/i);
  });
});
