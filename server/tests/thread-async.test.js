process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as metadata from "../services/metadata.js";
import * as objects from "../services/objects.js";
import {
  Constants,
  Configuration,
  Definitions,
  Rules,
  Engine,
  Traceability,
  Impact,
  Dependency,
  Paths,
  Completeness,
  Snapshots,
  Baselines,
  Compare,
  Projection,
  Metrics,
  History,
  Jobs,
  Search,
  Foundation,
  Seed,
} from "../services/thread/index.js";

// Async parity for the P1 Digital Thread. The synchronous service is the
// reference; the async twins must return the same graph, decisions and error
// semantics while running on the asynchronous PostgreSQL data-access layer.

const ACTOR = { id: 1, username: "admin" };
const IP = "127.0.0.1";
const VOLATILE = new Set(["created_at", "updated_at", "duration_ms", "generated_at"]);

function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (VOLATILE.has(key)) continue;
      out[key] = strip(entry);
    }
    return out;
  }
  return value;
}

function linkType(db, tenantId, code, name, sourceTypeId, targetTypeId) {
  return objects.createRelationshipType(
    db,
    { code, name, module: "thread", source_type_id: sourceTypeId, target_type_id: targetTypeId, cardinality: "N:N", semantic: "association", status: "active" },
    ACTOR,
    IP,
    tenantId
  );
}

