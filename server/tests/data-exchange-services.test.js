process.env.FILE_STORAGE_PROVIDER = "memory";

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, migrate, queryOne, queryAll, run, nowIso } from "../db.js";
import { seedDatabase } from "../seed.js";
import { EXCHANGE_HANDLER_CODES } from "../services/data-exchange/constants.js";
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
import * as Search from "../services/data-exchange/search.js";
import * as Objects from "../services/objects.js";
import { DataLifecycle } from "../services/data-lifecycle/index.js";
import { listHandlers } from "../services/job-execution/handlers.js";

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

describe("data-exchange services", () => {
  let db;
  let tenantId;
  let actor;
  let seq = 0;
  const nextCode = (prefix) => {
    seq += 1;
    return `${prefix}_SVC${String(seq).padStart(3, "0")}`;
  };

  before(() => {
    db = openDatabase(":memory:");
    migrate(db);
    seedDatabase(db);
    tenantId = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'").id;
    const row = queryOne(db, "SELECT id, username FROM users WHERE username = 'admin'");
    actor = { id: row.id, username: row.username };
  });

  after(() => db?.close());

  describe("connector-configs.js", () => {
    test("creates, gets, lists and updates a connector configuration", () => {
      const code = nextCode("CONN");
      const created = ConnectorConfigs.createConnectorConfiguration(
        db,
        tenantId,
        { code, name: "Source CSV", connector_type: "CSV", direction: "SOURCE", settings: { delimiter: ",", has_header: true } },
        actor
      );
      assert.equal(created.code, code);
      assert.equal(created.connector_type, "CSV");
      assert.deepEqual(created.settings, { delimiter: ",", has_header: true });

      const fetched = ConnectorConfigs.getConnectorConfiguration(db, tenantId, code);
      assert.equal(fetched.id, created.id);

      const listed = ConnectorConfigs.listConnectorConfigurations(db, { tenantId, connectorType: "CSV" });
      assert.ok(listed.items.some((item) => item.code === code));
      assert.equal(listed.total, listed.items.length);

      const updated = ConnectorConfigs.updateConnectorConfiguration(
        db,
        tenantId,
        code,
        { name: "Renamed", settings: { delimiter: ";" } },
        actor
      );
      assert.equal(updated.name, "Renamed");
      assert.deepEqual(updated.settings, { delimiter: ";" });
    });

    test("rejects duplicate codes and an immutable connector_type", () => {
      const code = nextCode("CONN");
      ConnectorConfigs.createConnectorConfiguration(db, tenantId, { code, name: "Dup", connector_type: "CSV" }, actor);
      assert.throws(
        () => ConnectorConfigs.createConnectorConfiguration(db, tenantId, { code, name: "Dup2", connector_type: "CSV" }, actor),
        (err) => isExchangeError(err, 400, "INVALID_DATA_EXCHANGE_CONNECTOR")
      );
      assert.throws(
        () => ConnectorConfigs.updateConnectorConfiguration(db, tenantId, code, { connector_type: "JSON" }, actor),
        (err) => isExchangeError(err, 400, "INVALID_DATA_EXCHANGE_CONNECTOR")
      );
      assert.throws(
        () => ConnectorConfigs.getConnectorConfiguration(db, tenantId, "NO_SUCH_CONNECTOR"),
        (err) => isExchangeError(err, 404, "DATA_EXCHANGE_CONNECTOR_NOT_FOUND")
      );
    });

    test("disables a connector through status transitions and rejects bogus values", () => {
      const code = nextCode("CONN");
      ConnectorConfigs.createConnectorConfiguration(db, tenantId, { code, name: "Lifecycle", connector_type: "CSV" }, actor);
      const inactive = ConnectorConfigs.setConnectorConfigurationStatus(db, tenantId, code, "inactive", actor);
      assert.equal(inactive.status, "inactive");
      const retired = ConnectorConfigs.setConnectorConfigurationStatus(db, tenantId, code, "RETIRED", actor);
      assert.equal(retired.status, "retired");
      assert.throws(
        () => ConnectorConfigs.setConnectorConfigurationStatus(db, tenantId, code, "archived", actor),
        (err) => isExchangeError(err, 400, "INVALID_DATA_EXCHANGE_CONNECTOR")
      );
    });

    test("keeps credential references opaque and never returns a raw secret", () => {
      const credCode = nextCode("CRED");
      const credential = ConnectorConfigs.createCredentialReference(
        db,
        tenantId,
        { code: credCode, name: "Vault token", credential_type: "TOKEN", secret_ref: "vault://kv/data/exchange", metadata: { vault: "kv" } },
        actor
      );
      assert.equal(credential.secret_ref, "vault://kv/data/exchange");
      assert.equal(credential.credential_type, "TOKEN");
      for (const forbidden of ["secret", "secret_value", "password", "token"]) {
        assert.equal(Object.prototype.hasOwnProperty.call(credential, forbidden), false, `must not expose ${forbidden}`);
      }

      const listed = ConnectorConfigs.listCredentialReferences(db, { tenantId });
      assert.ok(listed.items.some((item) => item.code === credCode));

      const code = nextCode("CONN");
      const config = ConnectorConfigs.createConnectorConfiguration(
        db,
        tenantId,
        { code, name: "Bound", connector_type: "REST", credential_ref_id: credential.id },
        actor
      );
      assert.equal(config.credential_ref_id, credential.id);
      assert.equal(Object.prototype.hasOwnProperty.call(config, "secret_ref"), false);
      assert.equal(JSON.stringify(config.settings).includes("vault://"), false);
    });

    test("requires an opaque secret_ref when creating a credential reference", () => {
      assert.throws(
        () => ConnectorConfigs.createCredentialReference(db, tenantId, { code: nextCode("CRED"), credential_type: "TOKEN" }, actor),
        (err) => isExchangeError(err, 400, "INVALID_DATA_EXCHANGE_CONNECTOR")
      );
      assert.throws(
        () => ConnectorConfigs.createCredentialReference(db, tenantId, { code: nextCode("CRED"), credential_type: "MAGIC", secret_ref: "x" }, actor),
        (err) => isExchangeError(err, 400, "INVALID_DATA_EXCHANGE_CONNECTOR")
      );
    });

    test("filters connector capabilities that the connector does not support", () => {
      const created = ConnectorConfigs.createConnectorConfiguration(
        db,
        tenantId,
        { code: nextCode("CONN"), name: "Caps", connector_type: "CSV", capabilities: ["READ", "WRITE", "TELEPORT"] },
        actor
      );
      assert.ok(created.capabilities.includes("READ"));
      assert.equal(created.capabilities.includes("TELEPORT"), false);
    });
  });

  describe("import-definitions.js", () => {
    test("creates a definition with mappings, transformations and validation rules", () => {
      const code = nextCode("IMPDEF");
      const created = ImportDefinitions.createImportDefinition(
        db,
        tenantId,
        {
          code,
          name: "Widget import",
          target_object_type: "product",
          source_type: "CSV",
          mappings: MAPPINGS,
          transformations: [{ stage: "FIELD", target_field: "name", transformation_type: "TRIM" }],
          validation_rules: [{ level: "FIELD", target_field: "part.number", rule_type: "REQUIRED" }],
          duplicate_strategy: "UPSERT",
          duplicate_key: { type: "BUSINESS_KEY", fields: ["code"] },
          status: "DRAFT",
        },
        actor
      );
      assert.equal(created.version, 1);
      assert.equal(created.mappings.length, MAPPINGS.length);
      assert.equal(created.transformations.length, 1);
      assert.equal(created.validation_rules.length, 1);

      const fetched = ImportDefinitions.getImportDefinition(db, tenantId, code);
      assert.equal(fetched.code, code);
      assert.equal(fetched.mappings.length, MAPPINGS.length);
      assert.equal(fetched.transformations[0].transformation_type, "TRIM");
      assert.equal(fetched.validation_rules[0].rule_type, "REQUIRED");
    });

    test("replaces child collections in place and versions a definition", () => {
      const code = nextCode("IMPDEF");
      ImportDefinitions.createImportDefinition(
        db,
        tenantId,
        { code, name: "Child v1", target_object_type: "product", source_type: "CSV", mappings: MAPPINGS },
        actor
      );
      const updated = ImportDefinitions.updateImportDefinition(
        db,
        tenantId,
        code,
        {
          mappings: [{ source_field: "part_number", target_field: "code", mapping_type: "DIRECT" }],
          validation_rules: [{ level: "FIELD", target_field: "part.number", rule_type: "REQUIRED" }],
        },
        actor
      );
      assert.equal(updated.mappings.length, 1);
      assert.equal(updated.validation_rules.length, 1);

      const versioned = ImportDefinitions.createImportDefinitionVersion(db, tenantId, code, { name: "Child v2", change_summary: "next" }, actor);
      assert.equal(versioned.version, 2);
      assert.equal(versioned.status, "DRAFT");
      assert.equal(versioned.name, "Child v2");

      const versions = ImportDefinitions.listImportDefinitionVersions(db, tenantId, code);
      assert.ok(versions.total >= 2);
      assert.equal(versions.items[0].version, 2);
    });

    test("enforces status transitions and immutability once ACTIVE", () => {
      const code = nextCode("IMPDEF");
      ImportDefinitions.createImportDefinition(
        db,
        tenantId,
        { code, name: "Immutable", target_object_type: "product", source_type: "CSV", mappings: MAPPINGS, status: "DRAFT" },
        actor
      );
      const active = ImportDefinitions.setImportDefinitionStatus(db, tenantId, code, "ACTIVE", actor);
      assert.equal(active.status, "ACTIVE");
      assert.throws(
        () => ImportDefinitions.updateImportDefinition(db, tenantId, code, { name: "nope" }, actor),
        (err) => isExchangeError(err, 409, "DATA_EXCHANGE_DEFINITION_IMMUTABLE")
      );
      const deprecated = ImportDefinitions.setImportDefinitionStatus(db, tenantId, code, "DEPRECATED", actor);
      assert.equal(deprecated.status, "DEPRECATED");
      const versioned = ImportDefinitions.createImportDefinitionVersion(db, tenantId, code, { name: "again" }, actor);
      assert.equal(versioned.status, "DRAFT");
      assert.equal(versioned.version, 2);
    });

    test("refuses to activate a definition with blocking issues", () => {
      const code = nextCode("IMPDEF");
      ImportDefinitions.createImportDefinition(db, tenantId, { code, name: "No mappings", target_object_type: "product", source_type: "CSV", status: "DRAFT" }, actor);
      assert.throws(
        () => ImportDefinitions.setImportDefinitionStatus(db, tenantId, code, "ACTIVE", actor),
        (err) => isExchangeError(err, 400, "INVALID_DATA_EXCHANGE_DEFINITION")
      );
      assert.throws(
        () => ImportDefinitions.getImportDefinition(db, tenantId, "NOT_THERE"),
        (err) => isExchangeError(err, 404, "DATA_EXCHANGE_DEFINITION_NOT_FOUND")
      );
    });

    test("validates a definition and reports source-field warnings", () => {
      const seeded = ImportDefinitions.validateImportDefinition(db, tenantId, "PART_IMPORT");
      assert.equal(seeded.valid, true);
      const withWarning = ImportDefinitions.validateImportDefinition(db, tenantId, "PART_IMPORT", { sourceFields: ["notes"] });
      assert.ok(withWarning.warnings.some((warning) => warning.code === "unknown_source"));
    });

    test("stores catalog references and lists definitions with filters", () => {
      const code = nextCode("IMPDEF");
      const created = ImportDefinitions.createImportDefinition(
        db,
        tenantId,
        {
          code,
          name: "Catalogued",
          target_object_type: "product",
          source_type: "CSV",
          mappings: MAPPINGS,
          catalog_refs: { domain_id: 1, business_terms: ["TERM-A"], classification: "internal" },
        },
        actor
      );
      assert.equal(created.catalog_refs.domain_id, 1);
      assert.deepEqual(created.catalog_refs.business_terms, ["TERM-A"]);

      const listed = ImportDefinitions.listImportDefinitions(db, { tenantId, targetObjectType: "product", sourceType: "CSV" });
      assert.ok(listed.items.some((item) => item.code === code));
      const searched = ImportDefinitions.listImportDefinitions(db, { tenantId, q: "Catalogued" });
      assert.ok(searched.items.some((item) => item.code === code));
    });
  });

  describe("export-definitions.js", () => {
    test("creates an export definition with fields, filters and transformations", () => {
      const code = nextCode("EXPDEF");
      const created = ExportDefinitions.createExportDefinition(
        db,
        tenantId,
        {
          code,
          name: "Widget export",
          object_type: "product",
          format: "CSV",
          destination: "DOWNLOAD",
          field_selections: [
            { field_path: "code", display_name: "Code" },
            { field_path: "name", display_name: "Name" },
          ],
          export_filters: [{ filter_type: "ATTRIBUTE", field: "code", operator: "contains", value: "WID" }],
          export_transformations: [{ field_path: "name", transformation_type: "UPPERCASE" }],
          status: "DRAFT",
        },
        actor
      );
      assert.equal(created.field_selections.length, 2);
      assert.equal(created.export_filters.length, 1);
      assert.equal(created.export_transformations.length, 1);
      assert.deepEqual(created.fields, ["code", "name"]);

      const fetched = ExportDefinitions.getExportDefinition(db, tenantId, code);
      assert.equal(fetched.field_selections[1].display_name, "Name");
      assert.equal(fetched.export_filters[0].operator, "contains");
    });

    test("updates in place while DRAFT and creates new versions", () => {
      const code = nextCode("EXPDEF");
      ExportDefinitions.createExportDefinition(
        db,
        tenantId,
        { code, name: "Export v1", object_type: "product", field_selections: [{ field_path: "code" }] },
        actor
      );
      const updated = ExportDefinitions.updateExportDefinition(
        db,
        tenantId,
        code,
        { field_selections: [{ field_path: "name", display_name: "Name" }], export_filters: [{ field: "status", operator: "eq", value: "active" }] },
        actor
      );
      assert.equal(updated.field_selections.length, 1);
      assert.equal(updated.field_selections[0].field_path, "name");
      const versioned = ExportDefinitions.createExportDefinitionVersion(db, tenantId, code, { change_summary: "v2" }, actor);
      assert.equal(versioned.version, 2);
      assert.equal(versioned.status, "DRAFT");
      const versions = ExportDefinitions.listExportDefinitionVersions(db, tenantId, code);
      assert.ok(versions.total >= 2);
    });

    test("is immutable once ACTIVE and validates max_records", () => {
      const code = nextCode("EXPDEF");
      ExportDefinitions.createExportDefinition(
        db,
        tenantId,
        { code, name: "Locked", object_type: "product", field_selections: [{ field_path: "code" }] },
        actor
      );
      const active = ExportDefinitions.setExportDefinitionStatus(db, tenantId, code, "ACTIVE", actor);
      assert.equal(active.status, "ACTIVE");
      assert.throws(
        () => ExportDefinitions.updateExportDefinition(db, tenantId, code, { name: "nope" }, actor),
        (err) => isExchangeError(err, 409, "DATA_EXCHANGE_DEFINITION_IMMUTABLE")
      );

      const badCode = nextCode("EXPDEF");
      ExportDefinitions.createExportDefinition(
        db,
        tenantId,
        { code: badCode, name: "Bad max", object_type: "product", max_records: 0 },
        actor
      );
      const validation = ExportDefinitions.validateExportDefinition(db, tenantId, badCode);
      assert.equal(validation.valid, false);
      assert.ok(validation.errors.some((error) => error.code === "invalid_max_records"));
      assert.throws(
        () => ExportDefinitions.setExportDefinitionStatus(db, tenantId, badCode, "ACTIVE", actor),
        (err) => isExchangeError(err, 400, "INVALID_DATA_EXCHANGE_DEFINITION")
      );
    });

    test("lists export definitions with filters", () => {
      const listed = ExportDefinitions.listExportDefinitions(db, { tenantId, objectType: "product" });
      assert.ok(listed.items.some((item) => item.code === "PART_EXPORT"));
      const byFormat = ExportDefinitions.listExportDefinitions(db, { tenantId, format: "CSV" });
      assert.ok(byFormat.items.every((item) => item.format === "CSV"));
      assert.throws(
        () => ExportDefinitions.getExportDefinition(db, tenantId, "MISSING"),
        (err) => isExchangeError(err, 404, "DATA_EXCHANGE_DEFINITION_NOT_FOUND")
      );
    });
  });

  describe("templates.js", () => {
    test("creates, gets, lists and updates a template", () => {
      const code = nextCode("TPL");
      const created = Templates.createTemplate(
        db,
        tenantId,
        { code, name: "Starter", direction: "IMPORT", object_type: "product", definition: { mappings: MAPPINGS }, status: "DRAFT" },
        actor
      );
      assert.equal(created.version, 1);
      assert.equal(created.direction, "IMPORT");
      assert.equal(created.definition.mappings.length, MAPPINGS.length);

      const fetched = Templates.getTemplate(db, tenantId, created.template_ref);
      assert.equal(fetched.code, code);

      const updated = Templates.updateTemplate(db, tenantId, code, { description: "updated", definition: { mappings: [] } }, actor);
      assert.equal(updated.description, "updated");
      assert.equal(updated.definition.mappings.length, 0);

      const listed = Templates.listTemplates(db, { tenantId, direction: "IMPORT", q: code });
      assert.ok(listed.items.some((item) => item.code === code));
    });

    test("versions a template and transitions status", () => {
      const code = nextCode("TPL");
      Templates.createTemplate(db, tenantId, { code, name: "Status", direction: "EXPORT", object_type: "product", definition: {} }, actor);
      const draft = Templates.setTemplateStatus(db, tenantId, code, "ACTIVE", actor);
      assert.equal(draft.status, "ACTIVE");
      const version = Templates.createTemplateVersion(db, tenantId, code, { name: "Status v2" }, actor);
      assert.equal(version.version, 2);
      assert.equal(version.status, "DRAFT");
      const inactive = Templates.setTemplateStatus(db, tenantId, code, "INACTIVE", actor);
      assert.equal(inactive.status, "INACTIVE");
    });

    test("validates a template and reports a missing object_type", () => {
      const code = nextCode("TPL");
      Templates.createTemplate(db, tenantId, { code, name: "No type", direction: "IMPORT", definition: {} }, actor);
      const result = Templates.validateTemplate(db, tenantId, code);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((error) => error.code === "missing_object_type"));
    });

    test("rejects duplicate template codes", () => {
      const code = nextCode("TPL");
      Templates.createTemplate(db, tenantId, { code, name: "Dup", direction: "IMPORT", object_type: "product", definition: {} }, actor);
      assert.throws(
        () => Templates.createTemplate(db, tenantId, { code, name: "Dup again", direction: "IMPORT", object_type: "product", definition: {} }, actor),
        (err) => isExchangeError(err, 409, "DATA_EXCHANGE_DEFINITION_CONFLICT")
      );
    });
  });

  describe("seed.js", () => {
    test("seeds the exchange estate once and is idempotent", () => {
      assert.ok(queryOne(db, "SELECT id FROM ie_import_definitions WHERE tenant_id = ? AND code = 'PART_IMPORT'", [tenantId]));
      assert.ok(queryOne(db, "SELECT id FROM ie_export_definitions WHERE tenant_id = ? AND code = 'PART_EXPORT'", [tenantId]));
      assert.ok(queryOne(db, "SELECT id FROM ie_templates WHERE tenant_id = ? AND code = 'PART_IMPORT_TEMPLATE'", [tenantId]));
      assert.ok(queryOne(db, "SELECT id FROM ie_connector_configurations WHERE tenant_id = ? AND code = 'PART_CSV'", [tenantId]));

      const second = Seed.seedDataExchange(db, tenantId);
      assert.equal(second.seeded, true);
      assert.equal(second.created.import_definitions, 0);
      assert.equal(second.created.export_definitions, 0);
      assert.equal(second.created.templates, 0);
      assert.equal(second.created.connector_configurations, 0);
    });

    test("ensureDataExchangeSeed reports already_present", () => {
      const result = Seed.ensureDataExchangeSeed(db, tenantId);
      assert.equal(result.seeded, false);
      assert.equal(result.reason, "already_present");
    });
  });

  describe("jobs.js", () => {
    test("submits import/validate/export/reconcile/retry/maintenance jobs", () => {
      const definition = ImportDefinitions.getImportDefinition(db, tenantId, "PART_IMPORT");
      const { job } = Importer.createImportJob(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
      const exportDefinition = ExportDefinitions.getExportDefinition(db, tenantId, "PART_EXPORT");
      const { job: exportJob } = Exporter.createExportJob(db, { tenantId, definition: exportDefinition, params: {}, actor });

      const submitted = [
        Jobs.submitImportJob(db, { tenantId, importJobId: job.id, actor }),
        Jobs.submitValidateJob(db, { tenantId, importJobId: job.id, actor }),
        Jobs.submitExportJob(db, { tenantId, exportJobId: exportJob.id, actor }),
        Jobs.submitReconcileJob(db, { tenantId, importJobId: job.id, actor }),
        Jobs.submitRetryJob(db, { tenantId, importJobId: job.id, actor }),
        Jobs.submitMaintenanceJob(db, { tenantId, actor }),
      ];
      const codes = submitted.map((entry) => entry.job_type_code);
      assert.deepEqual(codes, [
        "DATA_IMPORT",
        "DATA_IMPORT_VALIDATE",
        "DATA_EXPORT",
        "DATA_RECONCILIATION",
        "DATA_EXCHANGE_RETRY",
        "DATA_EXCHANGE_MAINTENANCE",
      ]);
      for (const entry of submitted) assert.ok(entry.id);
    });

    test("lists and gets exchange jobs with filters", async () => {
      const definition = ImportDefinitions.getImportDefinition(db, tenantId, "PART_IMPORT");
      const { job } = Importer.createImportJob(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
      await Importer.runImportJob(db, { jobId: job.id, params: { content: csvOf("JOB-LIST-1,Hydraulic pump,hydraulic,n,active") }, actor });

      const all = Jobs.listExchangeJobs(db, { tenantId });
      assert.ok(all.total >= 1);
      assert.ok(all.items.some((item) => item.job_ref === job.job_ref));

      const completed = Jobs.listExchangeJobs(db, { tenantId, direction: "IMPORT", status: "COMPLETED" });
      assert.ok(completed.items.every((item) => item.direction === "IMPORT" && item.status === "COMPLETED"));

      const fetched = Jobs.getExchangeJob(db, tenantId, "IMPORT", job.job_ref);
      assert.equal(fetched.job_ref, job.job_ref);
      assert.equal(fetched.direction, "IMPORT");
      assert.equal(Jobs.getExchangeJob(db, tenantId, "IMPORT", "NOPE"), null);

      const exportRow = Jobs.submitExportJob(db, { tenantId, exportJobId: 1, actor });
      const exportList = Jobs.listExchangeJobs(db, { tenantId, direction: "EXPORT" });
      assert.ok(exportList.items.every((item) => item.direction === "EXPORT"));
      assert.ok(exportRow.id);
    });

    test("reports failed record numbers and reconciles an import job", async () => {
      const definition = ImportDefinitions.getImportDefinition(db, tenantId, "PART_IMPORT");
      const { job } = Importer.createImportJob(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
      await Importer.runImportJob(db, { jobId: job.id, params: { content: csvOf("JOB-FAIL-1,,hydraulic,n,active") }, actor });

      const failed = Jobs.failedRecordNumbers(db, tenantId, job.id);
      assert.deepEqual(failed, [1]);

      const reconciliation = Jobs.reconcileImportJob(db, { tenantId, importJobId: job.id });
      assert.equal(reconciliation.strategy, "COUNT");
      assert.equal(reconciliation.status, "VARIANCE");
      assert.equal(reconciliation.variance, 1);

      const missing = Jobs.reconcileImportJob(db, { tenantId, importJobId: 987654 });
      assert.equal(missing.status, "PENDING");
    });

    test("retries failed records through the definition", async () => {
      const definition = ImportDefinitions.getImportDefinition(db, tenantId, "PART_IMPORT");
      const { job } = Importer.createImportJob(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
      await Importer.runImportJob(db, { jobId: job.id, params: { content: csvOf("JOB-RETRY-1,,hydraulic,n,active") }, actor });

      const retry = await Jobs.retryImportJob(db, { tenantId, importJobId: job.id, actor });
      assert.equal(retry.retried, 1);
      assert.ok(retry.job && retry.job.id);
    });

    test("expires export results during maintenance", async () => {
      const definition = ExportDefinitions.getExportDefinition(db, tenantId, "PART_EXPORT");
      const { job } = Exporter.createExportJob(db, { tenantId, definition, params: {}, actor });
      await Exporter.runExportJob(db, { jobId: job.id, params: {}, actor });

      const storageUri = `ie://probe/maintenance-${seq}`;
      run(
        db,
        "INSERT INTO ie_blobs (tenant_id, storage_uri, content_type, checksum, size_bytes, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [tenantId, storageUri, "text/csv", "checksum", 3, "abc", nowIso()]
      );
      const resultRef = `RES-SVC-${seq}`;
      run(
        db,
        `INSERT INTO ie_export_results (job_id, tenant_id, result_ref, format, storage_uri, filename, content_type, size_bytes, checksum, record_count, expires_at, status, created_at)
         VALUES (?, ?, ?, 'CSV', ?, 'expired.csv', 'text/csv', 3, 'checksum', 1, '2000-01-01 00:00:00', 'AVAILABLE', ?)`,
        [job.id, tenantId, resultRef, storageUri, nowIso()]
      );

      const summary = Jobs.runExchangeMaintenance(db, { tenantId });
      assert.ok(summary.exports_expired >= 1);
      assert.ok(summary.blobs_pruned >= 1);
      assert.equal(queryOne(db, "SELECT status FROM ie_export_results WHERE result_ref = ?", [resultRef]).status, "EXPIRED");
    });

    test("registers every exchange handler code", () => {
      const registered = Jobs.registerExchangeHandlers();
      assert.equal(registered.length, 6);
      const handlers = listHandlers();
      for (const code of Object.values(EXCHANGE_HANDLER_CODES)) {
        assert.ok(handlers.some((handler) => handler.code === code.toUpperCase()), `missing handler ${code}`);
      }
    });
  });

  describe("importer.js", () => {
    test("runs an import end-to-end from the seeded definition", async () => {
      const definition = ImportDefinitions.getImportDefinition(db, tenantId, "PART_IMPORT");
      const { job } = Importer.createImportJob(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
      const code = "SVC-IMP-OK-1";
      const result = await Importer.runImportJob(db, {
        jobId: job.id,
        params: { content: csvOf(`${code},Hydraulic pump A,hydraulic,first,active`) },
        actor,
      });
      assert.equal(result.status, "COMPLETED");
      assert.equal(result.created_count, 1);
      assert.equal(result.failed_count, 0);

      const records = Importer.listImportRecordResults(db, { tenantId, jobId: job.id });
      assert.equal(records.total, 1);
      assert.equal(records.items[0].status, "SUCCESS");
      assert.equal(records.items[0].action, "CREATE");
      assert.equal(records.items[0].business_key, code);

      assert.ok(queryOne(db, "SELECT id FROM objects WHERE tenant_id = ? AND code = ?", [tenantId, code]));
    });

    test("records a failed row and an error entry with a mapping failure", async () => {
      const definition = ImportDefinitions.getImportDefinition(db, tenantId, "PART_IMPORT");
      const { job } = Importer.createImportJob(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
      const result = await Importer.runImportJob(db, {
        jobId: job.id,
        params: { content: csvOf("SVC-IMP-BAD-1,,hydraulic,missing name,active") },
        actor,
      });
      assert.equal(result.status, "FAILED");
      const records = Importer.listImportRecordResults(db, { tenantId, jobId: job.id });
      assert.equal(records.items[0].status, "FAILED");
      const errors = Importer.listImportErrors(db, { tenantId, jobId: job.id });
      assert.equal(errors.total, 1);
      assert.equal(errors.items[0].record_number, 1);
    });

    test("rejects records that fail a validation rule", async () => {
      const code = nextCode("IMP_VALIDATE");
      ImportDefinitions.createImportDefinition(
        db,
        tenantId,
        {
          code,
          name: "Pattern validation",
          target_object_type: "product",
          source_type: "CSV",
          mappings: MAPPINGS,
          validation_rules: [{ level: "FIELD", target_field: "part.number", rule_type: "PATTERN", config: { pattern: "^OK-" } }],
          duplicate_strategy: "REJECT",
          duplicate_key: { type: "BUSINESS_KEY", fields: ["code"] },
        },
        actor
      );
      ImportDefinitions.setImportDefinitionStatus(db, tenantId, code, "ACTIVE", actor);
      const definition = ImportDefinitions.getImportDefinition(db, tenantId, code);
      const { job } = Importer.createImportJob(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
      const result = await Importer.runImportJob(db, {
        jobId: job.id,
        params: { content: csvOf("BAD-PREFIX-1,Hydraulic pump,hydraulic,n,active") },
        actor,
      });
      assert.equal(result.status, "FAILED");
      assert.equal(result.rejected_count, 1);
      const errors = Importer.listImportErrors(db, { tenantId, jobId: job.id });
      assert.ok(errors.items.some((error) => error.error_code === "VALIDATION"));
    });

    test("upserts an existing business key on the seeded definition", async () => {
      const definition = ImportDefinitions.getImportDefinition(db, tenantId, "PART_IMPORT");
      const code = "SVC-UPSERT-1";
      const content = csvOf(`${code},Hydraulic pump,hydraulic,first,active`);

      const first = Importer.createImportJob(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
      const firstRun = await Importer.runImportJob(db, { jobId: first.job.id, params: { content }, actor });
      assert.equal(firstRun.created_count, 1);
      assert.equal(firstRun.updated_count, 0);

      const second = Importer.createImportJob(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
      const secondRun = await Importer.runImportJob(db, { jobId: second.job.id, params: { content }, actor });
      assert.equal(secondRun.status, "COMPLETED");
      assert.equal(secondRun.created_count, 0);
      assert.equal(secondRun.updated_count, 1);
    });

    test("rejects duplicates under the REJECT strategy", async () => {
      const code = nextCode("IMP_REJECT");
      ImportDefinitions.createImportDefinition(
        db,
        tenantId,
        {
          code,
          name: "Reject dupes",
          target_object_type: "product",
          source_type: "CSV",
          mappings: MAPPINGS,
          duplicate_strategy: "REJECT",
          duplicate_key: { type: "BUSINESS_KEY", fields: ["code"] },
        },
        actor
      );
      ImportDefinitions.setImportDefinitionStatus(db, tenantId, code, "ACTIVE", actor);
      const definition = ImportDefinitions.getImportDefinition(db, tenantId, code);
      const content = csvOf("SVC-REJECT-1,Hydraulic pump,hydraulic,n,active");

      const first = Importer.createImportJob(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
      const firstRun = await Importer.runImportJob(db, { jobId: first.job.id, params: { content }, actor });
      assert.equal(firstRun.created_count, 1);

      const second = Importer.createImportJob(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
      const secondRun = await Importer.runImportJob(db, { jobId: second.job.id, params: { content }, actor });
      assert.equal(secondRun.status, "FAILED");
      assert.equal(secondRun.rejected_count, 1);
      assert.equal(secondRun.created_count, 0);
    });

    test("returns the existing job for a repeated idempotency key", () => {
      const definition = ImportDefinitions.getImportDefinition(db, tenantId, "PART_IMPORT");
      const key = `svc-idem-${seq}`;
      const first = Importer.createImportJob(db, { tenantId, definition, mode: "IMPORT", params: {}, actor, idempotencyKey: key });
      assert.equal(first.existing, false);
      const second = Importer.createImportJob(db, { tenantId, definition, mode: "IMPORT", params: {}, actor, idempotencyKey: key });
      assert.equal(second.existing, true);
      assert.equal(second.job.id, first.job.id);
    });

    test("blocks an update into a non-updatable lifecycle state", async () => {
      const code = "SVC-ARCH-1";
      const created = Objects.createObject(
        db,
        { type: "product", code, name: "Archived part", data: { "part.number": code, "part.name": "Archived part", "part.category": "mechanical" } },
        actor,
        tenantId,
        null
      );
      DataLifecycle.registerObject(db, tenantId, { object_type: "product", object_id: created.id, object_ref: created.code, current_state: "ARCHIVED" }, actor);

      const definition = ImportDefinitions.getImportDefinition(db, tenantId, "PART_IMPORT");
      const { job } = Importer.createImportJob(db, { tenantId, definition, mode: "IMPORT", params: {}, actor });
      const result = await Importer.runImportJob(db, {
        jobId: job.id,
        params: { content: csvOf(`${code},Archived part updated,mechanical,n,active`) },
        actor,
      });
      assert.equal(result.status, "FAILED");
      assert.equal(result.failed_count, 1);
      const errors = Importer.listImportErrors(db, { tenantId, jobId: job.id });
      assert.ok(errors.items.some((error) => error.error_code === "LIFECYCLE"));
    });

    test("previews and validates a source without writing", async () => {
      const definition = ImportDefinitions.getImportDefinition(db, tenantId, "PART_IMPORT");
      const content = csvOf("SVC-PREVIEW-1,Hydraulic pump,hydraulic,n,active", "SVC-PREVIEW-2,,hydraulic,n,active");
      const preview = await Importer.previewImport(db, tenantId, definition, { content }, actor);
      assert.equal(preview.valid, 1);
      assert.equal(preview.invalid, 1);

      const validation = await Importer.validateImport(db, tenantId, definition, { content }, actor);
      assert.equal(validation.source_count, 2);
      assert.equal(validation.valid, 1);
      assert.equal(validation.invalid, 1);
    });
  });

  describe("exporter.js", () => {
    test("runs an export, lists results and downloads the artifact", async () => {
      const definition = ExportDefinitions.getExportDefinition(db, tenantId, "PART_EXPORT");
      const { job } = Exporter.createExportJob(db, { tenantId, definition, params: {}, actor });
      const result = await Exporter.runExportJob(db, { jobId: job.id, params: {}, actor });
      assert.equal(result.status, "COMPLETED");
      assert.ok(result.exported_count >= 1);

      const results = Exporter.listExportResults(db, { tenantId, jobId: job.id });
      assert.equal(results.total, 1);
      assert.equal(results.items[0].status, "AVAILABLE");

      const download = Exporter.downloadExportResult(db, tenantId, results.items[0].result_ref);
      assert.match(download.content.split("\n")[0], /Part Number/);
      assert.equal(download.filename, results.items[0].filename);
    });

    test("throws resultNotFound for unknown results", () => {
      assert.throws(
        () => Exporter.downloadExportResult(db, tenantId, "NO-SUCH-RESULT"),
        (err) => isExchangeError(err, 404, "DATA_EXCHANGE_RESULT_NOT_FOUND")
      );
    });

    test("throws resultExpired for expired results", async () => {
      const definition = ExportDefinitions.getExportDefinition(db, tenantId, "PART_EXPORT");
      const { job } = Exporter.createExportJob(db, { tenantId, definition, params: {}, actor });
      await Exporter.runExportJob(db, { jobId: job.id, params: {}, actor });

      const resultRef = `RES-EXPIRED-${seq}`;
      run(
        db,
        `INSERT INTO ie_export_results (job_id, tenant_id, result_ref, format, storage_uri, filename, content_type, size_bytes, checksum, record_count, expires_at, status, created_at)
         VALUES (?, ?, ?, 'CSV', 'ie://missing/expired', 'expired.csv', 'text/csv', 0, '', 0, '2000-01-01 00:00:00', 'EXPIRED', ?)`,
        [job.id, tenantId, resultRef, nowIso()]
      );
      assert.throws(
        () => Exporter.downloadExportResult(db, tenantId, resultRef),
        (err) => isExchangeError(err, 410, "DATA_EXCHANGE_RESULT_EXPIRED")
      );
    });

    test("applies export filters and field selection", () => {
      const code = nextCode("EXP_RUN");
      ExportDefinitions.createExportDefinition(
        db,
        tenantId,
        {
          code,
          name: "Filtered",
          object_type: "product",
          field_selections: [{ field_path: "code", display_name: "Code" }],
          export_filters: [{ filter_type: "ATTRIBUTE", field: "code", operator: "starts_with", value: "SVC-" }],
        },
        actor
      );
      ExportDefinitions.setExportDefinitionStatus(db, tenantId, code, "ACTIVE", actor);
      const definition = ExportDefinitions.getExportDefinition(db, tenantId, code);
      const preview = Exporter.previewExport(db, tenantId, definition, {}, actor);
      assert.ok(preview.rows.length >= 1);
      assert.ok(preview.rows.every((row) => String(row.record.Code ?? "").startsWith("SVC-")));
    });
  });

  describe("lifecycle.js", () => {
    test("resolves state and capabilities for a tracked object", () => {
      assert.equal(Lifecycle.lifecycleStateOf(db, tenantId, "product", "PART-2001"), "ACTIVE");
      assert.equal(Lifecycle.lifecycleStateOf(db, tenantId, "product", "NO-SUCH-OBJECT"), null);
      const active = Lifecycle.stateCapabilitiesFor(db, tenantId, "ACTIVE");
      assert.equal(active.update, true);
      assert.equal(active.export, true);
      assert.equal(Lifecycle.stateCapabilitiesFor(db, tenantId, "NOPE"), null);
    });

    test("blocks import into ARCHIVED, COLD_STORAGE and PURGED", () => {
      for (const [id, state] of [["SVC-L-ARCH", "ARCHIVED"], ["SVC-L-COLD", "COLD_STORAGE"], ["SVC-L-PURG", "PURGED"]]) {
        DataLifecycle.registerObject(db, tenantId, { object_type: "product", object_id: id, object_ref: id, current_state: state }, actor);
        assert.throws(
          () => Lifecycle.assertImportStateAllowed(db, tenantId, { objectType: "product", objectId: id }),
          (err) => isExchangeError(err, 409, "DATA_EXCHANGE_LIFECYCLE_BLOCKED"),
          `import should be blocked in ${state}`
        );
      }
      const permitted = Lifecycle.assertImportStateAllowed(db, tenantId, { objectType: "product", objectId: "SVC-L-COLD", permit: true });
      assert.equal(permitted.allowed, true);
      const untracked = Lifecycle.assertImportStateAllowed(db, tenantId, { objectType: "product", objectId: "SVC-L-UNTRACKED" });
      assert.equal(untracked.allowed, true);
      assert.equal(untracked.state, null);
    });

    test("filters non-exportable lifecycle states from an export", () => {
      assert.equal(Lifecycle.lifecycleAllowsExport(db, tenantId, { objectType: "product", objectId: "SVC-L-ARCH" }), true);
      assert.equal(Lifecycle.lifecycleAllowsExport(db, tenantId, { objectType: "product", objectId: "SVC-L-COLD" }), false);
      assert.equal(Lifecycle.lifecycleAllowsExport(db, tenantId, { objectType: "product", objectId: "SVC-L-PURG" }), false);
      assert.equal(Lifecycle.lifecycleAllowsExport(db, tenantId, { objectType: "product", objectId: "SVC-L-UNKNOWN" }), true);

      const filtered = Lifecycle.filterExportableRecords(db, tenantId, "product", [
        { id: "SVC-L-ARCH" },
        { id: "SVC-L-COLD" },
        { id: "SVC-L-PURG" },
        { id: "SVC-L-UNKNOWN" },
      ]);
      assert.deepEqual(filtered.excluded, ["SVC-L-COLD", "SVC-L-PURG"]);
      assert.deepEqual(filtered.records.map((record) => record.id), ["SVC-L-ARCH", "SVC-L-UNKNOWN"]);
      assert.equal(Lifecycle.filterExportableRecords(db, tenantId, null, [{ id: "x" }]).records.length, 1);
    });

    test("integrates with a real object created through the object framework", () => {
      const code = "SVC-L-REAL-1";
      const created = Objects.createObject(
        db,
        { type: "product", code, name: "Lifecycle part", data: { "part.number": code, "part.name": "Lifecycle part", "part.category": "mechanical" } },
        actor,
        tenantId,
        null
      );
      DataLifecycle.registerObject(db, tenantId, { object_type: "product", object_id: created.id, object_ref: created.code, current_state: "INACTIVE" }, actor);
      assert.equal(Lifecycle.lifecycleStateOf(db, tenantId, "product", created.id), "INACTIVE");
      assert.throws(
        () => Lifecycle.assertImportStateAllowed(db, tenantId, { objectType: "product", objectId: created.id }),
        (err) => isExchangeError(err, 409, "DATA_EXCHANGE_LIFECYCLE_BLOCKED")
      );
      assert.equal(Lifecycle.lifecycleAllowsExport(db, tenantId, { objectType: "product", objectId: created.id }), true);
    });
  });

  describe("quality.js", () => {
    test("reports whether the gate is enabled", () => {
      assert.equal(Quality.qualityGateEnabled({ quality_gate_enabled: true }), true);
      assert.equal(Quality.qualityGateEnabled({ quality_gate_enabled: false }), false);
      assert.equal(Quality.qualityGateEnabled(null), false);
    });

    test("summarizes evaluation results", () => {
      const summary = Quality.summarizeQuality([
        { overall_score: 80 },
        { overall_score: 60, evaluation_state: "FAILED" },
        { overall_score: "not-a-number" },
      ]);
      assert.equal(summary.evaluated, 3);
      assert.equal(summary.score, 70);
      assert.equal(summary.failed, 1);

      const empty = Quality.summarizeQuality([]);
      assert.equal(empty.score, null);
      assert.equal(empty.evaluated, 0);
    });

    test("passes, blocks and skips according to the gate configuration", () => {
      const summary = { score: 80 };
      assert.equal(Quality.assertQualityGate(summary, { quality_gate_enabled: true, quality_min_score: 60 }), summary);
      assert.equal(Quality.assertQualityGate(summary, { quality_gate_enabled: false, quality_min_score: 99 }), summary);
      assert.throws(
        () => Quality.assertQualityGate({ score: 10 }, { quality_gate_enabled: true, quality_min_score: 60 }),
        (err) => isExchangeError(err, 422, "DATA_EXCHANGE_QUALITY_BLOCKED")
      );
      assert.equal(Quality.assertQualityGate({ score: null }, { quality_gate_enabled: true, quality_min_score: 60 }).score, null);
    });

    test("evaluates imported objects and tolerates non-onboarded types", () => {
      const summary = Quality.evaluateImportedObjects(db, tenantId, { objectType: "not_a_real_type", objectIds: ["A", "B", null, ""] });
      assert.equal(summary.evaluated, 0);
      assert.equal(summary.score, null);
      assert.equal(summary.failed, 0);
    });
  });

  describe("catalog.js", () => {
    test("resolves catalog references and flags unresolved business terms", () => {
      const resolved = Catalog.resolveCatalogRefs(db, tenantId, {
        object: "SVC-CAT-NOPE",
        business_terms: ["SVC-CAT-TERM"],
        attributes: [{ name: "code" }],
        classification: "internal",
      });
      assert.equal(resolved.object_ref, "SVC-CAT-NOPE");
      assert.equal(resolved.object, null);
      assert.deepEqual(resolved.attributes, [{ name: "code" }]);
      assert.equal(resolved.business_terms.length, 1);
      assert.equal(resolved.business_terms[0].unresolved, true);
      assert.equal(resolved.classification, "internal");
    });

    test("returns null for an incomplete definition and does not persist a catalog object", () => {
      assert.equal(Catalog.ensureCatalogObjectForDefinition(db, tenantId, { code: "SVC-CAT-1" }), null);
      const ensured = Catalog.ensureCatalogObjectForDefinition(db, tenantId, {
        code: "SVC-CAT-2",
        name: "Catalog probe",
        objectType: "product",
        actor,
      });
      assert.equal(ensured, null);
      assert.equal(Number(queryOne(db, "SELECT COUNT(*) AS c FROM dc_entries WHERE code = 'SVC-CAT-2'").c), 0);
    });
  });

  describe("search.js", () => {
    test("declares the exchange search registrations", () => {
      assert.equal(Search.SEARCH_REGISTRATIONS.length, 3);
      const codes = Search.SEARCH_REGISTRATIONS.map((entry) => entry.code);
      assert.deepEqual(codes, ["data_exchange_import_definition", "data_exchange_export_definition", "data_exchange_job"]);
      for (const entry of Search.SEARCH_REGISTRATIONS) {
        assert.equal(entry.source_module, "data-exchange");
        assert.ok(entry.source_table);
        assert.ok(entry.permission_resource);
        assert.ok(Array.isArray(entry.facet_attributes));
      }
    });

    test("registers a source resolver for every searchable type", () => {
      const registered = Search.registerDataExchangeSources();
      assert.deepEqual(registered, ["data_exchange_import_definition", "data_exchange_export_definition", "data_exchange_job"]);
    });

    test("ensureDataExchangeSearch is idempotent and installs the object types", () => {
      const first = Search.ensureDataExchangeSearch(db);
      assert.equal(first.created, 0);
      const second = Search.ensureDataExchangeSearch(db);
      assert.equal(second.created, 0);
      for (const code of ["data_exchange_import_definition", "data_exchange_export_definition", "data_exchange_job"]) {
        const row = queryOne(db, "SELECT id FROM search_object_types WHERE code = ? AND tenant_id = ?", [code, tenantId]);
        assert.ok(row, `missing search object type ${code}`);
      }
    });
  });
});
