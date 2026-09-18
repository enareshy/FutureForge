import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne, run } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as events from "../services/events.js";

// Service-level coverage for the Event & Messaging Framework: registry + schema
// versioning, the transactional outbox, routing/subscriptions and filters,
// ordered at-least-once consumption with idempotency, retry + dead-letter,
// replay, retention, bus topology and monitoring/traceability.

describe("event & messaging framework services", () => {
  let db;
  let actor;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  });

  test("installs the default event catalogue, topology and retention policies", () => {
    const first = events.ensureEventFoundation(db);
    const second = events.ensureEventFoundation(db);
    assert.ok(first.event_types.total >= 30);
    assert.equal(second.event_types.created, 0, "foundation install is idempotent");

    const types = events.Registry.listEventTypes(db, { pageSize: 100 });
    assert.ok(types.total >= 30);
    assert.ok(types.items.some((t) => t.code === "ProductCreated" && t.category === "product"));
    assert.ok(types.items.some((t) => t.code === "SecurityAccessDenied" && t.replay_policy === "denied"));

    assert.ok(events.Bus.listTopics(db, { pageSize: 100 }).items.some((t) => t.code === "domain-events"));
    assert.ok(events.Bus.listQueues(db, { pageSize: 100 }).items.some((q) => q.code === "event-consumers"));
    assert.ok(events.Bus.listConsumerGroups(db, {}).items.some((g) => g.code === "event-default"));
    assert.ok(events.Retention.listRetentionPolicies(db, { pageSize: 200 }).total >= 30);
  });

  test("registers event types and versions schemas with compatibility checks", () => {
    const created = events.Registry.createEventType(
      db,
      {
        code: "WidgetCreated",
        category: "product",
        source_module: "test",
        schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        example: { name: "bolt" },
      },
      actor
    );
    assert.equal(created.code, "WidgetCreated");
    assert.equal(created.version, 1);
    assert.equal(events.Registry.getEventType(db, "WidgetCreated").schema.required[0], "name");

    const added = events.Registry.addVersion(
      db,
      "WidgetCreated",
      { schema: { type: "object", required: ["name", "qty"], properties: { name: { type: "string" }, qty: { type: "number" } } } },
      actor
    );
    assert.equal(added.version.version, 2);
    assert.equal(added.comparison.compatible, false, "adding a required property is breaking");
    assert.ok(added.comparison.changes.some((c) => c.change === "added_required"));

    const compatible = events.Registry.checkCompatibility(db, "WidgetCreated", {
      schema: { type: "object", required: ["name", "qty"], properties: { name: { type: "string" }, qty: { type: "number" }, color: { type: "string" } } },
    });
    assert.equal(compatible.compatible, true);

    const resolved = events.Registry.resolveSchema(db, "WidgetCreated", 1);
    assert.equal(resolved.resolved, true);
    assert.equal(resolved.version, 1);
    assert.ok(events.Registry.listVersions(db, "WidgetCreated").length >= 2);
  });

  test("validates payloads against the registered schema", () => {
    events.Registry.createEventType(
      db,
      {
        code: "WidgetValidated",
        schema: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
          additionalProperties: false,
        },
      },
      actor
    );
    assert.throws(() => events.publishEvent(db, { event_type_code: "WidgetValidated", payload: {} }, actor, { useOutbox: false }), /schema/);
    assert.throws(() => events.publishEvent(db, { event_type_code: "WidgetValidated", payload: { name: 5 } }, actor, { useOutbox: false }), /schema/);
    assert.throws(() => events.publishEvent(db, { event_type_code: "WidgetValidated", payload: { name: "a", extra: 1 } }, actor, { useOutbox: false }), /schema/);
    const ok = events.publishEvent(db, { event_type_code: "WidgetValidated", payload: { name: "bolt" } }, actor, { useOutbox: false });
    assert.equal(ok.event_type_code, "WidgetValidated");
  });

  test("publishes synchronously and routes events through subscription filters", () => {
    events.Registry.createEventType(db, { code: "WidgetReleased", source_module: "test" }, actor);
    const sub = events.Subscriptions.createSubscription(
      db,
      {
        code: "widget-released-audit",
        event_type_code: "WidgetReleased",
        subscriber: "audit",
        handler: "test.record",
        filter: { "payload.kind": "release" },
      },
      actor
    );
    const validation = events.Subscriptions.validateSubscription(db, sub.code);
    assert.equal(validation.valid, true);
    assert.ok(validation.warnings.some((w) => /not registered/i.test(w)));
    events.Subscriptions.setSubscriptionStatus(db, sub.code, "active", actor);

    const matched = events.publishEvent(db, { event_type_code: "WidgetReleased", payload: { kind: "release" } }, actor, { useOutbox: false });
    assert.equal(matched.deliveries.length, 1);
    assert.equal(matched.deliveries[0].subscriber, "audit");

    const unmatched = events.publishEvent(db, { event_type_code: "WidgetReleased", payload: { kind: "draft" } }, actor, { useOutbox: false });
    assert.equal(unmatched.deliveries.length, 0);

    const eventRow = queryOne(db, "SELECT * FROM event_records WHERE id = ?", [matched.id]);
    const preview = events.Router.previewRoute(db, eventRow);
    assert.equal(preview.length, 1);
    assert.equal(preview[0].handler, "test.record");
  });

  test("publish is idempotent on idempotency_key", () => {
    events.Registry.createEventType(db, { code: "WidgetIdem" }, actor);
    const first = events.publishEvent(db, { event_type_code: "WidgetIdem", payload: {}, idempotency_key: "idem-widget-1" }, actor, { useOutbox: false });
    const second = events.publishEvent(db, { event_type_code: "WidgetIdem", payload: {}, idempotency_key: "idem-widget-1" }, actor, { useOutbox: false });
    assert.equal(second.duplicate, true);
    assert.equal(second.id, first.id);
  });

  test("publishBatch isolates per-event failures", () => {
    events.Registry.createEventType(
      db,
      { code: "WidgetBatch", schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
      actor
    );
    const result = events.Publisher.publishBatch(
      db,
      [
        { event_type_code: "WidgetBatch", payload: { name: "ok" } },
        { event_type_code: "WidgetBatch", payload: {} },
      ],
      actor,
      { useOutbox: false }
    );
    assert.equal(result.total, 2);
    assert.equal(result.published, 1);
    assert.equal(result.failed, 1);
    assert.match(result.failures[0].error, /schema/);
  });

  test("transactional outbox queues events then publishes them", async () => {
    events.Registry.createEventType(db, { code: "WidgetOutbox" }, actor);
    const queued = events.Publisher.publishAsync(db, { event_type_code: "WidgetOutbox", payload: {} }, actor);
    assert.equal(queued.queued, true);
    assert.ok(events.Outbox.outboxStats(db).pending >= 1);
    assert.ok(events.Outbox.listOutbox(db, { status: "pending" }).total >= 1);

    const summary = await events.Outbox.processOutbox(db);
    assert.ok(summary.published >= 1);
    assert.equal(events.Publisher.getEvent(db, queued.event_ref).status, "published");
  });

  test("consumer invokes registered handlers and suppresses duplicate idempotency keys", async () => {
    let calls = 0;
    events.Handlers.registerHandler("test.record", async () => { calls += 1; return { ok: true }; }, { module: "test" });
    assert.ok(events.Handlers.listHandlers().some((h) => h.code === "test.record"));

    events.Registry.createEventType(db, { code: "WidgetConsume" }, actor);
    events.Subscriptions.createSubscription(db, { code: "widget-consume-sub", event_type_code: "WidgetConsume", subscriber: "test", handler: "test.record" }, actor);
    events.Subscriptions.setSubscriptionStatus(db, "widget-consume-sub", "active", actor);
    events.publishEvent(db, { event_type_code: "WidgetConsume", payload: {} }, actor, { useOutbox: false });

    const summary = await events.Consumer.processDeliveries(db);
    assert.ok(summary.delivered >= 1);
    assert.ok(calls >= 1);
    assert.ok(events.Consumer.consumerStats(db).delivered >= 1);

    const d1 = events.Router.enqueueMessage(db, "event-consumers", { handler: "test.record", payload: { a: 1 }, idempotency_key: "dup-key-1" });
    const d2 = events.Router.enqueueMessage(db, "event-consumers", { handler: "test.record", payload: { a: 1 }, idempotency_key: "dup-key-1" });
    await events.Consumer.processDelivery(db, queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [d1.id]));
    const duplicate = await events.Consumer.processDelivery(db, queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [d2.id]));
    assert.equal(duplicate.status, "duplicate");
  });

  test("failed deliveries retry then dead-letter, and operators can requeue", async () => {
    events.Handlers.registerHandler(
      "test.boom",
      async () => {
        const error = new Error("handler exploded");
        error.category = "technical";
        throw error;
      },
      { module: "test" }
    );
    events.Registry.createEventType(db, { code: "WidgetFailure" }, actor);
    events.Subscriptions.createSubscription(
      db,
      { code: "widget-failure-sub", event_type_code: "WidgetFailure", subscriber: "test", handler: "test.boom", retry_policy: { max_attempts: 1 } },
      actor
    );
    events.Subscriptions.setSubscriptionStatus(db, "widget-failure-sub", "active", actor);
    events.publishEvent(db, { event_type_code: "WidgetFailure", payload: {} }, actor, { useOutbox: false });

    const summary = await events.Consumer.processDeliveries(db);
    assert.ok(summary.dead_lettered >= 1);
    const stats = events.DeadLetter.deadLetterStats(db);
    assert.ok(stats.open >= 1);
    assert.ok(stats.by_handler.some((row) => row.handler === "test.boom"));

    const open = events.DeadLetter.listDeadLetters(db, { status: "open" });
    assert.ok(open.total >= 1);
    const resolved = events.DeadLetter.resolveDeadLetter(db, open.items[0].id, { action: "retry", actor });
    assert.equal(resolved.status, "retrying");
  });

  test("buffers out-of-order deliveries until the earlier sequence resolves", async () => {
    events.Registry.createEventType(db, { code: "WidgetOrdered", source_module: "test", ordering_required: true, ordering_scope: "object" }, actor);
    events.Subscriptions.createSubscription(
      db,
      { code: "widget-ordered-sub", event_type_code: "WidgetOrdered", subscriber: "test", handler: "test.record", ordering_required: true, ordering_scope: "object" },
      actor
    );
    events.Subscriptions.setSubscriptionStatus(db, "widget-ordered-sub", "active", actor);

    const first = events.publishEvent(db, { event_type_code: "WidgetOrdered", source_object_id: "AGG-9", payload: {} }, actor, { useOutbox: false });
    const second = events.publishEvent(db, { event_type_code: "WidgetOrdered", source_object_id: "AGG-9", payload: {} }, actor, { useOutbox: false });
    assert.equal(first.sequence_number, 1);
    assert.equal(second.sequence_number, 2);
    assert.equal(first.partition_key, second.partition_key);

    const secondDelivery = events.Publisher.listDeliveries(db, { eventId: second.id }).items[0];
    const result = await events.Consumer.processDelivery(db, queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [secondDelivery.id]));
    assert.equal(result.status, "out_of_order");
    assert.ok(events.Ordering.orderingState(db).buffered >= 1);
  });

  test("manages topics, queues, consumer groups and queue messages", async () => {
    const topic = events.Bus.createTopic(db, { code: "test-topic", name: "Test topic" }, actor);
    assert.equal(topic.code, "test-topic");
    assert.equal(events.Bus.createQueue(db, { code: "test-queue", name: "Test queue", consumer_group: "test-group" }, actor).code, "test-queue");
    assert.equal(events.Bus.createConsumerGroup(db, { code: "test-group", name: "Test group", topic_code: "test-topic", queue_code: "test-queue" }, actor).code, "test-group");
    assert.ok(events.Bus.listTopics(db, {}).items.some((t) => t.code === "test-topic"));
    assert.ok(events.Bus.listQueues(db, {}).items.some((q) => q.code === "test-queue"));
    assert.ok(events.Bus.listConsumerGroups(db, {}).items.some((g) => g.code === "test-group"));

    const message = events.Router.enqueueMessage(db, "test-queue", { handler: "test.record", payload: { x: 1 } }, {});
    assert.equal(message.queue_code, "test-queue");
    assert.ok(events.Bus.queueStats(db, "test-queue").pending >= 1);
    assert.ok(events.Bus.queueDepth(db).total >= 1);
    assert.ok(events.Bus.topologyHealth(db).queues >= 2);

    const processed = await events.Consumer.processDeliveries(db, { queueCode: "test-queue" });
    assert.equal(processed.delivered, 1);
    assert.equal(events.Bus.queueStats(db, "test-queue").depth, 0);
  });

  test("replays a controlled set of events and honours replay policy", async () => {
    events.Registry.createEventType(db, { code: "WidgetReplay", source_module: "test" }, actor);
    events.Subscriptions.createSubscription(db, { code: "widget-replay-sub", event_type_code: "WidgetReplay", subscriber: "test", handler: "test.record" }, actor);
    events.Subscriptions.setSubscriptionStatus(db, "widget-replay-sub", "active", actor);
    events.publishEvent(db, { event_type_code: "WidgetReplay", payload: { n: 1 } }, actor, { useOutbox: false });
    events.publishEvent(db, { event_type_code: "WidgetReplay", payload: { n: 2 } }, actor, { useOutbox: false });

    const preview = events.Replay.previewReplay(db, { event_type_code: "WidgetReplay" });
    assert.ok(preview.matched_events >= 2);
    assert.equal(preview.target_subscriptions.length, 1);

    const dryRun = events.Replay.createReplay(db, { scope_type: "type", event_type_code: "WidgetReplay", dry_run: true }, actor);
    assert.equal(dryRun.dry_run, true);
    assert.equal((await events.Replay.runReplay(db, dryRun.id, actor)).status, "completed");

    const live = events.Replay.createReplay(db, { scope_type: "type", event_type_code: "WidgetReplay", rate_limit_per_second: 1000 }, actor);
    const finished = await events.Replay.runReplay(db, live.id, actor);
    assert.equal(finished.status, "completed");
    assert.ok(finished.replayed_events >= 2);
    assert.ok(events.Replay.replayStats(db).replayed >= 2);

    assert.throws(() => events.Replay.assertReplayAllowed(db, "SecurityAccessDenied"), /denied/);
  });

  test("retention protects events with active deliveries and deletes terminal ones", async () => {
    events.Registry.createEventType(db, { code: "WidgetRetention", source_module: "test" }, actor);
    events.Subscriptions.createSubscription(db, { code: "widget-retention-sub", event_type_code: "WidgetRetention", subscriber: "test", handler: "test.record" }, actor);
    events.Subscriptions.setSubscriptionStatus(db, "widget-retention-sub", "active", actor);
    const published = events.publishEvent(db, { event_type_code: "WidgetRetention", payload: {} }, actor, { useOutbox: false });

    run(db, "UPDATE event_records SET created_at = ? WHERE id = ?", ["2020-01-01 00:00:00", published.id]);
    const policy = events.Retention.createRetentionPolicy(
      db,
      { code: "retention-widget-retention-test", event_type_code: "WidgetRetention", retention_days: 1, action: "delete" },
      actor
    );
    const protectedPreview = events.Retention.applyRetentionPolicy(db, policy.code, { dryRun: true });
    assert.equal(protectedPreview.candidates, 0, "a pending delivery protects the event");

    await events.Consumer.processDeliveries(db);
    const applied = events.Retention.applyRetentionPolicy(db, policy.code);
    assert.equal(applied.deleted, 1);
    assert.throws(() => events.Publisher.getEvent(db, published.event_ref), /not found/i);
  });

  test("monitoring exposes dashboard, health and traceability", () => {
    const correlation = `corr-widget-${Date.now()}`;
    const explicit = events.Publisher.publishWithCorrelation(
      db,
      { event_type_code: "WidgetReplay", payload: {}, correlation_id: correlation },
      actor
    );
    const chain = events.Monitoring.traceability(db, { correlationId: correlation });
    assert.ok(chain.events.some((e) => e.event_ref === explicit.event_ref));

    const dashboard = events.Monitoring.dashboardSummary(db);
    assert.ok(dashboard.events.published >= 1);
    assert.ok(Array.isArray(dashboard.throughput));
    assert.ok(dashboard.generated_at);

    const health = events.Monitoring.healthCheck(db);
    assert.ok(["up", "degraded", "down"].includes(health.status));
    assert.equal(health.provider, "database");
    assert.ok(health.checks.length >= 4);
    assert.ok(events.Monitoring.latencyStats(db).overall.samples >= 0);
  });

  test("validation helpers mask secrets and compute retry backoff", () => {
    const masked = events.Validation.maskPayload({ api_key: "abc", nested: { password: "x", keep: "y" } });
    assert.equal(masked.api_key, "***");
    assert.equal(masked.nested.password, "***");
    assert.equal(masked.nested.keep, "y");

    const policy = events.Validation.normalizeRetryPolicy({ strategy: "exponential", delay_seconds: 2, multiplier: 3, max_attempts: 5 });
    assert.equal(events.Validation.computeBackoffSeconds(policy, 3, { random: () => 0.5 }), 18);
    assert.equal(events.Validation.shouldRetry({ max_attempts: 5 }, 1, "business_validation"), false);
    assert.equal(events.Validation.shouldRetry({ max_attempts: 5 }, 1, "technical"), true);

    const comparison = events.Validation.compareSchemas(
      { properties: { a: { type: "string" } } },
      { properties: { a: { type: "number" } } }
    );
    assert.equal(comparison.compatible, false);
  });

  test("registers pluggable bus providers", () => {
    const code = events.Bus.registerBusProvider("testbus", () => ({ code: "testbus", durable: false, async publish() { return { published: true }; } }));
    assert.equal(code, "testbus");
    assert.ok(events.Bus.listBusProviders().includes("testbus"));
    assert.equal(events.Bus.resolveBus(db, { provider: "testbus" }).code, "testbus");
    events.Bus.unregisterBusProvider("testbus");
    assert.ok(!events.Bus.listBusProviders().includes("testbus"));
  });
});
