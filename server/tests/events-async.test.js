process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, run, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as events from "../services/events.js";

// Async-twin coverage for the Event & Messaging Framework: every DB-touching
// service exposes an `*Async` twin that mirrors the sync layer statement for
// statement. This suite exercises the async path end to end (registry,
// publisher, outbox, router, subscriptions, consumer, dead-letter, replay,
// retention, bus topology and monitoring).

describe("event & messaging framework async twins mirror the sync layer", () => {
  let db;
  let actor;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    await events.Registry.ensureDefaultEventTypesAsync(db);
    await events.Bus.ensureDefaultTopologyAsync(db);
    await events.Retention.ensureDefaultRetentionPoliciesAsync(db);
    await events.Subscriptions.ensureDefaultSubscriptionsAsync(db);
  });

  after(() => db?.close());

  test("installs the default catalogue and topology asynchronously", async () => {
    const types = await events.Registry.listEventTypesAsync(db, { pageSize: 500 });
    assert.ok(types.total >= 30);
    assert.ok(types.items.some((t) => t.code === "ProductCreated" && t.category === "product"));

    const topics = await events.Bus.listTopicsAsync(db, { pageSize: 100 });
    assert.ok(topics.items.some((t) => t.code === "domain-events"));
    const policies = await events.Retention.listRetentionPoliciesAsync(db, { pageSize: 200 });
    assert.ok(policies.total >= 30);
  });

  test("registers event types and versions schemas asynchronously", async () => {
    const created = await events.Registry.createEventTypeAsync(
      db,
      {
        code: "AsyncWidgetCreated",
        category: "product",
        source_module: "test",
        schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
        example: { name: "bolt" },
      },
      actor
    );
    assert.equal(created.code, "AsyncWidgetCreated");
    assert.equal(created.version, 1);

    const fetched = await events.Registry.getEventTypeAsync(db, "AsyncWidgetCreated");
    assert.equal(fetched.schema.required[0], "name");

    const added = await events.Registry.addVersionAsync(
      db,
      "AsyncWidgetCreated",
      { schema: { type: "object", required: ["name", "qty"], properties: { name: { type: "string" }, qty: { type: "number" } } } },
      actor
    );
    assert.equal(added.version.version, 2);
    assert.equal(added.comparison.compatible, false);

    const compatible = await events.Registry.checkCompatibilityAsync(db, "AsyncWidgetCreated", {
      schema: { type: "object", required: ["name", "qty"], properties: { name: { type: "string" }, qty: { type: "number" }, color: { type: "string" } } },
    });
    assert.equal(compatible.compatible, true);

    const versions = await events.Registry.listVersionsAsync(db, "AsyncWidgetCreated");
    assert.ok(versions.length >= 2);

    const updated = await events.Registry.updateEventTypeAsync(db, "AsyncWidgetCreated", { description: "async demo" }, actor);
    assert.equal(updated.description, "async demo");
  });

  test("publishes and routes through subscription filters asynchronously", async () => {
    await events.Registry.createEventTypeAsync(db, { code: "AsyncWidgetReleased", source_module: "test" }, actor);
    const sub = await events.Subscriptions.createSubscriptionAsync(
      db,
      {
        code: "async-widget-released-audit",
        event_type_code: "AsyncWidgetReleased",
        subscriber: "audit",
        handler: "test.record",
        filter: { "payload.kind": "release" },
      },
      actor
    );
    const validation = await events.Subscriptions.validateSubscriptionAsync(db, sub.code);
    assert.equal(validation.valid, true);
    await events.Subscriptions.setSubscriptionStatusAsync(db, sub.code, "active", actor);

    const matched = await events.Publisher.publishEventAsync(
      db,
      { event_type_code: "AsyncWidgetReleased", payload: { kind: "release" } },
      actor,
      { useOutbox: false }
    );
    assert.equal(matched.deliveries.length, 1);
    assert.equal(matched.deliveries[0].subscriber, "audit");

    const unmatched = await events.Publisher.publishEventAsync(
      db,
      { event_type_code: "AsyncWidgetReleased", payload: { kind: "draft" } },
      actor,
      { useOutbox: false }
    );
    assert.equal(unmatched.deliveries.length, 0);

    const eventRow = await queryOne(db, "SELECT * FROM event_records WHERE id = ?", [matched.id]);
    const subs = await events.Router.matchSubscriptionsAsync(db, eventRow);
    assert.equal(subs.length, 1);
    const preview = await events.Router.previewRouteAsync(db, eventRow);
    assert.equal(preview[0].handler, "test.record");
  });

  test("publishBatch isolates per-event failures asynchronously", async () => {
    await events.Registry.createEventTypeAsync(
      db,
      { code: "AsyncWidgetBatch", schema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
      actor
    );
    const result = await events.Publisher.publishBatchAsync(
      db,
      [
        { event_type_code: "AsyncWidgetBatch", payload: { name: "ok" } },
        { event_type_code: "AsyncWidgetBatch", payload: {} },
      ],
      actor,
      { useOutbox: false }
    );
    assert.equal(result.total, 2);
    assert.equal(result.published, 1);
    assert.equal(result.failed, 1);
  });

  test("queues through the outbox then drains it asynchronously", async () => {
    await events.Registry.createEventTypeAsync(db, { code: "AsyncWidgetOutbox" }, actor);
    const queued = await events.Publisher.publishAsync(db, { event_type_code: "AsyncWidgetOutbox", payload: {} }, actor);
    assert.equal(queued.queued, true);

    assert.ok((await events.Outbox.outboxStatsAsync(db)).pending >= 1);
    assert.ok((await events.Outbox.listOutboxAsync(db, { status: "pending" })).total >= 1);

    const summary = await events.Outbox.processOutboxAsync(db);
    assert.ok(summary.published >= 1);
    const stored = await events.Publisher.getEventAsync(db, queued.event_ref);
    assert.equal(stored.status, "published");
  });

  test("consumes deliveries, invokes handlers and dedupes idempotency keys asynchronously", async () => {
    let calls = 0;
    events.Handlers.registerHandler("test.async-record", async () => { calls += 1; return { ok: true }; }, { module: "test" });

    await events.Registry.createEventTypeAsync(db, { code: "AsyncWidgetConsume" }, actor);
    await events.Subscriptions.createSubscriptionAsync(
      db,
      { code: "async-widget-consume-sub", event_type_code: "AsyncWidgetConsume", subscriber: "test", handler: "test.async-record" },
      actor
    );
    await events.Subscriptions.setSubscriptionStatusAsync(db, "async-widget-consume-sub", "active", actor);
    await events.Publisher.publishEventAsync(db, { event_type_code: "AsyncWidgetConsume", payload: {} }, actor, { useOutbox: false });

    const summary = await events.Consumer.processDeliveriesAsync(db, { queueCode: null });
    assert.ok(summary.delivered >= 1);
    assert.ok(calls >= 1);
    assert.ok((await events.Consumer.consumerStatsAsync(db)).delivered >= 1);

    const d1 = await events.Router.enqueueMessageAsync(db, "event-consumers", { handler: "test.async-record", payload: { a: 1 }, idempotency_key: "async-dup-key-1" });
    const d2 = await events.Router.enqueueMessageAsync(db, "event-consumers", { handler: "test.async-record", payload: { a: 1 }, idempotency_key: "async-dup-key-1" });
    await events.Consumer.processDeliveryAsync(db, await queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [d1.id]));
    const duplicate = await events.Consumer.processDeliveryAsync(db, await queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [d2.id]));
    assert.equal(duplicate.status, "duplicate");
  });

  test("retries then dead-letters failures and requeues them asynchronously", async () => {
    events.Handlers.registerHandler(
      "test.async-boom",
      async () => {
        const error = new Error("async handler exploded");
        error.category = "technical";
        throw error;
      },
      { module: "test" }
    );
    await events.Registry.createEventTypeAsync(db, { code: "AsyncWidgetFailure" }, actor);
    await events.Subscriptions.createSubscriptionAsync(
      db,
      { code: "async-widget-failure-sub", event_type_code: "AsyncWidgetFailure", subscriber: "test", handler: "test.async-boom", retry_policy: { max_attempts: 1 } },
      actor
    );
    await events.Subscriptions.setSubscriptionStatusAsync(db, "async-widget-failure-sub", "active", actor);
    await events.Publisher.publishEventAsync(db, { event_type_code: "AsyncWidgetFailure", payload: {} }, actor, { useOutbox: false });

    const summary = await events.Consumer.processDeliveriesAsync(db);
    assert.ok(summary.dead_lettered >= 1);

    const stats = await events.DeadLetter.deadLetterStatsAsync(db);
    assert.ok(stats.open >= 1);
    assert.ok(stats.by_handler.some((row) => row.handler === "test.async-boom"));

    const open = await events.DeadLetter.listDeadLettersAsync(db, { status: "open" });
    assert.ok(open.total >= 1);
    const resolved = await events.DeadLetter.resolveDeadLetterAsync(db, open.items[0].id, { action: "retry", actor });
    assert.equal(resolved.status, "retrying");

    const bulk = await events.DeadLetter.retryDeadLettersAsync(db, { eventTypeCode: "AsyncWidgetFailure", status: "retrying", actor });
    assert.ok(bulk.requested >= 1);
  });

  test("buffers out-of-order deliveries asynchronously", async () => {
    await events.Registry.createEventTypeAsync(
      db,
      { code: "AsyncWidgetOrdered", source_module: "test", ordering_required: true, ordering_scope: "object" },
      actor
    );
    await events.Subscriptions.createSubscriptionAsync(
      db,
      { code: "async-widget-ordered-sub", event_type_code: "AsyncWidgetOrdered", subscriber: "test", handler: "test.async-record", ordering_required: true, ordering_scope: "object" },
      actor
    );
    await events.Subscriptions.setSubscriptionStatusAsync(db, "async-widget-ordered-sub", "active", actor);

    const first = await events.Publisher.publishEventAsync(db, { event_type_code: "AsyncWidgetOrdered", source_object_id: "ASYNC-AGG-9", payload: {} }, actor, { useOutbox: false });
    const second = await events.Publisher.publishEventAsync(db, { event_type_code: "AsyncWidgetOrdered", source_object_id: "ASYNC-AGG-9", payload: {} }, actor, { useOutbox: false });
    assert.equal(first.sequence_number, 1);
    assert.equal(second.sequence_number, 2);

    const secondDelivery = (await events.Publisher.listDeliveriesAsync(db, { eventId: second.id })).items[0];
    const result = await events.Consumer.processDeliveryAsync(db, await queryOne(db, "SELECT * FROM event_deliveries WHERE id = ?", [secondDelivery.id]));
    assert.equal(result.status, "out_of_order");
    assert.ok((await events.Ordering.orderingStateAsync(db)).buffered >= 1);
  });

  test("manages topics, queues, consumer groups and queue messages asynchronously", async () => {
    const topic = await events.Bus.createTopicAsync(db, { code: "async-test-topic", name: "Async topic" }, actor);
    assert.equal(topic.code, "async-test-topic");
    await events.Bus.createQueueAsync(db, { code: "async-test-queue", name: "Async queue", consumer_group: "async-test-group" }, actor);
    await events.Bus.createConsumerGroupAsync(db, { code: "async-test-group", name: "Async group", topic_code: "async-test-topic", queue_code: "async-test-queue" }, actor);

    assert.ok((await events.Bus.listTopicsAsync(db, {})).items.some((t) => t.code === "async-test-topic"));
    assert.ok((await events.Bus.listQueuesAsync(db, {})).items.some((q) => q.code === "async-test-queue"));
    assert.ok((await events.Bus.listConsumerGroupsAsync(db, {})).items.some((g) => g.code === "async-test-group"));

    const message = await events.Router.enqueueMessageAsync(db, "async-test-queue", { handler: "test.async-record", payload: { x: 1 } }, {});
    assert.equal(message.queue_code, "async-test-queue");
    assert.ok((await events.Bus.queueStatsAsync(db, "async-test-queue")).pending >= 1);
    assert.ok((await events.Bus.queueDepthAsync(db)).total >= 1);
    assert.ok((await events.Bus.topologyHealthAsync(db)).queues >= 2);

    const processed = await events.Consumer.processDeliveriesAsync(db, { queueCode: "async-test-queue" });
    assert.equal(processed.delivered, 1);
    assert.equal((await events.Bus.queueStatsAsync(db, "async-test-queue")).depth, 0);
  });

  test("replays a controlled set of events and honours replay policy asynchronously", async () => {
    await events.Registry.createEventTypeAsync(db, { code: "AsyncWidgetReplay", source_module: "test" }, actor);
    await events.Subscriptions.createSubscriptionAsync(
      db,
      { code: "async-widget-replay-sub", event_type_code: "AsyncWidgetReplay", subscriber: "test", handler: "test.async-record" },
      actor
    );
    await events.Subscriptions.setSubscriptionStatusAsync(db, "async-widget-replay-sub", "active", actor);
    await events.Publisher.publishEventAsync(db, { event_type_code: "AsyncWidgetReplay", payload: { n: 1 } }, actor, { useOutbox: false });
    await events.Publisher.publishEventAsync(db, { event_type_code: "AsyncWidgetReplay", payload: { n: 2 } }, actor, { useOutbox: false });

    const preview = await events.Replay.previewReplayAsync(db, { event_type_code: "AsyncWidgetReplay" });
    assert.ok(preview.matched_events >= 2);

    const dryRun = await events.Replay.createReplayAsync(db, { scope_type: "type", event_type_code: "AsyncWidgetReplay", dry_run: true }, actor);
    assert.equal(dryRun.dry_run, true);
    assert.equal((await events.Replay.runReplayAsync(db, dryRun.id, actor)).status, "completed");

    const live = await events.Replay.createReplayAsync(db, { scope_type: "type", event_type_code: "AsyncWidgetReplay", rate_limit_per_second: 1000 }, actor);
    const finished = await events.Replay.runReplayAsync(db, live.id, actor);
    assert.equal(finished.status, "completed");
    assert.ok(finished.replayed_events >= 2);
    assert.ok((await events.Replay.replayStatsAsync(db)).replayed >= 2);

    assert.throws(() => events.Replay.assertReplayAllowed(db, "SecurityAccessDenied"), /denied/);
  });

  test("retention protects and then deletes terminal events asynchronously", async () => {
    await events.Registry.createEventTypeAsync(db, { code: "AsyncWidgetRetention", source_module: "test" }, actor);
    await events.Subscriptions.createSubscriptionAsync(
      db,
      { code: "async-widget-retention-sub", event_type_code: "AsyncWidgetRetention", subscriber: "test", handler: "test.async-record" },
      actor
    );
    await events.Subscriptions.setSubscriptionStatusAsync(db, "async-widget-retention-sub", "active", actor);
    const published = await events.Publisher.publishEventAsync(db, { event_type_code: "AsyncWidgetRetention", payload: {} }, actor, { useOutbox: false });

    run(db, "UPDATE event_records SET created_at = ? WHERE id = ?", ["2020-01-01 00:00:00", published.id]);
    const policy = await events.Retention.createRetentionPolicyAsync(
      db,
      { code: "retention-async-widget-test", event_type_code: "AsyncWidgetRetention", retention_days: 1, action: "delete" },
      actor
    );
    const protectedPreview = await events.Retention.applyRetentionPolicyAsync(db, policy.code, { dryRun: true });
    assert.equal(protectedPreview.candidates, 0);

    await events.Consumer.processDeliveriesAsync(db);
    const applied = await events.Retention.applyRetentionPolicyAsync(db, policy.code);
    assert.equal(applied.deleted, 1);
    await assert.rejects(() => events.Publisher.getEventAsync(db, published.event_ref), /not found/i);
  });

  test("monitoring exposes dashboard, health and traceability asynchronously", async () => {
    const correlation = `corr-async-widget-${Date.now()}`;
    const explicit = await events.Publisher.publishEventAsync(
      db,
      { event_type_code: "AsyncWidgetReplay", payload: {}, correlation_id: correlation },
      actor,
      { useOutbox: false }
    );
    const chain = await events.Monitoring.traceabilityAsync(db, { correlationId: correlation });
    assert.ok(chain.events.some((e) => e.event_ref === explicit.event_ref));

    const dashboard = await events.Monitoring.dashboardSummaryAsync(db);
    assert.ok(dashboard.events.published >= 1);
    assert.ok(Array.isArray(dashboard.throughput));

    const health = await events.Monitoring.healthCheckAsync(db);
    assert.ok(["up", "degraded", "down"].includes(health.status));
    assert.equal(health.provider, "database");

    const latency = await events.Monitoring.latencyStatsAsync(db);
    assert.ok(latency.overall.samples >= 0);
    const throughput = await events.Monitoring.throughputTimeseriesAsync(db, { windowHours: 24, bucketMinutes: 60 });
    assert.ok(Array.isArray(throughput.points));
  });

  test("routes a stored event and reports routing stats asynchronously", async () => {
    await events.Registry.createEventTypeAsync(db, { code: "AsyncWidgetRoute" }, actor);
    await events.Subscriptions.createSubscriptionAsync(
      db,
      { code: "async-widget-route-sub", event_type_code: "AsyncWidgetRoute", subscriber: "test", handler: "test.async-record" },
      actor
    );
    await events.Subscriptions.setSubscriptionStatusAsync(db, "async-widget-route-sub", "active", actor);
    const published = await events.Publisher.publishEventAsync(db, { event_type_code: "AsyncWidgetRoute", payload: {} }, actor, { useOutbox: false });

    const eventRow = await queryOne(db, "SELECT * FROM event_records WHERE id = ?", [published.id]);
    const routed = await events.Router.routeEventAsync(db, eventRow);
    assert.equal(routed.matched, 1);
    assert.equal(routed.deliveries.length, 0, "already delivered by the publish path, re-route is conflict-ignored");

    const rerouted = await events.Publisher.routeStoredEventAsync(db, published.event_ref, { trigger: "test" });
    assert.equal(rerouted.event_ref, published.event_ref);
    assert.equal(rerouted.matched, 1);

    const stats = await events.Router.routingStatsAsync(db);
    assert.ok(stats.subscriptions >= 1);
    assert.ok(Array.isArray(stats.top_event_types));
  });
});
