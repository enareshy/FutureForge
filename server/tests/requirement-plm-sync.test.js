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
import { getHandler } from "../services/events/handlers.js";
import * as RPDM from "../services/requirement-pdm/index.js";

describe("PLM -> Requirement change synchronization", () => {
  let db;
  let tenant;
  let actor;
  let owner;
  let requirement;
  let productItem;
  let revision;
  let bomRevision;
  let changeRequest;
  let changeOrder;
  let changeNotice;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('rplm-sync', 'RPLM Sync', 'organization')").run();
    tenant = db.prepare("SELECT id FROM organizations WHERE code = 'rplm-sync'").get().id;
    db.prepare("UPDATE organizations SET tenant_id = id WHERE id = ?").run(tenant);
    db.prepare(
      "INSERT INTO users (username, email, employee_id, display_name, organization_id, tenant_id, password_hash, password_salt) VALUES ('rplm-sync-owner','rplm-sync-owner@example.com','EMP-RPLMSY','RPLM Sync Owner',?,?,?,?)"
    ).run(tenant, tenant, "x", "y");
    owner = db.prepare("SELECT id FROM users WHERE username = 'rplm-sync-owner'").get();
    actor = { id: owner.id, tenant_id: tenant };

    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureChangeFoundation(db);
    ensurePdmFoundation(db);
    ensureBomFoundation(db);
    RPDM.ensureRequirementPdmFoundation(db);

    requirement = Requirements.createRequirement(db, tenant, { title: "Sync requirement", requirement_type: "product_requirement", owner_user_id: owner.id }, actor, null);
    RPDM.ensureRequirementObject(db, tenant, Requirements.getRequirementRow(db, tenant, requirement.id), actor, null);

    productItem = Items.createItem(db, tenant, { item_number: "SYNC-1000", name: "Sync Product", item_type: "PRODUCT" });
    const rule = RevisionRules.createRevisionRule(db, tenant, { code: "SYNC-LATEST", rule_type: "LATEST_WORKING", is_default: true });
    RevisionRules.activateRevisionRule(db, tenant, rule.id);
    revision = Revisions.createRevision(db, tenant, "SYNC-1000", { revision_number: "A1", description: "initial" });

    const header = BomDefinitions.createBom(db, tenant, { bom_number: "MBOM-SYNC-1000", name: "Manufacturing BOM", bom_type: "MBOM" }, actor, null);
    bomRevision = BomRevisions.createRevision(db, tenant, header.bom_ref ?? "MBOM-SYNC-1000", { revision_number: "A1" }, actor, null);

    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "ALLOCATED_TO", target_type: "pdm_item", target_id: productItem.id }, actor, null);
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "IMPLEMENTED_BY", target_type: "pdm_revision", target_id: revision.id }, actor, null);
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "SATISFIED_BY", target_type: "bom_revision", target_id: bomRevision.id }, actor, null);

    changeRequest = Change.createRequest(db, tenant, { request_number: "ECR-SYNC-1", title: "Sync change" }, actor, null);
    RPDM.linkChange(db, tenant, { requirement_id: requirement.id, change_type: "change_request", change_id: changeRequest.id }, actor, null);
    changeOrder = Change.createOrder(db, tenant, { title: "Sync order", change_request_id: changeRequest.id }, actor, null);
    const noticeNumber = `ECN-SYNC-${Date.now()}`;
    db.prepare("INSERT INTO change_notices (notice_ref, tenant_id, notice_number, title, change_order_id, status) VALUES (?, ?, ?, ?, ?, ?)").run(
      noticeNumber,
      tenant,
      noticeNumber,
      "Sync notice",
      changeOrder.id,
      "ISSUED"
    );
    changeNotice = db.prepare("SELECT id FROM change_notices WHERE notice_number = ?").get(noticeNumber);
  });

  after(() => {
    db?.close();
  });

  test("registers the PLM sync handler, subscriptions and notification rules", () => {
    assert.ok(getHandler("requirement-pdm.plm-change"));
    const subs = db.prepare("SELECT COUNT(*) AS c FROM event_subscriptions WHERE consumer_group = 'requirement-pdm' AND handler = 'requirement-pdm.plm-change'").get().c;
    assert.equal(Number(subs), 8);
    const rules = db.prepare("SELECT COUNT(*) AS c FROM notification_rules WHERE code IN ('requirement-pdm-plm-impact','requirement-pdm-plm-sync-failed')").get().c;
    assert.equal(Number(rules), 2);
  });

  test("navigates in reverse from any PLM node to linked requirements", () => {
    const fromRevision = RPDM.requirementsForPlmNode(db, tenant, "pdm_revision", revision.id);
    assert.equal(fromRevision.total, 1);
    assert.equal(fromRevision.requirements[0].id, requirement.id);

    assert.equal(RPDM.requirementsForPlmNode(db, tenant, "pdm_item", productItem.id).total, 1);
    assert.equal(RPDM.requirementsForPlmNode(db, tenant, "bom_revision", bomRevision.id).total, 1);
    assert.equal(RPDM.requirementsForPlmNode(db, tenant, "change_request", changeRequest.id).total, 1);

    const fromOrder = RPDM.requirementsForPlmNode(db, tenant, "change_order", changeOrder.id);
    assert.equal(fromOrder.total, 1);
    assert.equal(fromOrder.change_request_id, changeRequest.id);

    const fromNotice = RPDM.requirementsForPlmNode(db, tenant, "change_notice", changeNotice.id);
    assert.equal(fromNotice.total, 1);
    assert.equal(fromNotice.change_request_id, changeRequest.id);
  });

  test("synchronizes a PLM change, classifies impact and notifies the owner", () => {
    const result = RPDM.synchronizeFromPlm(db, tenant, { nodeType: "pdm_revision", nodeId: revision.id, eventType: "PdmRevisionReleased" }, actor, null);
    assert.equal(result.direction, "PLM_TO_REQUIREMENT");
    assert.equal(result.requirement_count, 1);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.analyzed_count, 1);
    assert.ok(result.impacted_count >= 4, `expected >=4 impacted, got ${result.impacted_count}`);
    assert.equal(result.notified_count, 1);

    const events = db.prepare("SELECT COUNT(*) AS c FROM notification_events WHERE event_type = 'RequirementPDMImpactDetected'").get().c;
    assert.ok(Number(events) >= 1);
    const notifications = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE recipient_id = ?").get(owner.id).c;
    assert.ok(Number(notifications) >= 1, "owner should receive an in-app notification");

    const impactEvents = db.prepare("SELECT COUNT(*) AS c FROM event_outbox WHERE event_type_code = 'RequirementPDMImpactDetected'").get().c;
    assert.ok(Number(impactEvents) >= 1);
    const syncEvents = db.prepare("SELECT COUNT(*) AS c FROM event_outbox WHERE event_type_code = 'RequirementPLMChangeSynchronized'").get().c;
    assert.ok(Number(syncEvents) >= 1);
  });

  test("async synchronization matches the sync path", async () => {
    const result = await RPDM.synchronizeFromPlmAsync(db, tenant, { nodeType: "bom_revision", nodeId: bomRevision.id, eventType: "BomRevisionReleased", analyze: false }, actor, null);
    assert.equal(result.requirement_count, 1);
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.analyzed_count, 0);
    assert.equal(result.requirements[0].analysis_status, "SKIPPED");

    const reverse = await RPDM.requirementsForPlmNodeAsync(db, tenant, "change_request", changeRequest.id);
    assert.equal(reverse.total, 1);
  });

  test("the registered event handler propagates a change event", async () => {
    const handler = getHandler("requirement-pdm.plm-change");
    const outcome = await handler.handler({
      db,
      event: { event_type_code: "PdmRevisionReleased", tenant_id: tenant, source_object_id: String(revision.id), correlation_id: "corr-1" },
      payload: { pdm_revision_id: revision.id },
    });
    assert.equal(outcome.status, "COMPLETED");
    assert.equal(outcome.requirement_count, 1);
  });

  test("records no requirements for an unrelated node", () => {
    const result = RPDM.synchronizeFromPlm(db, tenant, { nodeType: "pdm_revision", nodeId: 999999, analyze: false }, actor, null);
    assert.equal(result.requirement_count, 0);
    assert.equal(result.status, "COMPLETED");
  });

  test("submits a PLM synchronization job and enqueues an integration message", async () => {
    const job = await RPDM.submitPlmSynchronizationAsync(db, tenant, { node_type: "pdm_revision", node_id: revision.id }, actor, null);
    assert.equal(job.job_type_code, "REQUIREMENT_PLM_SYNCHRONIZE");

    const message = await RPDM.enqueuePlmSynchronizationAsync(db, tenant, { node_type: "pdm_revision", node_id: revision.id }, actor);
    assert.ok(message);
    assert.equal(message.message_type, "requirement-pdm.plm-sync");
  });

  test("exposes integration metrics and status", async () => {
    const metrics = await RPDM.plmMetricsAsync(db, tenant);
    assert.equal(metrics.source_module, "requirement-pdm");
    assert.ok(metrics.allowed_statuses.includes(metrics.status));
    assert.ok(metrics.allocations.total >= 3);
    assert.equal(metrics.change_requests.total, 1);
    assert.equal(metrics.change_orders.total, 1);
    assert.equal(metrics.change_notices.total, 1);
    assert.ok(metrics.events.impact_detected >= 1);
    assert.ok(metrics.events.synchronized >= 1);
  });
});
