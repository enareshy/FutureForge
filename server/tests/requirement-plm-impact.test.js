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

describe("Requirement -> PLM impact analysis", () => {
  let db;
  let tenant;
  let actor;
  let requirement;
  let objectId;
  let productItem;
  let revision;
  let bomRevision;
  let changeRequest;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('rplm-impact', 'RPLM Impact', 'organization')").run();
    tenant = db.prepare("SELECT id FROM organizations WHERE code = 'rplm-impact'").get().id;
    db.prepare("UPDATE organizations SET tenant_id = id WHERE id = ?").run(tenant);
    db.prepare(
      "INSERT INTO users (username, email, employee_id, display_name, organization_id, tenant_id, password_hash, password_salt) VALUES ('rplm-impact-owner','rplm-impact-owner@example.com','EMP-RPLMI','RPLM Impact Owner',?,?,?,?)"
    ).run(tenant, tenant, "x", "y");
    const owner = db.prepare("SELECT id FROM users WHERE username = 'rplm-impact-owner'").get();
    actor = { id: owner.id, tenant_id: tenant };

    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureChangeFoundation(db);
    ensurePdmFoundation(db);
    ensureBomFoundation(db);
    RPDM.ensureRequirementPdmFoundation(db);

    requirement = Requirements.createRequirement(db, tenant, { title: "Impact chain", requirement_type: "product_requirement" }, actor, null);
    objectId = RPDM.ensureRequirementObject(db, tenant, Requirements.getRequirementRow(db, tenant, requirement.id), actor, null).object_id;

    productItem = Items.createItem(db, tenant, { item_number: "IMP-1000", name: "Impact Product", item_type: "PRODUCT" });
    const rule = RevisionRules.createRevisionRule(db, tenant, { code: "IMP-LATEST", rule_type: "LATEST_WORKING", is_default: true });
    RevisionRules.activateRevisionRule(db, tenant, rule.id);
    revision = Revisions.createRevision(db, tenant, "IMP-1000", { revision_number: "A1", description: "initial" });

    const header = BomDefinitions.createBom(db, tenant, { bom_number: "MBOM-IMP-1000", name: "Manufacturing BOM", bom_type: "MBOM" }, actor, null);
    bomRevision = BomRevisions.createRevision(db, tenant, header.bom_ref ?? "MBOM-IMP-1000", { revision_number: "A1" }, actor, null);

    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "ALLOCATED_TO", target_type: "pdm_item", target_id: productItem.id }, actor, null);
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "IMPLEMENTED_BY", target_type: "pdm_revision", target_id: revision.id }, actor, null);
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "SATISFIED_BY", target_type: "bom_revision", target_id: bomRevision.id }, actor, null);

    changeRequest = Change.createRequest(db, tenant, { request_number: "ECR-IMPACT-1", title: "Impact change" }, actor, null);
    RPDM.linkChange(db, tenant, { requirement_id: requirement.id, change_type: "change_request", change_id: changeRequest.id }, actor, null);
  });

  after(() => {
    db?.close();
  });

  test("classifies downstream PLM impact across the digital thread", async () => {
    const report = await RPDM.analyzeRequirementImpactAsync(db, tenant, requirement.id, {}, actor, null);
    assert.equal(report.source_module, "requirement-pdm");
    assert.ok(report.impacted_count >= 4, `expected >=4 impacted, got ${report.impacted_count}`);
    assert.equal(report.category_totals.CHANGE, 1);
    assert.ok(report.object_type_totals.change_request >= 1);
    assert.ok(report.object_type_totals.pdm_item >= 1);
    assert.ok(report.object_type_totals.pdm_revision >= 1);
    assert.ok(report.object_type_totals.bom_revision >= 1);
    assert.ok(report.domain_totals.MBOM >= 1);
    assert.ok(report.domain_totals.CHANGE >= 1);
    assert.equal(report.recommendation.change_candidate, true);
    assert.ok(report.items.every((item) => item.category));
  });

  test("sync and async impact analysis agree on counts", () => {
    const sync = RPDM.analyzeRequirementImpact(db, tenant, requirement.id, {}, actor, null);
    assert.ok(sync.impacted_count >= 4);
    assert.equal(sync.category_totals.CHANGE, 1);
  });
});
