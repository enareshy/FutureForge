// Source resolvers translate system-of-record rows into normalised search
// documents. Business modules register one resolver per searchable object type;
// the indexer never reaches into module tables directly.
import { queryAll, queryOne } from "../../db.js";
import { safeParse } from "./repository.js";

const resolvers = new Map();

export function registerSourceResolver(objectType, resolver) {
  if (!objectType || typeof resolver?.resolve !== "function" || typeof resolver?.listIds !== "function") {
    throw new Error("A source resolver needs a code, resolve() and listIds()");
  }
  resolvers.set(String(objectType), resolver);
  return resolver;
}

export function getSourceResolver(objectType) {
  return resolvers.get(String(objectType)) || null;
}

export function listSourceResolvers() {
  return [...resolvers.keys()];
}

function joinText(parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => String(part))
    .join(" \n ")
    .toLowerCase();
}

function textFromValue(value, sink, depth = 0) {
  if (value === null || value === undefined || depth > 4) return;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    sink.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) textFromValue(item, sink, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const key of Object.keys(value)) textFromValue(value[key], sink, depth + 1);
  }
}

function attributesText(attributes) {
  const sink = [];
  textFromValue(attributes, sink, 0);
  return sink.join(" ");
}

// ── Business objects ────────────────────────────────────────────────────────
const OBJECT_SOURCE_SQL = `
  SELECT o.*,
    t.code AS type_code, t.name AS type_name, t.module AS type_module,
    u.username AS owner_username, u.display_name AS owner_display_name,
    (SELECT name FROM lifecycle_states ls WHERE ls.id = o.lifecycle_state_id) AS lifecycle_state_name
  FROM objects o
  JOIN metadata_types t ON t.id = o.object_type_id
  LEFT JOIN users u ON u.id = o.owner_id
  WHERE o.id = ?
`;

function objectRelationships(db, objectId) {
  const rows = queryAll(
    db,
    `SELECT r.direction, r.type_code, r.type_name, r.other_id, r.other_name, r.other_code
     FROM (
       SELECT 'out' AS direction, rt.code AS type_code, rt.name AS type_name,
              rel.target_object_id AS other_id, ro.name AS other_name, ro.code AS other_code
       FROM object_relationships rel
       JOIN relationship_types rt ON rt.id = rel.relationship_type_id
       JOIN objects ro ON ro.id = rel.target_object_id
       WHERE rel.source_object_id = ? AND rel.deleted_at IS NULL
       UNION ALL
       SELECT 'in' AS direction, rt.code AS type_code, rt.name AS type_name,
              rel.source_object_id AS other_id, ro.name AS other_name, ro.code AS other_code
       FROM object_relationships rel
       JOIN relationship_types rt ON rt.id = rel.relationship_type_id
       JOIN objects ro ON ro.id = rel.source_object_id
       WHERE rel.target_object_id = ? AND rel.deleted_at IS NULL
     ) r
     ORDER BY r.type_code, r.other_id
     LIMIT 100`,
    [Number(objectId), Number(objectId)]
  );
  return rows.map((row) => ({
    direction: row.direction,
    type: row.type_code,
    type_name: row.type_name,
    target_type: "object",
    target_id: row.other_id,
    title: row.other_name,
    code: row.other_code,
  }));
}

export const objectSource = {
  code: "object",
  table: "objects",
  resolve(db, objectId, { tenantId } = {}) {
    const row = queryOne(db, OBJECT_SOURCE_SQL, [Number(objectId)]);
    if (!row) return null;
    if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
    const attributes = {
      ...safeParse(row.data_json, {}),
      object_type_code: row.type_code,
      object_type_name: row.type_name,
      object_type_module: row.type_module,
      revision: row.revision,
      lifecycle_state: row.lifecycle_state_name || "",
      external_ref: row.external_ref || "",
      external_system: row.external_system || "",
    };
    const tags = safeParse(row.tags_json, []);
    const relationships = objectRelationships(db, row.id);
    const searchableText = joinText([
      row.name,
      row.code,
      row.description,
      row.external_ref,
      tags.join(" "),
      attributesText(attributes),
      relationships.map((rel) => `${rel.type_name} ${rel.title} ${rel.code}`).join(" "),
    ]);
    return {
      tenantId: row.tenant_id,
      organizationId: row.organization_id ?? null,
      objectType: objectSource.code,
      objectId: String(row.id),
      objectUuid: row.uuid,
      code: row.code || "",
      title: row.name || row.code || "",
      subtitle: row.code || "",
      summary: row.description || "",
      searchableText,
      status: row.deleted_at ? "deleted" : row.status,
      lifecycleState: row.lifecycle_state_name || "",
      ownerId: row.owner_id ?? null,
      ownerName: row.owner_display_name || row.owner_username || "",
      classification: safeParse(row.data_json, {}).classification || "internal",
      tags,
      attributes,
      relationships,
      revisions: String(row.revision ?? ""),
      sourceRevision: String(row.revision ?? ""),
      scoreWeight: 1,
    };
  },
  listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
    return queryAll(
      db,
      `SELECT id, tenant_id FROM objects
       WHERE tenant_id = ? AND id > ? AND deleted_at IS NULL
       ORDER BY id LIMIT ?`,
      [Number(tenantId), Number(afterId), Number(limit)]
    );
  },
};

