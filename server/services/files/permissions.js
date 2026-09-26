import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { checkPermission } from "../authorization.js";
import { isPlatformAdmin } from "../tenants.js";
import { findFileRow, findFolderRow, publicPermission, assertTenant } from "./repository.js";
import { auditFile } from "./events.js";
import { assertFilePermission, assertPrincipalType, assertPermissionEffect, FILE_PERMISSIONS } from "./validation.js";

// File/folder/collection access control. Explicit ACL entries (file_permissions)
// are layered on top of IAM role permissions: an explicit deny always wins, an
// explicit allow grants, the owner is always allowed, and otherwise the caller's
// IAM role permissions for the mapped resource/action decide.

export const RESOURCE_PERMISSION_MAP = {
  view_metadata: ["iam.files.browser", "read"],
  view_content: ["iam.files.details", "read"],
  download: ["iam.files.details", "read"],
  preview: ["iam.files.details", "read"],
  upload: ["iam.files.uploads", "create"],
  create_version: ["iam.files.versions", "create"],
  check_out: ["iam.files.locks", "execute"],
  check_in: ["iam.files.locks", "execute"],
  release_lock: ["iam.files.locks", "execute"],
  edit_metadata: ["iam.files.details", "update"],
  move: ["iam.files.details", "update"],
  associate: ["iam.files.associations", "create"],
  remove_association: ["iam.files.associations", "delete"],
  create_folder: ["iam.files.folders", "create"],
  manage_folder: ["iam.files.folders", "update"],
  delete: ["iam.files.details", "delete"],
  restore: ["iam.files.details", "update"],
  manage_permissions: ["iam.files.permissions", "create"],
};

export function principalsForActor(db, actor) {
  if (!actor?.id) return { userId: null, groupIds: new Set(), roleIds: new Set() };
  const groupIds = new Set(queryAll(db, "SELECT group_id FROM group_members WHERE user_id = ?", [actor.id]).map((r) => r.group_id));
  const roleIds = new Set([
    ...queryAll(db, "SELECT role_id FROM user_roles WHERE user_id = ?", [actor.id]).map((r) => r.role_id),
    ...(groupIds.size
      ? queryAll(db, `SELECT role_id FROM group_roles WHERE group_id IN (${[...groupIds].map(() => "?").join(",")})`, [...groupIds]).map((r) => r.role_id)
      : []),
  ]);
  return { userId: Number(actor.id), groupIds, roleIds };
}

function resourceRow(db, resourceType, resourceId, tenantId) {
  if (resourceType === "file") return findFileRow(db, resourceId, tenantId);
  if (resourceType === "folder") return findFolderRow(db, resourceId, tenantId);
  if (resourceType === "collection") {
    const row = queryOne(db, "SELECT * FROM file_collections WHERE id = ?", [Number(resourceId) || -1]);
    if (!row) throw new HttpError(404, "Collection not found");
    return row;
  }
  throw new HttpError(400, "resource_type must be file, folder or collection");
}

function matchesPrincipal(row, principals, resource) {
  const principalId = row.principal_id === null || row.principal_id === undefined ? null : Number(row.principal_id);
  switch (row.principal_type) {
    case "user":
      return principalId !== null && principalId === principals.userId;
    case "group":
      return principalId !== null && principals.groupIds.has(principalId);
    case "role":
      return principalId !== null && principals.roleIds.has(principalId);
    case "tenant":
      return principalId === null || principalId === Number(resource.tenant_id);
    case "organization":
      return principalId === null || principalId === Number(resource.organization_id);
    default:
      return false;
  }
}

function aclRowsFor(db, resourceType, resourceId, tenantId) {
  return queryAll(
    db,
    `SELECT * FROM file_permissions
     WHERE resource_type = ? AND resource_id = ? AND tenant_id = ?
       AND (expires_at IS NULL OR expires_at > ?)`,
    [resourceType, Number(resourceId), Number(tenantId), nowIso()]
  );
}

function folderAncestry(db, folderId, tenantId) {
  const chain = [];
  let current = folderId ? queryOne(db, "SELECT * FROM folders WHERE id = ?", [Number(folderId)]) : null;
  const seen = new Set();
  while (current && !seen.has(current.id) && Number(current.tenant_id) === Number(tenantId)) {
    seen.add(current.id);
    chain.push(current);
    current = current.parent_id ? queryOne(db, "SELECT * FROM folders WHERE id = ?", [current.parent_id]) : null;
  }
  return chain;
}

export function canAccess(db, resource, actor, permission, { tenantId = null } = {}) {
  assertFilePermission(permission);
  if (!actor?.id) return false;
  if (!resource) return false;
  const scope = tenantId ?? resource.tenant_id ?? resource.tenantId;
  if (scope !== null && scope !== undefined && Number(resource.tenant_id ?? resource.tenantId) !== Number(scope)) return false;
  if (isPlatformAdmin(db, actor.id)) return true;

  const principals = principalsForActor(db, actor);
  const resourceType = resource.file_ref ? "file" : (resource.path !== undefined ? "folder" : "collection");
  const resourceId = resource.id;

  const scopes = [{ type: resourceType, id: resourceId }];
  if (resourceType === "file" && resource.folder_id) {
    for (const folder of folderAncestry(db, resource.folder_id, resource.tenant_id)) {
      scopes.push({ type: "folder", id: folder.id });
    }
  }

  let explicitAllow = false;
  for (const scopeEntry of scopes) {
    for (const row of aclRowsFor(db, scopeEntry.type, scopeEntry.id, resource.tenant_id)) {
      if (!matchesPrincipal(row, principals, resource)) continue;
      if (row.effect === "deny") return false;
      if (row.permission === permission) explicitAllow = true;
    }
  }
  if (explicitAllow) return true;

  const ownerId = Number(resource.owner_id ?? 0);
  if (ownerId && ownerId === principals.userId) return true;

  if (resource.security_classification === "restricted") {
    return false;
  }

  const [iamResource, action] = RESOURCE_PERMISSION_MAP[permission] || [];
  if (!iamResource) return false;
  return checkPermission(db, actor, iamResource, action, { organizationId: resource.organization_id }).allowed === true;
}

