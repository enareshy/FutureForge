process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as dl from "../services/data-lifecycle/index.js";

function helixTenant(db) {
  return queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'")?.id ?? null;
}

function adminActor(db) {
  const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  return row ? { id: row.id, username: row.username } : null;
}

describe("Data lifecycle & archival foundation and seed", () => {
  let db;
  let tenant;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    tenant = helixTenant(db);
  });
  after(() => db?.close());

  test("installs the platform seams idempotently", () => {
    const eventTypes = queryOne(db, "SELECT COUNT(*) AS c FROM event_registry WHERE source_module = 'data-lifecycle'");
    assert.ok(Number(eventTypes.c) >= 10);
    const searchTypes = queryOne(db, "SELECT COUNT(*) AS c FROM search_object_types WHERE source_module = 'data-lifecycle'");
    assert.ok(Number(searchTypes.c) >= 1);
    const again = dl.ensureDataLifecycleFoundation(db);
    assert.equal(again.event_types, 0);
    assert.equal(again.states, 0);
    assert.equal(again.transitions, 0);
    assert.equal(again.tiers, 0);
    assert.equal(again.configuration, 0);
  });

  test("seeds a demonstration estate once", () => {
    const result = dl.ensureDataLifecycleSeed(db, tenant);
    assert.equal(result.seeded, false);
    assert.equal(result.reason, "already_present");
    const health = dl.Foundation.lifecycleHealth(db, tenant);
    assert.ok(health.counts.objects >= 5);
    assert.ok(health.counts.policies >= 3);
    assert.ok(health.counts.legal_holds >= 1);
  });

  test("resolves the most specific active policy deterministically", () => {
    const resolution = dl.Policies.resolvePolicy(db, { tenantId: tenant, objectType: "customer", lifecycleState: "INACTIVE" });
    assert.ok(resolution.policy);
    assert.equal(resolution.policy.code, "CUSTOMER_RETENTION");
    assert.ok(resolution.match_score > 0);
  });

  test("resolves state tiers from the tenant mapping", () => {
    assert.equal(dl.Tiers.resolveTier(db, tenant, "ACTIVE"), "HOT");
    assert.equal(dl.Tiers.resolveTier(db, tenant, "COLD_STORAGE"), "COLD");
  });

  test("guards the transition graph", () => {
    assert.ok(dl.States.assertTransition(db, tenant, "ACTIVE", "INACTIVE"));
    assert.throws(() => dl.States.assertTransition(db, tenant, "ACTIVE", "ARCHIVED"), /not permitted/i);
  });

  test("reports tenant-scoped metrics without leaking across tenants", () => {
    const metrics = dl.Metrics.metricsSnapshot(db, { tenantId: tenant });
    assert.ok(metrics.counters.objects_tracked >= 5);
    const other = dl.Metrics.metricsSnapshot(db, { tenantId: 999999 });
    assert.equal(other.counters.objects_tracked, 0);
  });

  test("validates configuration values", () => {
    assert.throws(() => dl.Configuration.setConfig(db, tenant, "quality_min_score", 200), /between 0 and 100/i);
    const value = dl.Configuration.setConfig(db, tenant, "quality_min_score", 75);
    assert.equal(Number(value), 75);
  });
});

