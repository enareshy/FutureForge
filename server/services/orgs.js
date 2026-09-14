import { queryAll, queryOne, run, nowIso } from "../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../validation.js";
import { writeAudit } from "./audit.js";
import * as hierarchy from "./hierarchy.js";

export function typedCollections(db) {
  const map = {};
  for (const level of hierarchy.getHierarchy(db, { includeInactive: true }).levels) {
    if (level.collection && level.code !== "tenant") map[level.collection] = level.code;
  }
  return map;
}

export function tenantIdOf(org) {
  if (!org) return null;
  if (org.kind === "tenant") return org.id;
  return org.tenant_id || null;
}

function inheritTenantId(kind, parent) {
  if (kind === "tenant") return null;
  if (!parent) return null;
  return parent.kind === "tenant" ? parent.id : parent.tenant_id || null;
}

function assertSameTenant(current, parent) {
  if (!parent) return;
  const childTenant = tenantIdOf(current);
  const parentTenant = tenantIdOf(parent);
  if (childTenant && parentTenant && Number(childTenant) !== Number(parentTenant)) {
    throw new HttpError(409, "Cannot move an organization to a different tenant");
  }
}

export function assertKind(db, kind) {
  const value = kind || "organization";
  const level = hierarchy.levelByCode(db, value);
  if (!level || !level.active) {
    const codes = hierarchy.kindCodes(db);
    throw new HttpError(400, `kind must be one of: ${codes.join(", ")}`);
  }
  return value;
}

function parentKindOf(parent) {
  return parent ? parent.kind : null;
}

function assertParentKind(db, kind, parent) {
  const allowed = hierarchy.allowedParentsFor(db, kind);
  const parentKind = parentKindOf(parent);
  if (!allowed.includes(parentKind)) {
    const level = hierarchy.levelByCode(db, kind);
    const expect = allowed
      .map((k) => (k === null ? "none (root)" : k))
      .join(", ");
    throw new HttpError(
      400,
      `${level?.name || kind} cannot be placed under ${parentKind || "root"}; allowed parents: ${expect}`
    );
  }
}

export function listOrganizations(db, query = {}) {
  const { page, pageSize, offset } = pagination({ ...query, pageSize: query.pageSize || 100 });
  const where = [];
  const params = [];
  if (query.kind) {
    assertKind(db, query.kind);
    where.push("kind = ?");
    params.push(query.kind);
  }
  if (query.status) {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.parentId !== undefined && query.parentId !== "") {
    if (query.parentId === "root" || query.parentId === "null") where.push("parent_id IS NULL");
    else {
      where.push("parent_id = ?");
      params.push(Number(query.parentId));
    }
  }
  if (query.q) {
    where.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  if (query.tenantId) {
    where.push("(tenant_id = ? OR id = ?)");
    params.push(Number(query.tenantId), Number(query.tenantId));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM organizations ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT o.*,
      (SELECT COUNT(*) FROM organizations c WHERE c.parent_id = o.id) AS child_count,
      (SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id) AS user_count,
      (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id) AS member_count
     FROM organizations o ${clause} ORDER BY o.kind, o.name LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return { items, total, page, pageSize };
}

export function getOrganization(db, id, { tenantId } = {}) {
  const org = queryOne(
    db,
    `SELECT o.*,
      (SELECT COUNT(*) FROM organizations c WHERE c.parent_id = o.id) AS child_count,
      (SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id) AS user_count,
      (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id) AS member_count
     FROM organizations o WHERE o.id = ?`,
    [id]
  );
  if (!org) throw new HttpError(404, "Organization not found");
  if (tenantId) {
    const idOfTenant = tenantIdOf(org);
    if (Number(idOfTenant) !== Number(tenantId)) throw new HttpError(404, "Organization not found");
  }
  return org;
}

export function getOrganizationOfKind(db, id, kind) {
  const org = getOrganization(db, id);
  if (org.kind !== kind) {
    const level = hierarchy.levelByCode(db, kind);
    throw new HttpError(404, `${level?.name || kind} not found`);
  }
  return org;
}

export function ancestorOrganizationIds(db, organizationId) {
  if (!organizationId) return [0];
  const ids = [0];
  let current = Number(organizationId);
  const seen = new Set();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    ids.push(current);
    const row = queryOne(db, "SELECT parent_id FROM organizations WHERE id = ?", [current]);
    if (!row) break;
    current = row.parent_id;
  }
  return ids;
}

export function ancestorOrganizations(db, id) {
  const result = [];
  let current = id;
  const seen = new Set();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const row = queryOne(db, "SELECT * FROM organizations WHERE id = ?", [current]);
    if (!row) break;
    result.push(row);
    current = row.parent_id;
  }
  return result;
}

