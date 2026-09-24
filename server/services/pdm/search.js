// Search & Discovery integration for the PDM domain.
//
// PDM items, revisions, datasets, representations, CAD associations and baselines
// are indexed as read-only search object types through the shared Enterprise
// Search, so PDM content is discoverable with the same facets, authorization and
// saved searches as every other module.
import { queryAll, queryOne } from "../../db.js";
import { registerObjectType, tenantIds } from "../search/registry.js";
import { registerSourceResolver } from "../search/sources.js";
import { getObjectType, registerObjectType as registerSecurityObjectType } from "../security/repository.js";
import { PDM_RESOURCES, SEARCH_OBJECT_TYPES } from "./constants.js";

function defFor(code) {
  return SEARCH_OBJECT_TYPES.find((entry) => entry.code === code);
}

export const SEARCH_REGISTRATIONS = [
  {
    ...defFor("pdm_item"),
    source_module: "pdm",
    source_table: "pdm_items",
    title_attribute: "name",
    subtitle_attribute: "item_number",
    summary_attribute: "description",
    body_attributes: ["item_number", "name", "description", "item_type", "classification_code", "status"],
    facet_attributes: ["status", "item_type"],
    filter_attributes: ["status", "item_type", "organization_id", "plant_id", "site_id", "classification_code"],
    permission_resource: PDM_RESOURCES.items,
    display_order: 150,
  },
  {
    ...defFor("pdm_revision"),
    source_module: "pdm",
    source_table: "pdm_item_revisions",
    title_attribute: "revision_number",
    subtitle_attribute: "revision_ref",
    summary_attribute: "configuration_context",
    body_attributes: ["revision_number", "revision_ref", "status", "variant_code", "configuration_context"],
    facet_attributes: ["status", "variant_code"],
    filter_attributes: ["status", "item_id", "variant_id", "variant_code"],
    permission_resource: PDM_RESOURCES.revisions,
    display_order: 151,
  },
  {
    ...defFor("pdm_dataset"),
    source_module: "pdm",
    source_table: "pdm_datasets",
    title_attribute: "name",
    subtitle_attribute: "dataset_number",
    summary_attribute: "description",
    body_attributes: ["dataset_number", "name", "description", "dataset_type", "content_reference", "status"],
    facet_attributes: ["status", "dataset_type"],
    filter_attributes: ["status", "dataset_type", "item_id", "revision_id"],
    permission_resource: PDM_RESOURCES.datasets,
    display_order: 152,
  },
  {
    ...defFor("pdm_representation"),
    source_module: "pdm",
    source_table: "pdm_representations",
    title_attribute: "name",
    subtitle_attribute: "representation_ref",
    summary_attribute: "description",
    body_attributes: ["representation_ref", "name", "description", "representation_type", "status"],
    facet_attributes: ["status", "representation_type"],
    filter_attributes: ["status", "representation_type", "item_id", "revision_id", "dataset_id"],
    permission_resource: PDM_RESOURCES.representations,
    display_order: 153,
  },
  {
    ...defFor("pdm_cad_association"),
    source_module: "pdm",
    source_table: "pdm_cad_associations",
    title_attribute: "source_object_id",
    subtitle_attribute: "association_ref",
    summary_attribute: "application",
    body_attributes: ["association_ref", "source_object_id", "cad_type", "association_type", "application", "status"],
    facet_attributes: ["cad_type", "association_type", "status"],
    filter_attributes: ["cad_type", "association_type", "status", "item_id", "source_revision_id", "dataset_id"],
    permission_resource: PDM_RESOURCES.cad,
    display_order: 154,
  },
  {
    ...defFor("pdm_baseline"),
    source_module: "pdm",
    source_table: "pdm_baselines",
    title_attribute: "name",
    subtitle_attribute: "baseline_number",
    summary_attribute: "description",
    body_attributes: ["baseline_number", "name", "description", "status"],
    facet_attributes: ["status"],
    filter_attributes: ["status", "item_id"],
    permission_resource: PDM_RESOURCES.baselines,
    display_order: 155,
  },
];

function joinText(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => String(part))
    .join(" \n ")
    .toLowerCase();
}

