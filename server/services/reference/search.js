// Search integration for Enterprise Reference Data Management. Reference items
// become searchable through the platform Search framework via a source
// resolver; the indexer never reaches into reference tables directly.
import { queryAll, queryOne } from "../../db.js";
import { registerSourceResolver } from "../search/sources.js";
import { registerObjectType, getObjectType } from "../search/registry.js";
import { applyIndexChange } from "../search/indexing.js";

function safeParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export const REFERENCE_ITEM_SOURCE = {
  code: "reference_item",
  table: "reference_data_items",
  resolve(db, itemId, { tenantId } = {}) {
    const row = queryOne(db, "SELECT * FROM reference_data_items WHERE id = ?", [Number(itemId)]);
    if (!row) return null;
    if (tenantId && row.tenant_id && Number(row.tenant_id) !== Number(tenantId)) return null;
    const domain = queryOne(db, "SELECT code, name, category FROM reference_domains WHERE id = ?", [row.domain_id]);
    const codes = queryAll(db, "SELECT code, code_type FROM reference_codes WHERE item_id = ?", [row.id]);
    const aliases = queryAll(db, "SELECT alias FROM reference_aliases WHERE item_id = ? AND status = 'active'", [row.id]);
    const translations = queryAll(db, "SELECT language, name FROM reference_translations WHERE item_id = ?", [row.id]);
    const attributes = safeParse(row.attributes_json, {});
    const searchableText = [
      row.code,
      row.name,
      row.description,
      domain?.code,
      domain?.name,
      domain?.category,
      row.scope_key,
      row.status,
      ...codes.map((c) => c.code),
      ...aliases.map((a) => a.alias),
      ...translations.map((t) => t.name),
    ]
      .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
      .join(" \n ")
      .toLowerCase();
    return {
      tenantId: row.tenant_id,
      organizationId: row.organization_id ?? null,
      objectType: REFERENCE_ITEM_SOURCE.code,
      objectId: String(row.id),
      objectUuid: row.item_ref,
      code: row.code,
      title: `${domain?.code ?? "REF"}:${row.code}`,
      subtitle: row.name,
      summary: `${row.name || row.code} (${row.status})`,
      searchableText,
      status: row.status,
      lifecycleState: row.status,
      ownerId: row.owner_user_id ?? null,
      ownerName: row.owner_label || "",
      classification: "internal",
      tags: [domain?.code, row.scope_key, row.status].filter(Boolean),
      attributes: {
        domain_id: row.domain_id,
        domain_code: domain?.code ?? "",
        scope_type: row.scope_type,
        scope_key: row.scope_key,
        version: row.current_version_number,
        effective_from: row.effective_from,
        effective_to: row.effective_to,
        is_default: Boolean(row.is_default),
        ...attributes,
      },
      relationships: [
        ...codes.map((c) => ({ direction: "out", type: "code", target_type: "reference_code", target_id: c.code, title: c.code, code: c.code })),
        ...aliases.map((a) => ({ direction: "out", type: "alias", target_type: "reference_alias", target_id: a.alias, title: a.alias, code: "" })),
      ],
      updated_at: row.updated_at,
    };
  },
  listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
    return queryAll(
      db,
      `SELECT id, tenant_id FROM reference_data_items
       WHERE (? IS NULL OR tenant_id = ?) AND id > ?
       ORDER BY id LIMIT ?`,
      [tenantId ?? null, tenantId ?? null, Number(afterId), Number(limit)]
    );
  },
};

let resolverRegistered = false;

export function registerReferenceSearchSource() {
  if (!resolverRegistered) {
    registerSourceResolver(REFERENCE_ITEM_SOURCE.code, REFERENCE_ITEM_SOURCE);
    resolverRegistered = true;
  }
  return REFERENCE_ITEM_SOURCE.code;
}

export const REFERENCE_ITEM_REGISTRATION = {
  code: REFERENCE_ITEM_SOURCE.code,
  name: "Reference data items",
  description: "Governed enterprise reference and master values.",
  source_module: "reference",
  source_table: "reference_data_items",
  key_column: "id",
  title_attribute: "code",
  subtitle_attribute: "name",
  summary_attribute: "status",
  body_attributes: ["domain_code", "scope_key", "status", "effective_from", "effective_to"],
  facet_attributes: ["domain_code", "status", "scope_type"],
  filter_attributes: ["domain_id", "status", "scope_key", "organization_id", "plant_id"],
  relationship_types: ["code", "alias"],
  permission_resource: "reference.items",
  permission_action: "read",
  sensitivity: "internal",
  status: "active",
};

export function ensureReferenceSearchRegistration(db) {
  registerReferenceSearchSource();
  const tenants = queryAll(db, "SELECT id FROM organizations");
  let created = 0;
  for (const tenant of tenants) {
    try {
      getObjectType(db, REFERENCE_ITEM_REGISTRATION.code, tenant.id);
    } catch {
      registerObjectType(db, REFERENCE_ITEM_REGISTRATION, null, tenant.id, null);
      created += 1;
    }
  }
  return { resolver: REFERENCE_ITEM_SOURCE.code, registrations: created };
}

export function reindexReferenceItem(db, item) {
  if (!item) return null;
  try {
    return applyIndexChange(db, {
      tenantId: item.tenant_id,
      objectType: REFERENCE_ITEM_SOURCE.code,
      objectId: item.id,
      operation: "upsert",
      reason: "reference.item",
    });
  } catch {
    return null;
  }
}

export function reindexReferenceDomain(db, domainId) {
  const items = queryAll(db, "SELECT id, tenant_id FROM reference_data_items WHERE domain_id = ?", [Number(domainId)]);
  let indexed = 0;
  for (const item of items) {
    if (reindexReferenceItem(db, item)) indexed += 1;
  }
  return { indexed, total: items.length };
}
