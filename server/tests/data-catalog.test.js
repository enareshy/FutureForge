process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as dc from "../services/data-catalog/index.js";
import { SEARCH_REGISTRATIONS } from "../services/data-catalog/search.js";
import { CONFIG_DEFAULTS } from "../services/data-catalog/constants.js";

function adminActor(db) {
  const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
  return row ? { id: row.id, username: row.username } : null;
}

describe("Data catalog foundation and seed", () => {
  let db;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
  });
  after(() => db?.close());

  test("installs the platform seams idempotently", () => {
    const eventTypes = queryOne(db, "SELECT COUNT(*) AS c FROM event_registry WHERE source_module = 'data-catalog'");
    assert.ok(Number(eventTypes.c) >= 6);
    const searchTypes = queryOne(db, "SELECT COUNT(*) AS c FROM search_object_types WHERE source_module = 'data-catalog'");
    assert.ok(Number(searchTypes.c) >= 5);
    const again = dc.ensureDataCatalogFoundation(db);
    assert.equal(again.event_types, 0);
    assert.equal(again.search_registrations, 0);
    assert.equal(again.relationship_types, 0);
    assert.equal(again.configuration, 0);
  });

  test("seeds a demonstration estate once", () => {
    const result = dc.ensureDataCatalogSeed(db);
    assert.equal(result.seeded, false);
    assert.equal(result.reason, "already_present");
    const health = dc.Foundation.catalogHealth(db, 1);
    assert.ok(health.counts.entries > 0);
    assert.ok(health.counts.objects >= 3);
    assert.ok(health.counts.terms >= 3);
    assert.ok(health.counts.lineage >= 2);
  });

  test("reports tenant-scoped metrics without leaking across tenants", () => {
    const metrics = dc.Metrics.metricsSnapshot(db, { tenantId: 1 });
    assert.ok(metrics.counters.entries > 0);
    assert.ok(metrics.governance.entries_without_owner >= 0);
    const other = dc.Metrics.metricsSnapshot(db, { tenantId: 999999 });
    assert.equal(other.counters.entries, 0);
  });

  test("registers catalog object types with the search and security engines", () => {
    assert.ok(SEARCH_REGISTRATIONS.length >= 5);
    assert.ok(SEARCH_REGISTRATIONS.every((registration) => registration.code && registration.permission_resource));
  });
});

describe("Unified catalog registry", () => {
  let db;
  let actor;
  const tenant = 1;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
  });
  after(() => db?.close());

  test("registers an entry and is idempotent for the same code", () => {
    const entry = dc.Entries.registerEntry(
      db,
      { entry_type: "OBJECT", code: "TST_REGISTRY", name: "Registry test", description: "registry", classification: "internal" },
      actor,
      tenant
    );
    assert.equal(entry.code, "TST_REGISTRY");
    assert.equal(entry.status, "active");
    const again = dc.Entries.registerEntry(db, { entry_type: "OBJECT", code: "TST_REGISTRY" }, actor, tenant);
    assert.equal(again.id, entry.id);
  });

  test("defaults an omitted status to active rather than an empty value", () => {
    const entry = dc.Entries.registerEntry(db, { entry_type: "SOURCE", code: "TST_DEFAULT_STATUS" }, actor, tenant);
    assert.equal(entry.status, "active");
    assert.equal(entry.classification, "internal");
  });

  test("filters the registry by entry type and searches by text", () => {
    const objects = dc.Entries.listEntries(db, { tenantId: tenant, entryType: "OBJECT" });
    assert.ok(objects.items.every((item) => item.entry_type === "OBJECT"));
    const search = dc.Entries.listEntries(db, { tenantId: tenant, q: "TST_REGISTRY" });
    assert.ok(search.items.some((item) => item.code === "TST_REGISTRY"));
  });

  test("appends an immutable metadata version on change", () => {
    const found = dc.Entries.listEntries(db, { tenantId: tenant, q: "TST_REGISTRY" });
    const entry = found.items[0];
    dc.Entries.commitEntryChange(db, entry.id, { change_summary: "test change", patch: { description: "updated" } }, actor);
    const versions = dc.Entries.listMetadataVersions(db, entry.id, { tenantId: tenant });
    assert.ok(versions.length >= 1);
  });

  test("never returns another tenant's entry", () => {
    dc.Entries.registerEntry(db, { entry_type: "OBJECT", code: "TST_OTHER_TENANT" }, actor, 2);
    const leaked = dc.Entries.listEntries(db, { tenantId: tenant, q: "TST_OTHER_TENANT" });
    assert.equal(leaked.total, 0);
  });
});

