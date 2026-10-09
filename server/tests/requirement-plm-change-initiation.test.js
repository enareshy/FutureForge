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

function impact(releasedImpacted) {
  return {
    impacted_count: releasedImpacted ? 5 : 2,
    released_count: releasedImpacted ? 2 : 0,
    released_impacted: releasedImpacted,
    category_totals: { DIRECT: 1, RELEASED: releasedImpacted ? 2 : 0 },
    recommendation: { change_candidate: releasedImpacted, reasons: releasedImpacted ? ["released_object_impacted"] : [] },
  };
}

describe("Requirement -> automatic change initiation", () => {
  let db;
  let tenant;
  let actor;

  const createRequirement = (overrides = {}) =>
    Requirements.createRequirement(db, tenant, { title: "Auto change requirement", requirement_type: "product_requirement", ...overrides }, actor, null);

  before(() => {
    db = openTestDatabase();
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('rplm-init', 'RPLM Init', 'organization')").run();
    tenant = db.prepare("SELECT id FROM organizations WHERE code = 'rplm-init'").get().id;
    db.prepare("UPDATE organizations SET tenant_id = id WHERE id = ?").run(tenant);
    db.prepare(
      "INSERT INTO users (username, email, employee_id, display_name, organization_id, tenant_id, password_hash, password_salt) VALUES ('rplm-init-owner','rplm-init-owner@example.com','EMP-RPLMINIT','RPLM Init Owner',?,?,?,?)"
    ).run(tenant, tenant, "x", "y");
    const owner = db.prepare("SELECT id FROM users WHERE username = 'rplm-init-owner'").get();
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

  test("evaluates the change-initiation business rules", () => {
    const req = createRequirement({ priority: "HIGH" });
    const disabled = RPDM.evaluateChangeInitiation(db, tenant, Requirements.getRequirementRow(db, tenant, req.id), impact(true), {});
    assert.equal(disabled.initiate, false);
    assert.equal(disabled.blocked_by, "auto_change_request_disabled");

    RPDM.setConfig(db, tenant, "auto_change_request", true);
    const enabled = RPDM.evaluateChangeInitiation(db, tenant, Requirements.getRequirementRow(db, tenant, req.id), impact(true), {});
    assert.equal(enabled.initiate, true);
    assert.equal(enabled.severity, "HIGH");
    assert.ok(enabled.matched_rules.includes("AUTO_CHANGE_REQUEST"));
    assert.ok(enabled.matched_rules.includes("SEVERITY_THRESHOLD"));
    assert.ok(enabled.matched_rules.includes("RELEASED_IMPACT"));

    const low = createRequirement({ priority: "LOW" });
    const below = RPDM.evaluateChangeInitiation(db, tenant, Requirements.getRequirementRow(db, tenant, low.id), impact(true), {});
    assert.equal(below.initiate, false);
    assert.equal(below.blocked_by, "severity_below_threshold");

    const notReleased = RPDM.evaluateChangeInitiation(db, tenant, Requirements.getRequirementRow(db, tenant, req.id), impact(false), {});
    assert.equal(notReleased.initiate, false);
    assert.equal(notReleased.blocked_by, "released_impact_required");
  });

  test("creates an existing Change Management request and links it, idempotently", () => {
    const req = createRequirement({ criticality: "CRITICAL" });
    const first = RPDM.initiateChangeRequest(db, tenant, req.id, { impact: impact(true) }, actor, null);
    assert.equal(first.status, "CREATED");
    assert.equal(first.created, true);
    assert.ok(first.change.id);
    assert.match(first.change.request_number, /^ECR-/);
    assert.equal(first.change.category, "DESIGN");
    assert.equal(first.link.change_type, "change_request");
    assert.equal(first.link.change_id, String(first.change.id));
    assert.equal(first.link.request_number ?? first.link.change.number, first.change.request_number);
    assert.equal(first.decision.severity, "CRITICAL");

    const second = RPDM.initiateChangeRequest(db, tenant, req.id, { impact: impact(true) }, actor, null);
    assert.equal(second.status, "EXISTING");
    assert.equal(second.created, false);
    assert.equal(second.change.id, first.change.id);

    const crs = RPDM.listRequirementChanges(db, tenant, req.id);
    assert.equal(crs.total, 1);
  });

  test("force overrides the configured threshold", () => {
    const req = createRequirement({ priority: "LOW" });
    const forced = RPDM.initiateChangeRequest(db, tenant, req.id, { impact: impact(false), force: true }, actor, null);
    assert.equal(forced.status, "CREATED");
    assert.equal(forced.created, true);
  });

  test("exposes the CR -> ECO chain and affected items", () => {
    const req = createRequirement({ priority: "HIGH" });
    const initiated = RPDM.initiateChangeRequest(db, tenant, req.id, { impact: impact(true) }, actor, null);
    assert.equal(initiated.status, "CREATED");

    const order = Change.createOrder(db, tenant, { title: "Implement requirement change", change_request_id: initiated.change.id }, actor, null);
    Change.addAffectedItem(db, tenant, order.id, { object_type: "pdm_item", object_id: "9001", disposition: "NEW_REVISION" }, actor, null);

    const chain = RPDM.requirementChangeChain(db, tenant, req.id);
    assert.equal(chain.change_request_count, 1);
    assert.equal(chain.order_count, 1);
    const item = chain.items[0];
    assert.equal(item.change_request.change_id, String(initiated.change.id));
    assert.equal(item.orders.length, 1);
    assert.equal(item.orders[0].id, order.id);
    assert.equal(item.orders[0].affected_item_count, 1);
    assert.deepEqual(item.orders[0].notices, []);
  });

  test("async parity for evaluation, initiation and chain", async () => {
    const req = createRequirement({ priority: "HIGH" });
    const preview = await RPDM.evaluateRequirementChangeInitiationAsync(db, tenant, req.id, { impact: impact(true) }, actor, null);
    assert.equal(preview.decision.initiate, true);

    const initiated = await RPDM.initiateChangeRequestAsync(db, tenant, req.id, { impact: impact(true) }, actor, null);
    assert.equal(initiated.status, "CREATED");

    const again = await RPDM.initiateChangeRequestAsync(db, tenant, req.id, { impact: impact(true) }, actor, null);
    assert.equal(again.status, "EXISTING");

    const chain = await RPDM.requirementChangeChainAsync(db, tenant, req.id);
    assert.equal(chain.change_request_count, 1);
  });

  test("submits a change-initiation job to the scheduling engine", async () => {
    const req = createRequirement({ priority: "HIGH" });
    const job = await RPDM.submitChangeInitiationAsync(db, tenant, { requirement_id: req.id, force: true }, actor, null);
    assert.ok(job);
    assert.equal(job.job_type_code, "REQUIREMENT_PLM_CHANGE_INITIATE");
  });
});
