import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { homeTenantId } from "../tenants.js";
import { matchRules, buildRuleContext } from "./rules.js";
import { findTemplateForEvent, renderTemplateRow } from "./templates.js";
import { resolveRecipients } from "./recipients.js";
import { evaluatePreference } from "./preferences.js";
import { enqueue, processQueue } from "./delivery.js";
import { scheduleReminderForRule } from "./reminders.js";
import { safeParse, normalizeChannels, CHANNELS } from "./validation.js";

// Notification event service. Business modules call `publish(event)` instead of
// implementing their own notification logic. The pipeline is:
//   event row -> matching rules -> recipient resolution -> preference filter ->
//   template rendering -> notification rows -> delivery queue.
// publish() never throws into the calling business transaction: failures are
// logged and swallowed so notifications cannot break the underlying operation.

function logError(event, fields = {}) {
  try {
    console.log(JSON.stringify({ level: "error", scope: "notifications", event, ...fields }));
  } catch {
    /* logging must never throw */
  }
}

export function publicEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    event_type: row.event_type,
    source_module: row.source_module,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    site_id: row.site_id ?? null,
    department_id: row.department_id ?? null,
    object_type: row.object_type || "",
    object_id: row.object_id || "",
    object_name: row.object_name || "",
    initiator_id: row.initiator_id ?? null,
    initiator_username: row.initiator_username || "",
    payload: safeParse(row.payload_json, {}),
    related: safeParse(row.related_json, {}),
    correlation_id: row.correlation_id || "",
    status: row.status,
    rule_count: row.rule_count,
    notification_count: row.notification_count,
    error_message: row.error_message || "",
    occurred_at: row.occurred_at,
    created_at: row.created_at,
  };
}

function normalizeEventInput(db, event = {}, actor = null) {
  const initiator = event.initiator || {};
  const tenantId =
    event.tenant_id ?? event.tenantId ?? actor?.tenant_id ?? homeTenantId(db, actor) ?? null;
  return {
    event_type: event.event_type || event.eventType,
    source_module: event.source_module || event.sourceModule || "platform",
    tenant_id: tenantId ? Number(tenantId) : null,
    organization_id: event.organization_id ?? event.organizationId ?? actor?.organization_id ?? null,
    plant_id: event.plant_id ?? event.plantId ?? null,
    site_id: event.site_id ?? event.siteId ?? null,
    department_id: event.department_id ?? event.departmentId ?? null,
    object_type: event.object_type ?? event.objectType ?? "",
    object_id: event.object_id ?? event.objectId ?? "",
    object_name: event.object_name ?? event.objectName ?? "",
    initiator_id: actor?.id ?? initiator.id ?? null,
    initiator_username: actor?.username ?? initiator.username ?? "",
    payload: event.payload ?? event.data ?? {},
    related: event.related ?? {},
    correlation_id: event.correlation_id ?? event.correlationId ?? "",
    idempotency_key: event.idempotency_key ?? event.idempotencyKey ?? null,
    occurred_at: event.occurred_at ?? event.occurredAt ?? null,
  };
}

