import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { resolveRecipients } from "../notifications/recipients.js";
import { submitRequest } from "./requests.js";
import { scheduleEscalation, completeEscalationsForObject } from "./escalations.js";
import { addMinutes, assertReminderKind, assertReminderStatus, safeParse, REMINDER_STATUSES } from "./validation.js";

// Reminder execution. The originating module supplies the recipient and the
// schedule (due/overdue/repeat) plus an optional escalation definition; this
// service only executes due reminders, repeats them and hands escalation to the
// escalation engine. Duplicate prevention uses per-run idempotency keys.

export { REMINDER_STATUSES };

export function publicReminder(row) {
  if (!row) return null;
  const pending = row.status === "pending";
  return {
    id: row.id,
    code: row.code || "",
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    source_module: row.source_module || "platform",
    object_type: row.object_type || "",
    object_id: row.object_id || "",
    object_name: row.object_name || "",
    deep_link: row.deep_link || "",
    recipient_id: row.recipient_id ?? null,
    recipient: safeParse(row.recipient_json, {}),
    kind: row.kind,
    due_at: row.due_at,
    next_run_at: row.next_run_at || null,
    next_execution: pending ? (row.next_run_at || row.due_at) : null,
    repeat_minutes: row.repeat_minutes,
    max_repeats: row.max_repeats,
    repeat_count: row.repeat_count,
    status: row.status,
    stop_on_complete: row.stop_on_complete === 1,
    completed_at: row.completed_at || null,
    last_run_at: row.last_run_at || null,
    last_error: row.last_error || "",
    level: row.level,
    escalation: safeParse(row.escalation_json, {}),
    details: safeParse(row.details_json, {}),
    dedupe_key: row.dedupe_key || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function insertReminder(db, fields) {
  const columns = Object.keys(fields);
  const result = run(
    db,
    `INSERT INTO delivery_reminders (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    columns.map((column) => fields[column])
  );
  return result.lastInsertRowid;
}

export function scheduleReminder(db, input = {}, { actor = null, ip = null } = {}) {
  const kind = input.kind || "due";
  assertReminderKind(kind);
  const tenantId = input.tenant_id ?? input.tenantId ?? actor?.tenant_id ?? null;
  const delay = Number(input.delay_minutes ?? input.delayMinutes ?? input.due_in_minutes ?? input.dueInMinutes ?? 0) || 0;
  const dueAt = input.due_at ?? input.dueAt ?? addMinutes(nowIso(), delay);
  const dedupeKey = input.dedupe_key ?? input.dedupeKey ?? null;
  if (dedupeKey) {
    const existing = queryOne(db, "SELECT * FROM delivery_reminders WHERE dedupe_key = ?", [dedupeKey]);
    if (existing) return publicReminder(existing);
  }
  const id = insertReminder(db, {
    code: input.code || null,
    tenant_id: tenantId !== null ? Number(tenantId) : null,
    organization_id: Number(input.organization_id ?? input.organizationId ?? 0) || null,
    source_module: input.source_module ?? input.sourceModule ?? "platform",
    object_type: input.object_type ?? input.objectType ?? "",
    object_id: input.object_id ?? input.objectId ?? "",
    object_name: input.object_name ?? input.objectName ?? "",
    deep_link: input.deep_link ?? input.deepLink ?? "",
    recipient_id: input.recipient_id ?? input.recipientId ?? null,
    recipient_json: input.recipient ? JSON.stringify(input.recipient) : (input.recipient_json ?? input.recipientJson ?? "{}"),
    kind,
    due_at: dueAt,
    next_run_at: dueAt,
    repeat_minutes: Math.max(0, Number(input.repeat_minutes ?? input.repeatMinutes ?? 0) || 0),
    max_repeats: Math.max(0, Number(input.max_repeats ?? input.maxRepeats ?? 0) || 0),
    repeat_count: 0,
    status: "pending",
    stop_on_complete: input.stop_on_complete === false || input.stopOnComplete === false ? 0 : 1,
    level: Math.max(0, Number(input.level ?? 0) || 0),
    escalation_json: input.escalation ? JSON.stringify(input.escalation) : (input.escalation_json ?? input.escalationJson ?? "{}"),
    details_json: input.details ? JSON.stringify(input.details) : (input.details_json ?? "{}"),
    dedupe_key: dedupeKey,
    created_by: actor?.id ?? null,
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  writeAudit(db, { actor, action: "delivery.reminder.create", resourceType: "delivery_reminder", resourceId: id, details: { kind, due_at: dueAt, object_type: input.object_type ?? "", object_id: input.object_id ?? "" }, ip });
  return publicReminder(queryOne(db, "SELECT * FROM delivery_reminders WHERE id = ?", [id]));
}

export function listReminders(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  const scoped = tenantId ?? (query.tenantId ? Number(query.tenantId) : null);
  if (scoped) {
    where.push("COALESCE(tenant_id, 0) = ?");
    params.push(Number(scoped));
  }
  if (query.status) {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.kind) {
    where.push("kind = ?");
    params.push(query.kind);
  }
  if (query.objectType || query.object_type) {
    where.push("object_type = ?");
    params.push(query.objectType || query.object_type);
  }
  if (query.objectId || query.object_id) {
    where.push("object_id = ?");
    params.push(query.objectId || query.object_id);
  }
  if (query.module || query.source_module) {
    where.push("source_module = ?");
    params.push(query.module || query.source_module);
  }
  if (query.q) {
    const like = `%${query.q}%`;
    where.push("(object_name LIKE ? OR details_json LIKE ?)");
    params.push(like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM delivery_reminders ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT * FROM delivery_reminders ${clause} ORDER BY (status = 'pending') DESC, due_at LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicReminder);
  return { items, total, page, pageSize };
}

export function getReminder(db, id, tenantId = null) {
  const row = queryOne(db, "SELECT * FROM delivery_reminders WHERE id = ?", [Number(id)]);
  if (!row) throw new HttpError(404, "Reminder not found");
  if (tenantId && Number(row.tenant_id) !== Number(tenantId)) throw new HttpError(404, "Reminder not found");
  const reminder = publicReminder(row);
  reminder.runs = queryAll(db, "SELECT * FROM delivery_runs WHERE reminder_id = ? ORDER BY id DESC LIMIT 50", [row.id]);
  reminder.escalations = queryAll(db, "SELECT * FROM delivery_escalations WHERE reminder_id = ? ORDER BY level", [row.id]).map((e) => ({
    id: e.id,
    level: e.level,
    max_level: e.max_level,
    status: e.status,
    due_at: e.due_at,
    fired_at: e.fired_at,
  }));
  return reminder;
}

export function updateReminder(db, id, body = {}, { tenantId = null, actor = null, ip = null } = {}) {
  const row = queryOne(db, "SELECT * FROM delivery_reminders WHERE id = ?", [Number(id)]);
  if (!row || (tenantId && Number(row.tenant_id) !== Number(tenantId))) throw new HttpError(404, "Reminder not found");
  if (body.status !== undefined) assertReminderStatus(body.status);
  const dueAt = body.due_at ?? body.dueAt ?? row.due_at;
  run(
    db,
    `UPDATE delivery_reminders
        SET due_at = ?, next_run_at = ?, repeat_minutes = ?, max_repeats = ?, status = ?,
            stop_on_complete = ?, deep_link = ?, details_json = ?, updated_at = ?
      WHERE id = ?`,
    [
      dueAt,
      row.status === "pending" ? dueAt : row.next_run_at,
      body.repeat_minutes !== undefined ? Math.max(0, Number(body.repeat_minutes) || 0) : row.repeat_minutes,
      body.max_repeats !== undefined ? Math.max(0, Number(body.max_repeats) || 0) : row.max_repeats,
      body.status ?? row.status,
      body.stop_on_complete === undefined ? row.stop_on_complete : body.stop_on_complete === false ? 0 : 1,
      body.deep_link ?? body.deepLink ?? row.deep_link,
      body.details ? JSON.stringify(body.details) : row.details_json,
      nowIso(),
      row.id,
    ]
  );
  writeAudit(db, { actor, action: "delivery.reminder.update", resourceType: "delivery_reminder", resourceId: row.id, details: { status: body.status ?? row.status }, ip });
  return publicReminder(queryOne(db, "SELECT * FROM delivery_reminders WHERE id = ?", [row.id]));
}

export function cancelReminder(db, id, { tenantId = null, actor = null, ip = null } = {}) {
  const row = queryOne(db, "SELECT * FROM delivery_reminders WHERE id = ?", [Number(id)]);
  if (!row || (tenantId && Number(row.tenant_id) !== Number(tenantId))) throw new HttpError(404, "Reminder not found");
  if (["cancelled", "completed"].includes(row.status)) return { cancelled: false, reason: "already_terminal" };
  run(db, "UPDATE delivery_reminders SET status = 'cancelled', next_run_at = NULL, updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  writeAudit(db, { actor, action: "delivery.reminder.cancel", resourceType: "delivery_reminder", resourceId: row.id, details: {}, ip });
  return { cancelled: true };
}

// Stops pending reminders (and their escalations) when the related task or
// process completes. Only reminders flagged stop_on_complete are affected.
export function completeRemindersForObject(db, { objectType, objectId, tenantId = null, reason = "completed" } = {}) {
  if (!objectType || objectId === undefined || objectId === null) {
    throw new HttpError(400, "objectType and objectId are required");
  }
  const params = [nowIso(), String(reason), nowIso(), String(objectType), String(objectId)];
  let clause = "";
  if (tenantId) {
    clause = "AND COALESCE(tenant_id, 0) = ?";
    params.push(Number(tenantId));
  }
  const result = run(
    db,
    `UPDATE delivery_reminders SET status = 'completed', completed_at = ?, last_error = ?, next_run_at = NULL, updated_at = ?
      WHERE status = 'pending' AND stop_on_complete = 1 AND object_type = ? AND object_id = ? ${clause}`,
    params
  );
  const escalations = completeEscalationsForObject(db, { objectType, objectId, tenantId, reason });
  return { completed: result.changes, escalations: escalations.completed };
}

function recordRun(db, { reminderId, level, status, requestId = null, detail = "" }) {
  run(
    db,
    "INSERT INTO delivery_runs (kind, reminder_id, level, status, request_id, detail, ran_at) VALUES ('reminder', ?, ?, ?, ?, ?, ?)",
    [reminderId, level, status, requestId, detail, nowIso()]
  );
}

function resolveReminderRecipients(db, reminder) {
  if (reminder.recipient_id) {
    const user = queryOne(db, "SELECT id, username, display_name, email, organization_id, tenant_id FROM users WHERE id = ?", [Number(reminder.recipient_id)]);
    return user ? [user] : [];
  }
  const definition = safeParse(reminder.recipient_json, null);
  if (!definition || (Array.isArray(definition.items) && !definition.items.length)) return [];
  const details = safeParse(reminder.details_json, {});
  return resolveRecipients(db, definition, {
    object: { type: reminder.object_type, id: reminder.object_id, name: reminder.object_name },
    payload: details.payload || {},
  }, reminder.tenant_id);
}

// Fires due/overdue reminders, schedules repeats and hands escalations to the
// escalation engine. Pull-based; safe to call repeatedly.
export function sweepReminders(db, { tenantId = null, limit = 200, now = null, actor = null, ip = null } = {}) {
  const stamp = now || nowIso();
  const params = [stamp];
  let clause = "";
  if (tenantId) {
    clause = "AND COALESCE(tenant_id, 0) = ?";
    params.push(Number(tenantId));
  }
  params.push(limit);
  const due = queryAll(
    db,
    `SELECT * FROM delivery_reminders WHERE status = 'pending' AND due_at <= ? ${clause} ORDER BY due_at, id LIMIT ?`,
    params
  );
  const summary = { processed: 0, fired: 0, rescheduled: 0, escalated: 0, skipped: 0, requests: [] };
  for (const reminder of due) {
    summary.processed += 1;
    const details = safeParse(reminder.details_json, {});
    let recipients = [];
    try {
      recipients = resolveReminderRecipients(db, reminder);
    } catch (err) {
      summary.skipped += 1;
      run(db, "UPDATE delivery_reminders SET last_error = ?, status = 'pending', due_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?", [String(err.message), addMinutes(stamp, 5), addMinutes(stamp, 5), stamp, reminder.id]);
      recordRun(db, { reminderId: reminder.id, level: reminder.level, status: "skipped", detail: err.message });
      continue;
    }
    for (const recipient of recipients) {
      const request = submitRequest(db, {
        tenant_id: reminder.tenant_id,
        organization_id: reminder.organization_id,
        source_module: reminder.source_module,
        recipient_id: recipient.id,
        recipient_name: recipient.display_name || recipient.username || "",
        recipient_address: recipient.email || "",
        channel: details.channel || "in_app",
        subject: details.subject || reminder.object_name || `${reminder.kind === "overdue" ? "Overdue" : "Reminder"}: ${reminder.object_type || "item"}`,
        body: details.body || "",
        priority: details.priority || (reminder.kind === "overdue" ? "high" : "normal"),
        object_type: reminder.object_type,
        object_id: reminder.object_id,
        object_name: reminder.object_name,
        deep_link: reminder.deep_link,
        idempotency_key: `reminder:${reminder.id}:${reminder.repeat_count}:${recipient.id}`,
        related: { reminder_id: reminder.id, repeat_count: reminder.repeat_count, kind: reminder.kind },
      }, { actor });
      summary.requests.push(request.id);
      recordRun(db, { reminderId: reminder.id, level: reminder.level, status: "fired", requestId: request.id, detail: `to ${recipient.username || recipient.id}` });
    }
    summary.fired += 1;

    // Repeats: keep the same row pending with an advanced next_run_at.
    const repeat = Number(reminder.repeat_minutes || 0);
    const maxRepeats = Number(reminder.max_repeats || 0);
    const nextCount = Number(reminder.repeat_count) + 1;
    if (repeat > 0 && nextCount <= maxRepeats) {
      const next = addMinutes(stamp, repeat);
      run(
        db,
        "UPDATE delivery_reminders SET due_at = ?, next_run_at = ?, repeat_count = ?, last_run_at = ?, last_error = '', updated_at = ? WHERE id = ?",
        [next, next, nextCount, stamp, stamp, reminder.id]
      );
      summary.rescheduled += 1;
    } else {
      run(
        db,
        "UPDATE delivery_reminders SET status = 'fired', last_run_at = ?, next_run_at = NULL, updated_at = ? WHERE id = ?",
        [stamp, stamp, reminder.id]
      );
    }

    // Escalation: schedule level 1 when configured and not already scheduled.
    const escalation = safeParse(reminder.escalation_json, {}) || {};
    if (escalation.enabled && reminder.object_type && reminder.object_id) {
      const scheduled = scheduleEscalation(db, {
        reminder_id: reminder.id,
        tenant_id: reminder.tenant_id,
        organization_id: reminder.organization_id,
        source_module: reminder.source_module,
        object_type: reminder.object_type,
        object_id: reminder.object_id,
        object_name: reminder.object_name,
        deep_link: reminder.deep_link,
        recipient: escalation.recipient || { items: [{ type: "manager" }] },
        level: 1,
        max_level: escalation.max_level ?? escalation.maxLevel ?? 3,
        after_minutes: escalation.after_minutes ?? escalation.afterMinutes ?? 0,
        priority: escalation.priority || "high",
        details: { subject: escalation.subject || details.subject, channel: escalation.channel || "in_app", payload: details.payload || {} },
      }, { actor });
      if (scheduled) summary.escalated += 1;
    }
    void ip;
  }
  return summary;
}

export function listRuns(db, { kind = null, reminderId = null, escalationId = null, limit = 100 } = {}) {
  const where = [];
  const params = [];
  if (kind) {
    where.push("kind = ?");
    params.push(kind);
  }
  if (reminderId) {
    where.push("reminder_id = ?");
    params.push(Number(reminderId));
  }
  if (escalationId) {
    where.push("escalation_id = ?");
    params.push(Number(escalationId));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return queryAll(db, `SELECT * FROM delivery_runs ${clause} ORDER BY id DESC LIMIT ?`, [...params, Math.min(500, Number(limit) || 100)]);
}
