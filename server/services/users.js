import { queryAll, queryOne, run, nowIso } from "../db.js";
import { hashPassword, verifyPassword } from "../crypto.js";
import { HttpError, requireFields, validateUsername, validateEmail, validateEmployeeId, validatePasswordAgainstPolicy, pagination } from "../validation.js";
import { getPolicy } from "./policy.js";
import { writeAudit } from "./audit.js";
import * as orgs from "./orgs.js";
import { emitDomainEvent } from "./events/emit.js";

const PUBLIC_USER_COLS = `id, username, email, employee_id, display_name, status,
  organization_id, tenant_id, failed_login_attempts, locked_until, last_login_at,
  password_changed_at, created_at, updated_at`;

export function publicUser(row) {
  if (!row) return null;
  const { password_hash, password_salt, ...rest } = row;
  return rest;
}

export function getUser(db, id, { tenantId } = {}) {
  const user = queryOne(db, `SELECT ${PUBLIC_USER_COLS} FROM users WHERE id = ?`, [id]);
  if (!user) throw new HttpError(404, "User not found");
  if (tenantId && Number(user.tenant_id) !== Number(tenantId)) throw new HttpError(404, "User not found");
  return user;
}

export function getUserInternal(db, id) {
  const user = queryOne(db, "SELECT * FROM users WHERE id = ?", [id]);
  if (!user) throw new HttpError(404, "User not found");
  return user;
}

export function listUsers(db, query) {
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  if (query.status) {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.organizationId) {
    where.push("organization_id = ?");
    params.push(Number(query.organizationId));
  }
  if (query.tenantId) {
    where.push("tenant_id = ?");
    params.push(Number(query.tenantId));
  }
  if (query.q) {
    where.push("(username LIKE ? OR email LIKE ? OR employee_id LIKE ? OR display_name LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM users ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT ${PUBLIC_USER_COLS} FROM users ${clause} ORDER BY username LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  return { items, total, page, pageSize };
}

function assertOrg(db, organizationId) {
  if (!organizationId) return null;
  const org = queryOne(db, "SELECT id FROM organizations WHERE id = ?", [organizationId]);
  if (!org) throw new HttpError(400, "Organization not found");
  return organizationId;
}

function assertUnique(db, { username, email, employee_id, excludeId }) {
  const existing = queryOne(
    db,
    `SELECT id, username, email, employee_id FROM users
     WHERE (username = ? OR email = ? OR employee_id = ?) AND id != ?`,
    [username, email, employee_id, excludeId || 0]
  );
  if (!existing) return;
  if (existing.username.toLowerCase() === username.toLowerCase()) {
    throw new HttpError(409, "Username already exists");
  }
  if (existing.email.toLowerCase() === email.toLowerCase()) {
    throw new HttpError(409, "Email already exists");
  }
  throw new HttpError(409, "Employee ID already exists");
}

function storePassword(db, userId, password, policy) {
  validatePasswordAgainstPolicy(password, policy);
  if (userId) {
    const history = queryAll(
      db,
      "SELECT password_hash, password_salt FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?",
      [userId, policy.history_count]
    );
    for (const row of history) {
      if (verifyPassword(password, row.password_hash, row.password_salt)) {
        throw new HttpError(400, "Password was used recently and cannot be reused");
      }
    }
  }
  const { hash, salt } = hashPassword(password);
  if (userId) {
    run(db, "INSERT INTO password_history (user_id, password_hash, password_salt) VALUES (?, ?, ?)", [
      userId,
      hash,
      salt,
    ]);
    if (policy.history_count > 0) {
      run(
        db,
        `DELETE FROM password_history WHERE user_id = ? AND id NOT IN (
          SELECT id FROM password_history WHERE user_id = ? ORDER BY id DESC LIMIT ?
        )`,
        [userId, userId, policy.history_count]
      );
    }
  }
  return { hash, salt };
}

export function createUser(db, body, actor, ip) {
  requireFields(body, ["username", "email", "employee_id", "display_name", "password"]);
  validateUsername(body.username);
  validateEmail(body.email);
  validateEmployeeId(body.employee_id);
  const orgId = assertOrg(db, body.organization_id || null);
  let tenantId = body.tenant_id || null;
  if (orgId) {
    const org = queryOne(db, "SELECT id, kind, tenant_id FROM organizations WHERE id = ?", [orgId]);
    tenantId = org?.kind === "tenant" ? org.id : org?.tenant_id || tenantId;
  }
  if (body.contextTenantId) {
    if (tenantId && Number(tenantId) !== Number(body.contextTenantId)) {
      throw new HttpError(404, "Organization not found");
    }
    tenantId = tenantId || body.contextTenantId;
  }
  assertUnique(db, body);
  const policy = getPolicy(db);
  const { hash, salt } = storePassword(db, null, body.password, policy);
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO users (
        username, email, employee_id, display_name, status, organization_id, tenant_id,
        password_hash, password_salt, password_changed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.username,
        body.email.toLowerCase(),
        body.employee_id,
        body.display_name.trim(),
        orgId,
        tenantId,
        hash,
        salt,
        ts,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "User already exists");
    }
    throw err;
  }
  run(db, "INSERT INTO password_history (user_id, password_hash, password_salt) VALUES (?, ?, ?)", [
    result.lastInsertRowid,
    hash,
    salt,
  ]);
  const user = getUser(db, result.lastInsertRowid);
  if (orgId) orgs.syncHomeMembership(db, user.id, orgId);
  writeAudit(db, {
    actor,
    action: "user.create",
    resourceType: "user",
    resourceId: user.id,
    details: { username: user.username },
    ip,
  });
  emitDomainEvent(
    db,
    {
      event_type_code: "UserCreated",
      category: "user",
      source_module: "iam",
      source_system: "iam",
      source_object_type: "user",
      source_object_id: user.id,
      tenant_id: user.tenant_id ?? null,
      organization_id: user.organization_id ?? null,
      payload: {
        id: user.id,
        username: user.username,
        email: user.email,
        display_name: user.display_name,
        status: user.status,
        organization_id: user.organization_id ?? null,
      },
    },
    actor
  );
  return user;
}

