import { queryAll, queryOne, run, nowIso, randomUuid, transaction } from "../../db.js";
import { HttpError, pagination, validateCode } from "../../validation.js";
import { assertTenantScope } from "../tenants.js";
import { findFolderRow, findFileRow, publicFolder, publicFile, assertTenant } from "./repository.js";
import { auditFile } from "./events.js";
import { sanitizeFilename, assertSecurityClassification } from "./validation.js";

// Folder & collection organization. Folders form a tenant-scoped tree with a
// materialized path for cheap ancestry lookups; file membership is a nullable
// primary folder on each file (moving a file changes that value).

function folderPath(parentPath, name) {
  const base = !parentPath || parentPath === "/" ? "" : parentPath.replace(/\/+$/, "");
  return `${base}/${name}`;
}

export function listFolders(db, query = {}, tenantId) {
  assertTenant(tenantId);
  const { page, pageSize, offset } = pagination(query);
  const where = ["f.tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.parentId !== undefined && query.parentId !== null && query.parentId !== "") {
    where.push("f.parent_id = ?");
    params.push(Number(query.parentId));
  }
  if (query.q) {
    where.push("(f.name LIKE ? OR f.description LIKE ?)");
    params.push(`%${query.q}%`, `%${query.q}%`);
  }
  if (query.includeDeleted !== "true") where.push("f.deleted_at IS NULL");
  const clause = `WHERE ${where.join(" AND ")}`;
  const items = queryAll(
    db,
    `SELECT f.*,
        (SELECT COUNT(*) FROM folders c WHERE c.parent_id = f.id AND c.deleted_at IS NULL) AS child_count,
        (SELECT COUNT(*) FROM files x WHERE x.folder_id = f.id AND x.deleted_at IS NULL) AS file_count
     FROM folders f ${clause}
     ORDER BY f.name COLLATE NOCASE LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map((row) => ({ ...publicFolder(row), child_count: row.child_count, file_count: row.file_count }));
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM folders f ${clause}`, params).c;
  return { items, total, page, pageSize };
}

export function folderTree(db, tenantId, { rootId = null } = {}) {
  assertTenant(tenantId);
  const rows = queryAll(
    db,
    `SELECT f.*,
        (SELECT COUNT(*) FROM files x WHERE x.folder_id = f.id AND x.deleted_at IS NULL) AS file_count
     FROM folders f WHERE f.tenant_id = ? AND f.deleted_at IS NULL ORDER BY f.name COLLATE NOCASE`,
    [Number(tenantId)]
  );
  const byId = new Map();
  for (const row of rows) byId.set(row.id, { ...publicFolder(row), file_count: row.file_count, children: [] });
  const roots = [];
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) byId.get(node.parent_id).children.push(node);
    else if (!rootId || node.id === Number(rootId)) roots.push(node);
  }
  return { items: roots };
}

export function getFolder(db, reference, tenantId) {
  assertTenant(tenantId);
  const row = findFolderRow(db, reference, tenantId);
  if (row.deleted_at && row.deleted_at !== null && row.status === "archived") {
    return publicFolder(row);
  }
  const counts = queryOne(
    db,
    `SELECT
       (SELECT COUNT(*) FROM folders c WHERE c.parent_id = ? AND c.deleted_at IS NULL) AS child_count,
       (SELECT COUNT(*) FROM files x WHERE x.folder_id = ? AND x.deleted_at IS NULL) AS file_count`,
    [row.id, row.id]
  );
  return { ...publicFolder(row), child_count: counts.child_count, file_count: counts.file_count };
}

