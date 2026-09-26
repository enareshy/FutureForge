import { queryAll, queryOne, run, nowIso, randomUuid, transaction } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { checkPermission } from "../authorization.js";
import { isPlatformAdmin, assertTenantScope } from "../tenants.js";
import {
  findFileRow,
  findFolderRow,
  currentVersionRow,
  publicFile,
  publicVersion,
  publicLock,
  assertTenant,
} from "./repository.js";
import { assertAccess, effectivePermissions, principalsForActor } from "./permissions.js";
import { recordFileEvent, auditFile, listFileEvents } from "./events.js";
import {
  sanitizeFilename,
  mimeFor,
  extensionOf,
  categoryForMime,
  assertSecurityClassification,
  assertFileCategory,
} from "./validation.js";

// Core file service: metadata CRUD, listing/search, and lifecycle (delete,
// restore, archive). Version creation and download live in versions.js; upload
// sessions in uploads.js; locking in locks.js.

export const SORTABLE_FILES = {
  name: "f.name COLLATE NOCASE",
  created_at: "f.created_at",
  updated_at: "f.updated_at",
  size_bytes: "f.size_bytes",
  status: "f.status",
  version_count: "f.version_count",
  mime_type: "f.mime_type",
};

const MAX_REF_ATTEMPTS = 5;

