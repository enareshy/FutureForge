process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as V from "../services/versioning.js";

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/_at$/.test(key) || /_ref$/.test(key)) continue;
      if (key === "cacheKey" || key === "durationMs" || key === "duration_ms") continue;
      if (key === "context_hash" || key === "request_id" || key === "correlation_id" || key === "timestamp") continue;
      out[key] = normalize(entry);
    }
    return out;
  }
  return value;
}

function bootstrap(db) {
  migrate(db);
  seedDatabase(db);
}

describe("async versioning read twins mirror the synchronous service", () => {
  let db;

  before(() => {
    db = openTestDatabase();
    bootstrap(db);
  });
  after(() => db?.close());

  test("revision reads match", async () => {
    assert.deepEqual(await V.Revisions.listRevisionsAsync(db, { objectId: "PART-DEMO-DATE" }), V.Revisions.listRevisions(db, { objectId: "PART-DEMO-DATE" }));
    const sync = V.Revisions.listRevisions(db, { objectId: "PART-DEMO-DATE" });
    assert.deepEqual(await V.Revisions.getRevisionAsync(db, sync.items[0].id), V.Revisions.getRevision(db, sync.items[0].id));
  });

  test("effectivity type and definition reads match", async () => {
    assert.deepEqual(await V.Effectivities.listEffectivityTypesAsync(db), V.Effectivities.listEffectivityTypes(db));
    assert.deepEqual(await V.Effectivities.listDefinitionsAsync(db), V.Effectivities.listDefinitions(db));
  });

  test("policy reads match", async () => {
    assert.deepEqual(await V.Policies.listResolutionPoliciesAsync(db, {}), V.Policies.listResolutionPolicies(db, {}));
    assert.deepEqual(await V.Policies.defaultPolicyRowAsync(db), V.Policies.defaultPolicyRow(db));
  });

  test("variant/context/baseline/snapshot list reads match", async () => {
    assert.deepEqual(await V.Variants.listVariantsAsync(db, {}), V.Variants.listVariants(db, {}));
    assert.deepEqual(await V.ConfigurationContexts.listConfigurationContextsAsync(db, {}), V.ConfigurationContexts.listConfigurationContexts(db, {}));
    assert.deepEqual(await V.Baselines.listBaselinesAsync(db, {}), V.Baselines.listBaselines(db, {}));
    assert.deepEqual(await V.Snapshots.listSnapshotsAsync(db, {}), V.Snapshots.listSnapshots(db, {}));
  });

  test("metrics reads match", async () => {
    assert.deepEqual(normalize(await V.Metrics.metricsSnapshotAsync(db)), normalize(V.Metrics.metricsSnapshot(db)));
    assert.deepEqual(normalize(await V.Metrics.dashboardSummaryAsync(db)), normalize(V.Metrics.dashboardSummary(db)));
    assert.deepEqual(normalize(await V.Metrics.healthCheckAsync(db)), normalize(V.Metrics.healthCheck(db)));
  });

  test("resolution matches", async () => {
    const input = { objectType: "Part", objectId: "PART-DEMO-DATE", context: { asOfDate: "2026-03-01" } };
    assert.deepEqual(normalize(await V.Engine.EffectivityResolver.resolveAsync(db, input)), normalize(V.Engine.EffectivityResolver.resolve(db, input)));
    const bulkInput = { context: { asOfDate: "2026-03-01" }, objects: [{ objectType: "Part", objectId: "PART-DEMO-DATE" }] };
    assert.deepEqual(normalize(await V.Engine.EffectivityResolver.resolveBulkAsync(db, bulkInput)), normalize(V.Engine.EffectivityResolver.resolveBulk(db, bulkInput)));
  });
});