export function createFolder(db, body = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const name = sanitizeFilename(body.name, { fallback: "" });
  if (!name) throw new HttpError(400, "Folder name is required");
  const code = String(body.code || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "folder").slice(0, 64);
  validateCode(code, "Folder code");
  const classification = body.security_classification || body.securityClassification || "internal";
  assertSecurityClassification(classification);

  let parentPath = "/";
  let parentId = null;
  if (body.parent_id || body.parentId) {
    const parent = findFolderRow(db, body.parent_id ?? body.parentId, scope);
    if (parent.deleted_at) throw new HttpError(409, "Parent folder is deleted");
    parentId = parent.id;
    parentPath = parent.path;
  }
  const exists = queryOne(
    db,
    `SELECT id FROM folders WHERE tenant_id = ? AND COALESCE(parent_id, 0) = ? AND name = ? AND deleted_at IS NULL`,
    [scope, parentId ?? 0, name]
  );
  if (exists) throw new HttpError(409, "A folder with that name already exists here");

  const ts = nowIso();
  const insert = run(
    db,
    `INSERT INTO folders
      (uuid, code, name, description, parent_id, path, owner_id, tenant_id, organization_id,
       plant_id, site_id, department_id, security_classification, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      randomUuid(), code, name, body.description || "", parentId ?? null, folderPath(parentPath, name),
      body.owner_id ?? actor?.id ?? null, scope,
      body.organization_id ?? body.organizationId ?? actor?.organization_id ?? null,
      body.plant_id ?? null, body.site_id ?? null, body.department_id ?? null,
      classification, actor?.id ?? null, actor?.id ?? null, ts, ts,
    ]
  );
  const row = findFolderRow(db, insert.lastInsertRowid, scope);
  auditFile(db, {
    actor, tenantId: scope, organizationId: row.organization_id, action: "files.folder.create",
    file: null, objectType: "folder", objectId: row.id, objectName: row.name,
    details: { code, path: row.path }, ip,
  });
  return publicFolder(row);
}

export function updateFolder(db, reference, body = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const row = findFolderRow(db, reference, scope);
  if (row.deleted_at) throw new HttpError(409, "Folder is deleted");
  if (row.is_system === 1 && body.status && body.status !== row.status) {
    throw new HttpError(409, "System folders cannot be archived");
  }
  const before = publicFolder(row);
  const patch = {};
  if (body.name !== undefined) {
    const name = sanitizeFilename(body.name, { fallback: "" });
    if (!name) throw new HttpError(400, "Folder name is required");
    const clash = queryOne(
      db,
      `SELECT id FROM folders WHERE tenant_id = ? AND COALESCE(parent_id, 0) = ? AND name = ? AND id != ? AND deleted_at IS NULL`,
      [scope, row.parent_id ?? 0, name, row.id]
    );
    if (clash) throw new HttpError(409, "A folder with that name already exists here");
    patch.name = name;
    patch.path = folderPath(row.path.slice(0, row.path.length - (row.name || "").length), name);
  }
  if (body.description !== undefined) patch.description = body.description;
  if (body.status !== undefined) {
    if (!["active", "archived"].includes(body.status)) throw new HttpError(400, "status must be active or archived");
    patch.status = body.status;
  }
  if (body.security_classification !== undefined) {
    assertSecurityClassification(body.security_classification);
    patch.security_classification = body.security_classification;
  }
  if (body.parent_id !== undefined) {
    if (body.parent_id === null) {
      patch.parent_id = null;
    } else {
      const parent = findFolderRow(db, body.parent_id, scope);
      if (parent.id === row.id) throw new HttpError(400, "A folder cannot be its own parent");
      if (parent.path.startsWith(`${row.path}/`)) throw new HttpError(400, "Cannot move a folder into its own descendant");
      patch.parent_id = parent.id;
    }
  }
  if (!Object.keys(patch).length) return publicFolder(row);
  patch.updated_by = actor?.id ?? null;
  patch.updated_at = nowIso();
  run(
    db,
    `UPDATE folders SET ${Object.keys(patch).map((k) => `${k} = ?`).join(", ")} WHERE id = ?`,
    [...Object.values(patch), row.id]
  );
  const next = findFolderRow(db, row.id, scope);
  auditFile(db, {
    actor, tenantId: scope, organizationId: next.organization_id, action: "files.folder.update",
    objectType: "folder", objectId: next.id, objectName: next.name, before, after: publicFolder(next), ip,
  });
  return publicFolder(next);
}

export function deleteFolder(db, reference, { force = false } = {}, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const row = findFolderRow(db, reference, scope);
  if (row.deleted_at) throw new HttpError(409, "Folder is already deleted");
  if (row.is_system === 1) throw new HttpError(409, "System folders cannot be deleted");
  const children = queryOne(db, "SELECT COUNT(*) AS c FROM folders WHERE parent_id = ? AND deleted_at IS NULL", [row.id]).c;
  const files = queryOne(db, "SELECT COUNT(*) AS c FROM files WHERE folder_id = ? AND deleted_at IS NULL", [row.id]).c;
  if ((children || files) && !force) {
    throw new HttpError(409, "Folder is not empty", { children, files });
  }
  return transaction(db, () => {
    if (force && children) {
      run(db, "UPDATE folders SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE parent_id = ? AND deleted_at IS NULL", [
        nowIso(), actor?.id ?? null, nowIso(), row.id,
      ]);
    }
    if (force && files) {
      run(db, "UPDATE files SET folder_id = NULL, updated_at = ? WHERE folder_id = ?", [nowIso(), row.id]);
    }
    run(db, "UPDATE folders SET deleted_at = ?, deleted_by = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
      nowIso(), actor?.id ?? null, actor?.id ?? null, nowIso(), row.id,
    ]);
    auditFile(db, {
      actor, tenantId: scope, organizationId: row.organization_id, action: "files.folder.delete",
      objectType: "folder", objectId: row.id, objectName: row.name, before: publicFolder(row),
      after: { deleted_at: nowIso() }, details: { forced: force, children, files }, ip,
    });
    return { deleted: true, id: row.id, cascade_children: force ? children : 0 };
  });
}

export function restoreFolder(db, reference, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const row = findFolderRow(db, reference, scope);
  if (!row.deleted_at) throw new HttpError(409, "Folder is not deleted");
  run(db, "UPDATE folders SET deleted_at = NULL, deleted_by = NULL, updated_by = ?, updated_at = ? WHERE id = ?", [
    actor?.id ?? null, nowIso(), row.id,
  ]);
  const next = findFolderRow(db, row.id, scope);
  auditFile(db, {
    actor, tenantId: scope, organizationId: next.organization_id, action: "files.folder.restore",
    objectType: "folder", objectId: next.id, objectName: next.name, ip,
  });
  return publicFolder(next);
}

export function listFolderFiles(db, reference, query = {}, tenantId) {
  const scope = assertTenant(tenantId);
  const folder = findFolderRow(db, reference, scope);
  const { page, pageSize, offset } = pagination(query);
  const rows = queryAll(
    db,
    `SELECT * FROM files WHERE folder_id = ? AND deleted_at IS NULL
     ORDER BY name COLLATE NOCASE LIMIT ? OFFSET ?`,
    [folder.id, pageSize, offset]
  ).map(publicFile);
  const total = queryOne(db, "SELECT COUNT(*) AS c FROM files WHERE folder_id = ? AND deleted_at IS NULL", [folder.id]).c;
  return { items: rows, total, page, pageSize, folder: publicFolder(folder) };
}

export function moveFilesToFolder(db, reference, fileIds, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const folder = findFolderRow(db, reference, scope);
  if (folder.deleted_at) throw new HttpError(409, "Target folder is deleted");
  const ids = normalizeIds(fileIds);
  if (!ids.length) throw new HttpError(400, "fileIds must be a non-empty array");
  return transaction(db, () => {
    const moved = [];
    for (const id of ids) {
      const file = findFileRow(db, id, scope);
      if (file.deleted_at) continue;
      run(db, "UPDATE files SET folder_id = ?, updated_by = ?, updated_at = ? WHERE id = ?", [
        folder.id, actor?.id ?? null, nowIso(), file.id,
      ]);
      moved.push(findFileRow(db, file.id, scope));
    }
    auditFile(db, {
      actor, tenantId: scope, organizationId: folder.organization_id, action: "files.folder.add_files",
      objectType: "folder", objectId: folder.id, objectName: folder.name,
      details: { file_ids: moved.map((f) => f.id) }, ip,
    });
    return { folder: publicFolder(folder), items: moved.map(publicFile), moved_count: moved.length };
  });
}

export function removeFileFromFolder(db, reference, fileId, actor, tenantId, ip) {
  const scope = assertTenantScope(db, actor, assertTenant(tenantId));
  const folder = findFolderRow(db, reference, scope);
  const file = findFileRow(db, fileId, scope);
  if (Number(file.folder_id) !== Number(folder.id)) {
    throw new HttpError(409, "File is not a member of this folder");
  }
  run(db, "UPDATE files SET folder_id = NULL, updated_by = ?, updated_at = ? WHERE id = ?", [
    actor?.id ?? null, nowIso(), file.id,
  ]);
  auditFile(db, {
    actor, tenantId: scope, organizationId: folder.organization_id, action: "files.folder.remove_file",
    objectType: "folder", objectId: folder.id, objectName: folder.name, details: { file_id: file.id }, ip,
  });
  return { removed: true, file_id: file.id, folder_id: folder.id };
}

function normalizeIds(value) {
  const list = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  return [...new Set(list.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0))];
}

export function folderBreadcrumb(db, reference, tenantId) {
  const scope = assertTenant(tenantId);
  const folder = findFolderRow(db, reference, scope);
  const crumbs = [];
  let current = folder;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    crumbs.unshift({ id: current.id, name: current.name, path: current.path });
    current = current.parent_id ? findFolderRow(db, current.parent_id, scope) : null;
  }
  return { items: crumbs };
}
