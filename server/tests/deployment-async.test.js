process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { Constants, Features, Foundation, History, Profile } from "../services/deployment/index.js";
import { invalidateCapabilities } from "../services/deployment/cache.js";

function adminActor(db) {
  const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  return row ? { id: row.id, username: row.username } : null;
}

function stripTimestamps(value) {
  if (Array.isArray(value)) return value.map(stripTimestamps);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (key === "generated_at" || key === "timestamp" || key === "updated_at" || key === "created_at") continue;
      out[key] = stripTimestamps(entry);
    }
    return out;
  }
  return value;
}

describe("async deployment read twins mirror the synchronous service", () => {
  let db;
  let actor;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
    Foundation.ensureDeploymentFoundation(db);
    Profile.updateProfile(db, { mode: "saas", installation_name: "Parity Cloud" }, actor);
    Features.setFeature(db, "observability", { enabled: false }, actor);
  });

  after(() => db?.close());

  test("profile reads match", async () => {
    assert.deepEqual(await Profile.getProfileAsync(db), Profile.getProfile(db));
  });

  test("feature reads match", async () => {
    assert.deepEqual(await Features.listFeaturesAsync(db), Features.listFeatures(db));
    assert.deepEqual(await Features.featureRowAsync(db, "observability"), Features.featureRow(db, "observability"));
    assert.deepEqual(await Features.featureRowAsync(db, "missing"), Features.featureRow(db, "missing"));
  });

  test("capability resolution matches", async () => {
    invalidateCapabilities(db);
    const asyncValue = stripTimestamps(await Features.resolveCapabilitiesAsync(db));
    invalidateCapabilities(db);
    const syncValue = stripTimestamps(Features.resolveCapabilities(db));
    assert.deepEqual(asyncValue, syncValue);
  });

  test("feature summary and health match", async () => {
    assert.deepEqual(await Features.featureSummaryAsync(db), Features.featureSummary(db));
    invalidateCapabilities(db);
    const asyncHealth = await Foundation.deploymentHealthAsync(db);
    invalidateCapabilities(db);
    const syncHealth = Foundation.deploymentHealth(db);
    assert.deepEqual(stripTimestamps(asyncHealth), stripTimestamps(syncHealth));
  });

  test("history reads match", async () => {
    assert.deepEqual(stripTimestamps(await History.listDeploymentHistoryAsync(db, {})), stripTimestamps(History.listDeploymentHistory(db, {})));
    assert.deepEqual(
      await History.listDeploymentHistoryAsync(db, { entityType: "feature" }),
      History.listDeploymentHistory(db, { entityType: "feature" })
    );
  });

  test("vocabulary constants are shared", () => {
    assert.deepEqual(Constants.DEPLOYMENT_MODES.map((m) => m.code), ["saas", "private_cloud", "local"]);
    assert.deepEqual(Constants.EDITIONS.map((e) => e.code), ["community", "standard", "enterprise"]);
  });
});

describe("async deployment write twins mirror the synchronous service", () => {
  let asyncDb;
  let syncDb;
  let actor;

  before(() => {
    asyncDb = openTestDatabase();
    migrate(asyncDb);
    seedDatabase(asyncDb);
    syncDb = openTestDatabase();
    migrate(syncDb);
    seedDatabase(syncDb);
    actor = adminActor(asyncDb);
    Foundation.ensureDeploymentFoundation(asyncDb);
    Foundation.ensureDeploymentFoundation(syncDb);
  });

  after(() => {
    asyncDb?.close();
    syncDb?.close();
  });

  test("profile update produces the same result", async () => {
    const body = { mode: "saas", edition: "standard", installation_name: "Same Name", notes: "parity" };
    const asyncResult = await Profile.updateProfileAsync(asyncDb, body, actor);
    const syncResult = Profile.updateProfile(syncDb, body, actor);
    assert.deepEqual(stripTimestamps(asyncResult), stripTimestamps(syncResult));
    assert.deepEqual(stripTimestamps(await Profile.getProfileAsync(asyncDb)), stripTimestamps(Profile.getProfile(syncDb)));
  });

  test("profile update rejects invalid input identically", async () => {
    await assert.rejects(() => Profile.updateProfileAsync(asyncDb, { mode: "mainframe" }, actor), (err) => err.status === 400);
    assert.throws(() => Profile.updateProfile(syncDb, { mode: "mainframe" }, actor), (err) => err.status === 400);
  });

  test("feature update produces the same result", async () => {
    const asyncResult = await Features.setFeatureAsync(asyncDb, "observability", { enabled: false, notes: "off" }, actor);
    const syncResult = Features.setFeature(syncDb, "observability", { enabled: false, notes: "off" }, actor);
    assert.deepEqual(asyncResult, syncResult);
    assert.equal(asyncResult.effective, false);
    assert.ok(asyncResult.reasons.includes("disabled_by_operator"));
  });

  test("feature update rejects unknown codes identically", async () => {
    await assert.rejects(() => Features.setFeatureAsync(asyncDb, "nope", { enabled: false }, actor), (err) => err.status === 404);
    assert.throws(() => Features.setFeature(syncDb, "nope", { enabled: false }, actor), (err) => err.status === 404);
  });

  test("history reflects both write paths equivalently", async () => {
    const asyncHistory = stripTimestamps(await History.listDeploymentHistoryAsync(asyncDb, {}));
    const syncHistory = stripTimestamps(History.listDeploymentHistory(syncDb, {}));
    assert.deepEqual(asyncHistory.items, syncHistory.items);
    assert.equal(asyncHistory.total, syncHistory.total);
  });
});