describe("Data lifecycle engine", () => {
  let db;
  let tenant;
  let actor;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    tenant = helixTenant(db);
    actor = adminActor(db);
    dl.Policies.createPolicy(
      db,
      tenant,
      {
        code: "WIDGET_RETENTION",
        name: "Widget retention",
        scope_type: "OBJECT_TYPE",
        object_type: "widget",
        retention_period_days: 30,
        retention_basis: "LAST_MODIFIED_DATE",
        archive_after_days: 10,
        cold_storage_after_days: 20,
        purge_after_days: 30,
        data_tier: "HOT",
        status: "active",
      },
      actor
    );
  });
  after(() => db?.close());

  function registerWidget(id, state = "ACTIVE") {
    const anchor = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    return dl.Objects.registerObjectLifecycle(db, tenant, { object_type: "widget", object_id: id, object_ref: id, current_state: state, retention_anchor: anchor }, actor);
  }

  test("changes state along the graph and rejects illegal jumps", () => {
    registerWidget("W-STATE");
    const inactive = dl.Objects.changeState(db, tenant, "widget", "W-STATE", "INACTIVE", { actor });
    assert.equal(inactive.current_state, "INACTIVE");
    assert.throws(() => dl.Objects.changeState(db, tenant, "widget", "W-STATE", "COLD_STORAGE", { actor }), /not permitted/i);
    assert.throws(() => dl.Objects.changeState(db, tenant, "widget", "W-STATE", "PURGED", { actor }), /purge workflow/i);
  });

  test("legal holds block transitions and eligibility", () => {
    const hold = dl.LegalHolds.createLegalHold(db, tenant, { code: "HOLD_WIDGET", name: "Widget hold", scope_type: "OBJECT", object_type: "widget", object_ids: [{ object_type: "widget", object_id: "W-STATE" }] }, actor);
    assert.equal(hold.status, "ACTIVE");
    const ledger = dl.Objects.getObjectLifecycle(db, tenant, "widget", "W-STATE");
    assert.equal(ledger.legal_hold_status, "ACTIVE");
    assert.throws(() => dl.Objects.changeState(db, tenant, "widget", "W-STATE", "ARCHIVED", { actor }), /legal hold/i);
    const eligibility = dl.Eligibility.evaluateEligibility(db, { tenantId: tenant, objectType: "widget", objectId: "W-STATE", action: "ARCHIVE" });
    assert.equal(eligibility.blocked, true);
    assert.ok(eligibility.reasons.some((r) => r.code === "LEGAL_HOLD_ACTIVE"));
    const released = dl.LegalHolds.releaseLegalHold(db, tenant, hold.hold_ref, { actor });
    assert.equal(released.status, "RELEASED");
  });

  test("archives, moves to cold storage and purges an object", async () => {
    registerWidget("W-FLOW");
    dl.Objects.changeState(db, tenant, "widget", "W-FLOW", "INACTIVE", { actor });

    const eligibility = dl.Eligibility.evaluateEligibility(db, { tenantId: tenant, objectType: "widget", objectId: "W-FLOW", action: "ARCHIVE" });
    assert.equal(eligibility.blocked, false);

    const archive = await dl.Archive.archiveObject(db, { tenantId: tenant, objectType: "widget", objectId: "W-FLOW", actor, idempotencyKey: "flow-1" });
    assert.equal(archive.status, "stored");
    assert.ok(archive.checksum);
    const duplicate = await dl.Archive.archiveObject(db, { tenantId: tenant, objectType: "widget", objectId: "W-FLOW", actor, idempotencyKey: "flow-1" });
    assert.equal(duplicate.archive_ref, archive.archive_ref);

    const integrity = await dl.Archive.verifyArchiveIntegrity(db, tenant, archive.archive_ref);
    assert.equal(integrity.ok, true);

    const cold = dl.Archive.moveToColdStorage(db, { tenantId: tenant, objectType: "widget", objectId: "W-FLOW", actor });
    assert.equal(cold.current_state, "COLD_STORAGE");

    const purge = await dl.Purge.executePurge(db, { tenantId: tenant, objectType: "widget", objectId: "W-FLOW", actor, reason: "end of life" });
    assert.equal(purge.status, "executed");
    assert.equal(dl.Objects.getObjectLifecycle(db, tenant, "widget", "W-FLOW").current_state, "PURGED");
  });

  test("restores an archived object back to active storage", async () => {
    registerWidget("W-RESTORE");
    dl.Objects.changeState(db, tenant, "widget", "W-RESTORE", "INACTIVE", { actor });
    await dl.Archive.archiveObject(db, { tenantId: tenant, objectType: "widget", objectId: "W-RESTORE", actor });
    const restore = await dl.Restore.restoreObject(db, { tenantId: tenant, objectType: "widget", objectId: "W-RESTORE", actor });
    assert.equal(restore.status, "completed");
    assert.equal(dl.Objects.getObjectLifecycle(db, tenant, "widget", "W-RESTORE").current_state, "INACTIVE");
  });

  test("denies a purge subject to a legal hold", () => {
    registerWidget("W-HOLD-PURGE", "ARCHIVED");
    dl.LegalHolds.createLegalHold(db, tenant, { code: "HOLD_PURGE", name: "Purge hold", scope_type: "OBJECT", object_type: "widget", object_ids: [{ object_type: "widget", object_id: "W-HOLD-PURGE" }] }, actor);
    const evaluation = dl.Purge.evaluatePurgeEligibility(db, { tenantId: tenant, objectType: "widget", objectId: "W-HOLD-PURGE" });
    assert.equal(evaluation.blocked, true);
    assert.ok(queryOne(db, "SELECT id FROM lc_legal_holds WHERE tenant_id = ? AND code = 'HOLD_PURGE'", [tenant]));
  });

  test("records history for every lifecycle action", () => {
    const history = dl.History.listHistory(db, { tenantId: tenant, objectType: "widget", objectId: "W-FLOW" });
    assert.ok(history.items.length >= 3);
    assert.ok(history.items.some((row) => row.action === "PURGE"));
  });
});
