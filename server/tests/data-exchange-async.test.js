process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { migrate, queryOne, openTestDatabase } from "../db.js";
import { seedDatabase } from "../seed.js";
import { DataExchangeError } from "../services/data-exchange/errors.js";
import * as ConnectorConfigs from "../services/data-exchange/connector-configs.js";
import * as ImportDefinitions from "../services/data-exchange/import-definitions.js";
import * as ExportDefinitions from "../services/data-exchange/export-definitions.js";
import * as Templates from "../services/data-exchange/templates.js";
import * as Seed from "../services/data-exchange/seed.js";
import * as Jobs from "../services/data-exchange/jobs.js";
import * as Importer from "../services/data-exchange/importer.js";
import * as Exporter from "../services/data-exchange/exporter.js";
import * as Lifecycle from "../services/data-exchange/lifecycle.js";
import * as Quality from "../services/data-exchange/quality.js";
import * as Catalog from "../services/data-exchange/catalog.js";
import * as Metrics from "../services/data-exchange/metrics.js";
import * as Configuration from "../services/data-exchange/configuration.js";
import * as History from "../services/data-exchange/history.js";
import * as Foundation from "../services/data-exchange/foundation.js";

const MAPPINGS = [
  { source_field: "part_number", target_field: "code", mapping_type: "DIRECT", required: true },
  { source_field: "part_number", target_field: "part.number", mapping_type: "DIRECT", required: true },
  { source_field: "part_name", target_field: "name", mapping_type: "DIRECT", required: true },
  { source_field: "part_name", target_field: "part.name", mapping_type: "DIRECT", required: true },
  { source_field: "part_category", target_field: "part.category", mapping_type: "DIRECT", required: true },
];

function csvOf(...lines) {
  return `part_number,part_name,part_category,notes,state\n${lines.join("\n")}\n`;
}

function isExchangeError(err, status, code) {
  return err instanceof DataExchangeError && err.status === status && err.code === code;
}

