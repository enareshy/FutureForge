import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, requireFields, validateCode, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { readTenant, writeTenant, tenantClause, assertReadable, assertMutable } from "../metadata/scope.js";
import { NOTIFICATION_CHANNELS, NOTIFICATION_STATUSES, safeParse } from "./validation.js";
import { usersForAssignee } from "./routing.js";

// Notification service. Templates are configuration; every dispatch writes a
// row so tenants have a durable, auditable record of what was sent. The default
// transport is store-only which keeps the platform free of external deps.

export function publicTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    channel: row.channel,
    subject: row.subject || "",
    body: row.body || "",
    locale: row.locale || "en",
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    is_system: row.is_system === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicNotification(row) {
  if (!row) return null;
  return {
    id: row.id,
    instance_id: row.instance_id ?? null,
    task_id: row.task_id ?? null,
    template_code: row.template_code || "",
    channel: row.channel,
    recipient_type: row.recipient_type,
    recipient_id: row.recipient_id ?? null,
    recipient_ref: row.recipient_ref || "",
    recipient_username: row.recipient_username ?? null,
    subject: row.subject || "",
    body: row.body || "",
    status: row.status,
    payload: safeParse(row.payload_json, {}),
    sent_at: row.sent_at || null,
    read_at: row.read_at || null,
    tenant_id: row.tenant_id,
    created_at: row.created_at,
  };
}

export function getTemplateRow(db, id) {
  return queryOne(db, "SELECT * FROM workflow_notification_templates WHERE id = ?", [Number(id)]);
}

export function findTemplate(db, idOrCode, tenantId) {
  if (!idOrCode) return null;
  const text = String(idOrCode);
  if (/^\d+$/.test(text)) {
    const byId = getTemplateRow(db, Number(text));
    if (byId) {
      assertReadable(byId, tenantId, "Notification template not found");
      return byId;
    }
  }
  const scope = tenantClause("t", tenantId);
  const byCode = queryOne(db, `SELECT t.* FROM workflow_notification_templates t WHERE t.code = ? AND ${scope.sql} ORDER BY t.tenant_id IS NULL LIMIT 1`, [
    text,
    ...scope.params,
  ]);
  if (!byCode) throw new HttpError(404, "Notification template not found");
  return byCode;
}

