// Search & Discovery integration for the BOM Engine.
//
// BOM headers, revisions and lines are indexed as read-only search object types
// through the shared Enterprise Search, so BOM content is discoverable with the
// same facets, authorization and saved searches as every other module.
import { queryAll, queryOne } from "../../db.js";
import { registerObjectType, tenantIds } from "../search/registry.js";
import { registerSourceResolver } from "../search/sources.js";
import { getObjectType, registerObjectType as registerSecurityObjectType } from "../security/repository.js";
import { BOM_RESOURCES, SEARCH_OBJECT_TYPES } from "./constants.js";

function defFor(code) {
  return SEARCH_OBJECT_TYPES.find((entry) => entry.code === code);
}

export const SEARCH_REGISTRATIONS = [
  {
    ...defFor("bom"),
    source_module: "bom",
    source_table: "bom_headers",
    title_attribute: "name",
    subtitle_attribute: "bom_number",
    summary_attribute: "description",
    body_attributes: ["bom_number", "name", "description", "bom_type", "status"],
    facet_attributes: ["status", "bom_type"],
    filter_attributes: ["status", "bom_type", "organization_id", "plant_id", "site_id"],
    permission_resource: BOM_RESOURCES.boms,
    display_order: 140,
  },
  {
    ...defFor("bom_revision"),
    source_module: "bom",
    source_table: "bom_revisions",
    title_attribute: "revision_number",
    subtitle_attribute: "revision_ref",
    summary_attribute: "configuration_context",
    body_attributes: ["revision_number", "revision_ref", "status", "variant_code", "configuration_context"],
    facet_attributes: ["status", "variant_code"],
    filter_attributes: ["status", "bom_id", "variant_id", "variant_code"],
    permission_resource: BOM_RESOURCES.revisions,
    display_order: 141,
  },
  {
    ...defFor("bom_line"),
    source_module: "bom",
    source_table: "bom_lines",
    title_attribute: "child_object_id",
    subtitle_attribute: "find_number",
    summary_attribute: "line_ref",
    body_attributes: ["child_object_id", "child_object_type", "find_number", "usage", "line_ref"],
    facet_attributes: ["usage", "line_status"],
    filter_attributes: ["usage", "line_status", "bom_revision_id", "child_object_id", "variant_id"],
    permission_resource: BOM_RESOURCES.lines,
    display_order: 142,
  },
];

function joinText(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => String(part))
    .join(" \n ")
    .toLowerCase();
}

export function registerBomSources() {
  registerSourceResolver("bom", {
    code: "bom",
    table: "bom_headers",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM bom_headers WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "bom",
        objectId: String(row.id),
        code: row.bom_number,
        title: row.name || row.bom_number,
        subtitle: row.bom_number,
        summary: row.description || "",
        searchableText: joinText([row.bom_number, row.name, row.description, row.bom_type, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: "internal",
        tags: [row.bom_type, row.status].filter(Boolean),
        attributes: { bom_number: row.bom_number, bom_type: row.bom_type, status: row.status, organization_id: row.organization_id ?? null },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM bom_headers WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("bom_revision", {
    code: "bom_revision",
    table: "bom_revisions",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM bom_revisions WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      const bom = queryOne(db, "SELECT bom_number, name FROM bom_headers WHERE id = ?", [row.bom_id]);
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "bom_revision",
        objectId: String(row.id),
        code: row.revision_ref,
        title: `${bom?.bom_number ?? row.bom_id} rev ${row.revision_number}`,
        subtitle: row.revision_ref,
        summary: row.configuration_context || "",
        searchableText: joinText([row.revision_ref, row.revision_number, row.status, row.variant_code, row.configuration_context, bom?.bom_number]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: "internal",
        tags: [row.status, row.variant_code].filter(Boolean),
        attributes: { revision_number: row.revision_number, status: row.status, bom_id: row.bom_id, variant_id: row.variant_id ?? null, variant_code: row.variant_code },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM bom_revisions WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("bom_line", {
    code: "bom_line",
    table: "bom_lines",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM bom_lines WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "bom_line",
        objectId: String(row.id),
        code: row.line_ref,
        title: row.child_object_id || row.line_ref,
        subtitle: row.find_number || "",
        summary: row.line_ref,
        searchableText: joinText([row.line_ref, row.child_object_id, row.child_object_type, row.find_number, row.usage, row.reference_designator, row.notes]),
        status: row.line_status,
        ownerId: null,
        classification: "internal",
        tags: [row.usage, row.line_status].filter(Boolean),
        attributes: { child_object_id: row.child_object_id, child_object_type: row.child_object_type, usage: row.usage, line_status: row.line_status, bom_revision_id: row.bom_revision_id },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM bom_lines WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  return SEARCH_REGISTRATIONS.map((entry) => entry.code);
}

export function ensureBomSearch(db) {
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
