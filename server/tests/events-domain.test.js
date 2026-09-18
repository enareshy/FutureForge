process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne, queryAll } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as events from "../services/events.js";
import * as objects from "../services/objects.js";
import * as files from "../services/files.js";
import * as users from "../services/users.js";

// Verifies that business modules publish domain events through the Event &
// Messaging Framework (transactional outbox) and that the seeded default
// subscriptions route them to the built-in consumers.

const ACTOR = { id: 1, username: "admin" };
const IP = "127.0.0.1";

describe("event framework domain integration", () => {
  let db;
  let tenantId;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
  });

  after(() => db.close());

  test("seeds idempotent default subscriptions bound to built-in handlers", () => {
    const first = events.Subscriptions.ensureDefaultSubscriptions(db);
    const second = events.Subscriptions.ensureDefaultSubscriptions(db);
    assert.equal(second.created, 0, "default subscriptions are idempotent");
    assert.equal(first.total, 13);
    const subs = events.Subscriptions.listSubscriptions(db, { pageSize: 100 }).items;
    assert.ok(subs.some((s) => s.code === "event-search-lifecycle" && s.handler === "search.index"));
    assert.ok(subs.some((s) => s.code === "event-workflow-item-status" && s.handler === "workflow.trigger"));
    assert.ok(subs.some((s) => s.code === "event-analytics-lifecycle" && s.handler === "analytics.record"));
    assert.ok(subs.some((s) => s.code === "event-notify-product-released" && s.handler === "notification.dispatch"));
    assert.ok(subs.every((s) => s.status === "active"));
  });

  test("object writes publish outbox events", async () => {
    const created = objects.createObject(
      db,
      {
        type: "product",
        code: "EVT-DOMAIN-1",
        name: "Evented product",
        data: { "part.number": "EVT-DOMAIN-1", "part.name": "Evented product", "part.category": "mechanical", "part.status": "draft" },
      },
      ACTOR,
      tenantId,
      IP
    );

    const createdEvent = queryOne(
      db,
      "SELECT * FROM event_records WHERE event_type_code = 'ObjectCreated' AND source_object_id = ?",
      [String(created.id)]
    );
    assert.ok(createdEvent, "ObjectCreated event is stored");
    assert.equal(createdEvent.status, "queued", "event is persisted to the outbox");

    objects.setObjectStatus(db, created.id, "released", ACTOR, tenantId, IP);
    const statusEvent = queryOne(
      db,
      "SELECT * FROM event_records WHERE event_type_code = 'ItemStatusChanged' AND source_object_id = ? ORDER BY id DESC LIMIT 1",
      [String(created.id)]
    );
    assert.ok(statusEvent, "ItemStatusChanged event is stored");
    assert.equal(statusEvent.status, "queued");
  });

  test("outbox publishing fans out to default subscribers and consumers run", async () => {
    const statusEvent = queryOne(db, "SELECT * FROM event_records WHERE event_type_code = 'ItemStatusChanged' ORDER BY id DESC LIMIT 1");
    assert.ok(statusEvent);

    await events.processOutbox(db, { limit: 500 });

    const deliveries = queryAll(db, "SELECT * FROM event_deliveries WHERE event_id = ?", [statusEvent.id]);
    assert.ok(deliveries.length >= 1, "the event was routed to subscribers");
    assert.ok(deliveries.some((d) => d.handler === "workflow.trigger"), "default workflow subscriber received the event");

    await events.consume(db, { limit: 200, ignoreIdempotency: false });

    const handled = queryOne(
      db,
      "SELECT * FROM event_deliveries WHERE event_id = ? AND handler = 'workflow.trigger'",
      [statusEvent.id]
    );
    assert.equal(handled.status, "delivered", "the workflow consumer acknowledged the delivery");
  });

  test("repaired catalogue keeps the system flag for auto-registered codes", () => {
    const totalSystem = queryOne(db, "SELECT COUNT(*) AS c FROM event_registry WHERE system = 1").c;
    assert.ok(totalSystem >= 30);
    const objectCreated = queryOne(db, "SELECT system FROM event_registry WHERE code = 'ObjectCreated'");
    assert.equal(Number(objectCreated.system), 1);
  });

  test("file lifecycle emits DocumentCreated and DocumentReleased", async () => {
    const admin = queryOne(db, "SELECT * FROM users WHERE username = 'admin'");
    const scope = admin.tenant_id ?? admin.organization_id;
    const init = files.initiateUpload(db, { name: "evt-doc.txt", size: 5 }, admin, scope, IP);
    const uploaded = await files.completeUpload(db, init.upload.upload_id, { buffer: Buffer.from("hello") }, admin, scope, IP);

    const created = queryOne(
      db,
      "SELECT * FROM event_records WHERE event_type_code = 'DocumentCreated' AND source_object_id = ?",
      [String(uploaded.file.id)]
    );
    assert.ok(created, "DocumentCreated event is stored");
    assert.equal(created.source_module, "files");

    files.checkOutFile(db, uploaded.file.file_ref, {}, admin, scope, IP);
    await files.checkInFile(db, uploaded.file.file_ref, { buffer: Buffer.from("hello v2") }, admin, scope, IP);
    const released = queryOne(
      db,
      "SELECT * FROM event_records WHERE event_type_code = 'DocumentReleased' AND source_object_id = ?",
      [String(uploaded.file.id)]
    );
    assert.ok(released, "DocumentReleased event is stored");
  });

  test("user lifecycle emits UserCreated and UserUpdated", () => {
    const created = users.createUser(
      db,
      {
        username: "evt.user.one",
        email: "evt.user.one@example.com",
        employee_id: "EVT1001",
        display_name: "Event User One",
        password: "EventUser!42x",
        organization_id: tenantId,
      },
      ACTOR,
      IP
    );
    const createdEvent = queryOne(
      db,
      "SELECT * FROM event_records WHERE event_type_code = 'UserCreated' AND source_object_id = ?",
      [String(created.id)]
    );
    assert.ok(createdEvent, "UserCreated event is stored");
    assert.equal(createdEvent.source_module, "iam");

    users.updateUser(db, created.id, { display_name: "Event User Renamed" }, ACTOR, IP);
    const updatedEvent = queryOne(
      db,
      "SELECT * FROM event_records WHERE event_type_code = 'UserUpdated' AND source_object_id = ?",
      [String(created.id)]
    );
    assert.ok(updatedEvent, "UserUpdated event is stored");
    const payload = JSON.parse(updatedEvent.payload_json);
    assert.equal(payload.changed.display_name, true);
    assert.equal(payload.after.display_name, "Event User Renamed");
  });
});
