process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase } from "../db.js";
import "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { ensureRequirementsFoundation, Requirements } from "../services/requirements/index.js";
import { ensurePdmFoundation, Items, Revisions, RevisionRules } from "../services/pdm/index.js";
import * as RPDM from "../services/requirement-pdm/index.js";

describe("Requirement -> Product / Lifecycle projection", () => {
  let db;
  let tenant;
  let actor;
  let requirement;
  let productItem;
  let revision;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('rplm-product', 'RPLM Product', 'organization')").run();
    tenant = db.prepare("SELECT id FROM organizations WHERE code = 'rplm-product'").get().id;
    db.prepare("UPDATE organizations SET tenant_id = id WHERE id = ?").run(tenant);
    db.prepare(
      "INSERT INTO users (username, email, employee_id, display_name, organization_id, tenant_id, password_hash, password_salt) VALUES ('rplm-product-owner','rplm-product-owner@example.com','EMP-RPLMP','RPLM Product Owner',?,?,?,?)"
    ).run(tenant, tenant, "x", "y");
    const owner = db.prepare("SELECT id FROM users WHERE username = 'rplm-product-owner'").get();
    actor = { id: owner.id, tenant_id: tenant };

    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensurePdmFoundation(db);
    RPDM.ensureRequirementPdmFoundation(db);

    requirement = Requirements.createRequirement(db, tenant, { title: "Product trace", requirement_type: "product_requirement" }, actor, null);
    RPDM.ensureRequirementObject(db, tenant, Requirements.getRequirementRow(db, tenant, requirement.id), actor, null);

    productItem = Items.createItem(db, tenant, { item_number: "PROD-1000", name: "Product 1000", item_type: "PRODUCT" });
    const rule = RevisionRules.createRevisionRule(db, tenant, { code: "PROD-LATEST", rule_type: "LATEST_WORKING", is_default: true });
    RevisionRules.activateRevisionRule(db, tenant, rule.id);
    revision = Revisions.createRevision(db, tenant, "PROD-1000", { revision_number: "A1", description: "initial" });

    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "ALLOCATED_TO", target_type: "pdm_item", target_id: productItem.id }, actor, null);
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "IMPLEMENTED_BY", target_type: "pdm_revision", target_id: revision.id }, actor, null);
  });

  after(() => {
    db?.close();
  });

  test("projects allocated products with revision awareness and realization stage", async () => {
    const view = await RPDM.listRequirementProductsAsync(db, tenant, requirement.id, {});
    assert.equal(view.product_count, 1);
    const product = view.products[0];
    assert.equal(product.item_type, "PRODUCT");
    assert.equal(product.number, "PROD-1000");
    assert.equal(product.implementation, true);
    assert.equal(product.superseded, false);
    assert.equal(product.realization_stage, "IMPLEMENTED");
    assert.equal(product.revisions.length, 1);
    assert.equal(product.revisions[0].revision_number, "A1");
    assert.equal(product.revisions[0].is_latest, true);
    assert.equal(view.realization.stage, "IMPLEMENTED");
    assert.equal(view.realization.implemented, true);
  });

  test("sync projection matches async", () => {
    const view = RPDM.listRequirementProducts(db, tenant, requirement.id, {});
    assert.equal(view.product_count, 1);
    assert.equal(view.products[0].realization_stage, "IMPLEMENTED");
  });

  test("resolves product lifecycle and rejects non-product items", async () => {
    const detail = await RPDM.productLifecycleAsync(db, tenant, productItem.id);
    assert.equal(detail.product.item_type, "PRODUCT");
    assert.equal(detail.product.number, "PROD-1000");
    assert.equal(detail.realization_stage, "IN_DEVELOPMENT");
    assert.equal(detail.is_released, false);

    const other = Items.createItem(db, tenant, { item_number: "PART-2000", name: "Part 2000", item_type: "PART" });
    await assert.rejects(() => RPDM.productLifecycleAsync(db, tenant, other.id), /not a product/);
  });

  test("reverse trace lists requirements allocated to a product", async () => {
    const reverse = await RPDM.listProductRequirementsAsync(db, tenant, productItem.id, {});
    assert.equal(reverse.total, 2);
    assert.ok(reverse.items.every((item) => item.requirement_id === requirement.id));
    assert.deepEqual(
      reverse.items.map((item) => item.relationship_type).sort(),
      ["ALLOCATED_TO", "IMPLEMENTED_BY"]
    );
  });

  test("release and a newer revision promote the realization stage", async () => {
    Items.setItemStatus(db, tenant, productItem.id, "RELEASED", actor, null);
    let view = RPDM.listRequirementProducts(db, tenant, requirement.id, {});
    assert.equal(view.products[0].realization_stage, "RELEASED");
    assert.equal(view.products[0].is_released, true);

    Revisions.createRevision(db, tenant, "PROD-1000", { revision_number: "A2", description: "next" }, actor, null);
    view = RPDM.listRequirementProducts(db, tenant, requirement.id, {});
    assert.equal(view.products[0].superseded, true);
    assert.equal(view.products[0].realization_stage, "SUPERSEDED");
    assert.equal(view.products[0].revisions[0].is_latest, false);
  });
});
