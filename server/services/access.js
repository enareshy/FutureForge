import { queryAll, queryOne } from "../db.js";
import { HttpError } from "../validation.js";
import { memoize } from "../request-context.js";
import { ancestorRoles } from "./roles.js";
import { groupsForUser } from "./groups.js";

export function effectiveAccess(db, userId) {
  // A request commonly resolves the same principal's access several times (one
  // per permission guard, plus route code). Resolve it once per request.
  return memoize(`access:${userId}`, () => computeEffectiveAccess(db, userId));
}

function computeEffectiveAccess(db, userId) {
  const user = queryOne(
    db,
    `SELECT id, username, email, employee_id, display_name, status, organization_id
     FROM users WHERE id = ?`,
    [userId]
  );
  if (!user) throw new HttpError(404, "User not found");

  const membershipGroups = groupsForUser(db, userId);
  const groupIds = membershipGroups.map((g) => g.id);

  const userAssignments = queryAll(
    db,
    `SELECT role_id, organization_id FROM user_roles WHERE user_id = ?`,
    [userId]
  );

  const groupAssignments = groupIds.length
    ? queryAll(
        db,
        `SELECT group_id, role_id, organization_id FROM group_roles
         WHERE group_id IN (${groupIds.map(() => "?").join(",")})`,
        groupIds
      )
    : [];

  const roleMap = new Map();
  const ancestorCache = new Map();
  const sourceKeys = new Map();

  function ancestors(roleId) {
    let cached = ancestorCache.get(roleId);
    if (!cached) {
      cached = ancestorRoles(db, roleId);
      ancestorCache.set(roleId, cached);
    }
    return cached;
  }

  function add(roleId, source, sourceId, organizationId, inheritedFromAssignment) {
    for (const role of ancestors(roleId)) {
      const inherited = role.id !== roleId || inheritedFromAssignment;
      const key = `${role.id}:${organizationId}`;
      const existing = roleMap.get(key);
      const entry = {
        id: role.id,
        code: role.code,
        name: role.name,
        organizationId,
        inherited,
        sources: existing?.sources ? [...existing.sources] : [],
      };
      const src = { type: source, id: sourceId, assignedRoleId: roleId };
      const srcKey = `${key}|${src.type}|${src.id}|${src.assignedRoleId}`;
      if (!sourceKeys.has(srcKey)) {
        sourceKeys.set(srcKey, true);
        entry.sources.push(src);
      }
      if (existing && !inherited) entry.inherited = false;
      roleMap.set(key, entry);
    }
  }

  for (const a of userAssignments) {
    add(a.role_id, "user", userId, a.organization_id, false);
  }
  for (const a of groupAssignments) {
    add(a.role_id, "group", a.group_id, a.organization_id, false);
  }

  return {
    principal: user,
    groups: membershipGroups,
    roles: [...roleMap.values()].sort((a, b) => a.code.localeCompare(b.code)),
  };
}
