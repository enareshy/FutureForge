import { queryAll, queryOne, run, nowIso } from "../db.js";
import { HttpError, assertEffect, orgScope } from "../validation.js";
import { writeAudit } from "./audit.js";
import { getRole } from "./roles.js";
import { getPermission } from "./catalog.js";

function assertOrgScope(db, organizationId) {
  const scope = orgScope(organizationId);
  if (scope === 0) return 0;
  const org = queryOne(db, "SELECT id FROM organizations WHERE id = ?", [scope]);
  if (!org) throw new HttpError(400, "Organization not found");
  return scope;
}

export function listRolePermissions(db, roleId) {
  getRole(db, roleId);
  return queryAll(
    db,
    `SELECT rp.role_id, rp.permission_id, rp.effect, rp.organization_id, rp.created_at,
            p.code AS permission_code, p.action, p.name AS permission_name,
            r.id AS resource_id, r.code AS resource_code, r.name AS resource_name, r.kind AS resource_kind,
            a.id AS application_id, a.code AS application_code
     FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     JOIN resources r ON r.id = p.resource_id
     JOIN applications a ON a.id = r.application_id
     WHERE rp.role_id = ?
     ORDER BY r.code, p.action, rp.organization_id`,
    [roleId]
  );
}

export function grantRolePermission(db, roleId, body, actor, ip) {
  getRole(db, roleId);
  if (!body.permission_id) throw new HttpError(400, "permission_id is required");
  assertEffect(body.effect || "allow");
  const permission = getPermission(db, body.permission_id);
  const scope = assertOrgScope(db, body.organization_id);
  const effect = body.effect || "allow";
  const existing = queryOne(
    db,
    `SELECT * FROM role_permissions
     WHERE role_id = ? AND permission_id = ? AND organization_id = ?`,
    [roleId, permission.id, scope]
  );
  if (existing) {
    run(
      db,
      `UPDATE role_permissions SET effect = ?, created_at = ?
       WHERE role_id = ? AND permission_id = ? AND organization_id = ?`,
      [effect, nowIso(), roleId, permission.id, scope]
    );
  } else {
    run(
      db,
      `INSERT INTO role_permissions (role_id, permission_id, effect, organization_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [roleId, permission.id, effect, scope, nowIso()]
    );
  }
  writeAudit(db, {
    actor,
    action: existing ? "permission.grant.update" : "permission.grant",
    resourceType: "role",
    resourceId: roleId,
    details: { permissionId: permission.id, effect, organizationId: scope },
    ip,
  });
  return listRolePermissions(db, roleId);
}

export function revokeRolePermission(db, roleId, permissionId, organizationId, actor, ip) {
  getRole(db, roleId);
  const scope = orgScope(organizationId);
  const existing = queryOne(
    db,
    `SELECT 1 AS x FROM role_permissions
     WHERE role_id = ? AND permission_id = ? AND organization_id = ?`,
    [roleId, permissionId, scope]
  );
  if (!existing) throw new HttpError(404, "Grant not found");
  run(
    db,
    `DELETE FROM role_permissions
     WHERE role_id = ? AND permission_id = ? AND organization_id = ?`,
    [roleId, permissionId, scope]
  );
  writeAudit(db, {
    actor,
    action: "permission.revoke",
    resourceType: "role",
    resourceId: roleId,
    details: { permissionId: Number(permissionId), organizationId: scope },
    ip,
  });
  return listRolePermissions(db, roleId);
}

export function replaceRolePermissionMatrix(db, roleId, grants, actor, ip) {
  getRole(db, roleId);
  if (!Array.isArray(grants)) throw new HttpError(400, "grants must be an array");
  run(db, "DELETE FROM role_permissions WHERE role_id = ?", [roleId]);
  for (const grant of grants) {
    if (!grant || grant.effect === "unset" || grant.effect === "" || grant.effect == null) continue;
    grantRolePermission(db, roleId, grant, actor, ip);
  }
  return listRolePermissions(db, roleId);
}
