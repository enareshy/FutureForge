// Search integration. Governance records participate in the centralized Search
// & Discovery engine as read-only object types; the search machinery (indexing,
// querying, authorization, saved searches) is entirely reused, not rebuilt.
import { queryAll, queryOne } from "../../db.js";
import { registerObjectType } from "../search/registry.js";
import { registerSourceResolver } from "../search/sources.js";
import { safeParse } from "../search/repository.js";
import { tenantIds } from "../search/registry.js";
import { getObjectType } from "../security/repository.js";
import { registerObjectType as registerSecurityObjectType } from "../security/repository.js";

export const SEARCH_REGISTRATIONS = [
  {
    code: "data_quality_exception",
    name: "Data quality exceptions",
    description: "Quality exceptions, their rule, severity, priority and lifecycle status",
    source_module: "data-governance",
    source_table: "dg_quality_exceptions",
    title_attribute: "exception_ref",
    subtitle_attribute: "rule_code",
    summary_attribute: "description",
    body_attributes: ["rule_code", "dimension", "severity", "status", "priority"],
    facet_attributes: ["status", "severity", "priority", "dimension"],
    filter_attributes: ["status", "severity", "dimension", "rule_code"],
    permission_resource: "iam.data_quality.exceptions",
    display_order: 60,
  },
  {
    code: "data_domain",
    name: "Data domains",
    description: "Governance domains, their category and ownership",
    source_module: "data-governance",
    source_table: "dg_domains",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "category", "status"],
    facet_attributes: ["status", "category"],
    filter_attributes: ["status", "category"],
    permission_resource: "iam.data_governance.domains",
    display_order: 61,
  },
];

function joinText(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => String(part))
    .join(" \n ")
    .toLowerCase();
}

export function registerDataGovernanceSources() {
  registerSourceResolver("data_quality_exception", {
    code: "data_quality_exception",
    table: "dg_quality_exceptions",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM dg_quality_exceptions WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "data_quality_exception",
        objectId: String(row.id),
        code: row.exception_ref,
        title: row.exception_ref,
        subtitle: row.rule_code || "",
        summary: row.description || "",
        searchableText: joinText([row.exception_ref, row.rule_code, row.object_type, row.object_id, row.description, row.dimension, row.severity, row.status]),
        status: row.status,
        ownerId: row.assignee_user_id ?? row.owner_user_id ?? null,
        classification: "internal",
        tags: [row.dimension, row.severity].filter(Boolean),
        attributes: {
          rule_code: row.rule_code,
          dimension: row.dimension,
          severity: row.severity,
          priority: row.priority,
          status: row.status,
          object_type: row.object_type,
          object_id: row.object_id,
        },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(
        db,
        `SELECT id, tenant_id FROM dg_quality_exceptions WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?`,
        [Number(tenantId), Number(afterId), Number(limit)]
      );
    },
  });

  registerSourceResolver("data_domain", {
    code: "data_domain",
    table: "dg_domains",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM dg_domains WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "data_domain",
        objectId: String(row.id),
        code: row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.description, row.category, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: "internal",
        tags: [row.category, row.status].filter(Boolean),
        attributes: { code: row.code, category: row.category, status: row.status, parent_id: row.parent_id },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(
        db,
        `SELECT id, tenant_id FROM dg_domains WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?`,
        [Number(tenantId), Number(afterId), Number(limit)]
      );
    },
  });
  return SEARCH_REGISTRATIONS.map((entry) => entry.code);
}

// Ensures each tenant has the search object types registered. Also mirrors them
// into the security object-type registry with tenant isolation so the security
// engine can authorize search results.
export function ensureDataGovernanceSearch(db) {
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

export { safeParse };
