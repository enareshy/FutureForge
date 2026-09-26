import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, validateCode, requireFields, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { readTenant, writeTenant, tenantClause, assertReadable, assertMutable } from "../metadata/scope.js";
import {
  assertPriority,
  assertDeliveryMode,
  normalizeChannels,
  normalizeRecipientDefinition,
  evaluateCondition,
  safeParse,
} from "./validation.js";
import { findTemplate } from "./templates.js";

// Notification rules map an event to recipients, a template, channels and
// scheduling. Conditions are evaluated against the event context. Multiple
// rules may match one event; all of them are applied.

export function publicRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    event_type: row.event_type || "",
    source_module: row.source_module || "",
    condition: safeParse(row.condition_json, {}),
    recipient: normalizeRecipientDefinition(safeParse(row.recipient_json, {})),
    template_id: row.template_id ?? null,
    template_code: row.template_code || "",
    channels: safeParse(row.channels_json, ["in_app"]),
    priority: row.priority,
    delivery_mode: row.delivery_mode,
    delay_minutes: row.delay_minutes,
    reminder: safeParse(row.reminder_json, {}),
    escalation: safeParse(row.escalation_json, {}),
    mandatory: row.mandatory === 1,
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    is_system: row.is_system === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getRuleRow(db, id) {
  return queryOne(db, "SELECT * FROM notification_rules WHERE id = ?", [Number(id)]);
}

