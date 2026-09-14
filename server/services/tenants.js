import { queryAll, queryOne, run, nowIso } from "../db.js";
import { HttpError, pagination } from "../validation.js";
import { writeAudit } from "./audit.js";
import * as orgs from "./orgs.js";
import { checkPermission } from "./authorization.js";

export function isPlatformAdmin(db, userId) {
  if (!userId) return false;
  const result = checkPermission(db, userId, "iam.platform", "read", { organizationId: 0 });
  return Boolean(result.allowed);
}

export function isTenantAdmin(db, userId) {
  if (!userId) return false;
  const result = checkPermission(db, userId, "iam.tenants", "read", { organizationId: 0 });
  return Boolean(result.allowed);
}

export function tenantIdOfOrganization(db, organizationId) {
  if (!organizationId) return null;
  const org = queryOne(db, "SELECT id, kind, tenant_id, parent_id FROM organizations WHERE id = ?", [
    organizationId,
  ]);
  if (!org) return null;
  if (org.kind === "tenant") return org.id;
  if (org.tenant_id) return org.tenant_id;
  return null;
}

export function getTenant(db, id) {
  const tenant = queryOne(
    db,
    `SELECT o.*,
      (SELECT COUNT(*) FROM organizations c WHERE c.tenant_id = o.id AND c.id != o.id) AS org_count,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id = o.id) AS user_count,
      (SELECT COUNT(*) FROM groups g WHERE g.tenant_id = o.id) AS group_count
     FROM organizations o WHERE o.id = ? AND o.kind = 'tenant'`,
    [id]
  );
  if (!tenant) throw new HttpError(404, "Tenant not found");
  return tenant;
}

export function listTenants(db, query = {}) {
  const { page, pageSize, offset } = pagination({ ...query, pageSize: query.pageSize || 100 });
  const where = ["kind = 'tenant'"];
  const params = [];
  if (query.status) {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.q) {
    where.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM organizations ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT o.*,
      (SELECT COUNT(*) FROM organizations c WHERE c.tenant_id = o.id AND c.id != o.id) AS org_count,
      (SELECT COUNT(*) FROM users u WHERE u.tenant_id = o.id) AS user_count
     FROM organizations o ${clause} ORDER BY o.name LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return { items, total, page, pageSize };
}

export function createTenant(db, body, actor, ip) {
  const org = orgs.createOrganization(
    db,
    {
      code: body.code,
      name: body.name,
      description: body.description || "",
      kind: "tenant",
    },
    actor,
    ip
  );
  writeAudit(db, {
    actor,
    action: "tenant.create",
    resourceType: "tenant",
    resourceId: org.id,
    details: { code: org.code },
    ip,
  });
  return getTenant(db, org.id);
}

export function updateTenant(db, id, body, actor, ip) {
  getTenant(db, id);
  const org = orgs.updateOrganization(
    db,
    id,
    {
      code: body.code,
      name: body.name,
      description: body.description,
      kind: "tenant",
      parent_id: null,
    },
    actor,
    ip
  );
  writeAudit(db, {
    actor,
    action: "tenant.update",
    resourceType: "tenant",
    resourceId: id,
    details: { code: org.code },
    ip,
  });
  return getTenant(db, org.id);
}

export function setTenantStatus(db, id, status, actor, ip) {
  getTenant(db, id);
  const org = orgs.setOrganizationStatus(db, id, status, actor, ip);
  writeAudit(db, {
    actor,
    action: `tenant.${status}`,
    resourceType: "tenant",
    resourceId: id,
    ip,
  });
  return getTenant(db, org.id);
}

export function deleteTenant(db, id, actor, ip) {
  getTenant(db, id);
  const result = orgs.deleteOrganization(db, id, actor, ip);
  writeAudit(db, {
    actor,
    action: "tenant.delete",
    resourceType: "tenant",
    resourceId: id,
    ip,
  });
  return result;
}

export function tenantContext(db, id) {
  const tenant = getTenant(db, id);
  const tree = orgs.organizationTree(db, { tenantId: id });
  return {
    tenant: {
      id: tenant.id,
      code: tenant.code,
      name: tenant.name,
      status: tenant.status,
      kind: tenant.kind,
    },
    organizationIds: orgs.descendantOrganizationIds(db, id),
    org_count: tenant.org_count,
    user_count: tenant.user_count,
    tree: tree.items,
  };
}

export function assertOrgInTenant(db, organizationId, tenantId) {
  if (!tenantId) throw new HttpError(403, "Tenant context required");
  if (!organizationId) return null;
  const org = queryOne(db, "SELECT id, tenant_id, kind FROM organizations WHERE id = ?", [organizationId]);
  if (!org) throw new HttpError(404, "Organization not found");
  const orgTenant = org.kind === "tenant" ? org.id : org.tenant_id;
  if (Number(orgTenant) !== Number(tenantId)) {
    throw new HttpError(404, "Organization not found");
  }
  return org;
}

export function assertSameTenant(db, leftId, rightId, message = "Cross-tenant access is not allowed") {
  const left = tenantIdOfOrganization(db, leftId);
  const right = tenantIdOfOrganization(db, rightId);
  if (!left || !right || Number(left) !== Number(right)) {
    throw new HttpError(409, message);
  }
}

export function homeTenantId(db, user) {
  if (!user) return null;
  if (user.tenant_id) return user.tenant_id;
  if (user.organization_id) return tenantIdOfOrganization(db, user.organization_id);
  return null;
}

export function resolveTenant(db, actorOrOrganization) {
  if (!actorOrOrganization) return null;
  if (typeof actorOrOrganization === "number" || /^\d+$/.test(String(actorOrOrganization))) {
    return tenantIdOfOrganization(db, Number(actorOrOrganization));
  }
  const tenantId = homeTenantId(db, actorOrOrganization);
  return tenantId || null;
}

export function assertTenantScope(db, actor, tenantId) {
  if (!tenantId) throw new HttpError(403, "Tenant context required");
  if (isPlatformAdmin(db, actor?.id)) return Number(tenantId);
  const home = homeTenantId(db, actor);
  if (!home || Number(home) !== Number(tenantId)) {
    throw new HttpError(403, "Cannot access another tenant");
  }
  return Number(tenantId);
}

export function selectTenant(db, sessionToken, tenantId, actor, ip) {
  const tenant = getTenant(db, tenantId);
  if (tenant.status !== "active") throw new HttpError(409, "Tenant is not active");
  const platform = isPlatformAdmin(db, actor?.id);
  const home = homeTenantId(db, actor);
  if (!platform && Number(home) !== Number(tenant.id)) {
    throw new HttpError(403, "Cannot switch to another tenant");
  }
  run(db, "UPDATE sessions SET tenant_id = ?, last_seen_at = ? WHERE token = ?", [
    tenant.id,
    nowIso(),
    sessionToken,
  ]);
  writeAudit(db, {
    actor,
    action: "tenant.context.switch",
    resourceType: "tenant",
    resourceId: tenant.id,
    details: { code: tenant.code, previous: actor?.tenant_id || null },
    ip,
  });
  return { tenant: { id: tenant.id, code: tenant.code, name: tenant.name, status: tenant.status } };
}

export function switchableTenants(db, actor) {
  if (isPlatformAdmin(db, actor?.id) || isTenantAdmin(db, actor?.id)) {
    return listTenants(db, { status: "active", pageSize: 200 }).items;
  }
  const home = homeTenantId(db, actor);
  if (!home) return [];
  try {
    return [getTenant(db, home)];
  } catch {
    return [];
  }
}

export function publicTenant(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    kind: row.kind || "tenant",
  };
}