export function listTemplates(db, query = {}, tenantId) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause("t", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.channel) {
    where.push("t.channel = ?");
    params.push(query.channel);
  }
  if (query.q) {
    where.push("(t.code LIKE ? OR t.name LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM workflow_notification_templates t ${clause}`, params).c;
  const items = queryAll(db, `SELECT t.* FROM workflow_notification_templates t ${clause} ORDER BY t.name LIMIT ? OFFSET ?`, [
    ...params,
    pageSize,
    offset,
  ]).map(publicTemplate);
  return { items, total, page, pageSize };
}

export function createTemplate(db, body, actor = null, ip = null, reqTenantId = null) {
  requireFields(body, ["code", "name"]);
  validateCode(body.code, "Notification template code");
  const tenantId = writeTenant(db, actor, body, reqTenantId);
  const channel = body.channel || "in_app";
  if (!NOTIFICATION_CHANNELS.includes(channel)) {
    throw new HttpError(400, `channel must be one of: ${NOTIFICATION_CHANNELS.join(", ")}`);
  }
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO workflow_notification_templates
        (code, name, description, channel, subject, body, locale, status, tenant_id, is_system, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.description || "",
        channel,
        body.subject || "",
        body.body || "",
        body.locale || "en",
        body.status || "active",
        tenantId ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Notification template code already exists in this scope");
    throw err;
  }
  writeAudit(db, { actor, action: "workflow.notification_template.create", resourceType: "workflow_notification_template", resourceId: result.lastInsertRowid, details: { code: body.code }, ip });
  return publicTemplate(getTemplateRow(db, result.lastInsertRowid));
}

export function updateTemplate(db, id, body, actor = null, ip = null, tenantId = null) {
  const row = getTemplateRow(db, id);
  assertMutable(db, row, tenantId, actor, "Notification template not found");
  if (body.code && body.code !== row.code) validateCode(body.code, "Notification template code");
  const channel = body.channel ?? row.channel;
  if (!NOTIFICATION_CHANNELS.includes(channel)) {
    throw new HttpError(400, `channel must be one of: ${NOTIFICATION_CHANNELS.join(", ")}`);
  }
  try {
    run(
      db,
      `UPDATE workflow_notification_templates SET
         code = ?, name = ?, description = ?, channel = ?, subject = ?, body = ?, locale = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.code ?? row.code,
        String(body.name ?? row.name).trim(),
        body.description ?? row.description,
        channel,
        body.subject ?? row.subject,
        body.body ?? row.body,
        body.locale ?? row.locale,
        body.status ?? row.status,
        nowIso(),
        row.id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) throw new HttpError(409, "Notification template code already exists in this scope");
    throw err;
  }
  writeAudit(db, { actor, action: "workflow.notification_template.update", resourceType: "workflow_notification_template", resourceId: row.id, details: { code: row.code }, ip });
  return publicTemplate(getTemplateRow(db, row.id));
}

export function deleteTemplate(db, id, actor = null, ip = null, tenantId = null) {
  const row = getTemplateRow(db, id);
  assertMutable(db, row, tenantId, actor, "Notification template not found");
  run(db, "DELETE FROM workflow_notification_templates WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "workflow.notification_template.delete", resourceType: "workflow_notification_template", resourceId: row.id, details: { code: row.code }, ip });
  return { deleted: true, id: row.id };
}

// Renders {{token}} placeholders against a flat context.
export function renderTemplate(text, context = {}) {
  if (!text) return "";
  return String(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, path) => {
    const value = path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), context);
    return value === undefined || value === null ? "" : String(value);
  });
}

// Resolves recipient users from a notification target, falling back to the
// assignee pointer on the notification row.
export function resolveRecipients(db, target = {}, tenantId) {
  if (Array.isArray(target.recipients) && target.recipients.length) return target.recipients;
  if (target.recipient_id || target.recipient_ref) {
    return usersForAssignee(
      db,
      { assignee_type: target.recipient_type || "user", assignee_id: target.recipient_id, assignee_ref: target.recipient_ref },
      tenantId,
      target.organization_id || 0
    );
  }
  return [];
}

export function dispatch(db, { instance = null, task = null, template = null, channel, recipientType, recipientId, recipientRef, subject, body, payload = {}, tenantId, actor = null }) {
  if (!tenantId) throw new HttpError(400, "A tenant is required to send a notification");
  const templateCode = template?.code || "";
  const resolvedChannel = channel || template?.channel || "in_app";
  const renderedSubject = renderTemplate(subject ?? template?.subject ?? "", payload);
  const renderedBody = renderTemplate(body ?? template?.body ?? "", payload);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO workflow_notifications
      (instance_id, task_id, template_code, channel, recipient_type, recipient_id, recipient_ref, subject, body, status, payload_json, sent_at, tenant_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent', ?, ?, ?, ?)`,
    [
      instance?.id ?? null,
      task?.id ?? null,
      templateCode,
      resolvedChannel,
      recipientType || "user",
      recipientId ?? null,
      recipientRef || "",
      renderedSubject,
      renderedBody,
      JSON.stringify(payload),
      ts,
      Number(tenantId),
      ts,
    ]
  );
  if (task?.id) {
    run(db, "UPDATE workflow_tasks SET updated_at = ? WHERE id = ?", [ts, task.id]);
  }
  return publicNotification(queryOne(db, "SELECT * FROM workflow_notifications WHERE id = ?", [result.lastInsertRowid]));
}

export function sendToAssignees(db, { instance = null, task = null, template = null, target = {}, recipients = [], payload = {}, subject, body, tenantId }) {
  const list = recipients.length ? recipients : resolveRecipients(db, target, tenantId);
  const created = [];
  for (const recipient of list) {
    if (!recipient?.id) continue;
    created.push(
      dispatch(db, {
        instance,
        task,
        template,
        channel: template?.channel,
        recipientType: "user",
        recipientId: recipient.id,
        recipientRef: recipient.username || "",
        subject,
        body,
        payload: { ...payload, username: recipient.username, display_name: recipient.display_name || recipient.username },
        tenantId,
      })
    );
  }
  return created;
}

const NOTIFICATION_SELECT = `
  SELECT n.*, u.username AS recipient_username
  FROM workflow_notifications n
  LEFT JOIN users u ON u.id = n.recipient_id
`;

export function listNotifications(db, query = {}, tenantId) {
  const { page, pageSize, offset } = pagination(query);
  const where = ["n.tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("n.status = ?");
    params.push(query.status);
  }
  if (query.channel) {
    where.push("n.channel = ?");
    params.push(query.channel);
  }
  if (query.instanceId || query.instance_id) {
    where.push("n.instance_id = ?");
    params.push(Number(query.instanceId || query.instance_id));
  }
  if (query.unread === "true" || query.unread === true) {
    where.push("n.read_at IS NULL");
  }
  if (query.q) {
    where.push("(n.subject LIKE ? OR n.body LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM workflow_notifications n ${clause}`, params).c;
  const items = queryAll(db, `${NOTIFICATION_SELECT} ${clause} ORDER BY n.id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]).map(
    publicNotification
  );
  return { items, total, page, pageSize };
}

export function markNotificationRead(db, id, tenantId, actor = null, ip = null) {
  const row = queryOne(db, "SELECT * FROM workflow_notifications WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)]);
  if (!row) throw new HttpError(404, "Notification not found");
  run(db, "UPDATE workflow_notifications SET status = 'read', read_at = ? WHERE id = ?", [nowIso(), row.id]);
  if (actor) writeAudit(db, { actor, action: "workflow.notification.read", resourceType: "workflow_notification", resourceId: row.id, ip });
  return publicNotification(queryOne(db, "SELECT * FROM workflow_notifications WHERE id = ?", [row.id]));
}

export function readNotificationTenant(db, actor, query, reqTenantId) {
  return readTenant(db, actor, query, reqTenantId);
}

export { NOTIFICATION_STATUSES };