export function updateUser(db, id, body, actor, ip) {
  const current = getUser(db, id);
  const next = {
    email: body.email ?? current.email,
    employee_id: body.employee_id ?? current.employee_id,
    display_name: body.display_name ?? current.display_name,
    organization_id:
      body.organization_id === undefined ? current.organization_id : body.organization_id || null,
  };
  if (body.username && body.username !== current.username) {
    throw new HttpError(400, "Username cannot be changed");
  }
  validateEmail(next.email);
  validateEmployeeId(next.employee_id);
  if (next.organization_id) assertOrg(db, next.organization_id);
  let tenantId = current.tenant_id;
  if (next.organization_id) {
    const org = queryOne(db, "SELECT id, kind, tenant_id FROM organizations WHERE id = ?", [next.organization_id]);
    const orgTenant = org?.kind === "tenant" ? org.id : org?.tenant_id;
    if (tenantId && orgTenant && Number(tenantId) !== Number(orgTenant)) {
      throw new HttpError(409, "Cannot move a user to an organization in another tenant");
    }
    tenantId = orgTenant || tenantId;
  }
  assertUnique(db, {
    username: current.username,
    email: next.email,
    employee_id: next.employee_id,
    excludeId: id,
  });
  run(
    db,
    `UPDATE users SET email = ?, employee_id = ?, display_name = ?, organization_id = ?, tenant_id = ?, updated_at = ?
     WHERE id = ?`,
    [next.email.toLowerCase(), next.employee_id, next.display_name.trim(), next.organization_id, tenantId, nowIso(), id]
  );
  const user = getUser(db, id);
  if (user.organization_id) orgs.syncHomeMembership(db, user.id, user.organization_id);
  writeAudit(db, {
    actor,
    action: "user.update",
    resourceType: "user",
    resourceId: id,
    details: { before: current, after: user },
    ip,
  });
  emitDomainEvent(
    db,
    {
      event_type_code: "UserUpdated",
      category: "user",
      source_module: "iam",
      source_system: "iam",
      source_object_type: "user",
      source_object_id: user.id,
      tenant_id: user.tenant_id ?? null,
      organization_id: user.organization_id ?? null,
      payload: {
        id: user.id,
        username: user.username,
        status: user.status,
        changed: {
          email: current.email !== user.email,
          employee_id: current.employee_id !== user.employee_id,
          display_name: current.display_name !== user.display_name,
          organization_id: (current.organization_id ?? null) !== (user.organization_id ?? null),
        },
        before: {
          email: current.email,
          employee_id: current.employee_id,
          display_name: current.display_name,
          organization_id: current.organization_id ?? null,
        },
        after: {
          email: user.email,
          employee_id: user.employee_id,
          display_name: user.display_name,
          organization_id: user.organization_id ?? null,
        },
      },
    },
    actor
  );
  return user;
}

