process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase } from "../db.js";
import "../seed.js";
import { ensureNumberingFoundation } from "../services/numbering.js";
import { ensureRequirementsFoundation, Requirements } from "../services/requirements/index.js";
import { ensureBomFoundation, Definitions as BomDefinitions, Revisions as BomRevisions, Lines as BomLines } from "../services/bom/index.js";
import * as RPDM from "../services/requirement-pdm/index.js";

describe("Requirement -> EBOM / MBOM / BOP structure projection", () => {
  let db;
  let tenant;
  let actor;
  let requirement;
  let ebomRevision;
  let mbomRevision;
  let bopRevision;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('rplm-struct', 'RPLM Struct', 'organization')").run();
    tenant = db.prepare("SELECT id FROM organizations WHERE code = 'rplm-struct'").get().id;
    db.prepare("UPDATE organizations SET tenant_id = id WHERE id = ?").run(tenant);
    db.prepare(
      "INSERT INTO users (username, email, employee_id, display_name, organization_id, tenant_id, password_hash, password_salt) VALUES ('rplm-struct-owner','rplm-struct-owner@example.com','EMP-RPLMS','RPLM Struct Owner',?,?,?,?)"
    ).run(tenant, tenant, "x", "y");
    const owner = db.prepare("SELECT id FROM users WHERE username = 'rplm-struct-owner'").get();
    actor = { id: owner.id, tenant_id: tenant };

    ensureNumberingFoundation(db);
    ensureRequirementsFoundation(db);
    ensureBomFoundation(db);
    RPDM.ensureRequirementPdmFoundation(db);

    requirement = Requirements.createRequirement(db, tenant, { title: "Structure trace", requirement_type: "product_requirement" }, actor, null);
    RPDM.ensureRequirementObject(db, tenant, Requirements.getRequirementRow(db, tenant, requirement.id), actor, null);

    const ebom = BomDefinitions.createBom(db, tenant, { bom_number: "EBOM-5000", name: "Engineering BOM", bom_type: "EBOM" }, actor, null);
    ebomRevision = BomRevisions.createRevision(db, tenant, ebom.id, { revision_number: "A1" }, actor, null);
    BomLines.addLine(db, tenant, ebomRevision.id, { child_object_id: "ASSY", quantity: 1, uom: "EA", find_number: "10" }, actor, null);
    BomLines.addLine(db, tenant, ebomRevision.id, { child_object_id: "SUB", parent_object_id: "ASSY", quantity: 2, uom: "EA", find_number: "10.1" }, actor, null);
    BomLines.addLine(db, tenant, ebomRevision.id, { child_object_id: "LEAF", parent_object_id: "SUB", quantity: 4, uom: "EA", find_number: "10.1.1" }, actor, null);
    BomLines.addLine(db, tenant, ebomRevision.id, { child_object_id: "FUTURE", quantity: 1, uom: "EA", effectivity: { start: "2030-01-01" } }, actor, null);

    const mbom = BomDefinitions.createBom(db, tenant, { bom_number: "MBOM-5000", name: "Manufacturing BOM", bom_type: "MBOM" }, actor, null);
    mbomRevision = BomRevisions.createRevision(db, tenant, mbom.id, { revision_number: "A1" }, actor, null);
    BomLines.addLine(db, tenant, mbomRevision.id, { child_object_id: "ASSY-M", quantity: 1, uom: "EA" }, actor, null);

    const bop = BomDefinitions.createBom(db, tenant, { bom_number: "BOP-5000", name: "Bill of Process", bom_type: "BOP" }, actor, null);
    bopRevision = BomRevisions.createRevision(db, tenant, bop.id, { revision_number: "A1" }, actor, null);
    BomLines.addLine(db, tenant, bopRevision.id, { child_object_id: "OP-10", quantity: 1, uom: "EA" }, actor, null);

    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "SATISFIED_BY", target_type: "bom_revision", target_id: ebomRevision.id }, actor, null);
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "SATISFIED_BY", target_type: "bom_revision", target_id: mbomRevision.id }, actor, null);
    RPDM.createAllocation(db, tenant, { requirement_id: requirement.id, relationship_type: "REALIZED_BY", target_type: "bom_revision", target_id: bopRevision.id }, actor, null);
  });

  after(() => {
    db?.close();
  });

  test("groups allocated structures by bom type with structure summaries", async () => {
    const view = await RPDM.listRequirementStructuresAsync(db, tenant, requirement.id, {});
    assert.equal(view.total, 3);
    assert.deepEqual(view.counts_by_type, { EBOM: 1, MBOM: 1, BOP: 1, OTHER: 0 });
    const ebom = view.by_type.EBOM[0];
    assert.equal(ebom.bom_type, "EBOM");
    assert.equal(ebom.revision_number, "A1");
    assert.equal(ebom.structure.line_count, 4);
    assert.equal(ebom.structure.max_depth, 3);
    assert.equal(view.coverage.structure_covered, true);
    assert.deepEqual(view.coverage.covered_types.sort(), ["BOP", "EBOM", "MBOM"]);
    assert.deepEqual(view.coverage.missing_types, []);
  });

  test("sync projection matches async", () => {
    const view = RPDM.listRequirementStructures(db, tenant, requirement.id, {});
    assert.equal(view.total, 3);
    assert.equal(view.by_type.EBOM[0].structure.line_count, 4);
  });

  test("applies effectivity filter to structure counts", async () => {
    const view = await RPDM.listRequirementStructuresAsync(db, tenant, requirement.id, { asOf: "2026-01-01" });
    const ebom = view.by_type.EBOM[0];
    assert.equal(ebom.structure.line_count, 3);
    assert.equal(view.coverage.covered_types.length, 3);
  });

  test("exposes structure coverage per bom type", async () => {
    const coverage = await RPDM.structureCoverageAsync(db, tenant, requirement.id, {});
    assert.equal(coverage.by_type.EBOM.allocated, true);
    assert.equal(coverage.by_type.EBOM.line_count, 4);
    assert.equal(coverage.by_type.MBOM.allocated, true);
    assert.equal(coverage.by_type.BOP.allocated, true);
    assert.equal(coverage.released, false);
  });

  test("traces a full BOM revision structure", async () => {
    const trace = await RPDM.bomRevisionStructureAsync(db, tenant, ebomRevision.id, {});
    assert.equal(trace.structure.bom_type, "EBOM");
    assert.equal(trace.nodes.length, 4);
    assert.equal(trace.max_depth, 3);
    assert.equal(trace.item_count, 4);
  });

  test("reverse trace lists requirements for a structure", async () => {
    const reverse = await RPDM.listStructureRequirementsAsync(db, tenant, ebomRevision.id, {});
    assert.equal(reverse.total, 1);
    assert.equal(reverse.items[0].requirement_id, requirement.id);
    assert.equal(reverse.items[0].relationship_type, "SATISFIED_BY");
  });
});
