process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, run, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { RequirementsManager, ensureRequirementsFoundation } from "../services/requirements/index.js";
import { ensureRequirementObject } from "../services/requirement-pdm/index.js";
import { Characteristics, Definitions, Hierarchy, Assignments } from "../services/classification/index.js";
import { Service } from "../services/traceability/index.js";
import {
  ensureRequirementManufacturingFoundation,
  createManufacturingObject,
  linkManufacturingObjects,
  designateCtq,
  setCharacteristicLimits,
  characteristicConstraints,
  listCriticalCharacteristics,
} from "../services/requirement-manufacturing/index.js";

const IP = "127.0.0.1";

function nodeKeys(graph) {
  return graph.nodes.map((node) => `${node.object_type}:${node.object_id}`);
}

describe("Requirement -> Manufacturing Digital Thread projection", () => {
  let db;
  let tenant;
  let actor;
  let requirement;
  let characteristic;
  let document;
  let operation;
  let workCenter;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureRequirementManufacturingFoundation(db);

    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");

    requirement = RequirementsManager.createRequirement(
      db,
      tenant,
      { title: "Battery pack CTQ governed", requirement_type: "business_requirement" },
      actor,
      IP
    );
    ensureRequirementObject(db, tenant, requirement, actor, IP);
    requirement = queryOne(db, "SELECT * FROM requirements WHERE id = ?", [requirement.id]);
    assert.ok(requirement.object_id, "requirement must be mirrored to a generic object id");

    characteristic = Characteristics.createCharacteristic(db, tenant, { code: "MFG-CTQ-1", name: "Weld depth", data_type: "UNIT_NUMERIC", unit: "MM" }, actor, IP);

    const inserted = run(
      db,
      "INSERT INTO content (content_id, content_key, tenant_id, file_name, description) VALUES (?, ?, ?, ?, ?)",
      ["MFG-DOC-1", "MFG-DOC-1", Number(tenant), "work-instruction.pdf", "Operation work instruction"]
    );
    document = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(inserted.lastInsertId)]);

    operation = createManufacturingObject(db, tenant, { object_type: "operation", code: "OP-10", name: "Weld operation" }, actor, IP);
    workCenter = createManufacturingObject(db, tenant, { object_type: "work_center", code: "WC-01", name: "Welding cell" }, actor, IP);
  });

  after(() => {
    db?.close();
  });

  test("generates and links operations and work centers as generic objects", () => {
    assert.equal(operation.type.code, "operation");
    assert.equal(workCenter.type.code, "work_center");
    const edge = linkManufacturingObjects(db, tenant, {
      relationship_type: "operation.performed-at.work-center",
      source_id: operation.id,
      target_id: workCenter.id,
    }, actor, IP);
    assert.ok(edge);
  });

  test("projects a GOVERNED_BY edge from a requirement to a characteristic", async () => {
    RequirementsManager.createRelationship(db, tenant, {
      relationship_type: "GOVERNED_BY",
      source_id: requirement.id,
      target_id: characteristic.id,
      target_type: "characteristic",
      status: "ACTIVE",
    }, actor, IP);

    const graph = await Service.forwardAsync(db, tenant, { objectType: "requirement", objectId: String(requirement.object_id), includeInactive: true }, actor);
    const keys = nodeKeys(graph);
    assert.ok(keys.includes(`requirement:${requirement.object_id}`), `root missing: ${keys.join(",")}`);
    assert.ok(keys.includes(`characteristic:${characteristic.id}`), `characteristic missing: ${keys.join(",")}`);
  });

  test("resolves a characteristic association edge to the operation", async () => {
    const classification = Definitions.createClassification(db, tenant, { code: "MFG-CLA", name: "Manufacturing" }, actor, IP);
    const cls = Hierarchy.createClass(db, tenant, { classification_id: classification.id, code: "MFG-ROOT", name: "Root" }, actor, IP);
    Hierarchy.setClassStatus(db, tenant, cls.id, "ACTIVE", actor, IP);
    Characteristics.addClassCharacteristic(db, tenant, cls.id, { characteristic_id: characteristic.id }, actor, IP);
    Assignments.assignClass(db, tenant, { class_id: cls.id, object_type: "operation", object_id: String(operation.id) }, actor, IP);

    const graph = await Service.forwardAsync(db, tenant, { objectType: "characteristic", objectId: String(characteristic.id), includeInactive: true }, actor);
    const keys = nodeKeys(graph);
    assert.ok(keys.includes(`operation:${operation.id}`), `operation edge missing: ${keys.join(",")}`);
  });

  test("walks a requirement back from a characteristic (reverse projection)", async () => {
    const graph = await Service.backwardAsync(db, tenant, { objectType: "characteristic", objectId: String(characteristic.id), includeInactive: true }, actor);
    const keys = nodeKeys(graph);
    assert.ok(keys.includes(`requirement:${requirement.object_id}`), `requirement reverse edge missing: ${keys.join(",")}`);
  });

  test("resolves content nodes and their reverse requirement edge", async () => {
    RequirementsManager.createRelationship(db, tenant, {
      relationship_type: "REPRESENTED_BY",
      source_id: requirement.id,
      target_id: document.id,
      target_type: "content",
      status: "ACTIVE",
    }, actor, IP);

    const graph = await Service.backwardAsync(db, tenant, { objectType: "content", objectId: String(document.id), includeInactive: true }, actor);
    const keys = nodeKeys(graph);
    assert.ok(keys.includes(`content:${document.id}`), `content root missing: ${keys.join(",")}`);
    assert.ok(keys.includes(`requirement:${requirement.object_id}`), `requirement reverse edge missing: ${keys.join(",")}`);
  });

  test("designates a characteristic as CTQ and reads process constraints", () => {
    designateCtq(db, tenant, characteristic.id, { ctq: true, severity: "HIGH", rationale: "Safety critical" }, actor, IP);
    setCharacteristicLimits(db, tenant, characteristic.id, { min_value: 1.5, max_value: 3.5, min_inclusive: true, max_inclusive: false }, actor, IP);

    const constraints = characteristicConstraints(db, tenant, characteristic.id);
    assert.equal(constraints.ctq, true);
    assert.equal(constraints.ctq_severity, "HIGH");
    assert.equal(Number(constraints.min_value), 1.5);
    assert.equal(Number(constraints.max_value), 3.5);
    assert.equal(constraints.min_inclusive, true);
    assert.equal(constraints.max_inclusive, false);

    const critical = listCriticalCharacteristics(db, tenant);
    assert.ok(critical.some((row) => row.code === "MFG-CTQ-1"), "CTQ characteristic must be listed");
  });
});
