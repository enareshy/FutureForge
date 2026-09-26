// Search integration for the Numbering Service. Allocations become searchable
// through the platform Search framework via a source resolver; the indexer
// never reaches into numbering tables directly.
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

export const NUMBERING_ALLOCATION_SOURCE = {
  code: "numbering_allocation",
  table: "numbering_allocations",
  resolve(db, allocationId, { tenantId } = {}) {
    const row = queryOne(db, "SELECT * FROM numbering_allocations WHERE id = ?", [Number(allocationId)]);
    if (!row) return null;
    if (tenantId && row.tenant_id && Number(row.tenant_id) !== Number(tenantId)) return null;
    const scheme = row.scheme_id
      ? queryOne(db, "SELECT code, name, object_type_code FROM numbering_schemes WHERE id = ?", [row.scheme_id])
      : null;
    const metadata = safeParse(row.metadata_json, {});
    const searchableText = [
      row.number,
      row.object_type_code,
      row.object_id,
      row.object_ref,
      row.allocation_ref,
      row.status,
      row.scope_key,
      scheme?.code,
      scheme?.name,
      row.requested_by_name,
      row.correlation_id,
    ]
      .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
      .join(" \n ")
      .toLowerCase();
    return {
      tenantId: row.tenant_id,
      organizationId: row.organization_id ?? null,
      objectType: NUMBERING_ALLOCATION_SOURCE.code,
      objectId: String(row.id),
      objectUuid: row.allocation_ref,
      code: row.number,
      title: row.number,
      subtitle: row.object_type_code,
      summary: `${row.object_type_code} identifier ${row.number} (${row.status})`,
      searchableText,
      status: row.status,
      lifecycleState: row.status,
      ownerId: row.requested_by ?? null,
      ownerName: row.requested_by_name || "",
      classification: "internal",
      tags: [row.object_type_code, row.status],
      attributes: {
        number: row.number,
        object_type: row.object_type_code,
        object_id: row.object_id,
        scheme: scheme?.code ?? "",
        scheme_version: row.scheme_version,
        sequence_value: row.sequence_value,
        scope: row.scope_key,
        reusable: Boolean(row.reusable),
        is_manual: Boolean(row.is_manual),
        ...metadata,
      },
      relationships: row.object_id
        ? [
            {
              direction: "out",
              type: "consumes",
              target_type: row.object_type_code,
              target_id: row.object_id,
              title: row.object_ref || row.object_id,
              code: "",
            },
          ]
        : [],
      updated_at: row.updated_at,
    };
  },
  listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
    return queryAll(
      db,
      `SELECT id, tenant_id FROM numbering_allocations
       WHERE (? IS NULL OR tenant_id = ?) AND id > ?
       ORDER BY id LIMIT ?`,
      [tenantId ?? null, tenantId ?? null, Number(afterId), Number(limit)]
    );
  },
};

let resolverRegistered = false;

export function registerNumberingSearchSource() {
  if (!resolverRegistered) {
    registerSourceResolver(NUMBERING_ALLOCATION_SOURCE.code, NUMBERING_ALLOCATION_SOURCE);
    resolverRegistered = true;
  }
  return NUMBERING_ALLOCATION_SOURCE.code;
}

export const NUMBERING_ALLOCATION_REGISTRATION = {
  code: NUMBERING_ALLOCATION_SOURCE.code,
  name: "Numbering allocations",
  description: "Generated and reserved enterprise identifiers.",
  source_module: "numbering",
  source_table: "numbering_allocations",
  key_column: "id",
  title_attribute: "number",
  subtitle_attribute: "object_type_code",
  summary_attribute: "status",
  body_attributes: ["object_id", "object_ref", "scheme_code", "scope_key", "sequence_value"],
  facet_attributes: ["object_type_code", "status", "classification"],
  filter_attributes: ["object_type_code", "status", "organization_id", "plant_id"],
  relationship_types: [],
  permission_resource: "numbering.allocations",
  permission_action: "read",
  sensitivity: "internal",
  status: "active",
};

export function ensureNumberingSearchRegistration(db) {
  registerNumberingSearchSource();
  const tenants = queryAll(db, "SELECT id FROM organizations");
  let created = 0;
  for (const tenant of tenants) {
    try {
      getObjectType(db, NUMBERING_ALLOCATION_REGISTRATION.code, tenant.id);
    } catch {
      registerObjectType(db, NUMBERING_ALLOCATION_REGISTRATION, null, tenant.id, null);
      created += 1;
    }
  }
  return { resolver: NUMBERING_ALLOCATION_SOURCE.code, registrations: created };
}

// Best-effort index refresh after an allocation transitions. Never fails the
// allocation.
export function reindexAllocation(db, allocation) {
  if (!allocation) return null;
  try {
    return applyIndexChange(db, {
      tenantId: allocation.tenant_id,
      objectType: NUMBERING_ALLOCATION_SOURCE.code,
      objectId: allocation.id,
      operation: "upsert",
      reason: "numbering.allocation",
    });
  } catch {
    return null;
  }
}
