// Search & Discovery integration for the Standards & Exchange domain.
//
// Formats, definitions and transactions are indexed as read-only search object
// types through the shared Enterprise Search, so exchange configuration and
// history are discoverable with the same facets, authorization and saved
// searches as every other module.
import { queryAll, queryOne } from "../../db.js";
import { registerObjectType, tenantIds } from "../search/registry.js";
import { registerSourceResolver } from "../search/sources.js";
import { getObjectType, registerObjectType as registerSecurityObjectType } from "../security/repository.js";
import { EXCHANGE_RESOURCES, SEARCH_OBJECT_TYPES } from "./constants.js";

function defFor(code) {
  return SEARCH_OBJECT_TYPES.find((entry) => entry.code === code);
}

function joinText(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => String(part))
    .join(" \n ")
    .toLowerCase();
}

export const SEARCH_REGISTRATIONS = [
  {
    ...defFor("exchange_format"),
    source_module: "exchange",
    source_table: "exchange_formats",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "name", "description", "standard_name", "standard_version", "category", "status"],
    facet_attributes: ["category", "status", "direction"],
    filter_attributes: ["status", "category", "direction"],
    permission_resource: EXCHANGE_RESOURCES.formats,
    display_order: 210,
  },
  {
    ...defFor("exchange_definition"),
    source_module: "exchange",
    source_table: "exchange_definitions",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "name", "description", "format_code", "direction", "source_object_type", "target_object_type", "status"],
    facet_attributes: ["format_code", "direction", "status"],
    filter_attributes: ["status", "format_code", "direction", "organization_id"],
    permission_resource: EXCHANGE_RESOURCES.definitions,
    display_order: 211,
  },
  {
    ...defFor("exchange_transaction"),
    source_module: "exchange",
    source_table: "exchange_transactions",
    title_attribute: "transaction_ref",
    subtitle_attribute: "definition_code",
    summary_attribute: "status",
    body_attributes: ["transaction_ref", "definition_code", "format_code", "direction", "operation", "status"],
    facet_attributes: ["direction", "operation", "status"],
    filter_attributes: ["status", "direction", "operation", "definition_code"],
    permission_resource: EXCHANGE_RESOURCES.history,
    display_order: 212,
  },
];

export function registerExchangeSources() {
  registerSourceResolver("exchange_format", {
    code: "exchange_format",
    table: "exchange_formats",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM exchange_formats WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: null,
        objectType: "exchange_format",
        objectId: String(row.id),
        code: row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.description, row.standard_name, row.category, row.status]),
        status: row.status,
        ownerId: row.created_by ?? null,
        classification: "internal",
        tags: [row.category, row.status].filter(Boolean),
        attributes: { category: row.category, direction: row.direction },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM exchange_formats WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("exchange_definition", {
    code: "exchange_definition",
    table: "exchange_definitions",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM exchange_definitions WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "exchange_definition",
        objectId: String(row.id),
        code: row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.description, row.format_code, row.direction, row.status]),
        status: row.status,
        ownerId: row.created_by ?? null,
        classification: "internal",
        tags: [row.format_code, row.direction, row.status].filter(Boolean),
        attributes: { format_code: row.format_code, direction: row.direction, organization_id: row.organization_id ?? null },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM exchange_definitions WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("exchange_transaction", {
    code: "exchange_transaction",
    table: "exchange_transactions",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM exchange_transactions WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "exchange_transaction",
        objectId: String(row.id),
        code: row.transaction_ref,
        title: row.transaction_ref,
        subtitle: `${row.direction} ${row.operation}`,
        summary: row.status,
        searchableText: joinText([row.transaction_ref, row.definition_code, row.format_code, row.direction, row.operation, row.status]),
        status: row.status,
        ownerId: row.created_by ?? null,
        classification: "internal",
        tags: [row.direction, row.operation, row.status].filter(Boolean),
        attributes: { direction: row.direction, operation: row.operation, definition_code: row.definition_code },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM exchange_transactions WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  return SEARCH_REGISTRATIONS.map((entry) => entry.code);
}

export function ensureExchangeSearch(db) {
  let created = 0;
  for (const tenantId of tenantIds(db)) {
    for (const def of SEARCH_REGISTRATIONS) {
      const existing = queryOne(db, "SELECT id FROM search_object_types WHERE code = ? AND tenant_id = ?", [def.code, Number(tenantId)]);
      if (!existing) {
        registerObjectType(db, def, null, tenantId, null);
        created += 1;
      }
      if (!getObjectType(db, Number(tenantId), def.code)) {
        registerSecurityObjectType(db, { object_type: def.code, enforcement: "tenant", permission_resource: def.permission_resource }, null, tenantId);
      }
    }
  }
  return { created };
}
