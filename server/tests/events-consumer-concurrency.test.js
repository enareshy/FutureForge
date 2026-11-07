process.env.FILE_STORAGE_PROVIDER = "memory";
// Real multi-connection concurrency coverage for the event consumer's lease.
//
// These tests use the async data layer, whose pg pool hands each concurrent
// operation an independent PostgreSQL connection, and coordinate with an
// in-process barrier rather than sleeps. A raw `pg` observer client (a truly
// separate connection/transaction stream) re-reads persisted state so the
// assertions prove what reached the database, not what an in-memory object says.
//
// The scenarios mirror the recovery path of a crashed/lagging worker:
//   1. two sweeps claim concurrently without double-claiming a delivery;
//   2. worker A claims, its lease expires, worker B reclaims it;
//   3. worker A then tries to complete/retry the delivery it no longer owns;
//   4. the completed delivery is not reverted and gets no duplicate side effect;
//   5. worker A cannot overwrite worker B's fresh claim via stale reclamation.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { queryAllAsync, queryOneAsync } from "../db-async.js";
import { seedDatabase } from "../seed.js";
import * as events from "../services/events.js";

const ACTOR = { id: 1, username: "admin" };

function nowSql(offsetSeconds = 0) {
  const d = new Date(Date.now() + offsetSeconds * 1000);
  return d.toISOString().replace("T", " ").slice(0, 19);
}

function openObserver(handle) {
  const cfg = handle.__config;
  return new pg.Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl,
    options: '-c search_path=public',
  });
}