export function backfillTenants(db) {
  const helix = queryOne(db, "SELECT * FROM organizations WHERE code = ?", ["helix"]);
  const hq = queryOne(db, "SELECT * FROM organizations WHERE code = ?", ["corp-hq"]);
  let tenant = helix;
  if (!tenant && hq) {
    tenant = orgs.createOrganization(db, {
      code: "helix",
      name: "Helix",
      kind: "tenant",
      description: "Default Helix tenant",
    });
  }
  if (tenant && hq && hq.parent_id !== tenant.id && hq.id !== tenant.id) {
    try {
      orgs.updateOrganization(db, hq.id, { parent_id: tenant.id, kind: hq.kind || "enterprise" });
    } catch {
      /* keep existing placement if a live tree cannot move yet */
    }
  }
  stampTenantIds(db);
}

export function stampTenantIds(db) {
  const nodes = queryAll(db, "SELECT id, kind, parent_id, tenant_id FROM organizations ORDER BY id");
  const byId = new Map(nodes.map((n) => [n.id, n]));
  function resolve(node, seen = new Set()) {
    if (!node) return null;
    if (node.kind === "tenant") return node.id;
    if (node.tenant_id) return node.tenant_id;
    if (!node.parent_id) return null;
    if (seen.has(node.id)) return null;
    seen.add(node.id);
    return resolve(byId.get(node.parent_id), seen);
  }
  for (const node of nodes) {
    const tenantId = node.kind === "tenant" ? node.id : resolve(node);
    if (tenantId && node.tenant_id !== tenantId) {
      run(db, "UPDATE organizations SET tenant_id = ? WHERE id = ?", [tenantId, node.id]);
      node.tenant_id = tenantId;
    }
  }
  run(
    db,
    `UPDATE users SET tenant_id = (
       SELECT COALESCE(o.tenant_id, CASE WHEN o.kind = 'tenant' THEN o.id END)
       FROM organizations o WHERE o.id = users.organization_id
     )
     WHERE organization_id IS NOT NULL AND (tenant_id IS NULL OR tenant_id != (
       SELECT COALESCE(o.tenant_id, CASE WHEN o.kind = 'tenant' THEN o.id END)
       FROM organizations o WHERE o.id = users.organization_id
     ))`
  );
  run(
    db,
    `UPDATE groups SET tenant_id = (
       SELECT COALESCE(o.tenant_id, CASE WHEN o.kind = 'tenant' THEN o.id END)
       FROM organizations o WHERE o.id = groups.organization_id
     )
     WHERE organization_id IS NOT NULL`
  );
  run(
    db,
    `UPDATE sessions SET tenant_id = (
       SELECT tenant_id FROM users WHERE users.id = sessions.user_id
     )
     WHERE tenant_id IS NULL`
  );
}
