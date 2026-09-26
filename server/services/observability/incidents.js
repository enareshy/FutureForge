// Incident tracking.
//
// Incidents group related alerts and manual reports into a single owned record
// with a lifecycle (OPEN → ACKNOWLEDGED → INVESTIGATING → MITIGATED →
// RESOLVED → CLOSED). Auto-creation from high-severity alerts is policy driven
// (see configuration), never hard-coded.
import { queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { INCIDENT_STATUSES, INCIDENT_OPEN_STATUSES, SEVERITIES } from "./constants.js";
import { incidentRef } from "./identifiers.js";
import { parseJson, stringifyJson, paged } from "./repository.js";
import { incidentNotFound, invalidIncident } from "./errors.js";
import { recordHistory } from "./history.js";
import { observabilityEventCode, publishObservabilityEvent } from "./events.js";

export function publicIncident(row) {
  if (!row) return null;
  return {
    id: row.id,
    incident_ref: row.incident_ref,
    tenant_id: row.tenant_id,
    title: row.title,
    description: row.description,
    severity: row.severity,
    status: row.status,
    service_code: row.service_code,
    module_code: row.module_code,
    metric_code: row.metric_code,
    alert_id: row.alert_id,
    owner_user_id: row.owner_user_id,
    opened_at: row.opened_at,
    acknowledged_at: row.acknowledged_at,
    resolved_at: row.resolved_at,
    closed_at: row.closed_at,
    resolution: row.resolution,
    metadata: parseJson(row.metadata_json, {}),
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getIncidentRow(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) return queryOne(db, "SELECT * FROM observability_incidents WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
  return queryOne(db, "SELECT * FROM observability_incidents WHERE tenant_id = ? AND (incident_ref = ? OR title = ?)", [Number(tenantId), raw, raw]);
}

export function getIncident(db, tenantId, ref) {
  const row = getIncidentRow(db, tenantId, ref);
  if (!row) throw incidentNotFound(ref);
  return publicIncident(row);
}

export function createIncident(db, tenantId, input = {}, actor = null) {
  if (!input.title || !String(input.title).trim()) throw invalidIncident("Incident title is required");
  const severity = String(input.severity || "HIGH").toUpperCase();
  if (!SEVERITIES.includes(severity)) throw invalidIncident(`Unsupported severity: ${input.severity}`);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO observability_incidents (incident_ref, tenant_id, title, description, severity, status, service_code, module_code, metric_code, alert_id, owner_user_id, opened_at, metadata_json, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.incident_ref || incidentRef(),
      Number(tenantId),
      String(input.title).trim(),
      String(input.description || ""),
      severity,
      String(input.status || "OPEN").toUpperCase(),
      input.service_code ?? null,
      input.module_code ?? null,
      input.metric_code ?? null,
      input.alert_id ?? null,
      input.owner_user_id ?? actor?.id ?? null,
      ts,
      stringifyJson(input.metadata || {}),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM observability_incidents WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordHistory(db, { tenantId, action: "INCIDENT_CREATED", entityType: "incident", entityId: row.id, entityRef: row.incident_ref, actor, summary: `Incident opened: ${row.title}` });
  writeAudit(db, { actor_id: actor?.id ?? null, actor_username: actor?.username ?? null, action: "observability.incident.create", resource_type: "observability_incident", resource_id: row.incident_ref, details: { severity } });
  publishObservabilityEvent(db, { eventType: observabilityEventCode("INCIDENT_CREATED"), payload: { incident_ref: row.incident_ref, severity, service_code: row.service_code }, objectType: "observability_incident", objectId: row.id, tenantId }, actor);
  return publicIncident(row);
}

function transition(db, row, nextStatus, actor, { resolution = null, patch = {} } = {}) {
  const status = String(nextStatus).toUpperCase();
  if (!INCIDENT_STATUSES.includes(status)) throw invalidIncident(`Unsupported incident status: ${nextStatus}`);
  const ts = nowIso();
  const acknowledgedAt = status === "ACKNOWLEDGED" && !row.acknowledged_at ? ts : row.acknowledged_at;
  const resolvedAt = status === "RESOLVED" && !row.resolved_at ? ts : row.resolved_at;
  const closedAt = status === "CLOSED" && !row.closed_at ? ts : row.closed_at;
  run(
    db,
    `UPDATE observability_incidents SET status = ?, title = ?, description = ?, severity = ?, owner_user_id = ?, acknowledged_at = ?, resolved_at = ?, closed_at = ?, resolution = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
    [
      status,
      patch.title ?? row.title,
      patch.description ?? row.description,
      patch.severity ?? row.severity,
      patch.owner_user_id ?? row.owner_user_id,
      acknowledgedAt,
      resolvedAt,
      closedAt,
      resolution ?? row.resolution,
      patch.metadata !== undefined ? stringifyJson(patch.metadata) : row.metadata_json,
      ts,
      row.id,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM observability_incidents WHERE id = ?", [row.id]);
  recordHistory(db, { tenantId: row.tenant_id, action: `INCIDENT_${status}`, entityType: "incident", entityId: row.id, entityRef: row.incident_ref, actor, summary: `Incident ${row.incident_ref} -> ${status}` });
  if (status === "RESOLVED") {
    publishObservabilityEvent(db, { eventType: observabilityEventCode("INCIDENT_RESOLVED"), payload: { incident_ref: row.incident_ref, resolution: resolution ?? row.resolution }, objectType: "observability_incident", objectId: row.id, tenantId: row.tenant_id }, actor);
  }
  return publicIncident(updated);
}

export function updateIncident(db, tenantId, ref, input = {}, actor = null) {
  const row = getIncidentRow(db, tenantId, ref);
  if (!row) throw incidentNotFound(ref);
  if (input.status) return transition(db, row, input.status, actor, { resolution: input.resolution, patch: input });
  run(
    db,
    `UPDATE observability_incidents SET title = ?, description = ?, severity = ?, service_code = ?, module_code = ?, metric_code = ?, owner_user_id = ?, metadata_json = ?, updated_at = ? WHERE id = ?`,
    [
      input.title ?? row.title,
      input.description ?? row.description,
      input.severity ? String(input.severity).toUpperCase() : row.severity,
      input.service_code !== undefined ? input.service_code : row.service_code,
      input.module_code !== undefined ? input.module_code : row.module_code,
      input.metric_code !== undefined ? input.metric_code : row.metric_code,
      input.owner_user_id !== undefined ? input.owner_user_id : row.owner_user_id,
      input.metadata !== undefined ? stringifyJson(input.metadata) : row.metadata_json,
      nowIso(),
      row.id,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM observability_incidents WHERE id = ?", [row.id]);
  recordHistory(db, { tenantId, action: "INCIDENT_UPDATED", entityType: "incident", entityId: row.id, entityRef: row.incident_ref, actor, summary: `Incident ${row.incident_ref} updated` });
  return publicIncident(updated);
}

export function linkAlert(db, tenantId, ref, alertId, actor = null) {
  const row = getIncidentRow(db, tenantId, ref);
  if (!row) throw incidentNotFound(ref);
  run(db, "UPDATE observability_incidents SET alert_id = COALESCE(alert_id, ?), updated_at = ? WHERE id = ?", [alertId ?? null, nowIso(), row.id]);
  run(db, "UPDATE observability_alerts SET incident_id = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [row.id, nowIso(), alertId ?? null, Number(tenantId)]);
  return publicIncident(queryOne(db, "SELECT * FROM observability_incidents WHERE id = ?", [row.id]));
}

export function listIncidents(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  } else if (query.open === "true" || query.open === true) {
    where.push(`status IN (${INCIDENT_OPEN_STATUSES.map(() => "?").join(", ")})`);
    params.push(...INCIDENT_OPEN_STATUSES);
  }
  if (query.severity) {
    where.push("severity = ?");
    params.push(String(query.severity).toUpperCase());
  }
  if (query.service_code || query.serviceCode) {
    where.push("service_code = ?");
    params.push(String(query.service_code || query.serviceCode));
  }
  return paged(db, "observability_incidents", { where, params, orderBy: "opened_at DESC, id DESC", page: query.page, pageSize: query.page_size || query.pageSize, map: publicIncident });
}

export function incidentSummary(db, tenantId) {
  const rows = queryOne(
    db,
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status IN (${INCIDENT_OPEN_STATUSES.map(() => "?").join(", ")}) THEN 1 ELSE 0 END) AS open,
       SUM(CASE WHEN severity = 'CRITICAL' AND status IN (${INCIDENT_OPEN_STATUSES.map(() => "?").join(", ")}) THEN 1 ELSE 0 END) AS critical_open
     FROM observability_incidents WHERE tenant_id = ?`,
    [...INCIDENT_OPEN_STATUSES, ...INCIDENT_OPEN_STATUSES, Number(tenantId)]
  );
  return {
    total: Number(rows?.total || 0),
    open: Number(rows?.open || 0),
    critical_open: Number(rows?.critical_open || 0),
  };
}

export function pruneIncidents(db, tenantId, retainDays) {
  const days = Math.max(1, Number(retainDays) || 730);
  const result = run(db, "DELETE FROM observability_incidents WHERE tenant_id = ? AND status IN ('RESOLVED', 'CLOSED') AND updated_at < datetime('now', ?)", [Number(tenantId), `-${days} days`]);
  return Number(result.changes || 0);
}