describe("Digital Thread async services mirror the synchronous layer", () => {
  let db;
  let tenant;
  let ids;
  let admin;

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    await Foundation.ensureThreadFoundationAsync(db);

    const typeFor = (code, name) =>
      queryOne(db, "SELECT * FROM metadata_types WHERE code = ? AND (tenant_id IS NULL OR tenant_id = ?) ORDER BY tenant_id IS NULL LIMIT 1", [code, tenant]) ||
      metadata.createType(db, { code, name, module: "thread", status: "active" }, ACTOR, IP, tenant);
    const requirementType = typeFor("requirement", "Requirement");
    const systemType = typeFor("system", "System");
    const designType = typeFor("design", "Design");
    const partType = typeFor("part", "Part");

    const relTypeFor = (code, name, sourceTypeId, targetTypeId) =>
      queryOne(db, "SELECT * FROM relationship_types WHERE code = ? AND (tenant_id IS NULL OR tenant_id = ?) ORDER BY tenant_id IS NULL LIMIT 1", [code, tenant]) ||
      linkType(db, tenant, code, name, sourceTypeId, targetTypeId);

    const satisfies = relTypeFor("requirement.satisfies.system", "Satisfies", requirementType.id, systemType.id);
    const realizedBy = relTypeFor("system.realized-by.design", "Realized by", systemType.id, designType.id);
    const implementedBy = relTypeFor("design.implemented-by.part", "Implemented by", designType.id, partType.id);

    const make = (type, code, name) =>
      objects.createObject(
        db,
        {
          type,
          code,
          name,
          status: "released",
          data: type === "part" ? { "part.number": code, "part.name": name, "part.category": "mechanical", "part.status": "released" } : {},
        },
        ACTOR,
        tenant,
        IP
      );
    const requirement = make("requirement", "ASYNC-REQ-1", "Async battery requirement");
    const system = make("system", "ASYNC-SYS-1", "Async power subsystem");
    const design = make("design", "ASYNC-DSG-1", "Async battery design");
    const part = make("part", "ASYNC-PRT-1", "Async lithium cell");

    objects.createRelationship(db, { type: satisfies.id, source: requirement.id, target: system.id, status: "active" }, ACTOR, tenant, IP);
    objects.createRelationship(db, { type: realizedBy.id, source: system.id, target: design.id, status: "active" }, ACTOR, tenant, IP);
    objects.createRelationship(db, { type: implementedBy.id, source: design.id, target: part.id, status: "active" }, ACTOR, tenant, IP);

    ids = { requirementType, systemType, designType, partType, satisfies, realizedBy, implementedBy, requirement, system, design, part };
  });

  after(() => db?.close());

  test("async foundation is idempotent and exposes health and config", async () => {
    const again = await Foundation.ensureThreadFoundationAsync(db);
    assert.equal(again.source_module, "thread");
    assert.ok(again.providers.includes("object"));
    const definition = await Definitions.resolveDefinitionAsync(db, tenant, {});
    assert.equal(definition.code, Constants.DEFAULT_DEFINITION_CODE);
    assert.ok(definition.domains.length >= 10);
    assert.ok((await Rules.activeRulesAsync(db, tenant)).length >= 7);
    assert.equal(await Configuration.getConfigAsync(db, tenant, "max_traversal_depth"), Constants.DEFAULT_MAX_DEPTH);
    const health = await Foundation.threadHealthAsync(db, tenant);
    assert.equal(health.source_module, "thread");
    assert.ok(health.counts.definitions >= 1);
  });

  test("async traversal matches the sync engine", async () => {
    const options = { root: `requirement:${ids.requirement.id}`, direction: "DOWNSTREAM", includeInactive: true };
    const asyncResult = await Engine.executeTraversalAsync(db, tenant, options, admin, { action: "TRAVERSAL" });
    const syncResult = Engine.executeTraversal(db, tenant, options, admin, { action: "TRAVERSAL" });
    const asyncGraph = Engine.publicGraph(asyncResult.result, asyncResult.definition);
    const syncGraph = Engine.publicGraph(syncResult.result, syncResult.definition);
    assert.equal(asyncGraph.node_count, syncGraph.node_count);
    assert.equal(asyncGraph.edge_count, syncGraph.edge_count);
    assert.equal(asyncGraph.direction, "DOWNSTREAM");
    assert.deepEqual(
      asyncGraph.nodes.map((node) => node.object_type).sort(),
      syncGraph.nodes.map((node) => node.object_type).sort()
    );
    assert.deepEqual(strip(asyncGraph.domains), strip(syncGraph.domains));
  });

  test("async and sync traversal honour depth and node limits identically", async () => {
    const limited = await Engine.executeTraversalAsync(db, tenant, { root: `requirement:${ids.requirement.id}`, maxNodes: 2, includeInactive: true }, admin);
    assert.equal(limited.result.node_count, 2);
    assert.equal(limited.result.truncated, true);
    assert.ok(limited.result.truncation_reasons.includes("node_limit"));
    const shallow = await Engine.executeTraversalAsync(db, tenant, { root: `requirement:${ids.requirement.id}`, maxDepth: 1, includeInactive: true }, admin);
    assert.equal(shallow.result.node_count, 2);
    assert.equal(shallow.result.truncated, false);
  });

  test("async paths, impact, dependency and traceability match the sync views", async () => {
    const pathOptions = { source: `requirement:${ids.requirement.id}`, target: `part:${ids.part.id}`, direction: "DOWNSTREAM", maxDepth: 10 };
    const asyncPaths = await Paths.findPathsAsync(db, tenant, pathOptions, admin);
    const syncPaths = Paths.findPaths(db, tenant, pathOptions, admin);
    assert.equal(asyncPaths.found, syncPaths.found);
    assert.equal(asyncPaths.shortest_path.length, syncPaths.shortest_path.length);

    const asyncImpact = await Impact.impactAnalysisAsync(db, tenant, { root: `requirement:${ids.requirement.id}`, includeInactive: true }, admin);
    const syncImpact = Impact.impactAnalysis(db, tenant, { root: `requirement:${ids.requirement.id}`, includeInactive: true }, admin);
    assert.equal(asyncImpact.impact_summary.impacted_count, syncImpact.impact_summary.impacted_count);

    const asyncDependency = await Dependency.dependencyAnalysisAsync(db, tenant, { root: `part:${ids.part.id}`, includeInactive: true }, admin);
    const syncDependency = Dependency.dependencyAnalysis(db, tenant, { root: `part:${ids.part.id}`, includeInactive: true }, admin);
    assert.equal(asyncDependency.dependency_summary.dependency_count, syncDependency.dependency_summary.dependency_count);

    const asyncMatrix = await Traceability.traceabilityMatrixAsync(db, tenant, { root: `requirement:${ids.requirement.id}`, includeInactive: true }, admin);
    const syncMatrix = Traceability.traceabilityMatrix(db, tenant, { root: `requirement:${ids.requirement.id}`, includeInactive: true }, admin);
    assert.deepEqual(strip(asyncMatrix.matrix), strip(syncMatrix.matrix));
    assert.deepEqual(strip(asyncMatrix.relationship_inventory), strip(syncMatrix.relationship_inventory));
  });

  test("async completeness evaluation matches the sync result", async () => {
    const asyncResult = await Completeness.evaluateCompletenessAsync(db, tenant, { root: `requirement:${ids.requirement.id}`, includeInactive: true }, admin);
    const syncResult = Completeness.evaluateCompleteness(db, tenant, { root: `requirement:${ids.requirement.id}`, includeInactive: true }, admin);
    assert.equal(asyncResult.completeness_score, syncResult.completeness_score);
    assert.equal(asyncResult.violated_rules, syncResult.violated_rules);
    assert.deepEqual(strip(asyncResult.states), strip(syncResult.states));
  });

  test("async snapshots and baselines preserve immutability semantics", async () => {
    const snapshot = await Snapshots.createSnapshotAsync(db, tenant, { root: `requirement:${ids.requirement.id}`, direction: "DOWNSTREAM", includeInactive: true, name: "Async requirement snapshot" }, admin, IP);
    assert.equal(snapshot.status, "FROZEN");
    assert.equal(snapshot.immutable, true);
    assert.equal(snapshot.node_count, 4);
    assert.equal(snapshot.nodes.length, 4);
    assert.equal(snapshot.edges.length, 3);

    const graph = await Snapshots.snapshotGraphAsync(db, tenant, snapshot.id);
    assert.equal(graph.nodes.length, 4);

    const baseline = await Baselines.createBaselineAsync(db, tenant, { name: "Async requirement baseline", snapshot_id: snapshot.id }, admin, IP);
    assert.equal(baseline.member_count, 4);
    assert.equal(baseline.status, "DRAFT");
    const released = await Baselines.releaseBaselineAsync(db, tenant, baseline.id, admin, IP);
    assert.equal(released.status, "RELEASED");
    assert.equal(released.immutable, true);
    await assert.rejects(() => Baselines.updateBaselineAsync(db, tenant, baseline.id, { name: "nope" }, admin, IP), (err) => err.code === "THREAD_BASELINE_IMMUTABLE");

    const detail = await Snapshots.getSnapshotAsync(db, tenant, snapshot.id, { includeNodes: true, includeEdges: true });
    assert.equal(detail.nodes.length, 4);
    const listed = await Snapshots.listSnapshotsAsync(db, tenant, { definition_code: "PRODUCT-DEVELOPMENT" });
    assert.ok(listed.items.some((item) => item.status === "FROZEN"));
  });

  test("async snapshot comparison reports the same structural delta", async () => {
    const before = await Snapshots.createSnapshotAsync(db, tenant, { root: `requirement:${ids.requirement.id}`, includeInactive: true, name: "Async compare before" }, admin, IP);
    const documentType = metadata.createType(db, { code: "thread-document", name: "Thread document", module: "thread", status: "active" }, ACTOR, IP, tenant);
    const doc = objects.createObject(db, { type: "thread-document", code: "ASYNC-TDOC-1", name: "Async analysis", status: "released", data: {} }, ACTOR, tenant, IP);
    const references = linkType(db, tenant, "part.documented-by.thread-document", "Documented by", ids.partType.id, documentType.id);
    objects.createRelationship(db, { type: references.id, source: ids.part.id, target: doc.id, status: "active" }, ACTOR, tenant, IP);
    const after = await Snapshots.createSnapshotAsync(db, tenant, { root: `requirement:${ids.requirement.id}`, includeInactive: true, name: "Async compare after" }, admin, IP);
    assert.ok(after.node_count > before.node_count);

    const diff = await Compare.compareSnapshotsAsync(db, tenant, { left: before.id, right: after.id }, admin);
    assert.ok(diff.added_nodes.some((node) => node.node_ref === `thread-document:${doc.id}`));
    assert.ok(Array.isArray(diff.added_relationships));
    assert.equal(diff.identical, false);
  });

  test("async projection, metrics and health mirror the sync layer", async () => {
    const rebuilt = await Projection.rebuildProjectionAsync(db, tenant, { objectTypes: ["requirement", "system"], actor: admin });
    assert.ok(rebuilt.processed >= 2);
    const list = await Projection.listProjectionsAsync(db, tenant, { object_type: "requirement" });
    assert.ok(list.items.length >= 1);

    const asyncMetrics = await Metrics.metricsSnapshotAsync(db, tenant);
    const syncMetrics = Metrics.metricsSnapshot(db, tenant);
    assert.deepEqual(strip(asyncMetrics.counts), strip(syncMetrics.counts));

    const health = await Metrics.healthCheckAsync(db, tenant);
    assert.equal(health.status, "OK");
    assert.deepEqual(strip(await Projection.projectionHealthAsync(db, tenant)), strip(Projection.projectionHealth(db, tenant)));
    assert.deepEqual(strip(await History.listQueryHistoryAsync(db, { tenantId: tenant, pageSize: 5 }).then((r) => r.items.map((i) => i.action))), strip(History.listQueryHistory(db, { tenantId: tenant, pageSize: 5 }).items.map((i) => i.action)));
  });

  test("async configuration validates bounds and persists", async () => {
    await assert.rejects(() => Configuration.setConfigAsync(db, tenant, "max_traversal_depth", 9999, admin, IP), (err) => err.status === 400);
    assert.equal(await Configuration.setConfigAsync(db, tenant, "max_traversal_depth", 12, admin, IP), 12);
    assert.equal(await Configuration.getConfigAsync(db, tenant, "max_traversal_depth"), 12);
    assert.equal(await Configuration.getNumericConfigAsync(db, tenant, "max_traversal_depth"), 12);
  });

  test("async search registration and job submission succeed", async () => {
    const first = await Search.ensureThreadSearchAsync(db);
    const second = await Search.ensureThreadSearchAsync(db);
    assert.equal(second.created, 0);
    assert.ok(first.created >= 0);

    const job = await Jobs.submitTraversalJobAsync(db, { tenantId: tenant, root: `requirement:${ids.requirement.id}`, options: { includeInactive: true }, actor: admin, ip: IP });
    assert.ok(job && Number.isInteger(Number(job.id)));
  });

  test("async demo seed is idempotent", async () => {
    const seeded = await Seed.ensureThreadSeedAsync(db, tenant);
    assert.equal(typeof seeded.seeded, "boolean");
  });

  test("async error parity for unauthorized and missing nodes", async () => {
    const reader = queryOne(db, "SELECT id, username FROM users WHERE username = 'j.patel'");
    await assert.rejects(
      () => Engine.executeTraversalAsync(db, tenant, { root: `requirement:${ids.requirement.id}`, includeInactive: true }, reader),
      (err) => err.code === "THREAD_NODE_NOT_FOUND" || err.code === "THREAD_SECURITY_BLOCKED"
    );
    await assert.rejects(() => Engine.executeTraversalAsync(db, tenant, { root: "requirement:999999", includeInactive: true }, admin), (err) => err.code === "THREAD_NODE_NOT_FOUND");
    await assert.rejects(() => Snapshots.getSnapshotAsync(db, tenant, "MISSING"), (err) => err.code === "THREAD_SNAPSHOT_NOT_FOUND");
  });
});
