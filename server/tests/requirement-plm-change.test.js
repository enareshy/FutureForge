process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase } from "../db.js";
import "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { ensureRequirementsFoundation, Requirements } from "../services/requirements/index.js";
import { ensureChangeFoundation, Change } from "../services/change/index.js";
import { ensurePdmFoundation } from "../services/pdm/index.js";
import { ensureBomFoundation } from "../services/bom/index.js";
import * as RPDM from "../services/requirement-pdm/index.js";
import * as Thread from "../services/thread/index.js";

describe("Requirement <-> Change Management integration", () => {
  let db;
  let tenant;
  let actor;
  let requirement;
  let objectId;
  let changeRequest;

  const authorizer = {
    allowsNode: () => true,
    filter: (nodes) => nodes,
    allowsNodeAsync: async () => true,
    filterAsync: async (nodes) => nodes,
  };

  before(() => {
    db = openTestDatabase();
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('rplm-change', 'RPLM Change', 'organization')").run();
    tenant = db.prepare("SELECT id FROM organizations WHERE code = 'rplm-change'").get().id;
    db.prepare("UPDATE organizations SET tenant_id = id WHERE id = ?").run(tenant);
    db.prepare(
      "INSERT INTO users (username, email, employee_id, display_name, organization_id, tenant_id, password_hash, password_salt) VALUES ('rplm-change-owner','rplm-change-owner@example.com','EMP-RPLMCH','RPLM Change Owner',?,?,?,?)"
    ).run(tenant, tenant, "x", "y");
    const owner = db.prepare("SELECT id FROM users WHERE username = 'rplm-change-owner'").get();
    actor = { id: owner.id, tenant_id: tenant };

    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureChangeFoundation(db);
    ensurePdmFoundation(db);
    ensureBomFoundation(db);
    RPDM.ensureRequirementPdmFoundation(db);

    requirement = Requirements.createRequirement(db, tenant, { title: "Thermal margin", requirement_type: "product_requirement" }, actor, null);
    const mirrored = RPDM.ensureRequirementObject(db, tenant, Requirements.getRequirementRow(db, tenant, requirement.id), actor, null);
    objectId = mirrored.object_id;

    changeRequest = Change.createRequest(db, tenant, { request_number: "ECR-TEST-1001", title: "Adjust thermal margin", category: "DESIGN", priority: "HIGH" }, actor, null);
  });

  after(() => {
    db?.close();
  });

  test("links a requirement to an existing change request idempotently", () => {
    const first = RPDM.linkChange(db, tenant, { requirement_id: requirement.id, change_type: "change_request", change_id: changeRequest.id, reason: "Requirement raised" }, actor, null);
    assert.equal(first.created, true);
    assert.equal(first.link.change_type, "change_request");
    assert.equal(first.link.change.number, "ECR-TEST-1001");
    assert.equal(first.link.requirement_ref, requirement.requirement_ref);

    const second = RPDM.linkChange(db, tenant, { requirement_id: requirement.id, change_type: "change_request", change_id: changeRequest.id }, actor, null);
    assert.equal(second.created, false);
    assert.equal(second.link.link_ref, first.link.link_ref);
  });

  test("lists requirement changes and reverse change requirements", () => {
    const forward = RPDM.listRequirementChanges(db, tenant, requirement.id);
    assert.equal(forward.total, 1);
    assert.equal(forward.items[0].change.number, "ECR-TEST-1001");

    const reverse = RPDM.listChangeRequirements(db, tenant, "change_request", changeRequest.id);
    assert.equal(reverse.total, 1);
    assert.equal(reverse.items[0].requirement_ref, requirement.requirement_ref);
  });

  test("projects the requirement -> change edge through the Digital Thread", () => {
    const anchor = `requirement:${objectId}`;
    const downstream = Thread.Engine.executeTraversal(db, tenant, { root: anchor, direction: "DOWNSTREAM", maxDepth: 2, includeInactive: true, authorizer }, actor, { record: false, publish: false });
    assert.ok(downstream.result.nodes.some((node) => node.node_ref === `change_request:${changeRequest.id}`));

    const upstream = Thread.Engine.executeTraversal(db, tenant, { root: `change_request:${changeRequest.id}`, direction: "UPSTREAM", maxDepth: 2, includeInactive: true, authorizer }, actor, { record: false, publish: false });
    assert.ok(upstream.result.nodes.some((node) => node.node_ref === anchor));
  });

  test("async parity and unlink", async () => {
    const asyncForward = await RPDM.listRequirementChangesAsync(db, tenant, requirement.id);
    assert.equal(asyncForward.total, 1);

    const asyncReverse = await RPDM.listChangeRequirementsAsync(db, tenant, "change_request", changeRequest.id);
    assert.equal(asyncReverse.total, 1);

    await assert.rejects(
      () => RPDM.linkChangeAsync(db, tenant, { requirement_id: requirement.id, change_type: "change_order", change_id: changeRequest.id }, actor, null),
      (error) => error.code === "REQUIREMENT_PDM_CHANGE_NOT_FOUND"
    );

    const linkRef = asyncForward.items[0].link_ref;
    const removed = RPDM.unlinkChange(db, tenant, linkRef, actor, null);
    assert.equal(removed.removed, true);
    assert.equal(RPDM.listRequirementChanges(db, tenant, requirement.id).total, 0);
  });
});
