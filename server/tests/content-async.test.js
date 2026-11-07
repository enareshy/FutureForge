process.env.FILE_STORAGE_PROVIDER = "memory";
process.env.FILE_SCAN_PROVIDER = "heuristic";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as C from "../services/content.js";

function seedTenant() {
  const db = openTestDatabase();
  migrate(db);
  seedDatabase(db);
  return db;
}

function adminActor(db) {
  const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  return row ? { id: row.id, username: row.username } : null;
}

function stripReads(value) {
  if (Array.isArray(value)) return value.map(stripReads);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/_at$/.test(key) || key === "duration_ms" || key === "latency_ms" || key === "now") continue;
      out[key] = stripReads(entry);
    }
    return out;
  }
  return value;
}

function stripWrites(value) {
  if (Array.isArray(value)) return value.map(stripWrites);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (/_at$/.test(key)) continue;
      if (/(?:^|_)(id|ref|key|token)$/.test(key)) continue;
      if (key === "duration_ms" || key === "latency_ms") continue;
      out[key] = stripWrites(entry);
    }
    return out;
  }
  return value;
}

describe("async content read twins mirror the synchronous service", () => {
  let db;
  before(async () => {
    db = seedTenant();
    const actor = adminActor(db);
    await C.Content.createContentAsync(db, { fileName: "parity-read.txt", buffer: Buffer.from("read parity payload"), objectType: "Part", objectId: "PR-1" }, { actor, tenantId: 1 });
  });
  after(() => db?.close());

  test("collection, facets and detail reads match", async () => {
    assert.deepEqual(stripReads(await C.Content.listContentAsync(db, { tenantId: 1 })), stripReads(C.Content.listContent(db, { tenantId: 1 })));
    assert.deepEqual(stripReads(await C.Content.contentFacetsAsync(db, { tenantId: 1 })), stripReads(C.Content.contentFacets(db, { tenantId: 1 })));
    const list = C.Content.listContent(db, { tenantId: 1 });
    const ref = list.items[0].content_id;
    assert.deepEqual(stripReads(await C.Content.contentDetailAsync(db, ref, { tenantId: 1 })), stripReads(C.Content.contentDetail(db, ref, { tenantId: 1 })));
  });

  test("retention, upload, lock, association and processing reads match", async () => {
    assert.deepEqual(stripReads(await C.Retention.listRetentionPoliciesAsync(db, { tenantId: 1 })), stripReads(C.Retention.listRetentionPolicies(db, { tenantId: 1 })));
    assert.deepEqual(stripReads(await C.Sessions.listUploadSessionsAsync(db, { tenantId: 1 })), stripReads(C.Sessions.listUploadSessions(db, { tenantId: 1 })));
    assert.deepEqual(stripReads(await C.Locks.listLocksAsync(db, { tenantId: 1 })), stripReads(C.Locks.listLocks(db, { tenantId: 1 })));
    assert.deepEqual(stripReads(await C.Associations.listAssociationsAsync(db, { tenantId: 1 })), stripReads(C.Associations.listAssociations(db, { tenantId: 1 })));
    assert.deepEqual(stripReads(await C.Processing.listProcessingJobsAsync(db, { tenantId: 1 })), stripReads(C.Processing.listProcessingJobs(db, { tenantId: 1 })));
    assert.deepEqual(stripReads(await C.Events.listContentEventsAsync(db, { tenantId: 1 })), stripReads(C.Events.listContentEvents(db, { tenantId: 1 })));
  });

  test("metrics reads match", async () => {
    assert.deepEqual(stripReads(await C.Metrics.metricsSnapshotAsync(db, { tenantId: 1 })), stripReads(C.Metrics.metricsSnapshot(db, { tenantId: 1 })));
    assert.deepEqual(stripReads(await C.Metrics.storageSummaryAsync(db, { tenantId: 1 })), stripReads(C.Metrics.storageSummary(db, { tenantId: 1 })));
    assert.deepEqual(stripReads(await C.Metrics.securitySummaryAsync(db, { tenantId: 1 })), stripReads(C.Metrics.securitySummary(db, { tenantId: 1 })));
    assert.deepEqual(stripReads(await C.Metrics.processingSummaryAsync(db, { tenantId: 1 })), stripReads(C.Metrics.processingSummary(db, { tenantId: 1 })));
  });
});

