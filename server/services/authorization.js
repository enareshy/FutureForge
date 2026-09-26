import { queryAll, queryOne } from "../db.js";
import { HttpError, assertAction } from "../validation.js";
import { effectiveAccess } from "./access.js";
import { ancestorResources, findResource } from "./catalog.js";
import { ancestorOrganizationIds } from "./orgs.js";
import { writeAudit } from "./audit.js";

const DENY_REASONS = {
  unknown_user: "User not found",
  inactive: "Principal is not active",
  unknown_resource: "Resource not found",
  unmatched: "No matching allow grant",
  explicit_deny: "Explicit deny",
};

function contextOrg(context) {
  if (!context) return 0;
  const value = context.organizationId ?? context.organization_id ?? 0;
  if (value === undefined || value === null || value === "" || value === "global") return 0;
  return Number(value) || 0;
}

export function checkPermission(db, user, resource, action, context = {}) {
  assertAction(action);
  const userId = typeof user === "object" && user ? user.id : user;
  const principal = queryOne(
    db,
    `SELECT id, username, status, organization_id FROM users WHERE id = ?`,
    [userId]
  );
  if (!principal) {
    return denied("unknown_user", { user: userId, resource, action });
  }
  if (principal.status !== "active") {
    return denied("inactive", { user: principal.id, status: principal.status, resource, action });
  }

  const target = findResource(db, resource);
  if (!target) {
    return denied("unknown_resource", { user: principal.id, resource, action });
  }

  const ancestry = ancestorResources(db, target.id);
  const resourceIds = new Set(ancestry.map((r) => r.id));
  const orgId = contextOrg(context);
  const applicableOrgs = new Set(ancestorOrganizationIds(db, orgId));

  const access = effectiveAccess(db, principal.id);
  if (!access.roles.length) {
    return denied("unmatched", {
      user: principal.id,
      resource: target.code,
      action,
      organizationId: orgId,
    });
  }

  const roleIds = [...new Set(access.roles.map((r) => r.id))];
  const ancestryIds = [...resourceIds];
  // Filter by the resource ancestry (and action) in SQL rather than fetching
  // every grant the roles hold and discarding most of them in JavaScript. For
  // broad roles (e.g. platform admin) this avoids materialising thousands of
  // irrelevant grants on every permission check.
  const grants = queryAll(
    db,
    `SELECT rp.role_id, rp.permission_id, rp.effect, rp.organization_id AS grant_organization_id,
            p.action, p.resource_id, p.code AS permission_code
     FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id IN (${roleIds.map(() => "?").join(",")})
       AND p.action = ?
       AND p.resource_id IN (${ancestryIds.map(() => "?").join(",")})`,
    [...roleIds, action, ...ancestryIds]
  );

  const matches = [];
  const rolesById = new Map();
  for (const role of access.roles) {
    const bindings = rolesById.get(role.id);
    if (bindings) bindings.push(role);
    else rolesById.set(role.id, [role]);
  }
  for (const grant of grants) {
    if (!resourceIds.has(grant.resource_id)) continue;
    if (!applicableOrgs.has(grant.grant_organization_id)) continue;
    const roleBindings = rolesById.get(grant.role_id);
    if (!roleBindings) continue;
    for (const binding of roleBindings) {
      if (!applicableOrgs.has(binding.organizationId)) continue;
      matches.push({
        effect: grant.effect,
        roleId: grant.role_id,
        roleCode: binding.code,
        permissionCode: grant.permission_code,
        grantOrganizationId: grant.grant_organization_id,
        assignmentOrganizationId: binding.organizationId,
        inheritedRole: binding.inherited,
        inheritedResource: grant.resource_id !== target.id,
      });
    }
  }

  const denies = matches.filter((m) => m.effect === "deny");
  if (denies.length) {
    return {
      allowed: false,
      decision: "deny",
      reason: "explicit_deny",
      message: DENY_REASONS.explicit_deny,
      principal: { id: principal.id, username: principal.username },
      resource: { id: target.id, code: target.code },
      action,
      organizationId: orgId,
      matches: denies,
    };
  }

  const allows = matches.filter((m) => m.effect === "allow");
  if (allows.length) {
    return {
      allowed: true,
      decision: "allow",
      reason: "allow",
      message: "Matched allow grant",
      principal: { id: principal.id, username: principal.username },
      resource: { id: target.id, code: target.code },
      action,
      organizationId: orgId,
      matches: allows,
    };
  }

  return denied("unmatched", {
    user: principal.id,
    username: principal.username,
    resource: target.code,
    resourceId: target.id,
    action,
    organizationId: orgId,
  });
}

function denied(reason, extra) {
  return {
    allowed: false,
    decision: "deny",
    reason,
    message: DENY_REASONS[reason] || reason,
    principal: extra.username ? { id: extra.user, username: extra.username } : { id: extra.user },
    resource: extra.resourceId
      ? { id: extra.resourceId, code: extra.resource }
      : extra.resource,
    action: extra.action,
    organizationId: extra.organizationId ?? 0,
    matches: [],
    status: extra.status,
  };
}

