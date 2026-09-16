import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne, queryAll, run } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as n from "../services/notifications.js";

const CHANNELS = n.CHANNELS;

describe("notification framework services", () => {
  let db;
  let tenantId;
  let admin;
  let operator;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    admin = queryOne(db, "SELECT * FROM users WHERE username = 'admin'");
    operator = queryOne(db, "SELECT * FROM users WHERE username = 'j.patel'");
  });

  after(() => db?.close());

  describe("template engine and validation", () => {
    test("renders allowlisted placeholders and escapes HTML", () => {
      const out = n.renderTemplate("<p>{{object.name}}</p>", { object: { name: "<script>x</script>" } }, { html: true });
      assert.equal(out, "<p>&lt;script&gt;x&lt;/script&gt;</p>");
    });

    test("rejects unknown or unsafe template variables", () => {
      assert.throws(() => n.validateTemplateVariables("{{ process.env.PATH }}"), /Unsafe|Unknown/);
      assert.throws(() => n.validateTemplateVariables("{{ malicious() }}"), /Unsafe|Unknown/);
      assert.deepEqual(n.validateTemplateVariables("{{object.name}} {{recipient.email}}").sort(), ["object.name", "recipient.email"]);
    });

    test("rejects explicit script tags", () => {
      assert.throws(() => n.assertTemplateInput({ subject: "hi", html_body: "<script>alert(1)</script>" }), /script/);
    });

    test("sanitizes active content", () => {
      const clean = n.sanitizeHtml('<div onclick="steal()"><a href="javascript:evil()">x</a></div>');
      assert.ok(!/onclick/i.test(clean));
      assert.ok(!/javascript:/i.test(clean));
    });
  });

  describe("recipient resolution", () => {
    test("resolves a role to its active users", () => {
      const users = n.resolveRecipients(db, { items: [{ type: "role", ref: "app.reader" }] }, { initiator: {} }, tenantId);
      const ids = users.map((u) => u.id);
      assert.ok(ids.includes(admin.id));
      assert.ok(ids.includes(operator.id));
    });

    test("resolves an organization subtree", () => {
      const users = n.resolveRecipients(db, { items: [{ type: "organization", id: tenantId }] }, { initiator: {} }, tenantId);
      assert.ok(users.length >= 2);
    });

    test("resolves event payload paths and dedupes", () => {
      const context = { initiator: { id: admin.id }, payload: { assignee_id: operator.id, watcher_id: operator.id } };
      const users = n.resolveRecipients(
        db,
        { items: [{ type: "event_payload", value: "assignee_id" }, { type: "event_payload", value: "watcher_id" }] },
        context,
        tenantId
      );
      assert.equal(users.length, 1);
      assert.equal(users[0].id, operator.id);
    });

    test("uses fallback recipients when primary items resolve nobody", () => {
      const users = n.resolveRecipients(
        db,
        { items: [{ type: "event_payload", value: "missing_id" }], fallback: [{ type: "user", id: operator.id }] },
        { initiator: { id: admin.id }, payload: {} },
        tenantId
      );
      assert.equal(users.length, 1);
      assert.equal(users[0].id, operator.id);
    });

    test("excludes the initiator when requested", () => {
      const users = n.resolveRecipients(
        db,
        { items: [{ type: "user", id: admin.id }], include_initiator: false },
        { initiator: { id: admin.id } },
        tenantId
      );
      assert.equal(users.length, 0);
      const withFlag = n.resolveRecipients(
        db,
        { items: [{ type: "user", id: admin.id }] },
        { initiator: { id: admin.id } },
        tenantId
      );
      assert.equal(withFlag[0].isInitiator, true);
    });
  });

  describe("preferences", () => {
    test("quiet hours block email but not in-app", () => {
      n.updatePreferences(db, operator.id, { quiet_hours: { start: "00:00", end: "23:59" } }, null, null, tenantId);
      const now = new Date();
      now.setHours(12, 0, 0, 0);
      const email = n.evaluatePreference(db, { id: operator.id }, "email", "task.assigned", tenantId, { now });
      const inApp = n.evaluatePreference(db, { id: operator.id }, "in_app", "task.assigned", tenantId, { now });
      assert.equal(email.allowed, false);
      assert.equal(email.reason, "quiet_hours");
      assert.equal(inApp.allowed, true);
      n.updatePreferences(db, operator.id, { quiet_hours: {} }, null, null, tenantId);
    });

    test("self_notify off blocks notifications caused by the recipient", () => {
      n.updatePreferences(db, operator.id, { self_notify: false }, null, null, tenantId);
      const decision = n.evaluatePreference(db, { id: operator.id, isInitiator: true }, "in_app", "task.assigned", tenantId);
      assert.equal(decision.allowed, false);
      assert.equal(decision.reason, "self_initiated");
      n.updatePreferences(db, operator.id, { self_notify: true }, null, null, tenantId);
    });

    test("mandatory rules override opt-outs", () => {
      n.updatePreferences(db, operator.id, { in_app: false }, null, null, tenantId);
      const decision = n.evaluatePreference(db, { id: operator.id }, "in_app", "task.assigned", tenantId, { mandatory: true });
      assert.equal(decision.allowed, true);
      n.updatePreferences(db, operator.id, { in_app: true }, null, null, tenantId);
    });
  });

  describe("publish pipeline", () => {
    before(() => {
      n.createTemplate(
        db,
        {
          code: "test.pipeline",
          name: "Pipeline test",
          event_type: "test.pipeline",
          channel: "in_app",
          subject: "Hello {{recipient.username}}",
          html_body: "<p>Object {{object.name}}</p>",
        },
        admin,
        "test",
        tenantId
      );
      n.createRule(
        db,
        {
          code: "test-pipeline-rule",
          name: "Pipeline rule",
          event_type: "test.pipeline",
          template_code: "test.pipeline",
          channels: ["in_app"],
          priority: "high",
          recipient: { items: [{ type: "event_payload", value: "user_id" }] },
          tenant_id: tenantId,
        },
        admin,
        "test",
        tenantId
      );
    });

    test("creates notifications for matching rules", () => {
      const result = n.publish(
        db,
        {
          event_type: "test.pipeline",
          source_module: "test",
          tenant_id: tenantId,
          object_type: "widget",
          object_id: "W-1",
          object_name: "Widget one",
          payload: { user_id: operator.id, deep_link: "/widgets/W-1" },
        },
        { actor: admin }
      );
      assert.equal(result.published, true);
      assert.equal(result.notifications.length, 1);
      const inbox = n.listInbox(db, operator.id, tenantId, { tab: "all" });
      const item = inbox.items.find((i) => i.id === result.notifications[0]);
      assert.equal(item.subject, `Hello ${operator.username}`);
      assert.equal(item.priority, "high");
      assert.equal(item.deep_link, "/widgets/W-1");
    });

    test("is idempotent per event idempotency key", () => {
      const first = n.publish(
        db,
        { event_type: "test.pipeline", tenant_id: tenantId, payload: { user_id: operator.id }, idempotency_key: "evt-1" },
        { actor: admin }
      );
      const second = n.publish(
        db,
        { event_type: "test.pipeline", tenant_id: tenantId, payload: { user_id: operator.id }, idempotency_key: "evt-1" },
        { actor: admin }
      );
      assert.equal(first.published, true);
      assert.equal(second.published, false);
      assert.equal(second.reason, "duplicate");
    });

    test("records skipped events when no rule matches", () => {
      const result = n.publish(db, { event_type: "unmatched.event", tenant_id: tenantId, payload: {} }, { actor: admin });
      const event = n.getEvent(db, result.event_id, tenantId);
      assert.equal(event.status, "skipped");
      assert.equal(event.rule_count, 0);
    });

    test("never throws into the caller on invalid input", () => {
      const result = n.publish(db, { tenant_id: tenantId }, { actor: admin });
      assert.equal(result.published, false);
      assert.ok(result.reason);
    });
  });

  describe("inbox", () => {
    test("isolates notifications to their owner", () => {
      const result = n.publish(
        db,
        {
          event_type: "test.pipeline",
          tenant_id: tenantId,
          payload: { user_id: operator.id, deep_link: "/x" },
        },
        { actor: admin }
      );
      assert.equal(result.notifications.length, 1);
      const id = result.notifications[0];
      assert.throws(() => n.getNotification(db, id, admin.id, tenantId), /not found/i);
      assert.ok(n.getNotification(db, id, operator.id, tenantId));
    });

    test("supports read, unread and unread counts", () => {
      const before = n.unreadCount(db, operator.id, tenantId).unread;
      const item = n.listInbox(db, operator.id, tenantId, { unread: "true" }).items[0];
      n.markRead(db, item.id, operator.id, tenantId, operator);
      assert.equal(n.unreadCount(db, operator.id, tenantId).unread, before - 1);
      n.markUnread(db, item.id, operator.id, tenantId, operator);
      assert.equal(n.unreadCount(db, operator.id, tenantId).unread, before);
      const marked = n.markAllRead(db, operator.id, tenantId, operator);
      assert.ok(marked.updated >= 1);
      assert.equal(n.unreadCount(db, operator.id, tenantId).unread, 0);
    });

    test("archives and soft-deletes without losing history", () => {
      const item = n.listInbox(db, operator.id, tenantId, {}).items[0];
      const archived = n.archiveNotification(db, item.id, operator.id, tenantId, operator);
      assert.equal(archived.archived, true);
      assert.ok(n.listInbox(db, operator.id, tenantId, { archived: "true" }).total >= 1);
      const deleted = n.deleteNotification(db, item.id, operator.id, tenantId, operator);
      assert.equal(deleted.deleted, true);
      assert.equal(queryOne(db, "SELECT id FROM notifications WHERE id = ?", [item.id]).id, item.id);
    });
  });

  describe("delivery queue", () => {
    test("moves failing deliveries to the dead letter after max attempts", () => {
      const notificationId = n.deliverDirect(db, {
        user: operator,
        tenantId,
        channel: "webhook",
        subject: "Webhook test",
        idempotencyKey: "delivery-fail-1",
      });
      assert.ok(notificationId);
      run(db, "UPDATE notification_deliveries SET max_attempts = 1 WHERE notification_id = ?", [notificationId]);
      const stats = n.processQueue(db, {});
      assert.ok(stats.processed >= 1);
      const delivery = queryOne(db, "SELECT * FROM notification_deliveries WHERE notification_id = ?", [notificationId]);
      assert.equal(delivery.status, "dead_letter");
      assert.equal(delivery.dead_letter, 1);
      const notification = queryOne(db, "SELECT * FROM notifications WHERE id = ?", [notificationId]);
      assert.equal(notification.status, "failed");
      assert.equal(n.retryDelivery(db, delivery.id).retried, true);
    });

    test("delivers in-app notifications", () => {
      const notificationId = n.deliverDirect(db, { user: operator, tenantId, channel: "in_app", subject: "In-app test", idempotencyKey: "delivery-ok-1" });
      n.processQueue(db, {});
      const notification = queryOne(db, "SELECT * FROM notifications WHERE id = ?", [notificationId]);
      assert.equal(notification.status, "sent");
    });
  });

  describe("reminders and escalations", () => {
    test("sweeps a due reminder and repeats it", () => {
      const id = n.scheduleReminder(db, {
        tenant_id: tenantId,
        recipient_id: operator.id,
        due_at: n.addMinutes(new Date().toISOString(), -5),
        details: {
          subject: "Overdue task",
          event_type: "task.overdue",
          object_type: "task",
          object_id: "T-9",
          repeat_minutes: 60,
          max_repeats: 1,
        },
      });
      const first = n.sweepReminders(db, { tenantId });
      assert.ok(first.fired >= 1);
      const reminder = queryOne(db, "SELECT * FROM notification_reminders WHERE id = ?", [id]);
      assert.equal(reminder.status, "fired");
      const repeat = queryOne(
        db,
        "SELECT * FROM notification_reminders WHERE status = 'pending' AND level = 1 AND details_json LIKE '%Overdue task%' ORDER BY id DESC LIMIT 1"
      );
      assert.ok(repeat);
      assert.equal(repeat.level, 1);
      n.processQueue(db, {});
      const inbox = n.listInbox(db, operator.id, tenantId, { q: "Overdue task" });
      assert.ok(inbox.total >= 1);
    });

    test("escalates to the configured recipient", () => {
      const published = n.publish(
        db,
        {
          event_type: "test.pipeline",
          tenant_id: tenantId,
          payload: { user_id: operator.id },
        },
        { actor: admin }
      );
      const event = n.getEvent(db, published.event_id, tenantId);
      n.scheduleReminder(db, {
        tenant_id: tenantId,
        event_id: event.id,
        recipient_id: operator.id,
        due_at: n.addMinutes(new Date().toISOString(), -5),
        details: {
          subject: "Escalate me",
          event_type: "test.pipeline",
          escalation: { enabled: true, after_minutes: 0, recipient: { items: [{ type: "initiator" }] } },
        },
      });
      n.sweepReminders(db, { tenantId });
      const second = n.sweepReminders(db, { tenantId });
      assert.ok(second.escalated >= 1);
      n.processQueue(db, {});
      const escalated = n.listInbox(db, admin.id, tenantId, { q: "Escalate me" });
      assert.ok(escalated.total >= 1);
      assert.equal(escalated.items[0].priority, "high");
    });
  });

  describe("providers", () => {
    test("masks secrets and validates configuration", () => {
      const provider = n.createProvider(
        db,
        {
          code: "test-smtp",
          name: "Test SMTP",
          channel: "email",
          type: "smtp",
          config: { host: "smtp.example.com", from_email: "no-reply@example.com", username: "mailer", password: "super-secret" },
        },
        admin,
        "test"
      );
      assert.equal(provider.secrets_configured.password, true);
      assert.equal(provider.config.password, undefined);
      const row = queryOne(db, "SELECT * FROM notification_providers WHERE code = 'test-smtp'");
      assert.ok(!row.secrets_enc.includes("super-secret"));
      const test = n.testProvider(db, "test-smtp", {});
      assert.equal(test.ok, true);
      n.deleteProvider(db, "test-smtp", admin, "test");
    });
  });

  describe("configuration surface", () => {
    test("exposes channel vocabulary", () => {
      assert.ok(CHANNELS.includes("in_app"));
      assert.ok(CHANNELS.includes("email"));
    });
  });
});