describe("async versioning write twins mirror the synchronous service", () => {
  let asyncDb;
  let syncDb;

  before(() => {
    asyncDb = openTestDatabase();
    syncDb = openTestDatabase();
    bootstrap(asyncDb);
    bootstrap(syncDb);
  });
  after(() => {
    asyncDb?.close();
    syncDb?.close();
  });

  test("revision create/update/transition match", async () => {
    const a = await V.Revisions.createRevisionAsync(asyncDb, { objectType: "Part", objectId: "REV-PARITY", revisionCode: "A", isDefault: true }, null, null, null);
    const b = V.Revisions.createRevision(syncDb, { objectType: "Part", objectId: "REV-PARITY", revisionCode: "A", isDefault: true }, null, null, null);
    assert.deepEqual(normalize(a), normalize(b));
    assert.equal(a.revision_sequence, b.revision_sequence);

    const asyncUpdated = await V.Revisions.updateRevisionAsync(asyncDb, a.id, { name: "Renamed" }, null, null);
    const syncUpdated = V.Revisions.updateRevision(syncDb, b.id, { name: "Renamed" }, null, null);
    assert.deepEqual(normalize(asyncUpdated), normalize(syncUpdated));

    const asyncActive = await V.Revisions.activateRevisionAsync(asyncDb, a.id, null, null);
    const syncActive = V.Revisions.activateRevision(syncDb, b.id, null, null);
    assert.deepEqual(normalize(asyncActive), normalize(syncActive));
    assert.equal(asyncActive.status, "active");
  });

  test("version create and transition match", async () => {
    const a = await V.Revisions.createRevisionAsync(asyncDb, { objectType: "Part", objectId: "VER-PARITY", revisionCode: "A", isDefault: true }, null, null, null);
    const b = V.Revisions.createRevision(syncDb, { objectType: "Part", objectId: "VER-PARITY", revisionCode: "A", isDefault: true }, null, null, null);
    const asyncVersion = await V.Versions.createVersionAsync(asyncDb, a.id, { versionNumber: "1", status: "active", isDefault: true }, null, null);
    const syncVersion = V.Versions.createVersion(syncDb, b.id, { versionNumber: "1", status: "active", isDefault: true }, null, null);
    assert.deepEqual(normalize(asyncVersion), normalize(syncVersion));
  });

  test("effectivity definition and assignment match", async () => {
    const asyncDef = await V.Effectivities.createDefinitionAsync(asyncDb, { code: "PARITY-DATE", name: "Parity", typeCode: "DATE_EFFECTIVITY", dimension: "date", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }, null, null, null);
    const syncDef = V.Effectivities.createDefinition(syncDb, { code: "PARITY-DATE", name: "Parity", typeCode: "DATE_EFFECTIVITY", dimension: "date", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }, null, null, null);
    assert.deepEqual(normalize(asyncDef), normalize(syncDef));

    const asyncAsn = await V.Effectivities.createAssignmentAsync(asyncDb, asyncDef.id, { objectType: "Part", objectId: "ASN-PARITY" }, null, null, null);
    const syncAsn = V.Effectivities.createAssignment(syncDb, syncDef.id, { objectType: "Part", objectId: "ASN-PARITY" }, null, null, null);
    assert.deepEqual(normalize(asyncAsn), normalize(syncAsn));
  });

  test("resolution policy create matches", async () => {
    const body = { code: "PARITY-POL", name: "Parity policy", precedence: ["date", "serial", "default"], ambiguityStrategy: "error" };
    const asyncPolicy = await V.Policies.createResolutionPolicyAsync(asyncDb, body, null, null, null);
    const syncPolicy = V.Policies.createResolutionPolicy(syncDb, body, null, null, null);
    assert.deepEqual(normalize(asyncPolicy), normalize(syncPolicy));
  });

  test("variant create/evaluate match", async () => {
    const body = { code: "PARITY-VAR", name: "Parity variant", options: [{ code: "BASE" }, { code: "ELECTRIC" }], rules: [{ code: "ONLY-ELECTRIC", ruleType: "inclusion", expression: { dimension: "variantCode", operator: "in", values: ["ELECTRIC"] } }] };
    const asyncVariant = await V.Variants.createVariantAsync(asyncDb, body, null, null, null);
    const syncVariant = V.Variants.createVariant(syncDb, body, null, null, null);
    assert.deepEqual(normalize(asyncVariant), normalize(syncVariant));
    assert.deepEqual(normalize(await V.Variants.evaluateVariantAsync(asyncDb, asyncVariant.id, { variantCode: "ELECTRIC" })), normalize(V.Variants.evaluateVariant(syncDb, syncVariant.id, { variantCode: "ELECTRIC" })));
  });

  test("configuration context create matches", async () => {
    const body = { code: "PARITY-CTX", name: "Parity context", plantId: "PLANT01" };
    const asyncCtx = await V.ConfigurationContexts.createConfigurationContextAsync(asyncDb, body, null, null, null);
    const syncCtx = V.ConfigurationContexts.createConfigurationContext(syncDb, body, null, null, null);
    assert.deepEqual(normalize(asyncCtx), normalize(syncCtx));
  });

  test("baseline create/freeze/restore match", async () => {
    await V.Revisions.createRevisionAsync(asyncDb, { objectType: "Part", objectId: "BL-PARITY", revisionCode: "A", isDefault: true, effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" }, null, null, null);
    V.Revisions.createRevision(syncDb, { objectType: "Part", objectId: "BL-PARITY", revisionCode: "A", isDefault: true, effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" }, null, null, null);
    const body = { code: "PARITY-BL", name: "Parity baseline", context: { asOfDate: "2026-05-01" }, objects: [{ objectType: "Part", objectId: "BL-PARITY" }] };
    const asyncBl = await V.Baselines.createBaselineAsync(asyncDb, body, null, null, null);
    const syncBl = V.Baselines.createBaseline(syncDb, body, null, null, null);
    assert.deepEqual(normalize(asyncBl), normalize(syncBl));
    assert.deepEqual(normalize(await V.Baselines.freezeBaselineAsync(asyncDb, asyncBl.id, null, null)), normalize(V.Baselines.freezeBaseline(syncDb, syncBl.id, null, null)));
    assert.deepEqual(normalize(await V.Baselines.restoreBaselineAsync(asyncDb, asyncBl.id)), normalize(V.Baselines.restoreBaseline(syncDb, syncBl.id)));
  });

  test("snapshot create/archive match", async () => {
    await V.Revisions.createRevisionAsync(asyncDb, { objectType: "Part", objectId: "SNAP-PARITY", revisionCode: "A", isDefault: true, effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" }, null, null, null);
    V.Revisions.createRevision(syncDb, { objectType: "Part", objectId: "SNAP-PARITY", revisionCode: "A", isDefault: true, effectiveFrom: "2026-01-01", effectiveTo: "2026-06-30" }, null, null, null);
    const body = { code: "PARITY-SNAP", name: "Parity snapshot", context: { asOfDate: "2026-05-01" }, objects: [{ objectType: "Part", objectId: "SNAP-PARITY" }] };
    const asyncSnap = await V.Snapshots.createSnapshotAsync(asyncDb, body, null, null, null);
    const syncSnap = V.Snapshots.createSnapshot(syncDb, body, null, null, null);
    assert.deepEqual(normalize(asyncSnap), normalize(syncSnap));
    assert.deepEqual(normalize(await V.Snapshots.archiveSnapshotAsync(asyncDb, asyncSnap.id, null, null)), normalize(V.Snapshots.archiveSnapshot(syncDb, syncSnap.id, null, null)));
  });

  test("error parity for unknown refs", async () => {
    await assert.rejects(() => V.Revisions.getRevisionAsync(asyncDb, "nope"), (err) => Boolean(err));
    assert.throws(() => V.Revisions.getRevision(syncDb, "nope"), (err) => Boolean(err));
  });
});
