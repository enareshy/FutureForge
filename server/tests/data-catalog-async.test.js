process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import {
  Entries,
  Objects,
  Sources,
  Consumers,
  Lineage,
  Relationships,
  Classifications,
  Ownership,
  Configuration,
  ImportExport,
  Metrics,
  Jobs,
  Glossary,
  Foundation,
} from "../services/data-catalog/index.js";

// Async parity for the P2 Data Catalog + Business Glossary module. The
// synchronous service is the reference; async read twins must return the same
// data and async write twins must mirror the same semantics.

const VOLATILE = new Set([
  "created_at",
  "updated_at",
  "generated_at",
  "assigned_at",
  "effective_date",
  "obsolete_date",
  "last_seen_at",
]);

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (VOLATILE.has(key)) continue;
      out[key] = normalize(entry);
    }
    return out;
  }
  return value;
}

describe("async data-catalog twins mirror the synchronous service", () => {
  let db;
  let tenant;
  let actor;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    Foundation.ensureCatalogFoundation(db);
  });

  after(() => db?.close());

  test("entry registry: register, read, list and versions", async () => {
    const asyncEntry = await Entries.registerEntryAsync(
      db,
      { entry_type: "OBJECT", code: "P2_ENTRY_A", name: "Async entry", description: "async" },
      actor,
      tenant
    );
    const syncEntry = Entries.registerEntry(
      db,
      { entry_type: "OBJECT", code: "P2_ENTRY_S", name: "Sync entry", description: "sync" },
      actor,
      tenant
    );
    for (const field of ["entry_type", "status", "classification"]) {
      assert.equal(asyncEntry[field], syncEntry[field], `entry field mismatch: ${field}`);
    }
    assert.equal(asyncEntry.code, "P2_ENTRY_A");

    assert.deepEqual(
      normalize(await Entries.getEntryAsync(db, asyncEntry.id, { tenantId: tenant })),
      normalize(Entries.getEntry(db, asyncEntry.id, { tenantId: tenant }))
    );

    await Entries.commitEntryChangeAsync(db, asyncEntry.id, { change_summary: "async change", patch: { description: "changed" } }, actor);
    assert.ok((await Entries.listMetadataVersionsAsync(db, asyncEntry.id, { tenantId: tenant })).length >= 1);

    const asyncList = await Entries.listEntriesAsync(db, { tenantId: tenant, q: "P2_ENTRY_A" });
    const syncList = Entries.listEntries(db, { tenantId: tenant, q: "P2_ENTRY_A" });
    assert.equal(asyncList.total, syncList.total);
  });

  test("objects and attributes write/read parity", async () => {
    const asyncObj = await Objects.createCatalogObjectAsync(db, { object_type: "p2_async_widget", display_name: "Async widget" }, actor, tenant);
    const syncObj = Objects.createCatalogObject(db, { object_type: "p2_sync_widget", display_name: "Sync widget" }, actor, tenant);
    assert.ok(asyncObj.entry_id && syncObj.entry_id);

    const asyncAttr = await Objects.createAttributeAsync(db, asyncObj.id, { attribute_name: "widget.code", display_name: "Widget code", data_type: "string" }, actor, tenant);
    assert.equal(asyncAttr.attribute_name, "widget.code");
    const syncAttr = Objects.createAttribute(db, syncObj.id, { attribute_name: "widget.code", display_name: "Widget code", data_type: "string" }, actor, tenant);
    for (const field of ["attribute_name", "data_type", "mandatory", "status"]) {
      assert.equal(asyncAttr[field], syncAttr[field], `attribute field mismatch: ${field}`);
    }

    assert.deepEqual(
      normalize(await Objects.listAttributesAsync(db, asyncObj.id, { tenantId: tenant })),
      normalize(Objects.listAttributes(db, asyncObj.id, { tenantId: tenant }))
    );
    assert.equal((await Objects.requireAttributeAsync(db, asyncAttr.id, tenant)).id, asyncAttr.id);

    const updated = await Objects.updateAttributeAsync(db, asyncAttr.id, { display_name: "Renamed" }, actor, tenant);
    assert.equal(updated.display_name, "Renamed");
    assert.deepEqual(
      normalize(await Objects.listObjectsAsync(db, { tenantId: tenant, objectType: "p2_async_widget" })),
      normalize(Objects.listObjects(db, { tenantId: tenant, objectType: "p2_async_widget" }))
    );
  });

  test("sources and consumers mapping parity", async () => {
    const obj = await Objects.createCatalogObjectAsync(db, { object_type: "p2_map_target", display_name: "Map target" }, actor, tenant);
    const source = await Sources.createSourceAsync(db, { code: "P2_SRC", name: "Async source", source_type: "DATABASE", connection_reference: "integration/credentials/p2" }, actor, tenant);
    assert.ok(await Sources.findSourceByCodeAsync(db, tenant, "P2_SRC"));
    const mapping = await Sources.addSourceMappingAsync(db, source.id, { target_entry_id: obj.entry_id, mapping_type: "SOURCE_TO_OBJECT", source_object_ref: "st.p2" }, actor, tenant);
    assert.equal(mapping.mapping_type, "SOURCE_TO_OBJECT");
    assert.deepEqual(
      normalize(await Sources.listSourceMappingsAsync(db, source.id)),
      normalize(Sources.listSourceMappings(db, source.id))
    );
    assert.equal((await Sources.updateSourceMappingAsync(db, mapping.id, { mapping_type: "SOURCE_TO_OBJECT" }, actor, tenant)).id, mapping.id);

    const consumer = await Consumers.createConsumerAsync(db, { code: "P2_CON", name: "Async consumer", consumer_type: "APPLICATION" }, actor, tenant);
    await Consumers.addConsumerMappingAsync(db, consumer.id, { object_id: obj.entry_id, purpose: "test", frequency: "daily" }, actor, tenant);
    assert.deepEqual(
      normalize(await Consumers.listConsumerMappingsAsync(db, consumer.id)),
      normalize(Consumers.listConsumerMappings(db, consumer.id))
    );
    const forObject = await Consumers.consumersForObjectAsync(db, tenant, obj.id);
    assert.ok(forObject.some((row) => row.code === "P2_CON"));

    const asyncSource = await Sources.createSourceAsync(db, { code: "P2_SRC_DEL", name: "Deletable" }, actor, tenant);
    const delMapping = await Sources.addSourceMappingAsync(db, asyncSource.id, { target_entry_id: obj.entry_id, mapping_type: "SOURCE_TO_OBJECT" }, actor, tenant);
    assert.equal((await Sources.removeSourceMappingAsync(db, delMapping.id, actor, tenant)).deleted, true);
  });

  test("lineage graph, impact and traversal parity", async () => {
    const obj = await Objects.createCatalogObjectAsync(db, { object_type: "p2_lineage", display_name: "Lineage" }, actor, tenant);
    const source = await Sources.createSourceAsync(db, { code: "P2_LIN_SRC", name: "Lineage source", source_type: "APPLICATION" }, actor, tenant);
    const consumer = await Consumers.createConsumerAsync(db, { code: "P2_LIN_CON", name: "Lineage consumer", consumer_type: "ANALYTICS" }, actor, tenant);
    await Lineage.createLineageAsync(db, { from_type: "SOURCE", from_id: source.id, to_type: "OBJECT", to_id: String(obj.entry_id), relationship_type: "SOURCE_OF" }, actor, tenant);
    await Lineage.createLineageAsync(db, { from_type: "OBJECT", from_id: String(obj.entry_id), to_type: "CONSUMER", to_id: String(consumer.id), relationship_type: "CONSUMED_BY" }, actor, tenant);

    const asyncGraph = await Lineage.lineageGraphAsync(db, { tenantId: tenant, rootType: "OBJECT", rootId: String(obj.entry_id), direction: "both", maxDepth: 3 });
    const syncGraph = Lineage.lineageGraph(db, { tenantId: tenant, rootType: "OBJECT", rootId: String(obj.entry_id), direction: "both", maxDepth: 3 });
    assert.equal(asyncGraph.nodes.length, syncGraph.nodes.length);

    const asyncImpact = await Lineage.impactAsync(db, { tenantId: tenant, rootType: "OBJECT", rootId: String(obj.entry_id) });
    const syncImpact = Lineage.impact(db, { tenantId: tenant, rootType: "OBJECT", rootId: String(obj.entry_id) });
    assert.equal(asyncImpact.consumer_count, syncImpact.consumer_count);
    assert.deepEqual(normalize(asyncImpact), normalize(syncImpact));
  });

  test("relationships and relationship types parity", async () => {
    const a = await Objects.createCatalogObjectAsync(db, { object_type: "p2_rel_a", display_name: "Rel A" }, actor, tenant);
    const b = await Objects.createCatalogObjectAsync(db, { object_type: "p2_rel_b", display_name: "Rel B" }, actor, tenant);
    const type = await Relationships.createRelationshipTypeAsync(db, { code: "P2_REL_TYPE", name: "Async rel type" }, actor, tenant);
    assert.ok(type.id);
    const rel = await Relationships.createRelationshipAsync(db, { from_entry_id: a.entry_id, to_entry_id: b.entry_id, relationship_type: "P2_REL_TYPE" }, actor, tenant);
    assert.ok(rel.id);
    assert.deepEqual(
      normalize(await Relationships.listRelationshipTypesAsync(db, { tenantId: tenant })),
      normalize(Relationships.listRelationshipTypes(db, { tenantId: tenant }))
    );
    assert.deepEqual(
      normalize(await Relationships.listRelationshipsAsync(db, { tenantId: tenant, entryId: a.entry_id })),
      normalize(Relationships.listRelationships(db, { tenantId: tenant, entryId: a.entry_id }))
    );
    assert.equal((await Relationships.removeRelationshipAsync(db, rel.id, actor, tenant)).deleted, true);
  });

  test("classifications and ownership parity", async () => {
    const obj = await Objects.createCatalogObjectAsync(db, { object_type: "p2_class", display_name: "Classified" }, actor, tenant);
    const asyncClass = await Classifications.createClassificationAsync(db, { code: "P2_CLS_A", name: "Async class", category: "security", security_classification: "restricted" }, actor, tenant);
    const syncClass = Classifications.createClassification(db, { code: "P2_CLS_S", name: "Sync class", category: "business", security_classification: "public" }, actor, tenant);
    for (const field of ["status"]) {
      assert.equal(asyncClass[field], syncClass[field], `classification field mismatch: ${field}`);
    }
    assert.equal(asyncClass.security_classification, "restricted");
    assert.equal(syncClass.security_classification, "public");
    await Classifications.assignClassificationAsync(db, obj.entry_id, { classification_id: asyncClass.id }, actor, tenant);
    assert.deepEqual(
      normalize(await Classifications.classificationsForEntryAsync(db, obj.entry_id, tenant)),
      normalize(Classifications.classificationsForEntry(db, obj.entry_id, tenant))
    );

    await Ownership.assignOwnershipAsync(db, obj.entry_id, { ownership_kind: "DATA_OWNER", relationship: "owner", subject_type: "user", subject_id: actor.id, is_primary: true }, actor, tenant);
    const asyncOwners = await Ownership.resolveOwnershipAsync(db, { entryId: obj.entry_id, relationship: "owner", tenantId: tenant });
    const syncOwners = Ownership.resolveOwnership(db, { entryId: obj.entry_id, relationship: "owner", tenantId: tenant });
    assert.equal(asyncOwners.length, syncOwners.length);
    assert.deepEqual(
      normalize(await Ownership.ownershipGapsAsync(db, tenant)),
      normalize(Ownership.ownershipGaps(db, tenant))
    );
  });

  test("glossary lifecycle and mappings parity", async () => {
    const term = await Glossary.createTermAsync(db, { code: "P2_TERM", name: "Async term", definition: "A term" }, actor, tenant);
    assert.ok(term.id);
    await Glossary.upsertDefinitionAsync(db, term.id, { definition_type: "TECHNICAL", definition: "tech" }, actor, tenant);
    await Glossary.addSynonymAsync(db, term.id, "p2 alias", actor, tenant);
    assert.deepEqual(
      normalize(await Glossary.listTermSynonymsAsync(db, term.id)),
      normalize(Glossary.listTermSynonyms(db, term.id))
    );
    assert.deepEqual(
      normalize(await Glossary.listTermDefinitionsAsync(db, term.id)),
      normalize(Glossary.listTermDefinitions(db, term.id))
    );

    const submitted = await Glossary.submitTermAsync(db, term.id, { comment: "review" }, actor, tenant);
    assert.equal(submitted.status, "in_review");
    const approved = await Glossary.approveTermAsync(db, term.id, {}, actor, tenant);
    assert.equal(approved.status, "approved");

    const target = await Objects.createCatalogObjectAsync(db, { object_type: "p2_gloss_map", display_name: "Gloss target" }, actor, tenant);
    await Glossary.addMappingAsync(db, term.id, { target_type: "OBJECT", target_id: target.entry_id }, actor, tenant);
    assert.deepEqual(
      normalize(await Glossary.termsForTargetAsync(db, tenant, "OBJECT", target.entry_id)),
      normalize(Glossary.termsForTarget(db, tenant, "OBJECT", target.entry_id))
    );
    assert.deepEqual(
      normalize(await Glossary.glossarySnapshotAsync(db, tenant)),
      normalize(Glossary.glossarySnapshot(db, tenant))
    );
  });

  test("configuration, import/export and metrics parity", async () => {
    assert.deepEqual(await Configuration.listConfigAsync(db, tenant), Configuration.listConfig(db, tenant));
    assert.equal(await Configuration.getConfigAsync(db, tenant, "lineage_max_depth"), Configuration.getConfig(db, tenant, "lineage_max_depth"));
    const set = await Configuration.setConfigAsync(db, tenant, "lineage_max_depth", 4, actor);
    assert.equal(set, 4);
    assert.equal(await Configuration.getConfigAsync(db, tenant, "lineage_max_depth"), 4);

    const dry = await ImportExport.importCatalogAsync(db, { tenantId: tenant, resourceType: "sources", records: [{ code: "P2_IMPORT", name: "Imported" }], dryRun: true, actor });
    assert.equal(dry.stats.skipped, 1);
    const real = await ImportExport.importCatalogAsync(db, { tenantId: tenant, resourceType: "sources", records: [{ code: "P2_IMPORT", name: "Imported" }], actor });
    assert.equal(real.stats.created, 1);
    assert.ok(await Sources.findSourceByCodeAsync(db, tenant, "P2_IMPORT"));

    const exported = await ImportExport.exportCatalogAsync(db, { tenantId: tenant, resourceTypes: ["objects"], format: "json" });
    assert.equal(exported.record_count, exported.data.objects.length);

    assert.deepEqual(normalize(await Metrics.metricsSnapshotAsync(db, { tenantId: tenant })), normalize(Metrics.metricsSnapshot(db, { tenantId: tenant })));
    assert.deepEqual(normalize(await Metrics.healthCheckAsync(db, { tenantId: tenant })), normalize(Metrics.healthCheck(db, { tenantId: tenant })));
    assert.deepEqual(normalize(await Foundation.catalogHealthAsync(db, tenant)), normalize(Foundation.catalogHealth(db, tenant)));

    const asyncJob = await Jobs.submitCatalogImportAsync(db, { tenantId: tenant, resourceType: "sources", records: [], actor });
    assert.ok(asyncJob && Number.isInteger(Number(asyncJob.id)));
    assert.deepEqual(
      normalize(await Jobs.listCatalogJobsAsync(db, { tenantId: tenant })),
      normalize(Jobs.listCatalogJobs(db, { tenantId: tenant }))
    );
  });

  test("async error parity for missing entities", async () => {
    await assert.rejects(() => Entries.getEntryAsync(db, "NOPE", { tenantId: tenant }), /not found/i);
    assert.throws(() => Entries.getEntry(db, "NOPE", { tenantId: tenant }), /not found/i);
    await assert.rejects(() => Objects.getObjectAsync(db, "NOPE", { tenantId: tenant }), /not found/i);
    await assert.rejects(() => Glossary.getTermAsync(db, "NOPE", { tenantId: tenant }), /not found/i);
    await assert.rejects(() => Configuration.setConfigAsync(db, tenant, "nope", 1, actor), /Unknown configuration key/i);
  });
});
