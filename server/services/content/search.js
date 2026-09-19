// Search integration (spec §44). Content metadata becomes searchable through the
// platform Search & Discovery framework; the indexer never reads content tables
// directly and full binary payloads are never placed in the index.
import { queryAll, queryOne } from "../../db.js";
import { registerSourceResolver } from "../search/sources.js";
import { registerObjectType, getObjectType, refreshState } from "../search/registry.js";
import { applyIndexChange } from "../search/indexing.js";

function safeParse(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export const CONTENT_SOURCE = {
  code: "content",
  table: "content",
  resolve(db, id, { tenantId } = {}) {
    const row = queryOne(db, "SELECT * FROM content WHERE id = ?", [Number(id)]);
    if (!row) return null;
    if (tenantId && row.tenant_id && Number(row.tenant_id) !== Number(tenantId)) return null;
    const associations = queryAll(
      db,
      "SELECT object_type, object_id, content_role, is_primary FROM content_associations WHERE content_id = ? AND deleted_at IS NULL AND status = 'active'",
      [row.id]
    );
    const metadata = safeParse(row.metadata_json, {});
    const searchableText = [
      row.file_name,
      row.original_file_name,
      row.mime_type,
      row.file_extension,
      row.content_role,
      row.content_key,
      row.content_id,
      row.object_type,
      row.object_id,
      row.status,
      row.security_status,
      row.checksum,
      ...associations.map((a) => `${a.object_type}:${a.object_id}`),
      ...Object.values(metadata).filter((v) => typeof v === "string"),
    ]
      .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
      .join(" \n ")
      .toLowerCase();
    return {
      tenantId: row.tenant_id,
      organizationId: row.organization_id ?? null,
      objectType: CONTENT_SOURCE.code,
      objectId: String(row.id),
      objectUuid: row.content_id,
      code: row.content_key,
      title: row.file_name,
      subtitle: `${row.content_role} · ${row.mime_type}`,
      summary: `${row.file_name} (${row.status}, ${row.file_size} bytes)`,
      searchableText,
      status: row.status,
      lifecycleState: row.status,
      ownerId: row.created_by ?? null,
      classification: row.security_classification || "internal",
      tags: [row.content_role, row.mime_type, row.status, row.security_status].filter(Boolean),
      attributes: {
        content_id: row.content_id,
        content_key: row.content_key,
        object_type: row.object_type,
        object_id: row.object_id,
        revision_id: row.versioning_revision_id,
        version_id: row.version_id,
        content_role: row.content_role,
        mime_type: row.mime_type,
        extension: row.file_extension,
        file_size: row.file_size,
        checksum: row.checksum,
        security_status: row.security_status,
        processing_status: row.processing_status,
        version_count: row.version_count,
        is_primary: Boolean(row.is_primary),
        created_by: row.created_by,
        created_at: row.created_at,
        ...metadata,
      },
      relationships: associations.map((a) => ({
        direction: "out",
        type: a.content_role,
        target_type: a.object_type,
        target_id: a.object_id,
        title: `${a.object_type} ${a.object_id}`,
        code: "",
      })),
      updated_at: row.updated_at,
    };
  },
  listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
    return queryAll(
      db,
      `SELECT id, tenant_id FROM content
       WHERE (? IS NULL OR tenant_id = ?) AND id > ? AND deleted_at IS NULL
       ORDER BY id LIMIT ?`,
      [tenantId ?? null, tenantId ?? null, Number(afterId), Number(limit)]
    );
  },
};

let resolverRegistered = false;

export function registerContentSearchSource() {
  if (!resolverRegistered) {
    registerSourceResolver(CONTENT_SOURCE.code, CONTENT_SOURCE);
    resolverRegistered = true;
  }
  return CONTENT_SOURCE.code;
}

export const CONTENT_REGISTRATION = {
  code: CONTENT_SOURCE.code,
  name: "Content objects",
  description: "Binary content metadata, versions, roles and renditions.",
  source_module: "content",
  source_table: "content",
  key_column: "id",
  title_attribute: "file_name",
  subtitle_attribute: "content_role",
  summary_attribute: "status",
  body_attributes: ["content_key", "mime_type", "file_extension", "checksum", "status", "security_status"],
  facet_attributes: ["content_role", "status", "security_status", "mime_type", "object_type"],
  filter_attributes: ["object_type", "object_id", "content_role", "status", "security_status", "created_by"],
  relationship_types: ["NATIVE", "PRIMARY", "PDF", "JT", "PREVIEW", "THUMBNAIL", "ATTACHMENT"],
  permission_resource: "iam.content.browser",
  permission_action: "read",
  sensitivity: "internal",
  status: "active",
};

export function ensureContentSearchRegistration(db) {
  registerContentSearchSource();
  const tenants = queryAll(db, "SELECT id FROM organizations");
  let created = 0;
  for (const tenant of tenants) {
    try {
      getObjectType(db, CONTENT_REGISTRATION.code, tenant.id);
    } catch {
      registerObjectType(db, CONTENT_REGISTRATION, null, tenant.id, null);
      created += 1;
    }
  }
  try {
    refreshState(db);
  } catch {
    /* search state refresh is best effort */
  }
  return { resolver: CONTENT_SOURCE.code, registrations: created };
}

export function reindexContent(db, content) {
  if (!content) return null;
  try {
    return applyIndexChange(db, {
      tenantId: content.tenant_id,
      objectType: CONTENT_SOURCE.code,
      objectId: content.id,
      operation: content.deleted_at ? "delete" : "upsert",
      reason: "content",
    });
  } catch {
    return null;
  }
}
