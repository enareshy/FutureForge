import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, validateCode, requireFields, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { readTenant, writeTenant, tenantClause, assertReadable, assertMutable } from "../metadata/scope.js";
import {
  CHANNELS,
  assertChannel,
  sanitizeHtml,
  assertTemplateInput,
  validateTemplateVariables,
  renderTemplate,
  safeParse,
} from "./validation.js";
import { deliverDirect } from "./delivery.js";

// Template management. Global templates (tenant_id NULL) are readable by every
// tenant; a tenant can override a global template by creating the same
// code/channel/locale inside its own scope. Every write stores an immutable
// version snapshot so administrators can review history.

export function publicTemplate(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    event_type: row.event_type || "",
    channel: row.channel,
    subject: row.subject || "",
    html_body: row.html_body || "",
    text_body: row.text_body || "",
    variables: safeParse(row.variables_json, []),
    locale: row.locale || "en",
    version: row.version,
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    is_system: row.is_system === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getTemplateRow(db, id) {
  return queryOne(db, "SELECT * FROM notification_templates WHERE id = ?", [Number(id)]);
}

// Resolves a template by id or code, preferring a tenant override over the
// global row for the requested channel/locale.
export function findTemplate(db, { id, code, channel, locale }, tenantId = null) {
  if (id) {
    const row = getTemplateRow(db, id);
    if (!row) throw new HttpError(404, "Notification template not found");
    assertReadable(row, tenantId, "Notification template not found");
    return row;
  }
  if (!code) return null;
  const params = [String(code)];
  const where = ["t.code = ?"];
  if (channel) {
    where.push("t.channel = ?");
    params.push(String(channel));
  }
  if (locale) {
    where.push("t.locale = ?");
    params.push(String(locale));
  }
  const scope = tenantClause("t", tenantId);
  where.push(scope.sql);
  params.push(...scope.params);
  const row = queryOne(
    db,
    `SELECT t.* FROM notification_templates t WHERE ${where.join(" AND ")}
      ORDER BY (t.tenant_id = ?) DESC, t.version DESC LIMIT 1`,
    [...params, tenantId ? Number(tenantId) : -1]
  );
  return row || null;
}

export function listTemplates(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const scope = tenantClause("t", tenantId);
  const where = [scope.sql];
  const params = [...scope.params];
  if (query.channel) {
    where.push("t.channel = ?");
    params.push(query.channel);
  }
  if (query.status) {
    where.push("t.status = ?");
    params.push(query.status);
  }
  if (query.eventType || query.event_type) {
    where.push("t.event_type = ?");
    params.push(query.eventType || query.event_type);
  }
  if (query.locale) {
    where.push("t.locale = ?");
    params.push(query.locale);
  }
  if (query.q) {
    where.push("(t.code LIKE ? OR t.name LIKE ? OR t.subject LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like);
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM notification_templates t ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT t.* FROM notification_templates t ${clause} ORDER BY t.name, t.channel LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicTemplate);
  return { items, total, page, pageSize };
}

function assertTemplateFields(body, existing = null) {
  const channel = body.channel ?? existing?.channel ?? "in_app";
  assertChannel(channel);
  const html = body.html_body ?? body.htmlBody ?? existing?.html_body ?? "";
  const text = body.text_body ?? body.textBody ?? existing?.text_body ?? "";
  const subject = body.subject ?? existing?.subject ?? "";
  assertTemplateInput({ subject, html_body: html, text_body: text });
  const variables = validateTemplateVariables(subject, html, text);
  return { channel, html, text, subject, variables };
}

export function createTemplate(db, body = {}, actor = null, ip = null, reqTenantId = null) {
  requireFields(body, ["code", "name"]);
  validateCode(body.code, "Template code");
  const tenantId = writeTenant(db, actor, body, reqTenantId);
  const { channel, html, text, subject, variables } = assertTemplateFields(body);
  const locale = body.locale || "en";
  const ts = nowIso();
  let result;
  try {
    result = run(
      db,
      `INSERT INTO notification_templates
        (code, name, description, event_type, channel, subject, html_body, text_body, variables_json,
         locale, version, status, tenant_id, is_system, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?, ?)`,
      [
        body.code,
        String(body.name).trim(),
        body.description || "",
        body.event_type || body.eventType || "",
        channel,
        subject,
        sanitizeHtml(html),
        text,
        JSON.stringify(variables),
        locale,
        body.status || "active",
        tenantId ?? null,
        actor?.id ?? null,
        ts,
        ts,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "A template with this code, channel and locale already exists in this scope");
    }
    throw err;
  }
  const row = getTemplateRow(db, result.lastInsertRowid);
  snapshotVersion(db, row, actor?.id ?? null, ts);
  writeAudit(db, {
    actor,
    action: "notification.template.create",
    resourceType: "notification_template",
    resourceId: row.id,
    details: { code: row.code, channel: row.channel, version: row.version },
    ip,
  });
  return publicTemplate(row);
}

function snapshotVersion(db, row, changedBy, ts) {
  run(
    db,
    `INSERT INTO notification_template_versions
      (template_id, version, subject, html_body, text_body, variables_json, changed_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.version, row.subject || "", row.html_body || "", row.text_body || "", row.variables_json || "[]", changedBy ?? null, ts]
  );
}

export function updateTemplate(db, id, body = {}, actor = null, ip = null, tenantId = null) {
  const row = getTemplateRow(db, id);
  assertMutable(db, row, tenantId, actor, "Notification template not found");
  if (body.code && body.code !== row.code) validateCode(body.code, "Template code");
  const { channel, html, text, subject, variables } = assertTemplateFields(body, row);
  const nextVersion = Number(row.version) + 1;
  const ts = nowIso();
  try {
    run(
      db,
      `UPDATE notification_templates SET
         code = ?, name = ?, description = ?, event_type = ?, channel = ?, subject = ?,
         html_body = ?, text_body = ?, variables_json = ?, locale = ?, version = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [
        body.code ?? row.code,
        String(body.name ?? row.name).trim(),
        body.description ?? row.description,
        body.event_type ?? body.eventType ?? row.event_type,
        channel,
        subject,
        sanitizeHtml(html),
        text,
        JSON.stringify(variables),
        body.locale ?? row.locale,
        nextVersion,
        body.status ?? row.status,
        ts,
        row.id,
      ]
    );
  } catch (err) {
    if (String(err.message).includes("UNIQUE")) {
      throw new HttpError(409, "A template with this code, channel and locale already exists in this scope");
    }
    throw err;
  }
  const updated = getTemplateRow(db, row.id);
  snapshotVersion(db, updated, actor?.id ?? null, ts);
  writeAudit(db, {
    actor,
    action: "notification.template.update",
    resourceType: "notification_template",
    resourceId: row.id,
    details: { code: updated.code, version: updated.version },
    ip,
  });
  return publicTemplate(updated);
}

export function setTemplateStatus(db, id, status, actor = null, ip = null, tenantId = null) {
  const row = getTemplateRow(db, id);
  assertMutable(db, row, tenantId, actor, "Notification template not found");
  if (!["active", "inactive"].includes(status)) throw new HttpError(400, "status must be active or inactive");
  run(db, "UPDATE notification_templates SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), row.id]);
  writeAudit(db, { actor, action: "notification.template.status", resourceType: "notification_template", resourceId: row.id, details: { status }, ip });
  return publicTemplate(getTemplateRow(db, row.id));
}

export function deleteTemplate(db, id, actor = null, ip = null, tenantId = null) {
  const row = getTemplateRow(db, id);
  assertMutable(db, row, tenantId, actor, "Notification template not found");
  if (row.is_system === 1) throw new HttpError(400, "System templates cannot be deleted; deactivate them instead");
  run(db, "DELETE FROM notification_templates WHERE id = ?", [row.id]);
  writeAudit(db, { actor, action: "notification.template.delete", resourceType: "notification_template", resourceId: row.id, details: { code: row.code }, ip });
  return { deleted: true, id: row.id };
}

export function listTemplateVersions(db, id, tenantId = null) {
  const row = getTemplateRow(db, id);
  assertReadable(row, tenantId, "Notification template not found");
  return queryAll(
    db,
    `SELECT v.*, u.username AS changed_by_username
       FROM notification_template_versions v
       LEFT JOIN users u ON u.id = v.changed_by
      WHERE v.template_id = ? ORDER BY v.version DESC`,
    [row.id]
  ).map((version) => ({
    id: version.id,
    version: version.version,
    subject: version.subject,
    html_body: version.html_body,
    text_body: version.text_body,
    variables: safeParse(version.variables_json, []),
    changed_by: version.changed_by,
    changed_by_username: version.changed_by_username || "",
    created_at: version.created_at,
  }));
}

// Sample context used by preview and variable reference panels.
export function sampleContext(overrides = {}) {
  return {
    recipient: { id: 1, name: "Priya Raman", username: "p.raman", email: "p.raman@example.com" },
    initiator: { id: 2, name: "Alex Chen", username: "a.chen" },
    actor: { id: 2, name: "Alex Chen", username: "a.chen" },
    object: { type: "part", id: "PART-000123", name: "Hydraulic bracket", status: "in_review" },
    workflow: { id: 42, name: "Engineering change review" },
    task: { id: 7, name: "Approve bracket revision", code: "TASK-7", due_date: "2026-09-20" },
    approval: { id: 11, status: "pending" },
    event: { type: "task.assigned", source_module: "workflow" },
    tenant: { id: 1, name: "Helix" },
    organization: { id: 1, name: "Helix" },
    dueDate: "2026-09-20",
    reason: "Change rejected by quality",
    applicationUrl: "https://helix.example.com",
    priority: "high",
    link: "/objects/1",
    payload: {},
    data: {},
    ...overrides,
  };
}

// Renders a template against a context. `html` output is escaped/sanitized.
export function renderTemplateRow(row, context = {}, { sanitize = false } = {}) {
  const subject = renderTemplate(row.subject || "", context, { html: false });
  const text = renderTemplate(row.text_body || row.html_body || "", context, { html: false });
  let html = renderTemplate(row.html_body || "", context, { html: false });
  if (sanitize) html = sanitizeHtml(html);
  else html = sanitizeHtml(html);
  return { subject, html, text };
}

export function previewTemplate(db, id, context = {}, tenantId = null) {
  const row = getTemplateRow(db, id);
  assertReadable(row, tenantId, "Notification template not found");
  const merged = sampleContext(context && typeof context === "object" ? context : {});
  const rendered = renderTemplateRow(row, merged, { sanitize: true });
  return { template: publicTemplate(row), context: merged, rendered };
}

// Sends a real notification for a template to a chosen recipient so
// administrators can validate rendering end to end. The delivery goes through
// the normal queue but bypasses rule matching.
export function testSendTemplate(db, id, body = {}, actor = null, ip = null, tenantId = null) {
  const row = getTemplateRow(db, id);
  assertReadable(row, tenantId, "Notification template not found");
  const ref = body.recipient_id ?? body.user_id ?? body.recipient ?? actor?.id;
  if (ref === undefined || ref === null || ref === "") throw new HttpError(400, "A test recipient is required");
  const user = queryOne(
    db,
    `SELECT id, username, email, tenant_id FROM users
      WHERE id = ? OR username = ? OR email = ? ORDER BY (id = ?) DESC LIMIT 1`,
    [Number(ref) || 0, String(ref), String(ref), Number(ref) || 0]
  );
  if (!user) throw new HttpError(400, "Test recipient not found");
  const merged = sampleContext(body.context && typeof body.context === "object" ? body.context : {});
  const rendered = renderTemplateRow(row, merged, { sanitize: true });
  const notificationId = deliverDirect(db, {
    user,
    tenantId: user.tenant_id ?? tenantId,
    channel: row.channel,
    subject: rendered.subject || row.name,
    body: rendered.html || rendered.text,
    templateId: row.id,
    templateCode: row.code,
    priority: "low",
    objectType: "notification_template",
    objectId: String(row.id),
    objectName: row.name,
    idempotencyKey: `template-test:${row.id}:${user.id}:${Date.now()}`,
  });
  writeAudit(db, { actor, action: "notification.template.test", resourceType: "notification_template", resourceId: row.id, details: { recipient_id: user.id, channel: row.channel }, ip });
  return {
    notification_id: notificationId,
    recipient: { id: user.id, username: user.username, email: user.email },
    rendered,
  };
}

export function findTemplateForEvent(db, rule, event, tenantId) {
  if (rule.template_id) {
    const row = getTemplateRow(db, rule.template_id);
    if (row) return row;
  }
  const channel = (safeParse(rule.channels_json, ["in_app"])[0]) || "in_app";
  if (rule.template_code) {
    return findTemplate(db, { code: rule.template_code, channel }, tenantId);
  }
  return null;
}

export { CHANNELS };