// ── Files ───────────────────────────────────────────────────────────────────
export const fileSource = {
  code: "file",
  table: "files",
  resolve(db, fileId, { tenantId } = {}) {
    const row = queryOne(
      db,
      `SELECT f.*, u.username AS owner_username, u.display_name AS owner_display_name,
              fo.name AS folder_name, fo.path AS folder_path
       FROM files f
       LEFT JOIN users u ON u.id = f.owner_id
       LEFT JOIN folders fo ON fo.id = f.folder_id
       WHERE f.id = ?`,
      [Number(fileId)]
    );
    if (!row) return null;
    if (tenantId && Number(row.tenant_id) !== Number(tenantId)) return null;
    const attributes = {
      ...safeParse(row.custom_metadata_json, {}),
      mime_type: row.mime_type,
      extension: row.extension,
      file_category: row.file_category,
      size_bytes: row.size_bytes,
      folder: row.folder_name || "",
      folder_path: row.folder_path || "",
      version_count: row.version_count,
      virus_scan_status: row.virus_scan_status,
      preview_status: row.preview_status,
    };
    const associations = queryAll(
      db,
      `SELECT business_object_type, business_object_id, business_object_name, relationship_type
       FROM file_associations
       WHERE file_id = ? AND deleted_at IS NULL
       ORDER BY is_primary DESC, id LIMIT 100`,
      [Number(row.id)]
    );
    const relationships = associations.map((assoc) => ({
      direction: "out",
      type: assoc.relationship_type || "attachment",
      target_type: assoc.business_object_type || "object",
      target_id: assoc.business_object_id,
      title: assoc.business_object_name || "",
      code: "",
    }));
    const searchableText = joinText([
      row.name,
      row.original_name,
      row.description,
      row.file_ref,
      row.extension,
      row.file_category,
      attributesText(attributes),
      relationships.map((rel) => `${rel.type} ${rel.title}`).join(" "),
    ]);
    return {
      tenantId: row.tenant_id,
      organizationId: row.organization_id ?? null,
      objectType: fileSource.code,
      objectId: String(row.id),
      objectUuid: row.uuid,
      code: row.file_ref || "",
      title: row.name || row.original_name || row.file_ref || "",
      subtitle: row.original_name || row.extension || "",
      summary: row.description || "",
      searchableText,
      status: row.deleted_at ? "deleted" : row.status,
      lifecycleState: "",
      ownerId: row.owner_id ?? null,
      ownerName: row.owner_display_name || row.owner_username || "",
      classification: row.security_classification || "internal",
      tags: [],
      attributes,
      relationships,
      revisions: String(row.version_count ?? ""),
      sourceRevision: String(row.version_count ?? ""),
      scoreWeight: 1,
    };
  },
  listIds(db, { tenantId, afterId = 0, limit = 200 } = {}) {
    return queryAll(
      db,
      `SELECT id, tenant_id FROM files
       WHERE tenant_id = ? AND id > ? AND deleted_at IS NULL
       ORDER BY id LIMIT ?`,
      [Number(tenantId), Number(afterId), Number(limit)]
    );
  },
};

let builtinsRegistered = false;
export function registerBuiltinSources() {
  if (builtinsRegistered) return listSourceResolvers();
  registerSourceResolver(objectSource.code, objectSource);
  registerSourceResolver(fileSource.code, fileSource);
  builtinsRegistered = true;
  return listSourceResolvers();
}
