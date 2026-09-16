import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { assertFrequency, safeParse } from "./validation.js";

// User notification preferences. Defaults are created lazily on first read so a
// new user always has a well-defined preference row. Administrators can mark a
// rule as mandatory; mandatory events ignore user opt-outs for those channels.

export const DEFAULT_PREFERENCES = {
  in_app: true,
  email: true,
  frequency: "immediate",
  language: "en",
  quiet_hours: {},
  reminders: true,
  escalations: true,
  self_notify: true,
  event_preferences: {},
};

export function publicPreferences(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    tenant_id: row.tenant_id ?? null,
    in_app: row.in_app === 1,
    email: row.email === 1,
    frequency: row.frequency,
    language: row.language,
    quiet_hours: safeParse(row.quiet_hours_json, {}),
    reminders: row.reminders === 1,
    escalations: row.escalations === 1,
    self_notify: row.self_notify === 1,
    event_preferences: safeParse(row.event_preferences_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getPreferenceRow(db, userId, tenantId) {
  const row = queryOne(
    db,
    "SELECT * FROM notification_preferences WHERE user_id = ? AND COALESCE(tenant_id, 0) = COALESCE(?, 0)",
    [Number(userId), tenantId ? Number(tenantId) : null]
  );
  if (row) return row;
  const ts = nowIso();
  run(
    db,
    `INSERT INTO notification_preferences
      (user_id, tenant_id, in_app, email, frequency, language, quiet_hours_json, reminders, escalations, self_notify, event_preferences_json, created_at, updated_at)
     VALUES (?, ?, 1, 1, 'immediate', 'en', '{}', 1, 1, 1, '{}', ?, ?)`,
    [Number(userId), tenantId ? Number(tenantId) : null, ts, ts]
  );
  return queryOne(
    db,
    "SELECT * FROM notification_preferences WHERE user_id = ? AND COALESCE(tenant_id, 0) = COALESCE(?, 0)",
    [Number(userId), tenantId ? Number(tenantId) : null]
  );
}

export function getPreferences(db, userId, tenantId = null) {
  return publicPreferences(getPreferenceRow(db, userId, tenantId));
}

export function updatePreferences(db, userId, body = {}, actor = null, ip = null, tenantId = null) {
  const row = getPreferenceRow(db, userId, tenantId);
  const frequency = body.frequency ?? row.frequency;
  assertFrequency(frequency);
  const bool = (value, fallback) => (value === undefined ? fallback : value ? 1 : 0);
  run(
    db,
    `UPDATE notification_preferences SET
       in_app = ?, email = ?, frequency = ?, language = ?, quiet_hours_json = ?,
       reminders = ?, escalations = ?, self_notify = ?, event_preferences_json = ?, updated_at = ?
     WHERE id = ?`,
    [
      bool(body.in_app ?? body.inApp, row.in_app),
      bool(body.email, row.email),
      frequency,
      body.language ?? row.language,
      JSON.stringify(body.quiet_hours ?? body.quietHours ?? safeParse(row.quiet_hours_json, {})),
      bool(body.reminders, row.reminders),
      bool(body.escalations, row.escalations),
      bool(body.self_notify ?? body.selfNotify, row.self_notify),
      JSON.stringify(body.event_preferences ?? body.eventPreferences ?? safeParse(row.event_preferences_json, {})),
      nowIso(),
      row.id,
    ]
  );
  if (actor && Number(actor.id) === Number(userId)) {
    writeAudit(db, {
      actor,
      action: "notification.preferences.update",
      resourceType: "notification_preference",
      resourceId: row.id,
      details: { frequency },
      ip,
    });
  }
  return publicPreferences(queryOne(db, "SELECT * FROM notification_preferences WHERE id = ?", [row.id]));
}

// Event types covered by an active mandatory rule for this tenant.
export function mandatoryEvents(db, tenantId) {
  const rows = queryAll(
    db,
    `SELECT DISTINCT event_type FROM notification_rules
      WHERE status = 'active' AND mandatory = 1 AND (tenant_id IS NULL OR tenant_id = ?)`,
    [tenantId ? Number(tenantId) : -1]
  );
  return rows.map((row) => row.event_type).filter((type) => type && type !== "*");
}

export function ensureDefaultPreferences(db, userId, tenantId) {
  getPreferenceRow(db, userId, tenantId);
}

function inQuietHours(quietHours, date) {
  const start = quietHours?.start;
  const end = quietHours?.end;
  if (!start || !end) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  const [sh, sm] = String(start).split(":").map(Number);
  const [eh, em] = String(end).split(":").map(Number);
  const from = (sh || 0) * 60 + (sm || 0);
  const to = (eh || 0) * 60 + (em || 0);
  if (from === to) return false;
  if (from < to) return minutes >= from && minutes < to;
  return minutes >= from || minutes < to;
}

// Shared delivery-time preference evaluation. Returns whether a channel may be
// used for a recipient and event type, plus the reason when it may not.
export function evaluatePreference(db, recipient, channel, eventType, tenantId, { now = new Date(), mandatory = false } = {}) {
  const row = getPreferenceRow(db, recipient.id, tenantId);
  const prefs = publicPreferences(row);
  if (mandatory) return { allowed: true, preference: prefs, reason: "mandatory", quiet: false };

  if (!prefs.self_notify && recipient.isInitiator) {
    return { allowed: false, preference: prefs, reason: "self_initiated" };
  }

  const eventPref = prefs.event_preferences?.[eventType] || prefs.event_preferences?.["*"];
  if (eventPref) {
    if (eventPref.enabled === false) return { allowed: false, preference: prefs, reason: "event_disabled" };
    if (channel && eventPref.channels && Array.isArray(eventPref.channels) && !eventPref.channels.includes(channel)) {
      return { allowed: false, preference: prefs, reason: "event_channel_disabled" };
    }
  }

  if (channel === "email" && !prefs.email) return { allowed: false, preference: prefs, reason: "email_disabled" };
  if (channel === "in_app" && !prefs.in_app) return { allowed: false, preference: prefs, reason: "in_app_disabled" };
  if (prefs.frequency === "off" && channel !== "in_app") {
    return { allowed: false, preference: prefs, reason: "frequency_off" };
  }

  const quiet = inQuietHours(prefs.quiet_hours, now);
  if (quiet && channel === "email") {
    return { allowed: false, preference: prefs, reason: "quiet_hours", quiet: true };
  }
  return { allowed: true, preference: prefs, reason: "allowed", quiet };
}

export function isReminderAllowed(db, recipientId, tenantId) {
  const prefs = publicPreferences(getPreferenceRow(db, recipientId, tenantId));
  return prefs.reminders;
}

export function isEscalationAllowed(db, recipientId, tenantId) {
  const prefs = publicPreferences(getPreferenceRow(db, recipientId, tenantId));
  return prefs.escalations;
}
