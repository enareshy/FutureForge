// Demonstration seed for the Import & Export Framework. Idempotent: it installs
// the built-in connectors/foundation plus a small, realistic exchange estate (a
// CSV connector, customer import/export definitions and a template) so an
// administrator can see the capability working immediately. Real organizations
// configure their own definitions.
import { queryOne } from "../../db.js";
import { withEventSuppression } from "../events/emit.js";
import { ensureExchangeFoundation } from "./foundation.js";
import { createConnectorConfiguration } from "./connector-configs.js";
import { createImportDefinition } from "./import-definitions.js";
import { createExportDefinition } from "./export-definitions.js";
import { createTemplate } from "./templates.js";

const IMPORT_MAPPINGS = [
  { source_field: "part_number", target_field: "code", mapping_type: "DIRECT", required: true },
  { source_field: "part_number", target_field: "part.number", mapping_type: "DIRECT", required: true },
  { source_field: "part_name", target_field: "name", mapping_type: "DIRECT", required: true },
  { source_field: "part_name", target_field: "part.name", mapping_type: "DIRECT", required: true },
  { source_field: "part_category", target_field: "part.category", mapping_type: "DIRECT", required: true },
  { source_field: "notes", target_field: "description", mapping_type: "DIRECT" },
  { source_field: "state", target_field: "status", mapping_type: "DEFAULT", default_value: "draft" },
];

const IMPORT_RULES = [
  { level: "FIELD", target_field: "part.number", rule_type: "REQUIRED", message: "Part number is required" },
  { level: "FIELD", target_field: "part.name", rule_type: "REQUIRED", message: "Part name is required" },
];

const EXPORT_FIELDS = [
  { field_path: "code", display_name: "Part Number", data_type: "string" },
  { field_path: "name", display_name: "Part Name", data_type: "string" },
  { field_path: "description", display_name: "Description", data_type: "string" },
  { field_path: "status", display_name: "Status", data_type: "string" },
];

export function seedDataExchange(db, tenantId) {
  return withEventSuppression(() => {
    const tenant = resolveTenantId(db, tenantId);
    const foundation = ensureExchangeFoundation(db);
    const created = { connector_configurations: 0, import_definitions: 0, export_definitions: 0, templates: 0 };
    if (!tenant) return { foundation, created, seeded: false, reason: "no_tenant" };

    if (!queryOne(db, "SELECT id FROM ie_connector_configurations WHERE tenant_id = ? AND code = 'PART_CSV'", [tenant])) {
      createConnectorConfiguration(
        db,
        tenant,
        {
          code: "PART_CSV",
          name: "Part master CSV files",
          connector_type: "CSV",
          direction: "SOURCE",
          settings: { delimiter: ",", has_header: true },
        },
        null,
        null
      );
      created.connector_configurations += 1;
    }

    if (!queryOne(db, "SELECT id FROM ie_import_definitions WHERE tenant_id = ? AND code = 'PART_IMPORT'", [tenant])) {
      createImportDefinition(
        db,
        tenant,
        {
          code: "PART_IMPORT",
          name: "Part master import",
          description: "Import part master records from a CSV extract.",
          target_object_type: "product",
          source_type: "CSV",
          mappings: IMPORT_MAPPINGS,
          validation_rules: IMPORT_RULES,
          duplicate_strategy: "UPSERT",
          duplicate_key: { type: "BUSINESS_KEY", fields: ["code"] },
          error_strategy: "CONTINUE",
          status: "ACTIVE",
        },
        null,
        null
      );
      created.import_definitions += 1;
    }

    if (!queryOne(db, "SELECT id FROM ie_export_definitions WHERE tenant_id = ? AND code = 'PART_EXPORT'", [tenant])) {
      createExportDefinition(
        db,
        tenant,
        {
          code: "PART_EXPORT",
          name: "Part master export",
          description: "Export part master records as a CSV or JSON extract.",
          object_type: "product",
          format: "CSV",
          destination: "DOWNLOAD",
          field_selections: EXPORT_FIELDS,
          sort: [{ field: "code", direction: "asc" }],
          status: "ACTIVE",
        },
        null,
        null
      );
      created.export_definitions += 1;
    }

    if (!queryOne(db, "SELECT id FROM ie_templates WHERE tenant_id = ? AND code = 'PART_IMPORT_TEMPLATE'", [tenant])) {
      createTemplate(
        db,
        tenant,
        {
          code: "PART_IMPORT_TEMPLATE",
          name: "Part import starter",
          description: "Starter template for part master imports.",
          direction: "IMPORT",
          object_type: "product",
          status: "ACTIVE",
          definition: { mappings: IMPORT_MAPPINGS, validation_rules: IMPORT_RULES, duplicate_strategy: "UPSERT" },
        },
        null,
        null
      );
      created.templates += 1;
    }

    return { foundation, created, seeded: true };
  });
}

function resolveTenantId(db, tenantId) {
  const explicit = Number(tenantId);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  const helix = queryOne(db, "SELECT id FROM organizations WHERE code = 'helix'");
  return helix?.id ?? null;
}

export function ensureDataExchangeSeed(db, tenantId) {
  const tenant = resolveTenantId(db, tenantId);
  if (!tenant) return { seeded: false, reason: "no_tenant" };
  const existing = queryOne(db, "SELECT id FROM ie_import_definitions WHERE tenant_id = ? AND code = 'PART_IMPORT'", [tenant]);
  if (existing) return { seeded: false, reason: "already_present" };
  return seedDataExchange(db, tenant);
}