describe("Objects, attributes, sources and consumers", () => {
  let db;
  let actor;
  const tenant = 1;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
  });
  after(() => db?.close());

  test("creates an object with attributes and rejects a duplicate object type", () => {
    const object = dc.Objects.createCatalogObject(
      db,
      { object_type: "test_widget", display_name: "Test widget", description: "a widget", classification: "internal" },
      actor,
      tenant
    );
    assert.equal(object.object_type, "test_widget");
    assert.ok(object.entry_id);
    const attribute = dc.Objects.createAttribute(db, object.id, { attribute_name: "widget.code", display_name: "Widget code", data_type: "string", mandatory: true }, actor, tenant);
    assert.equal(attribute.attribute_name, "widget.code");
    const attributes = dc.Objects.listAttributes(db, object.id, { tenantId: tenant });
    assert.equal(attributes.length, 1);
    assert.throws(
      () => dc.Objects.createCatalogObject(db, { object_type: "test_widget" }, actor, tenant),
      /already exists/i
    );
  });

  test("never stores a URL or connection string as a source reference", () => {
    assert.throws(
      () => dc.Sources.createSource(db, { code: "TST_BAD", name: "Bad", source_type: "DATABASE", connection_reference: "https://db.example.com/secret" }, actor, tenant),
      /connection reference/i
    );
    const good = dc.Sources.createSource(db, { code: "TST_GOOD", name: "Good", source_type: "DATABASE", connection_reference: "integration/credentials/tst" }, actor, tenant);
    assert.equal(good.connection_reference, "integration/credentials/tst");
  });

  test("maps a source to a catalog object", () => {
    const object = dc.Objects.findObjectByType(db, tenant, "test_widget");
    const source = dc.Sources.findSourceByCode(db, tenant, "TST_GOOD");
    const mapping = dc.Sources.addSourceMapping(db, source.id, { target_entry_id: object.entry_id, mapping_type: "SOURCE_TO_OBJECT", source_object_ref: "st.test_widget" }, actor, tenant);
    assert.equal(mapping.mapping_type, "SOURCE_TO_OBJECT");
    const mappings = dc.Sources.listSourceMappings(db, source.id);
    assert.equal(mappings.length, 1);
  });

  test("maps a consumer to a catalog object", () => {
    const object = dc.Objects.findObjectByType(db, tenant, "test_widget");
    const consumer = dc.Consumers.createConsumer(db, { code: "TST_APP", name: "Test app", consumer_type: "APPLICATION" }, actor, tenant);
    const mapping = dc.Consumers.addConsumerMapping(db, consumer.id, { object_id: object.entry_id, purpose: "test", frequency: "daily" }, actor, tenant);
    assert.ok(mapping.id);
    const consumers = dc.Consumers.consumersForObject(db, tenant, object.id);
    assert.ok(consumers.some((row) => row.code === "TST_APP"));
  });
});

