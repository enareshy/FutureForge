import { queryAll, queryOne, run, nowIso } from "../db.js";
import { HttpError, requireFields, validateCode, pagination, orgScope } from "../validation.js";
import { writeAudit } from "./audit.js";

export function getRole(db, id) {
  const role = queryOne(db, "SELECT * FROM roles WHERE id = ?", [id]);
  if (!role) throw new HttpError(404, "Role not found");
  return role;
}

export function listRoles(db, query = {}) {
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  if (query.q) {
    where.push("(name LIKE ? OR code LIKE ? OR description LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM roles ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT r.*,
       (SELECT COUNT(*) FROM user_roles ur WHERE ur.role_id = r.id) AS user_assignment_count,
       (SELECT COUNT(*) FROM group_roles gr WHERE gr.role_id = r.id) AS group_assignment_count
     FROM roles r ${clause} ORDER BY r.name LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return { items, total, page, pageSize };
}

function assertNoCycle(db, id, parentId) {
  if (!parentId) return;
  if (Number(id) === Number(parentId)) {
    throw new HttpError(400, "A role cannot be its own parent");
  }
  let current = parentId;
  const seen = new Set();
  while (current) {
    if (seen.has(current) || Number(current) === Number(id)) {
      throw new HttpError(400, "Role inheritance cycle detected");
    }
    seen.add(current);
    const row = queryOne(db, "SELECT parent_id FROM roles WHERE id = ?", [current]);
    if (!row) throw new HttpError(400, "Parent role not found");
    current = row.parent_id;
  }
}

export function createRole(db, body, actor, ip) {
  requireFields(body, ["name", "code"]);
  validateCode(body.code, "Role code");
  if (body.parent_id) getRole(db, body.parent_id);
  let result;
  try {
    result = run(
      db,
      `INSERT INTO roles (name, code, description, parent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [body.name.trim(), body.code, body.description || "", body.parent_id || null, nowIso(), nowIso()]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Role code already exists");
    }
    throw err;
  }
  const role = getRole(db, result.lastInsertRowid);
  writeAudit(db, {
    actor,
    action: "role.create",
    resourceType: "role",
    resourceId: role.id,
    details: { code: role.code },
    ip,
  });
  return role;
}

export function updateRole(db, id, body, actor, ip) {
  const current = getRole(db, id);
  const parentId = body.parent_id === undefined ? current.parent_id : body.parent_id || null;
  assertNoCycle(db, id, parentId);
  if (body.code && body.code !== current.code) validateCode(body.code, "Role code");
  try {
    run(
      db,
      `UPDATE roles SET name = ?, code = ?, description = ?, parent_id = ?, updated_at = ? WHERE id = ?`,
      [
        (body.name ?? current.name).trim(),
        body.code ?? current.code,
        body.description ?? current.description,
        parentId,
        nowIso(),
        id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "Role code already exists");
    }
    throw err;
  }
  const role = getRole(db, id);
  writeAudit(db, {
    actor,
    action: "role.update",
    resourceType: "role",
    resourceId: id,
    details: { before: current, after: role },
    ip,
  });
  return role;
}

export function deleteRole(db, id, actor, ip) {
  const role = getRole(db, id);
  const children = queryOne(db, "SELECT COUNT(*) AS c FROM roles WHERE parent_id = ?", [id]).c;
  if (children > 0) {
    throw new HttpError(409, "Cannot delete a role that has child roles");
  }
  run(db, "DELETE FROM roles WHERE id = ?", [id]);
  writeAudit(db, {
    actor,
    action: "role.delete",
    resourceType: "role",
    resourceId: id,
    details: { code: role.code },
    ip,
  });
  return { deleted: true, id: Number(id) };
}

export function ancestorRoles(db, roleId) {
  const result = [];
  let current = roleId;
  const seen = new Set();
  while (current) {
    if (seen.has(current)) break;
    seen.add(current);
    const row = queryOne(db, "SELECT * FROM roles WHERE id = ?", [current]);
    if (!row) break;
    result.push(row);
    current = row.parent_id;
  }
  return result;
}

function assertOrgScope(db, organizationId) {
  const scope = orgScope(organizationId);
  if (scope === 0) return 0;
  const org = queryOne(db, "SELECT id FROM organizations WHERE id = ?", [scope]);
  if (!org) throw new HttpError(400, "Organization not found");
  return scope;
}

export function assignUserRole(db, userId, roleId, organizationId, actor, ip) {
  const user = queryOne(db, "SELECT id FROM users WHERE id = ?", [userId]);
  if (!user) throw new HttpError(404, "User not found");
  getRole(db, roleId);
  const scope = assertOrgScope(db, organizationId);
  const existing = queryOne(
    db,
    "SELECT 1 AS x FROM user_roles WHERE user_id = ? AND role_id = ? AND organization_id = ?",
    [userId, roleId, scope]
  );
  if (existing) throw new HttpError(409, "Role already assigned to user in this scope");
  run(db, "INSERT INTO user_roles (user_id, role_id, organization_id) VALUES (?, ?, ?)", [
    userId,
    roleId,
    scope,
  ]);
  writeAudit(db, {
    actor,
    action: "role.assign_user",
    resourceType: "role",
    resourceId: roleId,
    details: { userId: Number(userId), organizationId: scope },
    ip,
  });
  return listUserRoles(db, userId);
}

export function unassignUserRole(db, userId, roleId, organizationId, actor, ip) {
  const scope = orgScope(organizationId);
  const existing = queryOne(
    db,
    "SELECT 1 AS x FROM user_roles WHERE user_id = ? AND role_id = ? AND organization_id = ?",
    [userId, roleId, scope]
  );
  if (!existing) throw new HttpError(404, "Assignment not found");
  run(db, "DELETE FROM user_roles WHERE user_id = ? AND role_id = ? AND organization_id = ?", [
    userId,
    roleId,
    scope,
  ]);
  writeAudit(db, {
    actor,
    action: "role.unassign_user",
    resourceType: "role",
    resourceId: roleId,
    details: { userId: Number(userId), organizationId: scope },
    ip,
  });
  return listUserRoles(db, userId);
}

export function assignGroupRole(db, groupId, roleId, organizationId, actor, ip) {
  const group = queryOne(db, "SELECT id FROM groups WHERE id = ?", [groupId]);
  if (!group) throw new HttpError(404, "Group not found");
  getRole(db, roleId);
  const scope = assertOrgScope(db, organizationId);
  const existing = queryOne(
    db,
    "SELECT 1 AS x FROM group_roles WHERE group_id = ? AND role_id = ? AND organization_id = ?",
    [groupId, roleId, scope]
  );
  if (existing) throw new HttpError(409, "Role already assigned to group in this scope");
  run(db, "INSERT INTO group_roles (group_id, role_id, organization_id) VALUES (?, ?, ?)", [
    groupId,
    roleId,
    scope,
  ]);
  writeAudit(db, {
    actor,
    action: "role.assign_group",
    resourceType: "role",
    resourceId: roleId,
    details: { groupId: Number(groupId), organizationId: scope },
    ip,
  });
  return listGroupRoles(db, groupId);
}

export function unassignGroupRole(db, groupId, roleId, organizationId, actor, ip) {
  const scope = orgScope(organizationId);
  const existing = queryOne(
    db,
    "SELECT 1 AS x FROM group_roles WHERE group_id = ? AND role_id = ? AND organization_id = ?",
    [groupId, roleId, scope]
  );
  if (!existing) throw new HttpError(404, "Assignment not found");
  run(db, "DELETE FROM group_roles WHERE group_id = ? AND role_id = ? AND organization_id = ?", [
    groupId,
    roleId,
    scope,
  ]);
  writeAudit(db, {
    actor,
    action: "role.unassign_group",
    resourceType: "role",
    resourceId: roleId,
    details: { groupId: Number(groupId), organizationId: scope },
    ip,
  });
  return listGroupRoles(db, groupId);
}

export function listUserRoles(db, userId) {
  return queryAll(
    db,
    `SELECT r.*, ur.organization_id AS assignment_organization_id, ur.assigned_at
     FROM roles r JOIN user_roles ur ON ur.role_id = r.id
     WHERE ur.user_id = ? ORDER BY r.name`,
    [userId]
  );
}

export function listGroupRoles(db, groupId) {
  return queryAll(
    db,
    `SELECT r.*, gr.organization_id AS assignment_organization_id, gr.assigned_at
     FROM roles r JOIN group_roles gr ON gr.role_id = r.id
     WHERE gr.group_id = ? ORDER BY r.name`,
    [groupId]
  );
}

export function roleAssignments(db, roleId) {
  getRole(db, roleId);
  const users = queryAll(
    db,
    `SELECT u.id, u.username, u.display_name, ur.organization_id AS assignment_organization_id
     FROM users u JOIN user_roles ur ON ur.user_id = u.id
     WHERE ur.role_id = ? ORDER BY u.username`,
    [roleId]
  );
  const groups = queryAll(
    db,
    `SELECT g.id, g.name, g.code, gr.organization_id AS assignment_organization_id
     FROM groups g JOIN group_roles gr ON gr.group_id = g.id
     WHERE gr.role_id = ? ORDER BY g.name`,
    [roleId]
  );
  return { users, groups };
}
