process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as search from "../services/search.js";

// Async parity for the Search indexing surface. The synchronous engine is the
// reference; the async engine (async pool + async source resolvers) must build
// the same documents and maintain the same index/queue rows.

describe("async search indexing twins mirror the synchronous engine", () => {
  let db;
  let admin;
  let tenantId;
  let objectId;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    admin = queryOne(db, "SELECT * FROM users WHERE username = 'admin'");
    tenantId = admin.tenant_id ?? admin.organization_id;
    search.initializeSearch(db);
    objectId = queryOne(db, "SELECT id FROM objects WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY id LIMIT 1", [tenantId])?.id;
  });

  after(() => {
    db?.close();
  });

  test("buildDocumentAsync matches buildDocument for a registered object", async () => {
    assert.ok(objectId, "a seeded object is required");
    const syncDoc = search.buildDocument(db, "object", objectId, { tenantId });
    const asyncDoc = await search.buildDocumentAsync(db, "object", objectId, { tenantId });
    assert.deepEqual(asyncDoc, syncDoc);
  });

  test("applyIndexChangeAsync upserts the same index row as the sync engine", async () => {
    const syncResult = search.applyIndexChange(db, { tenantId, objectType: "object", objectId, operation: "upsert", reason: "test" });
    const asyncResult = await search.applyIndexChangeAsync(db, { tenantId, objectType: "object", objectId, operation: "upsert", reason: "test" });
    assert.equal(syncResult.indexed, true);
    assert.equal(asyncResult.indexed, true);
    assert.equal(asyncResult.document.object_id, String(objectId));
    const row = queryOne(db, "SELECT * FROM search_index WHERE tenant_id = ? AND object_type = 'object' AND object_id = ?", [tenantId, String(objectId)]);
    assert.ok(row, "index row was written");
    assert.equal(row.object_id, String(objectId));
  });

  test("reindexTypeAsync and reindexTenantAsync index documents through async resolvers", async () => {
    const byType = await search.reindexTypeAsync(db, { tenantId, objectType: "object", limit: 200 }, admin, "test");
    assert.equal(byType.unsupported, undefined);
    assert.ok(byType.indexed >= 1, "at least one object indexed");

    const tenant = await search.reindexTenantAsync(db, { tenantId, limit: 200 }, admin, "test");
    assert.ok(tenant.types.length > 0, "tenant reindex iterated registered types");
  });

  test("rebuildIndexAsync supports full and object scopes", async () => {
    const full = await search.rebuildIndexAsync(db, { scope: "full", limit: 100 }, admin, { tenantId });
    assert.equal(full.scope, "full");
    const one = await search.rebuildIndexAsync(db, { scope: "object", object_type: "object", object_id: objectId }, admin, { tenantId });
    assert.equal(one.scope, "object");
    assert.equal(one.result.objectId, String(objectId));
  });

  test("putObjectExtractedTextAsync/removeObjectExtractedTextAsync maintain extracted text and reindex", async () => {
    const put = await search.putObjectExtractedTextAsync(
      db,
      { object_type: "object", object_id: objectId, text: "unique-async-body-token" },
      admin,
      { tenantId }
    );
    assert.equal(put.extractedText.objectType, "object");
    const text = await search.extractedTextForAsync(db, tenantId, "object", objectId);
    assert.match(text, /unique-async-body-token/);
    const reindexedDoc = await search.buildDocumentAsync(db, "object", objectId, { tenantId });
    assert.match(reindexedDoc.searchableText, /unique-async-body-token/);

    const removed = await search.removeObjectExtractedTextAsync(db, { object_type: "object", object_id: objectId }, admin, { tenantId });
    assert.equal(removed.deleted, true);
    const after = await search.extractedTextForAsync(db, tenantId, "object", objectId);
    assert.equal(after.includes("unique-async-body-token"), false);
  });

  test("indexDocumentsAsync indexes a document and reports status", async () => {
    const result = await search.indexDocumentsAsync(
      db,
      { object_type: "object", object_id: objectId, reason: "test" },
      admin,
      { tenantId }
    );
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].status, "indexed");
    assert.equal(result.indexed, 1);
  });

  test("drainIndexQueueAsync and retryIndexFailuresAsync run", async () => {
    const drain = await search.drainIndexQueueAsync(db, { tenantId, limit: 20 });
    assert.equal(typeof drain.processed, "number");
    const retry = await search.retryIndexFailuresAsync(db, { tenantId, includeDeadLetter: true }, admin, "test");
    assert.equal(typeof retry.requeued, "number");
  });

  test("pruneIndexAsync runs and reports counts", async () => {
    const result = await search.pruneIndexAsync(db, { tenantId }, admin, "test");
    assert.equal(typeof result.checked, "number");
    assert.equal(typeof result.removed, "number");
  });
});
