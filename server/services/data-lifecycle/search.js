// Search integration.
//
// Lifecycle ledger rows, policies, legal holds and archive records participate
// in the centralized Search & Discovery engine as read-only object types.
// Indexing, querying, authorization and saved searches are reused, not rebuilt.
import { queryAll, queryOne } from "../../db.js";
import { registerObjectType, tenantIds } from "../search/registry.js";
import { registerSourceResolver } from "../search/sources.js";
import { getObjectType, registerObjectType as registerSecurityObjectType } from "../security/repository.js";

export const SEARCH_REGISTRATIONS = [
  {
    code: "lifecycle_object",
    name: "Lifecycle objects",
    description: "Business objects tracked by the data lifecycle service, their state tier and retention",
    source_module: "data-lifecycle",
    source_table: "lc_object_lifecycle",
    title_attribute: "object_ref",
    subtitle_attribute: "object_type",
    summary_attribute: "classification",
    body_attributes: ["object_type", "object_id", "object_ref", "current_state", "data_tier", "classification", "legal_hold_status"],
    facet_attributes: ["current_state", "data_tier", "legal_hold_status", "classification"],
    filter_attributes: ["current_state", "data_tier", "legal_hold_status", "classification", "object_type"],
    permission_resource: "iam.data_lifecycle.objects",
    display_order: 70,
  },
  {
    code: "lifecycle_policy",
    name: "Lifecycle policies",
    description: "Retention, archive, cold-storage and purge policies",
    source_module: "data-lifecycle",
    source_table: "lc_policies",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "description",
    body_attributes: ["code", "name", "description", "scope_type", "retention_basis", "data_tier", "status"],
    facet_attributes: ["scope_type", "status", "retention_basis", "data_tier"],
    filter_attributes: ["scope_type", "status", "retention_basis", "data_tier", "object_type"],
    permission_resource: "iam.data_lifecycle.policies",
    display_order: 71,
  },
  {
    code: "legal_hold",
    name: "Legal holds",
    description: "Legal holds that suspend archive, purge and deletion",
    source_module: "data-lifecycle",
    source_table: "lc_legal_holds",
    title_attribute: "name",
    subtitle_attribute: "code",
    summary_attribute: "reason",
    body_attributes: ["code", "name", "reason", "scope_type", "status", "classification", "business_domain"],
    facet_attributes: ["scope_type", "status", "classification", "business_domain"],
    filter_attributes: ["scope_type", "status", "object_type", "organization_id"],
    permission_resource: "iam.data_lifecycle.legal_holds",
    display_order: 72,
  },
  {
    code: "archive_record",
    name: "Archive records",
    description: "Archive packages, their provider, checksum and status",
    source_module: "data-lifecycle",
    source_table: "lc_archive_records",
    title_attribute: "archive_ref",
    subtitle_attribute: "object_type",
    summary_attribute: "object_id",
    body_attributes: ["archive_ref", "object_type", "object_id", "object_ref", "status", "provider_code", "data_tier"],
    facet_attributes: ["status", "provider_code", "data_tier"],
    filter_attributes: ["status", "provider_code", "data_tier", "object_type"],
    permission_resource: "iam.data_lifecycle.archive",
    display_order: 73,
  },
];

function joinText(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => String(part))
    .join(" \n ")
    .toLowerCase();
}

function makeResolver(def, mapper) {
  registerSourceResolver(def.code, {
    code: def.code,
    table: def.source_table,
    resolve(db, objectId, { tenantId } = {}) {
      const row = queryOne(db, `SELECT * FROM ${def.source_table} WHERE id = ?`, [Number(objectId)]);
      if (!row) return null;
      if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
      return mapper(row);
    },
    listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
      return queryAll(db, `SELECT id, tenant_id FROM ${def.source_table} WHERE tenant_id = ? AND id > ? ORDER BY id LIMIT ?`, [
        Number(tenantId),
        Number(afterId),
        Number(limit),
      ]);
    },
  });
}

export function registerLifecycleSources() {
  makeResolver(SEARCH_REGISTRATIONS[0], (row) => ({
    tenantId: row.tenant_id,
    organizationId: row.organization_id ?? null,
    objectType: "lifecycle_object",
    objectId: String(row.id),
    code: `${row.object_type}:${row.object_id}`,
    title: row.object_ref || `${row.object_type} ${row.object_id}`,
    subtitle: row.object_type,
    summary: `state ${row.current_state} · tier ${row.data_tier}`,
    searchableText: joinText([row.object_type, row.object_id, row.object_ref, row.current_state, row.data_tier, row.classification, row.legal_hold_status]),
    status: row.current_state,
    ownerId: null,
    classification: row.classification || "internal",
    tags: [row.current_state, row.data_tier, row.legal_hold_status].filter(Boolean),
    attributes: {
      object_type: row.object_type,
      current_state: row.current_state,
      data_tier: row.data_tier,
      legal_hold_status: row.legal_hold_status,
      classification: row.classification,
    },
    scoreWeight: 1,
  }));

  makeResolver(SEARCH_REGISTRATIONS[1], (row) => ({
    tenantId: row.tenant_id,
    organizationId: row.organization_id ?? null,
    objectType: "lifecycle_policy",
    objectId: String(row.id),
    code: row.code,
    title: row.name || row.code,
    subtitle: row.code,
    summary: row.description || "",
    searchableText: joinText([row.code, row.name, row.description, row.scope_type, row.retention_basis, row.data_tier, row.status, row.object_type]),
    status: row.status,
    ownerId: row.owner_user_id ?? null,
    classification: "internal",
    tags: [row.scope_type, row.retention_basis, row.status].filter(Boolean),
    attributes: { code: row.code, scope_type: row.scope_type, retention_basis: row.retention_basis, data_tier: row.data_tier, object_type: row.object_type },
    scoreWeight: 1.1,
  }));

  makeResolver(SEARCH_REGISTRATIONS[2], (row) => ({
    tenantId: row.tenant_id,
    organizationId: row.organization_id ?? null,
    objectType: "legal_hold",
    objectId: String(row.id),
    code: row.code,
    title: row.name || row.code,
    subtitle: row.code,
    summary: row.reason || row.description || "",
    searchableText: joinText([row.code, row.name, row.reason, row.description, row.scope_type, row.status, row.classification, row.business_domain]),
    status: row.status,
    ownerId: row.created_by ?? null,
    classification: row.classification || "internal",
    tags: [row.scope_type, row.status].filter(Boolean),
    attributes: { code: row.code, scope_type: row.scope_type, status: row.status, object_type: row.object_type, organization_id: row.organization_id },
    scoreWeight: 1.2,
  }));

  makeResolver(SEARCH_REGISTRATIONS[3], (row) => ({
    tenantId: row.tenant_id,
    organizationId: null,
    objectType: "archive_record",
    objectId: String(row.id),
    code: row.archive_ref,
    title: row.archive_ref,
    subtitle: row.object_type,
    summary: `tier ${row.data_tier} · provider ${row.provider_code}`,
    searchableText: joinText([row.archive_ref, row.object_type, row.object_id, row.object_ref, row.status, row.provider_code, row.data_tier]),
    status: row.status,
    ownerId: null,
    classification: "internal",
    tags: [row.status, row.data_tier, row.provider_code].filter(Boolean),
    attributes: { object_type: row.object_type, status: row.status, provider_code: row.provider_code, data_tier: row.data_tier },
    scoreWeight: 1,
  }));

  return SEARCH_REGISTRATIONS.map((entry) => entry.code);
}

export function ensureLifecycleSearch(db) {
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
