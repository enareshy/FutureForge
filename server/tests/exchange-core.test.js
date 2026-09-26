process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne, queryAll } from "../db.js";
import { seedDatabase } from "../seed.js";
import {
  Constants,
  Formats,
  Detection,
  Definitions,
  Mappings,
  Transformations,
  Validation,
  Processor,
  Reconciliation,
  History,
  Metrics,
  Configuration,
  Foundation,
  Integrations,
  Adapters,
  ensureExchangeFoundation,
} from "../services/exchange/index.js";

const ACTOR = { id: 1, username: "admin" };
const IP = "127.0.0.1";

const PART_PAYLOAD = JSON.stringify({
  records: [
    {
      external_id: "XCH-PART-1",
      name: "Exchange bracket",
      attributes: {
        "part.number": "XCH-PART-1",
        "part.name": "Exchange bracket",
        "part.category": "mechanical",
        "part.status": "draft",
      },
    },
  ],
});

describe("Standards & Exchange core services", () => {
  let db;
  let tenant;

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    ensureExchangeFoundation(db);
  });

  after(() => {
    db?.close();
  });

  test("registers the full adapter and format catalog", () => {
    const catalog = Adapters.adapterCatalog();
    const codes = catalog.map((entry) => entry.code);
    for (const code of ["json", "xml", "edi-x12", "bom", "step-ap242", "jt", "pdfa", "cad"]) {
      assert.ok(codes.includes(code), `adapter ${code} is registered`);
    }
    const formats = Formats.listFormats(db, tenant, { page_size: 100 });
    assert.equal(formats.total, 8);
    const format = formats.items.find((entry) => entry.code === "JSON");
    assert.equal(format.adapter_code, "json");
  });

  test("exposes enterprise integrations and never builds a second object engine", () => {
    const integrations = Integrations.listIntegrations().map((entry) => entry.code);
    assert.deepEqual(integrations.sort(), ["bom", "object", "pdm"]);
  });

  test("detects a JSON payload and refuses unknown content", () => {
    const detected = Detection.detectFormat(db, tenant, { payload: PART_PAYLOAD });
    assert.equal(detected.detected, true);
    assert.equal(detected.format.code, "JSON");
    const unknown = Detection.detectFormat(db, tenant, { payload: "not an exchange document" });
    assert.equal(unknown.detected, false);
  });

  test("seeds reusable exchange definitions", () => {
    const defs = Definitions.listDefinitions(db, tenant, { page_size: 100 });
    const codes = defs.items.map((entry) => entry.code);
    assert.ok(codes.includes("JSON_PART_IMPORT"));
    assert.ok(codes.includes("JSON_PART_EXPORT"));
    const summary = Definitions.definitionSummary(db, tenant);
    assert.ok(summary.total >= 2);
  });

  test("published definitions are immutable and roll forward a new version", () => {
    const created = Definitions.createDefinition(
      db,
      tenant,
      { code: "XCH_TEST_DEF", name: "Test definition", format_code: "JSON", direction: "IMPORT", target_object_type: "part" },
      ACTOR
    );
    assert.equal(created.version, 1);
    Definitions.publishDefinition(db, tenant, created.id, { change_summary: "test" }, ACTOR);
    const updated = Definitions.updateDefinition(db, tenant, created.id, { name: "Test definition v2" }, ACTOR);
    assert.equal(updated.version, 2);
    assert.equal(updated.status, "DRAFT");
    assert.equal(updated.name, "Test definition v2");
    const versions = Definitions.listDefinitionVersions(db, tenant, created.id);
    assert.ok(versions.total >= 1);
  });

  test("applies a seeded mapping profile to a canonical record", () => {
    const result = Mappings.applyMappingRecord(db, tenant, "JSON_PART_MAPPING", {
      external_id: "XCH-PART-1",
      name: "Exchange bracket",
      attributes: { "part.number": "XCH-PART-1" },
    });
    assert.equal(result.target.code, "XCH-PART-1");
    assert.equal(result.target.name, "Exchange bracket");
    assert.equal(result.target.attributes["part.number"], "XCH-PART-1");
  });

  test("validates and applies transformation profiles through the shared engine", () => {
    const created = Transformations.createTransformation(
      db,
      tenant,
      {
        code: "XCH_TEST_TRF",
        name: "Uppercase name",
        format_code: "JSON",
        direction: "IMPORT",
        steps: [{ sequence: 10, target_field: "name", transformation_type: "UPPERCASE" }],
      },
      ACTOR
    );
    const check = Transformations.validateTransformation(db, tenant, created.id);
    assert.equal(check.valid, true);
    const applied = Transformations.applyTransformationProfile(db, tenant, created.id, { name: "bracket" });
    assert.equal(applied.target.name, "BRACKET");
  });

  test("manages validation profiles and their rules", () => {
    const profile = Validation.createValidationProfile(
      db,
      tenant,
      {
        code: "XCH_TEST_VAL",
        name: "Test validation",
        format_code: "JSON",
        direction: "IMPORT",
        target_object_type: "part",
        rules: [{ sequence: 10, level: "ENTERPRISE", target_field: "external_id", rule_type: "REQUIRED", severity: "ERROR" }],
      },
      ACTOR
    );
    assert.equal(profile.rules.length, 1);
    const withRule = Validation.addValidationRule(
      db,
      tenant,
      profile.id,
      { sequence: 20, level: "FILE", target_field: "name", rule_type: "LENGTH", config: { max: 10 }, severity: "WARNING" },
      ACTOR
    );
    assert.equal(withRule.rules.length, 2);
  });

  test("preview never writes enterprise data", () => {
    const before = queryOne(db, "SELECT COUNT(*) AS c FROM objects WHERE tenant_id = ?", [tenant]).c;
    const result = Processor.execute(
      db,
      tenant,
      { direction: "IMPORT", operation: "PREVIEW", definition_code: "JSON_PART_IMPORT", payload: PART_PAYLOAD },
      ACTOR,
      { ip: IP }
    );
    assert.equal(result.status, "PREVIEW");
    assert.equal(result.output.preview, true);
    const after = queryOne(db, "SELECT COUNT(*) AS c FROM objects WHERE tenant_id = ?", [tenant]).c;
    assert.equal(after, before);
  });

  test("dry-run reports the intended action without applying it", () => {
    const before = queryOne(db, "SELECT COUNT(*) AS c FROM objects WHERE tenant_id = ?", [tenant]).c;
    const result = Processor.execute(
      db,
      tenant,
      { direction: "IMPORT", operation: "DRY_RUN", definition_code: "JSON_PART_IMPORT", payload: PART_PAYLOAD },
      ACTOR,
      { ip: IP }
    );
    assert.ok(["COMPLETED", "PREVIEW"].includes(result.status));
    assert.equal(result.output.dry_run, true);
    const after = queryOne(db, "SELECT COUNT(*) AS c FROM objects WHERE tenant_id = ?", [tenant]).c;
    assert.equal(after, before);
  });

  test("execute imports the payload and records reconciliation", () => {
    const result = Processor.execute(
      db,
      tenant,
      { direction: "IMPORT", operation: "EXECUTE", definition_code: "JSON_PART_IMPORT", payload: PART_PAYLOAD },
      ACTOR,
      { ip: IP }
    );
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.counts.records_created, 1);
    const records = Reconciliation.listReconciliations(db, tenant, { page_size: 50 });
    assert.ok(records.total >= 1);
    const recon = Reconciliation.getReconciliation(db, tenant, records.items[0].reconciliation_ref);
    assert.ok(recon.records_read >= 1);
  });

  test("execute is idempotent for a repeated idempotency key", () => {
    const key = "idem-test-key";
    const first = Processor.execute(
      db,
      tenant,
      { direction: "IMPORT", operation: "EXECUTE", definition_code: "JSON_PART_IMPORT", payload: PART_PAYLOAD, idempotency_key: key },
      ACTOR,
      { ip: IP }
    );
    const second = Processor.execute(
      db,
      tenant,
      { direction: "IMPORT", operation: "EXECUTE", definition_code: "JSON_PART_IMPORT", payload: PART_PAYLOAD, idempotency_key: key },
      ACTOR,
      { ip: IP }
    );
    assert.equal(second.idempotent_replay, true);
    assert.equal(second.transaction_ref, first.transaction_ref);
  });

  test("exports enterprise objects through an export definition", () => {
    const result = Processor.execute(
      db,
      tenant,
      { direction: "EXPORT", operation: "EXPORT", definition_code: "JSON_PART_EXPORT", object_type: "part" },
      ACTOR,
      { ip: IP }
    );
    assert.equal(result.status, "COMPLETED");
    assert.ok(result.output.size > 0);
    assert.equal(result.output.mime_type, "application/json");
  });

  test("records history, errors and transaction summaries", () => {
    const history = History.listHistory(db, { tenantId: tenant, page_size: 50 });
    assert.ok(history.total >= 1);
    const summary = Processor.transactionSummary(db, tenant);
    assert.ok(summary.total >= 1);
    const health = { ...Metrics.healthCheck(db, tenant), ...Foundation.exchangeHealth(db, tenant) };
    assert.equal(health.source_module, "exchange");
  });

  test("honours configurable exchange settings within bounds", () => {
    const defaults = Configuration.listConfig(db, tenant);
    assert.ok(defaults.duplicate_strategy);
    const updated = Configuration.setConfig(db, tenant, "duplicate_strategy", "skip", ACTOR, IP);
    assert.equal(String(updated).toUpperCase(), "SKIP");
    assert.throws(() => Configuration.setConfig(db, tenant, "max_records", 99999999, ACTOR, IP));
  });

  test("refuses a planned CAD adapter honestly", () => {
    const definition = Definitions.createDefinition(
      db,
      tenant,
      { code: "XCH_STEP_DEF", name: "STEP import", format_code: "STEP_AP242", direction: "IMPORT", target_object_type: "part" },
      ACTOR
    );
    const result = Processor.execute(db, tenant, { direction: "IMPORT", definition_code: definition.id, payload: "ISO-10303-21;" }, ACTOR, { ip: IP });
    assert.equal(result.status, "FAILED");
    assert.equal(result.error.code, "EXCHANGE_ADAPTER_UNAVAILABLE");
  });

  test("exposes the platform vocabulary through meta constants", () => {
    assert.equal(Constants.SOURCE_MODULE, "exchange");
    assert.ok(Constants.OPERATIONS.includes("EXECUTE"));
    assert.ok(Constants.OPERATIONS.includes("PREVIEW"));
    assert.ok(Constants.DIRECTIONS.includes("BOTH"));
    assert.equal(Constants.SEARCH_OBJECT_TYPES.length, 3);
  });
});
