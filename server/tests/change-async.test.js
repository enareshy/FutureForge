process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase } from "../db.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { ensureVersioningFoundation } from "../services/versioning.js";
import {
  Configuration,
  Foundation,
  Requests,
  Orders,
  Notices,
  AffectedItems,
  Relationships,
  ensureChangeFoundation,
} from "../services/change/index.js";

const TENANT = 1;

function stripTimestamps(value) {
  if (Array.isArray(value)) return value.map(stripTimestamps);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/_at$/.test(key)) continue;
      out[key] = stripTimestamps(entry);
    }
    return out;
  }
  return value;
}

function bootstrap(db) {
  migrate(db);
  db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('test-org', 'Test Org', 'organization')").run();
  ensureNumberingFoundation(db);
  ensureVersioningFoundation(db);
  ensureChangeFoundation(db);
  Configuration.ensureChangeConfig(db, TENANT);
}

describe("async change read twins mirror the synchronous service", () => {
  let db;
  const refs = {};

  before(() => {
    db = openTestDatabase();
    bootstrap(db);

    const request = Requests.createRequest(db, TENANT, { title: "Async read ECR", category: "QUALITY" }, null, null);
    Requests.submitRequest(db, TENANT, request.id, null, null);
    Requests.screenRequest(db, TENANT, request.id, "APPROVED", "ok", null, null);
    const { order } = Requests.promoteRequest(db, TENANT, request.id, { title: "Async read ECO" }, null, null);
    AffectedItems.addAffectedItem(db, TENANT, order.id, { object_type: "pdm_item", object_id: "READ-1" }, null, null);
    Orders.submitOrder(db, TENANT, order.id, null, null);
    Orders.decideOrder(db, TENANT, order.id, "APPROVED", null, null);
    Orders.releaseOrder(db, TENANT, order.id, null, null);
    const notice = Notices.createNotice(db, TENANT, { change_order_id: order.id }, null, null);
    Notices.issueNotice(db, TENANT, notice.id, null, null);
    Relationships.createRelationship(db, TENANT, { relationship_type: "AFFECTS", source_type: "change_order", source_id: "1", target_type: "pdm_item", target_id: "2" }, null, null);
    Configuration.setConfig(db, TENANT, "history_retention_days", 30, null, null);

    refs.requestId = request.id;
    refs.orderId = order.id;
    refs.noticeId = notice.id;
  });

  after(() => db?.close());

  test("request reads match", async () => {
    assert.deepEqual(await Requests.listRequestsAsync(db, { tenantId: TENANT }), Requests.listRequests(db, { tenantId: TENANT }));
    assert.deepEqual(await Requests.getRequestAsync(db, TENANT, refs.requestId), Requests.getRequest(db, TENANT, refs.requestId));
  });

  test("order reads match", async () => {
    assert.deepEqual(await Orders.listOrdersAsync(db, { tenantId: TENANT }), Orders.listOrders(db, { tenantId: TENANT }));
    assert.deepEqual(await Orders.getOrderAsync(db, TENANT, refs.orderId), Orders.getOrder(db, TENANT, refs.orderId));
  });

  test("notice reads match", async () => {
    assert.deepEqual(await Notices.listNoticesAsync(db, { tenantId: TENANT }), Notices.listNotices(db, { tenantId: TENANT }));
    assert.deepEqual(await Notices.getNoticeAsync(db, TENANT, refs.noticeId), Notices.getNotice(db, TENANT, refs.noticeId));
  });

  test("affected item reads match", async () => {
    assert.deepEqual(await AffectedItems.listAffectedItemsAsync(db, TENANT, refs.orderId), AffectedItems.listAffectedItems(db, TENANT, refs.orderId));
  });

  test("relationship reads match", async () => {
    assert.deepEqual(await Relationships.listRelationshipsAsync(db, { tenantId: TENANT }), Relationships.listRelationships(db, { tenantId: TENANT }));
  });

  test("history reads match", async () => {
    assert.deepEqual(await Requests.listRequestHistoryAsync(db, TENANT, refs.requestId), Requests.listRequestHistory(db, TENANT, refs.requestId));
    assert.deepEqual(await Orders.listOrderHistoryAsync(db, TENANT, refs.orderId), Orders.listOrderHistory(db, TENANT, refs.orderId));
    assert.deepEqual(await Notices.listNoticeHistoryAsync(db, TENANT, refs.noticeId), Notices.listNoticeHistory(db, TENANT, refs.noticeId));
  });

  test("configuration and health reads match", async () => {
    assert.deepEqual(await Configuration.listConfigAsync(db, TENANT), Configuration.listConfig(db, TENANT));
    assert.deepEqual(await Foundation.changeHealthAsync(db), Foundation.changeHealth(db));
  });
});

