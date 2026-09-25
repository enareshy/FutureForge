process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne } from "../db.js";
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
  Foundation,
  ensureThreadFoundation,
} from "../services/thread/index.js";

const ACTOR = { id: 1, username: "admin" };
const READER = { id: null, username: "j.patel" };
const IP = "127.0.0.1";

function linkType(db, tenantId, code, name, sourceTypeId, targetTypeId) {
  return objects.createRelationshipType(
    db,
    {
      code,
      name,
      module: "thread",
      source_type_id: sourceTypeId,
      target_type_id: targetTypeId,
      cardinality: "N:N",
      semantic: "association",
      status: "active",
    },
    ACTOR,
    IP,
    tenantId
  );
}

describe("Digital Thread core services", () => {
  let db;
  let tenant;
  let ids;
  let admin;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    ensureThreadFoundation(db);

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
    const requirement = make("requirement", "REQ-1", "Battery must last 10 hours");
    const system = make("system", "SYS-1", "Power subsystem");
    const design = make("design", "DSG-1", "Battery pack design");
    const part = make("part", "PRT-1", "Lithium cell");

    objects.createRelationship(db, { type: satisfies.id, source: requirement.id, target: system.id, status: "active" }, ACTOR, tenant, IP);
    objects.createRelationship(db, { type: realizedBy.id, source: system.id, target: design.id, status: "active" }, ACTOR, tenant, IP);
    objects.createRelationship(db, { type: implementedBy.id, source: design.id, target: part.id, status: "active" }, ACTOR, tenant, IP);

    ids = { requirementType, systemType, designType, partType, satisfies, realizedBy, implementedBy, requirement, system, design, part };
  });

  after(() => {
    db?.close();
  });

  test("foundation installs providers, event/job types, definition and rules idempotently", () => {
    const again = ensureThreadFoundation(db);
    assert.equal(again.source_module, "thread");
    assert.ok(again.providers.includes("object"));
    assert.ok(again.providers.includes("pdm"));
    assert.ok(again.providers.includes("bom"));
    const definition = Definitions.resolveDefinition(db, tenant, {});
    assert.equal(definition.code, Constants.DEFAULT_DEFINITION_CODE);
    assert.ok(definition.domains.length >= 10);
    assert.ok(Rules.activeRules(db, tenant).length >= 7);
    assert.equal(Configuration.getConfig(db, tenant, "max_traversal_depth"), Constants.DEFAULT_MAX_DEPTH);
  });

  test("traverses the requirement -> system -> design -> part chain downstream", () => {
    const { result, definition } = Engine.executeTraversal(
      db,
      tenant,
      { root: `requirement:${ids.requirement.id}`, direction: "DOWNSTREAM", includeInactive: true },
      admin,
      { action: "TRAVERSAL" }
    );
    const graph = Engine.publicGraph(result, definition);
    assert.equal(graph.node_count, 4);
    assert.equal(graph.edge_count, 3);
    assert.equal(graph.direction, "DOWNSTREAM");
    const types = graph.nodes.map((node) => node.object_type).sort();
    assert.deepEqual(types, ["design", "part", "requirement", "system"]);
    assert.ok(graph.domains.some((entry) => entry.code === "PART" && entry.count === 1));
  });

  test("traverses upstream and in both directions", () => {
    const upstream = Engine.executeTraversal(db, tenant, { root: `part:${ids.part.id}`, direction: "UPSTREAM", includeInactive: true }, admin).result;
    assert.equal(upstream.node_count, 4);
    assert.equal(upstream.nodes.find((node) => node.depth === 3).object_type, "requirement");
    const both = Engine.executeTraversal(db, tenant, { root: `design:${ids.design.id}`, direction: "BOTH", includeInactive: true }, admin).result;
    assert.equal(both.node_count, 4);
  });

  test("honours depth and node limits with truncation reporting", () => {
    const shallow = Engine.executeTraversal(db, tenant, { root: `requirement:${ids.requirement.id}`, maxDepth: 1, includeInactive: true }, admin).result;
    assert.equal(shallow.node_count, 2);
    assert.equal(shallow.truncated, false);
    const limited = Engine.executeTraversal(db, tenant, { root: `requirement:${ids.requirement.id}`, maxNodes: 2, includeInactive: true }, admin).result;
    assert.equal(limited.node_count, 2);
    assert.equal(limited.truncated, true);
    assert.ok(limited.truncation_reasons.includes("node_limit"));
  });

  test("resolves paths between requirement and part", () => {
    const output = Paths.findPaths(
      db,
      tenant,
      { source: `requirement:${ids.requirement.id}`, target: `part:${ids.part.id}`, direction: "DOWNSTREAM", maxDepth: 10 },
      admin
    );
    assert.equal(output.found, true);
    assert.equal(output.shortest_path.length, 3);
    assert.equal(output.shortest_path.nodes[0], `requirement:${ids.requirement.id}`);
    assert.equal(output.shortest_path.nodes[3], `part:${ids.part.id}`);
  });

  test("computes impact, dependency and traceability views", () => {
    const impact = Impact.impactAnalysis(db, tenant, { root: `requirement:${ids.requirement.id}`, includeInactive: true }, admin);
    assert.equal(impact.impact_summary.impacted_count, 3);
    assert.ok(impact.nodes.some((node) => node.object_type === "part"));

    const dependency = Dependency.dependencyAnalysis(db, tenant, { root: `part:${ids.part.id}`, includeInactive: true }, admin);
    assert.equal(dependency.dependency_summary.dependency_count, 3);

    const matrix = Traceability.traceabilityMatrix(db, tenant, { root: `requirement:${ids.requirement.id}`, includeInactive: true }, admin);
    assert.ok(matrix.matrix.some((cell) => cell.from_domain === "REQUIREMENT" && cell.to_domain === "SYSTEM"));
    assert.ok(matrix.relationship_inventory.some((entry) => entry.relationship_type === "requirement.satisfies.system"));
  });

  test("evaluates traceability completeness against active rules", () => {
    const result = Completeness.evaluateCompleteness(db, tenant, { root: `requirement:${ids.requirement.id}`, includeInactive: true }, admin);
    assert.ok(result.completeness_score > 0);
    assert.ok(result.violated_rules >= 1);
    const requirementRule = result.rules.find((rule) => rule.rule.code === "REQ-TO-SYSTEM");
    assert.equal(requirementRule.state, "COMPLETE");
  });

  test("creates immutable snapshots and derives baselines", () => {
    const snapshot = Snapshots.createSnapshot(
      db,
      tenant,
      { root: `requirement:${ids.requirement.id}`, direction: "DOWNSTREAM", includeInactive: true, name: "Core requirement snapshot" },
      admin,
      IP
    );
    assert.equal(snapshot.status, "FROZEN");
    assert.equal(snapshot.immutable, true);
    assert.equal(snapshot.node_count, 4);
    assert.equal(snapshot.nodes.length, 4);
    assert.equal(snapshot.edges.length, 3);

    const graph = Snapshots.snapshotGraph(db, tenant, snapshot.id);
    assert.equal(graph.nodes.length, 4);

    const baseline = Baselines.createBaseline(db, tenant, { name: "Core requirement baseline", snapshot_id: snapshot.id }, admin, IP);
    assert.equal(baseline.member_count, 4);
    assert.equal(baseline.status, "DRAFT");
    const released = Baselines.releaseBaseline(db, tenant, baseline.id, admin, IP);
    assert.equal(released.status, "RELEASED");
    assert.equal(released.immutable, true);
    assert.throws(() => Baselines.updateBaseline(db, tenant, baseline.id, { name: "nope" }, admin, IP), (err) => err.code === "THREAD_BASELINE_IMMUTABLE");
  });

  test("compares snapshots and reports structural differences", () => {
    const before = Snapshots.createSnapshot(db, tenant, { root: `requirement:${ids.requirement.id}`, includeInactive: true, name: "Compare before" }, admin, IP);
    const documentType = metadata.createType(db, { code: "thread-document", name: "Thread document", module: "thread", status: "active" }, ACTOR, IP, tenant);
    const doc = objects.createObject(db, { type: "thread-document", code: "TDOC-1", name: "Analysis report", status: "released", data: {} }, ACTOR, tenant, IP);
    const references = linkType(db, tenant, "part.documented-by.thread-document", "Documented by", ids.partType.id, documentType.id);
    objects.createRelationship(db, { type: references.id, source: ids.part.id, target: doc.id, status: "active" }, ACTOR, tenant, IP);
    const after = Snapshots.createSnapshot(db, tenant, { root: `requirement:${ids.requirement.id}`, includeInactive: true, name: "Compare after" }, admin, IP);
    assert.ok(after.node_count > before.node_count);

    const diff = Compare.compareSnapshots(db, tenant, { left: before.id, right: after.id }, admin);
    assert.ok(diff.added_nodes.some((node) => node.node_ref === `thread-document:${doc.id}`));
    assert.ok(Array.isArray(diff.added_relationships));
  });

  test("denies traversal to an unauthorized actor", () => {
    const reader = queryOne(db, "SELECT id, username FROM users WHERE username = 'j.patel'");
    assert.throws(
      () => Engine.executeTraversal(db, tenant, { root: `requirement:${ids.requirement.id}`, includeInactive: true }, reader),
      (err) => err.code === "THREAD_NODE_NOT_FOUND" || err.code === "THREAD_SECURITY_BLOCKED"
    );
  });

  test("projects source objects and reports metrics", () => {
    const rebuilt = Projection.rebuildProjection(db, tenant, { objectTypes: ["requirement", "system"], actor: admin });
    assert.ok(rebuilt.processed >= 2);
    const list = Projection.listProjections(db, tenant, { object_type: "requirement" });
    assert.ok(list.items.some((item) => item.object_id === String(ids.requirement.id)));
    const metrics = Metrics.metricsSnapshot(db, tenant);
    assert.ok(metrics.counts.snapshots >= 1);
    assert.ok(metrics.counts.baselines >= 1);
    const health = Metrics.healthCheck(db, tenant);
    assert.equal(health.status, "OK");
    assert.equal(Foundation.threadHealth(db, tenant).source_module, "thread");
  });

  test("validates configuration bounds", () => {
    assert.throws(() => Configuration.setConfig(db, tenant, "max_traversal_depth", 9999, admin, IP), (err) => err.status === 400);
    assert.equal(Configuration.setConfig(db, tenant, "max_traversal_depth", 12, admin, IP), 12);
    assert.equal(Configuration.getConfig(db, tenant, "max_traversal_depth"), 12);
  });
});