describe("data-exchange async services mirror the sync layer", () => {
  let db;
  let tenantId;
  let actor;
  let seq = 0;
  const nextCode = (prefix) => {
    seq += 1;
    return `${prefix}_ASYNC${String(seq).padStart(3, "0")}`;
  };

  before(async () => {
    db = openTestDatabase();
    migrate(db);
    seedDatabase(db);
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    actor = { id: row.id, username: row.username };
    await Foundation.ensureExchangeFoundationAsync(db);
  });

  after(() => db?.close());

  test("async foundation is idempotent and reports health", async () => {
    const again = await Foundation.ensureExchangeFoundationAsync(db);
    assert.equal(again.source_module, "data-exchange");
    assert.ok(Array.isArray(again.connectors.registered) || typeof again.connectors.registered === "number");
    assert.equal(again.event_types, 0);
    assert.ok(again.tenants >= 1);

    const health = await Foundation.exchangeHealthAsync(db, tenantId);
    assert.equal(health.source_module, "data-exchange");
    assert.ok(health.counts.import_definitions >= 1);
    assert.ok((await Metrics.healthCheckAsync(db, { tenantId })).status === "healthy");
  });

  test("async configuration reads, writes and enforces bounds", async () => {
    const config = await Configuration.listConfigAsync(db, tenantId);
    assert.equal(typeof config.default_batch_size, "number");
    await assert.rejects(() => Configuration.setConfigAsync(db, tenantId, "default_batch_size", 0, actor), (err) => err.status === 400);
    assert.equal(await Configuration.setConfigAsync(db, tenantId, "default_batch_size", 250, actor), 250);
    assert.equal(await Configuration.getConfigAsync(db, tenantId, "default_batch_size"), 250);
    assert.equal((await Configuration.ensureExchangeConfigAsync(db, tenantId)).created, 0);
  });

  test("async connector configurations mirror create/get/list/update/status", async () => {
    const code = nextCode("CONN");
    const created = await ConnectorConfigs.createConnectorConfigurationAsync(
      db,
      tenantId,
      { code, name: "Async CSV", connector_type: "CSV", direction: "SOURCE", settings: { delimiter: ",", has_header: true } },
      actor
    );
    assert.equal(created.code, code);
    assert.deepEqual(created.settings, { delimiter: ",", has_header: true });

    const fetched = await ConnectorConfigs.getConnectorConfigurationAsync(db, tenantId, code);
    assert.equal(fetched.id, created.id);

    const listed = await ConnectorConfigs.listConnectorConfigurationsAsync(db, { tenantId, connectorType: "CSV" });
    assert.ok(listed.items.some((item) => item.code === code));

    const updated = await ConnectorConfigs.updateConnectorConfigurationAsync(db, tenantId, code, { name: "Renamed", settings: { delimiter: ";" } }, actor);
    assert.equal(updated.name, "Renamed");
    assert.deepEqual(updated.settings, { delimiter: ";" });

    const inactive = await ConnectorConfigs.setConnectorConfigurationStatusAsync(db, tenantId, code, "inactive", actor);
    assert.equal(inactive.status, "inactive");

    await assert.rejects(
      () => ConnectorConfigs.createConnectorConfigurationAsync(db, tenantId, { code, name: "Dup", connector_type: "CSV" }, actor),
      (err) => isExchangeError(err, 400, "INVALID_DATA_EXCHANGE_CONNECTOR")
    );
    await assert.rejects(() => ConnectorConfigs.getConnectorConfigurationAsync(db, tenantId, "NO_SUCH"), (err) => isExchangeError(err, 404, "DATA_EXCHANGE_CONNECTOR_NOT_FOUND"));
  });

  test("async import definitions create, version, list and validate", async () => {
    const code = nextCode("IMPDEF");
    const created = await ImportDefinitions.createImportDefinitionAsync(
      db,
      tenantId,
      {
        code,
        name: "Async widget import",
        target_object_type: "product",
        source_type: "CSV",
        mappings: MAPPINGS,
        transformations: [{ stage: "FIELD", target_field: "name", transformation_type: "TRIM" }],
        validation_rules: [{ level: "FIELD", target_field: "part.number", rule_type: "REQUIRED" }],
        duplicate_strategy: "UPSERT",
        duplicate_key: { type: "BUSINESS_KEY", fields: ["code"] },
        status: "ACTIVE",
      },
      actor
    );
    assert.equal(created.version, 1);
    assert.equal(created.mappings.length, MAPPINGS.length);

    const fetched = await ImportDefinitions.getImportDefinitionAsync(db, tenantId, code);
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.transformations[0].transformation_type, "TRIM");

    const versioned = await ImportDefinitions.createImportDefinitionVersionAsync(db, tenantId, code, { name: "Async widget import v2" }, actor);
    assert.ok(versioned.version >= 2);

    const versions = await ImportDefinitions.listImportDefinitionVersionsAsync(db, tenantId, code);
    assert.ok(versions.length >= 2 || versions.items?.length >= 2);

    const validated = await ImportDefinitions.validateImportDefinitionAsync(db, tenantId, code);
    assert.equal(typeof validated.valid, "boolean");

    const list = await ImportDefinitions.listImportDefinitionsAsync(db, { tenantId, q: code });
    assert.ok(list.items.some((item) => item.code === code));

    await assert.rejects(() => ImportDefinitions.getImportDefinitionAsync(db, tenantId, "NO_SUCH_DEF"), (err) => isExchangeError(err, 404, "DATA_EXCHANGE_DEFINITION_NOT_FOUND"));
  });

  test("async export definitions and templates mirror the sync surface", async () => {
    const exportCode = nextCode("EXPDEF");
    const created = await ExportDefinitions.createExportDefinitionAsync(
      db,
      tenantId,
      {
        code: exportCode,
        name: "Async part export",
        object_type: "product",
        format: "CSV",
        destination: "DOWNLOAD",
        field_selections: [
          { field_path: "code", display_name: "Part Number", data_type: "string" },
          { field_path: "name", display_name: "Part Name", data_type: "string" },
        ],
        status: "ACTIVE",
      },
      actor
    );
    assert.equal(created.format, "CSV");
    const fetched = await ExportDefinitions.getExportDefinitionAsync(db, tenantId, exportCode);
    assert.equal(fetched.id, created.id);
    const validated = await ExportDefinitions.validateExportDefinitionAsync(db, tenantId, exportCode);
    assert.equal(typeof validated.valid, "boolean");

    const templateCode = nextCode("TPL");
    const template = await Templates.createTemplateAsync(
      db,
      tenantId,
      { code: templateCode, name: "Async template", direction: "IMPORT", object_type: "product", status: "ACTIVE", definition: { mappings: MAPPINGS } },
      actor
    );
    assert.equal(template.code, templateCode);
    const fetchedTemplate = await Templates.getTemplateAsync(db, tenantId, templateCode);
    assert.equal(fetchedTemplate.id, template.id);
    const templateList = await Templates.listTemplatesAsync(db, { tenantId, q: templateCode });
    assert.ok(templateList.items.some((item) => item.code === templateCode));
  });

  test("async import runs end-to-end and reconciles", async () => {
    const definition = await ImportDefinitions.getImportDefinitionAsync(db, tenantId, "PART_IMPORT");
    const code = "DX-ASYNC-OK-1";
    const { job, existing } = await Importer.createImportJobAsync(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
    assert.equal(existing, false);
    const result = await Importer.runImportJobAsync(db, { jobId: job.id, params: { content: csvOf(`${code},Async hydraulic pump,hydraulic,first,active`) }, actor });
    assert.equal(result.status, "COMPLETED");
    assert.equal(result.created_count, 1);
    assert.equal(result.failed_count, 0);

    const records = await Importer.listImportRecordResultsAsync(db, { tenantId, jobId: job.id });
    assert.equal(records.total, 1);
    assert.equal(records.items[0].status, "SUCCESS");
    assert.equal(records.items[0].business_key, code);
    assert.ok(queryOne(db, "SELECT id FROM objects WHERE tenant_id = ? AND code = ?", [tenantId, code]));

    const reconciliation = await Jobs.reconcileImportJobAsync(db, { tenantId, importJobId: job.id });
    assert.ok(["PENDING", "COMPLETED", "VARIANCE"].includes(reconciliation.status));
  });

  test("async import records mapping failures and lifecycle blocks", async () => {
    const definition = await ImportDefinitions.getImportDefinitionAsync(db, tenantId, "PART_IMPORT");

    const failing = await Importer.createImportJobAsync(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
    const failed = await Importer.runImportJobAsync(db, { jobId: failing.job.id, params: { content: csvOf("DX-ASYNC-BAD-1,,hydraulic,missing name,active") }, actor });
    assert.equal(failed.status, "FAILED");
    const errors = await Importer.listImportErrorsAsync(db, { tenantId, jobId: failing.job.id });
    assert.equal(errors.total, 1);

    const archivedCode = "DX-ASYNC-ARCH-1";
    const { createObject } = await import("../services/objects.js");
    const archived = createObject(
      db,
      { type: "product", code: archivedCode, name: "Archived", data: { "part.number": archivedCode, "part.name": "Archived", "part.category": "mechanical" } },
      actor,
      tenantId,
      null
    );
    const { DataLifecycle } = await import("../services/data-lifecycle/index.js");
    DataLifecycle.registerObject(db, tenantId, { object_type: "product", object_id: archived.id, object_ref: archived.code, current_state: "ARCHIVED" }, actor);

    const blocked = await Importer.createImportJobAsync(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
    const blockedResult = await Importer.runImportJobAsync(db, { jobId: blocked.job.id, params: { content: csvOf(`${archivedCode},Async updated,mechanical,n,active`) }, actor });
    assert.equal(blockedResult.status, "FAILED");
    const blockedErrors = await Importer.listImportErrorsAsync(db, { tenantId, jobId: blocked.job.id });
    assert.ok(blockedErrors.items.some((error) => error.error_code === "LIFECYCLE"));
  });

  test("async import upserts, previews and validates without hiding errors", async () => {
    const definition = await ImportDefinitions.getImportDefinitionAsync(db, tenantId, "PART_IMPORT");
    const code = "DX-ASYNC-UPSERT-1";
    const content = csvOf(`${code},Async pump,hydraulic,first,active`);

    const first = await Importer.createImportJobAsync(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
    const firstRun = await Importer.runImportJobAsync(db, { jobId: first.job.id, params: { content }, actor });
    assert.equal(firstRun.created_count, 1);

    const second = await Importer.createImportJobAsync(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
    const secondRun = await Importer.runImportJobAsync(db, { jobId: second.job.id, params: { content }, actor });
    assert.equal(secondRun.created_count, 0);
    assert.equal(secondRun.updated_count, 1);

    const previewContent = csvOf("DX-ASYNC-PRE-1,Valid,hydraulic,n,active", "DX-ASYNC-PRE-2,,hydraulic,n,active");
    const preview = await Importer.previewImportAsync(db, tenantId, definition, { content: previewContent }, actor);
    assert.equal(preview.valid, 1);
    assert.equal(preview.invalid, 1);

    const validation = await Importer.validateImportAsync(db, tenantId, definition, { content: previewContent }, actor);
    assert.equal(validation.source_count, 2);
    assert.equal(validation.valid, 1);
    assert.equal(validation.invalid, 1);
  });

  test("async idempotency returns the same import job", async () => {
    const definition = await ImportDefinitions.getImportDefinitionAsync(db, tenantId, "PART_IMPORT");
    const key = `async-idem-${seq}`;
    const first = await Importer.createImportJobAsync(db, { tenantId, definition, mode: "IMPORT", params: {}, actor, idempotencyKey: key });
    assert.equal(first.existing, false);
    const second = await Importer.createImportJobAsync(db, { tenantId, definition, mode: "IMPORT", params: {}, actor, idempotencyKey: key });
    assert.equal(second.existing, true);
    assert.equal(second.job.id, first.job.id);
  });

  test("async export runs, lists results and downloads", async () => {
    const definition = await ExportDefinitions.getExportDefinitionAsync(db, tenantId, "PART_EXPORT");
    const { job } = await Exporter.createExportJobAsync(db, { tenantId, definition, params: {}, actor });
    const result = await Exporter.runExportJobAsync(db, { jobId: job.id, params: {}, actor });
    assert.equal(result.status, "COMPLETED");
    assert.ok(result.exported_count >= 1);

    const results = await Exporter.listExportResultsAsync(db, { tenantId, jobId: job.id });
    assert.equal(results.total, 1);
    assert.equal(results.items[0].status, "AVAILABLE");

    const download = await Exporter.downloadExportResultAsync(db, tenantId, results.items[0].result_ref);
    assert.match(download.content.split("\n")[0], /Part Number/);
    assert.equal(download.filename, results.items[0].filename);

    await assert.rejects(() => Exporter.downloadExportResultAsync(db, tenantId, "NO-SUCH-RESULT"), (err) => isExchangeError(err, 404, "DATA_EXCHANGE_RESULT_NOT_FOUND"));
  });

  test("async job submission and ledger listing work", async () => {
    const definition = await ImportDefinitions.getImportDefinitionAsync(db, tenantId, "PART_IMPORT");
    const { job } = await Importer.createImportJobAsync(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
    const submitted = await Jobs.submitImportJobAsync(db, { tenantId, importJobId: job.id, actor });
    assert.ok(submitted && submitted.id);
    const ledger = await Jobs.listExchangeJobsAsync(db, { tenantId, direction: "IMPORT" });
    assert.ok(ledger.items.some((item) => item.id === job.id || item.job_ref === job.job_ref));
  });

  test("async history, metrics and health mirror the sync layer", async () => {
    const history = await History.listHistoryAsync(db, { tenantId, pageSize: 5 });
    assert.ok(Array.isArray(history.items));

    const asyncMetrics = await Metrics.metricsSnapshotAsync(db, { tenantId });
    const syncMetrics = Metrics.metricsSnapshot(db, { tenantId });
    assert.equal(asyncMetrics.import_definitions, syncMetrics.import_definitions);
    assert.equal(asyncMetrics.export_definitions, syncMetrics.export_definitions);
    assert.equal(asyncMetrics.connector_configurations, syncMetrics.connector_configurations);
    assert.equal(asyncMetrics.templates, syncMetrics.templates);

    const asyncHealth = await Foundation.exchangeHealthAsync(db, tenantId);
    const syncHealth = Foundation.exchangeHealth(db, tenantId);
    assert.deepEqual(asyncHealth.counts, syncHealth.counts);
  });

  test("async lifecycle, quality and catalog integrations resolve", async () => {
    const objectRow = queryOne(db, "SELECT id FROM objects WHERE tenant_id = ? AND code = 'DX-ASYNC-OK-1'", [tenantId]);
    assert.ok(objectRow);
    const filtered = await Lifecycle.filterExportableRecordsAsync(db, tenantId, "product", [{ id: objectRow.id }]);
    assert.equal(filtered.records.length, 1);
    assert.deepEqual(filtered.excluded, []);

    const quality = await Quality.evaluateImportedObjectsAsync(db, tenantId, { objectType: "product", objectIds: [objectRow.id], actor });
    assert.equal(typeof quality.evaluated, "number");

    const definition = await ImportDefinitions.getImportDefinitionAsync(db, tenantId, "PART_IMPORT");
    const resolved = await Catalog.resolveCatalogRefsAsync(db, tenantId, definition.catalog_refs || {});
    assert.ok(Object.prototype.hasOwnProperty.call(resolved, "object_ref"));
  });

  test("async demo seed is idempotent", async () => {
    const seeded = await Seed.ensureDataExchangeSeedAsync(db, tenantId);
    assert.equal(typeof seeded.seeded, "boolean");
  });
});
