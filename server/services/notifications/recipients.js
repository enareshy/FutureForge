import { queryAll, queryOne } from "../../db.js";
import { descendantOrganizationIds } from "../orgs.js";
import {
  normalizeRecipientDefinition,
  normalizeRecipientItem,
  resolvePathSafe,
} from "./validation.js";

// Recipient resolution service. Turns a declarative recipient definition into a
// deduplicated list of active users, respecting tenant boundaries. Reused by
// every rule regardless of which business module published the event.

const USER_COLUMNS = "u.id, u.username, u.display_name, u.email, u.organization_id, u.tenant_id";

function tenantPredicate(tenantId, alias = "u") {
  if (tenantId) return { sql: `${alias}.tenant_id = ?`, params: [Number(tenantId)] };
  return { sql: `${alias}.tenant_id IS NULL`, params: [] };
}

function activeUsersInOrganizations(db, organizationIds, tenantId) {
  const ids = [...new Set(organizationIds.map(Number).filter(Boolean))];
  if (!ids.length) return [];
  const scope = tenantPredicate(tenantId);
  const placeholders = ids.map(() => "?").join(", ");
  return queryAll(
    db,
    `SELECT ${USER_COLUMNS} FROM users u
      WHERE u.status = 'active' AND u.organization_id IN (${placeholders}) AND ${scope.sql}
      ORDER BY u.username`,
    [...ids, ...scope.params]
  );
}

function resolveOrganizationSubtree(db, organizationId, tenantId) {
  const id = Number(organizationId);
  if (!id) return [];
  const descendants = descendantOrganizationIds(db, id);
  const ids = [id, ...(descendants || [])];
  return activeUsersInOrganizations(db, ids, tenantId);
}

function usersForRole(db, roleRef, tenantId, organizationId = 0) {
  if (!roleRef && roleRef !== 0) return [];
  const scope = tenantPredicate(tenantId);
  return queryAll(
    db,
    `SELECT DISTINCT ${USER_COLUMNS}
       FROM users u
      WHERE u.status = 'active' AND ${scope.sql}
        AND u.id IN (
          SELECT ur.user_id FROM user_roles ur
           WHERE ur.role_id IN (SELECT id FROM roles WHERE id = ? OR code = ?)
             AND (ur.organization_id = 0 OR ur.organization_id = ?)
          UNION
          SELECT gm.user_id FROM group_members gm
            JOIN group_roles gr ON gr.group_id = gm.group_id
           WHERE gr.role_id IN (SELECT id FROM roles WHERE id = ? OR code = ?)
             AND (gr.organization_id = 0 OR gr.organization_id = ?)
        )
      ORDER BY u.username`,
    [
      ...scope.params,
      Number(roleRef) || 0,
      String(roleRef ?? ""),
      Number(organizationId) || 0,
      Number(roleRef) || 0,
      String(roleRef ?? ""),
      Number(organizationId) || 0,
    ]
  );
}

function usersForGroup(db, groupRef, tenantId) {
  if (!groupRef && groupRef !== 0) return [];
  const scope = tenantPredicate(tenantId);
  return queryAll(
    db,
    `SELECT DISTINCT ${USER_COLUMNS}
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       JOIN groups g ON g.id = gm.group_id
      WHERE u.status = 'active' AND ${scope.sql}
        AND (g.id = ? OR g.code = ?)
      ORDER BY u.username`,
    [...scope.params, Number(groupRef) || 0, String(groupRef ?? "")]
  );
}

function usersForIdsOrRefs(db, values, tenantId) {
  const list = Array.isArray(values) ? values : [values];
  const ids = [];
  const refs = [];
  for (const value of list) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "number" || /^\d+$/.test(String(value))) ids.push(Number(value));
    else refs.push(String(value));
  }
  const out = [];
  const scope = tenantPredicate(tenantId);
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(", ");
    out.push(
      ...queryAll(
        db,
        `SELECT ${USER_COLUMNS} FROM users u WHERE u.status = 'active' AND ${scope.sql} AND u.id IN (${placeholders})`,
        [...scope.params, ...ids]
      )
    );
  }
  if (refs.length) {
    const ph = refs.map(() => "?").join(", ");
    out.push(
      ...queryAll(
        db,
        `SELECT ${USER_COLUMNS} FROM users u
          WHERE u.status = 'active' AND ${scope.sql} AND (u.username IN (${ph}) OR u.email IN (${ph}))`,
        [...scope.params, ...refs, ...refs]
      )
    );
  }
  return out;
}

function getByIdentity(db, { id, ref }, tenantId) {
  const scope = tenantPredicate(tenantId);
  if (id) {
    const row = queryOne(db, `SELECT ${USER_COLUMNS} FROM users u WHERE u.id = ? AND ${scope.sql}`, [Number(id), ...scope.params]);
    if (row && row.status !== "inactive") return [row];
  }
  if (ref) {
    const row = queryOne(
      db,
      `SELECT ${USER_COLUMNS} FROM users u WHERE (u.username = ? OR u.email = ?) AND ${scope.sql}`,
      [String(ref), String(ref), ...scope.params]
    );
    if (row && row.status !== "inactive") return [row];
  }
  return [];
}

