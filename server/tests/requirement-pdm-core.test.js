process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase } from "../db.js";
import "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { ensureRequirementsFoundation, Requirements } from "../services/requirements/index.js";
import { ensurePdmFoundation, Items, Revisions, RevisionRules } from "../services/pdm/index.js";
import { ensureBomFoundation, Definitions as BomDefinitions, Revisions as BomRevisions } from "../services/bom/index.js";
import { ensureChangeFoundation } from "../services/change/index.js";
import * as RPDM from "../services/requirement-pdm/index.js";
import * as Thread from "../services/thread/index.js";
import { listProviders } from "../services/thread/providers.js";

describe("Requirement -> PDM integration core", () => {
  let db;
  let tenant;
  let actor;
  let requirement;
  let objectId;
  let productItem;
  let revision;
  let allocationRef;
  let revisionAllocationRef;

  const authorizer = {
    allowsNode: () => true,
    filter: (nodes) => nodes,
    allowsNodeAsync: async () => true,
    filterAsync: async (nodes) => nodes,
  };

  before(() => {
    db = openTestDatabase();
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('rpdm-core', 'RPDM Core', 'organization')").run();
    tenant = db.prepare("SELECT id FROM organizations WHERE code = 'rpdm-core'").get().id;
    db.prepare("UPDATE organizations SET tenant_id = id WHERE id = ?").run(tenant);
    db.prepare(
      "INSERT INTO users (username, email, employee_id, display_name, organization_id, tenant_id, password_hash, password_salt) VALUES ('core-owner','core-owner@example.com','EMP-CORE','Core Owner',?,?,?,?)"
    ).run(tenant, tenant, "x", "y");
    const owner = db.prepare("SELECT id FROM users WHERE username = 'core-owner'").get();
    actor = { id: owner.id, tenant_id: tenant };

    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensurePdmFoundation(db);
    ensureBomFoundation(db);
    ensureChangeFoundation(db);
    RPDM.ensureRequirementPdmFoundation(db);

    requirement = Requirements.createRequirement(db, tenant, { title: "Braking force", requirement_type: "product_requirement" }, actor, null);
    const mirrored = RPDM.ensureRequirementObject(db, tenant, Requirements.getRequirementRow(db, tenant, requirement.id), actor, null);
    objectId = mirrored.object_id;

    productItem = Items.createItem(db, tenant, { item_number: "CORE-1000", name: "Core Assembly", item_type: "PRODUCT" });
    const rule = RevisionRules.createRevisionRule(db, tenant, { code: "CORE-LATEST", rule_type: "LATEST_WORKING", is_default: true });
    RevisionRules.activateRevisionRule(db, tenant, rule.id);
    revision = Revisions.createRevision(db, tenant, "CORE-1000", { revision_number: "A1", description: "initial" });
  });

  after(() => {
    db?.close();
  });

  test("registers the Digital Thread provider, events, jobs and subscriptions", () => {
    assert.ok(listProviders().some((provider) => provider.code === "requirement-pdm"));
    const subs = db.prepare("SELECT COUNT(*) AS c FROM event_subscriptions WHERE consumer_group = 'requirement-pdm'").get().c;
    assert.equal(Number(subs), 22);
    const changeSubs = db
      .prepare("SELECT COUNT(*) AS c FROM event_subscriptions WHERE consumer_group = 'requirement-pdm' AND handler = 'requirement-pdm.requirement-change'")
      .get().c;
    assert.equal(Number(changeSubs), 3);
    const plmSubs = db
      .prepare("SELECT COUNT(*) AS c FROM event_subscriptions WHERE consumer_group = 'requirement-pdm' AND handler = 'requirement-pdm.plm-change'")
      .get().c;
    assert.equal(Number(plmSubs), 8);
    const jobs = db.prepare("SELECT COUNT(*) AS c FROM job_types WHERE source_module = 'requirement-pdm'").get().c;
    assert.equal(Number(jobs), 5);
  });

  test("exposes the Requirement -> PLM vocabulary through meta and configuration", () => {
    const meta = RPDM.requirementPdmMeta();
    assert.equal(meta.plm.node_types.PRODUCT, "pdm_item");
    assert.equal(meta.plm.node_types.PRODUCT_REVISION, "pdm_revision");
    assert.equal(meta.plm.node_types.EBOM, "bom_revision");
    assert.equal(meta.plm.node_types.MBOM, "bom_revision");
    assert.equal(meta.plm.node_types.BOP, "bom_revision");
    assert.equal(meta.plm.change_node_types.REQUEST, "change_request");
    assert.deepEqual(meta.plm.link_codes, ["CHANGED_BY"]);
    assert.ok(meta.plm.impact_categories.includes("PROCESS"));
    assert.ok(meta.plm.change_initiation_statuses.includes("EXISTING"));

    const config = RPDM.listConfig(db, tenant);
    assert.equal(config.auto_change_request, false);
    assert.equal(config.auto_change_request_severities, "CRITICAL,HIGH");
    assert.equal(config.auto_change_request_require_released, true);
    assert.equal(config.change_request_category, "DESIGN");
    assert.equal(config.change_link_auto, true);
    assert.equal(RPDM.getConfig(db, tenant, "auto_change_request"), false);
    assert.equal(RPDM.getConfig(db, tenant, "requirement_pdm.notify_on_impact"), true);
  });

  test("creates allocations idempotently with reverse navigation and coverage", () => {
    const first = RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "ALLOCATED_TO", target_type: "pdm_item", target_id: productItem.id }, actor, null);
    assert.equal(first.created, true);
    allocationRef = first.allocation.allocation_ref;

    const second = RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "IMPLEMENTED_BY", target_type: "pdm_revision", target_id: revision.id }, actor, null);
    assert.equal(second.created, true);
    revisionAllocationRef = second.allocation.allocation_ref;

    const duplicate = RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "IMPLEMENTED_BY", target_type: "pdm_revision", target_id: revision.id }, actor, null);
    assert.equal(duplicate.created, false);

    const reverse = RPDM.listAllocations(db, tenant, { target_type: "pdm_revision", target_id: revision.id });
    assert.ok(reverse.items.some((item) => item.allocation_ref === second.allocation.allocation_ref));

    const coverage = RPDM.allocationCoverage(db, tenant, requirement.requirement_ref);
    assert.equal(coverage.coverage, "ALLOCATED");
    assert.equal(coverage.by_relationship.ALLOCATED_TO, 1);
  });

  test("marks the allocation STALE when the PDM revision is superseded", () => {
    assert.ok(typeof revisionAllocationRef === "string");
    const before = RPDM.checkAllocation(db, tenant, revisionAllocationRef, {}, actor, null);
    assert.equal(before.status, "COMPATIBLE");

    Revisions.createRevision(db, tenant, "CORE-1000", { revision_number: "A2", description: "v2" });
    const report = RPDM.checkAllocation(db, tenant, revisionAllocationRef, {}, actor, null);
    assert.equal(report.status, "STALE");
    assert.equal(report.changed, true);
  });

  test("synchronizes impacted allocations and reports the change", () => {
    const summary = RPDM.synchronize(db, tenant, { requirementId: requirement.id }, actor, null);
    assert.ok(["COMPLETED", "PARTIAL", "NOOP"].includes(summary.status));
    assert.ok(summary.evaluated >= 1);
    const impacted = RPDM.impactedRequirements(db, tenant, { targetType: "pdm_item", targetId: productItem.id });
    assert.ok(impacted.total >= 1);
  });

  test("projects the full digital thread downstream and upstream", async () => {
    const anchor = `requirement:${objectId}`;
    const downstream = Thread.Engine.executeTraversal(db, tenant, { root: anchor, direction: "DOWNSTREAM", maxDepth: 3, includeInactive: true, authorizer }, actor, { record: false, publish: false });
    assert.ok(downstream.result.node_count >= 3);
    assert.ok(downstream.result.edges.some((edge) => edge.relationship_type === "ALLOCATED_TO"));

    const upstream = Thread.Engine.executeTraversal(db, tenant, { root: `pdm_item:${productItem.id}`, direction: "UPSTREAM", maxDepth: 3, includeInactive: true, authorizer }, actor, { record: false, publish: false });
    assert.ok(upstream.result.nodes.some((node) => node.node_ref === anchor));

    const asyncDown = await Thread.Engine.executeTraversalAsync(db, tenant, { root: anchor, direction: "DOWNSTREAM", maxDepth: 3, includeInactive: true, authorizer }, actor, { record: false, publish: false });
    assert.equal(asyncDown.result.node_count, downstream.result.node_count);
  });

  test("denies an actor without integration privileges", () => {
    const decision = RPDM.authorizeRequirementPdmAction(db, actor, { resource: RPDM.REQUIREMENT_PDM_RESOURCES.overview, action: "read" });
    assert.equal(decision.allowed, false);
    const create = RPDM.authorizeRequirementPdmAction(db, actor, { resource: RPDM.REQUIREMENT_PDM_RESOURCES.allocations, action: "create" });
    assert.equal(create.allowed, false);
  });
});
