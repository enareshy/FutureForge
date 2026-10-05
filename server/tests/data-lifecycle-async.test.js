process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as dl from "../services/data-lifecycle/index.js";

function helixTenant(db) {
  return queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'")?.id ?? null;
}

function adminActor(db) {
  const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  return row ? { id: row.id, username: row.username } : null;
}

describe("data-lifecycle async twins mirror the sync layer", () => {
  let db;
  let tenant;
  let actor;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    tenant = helixTenant(db);
    actor = adminActor(db);
    await dl.Policies.createPolicyAsync(
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

  async function registerWidget(id, state = "ACTIVE") {
    const anchor = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    return await dl.Objects.registerObjectLifecycleAsync(db, tenant, { object_type: "widget", object_id: id, object_ref: id, current_state: state, retention_anchor: anchor }, actor);
  }

  test("foundation health matches the sync layer and is tenant-scoped", async () => {
    const asyncHealth = await dl.Foundation.lifecycleHealthAsync(db, tenant);
    const syncHealth = dl.Foundation.lifecycleHealth(db, tenant);
    assert.deepEqual(asyncHealth.counts, syncHealth.counts);
    assert.ok(asyncHealth.counts.objects >= 5);

    const scoped = await dl.Foundation.lifecycleHealthAsync(db, 999999);
    assert.equal(scoped.counts.objects, 0);
  });

  test("states, transitions and tiers resolve asynchronously", async () => {
    const active = await dl.States.requireStateAsync(db, tenant, "ACTIVE");
    assert.equal(active.code, "ACTIVE");

    const allowed = await dl.States.allowedTransitionsAsync(db, tenant, "ACTIVE");
    assert.ok(Array.isArray(allowed) ? allowed.length >= 1 : allowed.items.length >= 1);

    assert.ok(await dl.States.assertTransitionAsync(db, tenant, "ACTIVE", "INACTIVE"));
    await assert.rejects(() => dl.States.assertTransitionAsync(db, tenant, "ACTIVE", "ARCHIVED"), /not permitted/i);

    assert.equal(await dl.Tiers.resolveTierAsync(db, tenant, "ACTIVE"), "HOT");
    assert.equal(await dl.Tiers.resolveTierAsync(db, tenant, "COLD_STORAGE"), "COLD");
    const tiers = await dl.Tiers.listTierPoliciesAsync(db, { tenantId: tenant });
    assert.ok(tiers.length >= 1 || tiers.items.length >= 1);
  });

  test("policies resolve, version and read asynchronously", async () => {
    const resolution = await dl.Policies.resolvePolicyAsync(db, { tenantId: tenant, objectType: "widget", lifecycleState: "INACTIVE" });
    assert.ok(resolution.policy);
    assert.equal(resolution.policy.code, "WIDGET_RETENTION");

    const fetched = await dl.Policies.getPolicyAsync(db, tenant, "WIDGET_RETENTION");
    assert.equal(fetched.code, "WIDGET_RETENTION");

    const updated = await dl.Policies.updatePolicyAsync(db, tenant, "WIDGET_RETENTION", { name: "Widget retention v2" }, actor);
    assert.ok(updated.version >= 2);
    const versions = await dl.Policies.listPolicyVersionsAsync(db, tenant, "WIDGET_RETENTION");
    assert.ok((versions.items ?? versions).length >= 1);

    const list = await dl.Policies.listPoliciesAsync(db, { tenantId: tenant, q: "WIDGET" });
    assert.ok(list.items.some((p) => p.code === "WIDGET_RETENTION"));

    assert.deepEqual(await dl.Policies.defaultRetentionConfigAsync(db, tenant), dl.Policies.defaultRetentionConfig(db, tenant));
  });

  test("configuration write validates and persists asynchronously", async () => {
    await assert.rejects(() => dl.Configuration.setConfigAsync(db, tenant, "quality_min_score", 200), /between 0 and 100/i);
    const value = await dl.Configuration.setConfigAsync(db, tenant, "quality_min_score", 75);
    assert.equal(Number(value), 75);
    assert.equal(Number(await dl.Configuration.getConfigAsync(db, tenant, "quality_min_score")), 75);
    const config = await dl.Configuration.listConfigAsync(db, tenant);
    assert.equal(Number(config.quality_min_score), 75);
  });

  test("object ledger registers, changes state and rejects illegal jumps", async () => {
    await registerWidget("W-STATE");
    const inactive = await dl.Objects.changeStateAsync(db, tenant, "widget", "W-STATE", "INACTIVE", { actor });
    assert.equal(inactive.current_state, "INACTIVE");
    assert.equal((await dl.Objects.getObjectLifecycleAsync(db, tenant, "widget", "W-STATE")).current_state, "INACTIVE");

    await assert.rejects(() => dl.Objects.changeStateAsync(db, tenant, "widget", "W-STATE", "COLD_STORAGE", { actor }), /not permitted/i);
    await assert.rejects(() => dl.Objects.changeStateAsync(db, tenant, "widget", "W-STATE", "PURGED", { actor }), /purge workflow/i);

    const retained = await dl.Objects.applyRetentionAsync(db, tenant, "widget", "W-STATE", { actor });
    assert.ok(retained.archive_eligible_at);

    const tiered = await dl.Objects.setObjectTierAsync(db, tenant, "widget", "W-STATE", "COLD", { actor });
    assert.equal(tiered.data_tier, "COLD");

    const caps = await dl.Objects.stateCapabilitiesAsync(db, tenant, "INACTIVE");
    assert.equal(typeof caps, "object");
  });

  test("legal holds block transitions and eligibility asynchronously", async () => {
    const hold = await dl.LegalHolds.createLegalHoldAsync(db, tenant, { code: "HOLD_WIDGET_ASYNC", name: "Widget hold", scope_type: "OBJECT", object_type: "widget", object_ids: [{ object_type: "widget", object_id: "W-STATE" }] }, actor);
    assert.equal(hold.status, "ACTIVE");

    const fetched = await dl.LegalHolds.getLegalHoldAsync(db, tenant, hold.hold_ref);
    assert.equal(fetched.code, "HOLD_WIDGET_ASYNC");

    const holds = await dl.LegalHolds.activeHoldsForObjectAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-STATE" });
    assert.ok(holds.length >= 1);

    const ledger = await dl.Objects.getObjectLifecycleAsync(db, tenant, "widget", "W-STATE");
    assert.equal(ledger.legal_hold_status, "ACTIVE");

    await assert.rejects(() => dl.Objects.changeStateAsync(db, tenant, "widget", "W-STATE", "ARCHIVED", { actor }), /legal hold/i);

    const eligibility = await dl.Eligibility.evaluateEligibilityAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-STATE", action: "ARCHIVE" });
    assert.equal(eligibility.blocked, true);
    assert.ok(eligibility.reasons.some((r) => r.code === "LEGAL_HOLD_ACTIVE"));

    const released = await dl.LegalHolds.releaseLegalHoldAsync(db, tenant, hold.hold_ref, { actor });
    assert.equal(released.status, "RELEASED");
  });

  test("dependencies record, evaluate and resolve asynchronously", async () => {
    await registerWidget("W-DEP");
    await registerWidget("W-DEP-2");
    const dependency = await dl.Dependencies.recordDependencyAsync(db, tenant, { object_type: "widget", object_id: "W-DEP", depends_on_type: "widget", depends_on_id: "W-DEP-2", relationship_type: "REFERENCES", blocking: true }, actor);
    assert.ok(dependency.id);
    assert.equal(String(dependency.object_id), "W-DEP");

    const list = await dl.Dependencies.listDependenciesAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-DEP" });
    assert.ok(list.items.some((d) => String(d.depends_on_id) === "W-DEP-2"));

    const evaluated = await dl.Dependencies.evaluateDependenciesAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-DEP" });
    assert.equal(typeof evaluated, "object");

    const resolved = await dl.Dependencies.resolveDependencyAsync(db, tenant, dependency.id, actor);
    assert.ok(resolved.resolved_at);
  });

  test("archive, cold storage and integrity verification run asynchronously", async () => {
    await registerWidget("W-FLOW");
    await dl.Objects.changeStateAsync(db, tenant, "widget", "W-FLOW", "INACTIVE", { actor });

    const eligibility = await dl.Eligibility.evaluateEligibilityAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-FLOW", action: "ARCHIVE" });
    assert.equal(eligibility.blocked, false);

    const archive = await dl.Archive.archiveObjectAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-FLOW", actor, idempotencyKey: "async-flow-1" });
    assert.equal(archive.status, "stored");
    assert.ok(archive.checksum);

    const duplicate = await dl.Archive.archiveObjectAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-FLOW", actor, idempotencyKey: "async-flow-1" });
    assert.equal(duplicate.archive_ref, archive.archive_ref);

    const integrity = await dl.Archive.verifyArchiveIntegrityAsync(db, tenant, archive.archive_ref);
    assert.equal(integrity.ok, true);

    const fetched = await dl.Archive.getArchiveRecordAsync(db, tenant, archive.archive_ref);
    assert.equal(fetched.archive_ref, archive.archive_ref);

    const listed = await dl.Archive.listArchiveRecordsAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-FLOW" });
    assert.ok(listed.items.some((a) => a.archive_ref === archive.archive_ref));

    const cold = await dl.Archive.moveToColdStorageAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-FLOW", actor });
    assert.equal(cold.current_state, "COLD_STORAGE");
  });

  test("purge executes, summarises and blocks held objects asynchronously", async () => {
    const purge = await dl.Purge.executePurgeAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-FLOW", actor, reason: "end of life" });
    assert.equal(purge.status, "executed");
    assert.equal((await dl.Objects.getObjectLifecycleAsync(db, tenant, "widget", "W-FLOW")).current_state, "PURGED");

    const record = await dl.Purge.getPurgeRecordAsync(db, tenant, purge.purge_ref);
    assert.equal(record.purge_ref, purge.purge_ref);
    const list = await dl.Purge.listPurgeRecordsAsync(db, { tenantId: tenant, objectType: "widget" });
    assert.ok(list.items.some((p) => p.purge_ref === purge.purge_ref));

    const summary = await dl.Purge.purgeSummaryAsync(db, { tenantId: tenant });
    assert.ok(summary.total >= 1 || summary.items);

    await registerWidget("W-HOLD-PURGE", "ARCHIVED");
    await dl.LegalHolds.createLegalHoldAsync(db, tenant, { code: "HOLD_PURGE_ASYNC", name: "Purge hold", scope_type: "OBJECT", object_type: "widget", object_ids: [{ object_type: "widget", object_id: "W-HOLD-PURGE" }] }, actor);
    const evaluation = await dl.Purge.evaluatePurgeEligibilityAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-HOLD-PURGE" });
    assert.equal(evaluation.blocked, true);
  });

  test("restore returns an archived object to active storage asynchronously", async () => {
    await registerWidget("W-RESTORE");
    await dl.Objects.changeStateAsync(db, tenant, "widget", "W-RESTORE", "INACTIVE", { actor });
    await dl.Archive.archiveObjectAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-RESTORE", actor });

    const restore = await dl.Restore.restoreObjectAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-RESTORE", actor });
    assert.equal(restore.status, "completed");
    assert.equal((await dl.Objects.getObjectLifecycleAsync(db, tenant, "widget", "W-RESTORE")).current_state, "INACTIVE");

    const list = await dl.Restore.listRestoreRecordsAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-RESTORE" });
    assert.ok(list.items.some((r) => r.restore_ref === restore.restore_ref));
  });

  test("recovery request and execute run asynchronously", async () => {
    const request = await dl.Recovery.requestRecoveryAsync(db, { tenantId: tenant, recoveryPointRef: "RP-ASYNC-1", scope: "OBJECT", objectType: "widget", objectId: "W-RESTORE", details: { async: true }, actor });
    assert.ok(request.recovery_ref);
    const executed = await dl.Recovery.executeRecoveryAsync(db, { tenantId: tenant, recoveryRef: request.recovery_ref, actor });
    assert.ok(["completed", "failed"].includes(executed.status));
    const record = await dl.Recovery.getRecoveryRecordAsync(db, tenant, request.recovery_ref);
    assert.equal(record.recovery_ref, request.recovery_ref);
  });

  test("history, catalog snapshots and metrics mirror the sync layer", async () => {
    const history = await dl.History.listHistoryAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-FLOW" });
    assert.ok(history.items.length >= 3);
    assert.ok(history.items.some((row) => row.action === "PURGE"));

    const snapshot = await dl.CatalogIntegration.lifecycleSnapshotAsync(db, { tenantId: tenant, objectType: "widget", objectId: "W-RESTORE" });
    assert.equal(snapshot.tracked, true);
    assert.equal(snapshot.object_type, "widget");

    const bulk = await dl.CatalogIntegration.bulkLifecycleSnapshotsAsync(db, { tenantId: tenant, objects: [{ object_type: "widget", object_id: "W-RESTORE" }] });
    assert.equal(bulk.length, 1);

    const types = await dl.CatalogIntegration.lifecycleAwareTypesAsync(db, { tenantId: tenant });
    assert.ok(types.some((t) => t.object_type === "widget"));

    const asyncMetrics = await dl.Metrics.metricsSnapshotAsync(db, { tenantId: tenant });
    const syncMetrics = dl.Metrics.metricsSnapshot(db, { tenantId: tenant });
    assert.equal(asyncMetrics.counters.objects_tracked, syncMetrics.counters.objects_tracked);
    assert.equal((await dl.Metrics.healthCheckAsync(db, { tenantId: tenant })).status, dl.Metrics.healthCheck(db, { tenantId: tenant }).status);
  });

  test("jobs submit and read asynchronously", async () => {
    const job = await dl.Jobs.submitEvaluationJobAsync(db, { tenantId: tenant, actions: ["ARCHIVE"], apply: false, actor });
    assert.ok(job && (job.id || job.job_ref));
    const listed = await dl.Jobs.listLifecycleJobsAsync(db, { tenantId: tenant });
    assert.ok(Array.isArray(listed.items));
    assert.equal(typeof listed.total, "number");
    assert.equal(await dl.Jobs.getLifecycleJobAsync(db, tenant, "NO-SUCH-LIFECYCLE-JOB"), null);
  });

  test("archive provider configuration resolves asynchronously", async () => {
    assert.equal(await dl.Providers.resolveProviderCodeAsync(db, tenant), "database");
    assert.equal(await dl.Providers.resolveProviderCodeAsync(db, 999999), "database");
  });
});