export function checkPermissionAudited(db, user, resource, action, context, actor, ip) {
  const result = checkPermission(db, user, resource, action, context);
  writeAudit(db, {
    actor: actor || { id: result.principal?.id, username: result.principal?.username },
    action: result.allowed ? "authz.allow" : "authz.deny",
    resourceType: "authorization",
    resourceId: result.resource?.code || resource,
    details: {
      action,
      reason: result.reason,
      organizationId: result.organizationId,
      subject: result.principal,
    },
    ip,
  });
  return result;
}

export function effectivePermissions(db, userId, context = {}) {
  return permissionsFromAccess(db, effectiveAccess(db, userId), context);
}

// Same computation as effectivePermissions but reusing an already-resolved
// access set, so callers that have just computed `effectiveAccess` (for example
// the security context builder) do not pay for it twice.
export function permissionsFromAccess(db, access, context = {}) {
  const orgId = contextOrg(context);
  const applicableOrgs = new Set(ancestorOrganizationIds(db, orgId));
  const roleIds = [...new Set(access.roles.map((r) => r.id))];
  if (!roleIds.length) {
    return { principal: access.principal, organizationId: orgId, permissions: [] };
  }

  const grants = queryAll(
    db,
    `SELECT rp.role_id, rp.effect, rp.organization_id AS grant_organization_id,
            p.id AS permission_id, p.code, p.action, p.resource_id,
            r.code AS resource_code, r.name AS resource_name
     FROM role_permissions rp
     JOIN permissions p ON p.id = rp.permission_id
     JOIN resources r ON r.id = p.resource_id
     WHERE rp.role_id IN (${roleIds.map(() => "?").join(",")})`,
    roleIds
  );

  const map = new Map();
  const rolesById = new Map();
  for (const role of access.roles) {
    const bindings = rolesById.get(role.id);
    if (bindings) bindings.push(role);
    else rolesById.set(role.id, [role]);
  }
  for (const grant of grants) {
    if (!applicableOrgs.has(grant.grant_organization_id)) continue;
    const bindings = rolesById.get(grant.role_id);
    const inScope = bindings ? bindings.some((b) => applicableOrgs.has(b.organizationId)) : false;
    if (!inScope) continue;
    const key = `${grant.resource_id}:${grant.action}`;
    const current = map.get(key);
    if (grant.effect === "deny") {
      map.set(key, { ...grant, allowed: false });
      continue;
    }
    if (current?.allowed === false) continue;
    if (grant.effect === "allow") {
      map.set(key, { ...grant, allowed: true });
    }
  }

  return {
    principal: access.principal,
    roles: access.roles,
    organizationId: orgId,
    permissions: [...map.values()]
      .filter((p) => p.allowed)
      .map((p) => ({
        code: p.code,
        action: p.action,
        resourceId: p.resource_id,
        resourceCode: p.resource_code,
        resourceName: p.resource_name,
      }))
      .sort((a, b) => a.code.localeCompare(b.code)),
  };
}

export function permissionMatrix(db, { roleId, applicationId } = {}) {
  const resources = queryAll(
    db,
    applicationId
      ? `SELECT * FROM resources WHERE application_id = ? ORDER BY code`
      : `SELECT * FROM resources ORDER BY code`,
    applicationId ? [Number(applicationId)] : []
  );
  const permissions = queryAll(
    db,
    `SELECT p.*, r.code AS resource_code FROM permissions p JOIN resources r ON r.id = p.resource_id
     ORDER BY r.code, p.action`
  );
  const roles = roleId
    ? queryAll(db, "SELECT * FROM roles WHERE id = ?", [roleId])
    : queryAll(db, "SELECT * FROM roles ORDER BY name");
  const grants = queryAll(
    db,
    roleId
      ? `SELECT * FROM role_permissions WHERE role_id = ?`
      : `SELECT * FROM role_permissions`,
    roleId ? [Number(roleId)] : []
  );

  const grantMap = new Map();
  for (const g of grants) {
    grantMap.set(`${g.role_id}:${g.permission_id}:${g.organization_id}`, g.effect);
  }

  return {
    actions: ["create", "read", "update", "delete", "execute"],
    resources,
    permissions,
    roles,
    grants: grants.map((g) => ({
      roleId: g.role_id,
      permissionId: g.permission_id,
      effect: g.effect,
      organizationId: g.organization_id,
    })),
    cells: roles.flatMap((role) =>
      permissions.map((permission) => ({
        roleId: role.id,
        roleCode: role.code,
        permissionId: permission.id,
        permissionCode: permission.code,
        resourceId: permission.resource_id,
        action: permission.action,
        effect: grantMap.get(`${role.id}:${permission.id}:0`) || "unset",
      }))
    ),
  };
}