describe("async content write twins mirror the synchronous service", () => {
  let asyncDb;
  let syncDb;
  let asyncActor;
  let syncActor;

  before(() => {
    asyncDb = seedTenant();
    syncDb = seedTenant();
    asyncActor = adminActor(asyncDb);
    syncActor = adminActor(syncDb);
  });
  after(() => {
    asyncDb?.close();
    syncDb?.close();
  });

  test("createContent matches", async () => {
    const input = { fileName: "parity.txt", buffer: Buffer.from("write parity payload"), objectType: "Part", objectId: "WP-1" };
    const a = await C.Content.createContentAsync(asyncDb, input, { actor: asyncActor, tenantId: 1, process: false });
    const b = await C.Content.createContent(syncDb, input, { actor: syncActor, tenantId: 1, process: false });
    assert.deepEqual(stripWrites(a), stripWrites(b));
  });

  test("retention policy create/update matches", async () => {
    const body = { policy_code: "parity-retention", name: "Parity retention", retention_days: 30, retention_start_basis: "created", disposition: "review" };
    const a = await C.Retention.createRetentionPolicyAsync(asyncDb, body, { actor: asyncActor, tenantId: 1 });
    const b = await C.Retention.createRetentionPolicy(syncDb, body, { actor: syncActor, tenantId: 1 });
    assert.deepEqual(stripWrites(a), stripWrites(b));
    const aUp = await C.Retention.updateRetentionPolicyAsync(asyncDb, a.policy_ref, { retention_days: 60 }, { actor: asyncActor, tenantId: 1 });
    const bUp = await C.Retention.updateRetentionPolicy(syncDb, b.policy_ref, { retention_days: 60 }, { actor: syncActor, tenantId: 1 });
    assert.deepEqual(stripWrites(aUp), stripWrites(bUp));
  });

  test("upload session initiate/append/complete matches", async () => {
    const body = { fileName: "session.txt", expectedSize: 11, objectType: "Part", objectId: "UP-1" };
    const a = await C.Sessions.initiateUploadSessionAsync(asyncDb, body, { actor: asyncActor, tenantId: 1 });
    const b = await C.Sessions.initiateUploadSession(syncDb, body, { actor: syncActor, tenantId: 1 });
    assert.deepEqual(stripWrites(a), stripWrites(b));
    const aPart = await C.Sessions.appendUploadPartAsync(asyncDb, a.upload_id, { partNumber: 1, buffer: Buffer.from("hello world"), tenantId: 1, actor: asyncActor });
    const bPart = await C.Sessions.appendUploadPart(syncDb, b.upload_id, { partNumber: 1, buffer: Buffer.from("hello world"), tenantId: 1, actor: syncActor });
    assert.deepEqual(stripWrites(aPart), stripWrites(bPart));
  });

  test("association create matches on an existing content row", async () => {
    const input = { fileName: "assoc.txt", buffer: Buffer.from("assoc payload"), objectType: "Part", objectId: "AS-1" };
    const aContent = await C.Content.createContentAsync(asyncDb, input, { actor: asyncActor, tenantId: 1 });
    const bContent = await C.Content.createContent(syncDb, input, { actor: syncActor, tenantId: 1 });
    const aBody = { content_id: aContent.content_id, object_type: "Part", object_id: "AS-TARGET", content_role: "ATTACHMENT" };
    const bBody = { content_id: bContent.content_id, object_type: "Part", object_id: "AS-TARGET", content_role: "ATTACHMENT" };
    const a = await C.Associations.createAssociationAsync(asyncDb, aBody, { actor: asyncActor, tenantId: 1 });
    const b = C.Associations.createAssociation(syncDb, bBody, { actor: syncActor, tenantId: 1 });
    assert.deepEqual(stripWrites(a), stripWrites(b));
  });

  test("quarantine and release match", async () => {
    const input = { fileName: "quarantine.txt", buffer: Buffer.from("quarantine payload"), objectType: "Part", objectId: "Q-1" };
    const aContent = await C.Content.createContentAsync(asyncDb, input, { actor: asyncActor, tenantId: 1 });
    const bContent = await C.Content.createContent(syncDb, input, { actor: syncActor, tenantId: 1 });
    const aRow = C.Repository.findContentRow(asyncDb, aContent.content_id, 1);
    const bRow = C.Repository.findContentRow(syncDb, bContent.content_id, 1);
    const a = await C.Security.quarantineContentAsync(asyncDb, aRow, { reason: "parity", actor: asyncActor, tenantId: 1 });
    const b = C.Security.quarantineContent(syncDb, bRow, { reason: "parity", actor: syncActor, tenantId: 1 });
    assert.deepEqual(stripWrites(a), stripWrites(b));
    const aRow2 = C.Repository.findContentRow(asyncDb, aContent.content_id, 1);
    const bRow2 = C.Repository.findContentRow(syncDb, bContent.content_id, 1);
    const aRel = await C.Security.releaseQuarantineAsync(asyncDb, aRow2, { reason: "parity", actor: asyncActor, tenantId: 1 });
    const bRel = C.Security.releaseQuarantine(syncDb, bRow2, { reason: "parity", actor: syncActor, tenantId: 1 });
    assert.deepEqual(stripWrites(aRel), stripWrites(bRel));
  });

  test("checkout and force release match", async () => {
    const input = { fileName: "lock.txt", buffer: Buffer.from("lock payload"), objectType: "Part", objectId: "LK-1" };
    const aContent = await C.Content.createContentAsync(asyncDb, input, { actor: asyncActor, tenantId: 1 });
    const bContent = await C.Content.createContent(syncDb, input, { actor: syncActor, tenantId: 1 });
    const a = await C.Locks.checkOutContentAsync(asyncDb, aContent.content_id, { actor: asyncActor, tenantId: 1, reason: "parity" });
    const b = C.Locks.checkOutContent(syncDb, bContent.content_id, { actor: syncActor, tenantId: 1, reason: "parity" });
    assert.deepEqual(stripWrites(a), stripWrites(b));
    const aRel = await C.Locks.forceReleaseLockAsync(asyncDb, aContent.content_id, { actor: asyncActor, tenantId: 1, reason: "done" });
    const bRel = C.Locks.forceReleaseLock(syncDb, bContent.content_id, { actor: syncActor, tenantId: 1, reason: "done" });
    assert.deepEqual(stripWrites(aRel), stripWrites(bRel));
  });

  test("error parity for unknown content", async () => {
    await assert.rejects(() => C.Content.getContentAsync(asyncDb, "CNT-MISSING", 1), (err) => Boolean(err));
    assert.throws(() => C.Content.getContent(syncDb, "CNT-MISSING", 1), (err) => Boolean(err));
  });
});