// Publishes a domain event and fans it out to matching rules. Returns a summary
// including the created event and the notifications that were queued.
export function publish(db, event = {}, { actor = null, ip = null } = {}) {
  const summary = { published: false, event_id: null, notifications: [], skipped: [] };
  try {
    const input = normalizeEventInput(db, event, actor);
    if (!input.event_type) throw new HttpError(400, "event_type is required");
    if (!input.tenant_id) {
      logError("publish.missing_tenant", { event_type: input.event_type });
      summary.reason = "missing_tenant";
      return summary;
    }

    if (input.idempotency_key) {
      const existing = queryOne(db, "SELECT * FROM notification_events WHERE idempotency_key = ?", [input.idempotency_key]);
      if (existing) {
        summary.published = false;
        summary.event_id = existing.id;
        summary.reason = "duplicate";
        return summary;
      }
    }

    const ts = nowIso();
    const insert = run(
      db,
      `INSERT INTO notification_events
        (event_type, source_module, tenant_id, organization_id, plant_id, site_id, department_id,
         object_type, object_id, object_name, initiator_id, initiator_username, payload_json, related_json,
         correlation_id, idempotency_key, status, occurred_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
      [
        input.event_type,
        input.source_module,
        input.tenant_id,
        input.organization_id ?? null,
        input.plant_id ?? null,
        input.site_id ?? null,
        input.department_id ?? null,
        input.object_type,
        input.object_id,
        input.object_name,
        input.initiator_id ?? null,
        input.initiator_username,
        JSON.stringify(input.payload || {}),
        JSON.stringify(input.related || {}),
        input.correlation_id,
        input.idempotency_key,
        input.occurred_at || ts,
        ts,
      ]
    );
    const eventId = insert.lastInsertRowid;
    summary.published = true;
    summary.event_id = eventId;
    const eventRow = queryOne(db, "SELECT * FROM notification_events WHERE id = ?", [eventId]);

    const rules = matchRules(db, eventRow, input.tenant_id);
    let queued = 0;
    for (const rule of rules) {
      queued += applyRule(db, rule, eventRow, input.tenant_id, { ip, summary });
    }

    run(
      db,
      "UPDATE notification_events SET status = ?, rule_count = ?, notification_count = ? WHERE id = ?",
      [rules.length ? "processed" : "skipped", rules.length, queued, eventId]
    );
    summary.event = publicEvent(queryOne(db, "SELECT * FROM notification_events WHERE id = ?", [eventId]));

    if (queued) processQueue(db, { limit: 100 });
    return summary;
  } catch (err) {
    logError("publish.failed", { event_type: event?.event_type || event?.eventType, message: err.message });
    summary.reason = err.message;
    return summary;
  }
}

function applyRule(db, rule, eventRow, tenantId, { ip, summary }) {
  const context = buildRuleContext(eventRow);
  const template = findTemplateForEvent(db, rule, eventRow, tenantId);
  const channels = normalizeChannels(safeParse(rule.channels_json, ["in_app"]));
  const channelsToUse = template && CHANNELS.includes(template.channel) && !channels.includes(template.channel)
    ? [...channels, template.channel]
    : channels;
  const recipients = resolveRecipients(
    db,
    safeParse(rule.recipient_json, {}),
    { ...context, ip },
    tenantId
  );
  let created = 0;
  for (const recipient of recipients) {
    for (const channel of channelsToUse) {
      const decision = evaluatePreference(db, recipient, channel, eventRow.event_type, tenantId, {
        mandatory: rule.mandatory === 1,
        now: new Date(),
      });
      if (!decision.allowed) {
        summary.skipped.push({ recipient_id: recipient.id, channel, reason: decision.reason });
        continue;
      }
      const rendered = template
        ? renderTemplateRow(template, { ...context, recipient, applicationUrl: context.applicationUrl || "" })
        : { subject: eventRow.event_type, html: "", text: "" };
      const notificationId = insertNotification(db, {
        event: eventRow,
        rule,
        template,
        recipient,
        channel,
        rendered,
        context,
      });
      if (!notificationId) continue;
      created += 1;
      summary.notifications.push(notificationId);
      enqueue(db, { id: notificationId, channel, tenant_id: tenantId }, { delaySeconds: Number(rule.delay_minutes || 0) * 60 });
      if (rule.reminder_json && safeParse(rule.reminder_json, {}).enabled) {
        scheduleReminderForRule(db, { rule, event: eventRow, notificationId, recipient, tenantId });
      }
    }
  }
  return created;
}

function insertNotification(db, { event, rule, template, recipient, channel, rendered, context }) {
  const idempotencyKey = `${event.id}:${rule.id}:${recipient.id}:${channel}`;
  const existing = queryOne(db, "SELECT id FROM notifications WHERE idempotency_key = ?", [idempotencyKey]);
  if (existing) return null;
  const ts = nowIso();
  const payload = safeParse(event.payload_json, {});
  const deepLink = payload.deepLink || payload.deep_link || payload.link || context.link || "";
  const actions = Array.isArray(payload.actions) ? payload.actions : [];
  const result = run(
    db,
    `INSERT INTO notifications
      (event_id, rule_id, tenant_id, organization_id, recipient_id, recipient_address, channel,
       template_id, template_code, subject, body, content_ref, status, priority, correlation_id,
       object_type, object_id, object_name, deep_link, action_links_json, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      rule.id,
      event.tenant_id,
      event.organization_id ?? null,
      recipient.id,
      recipient.email || "",
      channel,
      template?.id ?? null,
      template?.code || "",
      rendered.subject || "",
      rendered.html || rendered.text || "",
      rule.priority || "normal",
      event.correlation_id || "",
      event.object_type || "",
      event.object_id || "",
      event.object_name || "",
      deepLink,
      JSON.stringify(actions),
      idempotencyKey,
      ts,
      ts,
    ]
  );
  return result.lastInsertRowid;
}

// ---------------------------------------------------------------------------
// Direct helpers used by integrations that do not go through a configured rule.
// ---------------------------------------------------------------------------

export function notifyUser(db, userId, data = {}, { actor = null, tenantId = null, ip = null } = {}) {
  const user = queryOne(
    db,
    "SELECT id, username, display_name, email, organization_id, tenant_id FROM users WHERE id = ?",
    [Number(userId)]
  );
  if (!user) return { notified: false, reason: "user_not_found" };
  const resolvedTenant = tenantId ?? user.tenant_id ?? homeTenantId(db, actor);
  const event = {
    event_type: data.event_type || data.eventType || "notification.direct",
    source_module: data.source_module || data.sourceModule || "platform",
    tenant_id: resolvedTenant,
    object_type: data.object_type || data.objectType || "",
    object_id: data.object_id || data.objectId || "",
    object_name: data.object_name || data.objectName || "",
    payload: data.payload || {},
    related: data.related || {},
    correlation_id: data.correlation_id || data.correlationId || "",
    initiator: { id: actor?.id, username: actor?.username },
  };
  return publish(db, event, { actor, ip });
}

export function notifyGroup(db, groupId, data = {}, options = {}) {
  return publish(
    db,
    {
      event_type: data.event_type || data.eventType || "notification.group",
      source_module: data.source_module || "platform",
      tenant_id: data.tenant_id || data.tenantId || options.tenantId,
      payload: data.payload || {},
      related: { ...(data.related || {}), group: { id: groupId } },
      correlation_id: data.correlation_id || "",
    },
    { actor: options.actor || null, ip: options.ip || null }
  );
}

export function notifyRole(db, roleId, data = {}, options = {}) {
  return publish(
    db,
    {
      event_type: data.event_type || data.eventType || "notification.role",
      source_module: data.source_module || "platform",
      tenant_id: data.tenant_id || data.tenantId || options.tenantId,
      payload: data.payload || {},
      related: { ...(data.related || {}), role: { id: roleId } },
      correlation_id: data.correlation_id || "",
    },
    { actor: options.actor || null, ip: options.ip || null }
  );
}

export function listEvents(db, query = {}, tenantId = null) {
  const where = [];
  const params = [];
  if (tenantId) {
    where.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (query.eventType || query.event_type) {
    where.push("event_type = ?");
    params.push(query.eventType || query.event_type);
  }
  if (query.sourceModule || query.source_module) {
    where.push("source_module = ?");
    params.push(query.sourceModule || query.source_module);
  }
  if (query.status) {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.q) {
    where.push("(object_name LIKE ? OR event_type LIKE ? OR initiator_username LIKE ? OR payload_json LIKE ?)");
    const like = `%${query.q}%`;
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize, 10) || 25));
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM notification_events ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT * FROM notification_events ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]
  ).map(publicEvent);
  return { items, total, page, pageSize };
}