export function setUserStatus(db, id, status, actor, ip, extra = {}) {
  const allowed = ["active", "inactive", "locked"];
  if (!allowed.includes(status)) throw new HttpError(400, "Invalid status");
  getUser(db, id);
  const ts = nowIso();
  run(
    db,
    `UPDATE users SET status = ?, locked_until = ?, failed_login_attempts = ?, updated_at = ? WHERE id = ?`,
    [
      status,
      status === "locked" ? extra.locked_until || null : null,
      status === "active" ? 0 : extra.failed_login_attempts ?? 0,
      ts,
      id,
    ]
  );
  const user = getUser(db, id);
  writeAudit(db, {
    actor,
    action: `user.${status}`,
    resourceType: "user",
    resourceId: id,
    details: extra,
    ip,
  });
  return user;
}

export function resetPassword(db, id, password, actor, ip) {
  getUserInternal(db, id);
  const policy = getPolicy(db);
  const { hash, salt } = storePassword(db, id, password, policy);
  run(
    db,
    `UPDATE users SET password_hash = ?, password_salt = ?, password_changed_at = ?,
      failed_login_attempts = 0, locked_until = NULL, updated_at = ? WHERE id = ?`,
    [hash, salt, nowIso(), nowIso(), id]
  );
  writeAudit(db, {
    actor,
    action: "user.reset_password",
    resourceType: "user",
    resourceId: id,
    ip,
  });
  return getUser(db, id);
}

export function authenticate(db, username, password, ip) {
  const user = queryOne(db, "SELECT * FROM users WHERE username = ? COLLATE NOCASE", [username]);
  if (!user) throw new HttpError(401, "Invalid credentials");
  const policy = getPolicy(db);
  if (user.status === "inactive") {
    throw new HttpError(403, "Account is deactivated");
  }
  if (user.status === "locked") {
    if (user.locked_until && new Date(user.locked_until.replace(" ", "T") + "Z") > new Date()) {
      throw new HttpError(403, "Account is locked");
    }
    run(db, "UPDATE users SET status = 'active', locked_until = NULL, failed_login_attempts = 0 WHERE id = ?", [
      user.id,
    ]);
    user.status = "active";
  }
  if (!verifyPassword(password, user.password_hash, user.password_salt)) {
    const attempts = user.failed_login_attempts + 1;
    const lock = attempts >= policy.lockout_threshold;
    const lockedUntil = lock
      ? new Date(Date.now() + policy.lockout_minutes * 60 * 1000)
          .toISOString()
          .replace("T", " ")
          .slice(0, 19)
      : null;
    run(
      db,
      `UPDATE users SET failed_login_attempts = ?, status = ?, locked_until = ?, updated_at = ? WHERE id = ?`,
      [attempts, lock ? "locked" : user.status, lockedUntil, nowIso(), user.id]
    );
    writeAudit(db, {
      actor: { id: user.id, username: user.username },
      action: lock ? "user.lockout" : "user.login_failed",
      resourceType: "user",
      resourceId: user.id,
      details: { attempts },
      ip,
    });
    if (lock) throw new HttpError(403, "Account locked due to failed login attempts");
    throw new HttpError(401, "Invalid credentials");
  }
  run(
    db,
    `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?`,
    [nowIso(), nowIso(), user.id]
  );
  writeAudit(db, {
    actor: { id: user.id, username: user.username },
    action: "user.login",
    resourceType: "user",
    resourceId: user.id,
    ip,
  });
  return publicUser(queryOne(db, `SELECT ${PUBLIC_USER_COLS} FROM users WHERE id = ?`, [user.id]));
}

export function userMemberships(db, id) {
  const user = getUser(db, id);
  const groups = queryAll(
    db,
    `SELECT g.* FROM groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.user_id = ? ORDER BY g.name`,
    [id]
  );
  const roles = queryAll(
    db,
    `SELECT r.*, ur.organization_id AS assignment_organization_id
     FROM roles r JOIN user_roles ur ON ur.role_id = r.id
     WHERE ur.user_id = ? ORDER BY r.name`,
    [id]
  );
  const organizations = orgs.listUserOrganizations(db, id);
  return { user, groups, roles, organizations };
}