export function listRules(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause("r", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.status) {
    where.push("r.status = ?");
    params.push(query.status);
  }
  if (query.eventType || query.event_type) {
    where.push("r.event_type = ?");
    params.push(query.eventType || query.event_type);
  }
  if (query.sourceModule || query.source_module) {
    where.push("r.source_module = ?");
    params.push(query.sourceModule || query.source_module);
  }
  if (query.q) {
    where.push("(r.code LIKE ? OR r.name LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM notification_rules r ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT r.* FROM notification_rules r ${clause} ORDER BY r.event_type, r.priority, r.code LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicRule);
  return { items, total, page, pageSize };
}

function validateRulePayload(db, body, existing, tenantId) {
  const eventType = body.event_type ?? body.eventType ?? existing?.event_type ?? "*";
  const priority = body.priority ?? existing?.priority ?? "normal";
  assertPriority(priority);
  const deliveryMode = body.delivery_mode ?? body.deliveryMode ?? existing?.delivery_mode ?? "immediate";
  assertDeliveryMode(deliveryMode);
  const channels = normalizeChannels(
    body.channels ?? safeParse(existing?.channels_json, ["in_app"]),
    ["in_app"]
  );
  const templateCode = body.template_code ?? body.templateCode ?? existing?.template_code ?? "";
  const templateId = body.template_id ?? body.templateId ?? existing?.template_id ?? null;
  if (templateCode) {
    const template = findTemplate(db, { code: templateCode, channel: channels[0] }, tenantId);
    if (!template) throw new HttpError(400, `Template "${templateCode}" was not found for channel ${channels[0]}`);
  }
  return { eventType, priority, deliveryMode, channels, templateCode, templateId };
}

export function createRule(db, body = {}, actor = null, ip = null, reqTenantId = null) {
  requireFields(body, ["code", "name"]);
  validateCode(body.code, "Rule code");
  const tenantId = writeTenant(db, actor, body, reqTenantId);
  const { eventType, priority, deliveryMode, channels, templateCode, templateId } = validateRulePayload(db, body, null, tenantId);
  const recipient = normalizeRecipientDefinition(body.recipient ?? body.recipient_definition ?? { items: [{ type: "initiator" }] });
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO notification_rules
        (code, name, description, event_type, source_module, condition_json, recipient_json,
         template_id, template_code, channels_json, priority, delivery_mode, delay_minutes,
         reminder_json, escalation_json, mandatory, status, tenant_id, organization_id, is_system, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.description || "",
        eventType,
        body.source_module ?? body.sourceModule ?? "",
        JSON.stringify(body.condition ?? safeParse(body.condition_json, {})),
        JSON.stringify(recipient),
        templateId,
        templateCode,
        JSON.stringify(channels),
        priority,
        deliveryMode,
        Number(body.delay_minutes ?? body.delayMinutes ?? 0) || 0,
        JSON.stringify(body.reminder ?? safeParse(body.reminder_json, {})),
        JSON.stringify(body.escalation ?? safeParse(body.escalation_json, {})),
        body.mandatory ? 1 : 0,
        body.status || "active",
        tenantId ?? null,
        body.organization_id ?? body.organizationId ?? null,
        actor?.id ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Rule code already exists in this scope");
    throw err;
  }
  writeAudit(db, { actor, action: "notification.rule.create", resourceType: "notification_rule", resourceId: result.lastInsertRowid, details: { code: body.code, event_type: eventType }, ip });
  return publicRule(getRuleRow(db, result.lastInsertRowid));
}

export function updateRule(db, id, body = {}, actor = null, ip = null, tenantId = null) {
  const row = getRuleRow(db, id);
  assertMutable(db, row, tenantId, actor, "Notification rule not found");
  if (body.code && body.code !== row.code) validateCode(body.code, "Rule code");
  const { eventType, priority, deliveryMode, channels, templateCode, templateId } = validateRulePayload(db, body, row, tenantId);
  const recipient = normalizeRecipientDefinition(
    body.recipient ?? body.recipient_definition ?? safeParse(row.recipient_json, {})
  );
  try {
    run(
      db,
      `UPDATE notification_rules SET
         code = ?, name = ?, description = ?, event_type = ?, source_module = ?, condition_json = ?,
         recipient_json = ?, template_id = ?, template_code = ?, channels_json = ?, priority = ?,
         delivery_mode = ?, delay_minutes = ?, reminder_json = ?, escalation_json = ?, mandatory = ?,
         status = ?, organization_id = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.code ?? row.code,
        String(body.name ?? row.name).trim(),
        body.description ?? row.description,
        eventType,
        body.source_module ?? body.sourceModule ?? row.source_module,
        body.condition === undefined && body.condition_json === undefined
          ? row.condition_json
          : JSON.stringify(body.condition ?? safeParse(body.condition_json, {})),
        JSON.stringify(recipient),
        templateId,
        templateCode,
        JSON.stringify(channels),
        priority,
        deliveryMode,
        body.delay_minutes === undefined && body.delayMinutes === undefined
          ? row.delay_minutes
          : Number(body.delay_minutes ?? body.delayMinutes) || 0,
        body.reminder === undefined && body.reminder_json === undefined ? row.reminder_json : JSON.stringify(body.reminder ?? safeParse(body.reminder_json, {})),
        body.escalation === undefined && body.escalation_json === undefined ? row.escalation_json : JSON.stringify(body.escalation ?? safeParse(body.escalation_json, {})),
        body.mandatory === undefined ? row.mandatory : body.mandatory ? 1 : 0,
        body.status ?? row.status,
        body.organization_id === undefined && body.organizationId === undefined ? row.organization_id : body.organization_id ?? body.organizationId,
        nowIso(),
        row.id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Rule code already exists in this scope");
    throw err;
  }
  writeAudit(db, { actor, action: "notification.rule.update", resourceType: "notification_rule", resourceId: row.id, details: { code: row.code }, ip });
  return publicRule(getRuleRow(db, row.id));
}

export function setRuleStatus(db, id, status, actor = null, ip = null, tenantId = null) {
  const row = getRuleRow(db, id);
  assertMutable(db, row, tenantId, actor, "Notification rule not found");
  if (!["active", "inactive"].includes(status)) throw new HttpError(400, "status must be active or inactive");
  run(db, "UPDATE notification_rules SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), row.id]);
  writeAudit(db, { actor, action: "notification.rule.status", resourceType: "notification_rule", resourceId: row.id, details: { status }, ip });
  return publicRule(getRuleRow(db, row.id));
}

export function deleteRule(db, id, actor = null, ip = null, tenantId = null) {
  const row = getRuleRow(db, id);
  assertMutable(db, row, tenantId, actor, "Notification rule not found");
  if (row.is_system === 1) throw new HttpError(400, "System rules cannot be deleted; deactivate them instead");
  run(db, "DELETE FROM notification_rules WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "notification.rule.delete", resourceType: "notification_rule", resourceId: row.id, details: { code: row.code }, ip });
  return { deleted: true, id: row.id };
}

// Selects the active rules that apply to an event. Matching is by exact event
// type (or the "*" wildcard), source module (empty = any) and condition.
export function matchRules(db, event, tenantId) {
  const rules = queryAll(
    db,
    `SELECT * FROM notification_rules
      WHERE status = 'active'
        AND (tenant_id IS NULL OR tenant_id = ?)
        AND (event_type = ? OR event_type = '*' OR event_type = '')
        AND (source_module = '' OR source_module IS NULL OR source_module = ?)
      ORDER BY (tenant_id IS NOT NULL) DESC, priority DESC, id`,
    [tenantId ? Number(tenantId) : -1, String(event.event_type || ""), String(event.source_module || "")]
  );
  const context = buildRuleContext(event);
  return rules.filter((rule) => evaluateCondition(safeParse(rule.condition_json, {}), context));
}

// Builds the evaluation/render context shared by rules, recipients and
// templates from a stored event row.
export function buildRuleContext(event) {
  const payload = safeParse(event.payload_json, {});
  const related = safeParse(event.related_json, {});
  return {
    event: {
      id: event.id,
      type: event.event_type,
      source_module: event.source_module,
      occurred_at: event.occurred_at,
    },
    payload,
    data: payload,
    object: {
      type: event.object_type || "",
      id: event.object_id || "",
      name: event.object_name || "",
      owner_id: event.object_owner_id ?? payload.owner_id ?? payload.ownerId ?? null,
      created_by: event.object_created_by ?? payload.created_by ?? payload.createdBy ?? null,
      organization_id: event.organization_id ?? null,
      status: payload.status || payload.state || "",
    },
    workflow: related.workflow || payload.workflow || {},
    task: related.task || payload.task || {},
    approval: related.approval || payload.approval || {},
    initiator: { id: event.initiator_id ?? null, username: event.initiator_username || "", name: event.initiator_username || "" },
    actor: { id: event.initiator_id ?? null, username: event.initiator_username || "" },
    organization: { id: event.organization_id ?? null },
    tenant: { id: event.tenant_id ?? null },
    priority: payload.priority || "normal",
    reason: payload.reason || payload.comment || "",
    dueDate: payload.dueDate || payload.due_date || related.task?.due_date || related.workflow?.due_date || "",
    link: payload.link || "",
    applicationUrl: payload.applicationUrl || "",
    responsible_organization_id: payload.responsible_organization_id || null,
  };
}

export { assertReadable };
