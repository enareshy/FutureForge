// Builds the trusted, server-derived SecurityContext. Client supplied values
// must never populate identity, tenant, role, permission or organization
// fields: they are always re-derived from the session/user record.
import { queryAll, queryOne } from "../../db.js";
import { effectiveAccess } from "../access.js";
import { effectivePermissions } from "../authorization.js";
import { listUserOrganizations, ancestorOrganizationIds } from "../orgs.js";

const PLANT_KINDS = new Set(["plant", "site"]);

function orgIdsForUser(db, userId) {
  const memberships = listUserOrganizations(db, userId);
  const seedIds = new Set(memberships.map((m) => Number(m.id)));
  if (Number.isFinite(Number(userId))) {
    const user = queryOne(db, "SELECT organization_id FROM users WHERE id = ?", [userId]);
    if (user?.organization_id) seedIds.add(Number(user.organization_id));
  }
  const all = new Set(seedIds);
  for (const id of seedIds) {
    for (const ancestorId of ancestorOrganizationIds(db, id)) all.add(Number(ancestorId));
  }
  return { memberships, ids: all };
}

export function buildSecurityContext(db, actor, options = {}) {
  if (!actor || actor.id === undefined || actor.id === null) {
    return {
      tenantId: Number(options.tenantId ?? 0),
      userId: null,
      username: null,
      roles: [],
      groups: [],
      organizations: [],
      organizationIds: [],
      plants: [],
      plantIds: [],
      permissions: [],
      authenticationMethod: options.authenticationMethod || "anonymous",
      sessionId: options.sessionId || null,
      clientApplication: options.clientApplication || null,
      correlationId: options.correlationId || null,
      ip: options.ip || null,
      attributes: { ...(options.attributes || {}) },
      anonymous: true,
    };
  }

  const principal = queryOne(
    db,
    `SELECT id, username, email, employee_id, display_name, status, organization_id, tenant_id
     FROM users WHERE id = ?`,
    [actor.id]
  );
  const access = principal ? effectiveAccess(db, principal.id) : { principal: actor, roles: [], groups: [] };
  const { ids: organizationIds, memberships } = orgIdsForUser(db, actor.id);

  const plantIds = new Set();
  const plants = [];
  for (const membership of memberships) {
    if (PLANT_KINDS.has(membership.kind)) {
      plantIds.add(Number(membership.id));
      plants.push({
        id: membership.id,
        code: membership.code,
        name: membership.name,
        kind: membership.kind,
        parent_id: membership.parent_id ?? null,
      });
    }
  }

  let permissions = [];
  try {
    permissions = effectivePermissions(db, actor.id, {
      organizationId: options.organizationId ?? principal?.organization_id ?? 0,
    }).permissions;
  } catch {
    permissions = [];
  }

  return {
    tenantId: Number(options.tenantId ?? principal?.tenant_id ?? actor.tenant_id ?? 0),
    userId: principal?.id ?? actor.id,
    username: principal?.username ?? actor.username ?? null,
    status: principal?.status ?? actor.status ?? "active",
    roles: access.roles.map((role) => ({
      id: role.id,
      code: role.code,
      name: role.name,
      organizationId: role.organizationId,
      inherited: Boolean(role.inherited),
    })),
    groups: access.groups.map((group) => ({
      id: group.id,
      code: group.code ?? null,
      name: group.name,
    })),
    organizations: memberships.map((org) => ({
      id: org.id,
      code: org.code,
      name: org.name,
      kind: org.kind,
      parent_id: org.parent_id ?? null,
      is_primary: Boolean(org.is_primary),
    })),
    organizationIds: [...organizationIds],
    plants,
    plantIds: [...plantIds],
    permissions: permissions.map((permission) => ({
      code: permission.code,
      action: permission.action,
      resourceId: permission.resourceId,
      resourceCode: permission.resourceCode,
    })),
    authenticationMethod: options.authenticationMethod || principal?.authentication_method || "session",
    sessionId: options.sessionId || actor.sessionToken || null,
    clientApplication: options.clientApplication || options.source || null,
    correlationId: options.correlationId || null,
    ip: options.ip || null,
    attributes: {
      employee_id: principal?.employee_id ?? null,
      email: principal?.email ?? null,
      display_name: principal?.display_name ?? null,
      primary_organization_id: principal?.organization_id ?? null,
      ...(options.attributes || {}),
    },
    anonymous: false,
  };
}

export function contextSubjectCodes(context) {
  const roleCodes = new Set((context.roles || []).map((role) => role.code));
  const groupIds = new Set((context.groups || []).map((group) => group.id));
  const userId = context.userId ?? null;
  return { roleCodes, groupIds, userId };
}

export function subjectMatches(context, subjectType, subjectId) {
  const type = String(subjectType || "everyone");
  if (type === "everyone") return true;
  if (!context || context.anonymous) return false;
  if (type === "user") return Number(subjectId) === Number(context.userId);
  if (type === "role") {
    const id = Number(subjectId);
    return (context.roles || []).some((role) => Number(role.id) === id || role.code === subjectId);
  }
  if (type === "group") {
    const id = Number(subjectId);
    return (context.groups || []).some((group) => Number(group.id) === id);
  }
  if (type === "organization") {
    return (context.organizationIds || []).map(Number).includes(Number(subjectId));
  }
  return false;
}

export function publicSecurityContext(context) {
  if (!context) return null;
  return {
    tenantId: context.tenantId,
    userId: context.userId,
    username: context.username,
    roles: (context.roles || []).map((role) => role.code),
    groups: (context.groups || []).map((group) => group.id),
    organizations: context.organizationIds || [],
    plants: context.plantIds || [],
    permissions: (context.permissions || []).map((permission) => permission.code),
    authenticationMethod: context.authenticationMethod,
    clientApplication: context.clientApplication,
    correlationId: context.correlationId,
    anonymous: Boolean(context.anonymous),
    attributes: context.attributes || {},
  };
}

export function securityContextRow(context) {
  return {
    tenantId: context?.tenantId ?? 0,
    userId: context?.userId ?? null,
    roles: (context?.roles || []).map((role) => role.code),
    permissions: (context?.permissions || []).map((permission) => permission.code),
  };
}

export function queryOrganizationMemberships(db, userId) {
  return queryAll(
    db,
    `SELECT o.id, o.code, o.name, o.kind, o.parent_id
     FROM organization_members m JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = ?`,
    [userId]
  );
}
