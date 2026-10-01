import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase, queryOne, queryAll } from "../db.js";
import { seedDatabase } from "../seed.js";
import { createRule, publish, publishAsync } from "../services/notifications.js";

let database;
let tenantId;
let recipientId;

before(() => {
  database = openTestDatabase();
  migrate(database);
  seedDatabase(database);
  const tenant = queryOne(database, "SELECT id FROM organizations WHERE kind = 'tenant' ORDER BY id LIMIT 1");
  tenantId = tenant.id;
  const user = queryOne(
    database,
    "SELECT id FROM users WHERE status = 'active' AND tenant_id = ? ORDER BY id LIMIT 1",
    [tenantId]
  );
  recipientId = user.id;
});

function makeRule(code, eventType, channels = ["in_app"]) {
  const existing = queryOne(database, "SELECT id FROM notification_rules WHERE code = ?", [code]);
  if (existing) return existing.id;
  const rule = createRule(
    database,
    {
      code,
      name: code,
      event_type: eventType,
      channels,
      priority: "normal",
      recipient: { items: [{ type: "user", id: recipientId }] },
      tenant_id: tenantId,
    },
    { id: 1, username: "admin", tenant_id: tenantId },
    "test",
    tenantId
  );
  return rule.id;
}

describe("async notification publish pipeline", () => {
  test("publishAsync fans an event out to rules, notifications and deliveries", async () => {
    const eventType = "async.test.pipeline";
    makeRule("async-test-pipeline", eventType);
    const summary = await publishAsync(
      database,
      {
        event_type: eventType,
        source_module: "test",
        tenant_id: tenantId,
        object_type: "object",
        object_id: "OBJ-ASYNC-1",
        object_name: "Async Object",
        payload: {},
      },
      { actor: { id: 1, username: "admin", tenant_id: tenantId } }
    );
    assert.equal(summary.published, true);
    assert.ok(summary.event_id > 0);
    assert.ok(summary.notifications.length >= 1);

    const event = queryOne(database, "SELECT * FROM notification_events WHERE id = ?", [summary.event_id]);
    assert.equal(event.status, "processed");
    assert.ok(event.rule_count >= 1);

    const notificationId = summary.notifications[0];
    const notification = queryOne(database, "SELECT * FROM notifications WHERE id = ?", [notificationId]);
    assert.equal(notification.recipient_id, recipientId);
    assert.equal(notification.channel, "in_app");
    assert.equal(notification.status, "sent");

    const delivery = queryOne(
      database,
      "SELECT * FROM notification_deliveries WHERE notification_id = ?",
      [notificationId]
    );
    assert.ok(delivery);
    assert.equal(delivery.status, "sent");
  });

  test("publishAsync is idempotent on idempotency_key", async () => {
    const eventType = "async.test.idempotent";
    makeRule("async-test-idempotent", eventType);
    const key = `async-idem-${Date.now()}`;
    const first = await publishAsync(database, { event_type: eventType, source_module: "test", tenant_id: tenantId, idempotency_key: key, payload: {} });
    const second = await publishAsync(database, { event_type: eventType, source_module: "test", tenant_id: tenantId, idempotency_key: key, payload: {} });
    assert.equal(first.published, true);
    assert.equal(second.published, false);
    assert.equal(second.reason, "duplicate");
    assert.equal(second.event_id, first.event_id);
  });

  test("publishAsync matches the synchronous publish outcome", async () => {
    const eventType = "async.test.parity";
    makeRule("async-test-parity", eventType);
    const sync = publish(database, { event_type: eventType, source_module: "test", tenant_id: tenantId, payload: {} });
    const async_ = await publishAsync(database, { event_type: eventType, source_module: "test", tenant_id: tenantId, payload: {} });
    assert.equal(async_.published, sync.published);
    assert.equal(async_.notifications.length, sync.notifications.length);
    const syncNotif = queryOne(database, "SELECT * FROM notifications WHERE id = ?", [sync.notifications[0]]);
    const asyncNotif = queryOne(database, "SELECT * FROM notifications WHERE id = ?", [async_.notifications[0]]);
    assert.equal(asyncNotif.recipient_id, syncNotif.recipient_id);
    assert.equal(asyncNotif.channel, syncNotif.channel);
    assert.equal(asyncNotif.subject, syncNotif.subject);
  });

  test("publishAsync schedules a reminder when the rule enables one", async () => {
    const eventType = "async.test.reminder";
    const code = "async-test-reminder";
    const existing = queryOne(database, "SELECT id FROM notification_rules WHERE code = ?", [code]);
    if (!existing) {
      createRule(
        database,
        {
          code,
          name: code,
          event_type: eventType,
          channels: ["in_app"],
          priority: "normal",
          recipient: { items: [{ type: "user", id: recipientId }] },
          reminder: { enabled: true, offset_minutes: 60, subject: "Async reminder" },
          tenant_id: tenantId,
        },
        { id: 1, username: "admin", tenant_id: tenantId },
        "test",
        tenantId
      );
    }
    const summary = await publishAsync(database, { event_type: eventType, source_module: "test", tenant_id: tenantId, payload: {} });
    assert.equal(summary.published, true);
    const reminder = queryOne(
      database,
      "SELECT * FROM notification_reminders WHERE notification_id = ?",
      [summary.notifications[0]]
    );
    assert.ok(reminder);
    assert.equal(reminder.status, "pending");
  });
});
