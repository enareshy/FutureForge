import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne } from "../db.js";
import { seedDatabase } from "../seed.js";
import * as objects from "../services/objects.js";
import { HttpError } from "../validation.js";

const ACTOR = { id: 1, username: "admin" };
const IP = "127.0.0.1";

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  seedDatabase(db);
  const tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
  return { db, tenantId, actor: ACTOR };
}

const productData = (code, name) => ({
  "part.number": code,
  "part.name": name,
  "part.category": "mechanical",
  "part.status": "draft",
});

describe("object framework: lifecycle", () => {
  test("seeded object types, objects and relationship types are present", () => {
    const { db, tenantId } = setup();
    const types = objects.objectTypes(db, tenantId).items.map((t) => t.code);
    for (const code of ["product", "product-revision", "bom", "document", "change-notice"]) {
      assert.ok(types.includes(code), `type ${code} is seeded`);
    }
    const list = objects.listObjects(db, { pageSize: 50 }, tenantId);
    assert.equal(list.total, 7);
    const relTypes = objects.listRelationshipTypes(db, {}, tenantId).items.map((r) => r.code);
    assert.ok(relTypes.includes("product.has-revision"));
  });

  test("create validates against metadata and records an initial version", () => {
    const { db, tenantId, actor } = setup();
    const created = objects.createObject(
      db,
      { type: "product", code: "PROD-7777", name: "Widget", data: productData("PROD-7777", "Widget") },
      actor,
      tenantId,
      IP
    );
    assert.equal(created.code, "PROD-7777");
    assert.equal(created.revision, 1);
    assert.equal(created.data["part.number"], "PROD-7777");
    const versions = objects.listObjectVersions(db, created.id, tenantId, {}).items;
    assert.equal(versions.length, 1);
    assert.equal(versions[0].change_type, "create");
    assert.equal(versions[0].snapshot.code, "PROD-7777");
  });

  test("create rejects invalid metadata payloads and duplicate codes", () => {
    const { db, tenantId, actor } = setup();
    assert.throws(
      () => objects.createObject(db, { type: "product", code: "BAD-1", name: "Bad", data: {} }, actor, tenantId, IP),
      (err) => err instanceof HttpError && err.status === 422
    );
    assert.throws(
      () =>
        objects.createObject(
          db,
          { type: "product", code: "PROD-1000", name: "Dup", data: productData("PROD-1000", "Dup") },
          actor,
          tenantId,
          IP
        ),
      (err) => err instanceof HttpError && err.status === 409
    );
  });

  test("status changes and updates bump the revision, stale revisions conflict", () => {
    const { db, tenantId, actor } = setup();
    const prod = objects.getObject(db, "PROD-1000", tenantId);
    const active = objects.setObjectStatus(db, prod.id, "active", actor, tenantId, IP);
    assert.equal(active.status, "active");
    assert.equal(active.revision, prod.revision + 1);

    assert.throws(
      () => objects.updateObject(db, prod.id, { name: "Stale", revision: prod.revision }, actor, tenantId, IP),
      (err) => err instanceof HttpError && err.status === 409
    );

    const updated = objects.updateObject(
      db,
      prod.id,
      { name: "Air Compressor v2", revision: active.revision, data: { "part.category": "hydraulic" } },
      actor,
      tenantId,
      IP
    );
    assert.equal(updated.name, "Air Compressor v2");
    assert.equal(updated.data["part.category"], "hydraulic");
    assert.equal(updated.data["part.number"], "PROD-1000");
    assert.equal(objects.listObjectVersions(db, prod.id, tenantId, {}).items.length, 3);
  });

  test("checkout locks the object and checkin releases it", () => {
    const { db, tenantId, actor } = setup();
    const prod = objects.getObject(db, "PROD-2000", tenantId);
    const locked = objects.checkoutObject(db, prod.id, { reason: "editing" }, actor, tenantId, IP);
    assert.equal(locked.checkout.locked_by, actor.id);
    assert.equal(objects.objectLocks(db, prod.id, tenantId).items.length, 1);
    const reread = objects.getObject(db, prod.id, tenantId);
    assert.equal(reread.locked, true);

    const again = objects.checkoutObject(db, prod.id, {}, actor, tenantId, IP);
    assert.equal(again.checkout.id, locked.checkout.id, "re-checkout is idempotent for the lock owner");
    assert.equal(objects.objectLocks(db, prod.id, tenantId).items.length, 1);

    const released = objects.checkinObject(db, prod.id, {}, actor, tenantId, IP);
    assert.equal(released.object.locked, false);
    assert.equal(objects.objectLocks(db, prod.id, tenantId).items.length, 0);
  });

  test("soft delete requires force when blocked, cascades composition children, restores", () => {
    const { db, tenantId, actor } = setup();
    const prod = objects.getObject(db, "PROD-1000", tenantId);
    const report = objects.safeDeleteReport(db, prod.id, tenantId);
    assert.ok(report.blockers.length > 0);
    assert.throws(
      () => objects.softDeleteObject(db, prod.id, {}, actor, tenantId, IP),
      (err) => err instanceof HttpError && err.status === 409
    );
    const deleted = objects.softDeleteObject(db, prod.id, { force: true }, actor, tenantId, IP);
    assert.equal(deleted.deleted, true);
    const revisionA = objects.getObject(db, "PROD-1000-A", tenantId);
    assert.equal(revisionA.deleted, true, "composition child was cascaded");
    const restored = objects.restoreObject(db, prod.id, actor, tenantId, IP);
    assert.equal(restored.deleted, false);
  });

  test("object queries are tenant-isolated", () => {
    const { db, tenantId } = setup();
    assert.throws(
      () => objects.getObject(db, "PROD-1000", 99999),
      (err) => err instanceof HttpError && err.status === 404
    );
    assert.throws(
      () => objects.listObjects(db, {}, null),
      (err) => err instanceof HttpError && err.status === 400
    );
  });
});