describe("async change write twins mirror the synchronous service", () => {
  let asyncDb;
  let syncDb;

  before(() => {
    asyncDb = openTestDatabase();
    syncDb = openTestDatabase();
    bootstrap(asyncDb);
    bootstrap(syncDb);
  });

  after(() => {
    asyncDb?.close();
    syncDb?.close();
  });

  test("createRequest produces the same result", async () => {
    const asyncResult = await Requests.createRequestAsync(asyncDb, TENANT, { title: "Parity ECR", category: "DESIGN" }, null, null);
    const syncResult = Requests.createRequest(syncDb, TENANT, { title: "Parity ECR", category: "DESIGN" }, null, null);
    assert.deepEqual(stripTimestamps(asyncResult), stripTimestamps(syncResult));
    assert.equal(asyncResult.status, "DRAFT");
  });

  test("createRequest enforces required title identically", async () => {
    await assert.rejects(() => Requests.createRequestAsync(asyncDb, TENANT, {}, null, null), (err) => err.status === 400);
    assert.throws(() => Requests.createRequest(syncDb, TENANT, {}, null, null), (err) => err.status === 400);
  });

  test("submit/screen/promote chain matches", async () => {
    const asyncReq = await Requests.createRequestAsync(asyncDb, TENANT, { title: "Chain ECR" }, null, null);
    await Requests.submitRequestAsync(asyncDb, TENANT, asyncReq.id, null, null);
    await Requests.screenRequestAsync(asyncDb, TENANT, asyncReq.id, "APPROVED", "looks good", null, null);
    const asyncPromoted = await Requests.promoteRequestAsync(asyncDb, TENANT, asyncReq.id, { title: "Chain ECO" }, null, null);

    const syncReq = Requests.createRequest(syncDb, TENANT, { title: "Chain ECR" }, null, null);
    Requests.submitRequest(syncDb, TENANT, syncReq.id, null, null);
    Requests.screenRequest(syncDb, TENANT, syncReq.id, "APPROVED", "looks good", null, null);
    const syncPromoted = Requests.promoteRequest(syncDb, TENANT, syncReq.id, { title: "Chain ECO" }, null, null);

    assert.deepEqual(stripTimestamps(asyncPromoted.request), stripTimestamps(syncPromoted.request));
    assert.deepEqual(stripTimestamps(asyncPromoted.order), stripTimestamps(syncPromoted.order));
    assert.equal(asyncPromoted.request.status, "PROMOTED");
  });

  test("updateOrder and cancelOrder match", async () => {
    const asyncOrder = await Orders.createOrderAsync(asyncDb, TENANT, { title: "Update order" }, null, null);
    const syncOrder = Orders.createOrder(syncDb, TENANT, { title: "Update order" }, null, null);

    const asyncUpdated = await Orders.updateOrderAsync(asyncDb, TENANT, asyncOrder.id, { title: "Updated", version: asyncOrder.version }, null, null);
    const syncUpdated = Orders.updateOrder(syncDb, TENANT, syncOrder.id, { title: "Updated", version: syncOrder.version }, null, null);
    assert.deepEqual(stripTimestamps(asyncUpdated), stripTimestamps(syncUpdated));

    const asyncCancelled = await Orders.cancelOrderAsync(asyncDb, TENANT, asyncOrder.id, null, null);
    const syncCancelled = Orders.cancelOrder(syncDb, TENANT, syncOrder.id, null, null);
    assert.deepEqual(stripTimestamps(asyncCancelled), stripTimestamps(syncCancelled));
    assert.equal(asyncCancelled.status, "CANCELLED");
  });

  test("updateOrder optimistic lock rejects stale versions identically", async () => {
    const asyncOrder = await Orders.createOrderAsync(asyncDb, TENANT, { title: "Lock order" }, null, null);
    const syncOrder = Orders.createOrder(syncDb, TENANT, { title: "Lock order" }, null, null);
    await assert.rejects(() => Orders.updateOrderAsync(asyncDb, TENANT, asyncOrder.id, { title: "x", version: 99 }, null, null), (err) => err.code === "CHANGE_CONFLICT");
    assert.throws(() => Orders.updateOrder(syncDb, TENANT, syncOrder.id, { title: "x", version: 99 }, null, null), (err) => err.code === "CHANGE_CONFLICT");
  });

  test("affected item add/list/remove match", async () => {
    const asyncOrder = await Orders.createOrderAsync(asyncDb, TENANT, { title: "Affected order" }, null, null);
    const syncOrder = Orders.createOrder(syncDb, TENANT, { title: "Affected order" }, null, null);

    const asyncItem = await AffectedItems.addAffectedItemAsync(asyncDb, TENANT, asyncOrder.id, { object_type: "pdm_item", object_id: "PARITY-1" }, null, null);
    const syncItem = AffectedItems.addAffectedItem(syncDb, TENANT, syncOrder.id, { object_type: "pdm_item", object_id: "PARITY-1" }, null, null);
    assert.deepEqual(stripTimestamps(asyncItem), stripTimestamps(syncItem));

    await assert.rejects(
      () => AffectedItems.addAffectedItemAsync(asyncDb, TENANT, asyncOrder.id, { object_type: "pdm_item", object_id: "PARITY-1" }, null, null),
      (err) => err.code === "CHANGE_AFFECTED_ITEM_CONFLICT"
    );

    const asyncRemoved = await AffectedItems.removeAffectedItemAsync(asyncDb, TENANT, asyncOrder.id, asyncItem.id, null, null);
    const syncRemoved = AffectedItems.removeAffectedItem(syncDb, TENANT, syncOrder.id, syncItem.id, null, null);
    assert.deepEqual(asyncRemoved, syncRemoved);
  });

  test("decideOrderAsync matches decideOrder", async () => {
    const asyncOrder = await Orders.createOrderAsync(asyncDb, TENANT, { title: "Decide order" }, null, null);
    const syncOrder = Orders.createOrder(syncDb, TENANT, { title: "Decide order" }, null, null);
    await Orders.submitOrderAsync(asyncDb, TENANT, asyncOrder.id, null, null);
    Orders.submitOrder(syncDb, TENANT, syncOrder.id, null, null);
    const asyncDecided = await Orders.decideOrderAsync(asyncDb, TENANT, asyncOrder.id, "APPROVED", null, null);
    const syncDecided = Orders.decideOrder(syncDb, TENANT, syncOrder.id, "APPROVED", null, null);
    assert.deepEqual(stripTimestamps(asyncDecided), stripTimestamps(syncDecided));
    assert.equal(asyncDecided.status, "APPROVED");
  });

  test("notice create/issue matches once the order is released", async () => {
    const asyncOrder = await Orders.createOrderAsync(asyncDb, TENANT, { title: "Notice order" }, null, null);
    const syncOrder = Orders.createOrder(syncDb, TENANT, { title: "Notice order" }, null, null);
    await AffectedItems.addAffectedItemAsync(asyncDb, TENANT, asyncOrder.id, { object_type: "pdm_item", object_id: "NOTICE-1" }, null, null);
    AffectedItems.addAffectedItem(syncDb, TENANT, syncOrder.id, { object_type: "pdm_item", object_id: "NOTICE-1" }, null, null);
    await Orders.submitOrderAsync(asyncDb, TENANT, asyncOrder.id, null, null);
    Orders.submitOrder(syncDb, TENANT, syncOrder.id, null, null);
    await Orders.decideOrderAsync(asyncDb, TENANT, asyncOrder.id, "APPROVED", null, null);
    Orders.decideOrder(syncDb, TENANT, syncOrder.id, "APPROVED", null, null);
    await Orders.releaseOrderAsync(asyncDb, TENANT, asyncOrder.id, null, null);
    Orders.releaseOrder(syncDb, TENANT, syncOrder.id, null, null);

    const asyncNotice = await Notices.createNoticeAsync(asyncDb, TENANT, { change_order_id: asyncOrder.id }, null, null);
    const syncNotice = Notices.createNotice(syncDb, TENANT, { change_order_id: syncOrder.id }, null, null);
    assert.deepEqual(stripTimestamps(asyncNotice), stripTimestamps(syncNotice));

    const asyncIssued = await Notices.issueNoticeAsync(asyncDb, TENANT, asyncNotice.id, null, null);
    const syncIssued = Notices.issueNotice(syncDb, TENANT, syncNotice.id, null, null);
    assert.deepEqual(stripTimestamps(asyncIssued), stripTimestamps(syncIssued));
    assert.equal(asyncIssued.status, "ISSUED");
  });

  test("relationship create/delete matches", async () => {
    const body = { relationship_type: "AFFECTS", source_type: "change_order", source_id: "1", target_type: "pdm_item", target_id: "2" };
    const asyncRel = await Relationships.createRelationshipAsync(asyncDb, TENANT, body, null, null);
    const syncRel = Relationships.createRelationship(syncDb, TENANT, body, null, null);
    const comparable = (rel) => {
      const { relationship_ref, ...rest } = rel;
      return stripTimestamps(rest);
    };
    assert.ok(asyncRel.relationship_ref.startsWith("CHG-REL-") && syncRel.relationship_ref.startsWith("CHG-REL-"));
    assert.deepEqual(comparable(asyncRel), comparable(syncRel));
    assert.deepEqual(await Relationships.deleteRelationshipAsync(asyncDb, TENANT, asyncRel.id), Relationships.deleteRelationship(syncDb, TENANT, syncRel.id));
  });

  test("configuration set/list matches", async () => {
    const asyncValue = await Configuration.setConfigAsync(asyncDb, TENANT, "history_retention_days", 30, null, null);
    const syncValue = Configuration.setConfig(syncDb, TENANT, "history_retention_days", 30, null, null);
    assert.deepEqual(asyncValue, syncValue);
    assert.deepEqual(await Configuration.listConfigAsync(asyncDb, TENANT), Configuration.listConfig(syncDb, TENANT));
  });
});
