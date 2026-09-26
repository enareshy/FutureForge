process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate } from "../db.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { ensureVersioningFoundation } from "../services/versioning.js";
import {
  Constants,
  Validation,
  Configuration,
  Foundation,
  Requests,
  Orders,
  Notices,
  AffectedItems,
  Seed,
  ensureChangeFoundation,
} from "../services/change/index.js";

describe("Change Management domain core services", () => {
  let db;
  const tenant = 1;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('test-org', 'Test Org', 'organization')").run();
    // Change Management is the first domain to actually depend on the
    // numbering and versioning kernels being bootstrapped (their token
    // catalog / effectivity-type catalog), so — unlike the PDM tests, which
    // never exercise that path — this must run first, exactly as app.js's
    // real boot sequence orders it.
    ensureNumberingFoundation(db);
    ensureVersioningFoundation(db);
    ensureChangeFoundation(db);
    Configuration.ensureChangeConfig(db, tenant);
  });

  after(() => {
    db?.close();
  });

  test("foundation installs the Change Management domain idempotently", () => {
    const again = Foundation.ensureChangeFoundation(db);
    assert.ok(again);
    assert.equal(again.source_module, "change");
    const config = Configuration.listConfig(db, tenant);
    assert.equal(config.default_request_status, "DRAFT");
    assert.equal(config.enforce_unique_numbers, true);
  });

  test("registers live numbering schemes for ECR/ECO/ECN", () => {
    const ecr = db.prepare("SELECT * FROM numbering_schemes WHERE code = 'ECR_DEFAULT'").get();
    const eco = db.prepare("SELECT * FROM numbering_schemes WHERE code = 'ECO_DEFAULT'").get();
    const ecn = db.prepare("SELECT * FROM numbering_schemes WHERE code = 'ECN_DEFAULT'").get();
    assert.ok(ecr && ecr.status === "active");
    assert.ok(eco && eco.status === "active");
    assert.ok(ecn && ecn.status === "active");
  });

  test("exposes a coherent capability vocabulary", () => {
    const vocab = Validation.vocabulary();
    assert.equal(Constants.SOURCE_MODULE, "change");
    assert.ok(vocab.request_statuses.includes("DRAFT"));
    assert.ok(vocab.order_statuses.includes("RELEASED"));
  });

  test("creates a change request with a generated, unique number", () => {
    const request = Requests.createRequest(db, tenant, { title: "Test ECR", category: "QUALITY" }, null, null);
    assert.ok(request.request_number.startsWith("ECR-"));
    assert.equal(request.status, "DRAFT");
    const second = Requests.createRequest(db, tenant, { title: "Second ECR" }, null, null);
    assert.notEqual(second.request_number, request.request_number);
    assert.throws(
      () => Requests.createRequest(db, tenant, { title: "Duplicate number", request_number: request.request_number }, null, null),
      (err) => err.code === "CHANGE_REQUEST_CONFLICT"
    );
  });

  test("rejects an invalid status transition", () => {
    const request = Requests.createRequest(db, tenant, { title: "Transition test" }, null, null);
    assert.throws(() => Requests.screenRequest(db, tenant, request.id, "APPROVED", null, null, null), (err) => err.code === "CHANGE_REQUEST_STATUS_INVALID");
  });

  test("drives an ECR through submit -> screen -> promote into an ECO", () => {
    const request = Requests.createRequest(db, tenant, { title: "Promote test", category: "DESIGN" }, null, null);
    Requests.submitRequest(db, tenant, request.id, null, null);
    Requests.screenRequest(db, tenant, request.id, "APPROVED", "Looks good", null, null);
    const { request: promoted, order } = Requests.promoteRequest(db, tenant, request.id, { title: "ECO for promote test" }, null, null);
    assert.equal(promoted.status, "PROMOTED");
    assert.equal(order.change_request_id, request.id);
    assert.ok(order.order_number.startsWith("ECO-"));
  });

  test("release fails without affected items, and succeeds once one is added", () => {
    const order = Orders.createOrder(db, tenant, { title: "Release test order" }, null, null);
    Orders.submitOrder(db, tenant, order.id, null, null);
    Orders.decideOrder(db, tenant, order.id, "APPROVED", null, null);
    assert.throws(() => Orders.releaseOrder(db, tenant, order.id, null, null), (err) => err.code === "CHANGE_NO_AFFECTED_ITEMS");

    AffectedItems.addAffectedItem(db, tenant, order.id, { object_type: "pdm_item", object_id: "TEST-ITEM-001", disposition: "NEW_REVISION" }, null, null);
    const result = Orders.releaseOrder(db, tenant, order.id, null, null);
    assert.equal(result.order.status, "RELEASED");
    assert.equal(result.effectivity.length, 1);

    const items = AffectedItems.listAffectedItems(db, tenant, order.id);
    assert.equal(items.items[0].effectivity_assignment_id != null || items.items[0].effectivity_definition_id != null, true);
  });

  test("issues a notice only once its order is released", () => {
    const order = Orders.createOrder(db, tenant, { title: "Notice test order" }, null, null);
    assert.throws(() => Notices.createNotice(db, tenant, { change_order_id: order.id }, null, null), (err) => err.code === "CHANGE_INVALID_NOTICE");

    AffectedItems.addAffectedItem(db, tenant, order.id, { object_type: "pdm_item", object_id: "TEST-ITEM-002" }, null, null);
    Orders.submitOrder(db, tenant, order.id, null, null);
    Orders.decideOrder(db, tenant, order.id, "APPROVED", null, null);
    Orders.releaseOrder(db, tenant, order.id, null, null);

    const notice = Notices.createNotice(db, tenant, { change_order_id: order.id }, null, null);
    assert.ok(notice.notice_number.startsWith("ECN-"));
    const issued = Notices.issueNotice(db, tenant, notice.id, null, null);
    assert.equal(issued.status, "ISSUED");
  });

  test("seedChange installs a complete, idempotent demo chain end to end", () => {
    const result = Seed.seedChange(db, tenant);
    assert.equal(result.seeded, true);
    assert.equal(result.order.status, "RELEASED");
    assert.ok(result.baseline_id != null);
    assert.equal(result.notice.status, "ISSUED");

    // Re-running must be a no-op, not a re-throw of a half-finished chain.
    const again = Seed.seedChange(db, tenant);
    assert.equal(again.seeded, false);
    assert.equal(again.reason, "already_seeded");
  });

  test("standardized 404s for unknown refs", () => {
    assert.throws(() => Requests.getRequest(db, tenant, "does-not-exist"), (err) => err.code === "CHANGE_REQUEST_NOT_FOUND");
    assert.throws(() => Orders.getOrder(db, tenant, "does-not-exist"), (err) => err.code === "CHANGE_ORDER_NOT_FOUND");
  });
});
