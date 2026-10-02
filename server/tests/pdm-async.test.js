process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, openTestDatabase } from "../db.js";
import {
  Items,
  Revisions,
  Datasets,
  Cad,
  Relationships,
  Baselines,
  Validator,
  Configuration,
  ensurePdmFoundation,
} from "../services/pdm/index.js";

describe("async PDM write twins mirror the synchronous service", () => {
  let db;
  const tenant = 1;

  before(() => {
    db = openTestDatabase();
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('pdm-async-org', 'Async Org', 'organization')").run();
    db.prepare("UPDATE organizations SET tenant_id = id WHERE code = 'pdm-async-org'").run();
    ensurePdmFoundation(db);
    Configuration.ensurePdmConfig(db, tenant);
  });

  after(() => {
    db?.close();
  });

  test("createItemAsync matches createItem and enforces uniqueness", async () => {
    const sync = Items.createItem(db, tenant, { item_number: "PAR-SYNC-1", name: "Parity item", item_type: "PART" });
    const asyn = await Items.createItemAsync(db, tenant, { item_number: "PAR-ASYNC-1", name: "Parity item", item_type: "PART" });
    assert.equal(asyn.name, sync.name);
    assert.equal(asyn.item_type, sync.item_type);
    assert.equal(asyn.status, sync.status);
    assert.equal(asyn.version, sync.version);
    assert.match(asyn.item_ref, /^PDM-ITEM-/);
    await assert.rejects(
      () => Items.createItemAsync(db, tenant, { item_number: "PAR-ASYNC-1", name: "dup", item_type: "PART" }),
      (err) => err.code === "PDM_ITEM_CONFLICT"
    );
  });

  test("updateItemAsync applies the same optimistic locking and validation", async () => {
    const row = await Items.getItemRowAsync(db, tenant, "PAR-ASYNC-1");
    const updated = await Items.updateItemAsync(db, tenant, "PAR-ASYNC-1", { description: "updated", version: row.version });
    assert.equal(updated.description, "updated");
    assert.equal(updated.version, row.version + 1);
    await assert.rejects(
      () => Items.updateItemAsync(db, tenant, "PAR-ASYNC-1", { description: "stale", version: row.version }),
      (err) => /CONFLICT/.test(err.code)
    );
    await assert.rejects(
      () => Items.setItemStatusAsync(db, tenant, "PAR-ASYNC-1", "NOPE"),
      (err) => /INVALID/.test(err.code)
    );
    assert.equal((await Items.setItemStatusAsync(db, tenant, "PAR-ASYNC-1", "RELEASED")).status, "RELEASED");
  });

  test("deleteItemAsync blocks while revisions exist and removes otherwise", async () => {
    const guarded = await Items.createItemAsync(db, tenant, { item_number: "PAR-ASYNC-HASREV", name: "Guarded", item_type: "PART" });
    await Revisions.createRevisionAsync(db, tenant, guarded.item_ref, { revision_number: "A1" });
    await assert.rejects(
      () => Items.deleteItemAsync(db, tenant, guarded.item_ref),
      (err) => /ITEM/.test(err.code)
    );
    const temp = await Items.createItemAsync(db, tenant, { item_number: "PAR-ASYNC-DEL", name: "Temp", item_type: "PART" });
    const deleted = await Items.deleteItemAsync(db, tenant, temp.item_ref);
    assert.equal(deleted.deleted, true);
    await assert.rejects(() => Items.getItemAsync(db, tenant, temp.item_ref), (err) => /NOT_FOUND/.test(err.code));
  });

  test("revision async lifecycle matches the sync state machine", async () => {
    const rev = await Revisions.createRevisionAsync(db, tenant, "PAR-ASYNC-1", { revision_number: "A1" });
    assert.equal(rev.status, "DRAFT");
    assert.equal((await Revisions.setRevisionStatusAsync(db, tenant, rev.revision_ref, "IN_WORK")).status, "IN_WORK");
    assert.equal((await Revisions.setRevisionStatusAsync(db, tenant, rev.revision_ref, "IN_REVIEW")).status, "IN_REVIEW");
    assert.equal((await Revisions.setRevisionStatusAsync(db, tenant, rev.revision_ref, "RELEASED")).status, "RELEASED");
    await assert.rejects(
      () => Revisions.updateRevisionAsync(db, tenant, rev.revision_ref, { description: "nope" }),
      (err) => /IMMUTABLE/.test(err.code)
    );
    await assert.rejects(
      () => Revisions.createRevisionAsync(db, tenant, "PAR-ASYNC-1", { revision_number: "A1" }),
      (err) => /CONFLICT/.test(err.code)
    );
  });

  test("dataset and CAD async writers persist updates and deletes", async () => {
    const item = await Items.getItemRowAsync(db, tenant, "PAR-ASYNC-1");
    const rev = Revisions.listRevisions(db, { tenantId: tenant, itemRef: "PAR-ASYNC-1" }).items[0];
    const ds = await Datasets.createDatasetAsync(db, tenant, {
      dataset_number: "PAR-DS-1",
      name: "Async dataset",
      dataset_type: "CAD_MODEL",
      item_id: item.id,
      revision_id: rev.id,
    });
    assert.equal(ds.dataset_number, "PAR-DS-1");
    const renamed = await Datasets.updateDatasetAsync(db, tenant, ds.dataset_ref, { name: "Async dataset 2" });
    assert.equal(renamed.name, "Async dataset 2");

    const cad = await Cad.createCadAssociationAsync(db, tenant, {
      item_id: item.id,
      source_revision_id: rev.id,
      dataset_id: ds.id,
      source_object_id: "PAR-ASYNC-1:A1",
      cad_type: "NATIVE",
      association_type: "MASTER",
      is_primary: true,
    });
    assert.equal(cad.is_primary, true);
    assert.equal((await Cad.deleteCadAssociationAsync(db, tenant, cad.association_ref)).deleted, true);
    assert.equal((await Datasets.deleteDatasetAsync(db, tenant, ds.dataset_ref)).deleted, true);
  });

  test("relationship async writers create and delete mirrored relationships", async () => {
    const item = await Items.getItemRowAsync(db, tenant, "PAR-ASYNC-1");
    const rel = await Relationships.createRelationshipAsync(db, tenant, {
      relationship_type: "PRODUCT_HAS_PART",
      source_type: "ITEM",
      source_id: String(item.id),
      target_type: "ITEM",
      target_id: String(item.id),
    });
    assert.match(rel.relationship_ref, /^PDM-REL-/);
    assert.equal((await Relationships.deleteRelationshipAsync(db, tenant, rel.relationship_ref)).deleted, true);
  });

  test("baseline async writers enforce immutability after release", async () => {
    const item = await Items.getItemRowAsync(db, tenant, "PAR-ASYNC-1");
    const bl = await Baselines.createBaselineAsync(db, tenant, { baseline_number: "PAR-BL-1", name: "Async baseline" });
    assert.equal(bl.status, "DRAFT");
    const member = await Baselines.addBaselineMemberAsync(db, tenant, bl.baseline_ref, { member_type: "ITEM", member_id: item.id, level: 0 });
    assert.ok(member);
    assert.equal((await Baselines.releaseBaselineAsync(db, tenant, bl.baseline_ref)).status, "RELEASED");
    await assert.rejects(
      () => Baselines.addBaselineMemberAsync(db, tenant, bl.baseline_ref, { member_type: "ITEM", member_id: item.id }),
      (err) => /IMMUTABLE/.test(err.code)
    );
    await assert.rejects(
      () => Baselines.deleteBaselineAsync(db, tenant, bl.baseline_ref),
      (err) => /IMMUTABLE/.test(err.code)
    );
  });

  test("validation and configuration async writers persist results", async () => {
    assert.equal(await Configuration.setConfigAsync(db, tenant, "default_revision_status", "DRAFT"), "DRAFT");
    await assert.rejects(
      () => Configuration.setConfigAsync(db, tenant, "not_a_key", 1),
      (err) => /INVALID_CONFIGURATION/.test(err.code)
    );
    const run = await Validator.validateTenantAsync(db, tenant, { scope: "TENANT" });
    assert.ok(["PASS", "WARNING"].includes(run.status));
    const detail = await Validator.getValidationResultAsync(db, tenant, run.id);
    assert.equal(Number(detail.id), Number(run.id));
    assert.ok(Array.isArray(detail.issues));
  });
});