export function generateFileRef(db) {
  for (let i = 0; i < MAX_REF_ATTEMPTS; i += 1) {
    const ref = `FILE-${randomUuid().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    if (!queryOne(db, "SELECT id FROM files WHERE file_ref = ?", [ref])) return ref;
  }
  throw new HttpError(500, "Unable to allocate a unique file reference");
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

// Returns null when the actor may see every file in the tenant, otherwise an SQL
// predicate (plus params) that limits rows to files the actor can view. File ACL
// entries are layered on IAM role grants, mirroring permissions.canAccess.
function visibilityClause(db, actor, scope) {
  if (!actor?.id) return { sql: "1 = 0", params: [] };
  if (isPlatformAdmin(db, actor.id)) return null;
  if (checkPermission(db, actor, "iam.files.browser", "read", {}).allowed === true) return null;
  const { userId, groupIds, roleIds } = principalsForActor(db, actor);
  const owner = ["f.owner_id = ?", [userId]];
  const acl = [
    "(f.id IN (SELECT resource_id FROM file_permissions WHERE resource_type = 'file' AND effect = 'allow' AND (expires_at IS NULL OR expires_at > ?) AND tenant_id = ? AND permission IN ('view_metadata','view_content') AND (principal_type = 'user' AND principal_id = ? OR principal_type = 'group' AND principal_id IN ({groups}) OR principal_type = 'role' AND principal_id IN ({roles}) OR principal_type = 'tenant' AND principal_id IS NULL))",
    "(f.folder_id IS NOT NULL AND f.folder_id IN (SELECT resource_id FROM file_permissions WHERE resource_type = 'folder' AND effect = 'allow' AND (expires_at IS NULL OR expires_at > ?) AND tenant_id = ? AND permission IN ('view_metadata','view_content') AND (principal_type = 'user' AND principal_id = ? OR principal_type = 'group' AND principal_id IN ({groups}) OR principal_type = 'role' AND principal_id IN ({roles}) OR principal_type = 'tenant' AND principal_id IS NULL)))",
  ];
  const groupPlaceholders = groupIds.size ? [...groupIds].map(() => "?").join(",") : "NULL";
  const rolePlaceholders = roleIds.size ? [...roleIds].map(() => "?").join(",") : "NULL";
  const aclParams = () => [
    nowIso(), scope, userId, ...groupIds, ...roleIds,
  ];
  const clauses = [
    owner[0],
    acl[0].replace("{groups}", groupPlaceholders).replace("{roles}", rolePlaceholders),
    acl[1].replace("{groups}", groupPlaceholders).replace("{roles}", rolePlaceholders),
  ];
  return {
    sql: `(${clauses.join(" OR ")})`,
    params: [owner[1][0], ...aclParams(), ...aclParams()],
  };
}

export function listFiles(db, query = {}, actor, tenantId, { platformAll = false } = {}) {
  const scope = assertTenant(tenantId);
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  if (!platformAll) {
    where.push("f.tenant_id = ?");
    params.push(scope);
  } else if (query.tenantId || query.tenant_id) {
    where.push("f.tenant_id = ?");
    params.push(Number(query.tenantId ?? query.tenant_id));
  }

  const includeDeleted = query.includeDeleted === "true" || query.include_deleted === "true";
  if (!includeDeleted) where.push("f.deleted_at IS NULL");
  else if (query.onlyDeleted === "true" || query.only_deleted === "true") where.push("f.deleted_at IS NOT NULL");

  if (query.q) {
    where.push("(f.name LIKE ? OR f.original_name LIKE ? OR f.description LIKE ? OR f.file_ref LIKE ?)");
    const like = `%${String(query.q)}%`;
    params.push(like, like, like, like);
  }
  if (query.folderId !== undefined && query.folderId !== null && query.folderId !== "") {
    if (query.folderId === "root" || query.folderId === "null") where.push("f.folder_id IS NULL");
    else { where.push("f.folder_id = ?"); params.push(Number(query.folderId)); }
  }
  if (query.status) {
    const statuses = Array.isArray(query.status) ? query.status : String(query.status).split(",").map((s) => s.trim()).filter(Boolean);
    where.push(`f.status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  if (query.fileCategory || query.file_category) {
    where.push("f.file_category = ?");
    params.push(query.fileCategory || query.file_category);
  }
  if (query.mimeType || query.mime_type) {
    where.push("f.mime_type LIKE ?");
    params.push(`${query.mimeType || query.mime_type}%`);
  }
  if (query.extension) {
    where.push("f.extension = ?");
    params.push(String(query.extension).toLowerCase());
  }
  if (query.ownerId || query.owner_id) {
    where.push("f.owner_id = ?");
    params.push(Number(query.ownerId ?? query.owner_id));
  }
  if (query.securityClassification || query.security_classification) {
    where.push("f.security_classification = ?");
    params.push(query.securityClassification || query.security_classification);
  }
  if (query.tag) {
    where.push("f.custom_metadata_json LIKE ?");
    params.push(`%\"${String(query.tag)}\"%`);
  }
  if (query.organizationId || query.organization_id) {
    where.push("f.organization_id = ?");
    params.push(Number(query.organizationId ?? query.organization_id));
  }
  if (query.createdFrom || query.created_from) {
    where.push("f.created_at >= ?");
    params.push(query.createdFrom || query.created_from);
  }
  if (query.createdTo || query.created_to) {
    where.push("f.created_at <= ?");
    params.push(query.createdTo || query.created_to);
  }

  const visibility = visibilityClause(db, actor, scope);
  if (visibility) {
    where.push(visibility.sql);
    params.push(...visibility.params);
  }

  const clause = `WHERE ${where.join(" AND ")}`;
  const sortKey = SORTABLE_FILES[query.sortBy || query.sort_by] || SORTABLE_FILES.created_at;
  const direction = String(query.sortDir || query.sort_dir || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const items = queryAll(
    db,
    `SELECT f.*,
        u.username AS owner_username, u.display_name AS owner_display_name,
        fo.name AS folder_name
     FROM files f
     LEFT JOIN users u ON u.id = f.owner_id
     LEFT JOIN folders fo ON fo.id = f.folder_id
     ${clause}
     ORDER BY ${sortKey} ${direction}, f.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map((row) => ({
    ...publicFile(row),
    owner_username: row.owner_username || "",
    owner_display_name: row.owner_display_name || "",
    folder_name: row.folder_name || "",
  }));
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM files f ${clause}`, params).c;
  return { items, total, page, pageSize };
}

export function getFile(db, reference, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const file = findFileRow(db, reference, scope);
  assertAccess(db, file, actor, "view_metadata", { tenantId: scope });
  const lock = queryOne(
    db,
    `SELECT l.*, u.username AS locked_by_username, u.display_name AS locked_by_display_name
     FROM file_locks l LEFT JOIN users u ON u.id = l.locked_by
     WHERE l.file_id = ? AND l.released_at IS NULL ORDER BY l.id DESC LIMIT 1`,
    [file.id]
  );
  const version = file.current_version_id
    ? queryOne(db, "SELECT * FROM file_versions WHERE id = ?", [file.current_version_id])
    : null;
  const owner = file.owner_id ? queryOne(db, "SELECT id, username, display_name FROM users WHERE id = ?", [file.owner_id]) : null;
  return {
    file: publicFile(file),
    owner: owner ? { id: owner.id, username: owner.username, display_name: owner.display_name || "" } : null,
    current_version: version ? publicVersion(version) : null,
    lock: lock ? publicLock(lock) : null,
    effective_permissions: effectivePermissions(db, file, actor, { tenantId: scope }),
  };
}

export function updateFileMetadata(db, reference, body = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const file = findFileRow(db, reference, scope);
  if (file.deleted_at) throw new HttpError(409, "File is deleted");
  assertAccess(db, file, actor, "edit_metadata", { tenantId: scope });
  const before = publicFile(file);
  const patch = {};

  if (body.name !== undefined && body.name !== file.name) {
    const name = sanitizeFilename(body.name, { fallback: "" });
    if (!name) throw new HttpError(400, "File name is required");
    patch.name = name;
    patch.original_name = file.original_name || file.name;
    patch.extension = extensionOf(name);
    patch.mime_type = body.mime_type || mimeFor(name);
    patch.file_category = categoryForMime(patch.mime_type, patch.extension);
  }
  if (body.description !== undefined) patch.description = String(body.description || "").slice(0, 4000);
  if (body.security_classification !== undefined || body.securityClassification !== undefined) {
    const value = body.security_classification ?? body.securityClassification;
    assertSecurityClassification(value);
    patch.security_classification = value;
  }
  if (body.file_category !== undefined || body.fileCategory !== undefined) {
    const value = body.file_category ?? body.fileCategory;
    assertFileCategory(value);
    patch.file_category = value;
  }
  if (body.custom_metadata !== undefined || body.customMetadata !== undefined || body.metadata !== undefined) {
    patch.custom_metadata_json = JSON.stringify(parseJson(body.custom_metadata ?? body.customMetadata ?? body.metadata, {}));
  }
  if (body.folder_id !== undefined || body.folderId !== undefined) {
    const target = body.folder_id ?? body.folderId;
    if (target === null || target === "" || target === "root") {
      patch.folder_id = null;
    } else {
      const folder = findFolderRow(db, target, scope);
      if (folder.deleted_at) throw new HttpError(409, "Target folder is deleted");
      patch.folder_id = folder.id;
    }
  }
  if (body.owner_id !== undefined || body.ownerId !== undefined) {
    const ownerId = body.owner_id ?? body.ownerId;
    if (ownerId !== null) {
      const owner = queryOne(db, "SELECT id FROM users WHERE id = ?", [Number(ownerId) || -1]);
      if (!owner) throw new HttpError(400, "Owner user not found");
      patch.owner_id = owner.id;
    } else {
      patch.owner_id = null;
    }
  }
  if (body.status !== undefined) {
    if (!["active", "available", "archived"].includes(body.status)) {
      throw new HttpError(400, "status must be active, available or archived");
    }
    if (body.status === "archived") patch.status = "archived";
    if (body.status === "available" && file.status === "archived") patch.status = "available";
  }

  if (!Object.keys(patch).length) {
    return { file: publicFile(file), changed: [] };
  }
  patch.updated_by = actor?.id ?? null;
  patch.updated_at = nowIso();
  run(
    db,
    `UPDATE files SET ${Object.keys(patch).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    [...Object.values(patch), file.id]
  );
  const next = findFileRow(db, file.id, scope);
  recordFileEvent(db, {
    eventType: "FileMetadataUpdated", file: next, actor, tenantId: scope,
    payload: { changed_fields: Object.keys(patch) },
  });
  auditFile(db, {
    actor, tenantId: scope, organizationId: next.organization_id, action: "files.metadata.update",
    file: next, before, after: publicFile(next), details: { changed_fields: Object.keys(patch) }, ip,
  });
  return { file: publicFile(next), before, changed: Object.keys(patch) };
}

export function deleteFile(db, reference, options = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const file = findFileRow(db, reference, scope);
  if (file.deleted_at) throw new HttpError(409, "File is already deleted");
  assertAccess(db, file, actor, "delete", { tenantId: scope });
  const reason = String(options.reason || "").slice(0, 500);
  return transaction(db, () => {
    const ts = nowIso();
    const lock = queryOne(db, "SELECT * FROM file_locks WHERE file_id = ? AND released_at IS NULL", [file.id]);
    if (lock) {
      run(
        db,
        "UPDATE file_locks SET released_at = ?, released_by = ?, force_released = 1, release_reason = ? WHERE id = ?",
        [ts, actor?.id ?? null, reason || "file deleted", lock.id]
      );
    }
    run(
      db,
      "UPDATE file_versions SET deleted_at = COALESCE(deleted_at, ?) WHERE file_id = ?",
      [ts, file.id]
    );
    run(db, "UPDATE files SET status = 'deleted', deleted_at = ?, deleted_by = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
      ts, actor?.id ?? null, actor?.id ?? null, ts, file.id,
    ]);
    const next = findFileRow(db, file.id, scope);
    recordFileEvent(db, {
      eventType: "FileDeleted", file: next, actor, tenantId: scope, payload: { reason },
    });
    auditFile(db, {
      actor, tenantId: scope, organizationId: next.organization_id, action: "files.delete",
      file: next, before: publicFile(file), after: publicFile(next), reason, ip,
    });
    return { deleted: true, file: publicFile(next) };
  });
}

export function restoreFile(db, reference, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const file = findFileRow(db, reference, scope);
  if (!file.deleted_at) throw new HttpError(409, "File is not deleted");
  assertAccess(db, file, actor, "restore", { tenantId: scope });
  const version = currentVersionRow(db, file.id);
  const status = version && version.virus_scan_status === "clean" ? "available" : "pending_scan";
  const ts = nowIso();
  run(db, "UPDATE files SET status = ?, deleted_at = NULL, deleted_by = NULL, updated_by = ?, updated_at = ? WHERE id = ?", [
    status, actor?.id ?? null, ts, file.id,
  ]);
  const next = findFileRow(db, file.id, scope);
  recordFileEvent(db, { eventType: "FileRestored", file: next, actor, tenantId: scope, payload: { status } });
  auditFile(db, {
    actor, tenantId: scope, organizationId: next.organization_id, action: "files.restore",
    file: next, before: publicFile(file), after: publicFile(next), ip,
  });
  return { restored: true, file: publicFile(next) };
}

export function moveFile(db, reference, folderReference, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const file = findFileRow(db, reference, scope);
  if (file.deleted_at) throw new HttpError(409, "File is deleted");
  assertAccess(db, file, actor, "move", { tenantId: scope });
  const folder = folderReference === null || folderReference === undefined || folderReference === "" || folderReference === "root"
    ? null
    : findFolderRow(db, folderReference, scope);
  if (folder?.deleted_at) throw new HttpError(409, "Target folder is deleted");
  run(db, "UPDATE files SET folder_id = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
    folder?.id ?? null, actor?.id ?? null, nowIso(), file.id,
  ]);
  const next = findFileRow(db, file.id, scope);
  recordFileEvent(db, {
    eventType: "FileMetadataUpdated", file: next, actor, tenantId: scope,
    payload: { changed_fields: ["folder_id"], folder_id: folder?.id ?? null },
  });
  auditFile(db, {
    actor, tenantId: scope, organizationId: next.organization_id, action: "files.move",
    file: next, before: { folder_id: file.folder_id }, after: { folder_id: next.folder_id }, ip,
  });
  return { file: publicFile(next), folder_id: next.folder_id };
}

export function fileFacets(db, query = {}, actor, tenantId) {
  const scope = assertTenant(tenantId);
  const where = ["f.tenant_id = ?", "f.deleted_at IS NULL"];
  const params = [scope];
  const visibility = visibilityClause(db, actor, scope);
  if (visibility) { where.push(visibility.sql); params.push(...visibility.params); }
  const clause = `WHERE ${where.join(" AND ")}`;
  const byStatus = queryAll(db, `SELECT f.status AS key, COUNT(*) AS count FROM files f ${clause} GROUP BY f.status`, params);
  const byCategory = queryAll(db, `SELECT f.file_category AS key, COUNT(*) AS count FROM files f ${clause} GROUP BY f.file_category`, params);
  const byClassification = queryAll(db, `SELECT f.security_classification AS key, COUNT(*) AS count FROM files f ${clause} GROUP BY f.security_classification`, params);
  const totalBytes = queryOne(db, `SELECT COALESCE(SUM(f.size_bytes), 0) AS bytes, COUNT(*) AS count FROM files f ${clause}`, params);
  return { by_status: byStatus, by_category: byCategory, by_classification: byClassification, total: totalBytes.count, total_bytes: totalBytes.bytes };
}

export { listFileEvents };
