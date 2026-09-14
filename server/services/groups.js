import { queryAll, queryOne, run, nowIso } from "../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../validation.js";
import { writeAudit } from "./audit.js";

export function getGroup(db, id, { tenantId } = {}) {
  const group = queryOne(db, "SELECT * FROM groups WHERE id = ?", [id]);
  if (!group) throw new HttpError(404, "Group not found");
  if (tenantId && Number(group.tenant_id) !== Number(tenantId)) throw new HttpError(404, "Group not found");
  return group;
}

export function listGroups(db, query = {}) {
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  if (query.organizationId) {
    where.push("organization_id = ?");
    params.push(Number(query.organizationId));
  }
  if (query.tenantId) {
    where.push("tenant_id = ?");
    params.push(Number(query.tenantId));
  }
  if (query.q) {
    where.push("(name LIKE ? OR code LIKE ? OR description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM groups ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT g.*,
       (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count
     FROM groups g ${clause} ORDER BY g.name LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return { items, total, page, pageSize };
}

function assertNoCycle(db, id, parentId) {
  if (!parentId) return;
  if (Number(id) === Number(parentId)) {
    throw new HttpError(400, "A group cannot be its own parent");
  }
  let current = parentId;
  const seen = new Set();
  while (current) {
    if (seen.has(current) || Number(current) === Number(id)) {
      throw new HttpError(400, "Group hierarchy cycle detected");
    }
    seen.add(current);
    const row = queryOne(db, "SELECT parent_id FROM groups WHERE id = ?", [current]);
    if (!row) throw new HttpError(400, "Parent group not found");
    current = row.parent_id;
  }
}

export function createGroup(db, body, actor, ip) {
  requireFields(body, ["name", "code"]);
  validateCode(body.code, "Group code");
  if (body.parent_id) getGroup(db, body.parent_id);
  let tenantId = body.tenant_id || null;
  if (body.organization_id) {
    const org = queryOne(db, "SELECT id, kind, tenant_id FROM organizations WHERE id = ?", [body.organization_id]);
    if (!org) throw new HttpError(400, "Organization not found");
    tenantId = org.kind === "tenant" ? org.id : org.tenant_id || tenantId;
  }
  if (body.parent_id) {
    const parent = getGroup(db, body.parent_id);
    if (tenantId && parent.tenant_id && Number(parent.tenant_id) !== Number(tenantId)) {
      throw new HttpError(409, "Cannot nest a group under another tenant");
    }
    tenantId = tenantId || parent.tenant_id;
  }
  let result;
  try {
    result = run(
      db,
      `INSERT INTO groups (name, code, description, parent_id, organization_id, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.name.trim(),
        body.code,
        body.description || "",
        body.parent_id || null,
        body.organization_id || null,
        tenantId,
        nowIso(),
        nowIso(),
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Group code already exists");
    }
    throw err;
  }
  const group = getGroup(db, result.lastInsertRowid);
  writeAudit(db, {
    actor,
    action: "group.create",
    resourceType: "group",
    resourceId: group.id,
    details: { code: group.code },
    ip,
  });
  return group;
}

export function updateGroup(db, id, body, actor, ip) {
  const current = getGroup(db, id);
  const parentId = body.parent_id === undefined ? current.parent_id : body.parent_id || null;
  assertNoCycle(db, id, parentId);
  if (body.code && body.code !== current.code) validateCode(body.code, "Group code");
  const organizationId = body.organization_id === undefined ? current.organization_id : body.organization_id || null;
  let tenantId = current.tenant_id;
  if (organizationId) {
    const org = queryOne(db, "SELECT id, kind, tenant_id FROM organizations WHERE id = ?", [organizationId]);
    if (!org) throw new HttpError(400, "Organization not found");
    const orgTenant = org.kind === "tenant" ? org.id : org.tenant_id;
    if (tenantId && orgTenant && Number(tenantId) !== Number(orgTenant)) {
      throw new HttpError(409, "Cannot move a group to another tenant");
    }
    tenantId = orgTenant || tenantId;
  }
  try {
    run(
      db,
      `UPDATE groups SET name = ?, code = ?, description = ?, parent_id = ?, organization_id = ?, tenant_id = ?, updated_at = ?
       WHERE id = ?`,
      [
        (body.name ?? current.name).trim(),
        body.code ?? current.code,
        body.description ?? current.description,
        parentId,
        organizationId,
        tenantId,
        nowIso(),
        id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Group code already exists");
    }
    throw err;
  }
  const group = getGroup(db, id);
  writeAudit(db, {
    actor,
    action: "group.update",
    resourceType: "group",
    resourceId: id,
    details: { before: current, after: group },
    ip,
  });
  return group;
}

export function deleteGroup(db, id, actor, ip) {
  const group = getGroup(db, id);
  const children = queryOne(db, "SELECT COUNT(*) AS c FROM groups WHERE parent_id = ?", [id]).c;
  if (children > 0) {
    throw new HttpError(409, "Cannot delete a group that has child groups");
  }
  run(db, "DELETE FROM groups WHERE id = ?", [id]);
  writeAudit(db, {
    actor,
    action: "group.delete",
    resourceType: "group",
    resourceId: id,
    details: { code: group.code },
    ip,
  });
  return { deleted: true, id: Number(id) };
}

export function listGroupMembers(db, groupId) {
  getGroup(db, groupId);
  return queryAll(
    db,
    `SELECT u.id, u.username, u.email, u.employee_id, u.display_name, u.status, gm.added_at
     FROM users u JOIN group_members gm ON gm.user_id = u.id
     WHERE gm.group_id = ? ORDER BY u.username`,
    [groupId]
  );
}

export function addGroupMember(db, groupId, userId, actor, ip) {
  getGroup(db, groupId);
  const user = queryOne(db, "SELECT id FROM users WHERE id = ?", [userId]);
  if (!user) throw new HttpError(404, "User not found");
  const existing = queryOne(
    db,
    "SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?",
    [groupId, userId]
  );
  if (existing) throw new HttpError(409, "User is already a member of this group");
  run(db, "INSERT INTO group_members (group_id, user_id) VALUES (?, ?)", [groupId, userId]);
  writeAudit(db, {
    actor,
    action: "group.add_member",
    resourceType: "group",
    resourceId: groupId,
    details: { userId: Number(userId) },
    ip,
  });
  return listGroupMembers(db, groupId);
}

export function removeGroupMember(db, groupId, userId, actor, ip) {
  getGroup(db, groupId);
  const existing = queryOne(
    db,
    "SELECT 1 AS x FROM group_members WHERE group_id = ? AND user_id = ?",
    [groupId, userId]
  );
  if (!existing) throw new HttpError(404, "Membership not found");
  run(db, "DELETE FROM group_members WHERE group_id = ? AND user_id = ?", [groupId, userId]);
  writeAudit(db, {
    actor,
    action: "group.remove_member",
    resourceType: "group",
    resourceId: groupId,
    details: { userId: Number(userId) },
    ip,
  });
  return listGroupMembers(db, groupId);
}

export function ancestorGroups(db, groupId) {
  const result = [];
  let current = groupId;
  const seen = new Set();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const row = queryOne(db, "SELECT * FROM groups WHERE id = ?", [current]);
    if (!row) break;
    result.push(row);
    current = row.parent_id;
  }
  return result;
}

export function descendantGroupIds(db, groupId) {
  const ids = [Number(groupId)];
  const queue = [Number(groupId)];
  while (queue.length) {
    const id = queue.shift();
    const children = queryAll(db, "SELECT id FROM groups WHERE parent_id = ?", [id]);
    for (const child of children) {
      if (!ids.includes(child.id)) {
        ids.push(child.id);
        queue.push(child.id);
      }
    }
  }
  return ids;
}

export function groupsForUser(db, userId) {
  const direct = queryAll(
    db,
    `SELECT g.* FROM groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.user_id = ?`,
    [userId]
  );
  const map = new Map();
  for (const g of direct) {
    for (const ancestor of ancestorGroups(db, g.id)) {
      map.set(ancestor.id, ancestor);
    }
  }
  return [...map.values()];
}