export function registerPdmSources() {
  registerSourceResolver("pdm_item", {
    code: "pdm_item",
    table: "pdm_items",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM pdm_items WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "pdm_item",
        objectId: String(row.id),
        code: row.item_number,
        title: row.name || row.item_number,
        subtitle: row.item_number,
        summary: row.description || "",
        searchableText: joinText([row.item_number, row.item_ref, row.name, row.description, row.item_type, row.classification_code, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: "internal",
        tags: [row.item_type, row.status].filter(Boolean),
        attributes: { item_number: row.item_number, item_type: row.item_type, status: row.status, organization_id: row.organization_id ?? null, classification_code: row.classification_code },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM pdm_items WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("pdm_revision", {
    code: "pdm_revision",
    table: "pdm_item_revisions",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM pdm_item_revisions WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      const item = queryOne(db, "SELECT item_number, name FROM pdm_items WHERE id = ?", [row.item_id]);
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "pdm_revision",
        objectId: String(row.id),
        code: row.revision_ref,
        title: `${item?.item_number ?? row.item_id} rev ${row.revision_number}`,
        subtitle: row.revision_ref,
        summary: row.configuration_context || "",
        searchableText: joinText([row.revision_ref, row.revision_number, row.status, row.variant_code, row.configuration_context, item?.item_number, item?.name]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: "internal",
        tags: [row.status, row.variant_code].filter(Boolean),
        attributes: { revision_number: row.revision_number, status: row.status, item_id: row.item_id, variant_id: row.variant_id ?? null, variant_code: row.variant_code },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM pdm_item_revisions WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("pdm_dataset", {
    code: "pdm_dataset",
    table: "pdm_datasets",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM pdm_datasets WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "pdm_dataset",
        objectId: String(row.id),
        code: row.dataset_number,
        title: row.name || row.dataset_number,
        subtitle: row.dataset_number,
        summary: row.description || row.content_reference || "",
        searchableText: joinText([row.dataset_number, row.dataset_ref, row.name, row.description, row.dataset_type, row.content_type, row.content_reference, row.status]),
        status: row.status,
        ownerId: row.owner_user_id ?? null,
        classification: "internal",
        tags: [row.dataset_type, row.status].filter(Boolean),
        attributes: { dataset_number: row.dataset_number, dataset_type: row.dataset_type, status: row.status, item_id: row.item_id ?? null, revision_id: row.revision_id ?? null },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM pdm_datasets WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("pdm_representation", {
    code: "pdm_representation",
    table: "pdm_representations",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM pdm_representations WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "pdm_representation",
        objectId: String(row.id),
        code: row.representation_ref,
        title: row.name || row.representation_ref,
        subtitle: row.representation_ref,
        summary: row.description || "",
        searchableText: joinText([row.representation_ref, row.name, row.description, row.representation_type, row.status]),
        status: row.status,
        ownerId: null,
        classification: "internal",
        tags: [row.representation_type, row.status].filter(Boolean),
        attributes: { representation_type: row.representation_type, status: row.status, item_id: row.item_id ?? null, revision_id: row.revision_id ?? null, dataset_id: row.dataset_id ?? null },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM pdm_representations WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("pdm_cad_association", {
    code: "pdm_cad_association",
    table: "pdm_cad_associations",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM pdm_cad_associations WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "pdm_cad_association",
        objectId: String(row.id),
        code: row.association_ref,
        title: row.source_object_id || row.association_ref,
        subtitle: row.association_ref,
        summary: row.application || "",
        searchableText: joinText([row.association_ref, row.source_object_id, row.cad_type, row.association_type, row.application, row.status]),
        status: row.status,
        ownerId: null,
        classification: "internal",
        tags: [row.cad_type, row.association_type, row.status].filter(Boolean),
        attributes: { cad_type: row.cad_type, association_type: row.association_type, status: row.status, item_id: row.item_id ?? null, source_revision_id: row.source_revision_id ?? null, dataset_id: row.dataset_id },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM pdm_cad_associations WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  registerSourceResolver("pdm_baseline", {
    code: "pdm_baseline",
    table: "pdm_baselines",
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, "SELECT * FROM pdm_baselines WHERE id = ?", [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return {
        tenantId: row.tenant_id,
        organizationId: row.organization_id ?? null,
        objectType: "pdm_baseline",
        objectId: String(row.id),
        code: row.baseline_number,
        title: row.name || row.baseline_number,
        subtitle: row.baseline_number,
        summary: row.description || "",
        searchableText: joinText([row.baseline_number, row.baseline_ref, row.name, row.description, row.status]),
        status: row.status,
        ownerId: row.created_by ?? null,
        classification: "internal",
        tags: [row.status].filter(Boolean),
        attributes: { baseline_number: row.baseline_number, status: row.status, item_id: row.item_id ?? null, member_count: row.member_count },
        scoreWeight: 1,
      };
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, "SELECT id, tenant_id FROM pdm_baselines WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?", [Number(tenantId), Number(afterId), Number(limit)]);
    },
  });

  return SEARCH_REGISTRATIONS.map((entry) => entry.code);
}

export function ensurePdmSearch(db) {
  let created = 0;
  for (const tenantId of tenantIds(db)) {
    for (const def of SEARCH_REGISTRATIONS) {
      const existing = queryOne(db, "SELECT id FROM search_object_types WHERE code = ? AND tenant_id = ?", [def.code, Number(tenantId)]);
      if (!existing) {
        registerObjectType(db, def, null, tenantId, null);
        created += 1;
      }
      if (!getObjectType(db, tenantId, def.code)) {
        registerSecurityObjectType(db, { object_type: def.code, enforcement: "tenant", permission_resource: def.permission_resource }, null, tenantId);
      }
    }
  }
  return { created };
}