describe("Business glossary lifecycle", () => {
  let db;
  let actor;
  const tenant = 1;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
  });
  after(() => db?.close());

  test("creates a term with definitions, synonyms and custom definitions", () => {
    const term = dc.Glossary.createTerm(db, { code: "TST_GLOSSARY", name: "Test glossary term", definition: "A term for tests." }, actor, tenant);
    dc.Glossary.upsertDefinition(db, term.id, { definition_type: "TECHNICAL", definition: "technical form" }, actor, tenant);
    dc.Glossary.addSynonym(db, term.id, "test alias", actor, tenant);
    const full = dc.Glossary.getTerm(db, term.id, { tenantId: tenant });
    assert.ok(full.definitions.length >= 2);
    assert.ok(full.synonyms.some((synonym) => synonym.synonym === "test alias"));
  });

  test("drives the review and approval lifecycle", () => {
    const term = dc.Glossary.createTerm(db, { code: "TST_LIFECYCLE", name: "Lifecycle", definition: "Definition", status: "draft" }, actor, tenant);
    const submitted = dc.Glossary.submitTerm(db, term.id, { comment: "please review" }, actor, tenant);
    assert.equal(submitted.status, "in_review");
    const approved = dc.Glossary.approveTerm(db, term.id, {}, actor, tenant);
    assert.equal(approved.status, "approved");
    assert.equal(approved.approval_status, "approved");
  });

  test("rejects an illegal lifecycle transition", () => {
    const term = dc.Glossary.createTerm(db, { code: "TST_BAD_TRANSITION", name: "Bad", definition: "d", status: "draft" }, actor, tenant);
    assert.throws(() => dc.Glossary.setTermStatus(db, term.id, "approved", actor, tenant), /transition|allowed/i);
  });

  test("maps a term to a catalog object and reads it back", () => {
    const object = dc.Objects.createCatalogObject(db, { object_type: "test_gloss_map", display_name: "Glossary target" }, actor, tenant);
    const term = dc.Glossary.createTerm(db, { code: "TST_MAPPED", name: "Mapped", definition: "d" }, actor, tenant);
    const mapping = dc.Glossary.addMapping(db, term.id, { target_type: "OBJECT", target_id: object.entry_id }, actor, tenant);
    assert.equal(mapping.target_type, "OBJECT");
    const terms = dc.Glossary.termsForTarget(db, tenant, "OBJECT", object.entry_id);
    assert.ok(terms.some((row) => row.code === "TST_MAPPED"));
  });
});

describe("Lineage, classifications and ownership", () => {
  let db;
  let actor;
  let source;
  let object;
  let consumer;
  const tenant = 1;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
    object = dc.Objects.createCatalogObject(db, { object_type: "test_lineage", display_name: "Lineage object" }, actor, tenant);
    source = dc.Sources.createSource(db, { code: "TST_LINEAGE_SRC", name: "Lineage source", source_type: "APPLICATION" }, actor, tenant);
    consumer = dc.Consumers.createConsumer(db, { code: "TST_LINEAGE_CON", name: "Lineage consumer", consumer_type: "ANALYTICS" }, actor, tenant);
  });
  after(() => db?.close());

  test("traverses lineage within bounded limits", () => {
    dc.Lineage.createLineage(db, { from_type: "SOURCE", from_id: source.id, to_type: "OBJECT", to_id: String(object.entry_id), relationship_type: "SOURCE_OF" }, actor, tenant);
    dc.Lineage.createLineage(db, { from_type: "OBJECT", from_id: String(object.entry_id), to_type: "CONSUMER", to_id: String(consumer.id), relationship_type: "CONSUMED_BY" }, actor, tenant);
    const graph = dc.Lineage.lineageGraph(db, { tenantId: tenant, rootType: "OBJECT", rootId: String(object.entry_id), direction: "both", maxDepth: 3 });
    assert.equal(graph.truncated, false);
    assert.ok(graph.nodes.length >= 3);
    const impact = dc.Lineage.impact(db, { tenantId: tenant, rootType: "OBJECT", rootId: String(object.entry_id) });
    assert.equal(impact.consumer_count, 1);
    assert.ok(graph.node_limit <= 200);
    assert.ok(graph.max_depth <= 6);
  });

  test("keeps the strongest classification as the entry's effective value", () => {
    const pub = dc.Classifications.createClassification(db, { code: "TST_PUB", name: "Public", category: "business", security_classification: "public" }, actor, tenant);
    const restricted = dc.Classifications.createClassification(db, { code: "TST_RESTRICTED", name: "Restricted", category: "security", security_classification: "restricted" }, actor, tenant);
    dc.Classifications.assignClassification(db, object.entry_id, { classification_id: pub.id }, actor, tenant);
    dc.Classifications.assignClassification(db, object.entry_id, { classification_id: restricted.id }, actor, tenant);
    const entry = dc.Entries.getEntry(db, object.entry_id, { tenantId: tenant });
    assert.equal(entry.classification, "restricted");
  });

  test("reports ownership gaps and resolves accountable subjects", () => {
    const gapsBefore = dc.Ownership.ownershipGaps(db, tenant);
    assert.ok(gapsBefore.some((gap) => gap.id === object.entry_id));
    dc.Ownership.assignOwnership(db, object.entry_id, { ownership_kind: "DATA_OWNER", relationship: "owner", subject_type: "user", subject_id: actor.id, is_primary: true }, actor, tenant);
    const owners = dc.Ownership.resolveOwnership(db, { entryId: object.entry_id, relationship: "owner", tenantId: tenant });
    assert.ok(owners.some((row) => row.subject_id === actor.id));
    const gapsAfter = dc.Ownership.ownershipGaps(db, tenant);
    assert.ok(!gapsAfter.some((gap) => gap.id === object.entry_id));
  });
});

