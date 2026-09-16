import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { resolveRecipients } from "../notifications/recipients.js";
import { submitRequest } from "./requests.js";
import { addMinutes, assertEscalationStatus, safeParse } from "./validation.js";

// Escalation execution. The business module supplies the escalation recipient
// definition and timing; this service only resolves the supplied definition
// (re-using the notification recipient resolver), raises the delivery request
// and advances through levels up to the configured maximum.

export const ESCALATION_MAX_LEVEL = 3;

export function publicEscalation(row) {
  if (!row) return null;
  return {
    id: row.id,
    reminder_id: row.reminder_id ?? null,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    source_module: row.source_module || "platform",
    object_type: row.object_type || "",
    object_id: row.object_id || "",
    object_name: row.object_name || "",
    deep_link: row.deep_link || "",
    recipient_id: row.recipient_id ?? null,
    recipient: safeParse(row.recipient_json, {}),
    level: row.level,
    max_level: row.max_level,
    after_minutes: row.after_minutes,
    status: row.status,
    due_at: row.due_at || null,
    fired_at: row.fired_at || null,
    last_run_at: row.last_run_at || null,
    last_error: row.last_error || "",
    priority: row.priority,
    details: safeParse(row.details_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function insertEscalation(db, fields) {
  const columns = Object.keys(fields);
  const result = run(
    db,
    `INSERT INTO delivery_escalations (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    columns.map((column) => fields[column])
  );
  return result.lastInsertRowid;
}

export function scheduleEscalation(db, input = {}, { actor = null, ip = null } = {}) {
  const tenantId = input.tenant_id ?? input.tenantId ?? actor?.tenant_id ?? null;
  const level = Math.max(1, Number(input.level ?? input.escalation_level ?? 1) || 1);
  const maxLevel = Math.max(level, Number(input.max_level ?? input.maxLevel ?? ESCALATION_MAX_LEVEL) || ESCALATION_MAX_LEVEL);
  const afterMinutes = Number(input.after_minutes ?? input.afterMinutes ?? 0) || 0;
  const dueAt = input.due_at ?? input.dueAt ?? addMinutes(nowIso(), afterMinutes);
  const dedupeKey = input.dedupe_key ?? input.dedupeKey ?? (input.reminder_id ?? input.reminderId ? `escalation:${input.reminder_id ?? input.reminderId}:${level}` : null);
  if (dedupeKey) {
    const existing = queryOne(db, "SELECT * FROM delivery_escalations WHERE dedupe_key = ?", [dedupeKey]);
    if (existing) return publicEscalation(existing);
  }
  const id = insertEscalation(db, {
    reminder_id: input.reminder_id ?? input.reminderId ?? null,
    tenant_id: tenantId !== null ? Number(tenantId) : null,
    organization_id: Number(input.organization_id ?? input.organizationId ?? 0) || null,
    source_module: input.source_module ?? input.sourceModule ?? "platform",
    object_type: input.object_type ?? input.objectType ?? "",
    object_id: input.object_id ?? input.objectId ?? "",
    object_name: input.object_name ?? input.objectName ?? "",
    deep_link: input.deep_link ?? input.deepLink ?? "",
    recipient_id: input.recipient_id ?? input.recipientId ?? null,
    recipient_json: input.recipient ? JSON.stringify(input.recipient) : (input.recipient_json ?? input.recipientJson ?? "{}"),
    level,
    max_level: maxLevel,
    after_minutes: afterMinutes,
    status: "pending",
    due_at: dueAt,
    priority: input.priority || "high",
    dedupe_key: dedupeKey,
    details_json: input.details ? JSON.stringify(input.details) : (input.details_json ?? "{}"),
    created_at: nowIso(),
    updated_at: nowIso(),
  });
  writeAudit(db, { actor, action: "delivery.escalation.create", resourceType: "delivery_escalation", resourceId: id, details: { level, max_level: maxLevel, object_type: input.object_type ?? "", object_id: input.object_id ?? "" }, ip });
  return publicEscalation(queryOne(db, "SELECT * FROM delivery_escalations WHERE id = ?", [id]));
}

export function listEscalations(db, query = {}, tenantId = null) {
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
  if (query.reminderId || query.reminder_id) {
    where.push("reminder_id = ?");
    params.push(Number(query.reminderId || query.reminder_id));
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM delivery_escalations ${clause}`, params).c;
  const items = queryAll(db, `SELECT * FROM delivery_escalations ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]).map(publicEscalation);
  return { items, total, page, pageSize };
}

export function getEscalation(db, id, tenantId = null) {
  const row = queryOne(db, "SELECT * FROM delivery_escalations WHERE id = ?", [Number(id)]);
  if (!row) throw new HttpError(404, "Escalation not found");
  if (tenantId && Number(row.tenant_id) !== Number(tenantId)) throw new HttpError(404, "Escalation not found");
  return publicEscalation(row);
}

export function cancelEscalation(db, id, { tenantId = null, actor = null, ip = null } = {}) {
  const row = queryOne(db, "SELECT * FROM delivery_escalations WHERE id = ?", [Number(id)]);
  if (!row || (tenantId && Number(row.tenant_id) !== Number(tenantId))) throw new HttpError(404, "Escalation not found");
  if (["fired", "completed", "cancelled"].includes(row.status)) return { cancelled: false, reason: "already_terminal" };
  run(db, "UPDATE delivery_escalations SET status = 'cancelled', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  writeAudit(db, { actor, action: "delivery.escalation.cancel", resourceType: "delivery_escalation", resourceId: row.id, details: { level: row.level }, ip });
  return { cancelled: true };
}

function resolveEscalationRecipients(db, escalation, details) {
  if (escalation.recipient_id) {
    const user = queryOne(db, "SELECT id, username, display_name, email, organization_id, tenant_id FROM users WHERE id = ?", [Number(escalation.recipient_id)]);
    return user ? [user] : [];
  }
  const definition = safeParse(escalation.recipient_json, null) || details.recipient || { items: [{ type: "manager" }] };
  const context = {
    object: { type: escalation.object_type, id: escalation.object_id, name: escalation.object_name },
    payload: details.payload || {},
    ...(details.context || {}),
  };
  return resolveRecipients(db, definition, context, escalation.tenant_id);
}

function recordRun(db, { escalationId, reminderId = null, level, status, requestId = null, detail = "" }) {
  run(
    db,
    "INSERT INTO delivery_runs (kind, escalation_id, reminder_id, level, status, request_id, detail, ran_at) VALUES ('escalation', ?, ?, ?, ?, ?, ?, ?)",
    [escalationId, reminderId, level, status, requestId, detail, nowIso()]
  );
}

// Fires due escalations, raises a delivery request per resolved recipient and
// advances to the next level until max_level is reached.
export function sweepEscalations(db, { tenantId = null, limit = 200, now = null, actor = null, ip = null } = {}) {
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
    `SELECT * FROM delivery_escalations WHERE status = 'pending' AND due_at <= ? ${clause} ORDER BY due_at, id LIMIT ?`,
    params
  );
  const summary = { processed: 0, escalated: 0, rescheduled: 0, skipped: 0, requests: [] };
  for (const escalation of due) {
    summary.processed += 1;
    const details = safeParse(escalation.details_json, {});
    let recipients = [];
    try {
      recipients = resolveEscalationRecipients(db, escalation, details);
    } catch (err) {
      summary.skipped += 1;
      run(db, "UPDATE delivery_escalations SET last_error = ?, updated_at = ? WHERE id = ?", [String(err.message), stamp, escalation.id]);
      recordRun(db, { escalationId: escalation.id, reminderId: escalation.reminder_id, level: escalation.level, status: "skipped", detail: err.message });
      continue;
    }
    for (const recipient of recipients) {
      const request = submitRequest(db, {
        tenant_id: escalation.tenant_id,
        organization_id: escalation.organization_id,
        source_module: escalation.source_module,
        recipient_id: recipient.id,
        recipient_name: recipient.display_name || recipient.username || "",
        recipient_address: recipient.email || "",
        channel: details.channel || "in_app",
        subject: details.subject || `Escalation level ${escalation.level}: ${escalation.object_name || escalation.object_type || "attention required"}`,
        body: details.body || "",
        priority: escalation.priority || "high",
        object_type: escalation.object_type,
        object_id: escalation.object_id,
        object_name: escalation.object_name,
        deep_link: escalation.deep_link,
        idempotency_key: `escalation:${escalation.id}:${recipient.id}:${escalation.level}`,
        related: { escalation_id: escalation.id, reminder_id: escalation.reminder_id, level: escalation.level },
      }, { actor });
      summary.requests.push(request.id);
      recordRun(db, { escalationId: escalation.id, reminderId: escalation.reminder_id, level: escalation.level, status: "fired", requestId: request.id, detail: `to ${recipient.username || recipient.id}` });
    }
    summary.escalated += recipients.length ? 1 : 0;
    const nextLevel = Number(escalation.level) + 1;
    if (recipients.length && nextLevel <= Number(escalation.max_level)) {
      run(
        db,
        "UPDATE delivery_escalations SET level = ?, due_at = ?, last_run_at = ?, last_error = '', status = 'pending', updated_at = ? WHERE id = ?",
        [nextLevel, addMinutes(stamp, escalation.after_minutes), stamp, stamp, escalation.id]
      );
      summary.rescheduled += 1;
    } else {
      run(
        db,
        "UPDATE delivery_escalations SET status = 'fired', fired_at = ?, last_run_at = ?, updated_at = ? WHERE id = ?",
        [stamp, stamp, stamp, escalation.id]
      );
    }
    void ip;
  }
  return summary;
}

export function completeEscalationsForObject(db, { objectType, objectId, tenantId = null, reason = "completed" } = {}) {
  const params = [String(objectType), String(objectId)];
  let clause = "";
  if (tenantId) {
    clause = "AND COALESCE(tenant_id, 0) = ?";
    params.push(Number(tenantId));
  }
  const result = run(
    db,
    `UPDATE delivery_escalations SET status = 'completed', last_error = ?, updated_at = ?
      WHERE status = 'pending' AND object_type = ? AND object_id = ? ${clause}`,
    [String(reason), nowIso(), ...params]
  );
  return { completed: result.changes };
}

export { assertEscalationStatus };
