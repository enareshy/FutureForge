import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne, queryAll, run } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as d from "../services/delivery.js";
import * as n from "../services/notifications.js";

const past = (minutes = 5) => new Date(Date.now() - minutes * 60000).toISOString().replace("T", " ").slice(0, 19);

describe("communication & delivery services", () => {
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

  describe("delivery requests and worker", () => {
    test("submits idempotently and delivers in-app requests", () => {
      const first = d.submitRequest(
        db,
        {
          tenant_id: tenantId,
          recipient_id: admin.id,
          recipient_address: admin.email,
          channel: "in_app",
          subject: "Delivered request",
          body: "hello",
          source_module: "test",
          idempotency_key: "svc-in-app-1",
        },
        { actor: admin }
      );
      assert.equal(first.status, "queued");
      assert.equal(first.status_label, "QUEUED");

      const duplicate = d.submitRequest(
        db,
        { tenant_id: tenantId, recipient_id: admin.id, channel: "in_app", subject: "Delivered request", body: "hello", idempotency_key: "svc-in-app-1" },
        { actor: admin }
      );
      assert.equal(duplicate.id, first.id);
      assert.equal(duplicate.duplicate, true);

      const stats = d.processDue(db, { tenantId });
      assert.ok(stats.processed >= 1);
      const request = d.getRequest(db, first.id, tenantId);
      assert.ok(["sent", "delivered"].includes(request.status));
      assert.equal(request.provider_code, "in-app-store");
      assert.equal(d.listAttempts(db, first.id).length, 1);
    });

    test("validates requests and requires a channel", () => {
      assert.throws(() => d.submitRequest(db, { tenant_id: tenantId, subject: "no channel" }, { actor: admin }), /channel/);
      assert.throws(() => d.submitRequest(db, { tenant_id: tenantId, channel: "email", subject: "no address" }, { actor: admin }), /recipient address/);
      assert.throws(() => d.submitRequest(db, { tenant_id: tenantId, channel: "in_app", subject: "bad priority", priority: "sometime" }, { actor: admin }), /priority/i);
    });

    test("dead-letters permanent failures, raises an alert and allows retry", () => {
      const request = d.submitRequest(
        db,
        { tenant_id: tenantId, recipient_id: admin.id, channel: "webhook", subject: "Will fail", body: "x", max_attempts: 1, idempotency_key: "svc-fail-1" },
        { actor: admin }
      );
      const stats = d.processDue(db, { tenantId });
      assert.ok(stats.failed >= 1);
      const after = d.getRequest(db, request.id, tenantId);
      assert.equal(after.status, "failed");
      assert.equal(after.dead_letter, true);
      assert.equal(after.error_code, "provider_not_configured");

      const alerts = d.listAlerts(db, {}, tenantId);
      assert.ok(alerts.items.some((a) => a.request_id === request.id && a.severity === "critical"));

      const failures = d.listProviderFailures(db, {}, tenantId);
      assert.ok(failures.some((f) => f.request_id === request.id && f.permanent));

      const retried = d.retryRequest(db, request.id, { tenantId, actor: admin });
      assert.equal(retried.retried, true);
      assert.equal(retried.request.status, "queued");
    });

    test("retries transient failures with backoff before dead-lettering", () => {
      d.registerCustomTransport("svc-transient", () => ({ ok: false, response: {}, delivered: false, provider: "svc-transient", error: "temporary glitch", error_code: "transport_timeout", permanent: false, retryable: true }));
      d.createDeliveryProvider(
        db,
        { code: "svc-transient", name: "Transient transport", channel: "sms", type: "custom", enabled: true, status: "active", max_attempts: 3 },
        admin,
        "test"
      );
      const request = d.submitRequest(
        db,
        { tenant_id: tenantId, recipient_id: admin.id, channel: "sms", subject: "Transient", body: "x", provider_code: "svc-transient", max_attempts: 3, idempotency_key: "svc-retry-1" },
        { actor: admin }
      );
      d.processDue(db, { tenantId });
      let row = d.getRequest(db, request.id, tenantId);
      assert.equal(row.status, "retrying");
      assert.equal(row.attempt, 1);
      assert.equal(row.error_code, "transport_timeout");

      // Force exhaustion to reach the dead-letter state.
      run(db, "UPDATE delivery_requests SET max_attempts = 1 WHERE id = ?", [request.id]);
      run(db, "UPDATE delivery_requests SET scheduled_at = ? WHERE id = ?", [past(1), request.id]);
      d.processDue(db, { tenantId });
      row = d.getRequest(db, request.id, tenantId);
      assert.equal(row.status, "dead_lettered");
      assert.equal(row.dead_letter, true);
    });

    test("cancels queued requests and reports already-terminal ones", () => {
      const request = d.submitRequest(
        db,
        { tenant_id: tenantId, recipient_id: admin.id, channel: "in_app", subject: "Cancel me", body: "x", idempotency_key: "svc-cancel-1" },
        { actor: admin }
      );
      const cancelled = d.cancelRequest(db, request.id, { tenantId, actor: admin });
      assert.equal(cancelled.cancelled, true);
      assert.equal(cancelled.request.status, "cancelled");
      const again = d.cancelRequest(db, request.id, { tenantId, actor: admin });
      assert.equal(again.cancelled, false);
      assert.equal(again.reason, "already_terminal");
    });

    test("keeps requests tenant-scoped", () => {
      const request = d.submitRequest(
        db,
        { tenant_id: tenantId, recipient_id: operator.id, channel: "in_app", subject: "Scoped", body: "x", idempotency_key: "svc-scope-1" },
        { actor: admin }
      );
      assert.throws(() => d.getRequest(db, request.id, tenantId + 999), /not found/i);
    });
  });

  describe("provider configuration", () => {
    test("creates providers, masks secrets and resolves a failover chain", () => {
      const created = d.createDeliveryProvider(
        db,
        {
          code: "svc-webhook",
          name: "Service Webhook",
          channel: "webhook",
          type: "webhook",
          config: { webhook_url: "https://example.com/hook", timeout_ms: 5000 },
          api_key: "top-secret",
          is_default: true,
          priority: 5,
          rate_limit_per_minute: 120,
          max_attempts: 4,
        },
        admin,
        "127.0.0.1"
      );
      assert.equal(created.code, "svc-webhook");
      assert.equal(created.is_default, true);
      assert.equal(created.rate_limit_per_minute, 120);
      assert.equal(created.secrets_configured.api_key, true);
      assert.equal(created.config.api_key, undefined);
      assert.equal(JSON.stringify(created).includes("top-secret"), false);

      const chain = d.resolveProviderChain(db, { channel: "webhook", tenantId });
      assert.ok(chain.length >= 1);
      assert.equal(chain[0].code, "svc-webhook");

      const tested = d.testDeliveryProvider(db, "svc-webhook", {});
      assert.equal(tested.ok, true);

      const disabled = d.setDeliveryProviderStatus(db, "svc-webhook", "inactive", admin, "127.0.0.1");
      assert.equal(disabled.enabled, false);
      assert.equal(d.resolveProviderChain(db, { channel: "webhook", tenantId }).some((p) => p.code === "svc-webhook"), false);
    });

    test("reports provider health including global providers", () => {
      const health = d.providerHealth(db, tenantId);
      assert.ok(health.total >= 2);
      assert.ok(health.items.some((p) => p.code === "in-app-store"));
      assert.ok(health.availability >= 0 && health.availability <= 100);
    });

    test("summarizes provider failures", () => {
      const summary = d.providerFailureSummary(db, tenantId);
      assert.ok(Array.isArray(summary));
    });
  });

  describe("rate limiting", () => {
    test("throws 429 when a bucket is exhausted and records events otherwise", () => {
      const options = { tenantId, providerId: 999, action: "test-send", limit: 2, windowSeconds: 60 };
      d.assertDeliveryRateLimit(db, options);
      d.assertDeliveryRateLimit(db, options);
      assert.throws(() => d.assertDeliveryRateLimit(db, options), /rate limit/i);
      const status = d.rateLimitStatus(db, options);
      assert.equal(status.allowed, false);
      assert.equal(status.count, 2);
    });
  });

  describe("reminders", () => {
    test("sweeps due reminders, records runs and repeats while configured", () => {
      const scheduled = d.scheduleReminder(
        db,
        {
          tenant_id: tenantId,
          recipient_id: operator.id,
          kind: "overdue",
          due_at: past(5),
          repeat_minutes: 30,
          max_repeats: 2,
          dedupe_key: "svc-reminder-1",
          details: { subject: "Reminder one", channel: "in_app", body: "tick" },
        },
        { actor: admin }
      );
      const id = scheduled.id;
      // Dedupe key prevents a duplicate schedule.
      const duplicate = d.scheduleReminder(db, { tenant_id: tenantId, due_at: past(5), dedupe_key: "svc-reminder-1" }, { actor: admin });
      assert.equal(duplicate.id, id);

      const summary = d.sweepReminders(db, { tenantId, actor: admin });
      assert.ok(summary.fired >= 1);
      assert.equal(summary.requests.length >= 1, true);

      const reminder = d.getReminder(db, id, tenantId);
      assert.equal(reminder.status, "pending");
      assert.equal(reminder.repeat_count, 1);
      assert.ok(reminder.runs.length >= 1);
    });

    test("stops reminders for a completed object", () => {
      const scheduled = d.scheduleReminder(
        db,
        {
          tenant_id: tenantId,
          recipient_id: operator.id,
          object_type: "svc-task",
          object_id: "SVC-1",
          due_at: past(5),
          stop_on_complete: true,
          details: { subject: "Stop me", channel: "in_app" },
        },
        { actor: admin }
      );
      const result = d.completeRemindersForObject(db, { objectType: "svc-task", objectId: "SVC-1", tenantId, reason: "done" });
      assert.equal(result.completed >= 1, true);
      assert.equal(d.getReminder(db, scheduled.id, tenantId).status, "completed");
    });
  });

  describe("escalations", () => {
    test("schedules, fires and advances escalation levels", () => {
      const escalation = d.scheduleEscalation(
        db,
        {
          tenant_id: tenantId,
          object_type: "svc-change",
          object_id: "CHG-1",
          object_name: "Change one",
          recipient: { items: [{ type: "user", id: operator.id }] },
          level: 1,
          max_level: 2,
          after_minutes: 0,
          dedupe_key: "svc-escalation-1",
          details: { subject: "Escalate", channel: "in_app", body: "please act" },
        },
        { actor: admin }
      );
      assert.equal(escalation.status, "pending");
      const summary = d.sweepEscalations(db, { tenantId, actor: admin });
      assert.ok(summary.escalated >= 1);
      const advanced = d.getEscalation(db, escalation.id, tenantId);
      assert.equal(advanced.status, "pending");
      assert.equal(advanced.level, 2);

      // Completing the object cancels the pending escalation chain.
      d.completeEscalationsForObject(db, { objectType: "svc-change", objectId: "CHG-1", tenantId, reason: "resolved" });
      assert.equal(d.getEscalation(db, escalation.id, tenantId).status, "completed");
    });
  });

  describe("notification hand-off", () => {
    test("ingests a finished notification idempotently and never double-queues", () => {
      const notificationId = n.deliverDirect(db, {
        user: operator,
        tenantId,
        channel: "in_app",
        subject: "Handoff notification",
        body: "hello",
        idempotencyKey: "svc-notif-handoff-1",
      });
      const notification = queryOne(db, "SELECT * FROM notifications WHERE id = ?", [notificationId]);
      const request = d.ingestNotification(db, notification, { actor: admin });
      assert.equal(request.notification_id, notificationId);
      assert.equal(request.status, "queued");
      const again = d.ingestNotification(db, notification, { actor: admin });
      assert.equal(again.id, request.id);
      assert.equal(again.duplicate, true);
      assert.equal(d.requestsForNotification(db, notificationId).length, 1);
    });
  });

  describe("tracking", () => {
    test("reports metrics, stats and a timeseries", () => {
      const metrics = d.deliveryMetrics(db, { tenantId });
      assert.ok(metrics.total >= 1);
      assert.ok(metrics.by_status);
      assert.ok(Array.isArray(metrics.by_channel));
      assert.ok(Array.isArray(metrics.timeseries));
      assert.equal(metrics.providers.total >= 2, true);

      const stats = d.deliveryStats(db, tenantId);
      assert.equal(typeof stats.queued, "number");
      assert.equal(typeof stats.sent, "number");
      assert.equal(typeof stats.dead_letter, "number");

      const series = d.deliveryTimeseries(db, { tenantId });
      assert.ok(Array.isArray(series));
    });

    test("lists and acknowledges operational alerts", () => {
      const alert = d.createAlert(db, { type: "delivery_failed", severity: "warning", tenantId, channel: "email", message: "unit test alert" });
      const ack = d.acknowledgeAlert(db, alert.id, { actor: admin });
      assert.equal(ack.status, "acknowledged");
      assert.ok(d.listAlerts(db, { status: "acknowledged" }, tenantId).items.some((a) => a.id === alert.id));
    });
  });

  describe("worker lifecycle", () => {
    test("processes a batch on demand and stops gracefully", async () => {
      const worker = d.createWorker(db, { intervalMs: 60000, batchSize: 5, tenantId, logger: { error() {} } });
      worker.start();
      const status = worker.status();
      assert.equal(status.started, true);
      assert.ok(status.ticks >= 1);
      await worker.stop();
      assert.equal(worker.status().started, false);
    });
  });
});