describe("object framework: relationships", () => {
  test("traverses, graphs and lists relationships for an object", () => {
    const { db, tenantId } = setup();
    const prod = objects.getObject(db, "PROD-1000", tenantId);
    const links = objects.relationshipsForObject(db, prod.id, tenantId, {});
    assert.ok(links.outgoing.length >= 2);
    const tree = objects.traverse(db, prod.id, { depth: 2 }, tenantId);
    assert.equal(tree.root.id, prod.id);
    assert.ok(tree.nodes.length >= 4);
    const graph = objects.graph(db, prod.id, tenantId, { depth: 2 });
    assert.ok(graph.node_count >= 5);
    assert.ok(graph.edge_count >= 5);
  });

  test("rejects duplicate and self relationships", () => {
    const { db, tenantId, actor } = setup();
    const productType = objects
      .objectTypes(db, tenantId)
      .items.find((t) => t.code === "product");
    const sameType = objects.createRelationshipType(
      db,
      {
        code: "product.related-to",
        name: "Product related to",
        source_type_id: productType.id,
        target_type_id: productType.id,
        cardinality: "N:N",
        semantic: "association",
        status: "active",
      },
      actor,
      IP,
      tenantId
    );
    const p1 = objects.getObject(db, "PROD-1000", tenantId);
    const p2 = objects.getObject(db, "PROD-2000", tenantId);

    const selfCheck = objects.validateRelationship(db, { type: sameType.id, source: p1.id, target: p1.id }, tenantId);
    assert.equal(selfCheck.valid, false);
    assert.match(selfCheck.error, /Self-relationships/);

    const created = objects.createRelationship(db, { type: sameType.id, source: p1.id, target: p2.id }, actor, tenantId, IP);
    assert.equal(created.status, "active");

    const dupCheck = objects.validateRelationship(db, { type: sameType.id, source: p1.id, target: p2.id }, tenantId);
    assert.equal(dupCheck.valid, false);
    assert.throws(
      () => objects.createRelationship(db, { type: sameType.id, source: p1.id, target: p2.id }, actor, tenantId, IP),
      (err) => err instanceof HttpError && err.status === 409
    );
  });

  test("relationship types in use cannot be deleted", () => {
    const { db, tenantId, actor } = setup();
    const rt = objects.listRelationshipTypes(db, { q: "has-revision" }, tenantId).items[0];
    assert.ok(rt);
    assert.throws(
      () => objects.deleteRelationshipType(db, rt.id, actor, IP, tenantId),
      (err) => err instanceof HttpError && err.status === 409
    );
  });
});

describe("object framework: references & dependencies", () => {
  test("direct dependencies, impact analysis and cycle detection", () => {
    const { db, tenantId } = setup();
    const prod = objects.getObject(db, "PROD-1000", tenantId);
    const deps = objects.directDependencies(db, prod.id, tenantId);
    assert.ok(deps.depended_on_by.length >= 2);
    const impact = objects.impactOf(db, prod.id, tenantId, { depth: 3 });
    const impactedCodes = impact.impacted.map((o) => o.code);
    assert.ok(impactedCodes.includes("PROD-1000-A"));
    assert.ok(impactedCodes.includes("BOM-1000"));
    const cycles = objects.detectCycles(db, tenantId, {});
    assert.equal(cycles.count, 0);
  });

  test("strong references block deletion while weak ones can orphan", () => {
    const { db, tenantId, actor } = setup();
    const doc = objects.getObject(db, "DOC-1000", tenantId);
    const prod = objects.getObject(db, "PROD-1000", tenantId);
    assert.throws(
      () =>
        objects.createReference(
          db,
          { source_object_id: doc.id, target_object_id: prod.id, reference_type: "weak", context: "describes" },
          actor,
          tenantId,
          IP
        ),
      (err) => err instanceof HttpError && err.status === 409
    );
    const created = objects.createReference(
      db,
      { source_object_id: doc.id, target_object_id: prod.id, reference_type: "strong", context: "doc-v2" },
      actor,
      tenantId,
      IP
    );
    assert.equal(created.reference_type, "strong");
    const target = objects.getObject(db, "PROD-2000", tenantId);
    const external = objects.createReference(
      db,
      {
        source_object_id: target.id,
        reference_type: "external",
        external_system: "ERP",
        external_ref: "X-1",
        context: "purchase",
      },
      actor,
      tenantId,
      IP
    );
    assert.equal(external.target, null);
  });

  test("orphan references surface weak links to deleted targets", () => {
    const { db, tenantId, actor } = setup();
    const doc = objects.getObject(db, "DOC-1000", tenantId);
    const revisionB = objects.getObject(db, "PROD-1000-B", tenantId);
    objects.createReference(
      db,
      { source_object_id: doc.id, target_object_id: revisionB.id, reference_type: "weak", context: "spec" },
      actor,
      tenantId,
      IP
    );
    objects.softDeleteObject(db, revisionB.id, { force: true }, actor, tenantId, IP);
    const orphans = objects.orphanReferences(db, tenantId, {});
    assert.ok(orphans.items.some((r) => r.target_object_id === revisionB.id));
  });
});
