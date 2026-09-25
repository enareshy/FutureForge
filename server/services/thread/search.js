// Search & Discovery integration for the Digital Thread domain.
//
// Definitions, snapshots and baselines are indexed as read-only search object
// types through the shared Enterprise Search, so thread configuration and
// controlled projections are discoverable with the same facets, authorization
// and saved searches as every other module.
import { queryAll, queryOne } from "../../db.js";
import { registerObjectType, tenantIds } from "../search/registry.js";
import { registerSourceResolver } from "../search/sources.js";
import { getObjectType, registerObjectType as registerSecurityObjectType } from "../security/repository.js";
import { THREAD_RESOURCES, SEARCH_OBJECT_TYPES } from "./constants.js";

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
    ...defFor("thread_definition"),
    source_module: "thread",
    source_table: "thread_definitions",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "name", "description", "thread_type", "root_object_type", "status"],
    facet_attributes: ["thread_type", "status"],
    filter_attributes: ["status", "thread_type", "organization_id"],
    permission_resource: THREAD_RESOURCES.definitions,
    display_order: 200,
  },
  {
    ...defFor("thread_snapshot"),
    source_module: "thread",
    source_table: "thread_snapshots",
    title_attribute: "name",
    subtitle_attribute: "snapshot_ref",
    summary_attribute: "description",
    body_attributes: ["snapshot_ref", "name", "description", "definition_code", "root_object_type", "status"],
    facet_attributes: ["status", "definition_code"],
    filter_attributes: ["status", "definition_code", "root_object_type", "organization_id"],
    permission_resource: THREAD_RESOURCES.snapshots,
    display_order: 201,
  },
  {
    ...defFor("thread_baseline"),
    source_module: "thread",
    source_table: "thread_baselines",
    title_attribute: "name",
    subtitle_attribute: "baseline_ref",
    summary_attribute: "description",
    body_attributes: ["baseline_ref", "name", "description", "definition_code", "status"],
    facet_attributes: ["status", "definition_code"],
    filter_attributes: ["status", "definition_code", "organization_id"],
    permission_resource: THREAD_RESOURCES.baselines,
    display_order: 202,
  },
];

export function registerThreadSources() {
  registerSourceResolver("thread_definition", {
    code: "thread_definition",
    table: "thread_definitions",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM thread_definitions WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "thread_definition",
        objectId: String(row.id),
        code: row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.description, row.thread_type, row.root_object_type, row.status]),
        status: row.status,
        ownerId: row.created_by ?? null,
        classification: "internal",
        tags: [row.thread_type, row.status].filter(Boolean),
        attributes: { thread_type: row.thread_type, root_object_type: row.root_object_type, organization_id: row.organization_id ?? null },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM thread_definitions WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("thread_snapshot", {
    code: "thread_snapshot",
    table: "thread_snapshots",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM thread_snapshots WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "thread_snapshot",
        objectId: String(row.id),
        code: row.snapshot_ref,
        title: row.name || row.snapshot_ref,
        subtitle: row.snapshot_ref,
        summary: row.description || "",
        searchableText: joinText([row.snapshot_ref, row.name, row.description, row.definition_code, row.root_object_type, row.status]),
        status: row.status,
        ownerId: row.created_by ?? null,
        classification: "internal",
        tags: [row.definition_code, row.status].filter(Boolean),
        attributes: { definition_code: row.definition_code, root_object_type: row.root_object_type, node_count: row.node_count, edge_count: row.edge_count, organization_id: row.organization_id ?? null },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM thread_snapshots WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("thread_baseline", {
    code: "thread_baseline",
    table: "thread_baselines",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM thread_baselines WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "thread_baseline",
        objectId: String(row.id),
        code: row.baseline_ref,
        title: row.name || row.baseline_ref,
        subtitle: row.baseline_ref,
        summary: row.description || "",
        searchableText: joinText([row.baseline_ref, row.name, row.description, row.definition_code, row.status]),
        status: row.status,
        ownerId: row.created_by ?? null,
        classification: "internal",
        tags: [row.definition_code, row.status].filter(Boolean),
        attributes: { definition_code: row.definition_code, member_count: row.member_count, organization_id: row.organization_id ?? null },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM thread_baselines WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  return SEARCH_REGISTRATIONS.map((entry) => entry.code);
}

export function ensureThreadSearch(db) {
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
