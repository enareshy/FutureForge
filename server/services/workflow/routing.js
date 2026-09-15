import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { readTenant, writeTenant, tenantClause, assertReadable, assertMutable } from "../metadata/scope.js";
import { ROUTING_ASSIGNEE_TYPES, ROUTING_STRATEGIES, safeParse, evaluateCondition } from "./validation.js";

// Assignment routing. Rules are evaluated by priority; the first matching rule
// wins (or round-robin/least-loaded strategies pick among candidates). Explicit
// node configuration always takes precedence over rules.

export function publicRoutingRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    definition_id: row.definition_id ?? null,
    node_type: row.node_type || "",
    priority: row.priority,
    condition: safeParse(row.condition_json, {}),
    strategy: row.strategy,
    assignee_type: row.assignee_type,
    assignee_id: row.assignee_id ?? null,
    assignee_ref: row.assignee_ref || "",
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    is_system: row.is_system === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getRoutingRuleRow(db, id) {
  return queryOne(db, "SELECT * FROM workflow_routing_rules WHERE id = ?", [Number(id)]);
}

export function listRoutingRules(db, query = {}, tenantId) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause("r", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.status) {
    where.push("r.status = ?");
    params.push(query.status);
  }
  if (query.definitionId || query.definition_id) {
    where.push("(r.definition_id IS NULL OR r.definition_id = ?)");
    params.push(Number(query.definitionId || query.definition_id));
  }
  if (query.nodeType || query.node_type) {
    where.push("(r.node_type = '' OR r.node_type = ?)");
    params.push(String(query.nodeType || query.node_type));
  }
  if (query.q) {
    where.push("(r.code LIKE ? OR r.name LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM workflow_routing_rules r ${clause}`, params).c;
  const items = queryAll(db, `SELECT r.* FROM workflow_routing_rules r ${clause} ORDER BY r.priority, r.code LIMIT ? OFFSET ?`, [
    ...params,
    pageSize,
    offset,
  ]).map(publicRoutingRule);
  return { items, total, page, pageSize };
}

export function createRoutingRule(db, body, actor = null, ip = null, reqTenantId = null) {
  requireFields(body, ["code", "name"]);
  validateCode(body.code, "Routing rule code");
  const tenantId = writeTenant(db, actor, body, reqTenantId);
  const assigneeType = body.assignee_type || body.assigneeType || "role";
  if (!ROUTING_ASSIGNEE_TYPES.includes(assigneeType)) {
    throw new HttpError(400, `assignee_type must be one of: ${ROUTING_ASSIGNEE_TYPES.join(", ")}`);
  }
  const strategy = body.strategy || "first_match";
  if (!ROUTING_STRATEGIES.includes(strategy)) {
    throw new HttpError(400, `strategy must be one of: ${ROUTING_STRATEGIES.join(", ")}`);
  }
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO workflow_routing_rules
        (code, name, description, definition_id, node_type, priority, condition_json, strategy,
         assignee_type, assignee_id, assignee_ref, status, tenant_id, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.description || "",
        body.definition_id ?? body.definitionId ?? null,
        body.node_type ?? body.nodeType ?? "",
        Number(body.priority ?? 100) || 100,
        JSON.stringify(body.condition ?? safeParse(body.condition_json, {})),
        strategy,
        assigneeType,
        body.assignee_id ?? body.assigneeId ?? null,
        body.assignee_ref ?? body.assigneeRef ?? "",
        body.status || "active",
        tenantId ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Routing rule code already exists in this scope");
    throw err;
  }
  writeAudit(db, { actor, action: "workflow.routing_rule.create", resourceType: "workflow_routing_rule", resourceId: result.lastInsertRowid, details: { code: body.code }, ip });
  return publicRoutingRule(getRoutingRuleRow(db, result.lastInsertRowid));
}

export function updateRoutingRule(db, id, body, actor = null, ip = null, tenantId = null) {
  const row = getRoutingRuleRow(db, id);
  assertMutable(db, row, tenantId, actor, "Routing rule not found");
  if (body.code && body.code !== row.code) validateCode(body.code, "Routing rule code");
  const assigneeType = body.assignee_type ?? body.assigneeType ?? row.assignee_type;
  if (!ROUTING_ASSIGNEE_TYPES.includes(assigneeType)) {
    throw new HttpError(400, `assignee_type must be one of: ${ROUTING_ASSIGNEE_TYPES.join(", ")}`);
  }
  const strategy = body.strategy ?? row.strategy;
  if (!ROUTING_STRATEGIES.includes(strategy)) {
    throw new HttpError(400, `strategy must be one of: ${ROUTING_STRATEGIES.join(", ")}`);
  }
  try {
    run(
      db,
      `UPDATE workflow_routing_rules SET
         code = ?, name = ?, description = ?, definition_id = ?, node_type = ?, priority = ?,
         condition_json = ?, strategy = ?, assignee_type = ?, assignee_id = ?, assignee_ref = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.code ?? row.code,
        String(body.name ?? row.name).trim(),
        body.description ?? row.description,
        body.definition_id === undefined && body.definitionId === undefined ? row.definition_id : body.definition_id ?? body.definitionId,
        body.node_type === undefined && body.nodeType === undefined ? row.node_type : body.node_type ?? body.nodeType,
        body.priority === undefined ? row.priority : Number(body.priority) || 100,
        body.condition === undefined && body.condition_json === undefined ? row.condition_json : JSON.stringify(body.condition ?? safeParse(body.condition_json, {})),
        strategy,
        assigneeType,
        body.assignee_id === undefined && body.assigneeId === undefined ? row.assignee_id : body.assignee_id ?? body.assigneeId,
        body.assignee_ref === undefined && body.assigneeRef === undefined ? row.assignee_ref : body.assignee_ref ?? body.assigneeRef,
        body.status ?? row.status,
        nowIso(),
        row.id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Routing rule code already exists in this scope");
    throw err;
  }
  writeAudit(db, { actor, action: "workflow.routing_rule.update", resourceType: "workflow_routing_rule", resourceId: row.id, details: { code: row.code }, ip });
  return publicRoutingRule(getRoutingRuleRow(db, row.id));
}

export function deleteRoutingRule(db, id, actor = null, ip = null, tenantId = null) {
  const row = getRoutingRuleRow(db, id);
  assertMutable(db, row, tenantId, actor, "Routing rule not found");
  run(db, "DELETE FROM workflow_routing_rules WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "workflow.routing_rule.delete", resourceType: "workflow_routing_rule", resourceId: row.id, details: { code: row.code }, ip });
  return { deleted: true, id: row.id };
}

// Resolves concrete users for an assignee reference. Used for approvals and for
// notifying members of a role/group/queue.
export function usersForAssignee(db, { assignee_type, assignee_id, assignee_ref }, tenantId, organizationId = 0) {
  const type = assignee_type || "role";
  const scope = tenantId ? "u.tenant_id = ?" : "u.tenant_id IS NULL";
  const params = tenantId ? [Number(tenantId)] : [];
  if (type === "user") {
    const id = Number(assignee_id);
    const user = id
      ? queryOne(db, `SELECT id, username, display_name, organization_id FROM users u WHERE u.id = ? AND ${scope}`, [id, ...params])
      : queryOne(db, `SELECT id, username, display_name, organization_id FROM users u WHERE u.username = ? AND ${scope}`, [String(assignee_ref), ...params]);
    return user ? [user] : [];
  }
  if (type === "organization") {
    const id = Number(assignee_id) || Number(assignee_ref);
    return queryAll(
      db,
      `SELECT id, username, display_name, organization_id FROM users u WHERE u.organization_id = ? AND u.status = 'active' AND ${scope} ORDER BY u.username`,
      [id, ...params]
    );
  }
  if (type === "group") {
    const group = resolveGroup(db, assignee_id, assignee_ref, tenantId);
    if (!group) return [];
    return queryAll(
      db,
      `SELECT DISTINCT u.id, u.username, u.display_name, u.organization_id
         FROM group_members gm JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = ? AND u.status = 'active' AND ${scope}
        ORDER BY u.username`,
      [group.id, ...params]
    );
  }
  if (type === "queue") {
    const queue = String(assignee_ref ?? assignee_id ?? "");
    if (!queue) return [];
    // A queue is modelled as a role whose code matches the queue name, so the
    // same membership semantics apply without a separate table.
    return usersForRole(db, queue, tenantId, organizationId);
  }
  return usersForRole(db, assignee_id ?? assignee_ref, tenantId, organizationId);
}

function resolveGroup(db, id, ref, tenantId) {
  if (id) {
    const group = queryOne(db, "SELECT * FROM groups WHERE id = ?", [Number(id)]);
    if (group) return group;
  }
  if (ref) {
    const scope = tenantId ? "(tenant_id IS NULL OR tenant_id = ?)" : "tenant_id IS NULL";
    const params = tenantId ? [Number(tenantId)] : [];
    return queryOne(db, `SELECT * FROM groups WHERE code = ? AND ${scope} ORDER BY tenant_id IS NULL LIMIT 1`, [String(ref), ...params]);
  }
  return null;
}

export function usersForRole(db, roleRef, tenantId, organizationId = 0) {
  if (!roleRef && roleRef !== 0) return [];
  return queryAll(
    db,
    `SELECT DISTINCT u.id, u.username, u.display_name, u.organization_id
       FROM users u
      WHERE u.status = 'active' AND u.tenant_id = ?
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
      Number(tenantId),
      Number(roleRef) || 0,
      String(roleRef ?? ""),
      Number(organizationId) || 0,
      Number(roleRef) || 0,
      String(roleRef ?? ""),
      Number(organizationId) || 0,
    ]
  );
}

// Resolves the assignee for a node. Explicit configuration wins, then routing
// rules by priority, then the fallback.
export function resolveAssignee(db, { definitionId, nodeType, nodeConfig = {}, context = {}, tenantId, organizationId = 0, nodeKey = "" } = {}) {
  const config = nodeConfig || {};
  if (config.assignee_type && config.assignee_type !== "unassigned") {
    return {
      assignee_type: config.assignee_type,
      assignee_id: config.assignee_id ?? null,
      assignee_ref: config.assignee_ref ?? "",
      source: "node",
    };
  }
  const rules = queryAll(
    db,
    `SELECT * FROM workflow_routing_rules
      WHERE status = 'active'
        AND (definition_id IS NULL OR definition_id = ?)
        AND (node_type = '' OR node_type = ?)
        AND (tenant_id IS NULL OR tenant_id = ?)
      ORDER BY priority, id`,
    [definitionId ?? -1, nodeType ?? "", Number(tenantId ?? 0)]
  );
  for (const rule of rules) {
    const condition = safeParse(rule.condition_json, {});
    if (evaluateCondition(condition, { ...context, node_key: nodeKey, node_type: nodeType })) {
      return {
        assignee_type: rule.assignee_type,
        assignee_id: rule.assignee_id ?? null,
        assignee_ref: rule.assignee_ref || "",
        source: "rule",
        rule_id: rule.id,
        strategy: rule.strategy,
      };
    }
  }
  if (config.fallback_assignee_type) {
    return {
      assignee_type: config.fallback_assignee_type,
      assignee_id: config.fallback_assignee_id ?? null,
      assignee_ref: config.fallback_assignee_ref ?? "",
      source: "fallback",
    };
  }
  return { assignee_type: "unassigned", assignee_id: null, assignee_ref: "", source: "default" };
}

export function readRoutingTenant(db, actor, query, reqTenantId) {
  return readTenant(db, actor, query, reqTenantId);
}

export { assertReadable };
