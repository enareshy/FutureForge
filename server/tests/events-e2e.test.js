import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne, run } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as events from "../services/events.js";
import * as objects from "../services/objects.js";

// End-to-end and failure-isolation coverage for the Event & Messaging
// Framework: a released product fans out to every consumer, a poison handler
// cannot block its siblings, a broker outage is retried without losing the
// event, and a crashed consumer's lease is reclaimed and redelivered.

const ACTOR = { id: 1, username: "admin" };
const IP = "127.0.0.1";

describe("event framework end-to-end delivery", () => {
  let db;
  let actor;
  let tenantId;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
  });

  after(() => db.close());

  test("ProductReleased fans out to search, notifications, workflow, integration and analytics", async () => {
    const product = objects.createObject(
      db,
      {
        type: "product",
        code: "E2E-PRODUCT-1",
        name: "E2E released product",
        data: { "part.number": "E2E-PRODUCT-1", "part.name": "E2E released product", "part.category": "mechanical", "part.status": "draft" },
      },
      ACTOR,
      tenantId,
      IP
    );
    await events.Outbox.processOutbox(db, { limit: 500 });

    events.publishEvent(
      db,
      {
        event_type_code: "ProductReleased",
        source_module: "product-data",
        source_system: "helix",
        source_object_type: "object",
        source_object_id: product.id,
        tenant_id: tenantId,
        organization_id: tenantId,
        correlation_id: "corr-e2e-product-release",
        payload: { id: product.id, code: product.code, name: product.name, value: 5 },
      },
      ACTOR
    );

    const summary = await events.Outbox.processOutbox(db, { limit: 500 });
    assert.equal(summary.published, 1, "the outbox published the product release");

    const record = queryOne(db, "SELECT * FROM event_records WHERE event_type_code = 'ProductReleased' ORDER BY id DESC LIMIT 1");
    assert.ok(record);

    const deliveries = events.Publisher.listDeliveries(db, { eventId: record.id, pageSize: 100 }).items;
    const handlers = new Set(deliveries.map((d) => d.handler));
    for (const handler of ["search.index", "notification.dispatch", "workflow.trigger", "integration.forward", "analytics.record"]) {
      assert.ok(handlers.has(handler), `subscriber ${handler} received the event`);
    }

    await events.Consumer.processDeliveries(db, { limit: 200 });
    const after = events.Publisher.listDeliveries(db, { eventId: record.id, pageSize: 100 }).items;
    assert.ok(after.every((d) => d.status === "delivered"), "every subscriber acknowledged the event");

    const indexed = queryOne(
      db,
      "SELECT * FROM search_index_status WHERE object_type = 'object' AND object_id = ?",
      [String(product.id)]
    );
    assert.ok(indexed, "the search consumer queued an index change");
    assert.equal(indexed.reason, "event:ProductReleased", "the index change came from the event consumer");

    const notified = queryOne(db, "SELECT * FROM notification_events WHERE event_type = 'ProductReleased' ORDER BY id DESC LIMIT 1");
    assert.ok(notified, "the notification consumer recorded the notification event");

    const forwarded = queryOne(db, "SELECT * FROM integration_events WHERE event_type_code = 'ProductReleased' ORDER BY id DESC LIMIT 1");
    assert.ok(forwarded, "the integration consumer forwarded the event to the Integration Hub");
  });

  test("a failing handler does not block its sibling subscribers", async () => {
    let goodRuns = 0;
    events.Handlers.registerHandler(
      "test.isolation.bad",
      async () => {
        const error = new Error("isolated handler failure");
        error.category = "technical";
        error.code = "isolation_failure";
        throw error;
      },
      { module: "test" }
    );
    events.Handlers.registerHandler(
      "test.isolation.good",
      async () => {
        goodRuns += 1;
        return { ok: true };
      },
      { module: "test" }
    );
    events.Registry.createEventType(db, { code: "WidgetIsolation" }, actor);
    events.Subscriptions.createSubscription(
      db,
      { code: "widget-isolation-bad", event_type_code: "WidgetIsolation", subscriber: "test", handler: "test.isolation.bad", retry_policy: { max_attempts: 1 } },
      actor
    );
    events.Subscriptions.createSubscription(
      db,
      { code: "widget-isolation-good", event_type_code: "WidgetIsolation", subscriber: "test", handler: "test.isolation.good" },
      actor
    );
    events.Subscriptions.setSubscriptionStatus(db, "widget-isolation-bad", "active", actor);
    events.Subscriptions.setSubscriptionStatus(db, "widget-isolation-good", "active", actor);

    const published = events.publishEvent(db, { event_type_code: "WidgetIsolation", payload: {} }, actor, { useOutbox: false });
    const summary = await events.Consumer.processDeliveries(db, { limit: 50 });
    assert.equal(summary.dead_lettered, 1, "the poison handler dead-lettered");
    assert.equal(summary.delivered, 1, "the healthy sibling still delivered");
    assert.equal(goodRuns, 1);

    const deliveries = events.Publisher.listDeliveries(db, { eventId: published.id, pageSize: 50 }).items;
    assert.equal(deliveries.find((d) => d.handler === "test.isolation.bad").status, "dead_letter");
    assert.equal(deliveries.find((d) => d.handler === "test.isolation.good").status, "delivered");
  });

  test("an outbox event survives a broker outage and publishes after recovery", async () => {
    // Drain events queued by earlier setup (for example event-driven quality
    // evaluation) so this test isolates the durability of its own event.
    await events.Outbox.processOutbox(db, { limit: 500 });
    const published = events.publishEvent(db, { event_type_code: "WidgetBroker", payload: { n: 1 } }, actor);
    const failingRoute = async () => {
      const error = new Error("ECONNREFUSED broker unavailable");
      error.category = "network";
      error.code = "network_unreachable";
      throw error;
    };

    const outage = await events.Outbox.processOutbox(db, { route: failingRoute });
    assert.equal(outage.retried, 1, "the outage was retried, not dropped");
    const row = queryOne(db, "SELECT * FROM event_outbox WHERE event_ref = ?", [published.event_ref]);
    assert.equal(row.status, "failed");
    assert.ok(row.next_retry_at, "a backoff schedule was recorded");

    run(db, "UPDATE event_outbox SET next_retry_at = NULL WHERE id = ?", [row.id]);
    const recovered = await events.Outbox.processOutbox(db);
    assert.equal(recovered.published, 1, "the event published once the broker recovered");
    const finalRow = queryOne(db, "SELECT * FROM event_outbox WHERE id = ?", [row.id]);
    assert.equal(finalRow.status, "published");
  });

  test("a crashed consumer's delivery is reclaimed after its lease expires", async () => {
    events.Handlers.registerHandler(
      "test.lease.good",
      async () => ({ ok: true }),
      { module: "test" }
    );
    events.Registry.createEventType(db, { code: "WidgetLease" }, actor);
    events.Subscriptions.createSubscription(
      db,
      { code: "widget-lease-sub", event_type_code: "WidgetLease", subscriber: "test", handler: "test.lease.good" },
      actor
    );
    events.Subscriptions.setSubscriptionStatus(db, "widget-lease-sub", "active", actor);
    events.publishEvent(db, { event_type_code: "WidgetLease", payload: {} }, actor, { useOutbox: false });

    const claimed = events.Consumer.claimDeliveries(db, { worker: "crashed-worker", limit: 50 });
    const target = claimed.find((d) => d.event_type_code === "WidgetLease");
    assert.ok(target, "the crashed worker claimed the delivery");
    assert.equal(target.status, "processing");

    run(db, "UPDATE event_deliveries SET visibility_expires_at = ? WHERE id = ?", ["2000-01-01 00:00:00", target.id]);
    const reclaimed = events.Consumer.releaseStaleDeliveries(db);
    assert.ok(reclaimed.reclaimed >= 1, "the expired lease was reclaimed");
    const requeued = queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [target.id]);
    assert.equal(requeued.status, "retry");
    assert.equal(requeued.error_category, "timeout");

    const summary = await events.Consumer.processDeliveries(db, { limit: 50 });
    assert.ok(summary.delivered >= 1, "a healthy worker redelivered the reclaimed message");
    const finished = queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [target.id]);
    assert.equal(finished.status, "delivered");
  });
});