export function assertAccess(db, resource, actor, permission, options) {
  if (!canAccess(db, resource, actor, permission, options)) {
    throw new HttpError(403, `Not authorized to ${permission.replace(/_/g, " ")}`);
  }
  return true;
}

export function effectivePermissions(db, resource, actor, { tenantId = null } = {}) {
  const permissions = {};
  for (const permission of FILE_PERMISSIONS) {
    permissions[permission] = canAccess(db, resource, actor, permission, { tenantId });
  }
  return {
    permissions,
    allowed: FILE_PERMISSIONS.filter((p) => permissions[p]),
    resource_type: resource.file_ref ? "file" : (resource.path !== undefined ? "folder" : "collection"),
    resource_id: resource.id,
  };
}

export function grantPermission(db, body = {}, actor, tenantId, ip) {
  const scope = assertTenant(tenantId);
  const resourceType = body.resource_type || body.resourceType;
  const resourceId = Number(body.resource_id ?? body.resourceId ?? body.file_id ?? body.folder_id);
  if (!["file", "folder", "collection"].includes(resourceType)) {
    throw new HttpError(400, "resource_type must be file, folder or collection");
  }
  const resource = resourceRow(db, resourceType, resourceId, scope);
  const principalType = body.principal_type || body.principalType;
  assertPrincipalType(principalType);
  const permission = body.permission;
  assertFilePermission(permission);
  const effect = body.effect || "allow";
  assertPermissionEffect(effect);
  const principalId = body.principal_id ?? body.principalId ?? null;
  if (["user", "group", "role"].includes(principalType) && !principalId) {
    throw new HttpError(400, `principal_id is required for ${principalType} principals`);
  }
  const existing = queryOne(
    db,
    `SELECT * FROM file_permissions WHERE resource_type = ? AND resource_id = ?
       AND principal_type = ? AND COALESCE(principal_id, 0) = ? AND permission = ?`,
    [resourceType, resourceId, principalType, Number(principalId) || 0, permission]
  );
  const ts = nowIso();
  if (existing) {
    run(
      db,
      "UPDATE file_permissions SET effect = ?, expires_at = ?, granted_by = ?, updated_at = ? WHERE id = ?",
      [effect, body.expires_at ?? body.expiresAt ?? null, actor?.id ?? null, ts, existing.id]
    );
    auditFile(db, {
      actor, tenantId: scope, organizationId: resource.organization_id, action: "files.permission.update",
      objectType: resourceType, objectId: resource.id, objectName: resource.name,
      details: { principal_type: principalType, principal_id: principalId, permission, effect }, ip,
    });
    return publicPermission(queryOne(db, "SELECT * FROM file_permissions WHERE id = ?", [existing.id]));
  }
  const insert = run(
    db,
    `INSERT INTO file_permissions
      (resource_type, resource_id, principal_type, principal_id, permission, effect, tenant_id, granted_by, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [resourceType, resourceId, principalType, principalId, permission, effect, scope, actor?.id ?? null, body.expires_at ?? body.expiresAt ?? null, ts, ts]
  );
  auditFile(db, {
    actor, tenantId: scope, organizationId: resource.organization_id, action: "files.permission.grant",
    objectType: resourceType, objectId: resource.id, objectName: resource.name,
    details: { principal_type: principalType, principal_id: principalId, permission, effect }, ip,
  });
  return publicPermission(queryOne(db, "SELECT * FROM file_permissions WHERE id = ?", [insert.lastInsertRowid]));
}

export function revokePermission(db, id, actor, tenantId, ip) {
  const scope = assertTenant(tenantId);
  const row = queryOne(db, "SELECT * FROM file_permissions WHERE id = ? AND tenant_id = ?", [Number(id) || -1, scope]);
  if (!row) throw new HttpError(404, "Permission not found");
  run(db, "DELETE FROM file_permissions WHERE id = ?", [row.id]);
  auditFile(db, {
    actor, tenantId: scope, organizationId: null, action: "files.permission.revoke",
    objectType: row.resource_type, objectId: row.resource_id,
    details: { principal_type: row.principal_type, principal_id: row.principal_id, permission: row.permission }, ip,
  });
  return { revoked: true, id: row.id };
}

export function listPermissions(db, { resourceType, resourceId } = {}, tenantId) {
  const scope = assertTenant(tenantId);
  const where = ["tenant_id = ?"];
  const params = [scope];
  if (resourceType) { where.push("resource_type = ?"); params.push(resourceType); }
  if (resourceId) { where.push("resource_id = ?"); params.push(Number(resourceId)); }
  const items = queryAll(
    db,
    `SELECT * FROM file_permissions WHERE ${where.join(" AND ")} ORDER BY resource_type, resource_id, permission`,
    params
  ).map(publicPermission);
  return { items, total: items.length };
}
