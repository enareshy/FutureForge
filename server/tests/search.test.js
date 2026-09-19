import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as search from "../services/search.js";

function actorRow(db, username) {
  return queryOne(db, "SELECT * FROM users WHERE username = ?", [username]);
}

describe("Search & Discovery Framework services", () => {
  let db;
  let admin;
  let user;
  let tenantId;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    admin = actorRow(db, "admin");
    user = actorRow(db, "j.patel");
    tenantId = admin.tenant_id ?? admin.organization_id;
    search.initializeSearch(db);
    search.reindexTenant(db, { tenantId, limit: 1000 }, admin, "test");
  });

  after(() => {
    db?.close();
  });

  test("initializes default searchable object types", () => {
    const codes = search.listObjectTypes(db, { tenantId }).map((type) => type.code);
    assert.deepEqual(codes.sort(), [
      "file",
      "numbering_allocation",
      "object",
      "reference_item",
      "versioning_baseline",
      "versioning_revision",
      "versioning_snapshot",
    ]);
  });

  test("indexes business objects and returns ranked results", () => {
    const result = search.search(db, { text: "compressor" }, admin, { tenantId, recordHistory: false });
    assert.ok(result.total >= 1);
    assert.ok(result.items[0].title.toLowerCase().includes("compressor"));
    assert.equal(result.items[0].object_type, "object");
    assert.ok(result.took_ms >= 0);
  });

  test("rejects queries shorter than the configured minimum", () => {
    assert.throws(
      () => search.search(db, { text: "a" }, admin, { tenantId, recordHistory: false }),
      (err) => err.status === 400
    );
  });

  test("filters by object type and facets", () => {
    const byType = search.searchByType(db, "object", { text: "pump" }, admin, {
      tenantId,
      recordHistory: false,
    });
    assert.ok(byType.items.every((item) => item.object_type === "object"));

    const facets = search.getFacets(db, { text: "compressor" }, admin, { tenantId, recordHistory: false });
    const objectTypeFacet = facets.facets.find((facet) => facet.field === "object_type");
    assert.ok(objectTypeFacet.values.some((value) => value.value === "object"));
  });

  test("supports attribute filters and highlights matches", () => {
    const anyObject = search
      .search(db, { text: "air" }, admin, { tenantId, recordHistory: false })
      .items.find((item) => item.object_type === "object");
    assert.ok(anyObject);
    const attrName = Object.keys(anyObject.attributes)[0];
    if (attrName) {
      const value = anyObject.attributes[attrName];
      if (value !== null && typeof value !== "object") {
        const filtered = search.searchByAttributes(db, { [attrName]: value }, { text: "" }, admin, {
          tenantId,
          recordHistory: false,
        });
        assert.ok(filtered.items.length >= 1);
      }
    }
    const highlighted = search.search(db, { text: "compressor" }, admin, {
      tenantId,
      recordHistory: false,
      highlight: true,
    });
    assert.ok(highlighted.items[0].highlights.title.includes("<mark>"));
  });

  test("returns autocomplete suggestions from titles, tags and history", () => {
    search.search(db, { text: "compressor" }, admin, { tenantId, recordHistory: true });
    const suggestions = search.getSuggestions(db, { text: "comp" }, admin, { tenantId });
    assert.ok(suggestions.suggestions.some((item) => item.type === "title"));
    assert.ok(suggestions.suggestions.some((item) => item.type === "recent"));
  });

  test("records, lists and clears search history", () => {
    const before = search.listSearchHistory(db, { tenantId, actorId: admin.id }).length;
    search.search(db, { text: "pump" }, admin, { tenantId, recordHistory: true });
    const after = search.listSearchHistory(db, { tenantId, actorId: admin.id });
    assert.equal(after.length, before + 1);
    assert.equal(after[0].query, "pump");
    const cleared = search.clearSearchHistory(db, admin, tenantId);
    assert.ok(cleared.cleared >= 1);
  });

  test("creates, runs, shares and deletes saved searches", () => {
    const saved = search.createSavedSearch(
      db,
      { name: "Compressor parts", query: { text: "compressor" }, sharing_scope: "tenant" },
      admin,
      tenantId,
      "test"
    );
    assert.equal(saved.is_shared, true);

    const run = search.runSavedSearch(db, saved.uuid, { page: 1, page_size: 5 }, admin, tenantId, "test");
    assert.ok(run.total >= 1);
    assert.equal(run.saved_search.name, "Compressor parts");

    const visibleToOther = search.listSavedSearches(db, { tenantId, actorId: user.id });
    assert.ok(visibleToOther.some((item) => item.uuid === saved.uuid));

    const updated = search.updateSavedSearch(db, saved.uuid, { name: "Renamed" }, admin, tenantId, "test");
    assert.equal(updated.name, "Renamed");

    const deleted = search.deleteSavedSearch(db, saved.uuid, admin, tenantId, "test");
    assert.equal(deleted.deleted, true);
  });

  test("updates per-tenant search configuration", () => {
    const initial = search.getConfiguration(db, tenantId);
    assert.equal(initial.enabled, true);
    const updated = search.updateConfiguration(
      db,
      tenantId,
      { page_size: 30, min_query_length: 3, excluded_types: [] },
      admin,
      "test"
    );
    assert.equal(updated.page_size, 30);
    assert.equal(updated.min_query_length, 3);
    search.updateConfiguration(db, tenantId, { page_size: 20, min_query_length: 2 }, admin, "test");
  });

  test("exposes indexing status and failure retry", () => {
    const status = search.indexingStatus(db, { tenantId });
    assert.ok(status.documents_total >= 1);
    assert.ok(status.documents_by_type.some((row) => row.object_type === "object"));
    const retried = search.retryIndexFailures(db, { tenantId }, admin, "test");
    assert.ok(retried.requeued >= 0);
  });

  test("requests and materialises a search export", () => {
    const request = search.requestExport(
      db,
      { name: "Compressor export", format: "json", query: { text: "compressor" } },
      admin,
      tenantId,
      "test"
    );
    assert.equal(request.status, "pending");
    const completed = search.runExport(db, request.id);
    assert.equal(completed.status, "completed");
    assert.ok(completed.row_count >= 1);
    const withContent = search.getExport(db, request.uuid, admin, tenantId, { includeContent: true });
    assert.match(withContent.content, /compressor/i);
  });

  test("reports search metrics and health", () => {
    const metrics = search.searchMetrics(db, { tenantId });
    assert.ok(metrics.searches.total >= 1);
    const health = search.searchHealth(db);
    assert.ok(health.registered_object_types >= 2);
    assert.ok(health.source_resolvers.includes("object"));
  });

  test("supports relationship-aware search", () => {
    const relationships = db.prepare("SELECT * FROM object_relationships WHERE deleted_at IS NULL LIMIT 1").all();
    if (!relationships.length) return;
    const edge = relationships[0];
    search.reindexObject(db, { tenantId, objectType: "object", objectId: edge.source_object_id }, admin, "test");
    const related = search.searchByRelationship(
      db,
      { object_type: "object", object_id: edge.source_object_id, direction: "out" },
      { text: "" },
      admin,
      { tenantId, recordHistory: false }
    );
    assert.ok(related.items.some((item) => String(item.object_id) === String(edge.target_object_id)));
  });
});
