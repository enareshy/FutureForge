import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as d from "../services/delivery.js";

const past = (minutes = 5) => new Date(Date.now() - minutes * 60000).toISOString().replace("T", " ").slice(0, 19);

describe("async delivery sweeps", () => {
  let db;
  let tenantId;
  let admin;
  let operator;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    admin = queryOne(db, "SELECT * FROM users WHERE username = 'admin'");
    operator = queryOne(db, "SELECT * FROM users WHERE username = 'j.patel'");
  });

  after(() => db?.close());

  test("sweepRemindersAsync fires and repeats a due reminder on the async layer", async () => {
    const scheduled = d.scheduleReminder(
      db,
      {
        tenant_id: tenantId,
        recipient_id: operator.id,
        kind: "overdue",
        due_at: past(5),
        repeat_minutes: 30,
        max_repeats: 2,
        dedupe_key: "async-reminder-1",
        details: { subject: "Async reminder", channel: "in_app", body: "tick" },
      },
      { actor: admin }
    );

    const summary = await d.sweepRemindersAsync(db, { tenantId, actor: admin });
    assert.ok(summary.fired >= 1);
    assert.ok(summary.requests.length >= 1);

    const reminder = await d.getReminderAsync(db, scheduled.id, tenantId);
    assert.equal(reminder.status, "pending");
    assert.equal(reminder.repeat_count, 1);
    assert.ok(reminder.runs.length >= 1);

    const request = queryOne(db, "SELECT * FROM delivery_requests WHERE id = ?", [summary.requests[0]]);
    assert.ok(request);
  });

  test("sweepEscalationsAsync fires and advances an escalation on the async layer", async () => {
    const escalation = d.scheduleEscalation(
      db,
      {
        tenant_id: tenantId,
        object_type: "async-change",
        object_id: "ACHG-1",
        object_name: "Async change",
        recipient: { items: [{ type: "user", id: operator.id }] },
        level: 1,
        max_level: 2,
        after_minutes: 0,
        dedupe_key: "async-escalation-1",
        details: { subject: "Escalate async", channel: "in_app", body: "please act" },
      },
      { actor: admin }
    );
    assert.equal(escalation.status, "pending");

    const summary = await d.sweepEscalationsAsync(db, { tenantId, actor: admin });
    assert.ok(summary.escalated >= 1);
    assert.ok(summary.requests.length >= 1);

    const advanced = await d.getEscalationAsync(db, escalation.id, tenantId);
    assert.equal(advanced.status, "pending");
    assert.equal(advanced.level, 2);
  });

  test("processDueAsync delivers a queued request", async () => {
    const request = d.submitRequest(
      db,
      {
        tenant_id: tenantId,
        source_module: "test",
        recipient_id: operator.id,
        recipient_name: "J Patel",
        recipient_address: "j.patel@example.com",
        channel: "in_app",
        subject: "Async process",
        body: "deliver me",
      },
      { actor: admin }
    );
    const summary = await d.processDueAsync(db, { limit: 50, tenantId });
    const reloaded = queryOne(db, "SELECT * FROM delivery_requests WHERE id = ?", [request.id]);
    assert.ok(["sent", "delivered", "processing"].includes(reloaded.status));
    assert.ok(summary);
  });
});