// Manager / supervisor: the primary members of the target user's parent
// organization (department head and upwards). An explicit id in the event
// context always wins.
function resolveManager(db, context, tenantId) {
  const explicit = context.managerUserId || context.supervisorUserId || context.payload?.manager_id;
  if (explicit) return usersForIdsOrRefs(db, explicit, tenantId);
  const subjectUser =
    context.recipient ||
    context.object?.owner_id ||
    context.object?.created_by ||
    context.task?.assignee_id ||
    context.initiator?.id ||
    context.task?.assignee_id;
  let organizationId = context.organization?.id || context.object?.organization_id || context.initiator?.organization_id;
  if (subjectUser && !organizationId) {
    const row = queryOne(db, "SELECT organization_id FROM users WHERE id = ?", [Number(subjectUser)]);
    organizationId = row?.organization_id;
  }
  if (!organizationId) return [];
  const org = queryOne(db, "SELECT id, parent_id FROM organizations WHERE id = ?", [Number(organizationId)]);
  if (!org) return [];
  const targetId = org.parent_id || org.id;
  const scope = tenantPredicate(tenantId);
  const primary = queryAll(
    db,
    `SELECT DISTINCT ${USER_COLUMNS}
       FROM organization_members om
       JOIN users u ON u.id = om.user_id
      WHERE om.organization_id = ? AND om.is_primary = 1 AND u.status = 'active' AND ${scope.sql}
      ORDER BY u.username`,
    [Number(targetId), ...scope.params]
  );
  if (primary.length) return primary;
  return activeUsersInOrganizations(db, descendantOrganizationIds(db, targetId) || [targetId], tenantId);
}

function resolveItem(db, item, context, tenantId) {
  const type = item.type || "user";
  switch (type) {
    case "user":
      return getByIdentity(db, item, tenantId);
    case "role":
      return usersForRole(db, item.id ?? item.ref, tenantId, context.organization?.id || context.object?.organization_id || 0);
    case "group":
      return usersForGroup(db, item.id ?? item.ref, tenantId);
    case "organization":
    case "business_unit":
    case "plant":
    case "site":
    case "department":
      return resolveOrganizationSubtree(db, item.id ?? item.ref ?? context.organization?.id, tenantId);
    case "responsible_organization":
      return resolveOrganizationSubtree(
        db,
        context.responsible_organization_id || item.id || item.ref || context.organization?.id,
        tenantId
      );
    case "object_owner":
      return usersForIdsOrRefs(db, context.object?.owner_id ?? context.payload?.owner_id, tenantId);
    case "object_creator":
      return usersForIdsOrRefs(db, context.object?.created_by ?? context.payload?.created_by, tenantId);
    case "workflow_assignee":
      return resolveAssigneeUsers(db, context.workflow || {}, tenantId, context);
    case "task_assignee":
      return resolveAssigneeUsers(db, context.task || {}, tenantId, context);
    case "manager":
      return resolveManager(db, context, tenantId);
    case "supervisor":
      return resolveManager(db, { ...context, supervisorUserId: context.supervisorUserId || context.payload?.supervisor_id }, tenantId);
    case "initiator":
      return getByIdentity(db, { id: context.initiator?.id, ref: context.initiator?.username }, tenantId);
    case "event_payload": {
      const path = item.ref || item.id;
      const value = path ? resolvePathSafe(context.payload || context, String(path)) : context.payload?.recipients;
      return usersForIdsOrRefs(db, value, tenantId);
    }
    default:
      return [];
  }
}

function resolveAssigneeUsers(db, holder, tenantId, context) {
  const type = holder.assignee_type || "user";
  const id = holder.assignee_id;
  const ref = holder.assignee_ref;
  if (!type || type === "unassigned") return [];
  if (type === "user") return getByIdentity(db, { id, ref }, tenantId);
  if (type === "role" || type === "queue") return usersForRole(db, id ?? ref, tenantId, context.organization?.id || 0);
  if (type === "group") return usersForGroup(db, id ?? ref, tenantId);
  if (type === "organization") return resolveOrganizationSubtree(db, id ?? ref, tenantId);
  return [];
}

// Public entry point. Returns deduplicated active users. Resolution order:
// explicit items, then fallback items when the primary items resolved nobody.
export function resolveRecipients(db, definition, context = {}, tenantId = null) {
  const normalized = normalizeRecipientDefinition(definition);
  const items = normalized.items.length ? normalized.items : [normalizeRecipientItem({ type: "initiator" })];
  const collected = collect(db, items, context, tenantId);
  if (!collected.length && normalized.fallback.length) {
    return finalize(collect(db, normalized.fallback, context, tenantId), normalized, context);
  }
  return finalize(collected, normalized, context);
}

function collect(db, items, context, tenantId) {
  const map = new Map();
  for (const item of items) {
    for (const user of resolveItem(db, item, context, tenantId)) {
      if (!user) continue;
      if (user.status && user.status !== "active") continue;
      if (item.exclude_initiator && Number(user.id) === Number(context.initiator?.id)) continue;
      map.set(Number(user.id), user);
    }
  }
  return [...map.values()];
}

function finalize(users, normalized, context) {
  let list = users;
  if (!normalized.include_initiator && context.initiator?.id) {
    list = list.filter((user) => Number(user.id) !== Number(context.initiator.id));
  }
  const seen = new Set();
  return list
    .filter((user) => {
      const id = Number(user.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((user) => ({
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      email: user.email,
      organization_id: user.organization_id,
      tenant_id: user.tenant_id,
      language: user.language || "en",
      isInitiator: context.initiator?.id ? Number(user.id) === Number(context.initiator.id) : false,
    }));
}
