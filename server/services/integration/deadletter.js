// Dead-letter processing for messages that cannot be completed. Supports
// inspection (payload masked unless explicitly permitted), manual retry,
// bulk retry, reprocess after correction, and close/ignore with a reason.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import { publicDeadLetter } from "./repository.js";
import { maskPayload, safeParse, toJson } from "./validation.js";
import { requeueMessage, getMessageRow } from "./messages.js";
import { auditIntegration } from "./hooks.js";

function whereFrom({ tenantId, status, integrationId, errorCategory, q } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (integrationId) {
    clauses.push("integration_id = ?");
    params.push(Number(integrationId));
  }
  if (errorCategory) {
    clauses.push("error_category = ?");
    params.push(errorCategory);
  }
  if (q) {
    clauses.push("(LOWER(reason) LIKE ? OR LOWER(correlation_id) LIKE ? OR LOWER(error_code) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function createDeadLetter(db, input = {}) {
  const message = input.message || null;
  const execution = input.execution || null;
  const error = input.error || {};
  const ts = nowIso();
  // Avoid piling up duplicate entries for the same message.
  if (message?.id) {
    const existing = queryOne(db, "SELECT * FROM integration_dead_letters WHERE message_id = ? AND status IN ('open', 'retrying')", [message.id]);
    if (existing) return publicDeadLetter(existing);
  }
  const result = run(
    db,
    `INSERT INTO integration_dead_letters
      (message_id, execution_id, integration_id, correlation_id, reason, error_category, error_code,
       attempt_history_json, stack_ref, payload_ref, payload_json, status, tenant_id, dead_lettered_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
    [
      message?.id ?? null,
      execution?.id ?? null,
      execution?.definition_id ?? message?.integration_id ?? null,
      execution?.correlation_id ?? message?.correlation_id ?? null,
      error.message || "Integration failed",
      error.category || "technical",
      error.code || "internal_error",
      toJson(input.attempt_history || (message ? [{ attempt: message.attempts, error: error.message }] : []), []),
      input.stack_ref || "",
      message?.payload_ref || "",
      message?.payload_json ?? (input.payload ? toJson(input.payload, null) : null),
      message?.tenant_id ?? execution?.tenant_id ?? null,
      ts,
      ts,
    ]
  );
  return publicDeadLetter(queryOne(db, "SELECT * FROM integration_dead_letters WHERE id = ?", [Number(result.lastInsertRowid)]));
}

export function listDeadLetters(db, options = {}) {
  const { page = 1, pageSize = 50 } = options;
  const { where, params } = whereFrom(options);
  const total = queryOne(db, `SELECT COUNT(*) FROM integration_dead_letters ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_dead_letters ${where} ORDER BY dead_lettered_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicDeadLetter(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getDeadLetterRow(db, ref) {
  const id = Number(ref);
  return queryOne(db, "SELECT * FROM integration_dead_letters WHERE id = ?", [Number.isFinite(id) ? id : -1]);
}

export function getDeadLetter(db, ref, { includePayload = false } = {}) {
  const row = getDeadLetterRow(db, ref);
  if (!row) throw new HttpError(404, "Dead-letter entry not found");
  return publicDeadLetter(row, { includePayload });
}

export function inspectDeadLetterPayload(db, ref, actor = null) {
  const row = getDeadLetterRow(db, ref);
  if (!row) throw new HttpError(404, "Dead-letter entry not found");
  auditIntegration(db, { actor, action: "integration.dead_letter.inspect", resourceType: "integration_dead_letter", resourceId: row.id, details: { correlation_id: row.correlation_id } });
  return { id: row.id, payload: safeParse(row.payload_json, null), payload_ref: row.payload_ref || "" };
}

export function retryDeadLetter(db, ref, actor = null, { resetAttempts = true } = {}) {
  const row = getDeadLetterRow(db, ref);
  if (!row) throw new HttpError(404, "Dead-letter entry not found");
  let message = null;
  if (row.message_id) {
    message = requeueMessage(db, row.message_id, { resetAttempts, actor });
  }
  run(db, "UPDATE integration_dead_letters SET status = 'retrying', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  auditIntegration(db, { actor, action: "integration.dead_letter.retry", resourceType: "integration_dead_letter", resourceId: row.id, details: { message_ref: message?.message_ref || null } });
  return { retried: true, dead_letter: publicDeadLetter(queryOne(db, "SELECT * FROM integration_dead_letters WHERE id = ?", [row.id])), message };
}

export function bulkRetryDeadLetters(db, ids = [], actor = null) {
  const results = [];
  for (const id of ids) {
    try {
      results.push({ id, ...retryDeadLetter(db, id, actor) });
    } catch (error) {
      results.push({ id, error: error.message });
    }
  }
  auditIntegration(db, { actor, action: "integration.dead_letter.bulk_retry", resourceType: "integration_dead_letter", resourceId: null, details: { count: results.length } });
  return { retried: results.filter((r) => r.retried).length, results };
}

export function resolveDeadLetter(db, ref, { status = "closed", resolution = "", actor = null } = {}) {
  const row = getDeadLetterRow(db, ref);
  if (!row) throw new HttpError(404, "Dead-letter entry not found");
  if (!["ignored", "closed", "reprocessed"].includes(status)) throw new HttpError(400, "status must be ignored, closed or reprocessed");
  run(db, "UPDATE integration_dead_letters SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ?, updated_at = ? WHERE id = ?", [
    status,
    resolution,
    actor?.id ?? null,
    nowIso(),
    nowIso(),
    row.id,
  ]);
  auditIntegration(db, { actor, action: "integration.dead_letter.resolve", resourceType: "integration_dead_letter", resourceId: row.id, details: { status, resolution } });
  return publicDeadLetter(queryOne(db, "SELECT * FROM integration_dead_letters WHERE id = ?", [row.id]));
}

export function deadLetterStats(db, { tenantId } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_dead_letters ${where}`, params).c;
  const open = queryOne(db, `SELECT COUNT(*) AS c FROM integration_dead_letters ${where ? `${where} AND` : "WHERE"} status = 'open'`, params).c;
  const byCategory = queryAll(db, `SELECT error_category, COUNT(*) AS count FROM integration_dead_letters ${where} GROUP BY error_category`, params);
  return { total, open, by_category: byCategory };
}

export function deadLetterMessageFor(db, row) {
  return row?.message_id ? getMessageRow(db, row.message_id) : null;
}