export function getEvent(db, id, tenantId = null) {
  const row = queryOne(db, "SELECT * FROM notification_events WHERE id = ?", [Number(id)]);
  if (!row) throw new HttpError(404, "Notification event not found");
  if (tenantId && Number(row.tenant_id) !== Number(tenantId)) throw new HttpError(404, "Notification event not found");
  const event = publicEvent(row);
  event.notifications = queryAll(
    db,
    `SELECT n.id, n.recipient_id, u.username AS recipient_username, n.channel, n.status, n.subject, n.created_at
       FROM notifications n LEFT JOIN users u ON u.id = n.recipient_id WHERE n.event_id = ? ORDER BY n.id`,
    [row.id]
  );
  return event;
}

// Re-publishes an event to a specific set of users (used by template test-send
// and by the "simulate rule" admin action).
export function simulateRule(db, ruleId, event, { actor = null, ip = null } = {}) {
  const rule = queryOne(db, "SELECT * FROM notification_rules WHERE id = ?", [Number(ruleId)]);
  if (!rule) throw new HttpError(404, "Notification rule not found");
  const input = normalizeEventInput(db, event, actor);
  if (!input.event_type) input.event_type = rule.event_type === "*" ? "notification.test" : rule.event_type;
  if (!input.tenant_id) input.tenant_id = actor?.tenant_id ?? homeTenantId(db, actor) ?? null;
  const ts = nowIso();
  const insert = run(
    db,
    `INSERT INTO notification_events
      (event_type, source_module, tenant_id, organization_id, object_type, object_id, object_name,
       initiator_id, initiator_username, payload_json, related_json, correlation_id, status, occurred_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
    [
      input.event_type,
      input.source_module,
      input.tenant_id,
      input.organization_id ?? null,
      input.object_type,
      input.object_id,
      input.object_name,
      input.initiator_id ?? null,
      input.initiator_username,
      JSON.stringify(input.payload || {}),
      JSON.stringify(input.related || {}),
      input.correlation_id,
      ts,
      ts,
    ]
  );
  const eventRow = queryOne(db, "SELECT * FROM notification_events WHERE id = ?", [insert.lastInsertRowid]);
  const summary = { notifications: [], skipped: [] };
  const created = applyRule(db, rule, eventRow, eventRow.tenant_id, { ip, summary });
  run(db, "UPDATE notification_events SET status = 'processed', rule_count = 1, notification_count = ? WHERE id = ?", [created, eventRow.id]);
  processQueue(db, { limit: 100 });
  return { event: publicEvent(eventRow), created, notifications: summary.notifications, skipped: summary.skipped };
}