describe("Configuration, import/export and job seams", () => {
  let db;
  let actor;
  const tenant = 1;
  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    actor = adminActor(db);
  });
  after(() => db?.close());

  test("exposes tenant configuration and validates bounds", () => {
    const config = dc.Configuration.listConfig(db, tenant);
    assert.equal(config.lineage_max_depth, CONFIG_DEFAULTS.lineage_max_depth);
    dc.Configuration.setConfig(db, tenant, "lineage_max_depth", 4, actor);
    assert.equal(dc.Configuration.getConfig(db, tenant, "lineage_max_depth"), 4);
    assert.throws(() => dc.Configuration.setConfig(db, tenant, "lineage_max_depth", 0, actor), /positive integer/i);
    assert.throws(() => dc.Configuration.setConfig(db, tenant, "nope", 1, actor), /Unknown configuration key/i);
  });

  test("imports metadata through a dry run and a real run", () => {
    const dry = dc.ImportExport.importCatalog(db, { tenantId: tenant, resourceType: "sources", records: [{ code: "TST_IMPORT", name: "Imported" }], dryRun: true, actor });
    assert.equal(dry.stats.skipped, 1);
    assert.equal(dc.Sources.findSourceByCode(db, tenant, "TST_IMPORT"), null);
    const real = dc.ImportExport.importCatalog(db, { tenantId: tenant, resourceType: "sources", records: [{ code: "TST_IMPORT", name: "Imported" }], actor });
    assert.equal(real.stats.created, 1);
    assert.ok(dc.Sources.findSourceByCode(db, tenant, "TST_IMPORT"));
    assert.throws(() => dc.ImportExport.importCatalog(db, { tenantId: tenant, resourceType: "nope", records: [], actor }), /Unsupported import resource/i);
  });

  test("exports only the requested resources for the tenant", () => {
    const exported = dc.ImportExport.exportCatalog(db, { tenantId: tenant, resourceTypes: ["objects"], format: "json" });
    assert.equal(exported.record_count, exported.data.objects.length);
    assert.ok(exported.record_count >= 1);
    assert.equal(exported.data.sources, undefined);
  });

  test("exposes the catalog health check", () => {
    const health = dc.Metrics.healthCheck(db, { tenantId: tenant });
    assert.equal(health.status, "healthy");
  });
});
