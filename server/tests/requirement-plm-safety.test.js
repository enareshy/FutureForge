process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase } from "../db.js";
import "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { ensureRequirementsFoundation, Requirements } from "../services/requirements/index.js";
import { ensureChangeFoundation, Change } from "../services/change/index.js";
import { ensurePdmFoundation, Items } from "../services/pdm/index.js";
import { ensureBomFoundation, Definitions as BomDefinitions, Revisions as BomRevisions } from "../services/bom/index.js";
import { getHandler } from "../services/events/handlers.js";
import * as RPDM from "../services/requirement-pdm/index.js";

// Security, failure and event coverage for the Requirement -> PLM integration
// (spec section 38: security tests, event tests and failure tests).
describe("Requirement -> PLM security, failure and event coverage", () => {
  let db;
  let tenant;
  let actor;
  let requirement;
  let productItem;
  let changeRequest;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('rplm-safe', 'RPLM Safe', 'organization')").run();
    tenant = db.prepare("SELECT id FROM organizations WHERE code = 'rplm-safe'").get().id;
    db.prepare("UPDATE organizations SET tenant_id = id WHERE id = ?").run(tenant);
    db.prepare(
      "INSERT INTO users (username, email, employee_id, display_name, organization_id, tenant_id, password_hash, password_salt) VALUES ('rplm-safe-owner','rplm-safe-owner@example.com','EMP-RPLMSAFE','RPLM Safe Owner',?,?,?,?)"
    ).run(tenant, tenant, "x", "y");
    db.prepare(
      "INSERT INTO users (username, email, employee_id, display_name, organization_id, tenant_id, password_hash, password_salt) VALUES ('rplm-safe-nobody','rplm-safe-nobody@example.com','EMP-RPLMNOBODY','Unprivileged User',?,?,?,?)"
    ).run(tenant, tenant, "x", "y");
    const owner = db.prepare("SELECT id FROM users WHERE username = 'rplm-safe-owner'").get();
    actor = { id: owner.id, tenant_id: tenant };

    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureChangeFoundation(db);
    ensurePdmFoundation(db);
    ensureBomFoundation(db);
    RPDM.ensureRequirementPdmFoundation(db);

    requirement = Requirements.createRequirement(db, tenant, { title: "Safe requirement", requirement_type: "product_requirement", priority: "HIGH" }, actor, null);
    RPDM.ensureRequirementObject(db, tenant, Requirements.getRequirementRow(db, tenant, requirement.id), actor, null);

    productItem = Items.createItem(db, tenant, { item_number: "SAFE-1000", name: "Safe Product", item_type: "PRODUCT" });
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "ALLOCATED_TO", target_type: "pdm_item", target_id: productItem.id }, actor, null);

    const header = BomDefinitions.createBom(db, tenant, { bom_number: "EBOM-SAFE-1000", name: "Safe EBOM", bom_type: "EBOM" }, actor, null);
    const bomRevision = BomRevisions.createRevision(db, tenant, header.id, { revision_number: "A1" }, actor, null);
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "SATISFIED_BY", target_type: "bom_revision", target_id: bomRevision.id }, actor, null);

    changeRequest = Change.createRequest(db, tenant, { request_number: "ECR-SAFE-1", title: "Safe change" }, actor, null);
    RPDM.linkChange(db, tenant, { requirement_id: requirement.id, change_type: "change_request", change_id: changeRequest.id }, actor, null);
  });

  after(() => {
    db?.close();
  });

  test("applies the security contract: unauthenticated actors are denied", () => {
    const denied = RPDM.authorizeRequirementPdmAction(db, null, { resource: RPDM.REQUIREMENT_PDM_RESOURCES.plm, action: "read" });
    assert.equal(denied.allowed, false);
    assert.equal(denied.reason, "NO_ACTOR");

    assert.throws(
      () => RPDM.requireRequirementPdmAction(db, null, { resource: RPDM.REQUIREMENT_PDM_RESOURCES.plm, action: "read" }),
      /Not authorized/
    );
  });

  test("applies the security contract: a principal without grants is denied", () => {
    const nobody = db.prepare("SELECT id, tenant_id FROM users WHERE username = 'rplm-safe-nobody'").get();
    const decision = RPDM.authorizeRequirementPdmAction(db, nobody, { resource: RPDM.REQUIREMENT_PDM_RESOURCES.plm, action: "read" });
    assert.equal(decision.allowed, false);
    assert.throws(
      () => RPDM.requireRequirementPdmAction(db, nobody, { resource: RPDM.REQUIREMENT_PDM_RESOURCES.changeInitiation, action: "execute" }),
      /Not authorized/
    );
  });

  test("rejects unknown PLM node types", () => {
    assert.throws(() => RPDM.resolvePlmNodeTargets(db, tenant, "not_a_plm_node", 1), /Unsupported|PLM node/i);
    assert.throws(() => RPDM.resolvePlmNodeTargets(db, tenant, "pdm_item", 0), /PLM node|node/i);
  });

  test("registers the PLM event handler and its subscriptions", () => {
    assert.ok(getHandler("requirement-pdm.plm-change"));
    const subs = db.prepare("SELECT COUNT(*) AS c FROM event_subscriptions WHERE consumer_group = 'requirement-pdm' AND handler = 'requirement-pdm.plm-change'").get().c;
    assert.equal(Number(subs), 8, "the handler subscribes to all eight PLM node events");
  });

  test("a failed impact analysis surfaces as FAILED and publishes a failure event", () => {
    const result = RPDM.synchronizeFromPlm(
      db,
      tenant,
      {
        nodeType: "pdm_item",
        nodeId: productItem.id,
        analyze: true,
        impact: () => {
          throw new Error("simulated impact failure");
        },
      },
      actor,
      null
    );
    assert.equal(result.status, "FAILED");
    assert.equal(result.failed_count, result.requirement_count);
    assert.equal(result.requirements[0].analysis_status, "FAILED");

    const failureEvents = db.prepare("SELECT COUNT(*) AS c FROM event_outbox WHERE event_type_code = 'RequirementPLMSynchronizationFailed'").get().c;
    assert.ok(Number(failureEvents) >= 1, "a synchronization failure event must be published");
  });

  test("retry after a failure recovers and is idempotent", () => {
    const first = RPDM.synchronizeFromPlm(db, tenant, { nodeType: "pdm_item", nodeId: productItem.id, analyze: false }, actor, null);
    assert.equal(first.status, "COMPLETED");
    assert.equal(first.requirement_count, 1);

    const second = RPDM.synchronizeFromPlm(db, tenant, { nodeType: "pdm_item", nodeId: productItem.id, analyze: false }, actor, null);
    assert.equal(second.status, "COMPLETED");
    assert.equal(second.requirement_count, first.requirement_count);

    // No duplicate change request is created by repeated synchronization events.
    assert.equal(RPDM.listRequirementChanges(db, tenant, requirement.id).total, 1);
  });
});
