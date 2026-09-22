// Search & Discovery integration. Exchange definitions and jobs are indexed as
// read-only search object types so operators can find them through the shared
// Enterprise Search instead of a bespoke listing UI. Indexing, querying,
// authorization and saved searches are all reused.
import { queryAll, queryOne } from "../../db.js";
import { registerObjectType } from "../search/registry.js";
import { registerSourceResolver } from "../search/sources.js";
import { tenantIds } from "../search/registry.js";
import { getObjectType } from "../security/repository.js";
import { registerObjectType as registerSecurityObjectType } from "../security/repository.js";

export const SEARCH_REGISTRATIONS = [
  {
    code: "data_exchange_import_definition",
    name: "Import definitions",
    description: "Import definitions, their source systems, target object types and status",
    source_module: "data-exchange",
    source_table: "ie_import_definitions",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "target_object_type", "source_type", "status", "mode"],
    facet_attributes: ["status", "source_type", "target_object_type", "mode"],
    filter_attributes: ["status", "source_type", "target_object_type", "mode"],
    permission_resource: "iam.data_exchange.import_definitions",
    display_order: 80,
  },
  {
    code: "data_exchange_export_definition",
    name: "Export definitions",
    description: "Export definitions, their formats, destinations and status",
    source_module: "data-exchange",
    source_table: "ie_export_definitions",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "object_type", "format", "destination", "status"],
    facet_attributes: ["status", "format", "destination", "object_type"],
    filter_attributes: ["status", "format", "destination", "object_type"],
    permission_resource: "iam.data_exchange.export_definitions",
    display_order: 81,
  },
  {
    code: "data_exchange_job",
    name: "Data exchange jobs",
    description: "Import and export job runs, their mode, status and error summary",
    source_module: "data-exchange",
    source_table: "ie_import_jobs",
    title_attribute: "job_ref",
    subtitle_attribute: "target_object_type",
    summary_attribute: "error_message",
    body_attributes: ["job_ref", "mode", "status", "target_object_type", "source_type"],
    facet_attributes: ["status", "mode", "source_type", "target_object_type"],
    filter_attributes: ["status", "mode", "source_type", "target_object_type"],
    permission_resource: "iam.data_exchange.jobs",
    display_order: 82,
  },
];

function joinText(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => String(part))
    .join(" \n ")
    .toLowerCase();
}

export function registerDataExchangeSources() {
  registerSourceResolver("data_exchange_import_definition", {
    code: "data_exchange_import_definition",
    table: "ie_import_definitions",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM ie_import_definitions WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "data_exchange_import_definition",
        objectId: String(row.id),
        code: row.definition_ref || row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.description, row.target_object_type, row.source_type, row.status, row.mode]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: "internal",
        tags: [row.source_type, row.target_object_type, row.status].filter(Boolean),
        attributes: { code: row.code, source_type: row.source_type, target_object_type: row.target_object_type, status: row.status, mode: row.mode },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(
        db,
        "SELECT id, tenant_id FROM ie_import_definitions WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?",
        [Number(tenantId), Number(afterId), Number(limit)]
      );
    },
  });

  registerSourceResolver("data_exchange_export_definition", {
    code: "data_exchange_export_definition",
    table: "ie_export_definitions",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM ie_export_definitions WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "data_exchange_export_definition",
        objectId: String(row.id),
        code: row.definition_ref || row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.description, row.object_type, row.format, row.destination, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: "internal",
        tags: [row.format, row.destination, row.status].filter(Boolean),
        attributes: { code: row.code, format: row.format, destination: row.destination, object_type: row.object_type, status: row.status },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(
        db,
        "SELECT id, tenant_id FROM ie_export_definitions WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?",
        [Number(tenantId), Number(afterId), Number(limit)]
      );
    },
  });

  registerSourceResolver("data_exchange_job", {
    code: "data_exchange_job",
    table: "ie_import_jobs",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM ie_import_jobs WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "data_exchange_job",
        objectId: String(row.id),
        code: row.job_ref,
        title: row.job_ref,
        subtitle: row.target_object_type || "",
        summary: row.error_message || "",
        searchableText: joinText([row.job_ref, row.mode, row.status, row.source_type, row.target_object_type, row.error_message]),
        status: row.status,
        ownerId: row.created_by ?? null,
        classification: "internal",
        tags: [row.mode, row.status, row.source_type].filter(Boolean),
        attributes: { mode: row.mode, status: row.status, source_type: row.source_type, target_object_type: row.target_object_type },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(
        db,
        "SELECT id, tenant_id FROM ie_import_jobs WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?",
        [Number(tenantId), Number(afterId), Number(limit)]
      );
    },
  });

  return SEARCH_REGISTRATIONS.map((entry) => entry.code);
}

export function ensureDataExchangeSearch(db) {
  let created = 0;
  for (const tenantId of tenantIds(db)) {
    for (const def of SEARCH_REGISTRATIONS) {
      const existing = queryOne(db, "SELECT id FROM search_object_types WHERE code = ? AND tenant_id = ?", [def.code, Number(tenantId)]);
      if (!existing) {
        registerObjectType(db, def, null, tenantId, null);
        created += 1;
      }
      if (!getObjectType(db, tenantId, def.code)) {
        registerSecurityObjectType(
          db,
          { object_type: def.code, enforcement: "tenant", permission_resource: def.permission_resource },
          null,
          tenantId
        );
      }
    }
  }
  return { created };
}
