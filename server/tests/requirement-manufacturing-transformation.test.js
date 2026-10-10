process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, run, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { ensureRequirementsFoundation } from "../services/requirements/index.js";
import { Definitions, Revisions, Lines, Transformation, Seed, Configuration, ensureBomFoundation } from "../services/bom/index.js";
import {
  ensureRequirementManufacturingFoundation,
  ebomMbomMappings,
  ebomMbomMappingsAsync,
  mbomEbomSources,
  listTransformationsForRevision,
} from "../services/requirement-manufacturing/index.js";

const IP = "127.0.0.1";

describe("Requirement -> Manufacturing EBOM/MBOM transformation trace", () => {
  let db;
  let tenant;
  let actor;
  let sourceRevision;
  let targetRevision;
  let definition;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureBomFoundation(db);
    ensureRequirementManufacturingFoundation(db);

    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    actor = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");

    Configuration.ensureBomConfig(db, tenant);
    Seed.seedBom(db, tenant);

    const ebom = Definitions.getBom(db, tenant, "DEMO-EBOM-PUMP");
    sourceRevision = Revisions.listRevisions(db, { tenantId: tenant, bomId: ebom.id }).items[0];
    definition = Transformation.listTransformationDefinitions(db, { tenantId: tenant }).items[0];

    const executed = Transformation.transform(db, tenant, { definition_id: definition.id, source_revision_id: sourceRevision.id, mode: "EXECUTE" });
    assert.equal(executed.run.status, "COMPLETED");
    targetRevision = Revisions.getRevision(db, tenant, executed.run.target_revision_id);
  });

  after(() => {
    db?.close();
  });

  test("projects EBOM -> MBOM mappings from persisted transformation provenance", () => {
    const result = ebomMbomMappings(db, tenant, sourceRevision.id);
    assert.equal(result.direction, "EBOM_TO_MBOM");
    assert.equal(result.ebom_revision.bom_type, "EBOM");
    assert.ok(result.summary.mappings >= 1);
    assert.equal(result.summary.invalid, 0);
    assert.equal(result.summary.unmapped_source_items, 0);
    assert.ok(result.items.every((item) => item.link_source === "TRANSFORMATION_PROVENANCE"));
    assert.ok(result.items.every((item) => item.status === "VALID"));
    const first = result.items[0];
    assert.equal(first.source.found, true);
    assert.ok(first.source.line_ref);
    assert.equal(first.target.bom_type, "MBOM");
    assert.equal(first.target.revision_number, targetRevision.revision_number);
  });

  test("projects MBOM -> EBOM sources and reports no unlinked targets", () => {
    const result = mbomEbomSources(db, tenant, targetRevision.id);
    assert.equal(result.direction, "MBOM_TO_EBOM");
    assert.equal(result.mbom_revision.bom_type, "MBOM");
    assert.ok(result.summary.traced >= 1);
    assert.equal(result.summary.unlinked_target_items, 0);
    assert.equal(result.summary.invalid, 0);
    const first = result.items[0];
    assert.equal(first.source.found, true);
    assert.equal(first.source.bom_type, "EBOM");
  });

  test("supports the async twin", async () => {
    const result = await ebomMbomMappingsAsync(db, tenant, sourceRevision.id);
    assert.ok(result.summary.mappings >= 1);
    assert.equal(result.source_module, "requirement-manufacturing");
  });

  test("detects unmapped source items that were never transformed", () => {
    const bom = Definitions.createBom(db, tenant, { bom_number: "TRACE-EBOM", name: "Trace", bom_type: "EBOM" }, actor, IP);
    const revision = Revisions.createRevision(db, tenant, bom.id, { revision_number: "A1" }, actor, IP);
    Lines.addLine(db, tenant, revision.id, { child_object_id: "TRACE-C1", quantity: 1, uom: "EA", find_number: "10" }, actor, IP);
    Lines.addLine(db, tenant, revision.id, { child_object_id: "TRACE-C2", quantity: 1, uom: "EA", find_number: "20" }, actor, IP);
    const executed = Transformation.transform(db, tenant, { definition_id: definition.id, source_revision_id: revision.id, mode: "EXECUTE" });
    assert.equal(executed.run.status, "COMPLETED");

    Lines.addLine(db, tenant, revision.id, { child_object_id: "TRACE-C3", quantity: 1, uom: "EA", find_number: "30" }, actor, IP);

    const result = ebomMbomMappings(db, tenant, revision.id);
    assert.equal(result.summary.unmapped_source_items, 1);
    assert.equal(result.unmapped_source_items[0].object_id, "TRACE-C3");
    assert.equal(result.unmapped_source_items[0].reason, "MISSING_LINK");
  });

  test("lists transformation runs for a revision", () => {
    const runs = listTransformationsForRevision(db, tenant, sourceRevision.id);
    assert.ok(runs.total >= 1);
    assert.equal(runs.items[0].status, "COMPLETED");
    assert.equal(runs.source_module, "requirement-manufacturing");
  });

  test("rejects non-EBOM and non-MBOM revisions", () => {
    assert.throws(() => ebomMbomMappings(db, tenant, targetRevision.id), (err) => err.code === "REQUIREMENT_MANUFACTURING_INVALID_MAPPING");
    assert.throws(() => mbomEbomSources(db, tenant, sourceRevision.id), (err) => err.code === "REQUIREMENT_MANUFACTURING_INVALID_MAPPING");
  });

  test("distinguishes an invalid link from a missing link", () => {
    const targetLine = Lines.listLines(db, { tenantId: tenant, revisionId: targetRevision.id }).items[0];
    run(db, "UPDATE bom_lines SET attributes_json = ? WHERE id = ?", [
      JSON.stringify({ source_line_ref: "DOES-NOT-EXIST", source_object_id: "999999" }),
      Number(targetLine.id),
    ]);
    const result = mbomEbomSources(db, tenant, targetRevision.id);
    assert.equal(result.summary.invalid, 1);
    const invalid = result.invalid_links[0];
    assert.equal(invalid.status, "INVALID_LINK");
    assert.equal(invalid.source.found, false);
  });
});
