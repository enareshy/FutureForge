import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { assertAlertSeverity } from "./validation.js";

// Operational alerts. Raised automatically when a delivery dead-letters or a
// provider repeatedly fails, and surfaced on the operational dashboard so
// operators can acknowledge them.

export function publicAlert(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    severity: row.severity,
    tenant_id: row.tenant_id ?? null,
    provider_id: row.provider_id ?? null,
    provider_code: row.provider_code || "",
    request_id: row.request_id ?? null,
    channel: row.channel || "",
    message: row.message || "",
    status: row.status,
    acknowledged_by: row.acknowledged_by ?? null,
    acknowledged_at: row.acknowledged_at || null,
    created_at: row.created_at,
  };
}

export function createAlert(db, { type = "delivery_failed", severity = "warning", tenantId = null, providerId = null, providerCode = "", requestId = null, channel = "", message = "" } = {}) {
  assertAlertSeverity(severity);
  const result = run(
    db,
    `INSERT INTO delivery_alerts (type, severity, tenant_id, provider_id, provider_code, request_id, channel, message, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    [type, severity, tenantId ?? null, providerId ?? null, providerCode || "", requestId ?? null, channel || "", String(message || ""), nowIso()]
  );
  return publicAlert(queryOne(db, "SELECT * FROM delivery_alerts WHERE id = ?", [result.lastInsertRowid]));
}

export function listAlerts(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  if (tenantId) {
    where.push("COALESCE(tenant_id, 0) = ?");
    params.push(Number(tenantId));
  }
  if (query.status) {
    where.push("status = ?");
    params.push(query.status);
  }
  if (query.severity) {
    where.push("severity = ?");
    params.push(query.severity);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM delivery_alerts ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT * FROM delivery_alerts ${clause} ORDER BY status = 'open' DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicAlert);
  const open = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM delivery_alerts WHERE status = 'open' ${tenantId ? "AND COALESCE(tenant_id, 0) = ?" : ""}`,
    tenantId ? [Number(tenantId)] : []
  ).c;
  return { items, total, page, pageSize, open };
}

export function acknowledgeAlert(db, id, { actor = null, ip = null } = {}) {
  void ip;
  const row = queryOne(db, "SELECT * FROM delivery_alerts WHERE id = ?", [Number(id)]);
  if (!row) throw new HttpError(404, "Delivery alert not found");
  run(
    db,
    "UPDATE delivery_alerts SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ? WHERE id = ?",
    [actor?.id ?? null, nowIso(), row.id]
  );
  return publicAlert(queryOne(db, "SELECT * FROM delivery_alerts WHERE id = ?", [row.id]));
}