export function descendantOrganizationIds(db, id) {
  const ids = [Number(id)];
  const queue = [Number(id)];
  const seen = new Set(queue);
  while (queue.length) {
    const current = queue.shift();
    const children = queryAll(db, "SELECT id FROM organizations WHERE parent_id = ?", [current]);
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      ids.push(child.id);
      queue.push(child.id);
    }
  }
  return ids;
}

function assertNoCycle(db, id, parentId) {
  if (!parentId) return;
  if (Number(id) === Number(parentId)) {
    throw new HttpError(400, "An organization cannot be its own parent");
  }
  let current = parentId;
  const seen = new Set();
  while (current) {
    if (seen.has(current) || Number(current) === Number(id)) {
      throw new HttpError(400, "Organization hierarchy cycle detected");
    }
    seen.add(current);
    const row = queryOne(db, "SELECT parent_id FROM organizations WHERE id = ?", [current]);
    if (!row) throw new HttpError(400, "Parent organization not found");
    current = row.parent_id;
  }
}

function loadParent(db, parentId) {
  if (!parentId) return null;
  return getOrganization(db, parentId);
}

function assertKindChangeSafe(db, id, nextKind, currentKind) {
  if (nextKind === currentKind) return;
  const children = queryAll(db, "SELECT id, kind, name FROM organizations WHERE parent_id = ?", [id]);
  for (const child of children) {
    const allowed = hierarchy.allowedParentsFor(db, child.kind);
    if (!allowed.includes(nextKind)) {
      throw new HttpError(
        400,
        `Cannot change kind to ${nextKind}: child ${child.name} (${child.kind}) would be invalid`
      );
    }
  }
}

export function createOrganization(db, body, actor, ip) {
  requireFields(body, ["code", "name"]);
  validateCode(body.code, "Organization code");
  const kind = assertKind(db, body.kind);
  const parent = loadParent(db, body.parent_id || null);
  assertParentKind(db, kind, parent);
  const tenantId = inheritTenantId(kind, parent);
  try {
    const result = run(
      db,
      `INSERT INTO organizations (code, name, kind, status, description, parent_id, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      [
        body.code,
        body.name.trim(),
        kind,
        body.description || "",
        parent ? parent.id : null,
        tenantId,
        nowIso(),
        nowIso(),
      ]
    );
    if (kind === "tenant") {
      run(db, "UPDATE organizations SET tenant_id = ? WHERE id = ?", [result.lastInsertRowid, result.lastInsertRowid]);
    }
    const org = getOrganization(db, result.lastInsertRowid);
    if (actor) {
      writeAudit(db, {
        actor,
        action: "org.create",
        resourceType: "organization",
        resourceId: org.id,
        details: { code: org.code, kind: org.kind },
        ip,
      });
    }
    return org;
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Organization code already exists");
    }
    throw err;
  }
}

export function updateOrganization(db, id, body, actor, ip) {
  const current = getOrganization(db, id);
  const parentId = body.parent_id === undefined ? current.parent_id : body.parent_id || null;
  assertNoCycle(db, id, parentId);
  if (body.code && body.code !== current.code) validateCode(body.code, "Organization code");
  const kind = body.kind ? assertKind(db, body.kind) : current.kind;
  assertKindChangeSafe(db, id, kind, current.kind);
  const parent = loadParent(db, parentId);
  assertParentKind(db, kind, parent);
  assertSameTenant(current, parent);
  const nextTenantId = kind === "tenant" ? current.id : inheritTenantId(kind, parent) || current.tenant_id;
  try {
    run(
      db,
      `UPDATE organizations SET code = ?, name = ?, kind = ?, description = ?, parent_id = ?, tenant_id = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.code ?? current.code,
        (body.name ?? current.name).trim(),
        kind,
        body.description ?? current.description ?? "",
        parent ? parent.id : null,
        nextTenantId,
        nowIso(),
        id,
      ]
    );
    if (kind === "tenant") {
      run(db, "UPDATE organizations SET tenant_id = ? WHERE id = ?", [id, id]);
    }
    stampDescendantTenants(db, id, nextTenantId);
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Organization code already exists");
    }
    throw err;
  }
  const org = getOrganization(db, id);
  writeAudit(db, {
    actor,
    action: "org.update",
    resourceType: "organization",
    resourceId: id,
    details: { before: current, after: org },
    ip,
  });
  return org;
}

export function moveOrganization(db, id, parentId, actor, ip) {
  return updateOrganization(db, id, { parent_id: parentId || null }, actor, ip);
}

