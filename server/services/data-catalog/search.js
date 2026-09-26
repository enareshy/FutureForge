// Search integration. Catalog records participate in the centralized Search &
// Discovery engine as read-only object types; indexing, querying,
// authorization and saved searches are entirely reused, not rebuilt.
import { queryAll, queryOne } from "../../db.js";
import { registerObjectType, tenantIds } from "../search/registry.js";
import { registerSourceResolver } from "../search/sources.js";
import { safeParse } from "../search/repository.js";
import { getObjectType, registerObjectType as registerSecurityObjectType } from "../security/repository.js";

export const SEARCH_REGISTRATIONS = [
  {
    code: "business_term",
    name: "Business glossary terms",
    description: "Business terms, their definitions, approval status and owning domain",
    source_module: "data-catalog",
    source_table: "dc_business_terms",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "definition",
    body_attributes: ["code", "preferred_name", "definition", "status", "approval_status"],
    facet_attributes: ["status", "approval_status", "domain_id"],
    filter_attributes: ["status", "approval_status", "domain_id"],
    permission_resource: "iam.data_catalog.terms",
    display_order: 62,
  },
  {
    code: "catalog_object",
    name: "Catalog data objects",
    description: "Cataloged enterprise object types, their domain, source and classification",
    source_module: "data-catalog",
    source_table: "dc_catalog_objects",
    title_attribute: "display_name",
    subtitle_attribute: "object_type",
    summary_attribute: "description",
    body_attributes: ["object_type", "target_object_type", "status", "classification"],
    facet_attributes: ["status", "classification", "domain_id"],
    filter_attributes: ["status", "classification", "domain_id", "source_id"],
    permission_resource: "iam.data_catalog.objects",
    display_order: 63,
  },
  {
    code: "catalog_attribute",
    name: "Catalog attributes",
    description: "Cataloged object attributes and their definitions",
    source_module: "data-catalog",
    source_table: "dc_catalog_attributes",
    title_attribute: "display_name",
    subtitle_attribute: "attribute_name",
    summary_attribute: "description",
    body_attributes: ["attribute_name", "data_type", "status", "classification"],
    facet_attributes: ["status", "classification", "data_type"],
    filter_attributes: ["status", "classification", "data_type", "object_id"],
    permission_resource: "iam.data_catalog.attributes",
    display_order: 64,
  },
  {
    code: "data_source",
    name: "Catalog data sources",
    description: "Systems that originate cataloged data",
    source_module: "data-catalog",
    source_table: "dc_sources",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["source_type", "system", "status", "classification"],
    facet_attributes: ["source_type", "status", "classification"],
    filter_attributes: ["source_type", "status", "classification"],
    permission_resource: "iam.data_catalog.sources",
    display_order: 65,
  },
  {
    code: "data_consumer",
    name: "Catalog data consumers",
    description: "Systems, services and audiences that consume cataloged data",
    source_module: "data-catalog",
    source_table: "dc_consumers",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "purpose",
    body_attributes: ["consumer_type", "purpose", "frequency", "status", "classification"],
    facet_attributes: ["consumer_type", "status", "classification"],
    filter_attributes: ["consumer_type", "status", "classification"],
    permission_resource: "iam.data_catalog.consumers",
    display_order: 66,
  },
];

function joinText(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => String(part))
    .join(" \n ")
    .toLowerCase();
}

export function registerCatalogSources() {
  registerSourceResolver("business_term", {
    code: "business_term",
    table: "dc_business_terms",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM dc_business_terms WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: null,
        objectType: "business_term",
        objectId: String(row.id),
        code: row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.definition || row.description || "",
        searchableText: joinText([row.code, row.name, row.preferred_name, row.definition, row.description, row.status, row.approval_status]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: row.classification || "internal",
        tags: [row.status, row.approval_status].filter(Boolean),
        attributes: { code: row.code, domain_id: row.domain_id, approval_status: row.approval_status, status: row.status },
        scoreWeight: 1.2,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM dc_business_terms WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [
        Number(tenantId),
        Number(afterId),
        Number(limit),
      ]);
    },
  });

  registerSourceResolver("catalog_object", {
    code: "catalog_object",
    table: "dc_catalog_objects",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM dc_catalog_objects WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: null,
        objectType: "catalog_object",
        objectId: String(row.id),
        code: row.object_type,
        title: row.display_name || row.object_type,
        subtitle: row.object_type,
        summary: row.description || "",
        searchableText: joinText([row.object_type, row.display_name, row.description, row.target_object_type, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: row.classification || "internal",
        tags: [row.status, row.classification].filter(Boolean),
        attributes: { object_type: row.object_type, domain_id: row.domain_id, source_id: row.source_id, target_object_type: row.target_object_type },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM dc_catalog_objects WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [
        Number(tenantId),
        Number(afterId),
        Number(limit),
      ]);
    },
  });

  registerSourceResolver("catalog_attribute", {
    code: "catalog_attribute",
    table: "dc_catalog_attributes",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM dc_catalog_attributes WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: null,
        objectType: "catalog_attribute",
        objectId: String(row.id),
        code: row.attribute_ref,
        title: row.display_name || row.attribute_name,
        subtitle: row.attribute_name,
        summary: row.description || row.business_definition || "",
        searchableText: joinText([row.attribute_name, row.display_name, row.description, row.business_definition, row.data_type, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: row.classification || "internal",
        tags: [row.status, row.data_type].filter(Boolean),
        attributes: { object_id: row.object_id, data_type: row.data_type, domain_id: row.domain_id, source_id: row.source_id },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM dc_catalog_attributes WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [
        Number(tenantId),
        Number(afterId),
        Number(limit),
      ]);
    },
  });

  registerSourceResolver("data_source", {
    code: "data_source",
    table: "dc_sources",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM dc_sources WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: null,
        objectType: "data_source",
        objectId: String(row.id),
        code: row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.description || "",
        searchableText: joinText([row.code, row.name, row.system, row.description, row.source_type, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: row.classification || "internal",
        tags: [row.source_type, row.status].filter(Boolean),
        attributes: { code: row.code, source_type: row.source_type, system: row.system, status: row.status },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM dc_sources WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [
        Number(tenantId),
        Number(afterId),
        Number(limit),
      ]);
    },
  });

  registerSourceResolver("data_consumer", {
    code: "data_consumer",
    table: "dc_consumers",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM dc_consumers WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: null,
        objectType: "data_consumer",
        objectId: String(row.id),
        code: row.code,
        title: row.name || row.code,
        subtitle: row.code,
        summary: row.purpose || row.description || "",
        searchableText: joinText([row.code, row.name, row.purpose, row.description, row.consumer_type, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: row.classification || "internal",
        tags: [row.consumer_type, row.status].filter(Boolean),
        attributes: { code: row.code, consumer_type: row.consumer_type, purpose: row.purpose, frequency: row.frequency, status: row.status },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM dc_consumers WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [
        Number(tenantId),
        Number(afterId),
        Number(limit),
      ]);
    },
  });

  return SEARCH_REGISTRATIONS.map((entry) => entry.code);
}

// Ensures each tenant has the search object types registered and mirrors them
// into the security object-type registry so search results are authorized.
export function ensureCatalogSearch(db) {
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
