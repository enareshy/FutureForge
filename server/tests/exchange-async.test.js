process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { ExchangeError } from "../services/exchange/errors.js";
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
  Adapters,
  Seed,
} from "../services/exchange/index.js";

const ACTOR = { id: 1, username: "admin" };
const IP = "127.0.0.1";

const PART_PAYLOAD = JSON.stringify({
  records: [
    {
      external_id: "XCH-ASY-PART-1",
      name: "Exchange async bracket",
      attributes: {
        "part.number": "XCH-ASY-PART-1",
        "part.name": "Exchange async bracket",
        "part.category": "mechanical",
        "part.status": "draft",
      },
    },
  ],
});

function isExchangeError(err, code) {
  return err instanceof ExchangeError && err.code === code;
}

describe("Standards & Exchange async twins mirror the sync layer", () => {
  let db;
  let tenant;
  let seq = 0;
  const nextCode = (prefix) => {
    seq += 1;
    return `${prefix}_ASY${String(seq).padStart(3, "0")}`;
  };

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    tenant = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    await Foundation.ensureExchangeFoundationAsync(db);
  });

  after(() => {
    db?.close();
  });

  test("boots the foundation and reports health asynchronously", async () => {
    const adapters = Adapters.adapterCatalog().map((entry) => entry.code);
    for (const code of ["json", "xml", "edi-x12", "bom", "step-ap242"]) {
      assert.ok(adapters.includes(code));
    }
    const formats = await Formats.listFormatsAsync(db, tenant, { page_size: 100 });
    assert.equal(formats.total, 8);
    const health = { ...(await Metrics.healthCheckAsync(db, tenant)), ...(await Foundation.exchangeHealthAsync(db, tenant)) };
    assert.equal(health.source_module, "exchange");
    assert.ok(Number(health.counts.formats) >= 8);
  });

  test("detects JSON and refuses unknown content asynchronously", async () => {
    const detected = await Detection.detectFormatAsync(db, tenant, { payload: PART_PAYLOAD });
    assert.equal(detected.detected, true);
    assert.equal(detected.format.code, "JSON");
    const unknown = await Detection.detectFormatAsync(db, tenant, { payload: "not an exchange document" });
    assert.equal(unknown.detected, false);
  });

  test("creates, updates, versions and deletes a format asynchronously", async () => {
    const code = nextCode("FMT");
    const created = await Formats.createFormatAsync(db, tenant, { code, name: "Async format", adapter_code: "json", direction: "IMPORT" }, ACTOR, IP);
    assert.equal(created.code, code);
    const fetched = await Formats.getFormatAsync(db, tenant, code);
    assert.equal(fetched.id, created.id);
    const updated = await Formats.updateFormatAsync(db, tenant, code, { name: "Async format v2" }, ACTOR);
    assert.equal(updated.name, "Async format v2");
    const version = await Formats.createFormatVersionAsync(db, tenant, code, { change_summary: "async" }, ACTOR);
    assert.ok(version);
    const versions = await Formats.listFormatVersionsAsync(db, tenant, code);
    assert.ok(versions.total >= 1);
    await Formats.deleteFormatAsync(db, tenant, code);
    await assert.rejects(() => Formats.getFormatAsync(db, tenant, code), (err) => isExchangeError(err, "EXCHANGE_FORMAT_NOT_FOUND"));
  });

  test("lists, creates, publishes and versions definitions asynchronously", async () => {
    const defs = await Definitions.listDefinitionsAsync(db, tenant, { page_size: 100 });
    assert.ok(defs.items.some((entry) => entry.code === "JSON_PART_IMPORT"));
    const summary = await Definitions.definitionSummaryAsync(db, tenant);
    assert.ok(summary.total >= 2);

    const code = nextCode("DEF");
    const created = await Definitions.createDefinitionAsync(db, tenant, { code, name: "Async definition", format_code: "JSON", direction: "IMPORT", target_object_type: "part" }, ACTOR);
    assert.equal(created.version, 1);
    await Definitions.publishDefinitionAsync(db, tenant, created.id, { change_summary: "async" }, ACTOR);
    const updated = await Definitions.updateDefinitionAsync(db, tenant, created.id, { name: "Async definition v2" }, ACTOR);
    assert.equal(updated.version, 2);
    assert.equal(updated.status, "DRAFT");
    const versions = await Definitions.listDefinitionVersionsAsync(db, tenant, created.id);
    assert.ok(versions.total >= 1);
    const version = await Definitions.getDefinitionVersionAsync(db, tenant, created.id, 1);
    assert.equal(version.version, 1);
  });

  test("applies mapping and transformation profiles asynchronously", async () => {
    const mapped = await Mappings.applyMappingRecordAsync(db, tenant, "JSON_PART_MAPPING", {
      external_id: "XCH-ASY-PART-1",
      name: "Exchange async bracket",
      attributes: { "part.number": "XCH-ASY-PART-1" },
    });
    assert.equal(mapped.target.code, "XCH-ASY-PART-1");
    assert.equal(mapped.target.name, "Exchange async bracket");

    const code = nextCode("TRF");
    const created = await Transformations.createTransformationAsync(
      db,
      tenant,
      { code, name: "Uppercase name", format_code: "JSON", direction: "IMPORT", steps: [{ sequence: 10, target_field: "name", transformation_type: "UPPERCASE" }] },
      ACTOR
    );
    const check = await Transformations.validateTransformationAsync(db, tenant, created.id);
    assert.equal(check.valid, true);
    const applied = await Transformations.applyTransformationProfileAsync(db, tenant, created.id, { name: "bracket" });
    assert.equal(applied.target.name, "BRACKET");
  });

  test("manages validation profiles and their rules asynchronously", async () => {
    const code = nextCode("VAL");
    const profile = await Validation.createValidationProfileAsync(
      db,
      tenant,
      {
        code,
        name: "Async validation",
        format_code: "JSON",
        direction: "IMPORT",
        target_object_type: "part",
        rules: [{ sequence: 10, level: "ENTERPRISE", target_field: "external_id", rule_type: "REQUIRED", severity: "ERROR" }],
      },
      ACTOR
    );
    assert.equal(profile.rules.length, 1);
    const withRule = await Validation.addValidationRuleAsync(
      db,
      tenant,
      profile.id,
      { sequence: 20, level: "FILE", target_field: "name", rule_type: "LENGTH", config: { max: 10 }, severity: "WARNING" },
      ACTOR
    );
    assert.equal(withRule.rules.length, 2);
    const listed = await Validation.listValidationProfilesAsync(db, tenant, { page_size: 100 });
    assert.ok(listed.items.some((entry) => entry.id === profile.id));
    await Validation.deleteValidationRuleAsync(db, tenant, profile.id, withRule.rules[1].id);
    const reloaded = await Validation.getValidationProfileAsync(db, tenant, profile.id);
    assert.equal(reloaded.rules.length, 1);
  });

  test("preview and dry-run never write enterprise data asynchronously", async () => {
    const before = queryOne(db, "SELECT COUNT(*) AS c FROM objects WHERE tenant_id = ?", [tenant]).c;
    const preview = await Processor.executeAsync(
      db,
      tenant,
      { direction: "IMPORT", operation: "PREVIEW", definition_code: "JSON_PART_IMPORT", payload: PART_PAYLOAD },
      ACTOR,
      { ip: IP }
    );
    assert.equal(preview.status, "PREVIEW");
    assert.equal(preview.output.preview, true);
    const dry = await Processor.executeAsync(
      db,
      tenant,
      { direction: "IMPORT", operation: "DRY_RUN", definition_code: "JSON_PART_IMPORT", payload: PART_PAYLOAD },
      ACTOR,
      { ip: IP }
    );
    assert.equal(dry.output.dry_run, true);
    const after = queryOne(db, "SELECT COUNT(*) AS c FROM objects WHERE tenant_id = ?", [tenant]).c;
    assert.equal(after, before);
  });

  test("executes an import, exports it and reads transactions asynchronously", async () => {
    const imported = await Processor.executeAsync(
      db,
      tenant,
      { direction: "IMPORT", operation: "EXECUTE", definition_code: "JSON_PART_IMPORT", payload: PART_PAYLOAD },
      ACTOR,
      { ip: IP }
    );
    assert.equal(imported.status, "COMPLETED");
    assert.equal(imported.counts.records_created, 1);

    const fetched = await Processor.getTransactionAsync(db, tenant, imported.transaction_ref);
    assert.equal(fetched.transaction_ref, imported.transaction_ref);
    const list = await Processor.listTransactionsAsync(db, tenant, { page_size: 50 });
    assert.ok(list.total >= 1);
    const summary = await Processor.transactionSummaryAsync(db, tenant);
    assert.ok(summary.total >= 1);

    const exported = await Processor.executeAsync(
      db,
      tenant,
      { direction: "EXPORT", operation: "EXPORT", definition_code: "JSON_PART_EXPORT", object_type: "part" },
      ACTOR,
      { ip: IP }
    );
    assert.equal(exported.status, "COMPLETED");
    assert.ok(exported.output.size > 0);
    assert.equal(exported.output.mime_type, "application/json");
    const present = await Processor.getTransactionAsync(db, tenant, exported.id);
    assert.equal(present.transaction_ref, exported.transaction_ref);
    const byRef = await Processor.getTransactionAsync(db, tenant, exported.transaction_ref);
    assert.equal(byRef.id, exported.id);
  });

  test("rejects cancel on a terminal transaction asynchronously", async () => {
    const result = await Processor.executeAsync(
      db,
      tenant,
      { direction: "IMPORT", operation: "EXECUTE", definition_code: "JSON_PART_IMPORT", payload: PART_PAYLOAD },
      ACTOR,
      { ip: IP }
    );
    assert.equal(result.status, "COMPLETED");
    await assert.rejects(() => Processor.cancelTransactionAsync(db, tenant, result.transaction_ref, ACTOR), (err) => isExchangeError(err, "EXCHANGE_TRANSACTION_IMMUTABLE"));
    await assert.rejects(() => Processor.getTransactionAsync(db, tenant, "does-not-exist"), (err) => isExchangeError(err, "EXCHANGE_TRANSACTION_NOT_FOUND"));
  });

  test("is idempotent for a repeated idempotency key asynchronously", async () => {
    const key = nextCode("IDEM");
    const first = await Processor.executeAsync(
      db,
      tenant,
      { direction: "IMPORT", operation: "EXECUTE", definition_code: "JSON_PART_IMPORT", payload: PART_PAYLOAD, idempotency_key: key },
      ACTOR,
      { ip: IP }
    );
    const second = await Processor.executeAsync(
      db,
      tenant,
      { direction: "IMPORT", operation: "EXECUTE", definition_code: "JSON_PART_IMPORT", payload: PART_PAYLOAD, idempotency_key: key },
      ACTOR,
      { ip: IP }
    );
    assert.equal(second.idempotent_replay, true);
    assert.equal(second.transaction_ref, first.transaction_ref);
  });

  test("records reconciliation, history and errors asynchronously", async () => {
    const run = await Processor.executeAsync(
      db,
      tenant,
      { direction: "IMPORT", operation: "EXECUTE", definition_code: "JSON_PART_IMPORT", payload: PART_PAYLOAD },
      ACTOR,
      { ip: IP }
    );
    assert.equal(run.status, "COMPLETED");
    const reconciliations = await Reconciliation.listReconciliationsAsync(db, tenant, { page_size: 50 });
    assert.ok(reconciliations.total >= 1);
    const recon = await Reconciliation.getReconciliationAsync(db, tenant, reconciliations.items[0].reconciliation_ref);
    assert.ok(recon.records_read >= 1);
    const recomputed = await Reconciliation.reconcileTransactionAsync(db, tenant, run.transaction_ref, { actor: ACTOR, ip: IP });
    assert.ok(recomputed.reconciliation.reconciliation_ref);

    const history = await History.listHistoryAsync(db, { tenantId: tenant, page_size: 50 });
    assert.ok(history.total >= 1);
    const timeline = await History.transactionTimelineAsync(db, tenant, run.transaction_ref);
    assert.ok(timeline.length >= 1);
    const errors = await History.listErrorsAsync(db, { tenantId: tenant, page_size: 50 });
    assert.ok(Array.isArray(errors.items));
    const errSummary = await History.errorSummaryAsync(db, tenant, null);
    assert.ok(errSummary);
  });

  test("manages configuration within bounds and snapshots metrics asynchronously", async () => {
    const defaults = await Configuration.listConfigAsync(db, tenant);
    assert.ok(defaults.duplicate_strategy);
    const updated = await Configuration.setConfigAsync(db, tenant, "duplicate_strategy", "skip", ACTOR, IP);
    assert.equal(String(updated).toUpperCase(), "SKIP");
    await assert.rejects(() => Configuration.setConfigAsync(db, tenant, "max_records", 99999999, ACTOR, IP), () => true);
    const snapshot = await Metrics.metricsSnapshotAsync(db, tenant);
    assert.ok(snapshot);
    const throughput = await Metrics.throughputAsync(db, tenant, { limit: 5 });
    assert.ok(throughput);
  });

  test("refuses a planned CAD adapter honestly asynchronously", async () => {
    const code = nextCode("STEP");
    const definition = await Definitions.createDefinitionAsync(
      db,
      tenant,
      { code, name: "STEP async import", format_code: "STEP_AP242", direction: "IMPORT", target_object_type: "part" },
      ACTOR
    );
    const result = await Processor.executeAsync(db, tenant, { direction: "IMPORT", definition_code: definition.id, payload: "ISO-10303-21;" }, ACTOR, { ip: IP });
    assert.equal(result.status, "FAILED");
    assert.equal(result.error.code, "EXCHANGE_ADAPTER_UNAVAILABLE");
  });

  test("seeds demo artifacts asynchronously", async () => {
    const result = await Seed.seedExchangeAsync(db, tenant);
    assert.ok(result);
    const defs = await Definitions.listDefinitionsAsync(db, tenant, { page_size: 100 });
    assert.ok(defs.items.some((entry) => entry.code === "JSON_PART_IMPORT"));
  });

  test("exposes the platform vocabulary through meta constants", async () => {
    assert.equal(Constants.SOURCE_MODULE, "exchange");
    assert.ok(Constants.OPERATIONS.includes("EXECUTE"));
    assert.equal(Constants.SEARCH_OBJECT_TYPES.length, 3);
  });
});