describe("event consumer lease safety under real PostgreSQL concurrency", () => {
  let db;
  let observer;
  let actor;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    await events.Registry.ensureDefaultEventTypesAsync(db);
    await events.Bus.ensureDefaultTopologyAsync(db);
    await events.Subscriptions.ensureDefaultSubscriptionsAsync(db);
    observer = openObserver(db);
    await observer.connect();
  });

  after(async () => {
    if (observer) await observer.end().catch(() => {});
    await db?.close();
  });

  async function makeDeliveries(handler, count, prefix) {
    const ids = [];
    for (let i = 0; i < count; i += 1) {
      const row = await events.Router.enqueueMessageAsync(db, "event-consumers", {
        handler,
        payload: { i },
        idempotency_key: `${prefix}-${i}`,
      });
      ids.push(row.id);
    }
    return ids;
  }

  test("two concurrent sweeps partition eligible deliveries (no double claim)", async () => {
    await events.Handlers.registerHandler("test.concurrent.claim", async () => ({ ok: true }), { module: "test" });
    const created = await makeDeliveries("test.concurrent.claim", 4, "concurrent-claim");

    const [a, b] = await Promise.all([
      events.Consumer.claimDeliveriesAsync(db, { worker: "sweep-a", limit: 50 }),
      events.Consumer.claimDeliveriesAsync(db, { worker: "sweep-b", limit: 50 }),
    ]);

    const claimedIds = [...a, ...b].filter((d) => created.includes(d.id)).map((d) => d.id);
    assert.equal(new Set(claimedIds).size, claimedIds.length, "no delivery was claimed by both sweeps");
    assert.equal(claimedIds.length, 4, "every eligible delivery was claimed exactly once");

    // Persisted state agrees: each created row is processing with a unique,
    // non-empty lease token, confirmed over an independent connection.
    const rows = await observer.query(
      "SELECT id, status, lease_token, locked_by FROM event_deliveries WHERE id = ANY($1::bigint[])",
      [created]
    );
    for (const row of rows.rows) {
      assert.equal(row.status, "processing");
      assert.ok(row.lease_token && row.lease_token.length > 0, "claim stamped a lease token");
    }
    // A claim stamps one lease token for its whole batch. Under contention one
    // sweep may win all rows and the other none, so assert the union covers each
    // delivery once and each row carries the token of whichever sweep claimed it.
    const tokenByWorker = new Map();
    for (const d of [...a, ...b]) tokenByWorker.set(d.id, d.lease_token);
    for (const row of rows.rows) {
      assert.equal(row.lease_token, tokenByWorker.get(Number(row.id)), "row carries its claiming sweep's token");
      assert.ok(row.lease_token && row.lease_token.length > 0, "claim stamped a lease token");
    }
    for (const sweep of [a, b]) {
      const tokens = new Set(sweep.map((d) => d.lease_token));
      assert.ok(tokens.size <= 1, "a single sweep uses one lease token for its batch");
    }
  });

  test("a reclaimed delivery is not completed by the worker that lost its lease", async () => {
    // Barrier: worker A pauses inside its handler while we expire + reclaim.
    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    let enteredA;
    const entered = new Promise((resolve) => { enteredA = resolve; });
    await events.Handlers.registerHandler(
      "test.concurrent.fenced",
      async ({ worker }) => {
        if (worker === "worker-a") {
          enteredA();
          await gateA;
        }
        return { ok: true };
      },
      { module: "test" }
    );

    await events.Registry.createEventTypeAsync(db, { code: "AsyncConcurrencyFenced" }, actor);
    await events.Subscriptions.createSubscriptionAsync(
      db,
      { code: "async-concurrency-fenced-sub", event_type_code: "AsyncConcurrencyFenced", subscriber: "test", handler: "test.concurrent.fenced" },
      actor
    );
    await events.Subscriptions.setSubscriptionStatusAsync(db, "async-concurrency-fenced-sub", "active", actor);

    // A real published event gives the delivery an event_id, so the framework's
    // authoritative side effect (event_records.delivered_count) is exercised.
    const published = await events.Publisher.publishEventAsync(
      db,
      { event_type_code: "AsyncConcurrencyFenced", payload: { n: 1 } },
      actor,
      { useOutbox: false }
    );
    const deliveryRow = await queryOneAsync(
      db,
      "SELECT * FROM event_deliveries WHERE event_id = ? ORDER BY id DESC LIMIT 1",
      [published.id]
    );
    assert.ok(deliveryRow, "the event produced a delivery");

    // Worker A claims and starts handling; it is now suspended mid-flight.
    const [deliveryA] = await events.Consumer.claimDeliveriesAsync(db, { worker: "worker-a", limit: 50 });
    assert.equal(deliveryA.id, deliveryRow.id);
    const aPromise = events.Consumer.processDeliveryAsync(db, deliveryA, { worker: "worker-a" });
    await entered; // deterministic: A is inside the handler, holding its claim

    // Its lease expires and worker B reclaims it over independent connections.
    await db.prepare("UPDATE event_deliveries SET visibility_expires_at = ? WHERE id = ?").run(nowSql(-1), deliveryRow.id);
    const reclaimed = await events.Consumer.releaseStaleDeliveriesAsync(db);
    assert.equal(reclaimed.reclaimed, 1, "the expired lease was reclaimed");

    const claimedByB = await events.Consumer.claimDeliveriesAsync(db, { worker: "worker-b", limit: 50 });
    const deliveryB = claimedByB.find((d) => d.id === deliveryRow.id);
    assert.ok(deliveryB, "worker B claimed the reclaimed delivery");
    assert.notEqual(deliveryB.lease_token, deliveryA.lease_token, "reclaim issued a new lease token");

    // Worker B completes it (not blocked).
    const bResult = await events.Consumer.processDeliveryAsync(db, deliveryB, { worker: "worker-b" });
    assert.equal(bResult.status, "delivered");

    // Now let worker A finish and attempt its own completion.
    releaseA();
    const aResult = await aPromise;
    assert.equal(aResult.status, "stale_lease", "worker A's late completion is fenced out");

    // Persisted state (read on a separate connection): B owns the result only.
    const finalRow = (await observer.query("SELECT * FROM event_deliveries WHERE id = $1", [deliveryRow.id])).rows[0];
    assert.equal(finalRow.status, "delivered");
    assert.equal(finalRow.locked_by, "");
    assert.equal(finalRow.lease_token, "");
    assert.equal(Number(finalRow.attempts), 1, "only worker B's attempt counted");

    const eventRow = (await observer.query("SELECT delivered_count FROM event_records WHERE id = $1", [published.id])).rows[0];
    assert.equal(Number(eventRow.delivered_count), 1, "the event was counted delivered exactly once");

    const idem = await observer.query("SELECT COUNT(*)::int AS c FROM event_idempotency WHERE delivery_id = $1", [deliveryRow.id]);
    assert.equal(idem.rows[0].c, 1, "exactly one idempotency record was written");

    const attempts = await observer.query(
      "SELECT status FROM event_delivery_attempts WHERE delivery_id = $1 ORDER BY id",
      [deliveryRow.id]
    );
    assert.equal(attempts.rows.filter((r) => r.status === "delivered").length, 1, "one delivered attempt recorded");
  });

  test("a stale worker cannot revert a completed delivery via retry or reclamation", async () => {
    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    let enteredA;
    const entered = new Promise((resolve) => { enteredA = resolve; });
    await events.Handlers.registerHandler(
      "test.concurrent.fail-after-gate",
      async ({ worker }) => {
        if (worker === "worker-a") {
          enteredA();
          await gateA;
          const error = new Error("late failure from a stale worker");
          error.category = "technical";
          throw error;
        }
        return { ok: true };
      },
      { module: "test" }
    );

    const row = await events.Router.enqueueMessageAsync(db, "event-consumers", {
      handler: "test.concurrent.fail-after-gate",
      payload: {},
      idempotency_key: "stale-retry-key",
      retry_policy: { max_attempts: 5 },
    });

    const [deliveryA] = await events.Consumer.claimDeliveriesAsync(db, { worker: "worker-a", limit: 50 });
    const aPromise = events.Consumer.processDeliveryAsync(db, deliveryA, { worker: "worker-a" });
    await entered;

    // Expire A's lease; B reclaims and completes successfully.
    await db.prepare("UPDATE event_deliveries SET visibility_expires_at = ? WHERE id = ?").run(nowSql(-1), row.id);
    await events.Consumer.releaseStaleDeliveriesAsync(db);
    const [deliveryB] = await events.Consumer.claimDeliveriesAsync(db, { worker: "worker-b", limit: 50 });
    const bResult = await events.Consumer.processDeliveryAsync(db, deliveryB, { worker: "worker-b" });
    assert.equal(bResult.status, "delivered");

    // A finishes with a failure and tries to move the row to `retry`.
    releaseA();
    const aResult = await aPromise;
    assert.equal(aResult.status, "stale_lease", "the stale worker's retry transition is fenced out");

    const finalRow = (await observer.query("SELECT status, attempts FROM event_deliveries WHERE id = $1", [row.id])).rows[0];
    assert.equal(finalRow.status, "delivered", "the completed delivery was not reverted to retry");
    assert.equal(Number(finalRow.attempts), 1, "the stale failure did not bump attempts");
  });

  test("stale reclamation cannot disturb a freshly re-claimed delivery", async () => {
    const row = await events.Router.enqueueMessageAsync(db, "event-consumers", {
      handler: "test.concurrent.claim",
      payload: {},
      idempotency_key: "fresh-reclaim-key",
    });

    // A claims then its lease expires; B reclaims and holds a fresh lease.
    await events.Consumer.claimDeliveriesAsync(db, { worker: "worker-a", limit: 50 });
    await db.prepare("UPDATE event_deliveries SET visibility_expires_at = ? WHERE id = ?").run(nowSql(-1), row.id);
    await events.Consumer.releaseStaleDeliveriesAsync(db);
    const [deliveryB] = await events.Consumer.claimDeliveriesAsync(db, { worker: "worker-b", limit: 50 });
    assert.ok(deliveryB, "worker B holds the fresh claim");
    const freshToken = deliveryB.lease_token;

    // A late reclamation sweep (e.g. maintenance on the crashed worker) must not
    // reclaim a delivery whose current lease has not expired.
    const lateReclaim = await events.Consumer.releaseStaleDeliveriesAsync(db);
    assert.equal(lateReclaim.reclaimed, 0, "a live lease was not reclaimed");

    const finalRow = (await observer.query("SELECT status, locked_by, lease_token FROM event_deliveries WHERE id = $1", [row.id])).rows[0];
    assert.equal(finalRow.status, "processing");
    assert.equal(finalRow.locked_by, "worker-b");
    assert.equal(finalRow.lease_token, freshToken, "worker B's claim was not overwritten");
  });

  test("a delivery completed without a lease token never matches a stale empty-token worker", async () => {
    // Regression guard: the legacy empty token must not let a delivery row that
    // was never claimed (no token) be silently re-terminalized by a worker that
    // also carries no token. Deliveries are always claimed with a unique token,
    // so this asserts the invariant that a terminal row's token is cleared.
    const row = await events.Router.enqueueMessageAsync(db, "event-consumers", {
      handler: "test.concurrent.claim",
      payload: {},
      idempotency_key: "terminal-token-key",
    });
    const [claim] = await events.Consumer.claimDeliveriesAsync(db, { worker: "worker-c", limit: 50 });
    assert.ok(claim.lease_token, "a claim always carries a token");
    await events.Consumer.processDeliveryAsync(db, claim, { worker: "worker-c" });

    const finalRow = (await observer.query("SELECT status, lease_token FROM event_deliveries WHERE id = $1", [row.id])).rows[0];
    assert.equal(finalRow.status, "delivered");
    assert.equal(finalRow.lease_token, "", "a terminal delivery holds no lease token");
  });
});
