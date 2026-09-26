process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate } from "../db.js";
import {
  Constants,
  Validation,
  Configuration,
  Items,
  Revisions,
  Foundation,
  ensurePdmFoundation,
} from "../services/pdm/index.js";

describe("PDM domain core services", () => {
  let db;
  const tenant = 1;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    db.prepare("INSERT INTO organizations (code, name, kind) VALUES ('test-org', 'Test Org', 'organization')").run();
    ensurePdmFoundation(db);
    Configuration.ensurePdmConfig(db, tenant);
  });

  after(() => {
    db?.close();
  });

  test("foundation installs the PDM domain idempotently", () => {
    const again = Foundation.ensurePdmFoundation(db);
    assert.ok(again);
    const config = Configuration.listConfig(db, tenant);
    assert.equal(config.default_item_status, "DRAFT");
    assert.equal(config.enforce_unique_item_number, true);
  });

  test("exposes a coherent capability vocabulary", () => {
    const vocab = Validation.vocabulary();
    assert.equal(Constants.SOURCE_MODULE, "pdm");
    assert.ok(Constants.ITEM_TYPES.includes("PART"));
    assert.ok(Constants.ITEM_TYPES.includes("PRODUCT"));
    assert.ok(Constants.REVISION_RULE_TYPES.includes("LATEST_RELEASED"));
    assert.ok(Constants.DATASET_TYPES.includes("CAD_MODEL"));
    assert.ok(Constants.RELATIONSHIP_TYPES.some((entry) => entry.code === "PRODUCT_HAS_PART"));
    assert.ok(Array.isArray(vocab.item_types));
  });

  test("creates items and rejects duplicates", () => {
    const item = Items.createItem(db, tenant, { item_number: "CORE-ITEM-001", name: "Core item", item_type: "PART" });
    assert.equal(item.item_number, "CORE-ITEM-001");
    assert.equal(item.item_type, "PART");
    assert.equal(item.status, "DRAFT");
    assert.match(item.item_ref, /^PDM-ITEM-/);

    assert.throws(
      () => Items.createItem(db, tenant, { item_number: "CORE-ITEM-001", name: "dup", item_type: "PART" }),
      (err) => err.code === "PDM_ITEM_CONFLICT"
    );
  });

  test("validates item input", () => {
    assert.throws(
      () => Items.createItem(db, tenant, { item_number: "", name: "no number", item_type: "PART" }),
      (err) => err.code === "PDM_INVALID_ITEM"
    );
    assert.throws(
      () => Items.createItem(db, tenant, { item_number: "CORE-BAD-TYPE", name: "bad", item_type: "NOPE" }),
      (err) => err.code === "PDM_INVALID_ITEM"
    );
  });

  test("revisions follow the lifecycle and become immutable", () => {
    const item = Items.getItem(db, tenant, "CORE-ITEM-001");
    const rev = Revisions.createRevision(db, tenant, item.item_ref, { revision_number: "A1" });
    assert.equal(rev.revision_number, "A1");
    assert.equal(rev.status, "DRAFT");
    assert.match(rev.revision_ref, /^PDM-REV-/);

    assert.throws(
      () => Revisions.setRevisionStatus(db, tenant, rev.revision_ref, "RELEASED"),
      (err) => err.code === "PDM_REVISION_STATUS_INVALID"
    );

    assert.equal(Revisions.setRevisionStatus(db, tenant, rev.revision_ref, "IN_WORK").status, "IN_WORK");
    assert.equal(Revisions.setRevisionStatus(db, tenant, rev.revision_ref, "IN_REVIEW").status, "IN_REVIEW");
    assert.equal(Revisions.setRevisionStatus(db, tenant, rev.revision_ref, "RELEASED").status, "RELEASED");

    assert.throws(
      () => Revisions.updateRevision(db, tenant, rev.revision_ref, { description: "nope" }),
      (err) => err.code === "PDM_REVISION_IMMUTABLE"
    );
  });

  test("rejects duplicate revision numbers on the same item", () => {
    const item = Items.getItem(db, tenant, "CORE-ITEM-001");
    assert.throws(
      () => Revisions.createRevision(db, tenant, item.item_ref, { revision_number: "A1" }),
      (err) => err.code === "PDM_REVISION_CONFLICT"
    );
  });

  test("config is validated and reusable", () => {
    assert.equal(Configuration.setConfig(db, tenant, "default_revision_status", "DRAFT"), "DRAFT");
    assert.equal(Configuration.getConfig(db, tenant, "default_revision_status"), "DRAFT");
    assert.throws(
      () => Configuration.setConfig(db, tenant, "not_a_key", 1),
      (err) => err.code === "PDM_INVALID_CONFIGURATION"
    );
  });

  test("standardized 404 for unknown items and revisions", () => {
    assert.throws(
      () => Items.getItem(db, tenant, "DOES-NOT-EXIST"),
      (err) => err.code === "PDM_ITEM_NOT_FOUND"
    );
    assert.throws(
      () => Revisions.getRevision(db, tenant, "PDM-REV-NOPE"),
      (err) => err.code === "PDM_REVISION_NOT_FOUND"
    );
  });
});
