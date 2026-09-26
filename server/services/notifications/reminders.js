import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { resolveRecipients } from "./recipients.js";
import { buildRuleContext } from "./rules.js";
import { safeParse } from "./validation.js";
import { deliverDirect } from "./delivery.js";

// Reminder and escalation service. Pull-based like the workflow escalation
// sweeper: the scheduler endpoint calls `sweepReminders`, which fires due
// reminders, schedules repeats and escalates to managers/roles when configured.
// Dedupe keys prevent duplicate reminders for the same level.

export function addMinutes(base, minutes) {
  const date = new Date(String(base).replace(" ", "T") + "Z");
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  safeDate.setMinutes(safeDate.getMinutes() + Number(minutes || 0));
  return safeDate.toISOString().replace("T", " ").slice(0, 19);
}

function insertReminder(db, { ruleId, eventId, notificationId, tenantId, recipientId, dueAt, level, dedupeKey, details }) {
  if (dedupeKey) {
    const existing = queryOne(db, "SELECT id FROM notification_reminders WHERE dedupe_key = ?", [dedupeKey]);
    if (existing) return existing.id;
  }
  const result = run(
    db,
    `INSERT INTO notification_reminders
      (rule_id, event_id, notification_id, tenant_id, recipient_id, due_at, level, status, dedupe_key, details_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [
      ruleId ?? null,
      eventId ?? null,
      notificationId ?? null,
      tenantId ?? null,
      recipientId ?? null,
      dueAt,
      level || 0,
      dedupeKey ?? null,
      JSON.stringify(details || {}),
      nowIso(),
    ]
  );
  return result.lastInsertRowid;
}

// Schedules the first reminder for a rule that just produced a notification.
export function scheduleReminderForRule(db, { rule, event, notificationId, recipient, tenantId }) {
  const config = safeParse(rule.reminder_json, {});
  if (!config.enabled) return null;
  const offset = Number(config.offset_minutes ?? config.offsetMinutes ?? 0) || 0;
  const dueAt = addMinutes(nowIso(), offset);
  const details = {
    event_type: event.event_type,
    source_module: event.source_module,
    object_type: event.object_type,
    object_id: event.object_id,
    object_name: event.object_name,
    subject: config.subject || "Reminder",
    repeat_minutes: Number(config.repeat_minutes ?? config.repeatMinutes ?? 0) || 0,
    max_repeats: Number(config.max_repeats ?? config.maxRepeats ?? 0) || 0,
    escalation: config.escalation || safeParse(rule.escalation_json, {}),
    deep_link: config.deep_link || config.deepLink || "",
  };
  return insertReminder(db, {
    ruleId: rule.id,
    eventId: event.id,
    notificationId,
    tenantId,
    recipientId: recipient.id,
    dueAt,
    level: 0,
    dedupeKey: `reminder:${rule.id}:${event.id}:${recipient.id}:0`,
    details,
  });
}

export function scheduleReminder(db, data = {}) {
  const input = data || {};
  const dueAt = input.due_at || input.dueAt || addMinutes(nowIso(), Number(input.delay_minutes ?? input.delayMinutes ?? 0) || 0);
  return insertReminder(db, {
    ruleId: input.rule_id ?? input.ruleId ?? null,
    eventId: input.event_id ?? input.eventId ?? null,
    notificationId: input.notification_id ?? input.notificationId ?? null,
    tenantId: input.tenant_id ?? input.tenantId ?? null,
    recipientId: input.recipient_id ?? input.recipientId ?? null,
    dueAt,
    level: Number(input.level ?? 0) || 0,
    dedupeKey: input.dedupe_key ?? input.dedupeKey ?? null,
    details: input.details || {},
  });
}

function publishReminderEvent(db, reminderRow, details) {
  // Direct notification so a reminder is not gated behind rules again. Uses the
  // reminder's recipient and the originating object context.
  const user = queryOne(db, "SELECT id, username, email, tenant_id FROM users WHERE id = ?", [reminderRow.recipient_id]);
  if (!user) return null;
  return deliverDirect(db, {
    user,
    tenantId: reminderRow.tenant_id,
    channel: "in_app",
    subject: details.subject || "Reminder",
    objectType: details.object_type || "",
    objectId: details.object_id || "",
    objectName: details.object_name || "",
    deepLink: details.deep_link || details.link || "",
    priority: "normal",
    correlationId: details.correlation_id || "",
    idempotencyKey: `reminder:${reminderRow.id}`,
  });
}

// Fires due reminders and escalations. Returns a summary for observability.
export function sweepReminders(db, { tenantId = null, limit = 200, now = null, actor = null, ip = null } = {}) {
  const stamp = now || nowIso();
  const params = [stamp];
  let clause = "";
  if (tenantId) {
    clause = "AND tenant_id = ?";
    params.push(Number(tenantId));
  }
  params.push(limit);
  const due = queryAll(
    db,
    `SELECT * FROM notification_reminders WHERE status = 'pending' AND due_at <= ? ${clause} ORDER BY due_at, id LIMIT ?`,
    params
  );
  const summary = { processed: 0, fired: 0, escalated: 0, rescheduled: 0, skipped: 0 };
  for (const reminder of due) {
    summary.processed += 1;
    const details = safeParse(reminder.details_json, {});
    if (details.escalate) {
      summary.escalated += 1;
      fireEscalation(db, reminder, details, { actor, ip });
    } else {
      summary.fired += 1;
      const notificationId = publishReminderEvent(db, reminder, details);
      // Repeats.
      const repeat = Number(details.repeat_minutes || 0);
      const maxRepeats = Number(details.max_repeats || 0);
      if (repeat > 0 && Number(reminder.level) < maxRepeats) {
        insertReminder(db, {
          ruleId: reminder.rule_id,
          eventId: reminder.event_id,
          notificationId,
          tenantId: reminder.tenant_id,
          recipientId: reminder.recipient_id,
          dueAt: addMinutes(stamp, repeat),
          level: Number(reminder.level) + 1,
          dedupeKey: `reminder:${reminder.rule_id}:${reminder.event_id}:${reminder.recipient_id}:${Number(reminder.level) + 1}`,
          details,
        });
        summary.rescheduled += 1;
      }
    }
    // Escalation schedule (first level only).
    const escalation = details.escalation || {};
    if (escalation.enabled && !details.escalate) {
      const after = Number(escalation.after_minutes ?? escalation.afterMinutes ?? 0);
      insertReminder(db, {
        ruleId: reminder.rule_id,
        eventId: reminder.event_id,
        notificationId: reminder.notification_id,
        tenantId: reminder.tenant_id,
        recipientId: reminder.recipient_id,
        dueAt: addMinutes(stamp, after),
        level: Number(reminder.level) + 1,
        dedupeKey: `escalation:${reminder.rule_id}:${reminder.event_id}:${Number(reminder.level) + 1}`,
        details: { ...details, escalate: true },
      });
    }
    run(
      db,
      "UPDATE notification_reminders SET status = 'fired', fired_at = ?, attempts = attempts + 1 WHERE id = ?",
      [stamp, reminder.id]
    );
  }
  return summary;
}

function fireEscalation(db, reminder, details, { actor = null, ip = null } = {}) {
  const escalation = details.escalation || {};
  const eventRow = reminder.event_id
    ? queryOne(db, "SELECT * FROM notification_events WHERE id = ?", [reminder.event_id])
    : { id: null, tenant_id: reminder.tenant_id, payload_json: "{}", related_json: "{}", event_type: details.event_type, source_module: details.source_module };
  const context = buildRuleContext(eventRow);
  const recipients = resolveRecipients(
    db,
    escalation.recipient || { items: [{ type: "manager" }] },
    context,
    reminder.tenant_id
  );
  const created = [];
  for (const recipient of recipients) {
    const notificationId = deliverDirect(db, {
      user: recipient,
      tenantId: reminder.tenant_id,
      channel: "in_app",
      subject: escalation.subject || `Escalation: ${details.subject || eventRow.event_type || "notification"}`,
      objectType: details.object_type || "",
      objectId: details.object_id || "",
      objectName: details.object_name || "",
      deepLink: details.deep_link || details.link || "",
      priority: "high",
      idempotencyKey: `escalation:${reminder.id}:${recipient.id}`,
    });
    if (notificationId) created.push(notificationId);
  }
  void actor;
  void ip;
  return created;
}

// Cancels pending reminders (for example when a task is completed).
export function cancelRemindersForObject(db, { objectType, objectId, tenantId = null }) {
  const params = [`%"object_type":"${objectType}"%`, `%"object_id":"${objectId}"%`];
  let clause = "";
  if (tenantId) {
    clause = "AND tenant_id = ?";
    params.push(Number(tenantId));
  }
  const result = run(
    db,
    `UPDATE notification_reminders SET status = 'cancelled'
      WHERE status = 'pending' AND details_json LIKE ? AND details_json LIKE ? ${clause}`,
    params
  );
  return { cancelled: result.changes };
}

export function listReminders(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  if (tenantId) {
    where.push("r.tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (query.status) {
    where.push("r.status = ?");
    params.push(query.status);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM notification_reminders r ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT r.*, u.username AS recipient_username FROM notification_reminders r
      LEFT JOIN users u ON u.id = r.recipient_id ${clause} ORDER BY r.due_at LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map((row) => ({
    id: row.id,
    rule_id: row.rule_id ?? null,
    event_id: row.event_id ?? null,
    notification_id: row.notification_id ?? null,
    recipient_id: row.recipient_id,
    recipient_username: row.recipient_username || "",
    due_at: row.due_at,
    fired_at: row.fired_at,
    level: row.level,
    status: row.status,
    attempts: row.attempts,
    details: safeParse(row.details_json, {}),
    created_at: row.created_at,
  }));
  return { items, total, page, pageSize };
}

export function getReminder(db, id, tenantId = null) {
  const row = queryOne(db, "SELECT * FROM notification_reminders WHERE id = ?", [Number(id)]);
  if (!row) throw new HttpError(404, "Reminder not found");
  if (tenantId && Number(row.tenant_id) !== Number(tenantId)) throw new HttpError(404, "Reminder not found");
  return row;
}
