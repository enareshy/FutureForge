import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { readTenant, writeTenant, tenantClause, assertReadable, assertMutable } from "../metadata/scope.js";
import { BINDING_EVENTS, safeParse, evaluateCondition } from "./validation.js";
import { startInstance } from "./engine.js";
import { getDefinitionRow, publishedVersionRow } from "./templates.js";

// Workflow bindings connect platform events to workflow templates. When the
// Lifecycle module approves a release, for example, a binding starts the
// matching workflow with the object/release in its context.

export function publicBinding(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    event: row.event,
    definition_id: row.definition_id,
    definition_code: row.definition_code ?? null,
    version_id: row.version_id ?? null,
    condition: safeParse(row.condition_json, {}),
    context_map: safeParse(row.context_map_json, {}),
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

const BINDING_SELECT = `
  SELECT b.*, d.code AS definition_code
  FROM workflow_bindings b
  LEFT JOIN workflow_definitions d ON d.id = b.definition_id
`;

export function getBindingRow(db, id) {
  return queryOne(db, `${BINDING_SELECT} WHERE b.id = ?`, [Number(id)]);
}

export function listBindings(db, query = {}, tenantId) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause("b", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.event) {
    where.push("b.event = ?");
    params.push(query.event);
  }
  if (query.definitionId || query.definition_id) {
    where.push("b.definition_id = ?");
    params.push(Number(query.definitionId || query.definition_id));
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM workflow_bindings b ${clause}`, params).c;
  const items = queryAll(db, `${BINDING_SELECT} ${clause} ORDER BY b.event, b.code LIMIT ? OFFSET ?`, [...params, pageSize, offset]).map(
    publicBinding
  );
  return { items, total, page, pageSize };
}

export function createBinding(db, body, actor = null, ip = null, reqTenantId = null) {
  requireFields(body, ["code", "name", "event", "definition_id"]);
  validateCode(body.code, "Binding code");
  const tenantId = writeTenant(db, actor, body, reqTenantId);
  const definition = getDefinitionRow(db, Number(body.definition_id ?? body.definitionId));
  if (!definition) throw new HttpError(400, "Workflow definition not found");
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO workflow_bindings
        (code, name, description, event, definition_id, version_id, condition_json, context_map_json, status, tenant_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.description || "",
        body.event,
        definition.id,
        body.version_id ?? body.versionId ?? null,
        JSON.stringify(body.condition ?? safeParse(body.condition_json, {})),
        JSON.stringify(body.context_map ?? safeParse(body.context_map_json, {})),
        body.status || "active",
        tenantId ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Binding code already exists in this scope");
    throw err;
  }
  writeAudit(db, { actor, action: "workflow.binding.create", resourceType: "workflow_binding", resourceId: result.lastInsertRowid, details: { code: body.code, event: body.event }, ip });
  return publicBinding(getBindingRow(db, result.lastInsertRowid));
}

export function updateBinding(db, id, body, actor = null, ip = null, tenantId = null) {
  const row = getBindingRow(db, id);
  assertMutable(db, row, tenantId, actor, "Binding not found");
  if (body.code && body.code !== row.code) validateCode(body.code, "Binding code");
  try {
    run(
      db,
      `UPDATE workflow_bindings SET
         code = ?, name = ?, description = ?, event = ?, definition_id = ?, version_id = ?,
         condition_json = ?, context_map_json = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.code ?? row.code,
        String(body.name ?? row.name).trim(),
        body.description ?? row.description,
        body.event ?? row.event,
        body.definition_id === undefined && body.definitionId === undefined ? row.definition_id : Number(body.definition_id ?? body.definitionId),
        body.version_id === undefined && body.versionId === undefined ? row.version_id : body.version_id ?? body.versionId,
        body.condition === undefined && body.condition_json === undefined ? row.condition_json : JSON.stringify(body.condition ?? safeParse(body.condition_json, {})),
        body.context_map === undefined && body.context_map_json === undefined ? row.context_map_json : JSON.stringify(body.context_map ?? safeParse(body.context_map_json, {})),
        body.status ?? row.status,
        nowIso(),
        row.id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Binding code already exists in this scope");
    throw err;
  }
  writeAudit(db, { actor, action: "workflow.binding.update", resourceType: "workflow_binding", resourceId: row.id, details: { code: row.code }, ip });
  return publicBinding(getBindingRow(db, row.id));
}

export function deleteBinding(db, id, actor = null, ip = null, tenantId = null) {
  const row = getBindingRow(db, id);
  assertMutable(db, row, tenantId, actor, "Binding not found");
  run(db, "DELETE FROM workflow_bindings WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "workflow.binding.delete", resourceType: "workflow_binding", resourceId: row.id, details: { code: row.code }, ip });
  return { deleted: true, id: row.id };
}

// Applies a simple `{{path}}` mapping or a key->path map against an event payload.
function mapContext(contextMap, payload) {
  const result = {};
  if (contextMap && typeof contextMap === "object" && Object.keys(contextMap).length) {
    for (const [key, path] of Object.entries(contextMap)) {
      result[key] = path.split(".").reduce((acc, part) => (acc == null ? acc : acc[part]), payload);
    }
    return result;
  }
  return { ...payload };
}

// Emits an event: starts every active binding that matches the event and
// condition. Returns the list of started instances.
export function triggerEvent(db, event, payload = {}, { actor = null, tenantId = null, ip = null } = {}) {
  const effectiveTenant = tenantId ?? payload.tenant_id ?? payload.tenantId ?? null;
  if (!effectiveTenant) return { event, started: [] };
  const bindings = queryAll(
    db,
    `${BINDING_SELECT} WHERE b.event = ? AND b.status = 'active' AND (b.tenant_id IS NULL OR b.tenant_id = ?) ORDER BY b.id`,
    [event, Number(effectiveTenant)]
  );
  const started = [];
  for (const binding of bindings) {
    const condition = safeParse(binding.condition_json, {});
    if (condition && Object.keys(condition).length && !evaluateCondition(condition, payload)) continue;
    const definition = getDefinitionRow(db, binding.definition_id);
    if (!definition) continue;
    const version = binding.version_id ? null : publishedVersionRow(db, definition.id);
    if (!binding.version_id && !version) continue;
    try {
      const instance = startInstance(
        db,
        {
          definition_id: definition.id,
          version_id: binding.version_id ?? version.id,
          title: payload.title || `${definition.name} (${event})`,
          object_id: payload.object_id ?? payload.objectId ?? null,
          organization_id: payload.organization_id ?? payload.organizationId ?? null,
          context: { event, ...mapContext(safeParse(binding.context_map_json, {}), payload) },
          organization: payload.organization_id ?? null,
        },
        actor,
        effectiveTenant,
        ip
      );
      started.push({ binding_id: binding.id, instance_id: instance.id, code: instance.code });
    } catch (err) {
      // A single misconfigured binding must not break the originating action.
      writeAudit(db, {
        actor,
        action: "workflow.binding.trigger_failed",
        resourceType: "workflow_binding",
        resourceId: binding.id,
        details: { event, error: String(err.message) },
        ip,
      });
    }
  }
  return { event, started };
}

export function readBindingTenant(db, actor, query, reqTenantId) {
  return readTenant(db, actor, query, reqTenantId);
}

export { BINDING_EVENTS };