export function setOrganizationStatus(db, id, status, actor, ip) {
  if (!["active", "inactive"].includes(status)) throw new HttpError(400, "Invalid status");
  getOrganization(db, id);
  run(db, "UPDATE organizations SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), id]);
  const org = getOrganization(db, id);
  writeAudit(db, {
    actor,
    action: `org.${status}`,
    resourceType: "organization",
    resourceId: id,
    ip,
  });
  return org;
}

export function deleteOrganization(db, id, actor, ip) {
  const org = getOrganization(db, id);
  const children = queryOne(db, "SELECT COUNT(*) AS c FROM organizations WHERE parent_id = ?", [id]).c;
  if (children > 0) throw new HttpError(409, "Cannot delete an organization that has children");
  const users = queryOne(db, "SELECT COUNT(*) AS c FROM users WHERE organization_id = ?", [id]).c;
  if (users > 0) throw new HttpError(409, "Cannot delete an organization that still has users");
  const groups = queryOne(db, "SELECT COUNT(*) AS c FROM groups WHERE organization_id = ?", [id]).c;
  if (groups > 0) throw new HttpError(409, "Cannot delete an organization that still has groups");
  const members = queryOne(db, "SELECT COUNT(*) AS c FROM organization_members WHERE organization_id = ?", [id]).c;
  if (members > 0) throw new HttpError(409, "Cannot delete an organization that still has members");
  run(db, "DELETE FROM organizations WHERE id = ?", [id]);
  writeAudit(db, {
    actor,
    action: "org.delete",
    resourceType: "organization",
    resourceId: id,
    details: { code: org.code },
    ip,
  });
  return { deleted: true, id: Number(id) };
}

export function listSites(db, organizationId) {
  getOrganization(db, organizationId);
  const ids = descendantOrganizationIds(db, organizationId);
  if (ids.length === 1) {
    return queryAll(
      db,
      `SELECT * FROM organizations WHERE parent_id = ? AND kind = 'site' ORDER BY name`,
      [organizationId]
    );
  }
  const placeholders = ids.map(() => "?").join(",");
  return queryAll(
    db,
    `SELECT * FROM organizations WHERE id IN (${placeholders}) AND kind = 'site' AND id != ? ORDER BY name`,
    [...ids, Number(organizationId)]
  );
}

export function listMembers(db, organizationId) {
  getOrganization(db, organizationId);
  return queryAll(
    db,
    `SELECT u.id, u.username, u.email, u.employee_id, u.display_name, u.status, u.organization_id AS home_organization_id,
            m.is_primary, m.added_at
     FROM organization_members m
     JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = ?
     ORDER BY u.username`,
    [organizationId]
  );
}

function stampDescendantTenants(db, id, tenantId) {
  if (!tenantId) return;
  const ids = descendantOrganizationIds(db, id);
  for (const childId of ids) {
    run(db, "UPDATE organizations SET tenant_id = ? WHERE id = ? AND kind != 'tenant'", [tenantId, childId]);
  }
  run(
    db,
    `UPDATE users SET tenant_id = ? WHERE organization_id IN (${ids.map(() => "?").join(",")})`,
    [tenantId, ...ids]
  );
  run(
    db,
    `UPDATE groups SET tenant_id = ? WHERE organization_id IN (${ids.map(() => "?").join(",")})`,
    [tenantId, ...ids]
  );
}

export function addMember(db, organizationId, userId, isPrimary, actor, ip) {
  const org = getOrganization(db, organizationId);
  const user = queryOne(db, "SELECT id, username, tenant_id, organization_id FROM users WHERE id = ?", [userId]);
  if (!user) throw new HttpError(404, "User not found");
  const orgTenant = tenantIdOf(org);
  const userTenant = user.tenant_id || (user.organization_id ? tenantIdOf(getOrganization(db, user.organization_id)) : null);
  if (orgTenant && userTenant && Number(orgTenant) !== Number(userTenant)) {
    throw new HttpError(409, "Cannot assign a user to an organization in another tenant");
  }
  const allowMulti = hierarchy.getSetting(db, "org.allow_multi_site", true);
  if (!allowMulti) {
    const existingCount = queryOne(
      db,
      "SELECT COUNT(*) AS c FROM organization_members WHERE user_id = ?",
      [userId]
    ).c;
    const alreadyHere = queryOne(
      db,
      "SELECT 1 AS x FROM organization_members WHERE organization_id = ? AND user_id = ?",
      [organizationId, userId]
    );
    if (existingCount > 0 && !alreadyHere) {
      throw new HttpError(409, "Multi-site assignment is disabled by Super Admin");
    }
  }
  const existing = queryOne(
    db,
    "SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ?",
    [organizationId, userId]
  );
  if (existing) {
    if (isPrimary && !existing.is_primary) {
      run(db, "UPDATE organization_members SET is_primary = 0 WHERE user_id = ?", [userId]);
      run(
        db,
        "UPDATE organization_members SET is_primary = 1 WHERE organization_id = ? AND user_id = ?",
        [organizationId, userId]
      );
    }
    return listMembers(db, organizationId);
  }
  if (isPrimary) {
    run(db, "UPDATE organization_members SET is_primary = 0 WHERE user_id = ?", [userId]);
  }
  run(
    db,
    "INSERT INTO organization_members (organization_id, user_id, is_primary, added_at) VALUES (?, ?, ?, ?)",
    [organizationId, userId, isPrimary ? 1 : 0, nowIso()]
  );
  if (actor) {
    writeAudit(db, {
      actor,
      action: "org.member.add",
      resourceType: "organization",
      resourceId: organizationId,
      details: { userId: Number(userId), username: user.username, isPrimary: Boolean(isPrimary) },
      ip,
    });
  }
  return listMembers(db, organizationId);
}

export function removeMember(db, organizationId, userId, actor, ip) {
  getOrganization(db, organizationId);
  const existing = queryOne(
    db,
    "SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ?",
    [organizationId, userId]
  );
  if (!existing) throw new HttpError(404, "Membership not found");
  run(db, "DELETE FROM organization_members WHERE organization_id = ? AND user_id = ?", [
    organizationId,
    userId,
  ]);
  writeAudit(db, {
    actor,
    action: "org.member.remove",
    resourceType: "organization",
    resourceId: organizationId,
    details: { userId: Number(userId) },
    ip,
  });
  return listMembers(db, organizationId);
}

export function listUserOrganizations(db, userId) {
  const user = queryOne(db, "SELECT id FROM users WHERE id = ?", [userId]);
  if (!user) throw new HttpError(404, "User not found");
  return queryAll(
    db,
    `SELECT o.*, m.is_primary, m.added_at
     FROM organization_members m
     JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = ?
     ORDER BY m.is_primary DESC, o.name`,
    [userId]
  );
}

export function syncHomeMembership(db, userId, organizationId) {
  if (!userId) return;
  if (!organizationId) return;
  addMember(db, organizationId, userId, true);
}

export function organizationDetail(db, id) {
  const org = getOrganization(db, id);
  const children = queryAll(
    db,
    "SELECT * FROM organizations WHERE parent_id = ? ORDER BY kind, name",
    [id]
  );
  const ancestors = ancestorOrganizations(db, id).slice(1);
  return {
    ...org,
    ancestors,
    path: [...ancestors].reverse().concat(org),
    children,
    sites: children.filter((c) => c.kind === "site").concat(
      listSites(db, id).filter((s) => !children.some((c) => c.id === s.id))
    ),
    members: listMembers(db, id),
  };
}

export function organizationContext(db, id) {
  const detail = organizationDetail(db, id);
  return {
    organization: {
      id: detail.id,
      code: detail.code,
      name: detail.name,
      kind: detail.kind,
      status: detail.status,
      parent_id: detail.parent_id,
    },
    ancestors: detail.ancestors.map((a) => ({
      id: a.id,
      code: a.code,
      name: a.name,
      kind: a.kind,
    })),
    children: detail.children.map((c) => ({
      id: c.id,
      code: c.code,
      name: c.name,
      kind: c.kind,
      status: c.status,
    })),
    descendantIds: descendantOrganizationIds(db, id),
    ancestorIds: ancestorOrganizationIds(db, id),
    path: detail.path.map((n) => n.code).join(" / "),
    members: detail.members,
    tenant: detail.kind === "tenant"
      ? { id: detail.id, code: detail.code, name: detail.name, status: detail.status }
      : detail.tenant_id
        ? queryOne(db, "SELECT id, code, name, status, kind FROM organizations WHERE id = ?", [detail.tenant_id])
        : null,
  };
}

export function organizationTree(db, query = {}) {
  const where = [];
  const params = [];
  if (query.kind) {
    assertKind(db, query.kind);
    where.push("kind = ?");
    params.push(query.kind);
  }
  if (query.status) {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.q) {
    where.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  if (query.tenantId) {
    where.push("(tenant_id = ? OR id = ?)");
    params.push(Number(query.tenantId), Number(query.tenantId));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const items = queryAll(
    db,
    `SELECT o.*,
      (SELECT COUNT(*) FROM organizations c WHERE c.parent_id = o.id) AS child_count,
      (SELECT COUNT(*) FROM users u WHERE u.organization_id = o.id) AS user_count,
      (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id) AS member_count
     FROM organizations o ${clause} ORDER BY o.kind, o.name`,
    params
  );
  const byParent = new Map();
  for (const item of items) {
    const key = item.parent_id || 0;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(item);
  }
  function nest(parentId) {
    return (byParent.get(parentId) || []).map((node) => ({
      ...node,
      children: nest(node.id),
    }));
  }
  const roots = nest(0);
  const attached = new Set();
  function mark(nodes) {
    for (const n of nodes) {
      attached.add(n.id);
      mark(n.children);
    }
  }
  mark(roots);
  const orphans = items.filter((i) => !attached.has(i.id)).map((n) => ({ ...n, children: [] }));
  return { items: roots.concat(orphans), total: items.length };
}
