process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as metadata from "../services/metadata.js";
import * as objects from "../services/objects.js";
import { ensureThreadFoundation } from "../services/thread/index.js";
import { Service, Links, Constants } from "../services/traceability/index.js";

const ACTOR = { id: 1, username: "admin" };
const IP = "127.0.0.1";

describe("Generic Traceability Engine core", () => {
  let db;
  let tenant;
  let admin;
  let reader;
  let ids;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    admin = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    reader = queryOne(db, "SELECT id, username FROM users WHERE username = 'j.patel'");
    ensureThreadFoundation(db);

    const typeFor = (code, name) =>
      queryOne(db, "SELECT * FROM metadata_types WHERE code = ? AND (tenant_id IS NULL OR tenant_id = ?) ORDER BY tenant_id IS NULL LIMIT 1", [code, tenant]) ||
      metadata.createType(db, { code, name, module: "traceability", status: "active" }, ACTOR, IP, tenant);
    const requirementType = typeFor("requirement", "Requirement");
    const systemType = typeFor("system", "System");
    const designType = typeFor("design", "Design");
    const partType = typeFor("part", "Part");

    const linkType = (code, name, sourceTypeId, targetTypeId) =>
      queryOne(db, "SELECT * FROM relationship_types WHERE code = ? AND (tenant_id IS NULL OR tenant_id = ?) ORDER BY tenant_id IS NULL LIMIT 1", [code, tenant]) ||
      objects.createRelationshipType(
        db,
        { code, name, module: "traceability", source_type_id: sourceTypeId, target_type_id: targetTypeId, cardinality: "N:N", semantic: "association", status: "active" },
        ACTOR,
        IP,
        tenant
      );
    const satisfies = linkType("requirement.satisfies.system", "Satisfies", requirementType.id, systemType.id);
    const realizedBy = linkType("system.realized-by.design", "Realized by", systemType.id, designType.id);
    const implementedBy = linkType("design.implemented-by.part", "Implemented by", designType.id, partType.id);

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
    const requirement = make("requirement", "REQ-100", "Battery must last 10 hours");
    const requirement2 = make("requirement", "REQ-200", "Unlinked requirement");
    const system = make("system", "SYS-100", "Power subsystem");
    const design = make("design", "DSG-100", "Battery pack design");
    const part = make("part", "PRT-100", "Lithium cell");

    objects.createRelationship(db, { type: satisfies.id, source: requirement.id, target: system.id, status: "active" }, ACTOR, tenant, IP);
    objects.createRelationship(db, { type: realizedBy.id, source: system.id, target: design.id, status: "active" }, ACTOR, tenant, IP);
    objects.createRelationship(db, { type: implementedBy.id, source: design.id, target: part.id, status: "active" }, ACTOR, tenant, IP);

    ids = { requirementType, systemType, designType, partType, satisfies, realizedBy, implementedBy, requirement, requirement2, system, design, part };
  });

  after(() => {
    db?.close();
  });

  test("exposes the reusable source module and reuses Digital Thread IAM resources", () => {
    assert.equal(Constants.SOURCE_MODULE, "traceability");
    assert.equal(Constants.TRACEABILITY_RESOURCES.traceability, "iam.thread.traceability");
    assert.equal(Constants.TRACEABILITY_RESOURCES.completeness, "iam.thread.completeness");
  });

  test("forward traversal walks the requirement -> system -> design -> part thread", async () => {
    const graph = await Service.forwardAsync(db, tenant, { objectType: "requirement", objectId: ids.requirement.id, includeInactive: true }, admin);
    assert.equal(graph.source_module, "thread");
    assert.equal(graph.direction, "DOWNSTREAM");
    assert.equal(graph.node_count, 4);
    assert.equal(graph.edge_count, 3);
    const types = graph.nodes.map((node) => node.object_type).sort();
    assert.deepEqual(types, ["design", "part", "requirement", "system"]);
  });

  test("backward traversal is the reverse of forward", async () => {
    const graph = await Service.backwardAsync(db, tenant, { objectType: "part", objectId: ids.part.id, includeInactive: true }, admin);
    assert.equal(graph.direction, "UPSTREAM");
    assert.equal(graph.node_count, 4);
    assert.equal(graph.nodes.find((node) => node.depth === 3).object_type, "requirement");
  });

  test("children and parents are depth-1 projections", async () => {
    const kids = await Service.childrenAsync(db, tenant, { objectType: "requirement", objectId: ids.requirement.id, includeInactive: true }, admin);
    assert.equal(kids.node_count, 2);
    const parents = await Service.parentsAsync(db, tenant, { objectType: "part", objectId: ids.part.id, includeInactive: true }, admin);
    assert.equal(parents.node_count, 2);
  });

  test("finds the full path between two objects", async () => {
    const result = await Service.findPathsAsync(db, tenant, { source: `requirement:${ids.requirement.id}`, target: `part:${ids.part.id}`, maxDepth: 10 }, admin);
    assert.equal(result.found, true);
    assert.equal(result.shortest_path.length, 3);
    assert.equal(result.shortest_path.nodes[0], `requirement:${ids.requirement.id}`);
    assert.equal(result.shortest_path.nodes[3], `part:${ids.part.id}`);
  });

  test("computes impact analysis for a changed requirement", async () => {
    const impact = await Service.impactAsync(db, tenant, { objectType: "requirement", objectId: ids.requirement.id, includeInactive: true }, admin);
    assert.equal(impact.impact_summary.impacted_count, 3);
    assert.ok(impact.nodes.some((node) => node.object_type === "part"));
  });

  test("builds a domain matrix with a relationship inventory", async () => {
    const matrix = await Service.matrixAsync(db, tenant, { objectType: "requirement", objectId: ids.requirement.id, includeInactive: true }, admin);
    assert.ok(matrix.matrix.some((cell) => cell.from_domain === "REQUIREMENT" && cell.to_domain === "SYSTEM"));
    assert.ok(matrix.relationship_inventory.some((entry) => entry.relationship_type === "requirement.satisfies.system"));
  });

  test("computes coverage from configurable traceability rules", async () => {
    const result = await Service.coverageAsync(db, tenant, {}, admin);
    const rule = result.rules.find((entry) => entry.rule.code === "REQ-TO-SYSTEM");
    assert.equal(rule.expected, 2);
    assert.equal(rule.linked, 1);
    assert.equal(rule.orphaned, 1);
    assert.equal(rule.coverage, 50);
    assert.ok(result.overall_coverage <= 100);
    assert.ok(result.target_domains.some((entry) => entry.target_domain === "SYSTEM"));
  });

  test("detects orphan objects that violate a required rule", async () => {
    const result = await Service.orphansAsync(db, tenant, {}, admin);
    const orphan = result.items.find((item) => item.object.code === "REQ-200");
    assert.ok(orphan);
    assert.equal(orphan.expected_target_domain, "SYSTEM");
    assert.equal(orphan.rule.required, true);
  });

  test("detects broken links when a target object is removed", async () => {
    const spare = objects.createObject(db, { type: "part", code: "PRT-BROKEN", name: "Spare", status: "released", data: { "part.number": "PRT-BROKEN", "part.name": "Spare", "part.category": "mechanical", "part.status": "released" } }, ACTOR, tenant, IP);
    objects.createRelationship(db, { type: ids.implementedBy.id, source: ids.design.id, target: spare.id, status: "active" }, ACTOR, tenant, IP);
    objects.setObjectStatus(db, spare.id, "obsolete", ACTOR, tenant, IP);
    const result = await Service.brokenLinksAsync(db, tenant, {}, admin);
    const broken = result.items.find((item) => item.target?.code === "PRT-BROKEN");
    assert.ok(broken, "expected a broken link for the obsolete part");
    assert.ok(broken.reasons.includes("TARGET_OBSOLETE"));
    assert.equal(broken.severity, "WARNING");
  });

  test("creates, reads, updates and deletes trace links through the shared framework", async () => {
    const extra = objects.createObject(db, { type: "system", code: "SYS-LINK", name: "Link target", status: "released", data: {} }, ACTOR, tenant, IP);
    const created = await Links.createLinkAsync(db, {
      relationshipType: "requirement.satisfies.system",
      sourceObject: { objectType: "requirement", objectId: ids.requirement.id },
      targetObject: { objectType: "system", objectId: extra.id },
      effectivity: { start: "2026-01-01" },
    }, ACTOR, tenant, IP);
    assert.equal(created.source.id, ids.requirement.id);
    assert.equal(created.target.id, extra.id);
    assert.equal(created.valid_from, "2026-01-01");
    assert.equal(typeof created.attributes, "object");

    const fetched = await Links.getLinkAsync(db, created.id, tenant);
    assert.equal(fetched.id, created.id);

    const links = await Links.linksForObjectAsync(db, "requirement", ids.requirement.id, tenant, {});
    assert.equal(links.direction, "BOTH");
    assert.ok(links.outgoing.length >= 2);

    const deleted = await Links.deleteLinkAsync(db, created.id, {}, ACTOR, tenant, IP);
    assert.equal(deleted.deleted, true);
  });

  test("reports an aggregate health status", async () => {
    const health = await Service.healthAsync(db, tenant, admin);
    assert.equal(health.source_module, "traceability");
    assert.ok(["OK", "DEGRADED"].includes(health.status));
    assert.ok(health.broken_links >= 1);
    assert.ok(health.orphaned >= 1);
  });

  test("enforces data security during traversal", async () => {
    await assert.rejects(
      () => Service.forwardAsync(db, tenant, { objectType: "requirement", objectId: ids.requirement.id, includeInactive: true }, reader),
      (err) => err.code === "THREAD_NODE_NOT_FOUND" || err.code === "THREAD_SECURITY_BLOCKED"
    );
  });
});
