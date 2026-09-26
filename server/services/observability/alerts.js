// Alert rules and the alert lifecycle.
//
// An alert is the current state of a breached condition; alert *events* are the
// immutable timeline (created/acknowledged/suppressed/escalated/resolved). Rule
// evaluation supports deduplication, cooldown, aggregation, suppression and
// escalation so operators are not paged repeatedly for the same condition. All
// policy (severity, cooldown, incident auto-creation, notification) is data.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { notifyUser } from "../notifications.js";
import {
  ALERT_STATUSES,
  ALERT_OPEN_STATUSES,
  ALERT_TERMINAL_STATUSES,
  ALERT_EVENT_TYPES,
  SEVERITIES,
  SEVERITY_RANK,
  THRESHOLD_OPERATORS,
} from "./constants.js";
import { alertRuleRef, alertRef } from "./identifiers.js";
import { parseJson, stringifyJson, paged, tableExists } from "./repository.js";
import { alertRuleNotFound, alertRuleConflict, invalidAlertRule, alertNotFound, invalidAlert } from "./errors.js";
import { recordHistory } from "./history.js";
import { classifyMetric } from "./thresholds.js";
import { getMetricRow } from "./metrics.js";
import { getConfig, getNumericConfig } from "./configuration.js";
import { createIncident } from "./incidents.js";
import { observabilityEventCode, publishObservabilityEvent } from "./events.js";

// ── Rule DTO / CRUD ─────────────────────────────────────────────────────────
export function publicAlertRule(row) {
  if (!row) return null;
  return {
    id: row.id,
    rule_ref: row.rule_ref,
    tenant_id: row.tenant_id,
    code: row.code,
    name: row.name,
    description: row.description,
    metric_code: row.metric_code,
    condition: parseJson(row.condition_json, {}),
    severity: row.severity,
    scope: parseJson(row.scope_json, {}),
    for_seconds: row.for_seconds,
    cooldown_seconds: row.cooldown_seconds,
    dedup_key_template: row.dedup_key_template,
    auto_resolve: Boolean(row.auto_resolve),
    notification: parseJson(row.notification_json, {}),
    service_code: row.service_code,
    incident_severity: row.incident_severity,
    version: row.version,
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getAlertRuleRow(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) return queryOne(db, "SELECT * FROM observability_alert_rules WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
  return queryOne(db, "SELECT * FROM observability_alert_rules WHERE tenant_id = ? AND (rule_ref = ? OR code = ?)", [Number(tenantId), raw, raw]);
}

export function getAlertRule(db, tenantId, ref) {
  const row = getAlertRuleRow(db, tenantId, ref);
  if (!row) throw alertRuleNotFound(ref);
  return publicAlertRule(row);
}

function normalizeCondition(input = {}) {
  const operator = String(input.operator || "GT").toUpperCase();
  if (!THRESHOLD_OPERATORS.includes(operator)) throw invalidAlertRule(`Unsupported condition operator: ${input.operator}`);
  const value = Number(input.value);
  if (!Number.isFinite(value)) throw invalidAlertRule("Alert rule condition value must be numeric");
  return { operator, value };
}

function snapshotRuleVersion(db, row, actor) {
  run(
    db,
    "INSERT INTO observability_alert_rule_versions (rule_id, tenant_id, version, snapshot_json, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [row.id, row.tenant_id, row.version, stringifyJson(publicAlertRule(row)), actor?.id ?? null, nowIso()]
  );
}

export function createAlertRule(db, tenantId, input = {}, actor = null) {
  const code = String(input.code || "").trim().toUpperCase();
  if (!code) throw invalidAlertRule("Alert rule code is required");
  if (!input.metric_code) throw invalidAlertRule("metric_code is required");
  if (queryOne(db, "SELECT id FROM observability_alert_rules WHERE tenant_id = ? AND code = ?", [Number(tenantId), code])) throw alertRuleConflict(code);
  const severity = String(input.severity || "WARNING").toUpperCase();
  if (!SEVERITIES.includes(severity)) throw invalidAlertRule(`Unsupported severity: ${input.severity}`);
  const condition = normalizeCondition(input.condition || { operator: input.operator, value: input.value });
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO observability_alert_rules (rule_ref, tenant_id, code, name, description, metric_code, condition_json, severity, scope_json, for_seconds, cooldown_seconds, dedup_key_template, auto_resolve, notification_json, service_code, incident_severity, version, status, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [
      input.rule_ref || alertRuleRef(code),
      Number(tenantId),
      code,
      String(input.name || code),
      String(input.description || ""),
      String(input.metric_code).toUpperCase(),
      stringifyJson(condition),
      severity,
      stringifyJson(input.scope || {}),
      Math.max(0, Number(input.for_seconds) || 0),
      Math.max(0, Number(input.cooldown_seconds ?? 300)),
      String(input.dedup_key_template || ""),
      input.auto_resolve === false ? 0 : 1,
      stringifyJson(input.notification || {}),
      input.service_code ?? null,
      input.incident_severity ? String(input.incident_severity).toUpperCase() : null,
      String(input.status || "ACTIVE").toUpperCase(),
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM observability_alert_rules WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordHistory(db, { tenantId, action: "ALERT_RULE_CREATED", entityType: "alert_rule", entityId: row.id, entityRef: row.rule_ref, actor, summary: `Alert rule ${code} created` });
  writeAudit(db, { actor_id: actor?.id ?? null, actor_username: actor?.username ?? null, action: "observability.alert_rule.create", resource_type: "observability_alert_rule", resource_id: row.rule_ref, details: { code } });
  return publicAlertRule(row);
}

export function updateAlertRule(db, tenantId, ref, input = {}, actor = null) {
  const row = getAlertRuleRow(db, tenantId, ref);
  if (!row) throw alertRuleNotFound(ref);
  snapshotRuleVersion(db, row, actor);
  const condition = input.condition || input.operator !== undefined || input.value !== undefined
    ? normalizeCondition(input.condition || { operator: input.operator ?? parseJson(row.condition_json, {}).operator, value: input.value ?? parseJson(row.condition_json, {}).value })
    : parseJson(row.condition_json, {});
  const severity = input.severity ? String(input.severity).toUpperCase() : row.severity;
  if (!SEVERITIES.includes(severity)) throw invalidAlertRule(`Unsupported severity: ${input.severity}`);
  run(
    db,
    `UPDATE observability_alert_rules SET name = ?, description = ?, metric_code = ?, condition_json = ?, severity = ?, scope_json = ?, for_seconds = ?, cooldown_seconds = ?, dedup_key_template = ?, auto_resolve = ?, notification_json = ?, service_code = ?, incident_severity = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?`,
    [
      input.name ?? row.name,
      input.description ?? row.description,
      input.metric_code ? String(input.metric_code).toUpperCase() : row.metric_code,
      stringifyJson(condition),
      severity,
      input.scope !== undefined ? stringifyJson(input.scope) : row.scope_json,
      input.for_seconds !== undefined ? Math.max(0, Number(input.for_seconds)) : row.for_seconds,
      input.cooldown_seconds !== undefined ? Math.max(0, Number(input.cooldown_seconds)) : row.cooldown_seconds,
      input.dedup_key_template !== undefined ? String(input.dedup_key_template) : row.dedup_key_template,
      input.auto_resolve !== undefined ? (input.auto_resolve ? 1 : 0) : row.auto_resolve,
      input.notification !== undefined ? stringifyJson(input.notification) : row.notification_json,
      input.service_code !== undefined ? input.service_code : row.service_code,
      input.incident_severity !== undefined ? (input.incident_severity ? String(input.incident_severity).toUpperCase() : null) : row.incident_severity,
      input.status ? String(input.status).toUpperCase() : row.status,
      nowIso(),
      row.id,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM observability_alert_rules WHERE id = ?", [row.id]);
  recordHistory(db, { tenantId, action: "ALERT_RULE_UPDATED", entityType: "alert_rule", entityId: row.id, entityRef: row.rule_ref, actor, summary: `Alert rule ${row.code} updated` });
  return publicAlertRule(updated);
}

export function deleteAlertRule(db, tenantId, ref, actor = null) {
  const row = getAlertRuleRow(db, tenantId, ref);
  if (!row) throw alertRuleNotFound(ref);
  run(db, "UPDATE observability_alert_rules SET status = 'ARCHIVED', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  recordHistory(db, { tenantId, action: "ALERT_RULE_ARCHIVED", entityType: "alert_rule", entityId: row.id, entityRef: row.rule_ref, actor, summary: `Alert rule ${row.code} archived` });
  return { archived: true, rule_ref: row.rule_ref };
}

export function listAlertRules(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.metric_code || query.metricCode) {
    where.push("metric_code = ?");
    params.push(String(query.metric_code || query.metricCode).toUpperCase());
  }
  return paged(db, "observability_alert_rules", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicAlertRule });
}

export function listAlertRuleVersions(db, tenantId, ref) {
  const row = getAlertRuleRow(db, tenantId, ref);
  if (!row) throw alertRuleNotFound(ref);
  return queryAll(db, "SELECT * FROM observability_alert_rule_versions WHERE rule_id = ? ORDER BY version DESC", [row.id]).map((version) => ({
    id: version.id,
    rule_id: version.rule_id,
    version: version.version,
    snapshot: parseJson(version.snapshot_json, {}),
    created_by: version.created_by,
    created_at: version.created_at,
  }));
}

// ── Alert DTO / read ────────────────────────────────────────────────────────
export function publicAlert(row) {
  if (!row) return null;
  return {
    id: row.id,
    alert_ref: row.alert_ref,
    tenant_id: row.tenant_id,
    rule_id: row.rule_id,
    rule_code: row.rule_code,
    metric_code: row.metric_code,
    service_code: row.service_code,
    severity: row.severity,
    status: row.status,
    value: row.value,
    threshold: row.threshold,
    comparison: row.comparison,
    scope: parseJson(row.scope_json, {}),
    dedup_key: row.dedup_key,
    message: row.message,
    occurrence_count: row.occurrence_count,
    incident_id: row.incident_id,
    first_seen_at: row.first_seen_at,
    last_seen_at: row.last_seen_at,
    acknowledged_at: row.acknowledged_at,
    acknowledged_by: row.acknowledged_by,
    suppressed_until: row.suppressed_until,
    resolved_at: row.resolved_at,
    resolved_by: row.resolved_by,
    closed_at: row.closed_at,
    resolution: row.resolution,
    metadata: parseJson(row.metadata_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicAlertEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    alert_id: row.alert_id,
    tenant_id: row.tenant_id,
    event_type: row.event_type,
    value: row.value,
    actor_id: row.actor_id,
    message: row.message,
    detail: parseJson(row.detail_json, {}),
    created_at: row.created_at,
  };
}

export function getAlertRow(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const id = Number(raw);
  if (Number.isInteger(id) && id > 0) return queryOne(db, "SELECT * FROM observability_alerts WHERE tenant_id = ? AND id = ?", [Number(tenantId), id]);
  return queryOne(db, "SELECT * FROM observability_alerts WHERE tenant_id = ? AND alert_ref = ?", [Number(tenantId), raw]);
}

export function getAlert(db, tenantId, ref) {
  const row = getAlertRow(db, tenantId, ref);
  if (!row) throw alertNotFound(ref);
  return publicAlert(row);
}

export function listAlerts(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    const status = String(query.status).toUpperCase();
    where.push("status = ?");
    params.push(status);
  } else if (query.open === "true" || query.open === true) {
    where.push(`status IN (${ALERT_OPEN_STATUSES.map(() => "?").join(", ")})`);
    params.push(...ALERT_OPEN_STATUSES);
  }
  if (query.severity) {
    where.push("severity = ?");
    params.push(String(query.severity).toUpperCase());
  }
  if (query.metric_code || query.metricCode) {
    where.push("metric_code = ?");
    params.push(String(query.metric_code || query.metricCode).toUpperCase());
  }
  if (query.service_code || query.serviceCode) {
    where.push("service_code = ?");
    params.push(String(query.service_code || query.serviceCode));
  }
  if (query.rule_code || query.ruleCode) {
    where.push("rule_code = ?");
    params.push(String(query.rule_code || query.ruleCode).toUpperCase());
  }
  return paged(db, "observability_alerts", { where, params, orderBy: "last_seen_at DESC, id DESC", page: query.page, pageSize: query.page_size || query.pageSize, map: publicAlert });
}

export function listAlertEvents(db, tenantId, ref) {
  const row = getAlertRow(db, tenantId, ref);
  if (!row) throw alertNotFound(ref);
  return queryAll(db, "SELECT * FROM observability_alert_events WHERE alert_id = ? ORDER BY created_at ASC, id ASC", [row.id]).map(publicAlertEvent);
}

export function alertSummary(db, tenantId) {
  if (!tableExists(db, "observability_alerts")) return { total: 0, open: 0, by_severity: {}, by_status: {} };
  const rows = queryAll(db, "SELECT status, severity, COUNT(*) AS c FROM observability_alerts WHERE tenant_id = ? GROUP BY status, severity", [Number(tenantId)]);
  const summary = { total: 0, open: 0, by_severity: { INFO: 0, WARNING: 0, HIGH: 0, CRITICAL: 0 }, by_status: {} };
  for (const row of rows) {
    const count = Number(row.c);
    summary.total += count;
    summary.by_severity[row.severity] = (summary.by_severity[row.severity] || 0) + count;
    summary.by_status[row.status] = (summary.by_status[row.status] || 0) + count;
    if (ALERT_OPEN_STATUSES.includes(row.status)) summary.open += count;
  }
  return summary;
}

function recordAlertEvent(db, alert, eventType, { value = null, actor = null, message = "", detail = {} } = {}) {
  run(
    db,
    "INSERT INTO observability_alert_events (alert_id, tenant_id, event_type, value, actor_id, message, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [alert.id, alert.tenant_id, String(eventType), value, actor?.id ?? null, String(message || ""), stringifyJson(detail), nowIso()]
  );
}

// ── Lifecycle transitions ───────────────────────────────────────────────────
function reload(db, id) {
  return queryOne(db, "SELECT * FROM observability_alerts WHERE id = ?", [id]);
}

export function acknowledgeAlert(db, tenantId, ref, actor = null, { message = "" } = {}) {
  const row = getAlertRow(db, tenantId, ref);
  if (!row) throw alertNotFound(ref);
  if (ALERT_TERMINAL_STATUSES.includes(row.status)) throw invalidAlert(`Alert ${row.alert_ref} is already ${row.status}`);
  run(db, "UPDATE observability_alerts SET status = 'ACKNOWLEDGED', acknowledged_at = ?, acknowledged_by = ?, updated_at = ? WHERE id = ?", [nowIso(), actor?.id ?? null, nowIso(), row.id]);
  const updated = reload(db, row.id);
  recordAlertEvent(db, updated, "ACKNOWLEDGED", { actor, message: message || `Acknowledged by ${actor?.username || "system"}` });
  recordHistory(db, { tenantId, action: "ALERT_ACKNOWLEDGED", entityType: "alert", entityId: row.id, entityRef: row.alert_ref, actor, summary: `Alert ${row.alert_ref} acknowledged` });
  writeAudit(db, { actor_id: actor?.id ?? null, actor_username: actor?.username ?? null, action: "observability.alert.acknowledge", resource_type: "observability_alert", resource_id: row.alert_ref });
  publishObservabilityEvent(db, { eventType: observabilityEventCode("ALERT_ACKNOWLEDGED"), payload: { alert_ref: row.alert_ref, severity: row.severity }, objectType: "observability_alert", objectId: row.id, tenantId }, actor);
  return publicAlert(updated);
}

export function suppressAlert(db, tenantId, ref, { until = null, seconds = null, reason = "" } = {}, actor = null) {
  const row = getAlertRow(db, tenantId, ref);
  if (!row) throw alertNotFound(ref);
  const suppressedUntil = until || new Date(Date.now() + Math.max(60, Number(seconds) || 3600) * 1000).toISOString();
  run(db, "UPDATE observability_alerts SET status = 'SUPPRESSED', suppressed_until = ?, updated_at = ? WHERE id = ?", [suppressedUntil, nowIso(), row.id]);
  const updated = reload(db, row.id);
  recordAlertEvent(db, updated, "SUPPRESSED", { actor, message: reason || `Suppressed until ${suppressedUntil}`, detail: { until: suppressedUntil } });
  recordHistory(db, { tenantId, action: "ALERT_SUPPRESSED", entityType: "alert", entityId: row.id, entityRef: row.alert_ref, actor, summary: `Alert ${row.alert_ref} suppressed` });
  return publicAlert(updated);
}

export function unsuppressAlert(db, tenantId, ref, actor = null) {
  const row = getAlertRow(db, tenantId, ref);
  if (!row) throw alertNotFound(ref);
  run(db, "UPDATE observability_alerts SET status = CASE WHEN acknowledged_at IS NOT NULL THEN 'ACKNOWLEDGED' ELSE 'OPEN' END, suppressed_until = NULL, updated_at = ? WHERE id = ?", [nowIso(), row.id]);
  const updated = reload(db, row.id);
  recordAlertEvent(db, updated, "UNSUPPRESSED", { actor });
  return publicAlert(updated);
}

export function resolveAlert(db, tenantId, ref, actor = null, { resolution = "Resolved", auto = false } = {}) {
  const row = getAlertRow(db, tenantId, ref);
  if (!row) throw alertNotFound(ref);
  if (row.status === "RESOLVED" || row.status === "CLOSED") return publicAlert(row);
  run(db, "UPDATE observability_alerts SET status = 'RESOLVED', resolved_at = ?, resolved_by = ?, resolution = ?, updated_at = ? WHERE id = ?", [nowIso(), actor?.id ?? null, String(resolution), nowIso(), row.id]);
  const updated = reload(db, row.id);
  recordAlertEvent(db, updated, "RESOLVED", { actor, message: resolution, detail: { auto } });
  recordHistory(db, { tenantId, action: "ALERT_RESOLVED", entityType: "alert", entityId: row.id, entityRef: row.alert_ref, actor, summary: `Alert ${row.alert_ref} resolved`, detail: { auto } });
  writeAudit(db, { actor_id: actor?.id ?? null, actor_username: actor?.username ?? null, action: "observability.alert.resolve", resource_type: "observability_alert", resource_id: row.alert_ref, details: { auto } });
  publishObservabilityEvent(db, { eventType: observabilityEventCode("ALERT_RESOLVED"), payload: { alert_ref: row.alert_ref, severity: row.severity, auto }, objectType: "observability_alert", objectId: row.id, tenantId }, actor);
  return publicAlert(updated);
}

export function closeAlert(db, tenantId, ref, actor = null, { resolution = "" } = {}) {
  const row = getAlertRow(db, tenantId, ref);
  if (!row) throw alertNotFound(ref);
  run(db, "UPDATE observability_alerts SET status = 'CLOSED', closed_at = ?, resolution = CASE WHEN ? <> '' THEN ? ELSE resolution END, updated_at = ? WHERE id = ?", [nowIso(), String(resolution), String(resolution), nowIso(), row.id]);
  const updated = reload(db, row.id);
  recordAlertEvent(db, updated, "CLOSED", { actor, message: resolution });
  return publicAlert(updated);
}

export function commentAlert(db, tenantId, ref, { message = "" } = {}, actor = null) {
  const row = getAlertRow(db, tenantId, ref);
  if (!row) throw alertNotFound(ref);
  if (!String(message).trim()) throw invalidAlert("Comment message is required");
  recordAlertEvent(db, row, "COMMENTED", { actor, message: String(message) });
  return listAlertEvents(db, tenantId, ref);
}

export function pruneAlerts(db, tenantId, retainDays) {
  const days = Math.max(1, Number(retainDays) || 365);
  const result = run(db, "DELETE FROM observability_alerts WHERE tenant_id = ? AND status IN ('RESOLVED', 'CLOSED') AND updated_at < datetime('now', ?)", [Number(tenantId), `-${days} days`]);
  return Number(result.changes || 0);
}

// ── Evaluation ──────────────────────────────────────────────────────────────
function dedupKey(rule, metric, observation) {
  if (rule.dedup_key_template) {
    return String(rule.dedup_key_template)
      .replace(/\{rule\}/g, rule.code)
      .replace(/\{metric\}/g, metric.code)
      .replace(/\{service\}/g, rule.service_code || "platform")
      .replace(/\{scope\}/g, JSON.stringify(rule.scope || {}));
  }
  return `${rule.code}:${metric.code}:${rule.service_code || "platform"}`;
}

function breach(condition, value) {
  const operator = String(condition?.operator || "GT").toUpperCase();
  const target = Number(condition?.value);
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || !Number.isFinite(target)) return false;
  switch (operator) {
    case "GT":
      return numeric > target;
    case "GTE":
      return numeric >= target;
    case "LT":
      return numeric < target;
    case "LTE":
      return numeric <= target;
    case "EQ":
      return numeric === target;
    case "NEQ":
      return numeric !== target;
    default:
      return false;
  }
}

function findOpenByDedup(db, tenantId, key) {
  const placeholders = ALERT_OPEN_STATUSES.map(() => "?").join(", ");
  return queryOne(db, `SELECT * FROM observability_alerts WHERE tenant_id = ? AND dedup_key = ? AND status IN (${placeholders}) ORDER BY id DESC LIMIT 1`, [Number(tenantId), key, ...ALERT_OPEN_STATUSES]);
}

function recentTerminalByDedup(db, tenantId, key, cooldownSeconds) {
  return queryOne(
    db,
    `SELECT * FROM observability_alerts WHERE tenant_id = ? AND dedup_key = ? AND status IN ('RESOLVED', 'CLOSED') AND updated_at >= datetime('now', ?) ORDER BY id DESC LIMIT 1`,
    [Number(tenantId), key, `-${Math.max(0, Number(cooldownSeconds) || 0)} seconds`]
  );
}

function notifyRule(db, rule, alert, metric) {
  const config = getConfig(db, alert.tenant_id, "notify_on_alerts");
  if (!config) return;
  const recipients = new Set();
  const notification = rule.notification || {};
  for (const userId of Array.isArray(notification.user_ids) ? notification.user_ids : []) recipients.add(Number(userId));
  if (metric?.owner_user_id) recipients.add(Number(metric.owner_user_id));
  if (!recipients.size && rule.created_by) recipients.add(Number(rule.created_by));
  for (const userId of recipients) {
    if (!Number.isInteger(userId) || userId <= 0) continue;
    try {
      notifyUser(
        db,
        userId,
        {
          event_type: "observability.alert",
          source_module: "observability",
          object_type: "observability_alert",
          object_id: String(alert.id),
          object_name: alert.alert_ref,
          payload: { alert_ref: alert.alert_ref, severity: alert.severity, metric_code: alert.metric_code, value: alert.value, message: alert.message },
        },
        { tenantId: alert.tenant_id }
      );
    } catch {
      /* notification is best-effort and must never fail alert evaluation */
    }
  }
}

// Applies every active rule for a metric to a fresh observation. Returns a
// summary of state changes. Dedup/cooldown/precondition/for_seconds handling
// lives here so the collection engine stays thin.
export function applyAlertRules(db, tenantId, metric, observation, { actor = null, runId = null } = {}) {
  const summary = { evaluated: 0, created: 0, updated: 0, resolved: 0, escalated: 0, incidents_created: 0, alerts: [] };
  if (!metric) return summary;
  const rules = queryAll(db, "SELECT * FROM observability_alert_rules WHERE tenant_id = ? AND metric_code = ? AND status = 'ACTIVE'", [Number(tenantId), metric.code]);
  const value = observation?.value;
  const config = {
    autoIncidents: getConfig(db, tenantId, "auto_create_incidents"),
    incidentMinSeverity: String(getConfig(db, tenantId, "incident_min_severity") || "HIGH").toUpperCase(),
  };
  const classified = classifyMetric(db, tenantId, metric, value);
  for (const rawRule of rules) {
    const rule = publicAlertRule(rawRule);
    summary.evaluated += 1;
    const condition = rule.condition || {};
    const isBreach = breach(condition, value);
    const key = dedupKey(rule, metric, observation);
    const open = findOpenByDedup(db, tenantId, key);
    if (isBreach) {
      if (open) {
        const occurrence = Number(open.occurrence_count || 1) + 1;
        run(db, "UPDATE observability_alerts SET value = ?, threshold = ?, occurrence_count = ?, last_seen_at = ?, status = CASE WHEN status = 'SUPPRESSED' AND suppressed_until IS NOT NULL AND suppressed_until <= ? THEN 'OPEN' ELSE status END, suppressed_until = CASE WHEN suppressed_until IS NOT NULL AND suppressed_until <= ? THEN NULL ELSE suppressed_until END, updated_at = ? WHERE id = ?", [
          Number(value ?? open.value),
          Number(condition.value ?? open.threshold),
          occurrence,
          nowIso(),
          nowIso(),
          nowIso(),
          nowIso(),
          open.id,
        ]);
        const updated = reload(db, open.id);
        recordAlertEvent(db, updated, "UPDATED", { value: Number(value), message: `Observed ${value} (occurrence ${occurrence})`, detail: { threshold: condition.value } });
        summary.updated += 1;
        summary.alerts.push(publicAlert(updated));
        // Escalate severity if a higher band is observed than the rule default.
        const bandSeverity = classified.band === "CRITICAL" ? "CRITICAL" : classified.band === "WARNING" ? "WARNING" : null;
        if (bandSeverity && SEVERITY_RANK[bandSeverity] > SEVERITY_RANK[updated.severity]) {
          run(db, "UPDATE observability_alerts SET severity = ?, updated_at = ? WHERE id = ?", [bandSeverity, nowIso(), updated.id]);
          const escalated = reload(db, updated.id);
          recordAlertEvent(db, escalated, "ESCALATED", { value: Number(value), message: `Severity escalated to ${bandSeverity}`, detail: { previous: updated.severity, band: classified.band } });
          summary.escalated += 1;
          publishObservabilityEvent(db, { eventType: observabilityEventCode("THRESHOLD_BREACHED"), payload: { alert_ref: escalated.alert_ref, metric_code: metric.code, severity: bandSeverity, value, threshold: condition.value, band: classified.band }, objectType: "observability_alert", objectId: escalated.id, tenantId }, actor);
        }
      } else {
        const cooldown = recentTerminalByDedup(db, tenantId, key, rule.cooldown_seconds);
        if (cooldown) {
          // Within cooldown: suppress flapping by not re-raising immediately.
          continue;
        }
        const ts = nowIso();
        const severity = rule.severity;
        const insert = run(
          db,
          `INSERT INTO observability_alerts (alert_ref, tenant_id, rule_id, rule_code, metric_code, service_code, severity, status, value, threshold, comparison, scope_json, dedup_key, message, occurrence_count, first_seen_at, last_seen_at, metadata_json, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
          [
            alertRef(),
            Number(tenantId),
            rule.id,
            rule.code,
            metric.code,
            rule.service_code ?? metric.metadata?.service_code ?? null,
            severity,
            Number(value),
            Number(condition.value),
            condition.operator,
            stringifyJson(rule.scope || {}),
            key,
            `${rule.name}: ${metric.name} = ${value} (${condition.operator} ${condition.value})`,
            ts,
            ts,
            stringifyJson({ band: classified.band, run_id: runId }),
            rule.created_by ?? actor?.id ?? null,
            ts,
            ts,
          ]
        );
        let alert = reload(db, Number(insert.lastInsertRowid));
        recordAlertEvent(db, alert, "CREATED", { value: Number(value), message: alert.message, detail: { band: classified.band, threshold: condition.value } });
        summary.created += 1;
        publishObservabilityEvent(db, { eventType: observabilityEventCode("THRESHOLD_BREACHED"), payload: { alert_ref: alert.alert_ref, metric_code: metric.code, severity, value, threshold: condition.value, band: classified.band }, objectType: "observability_alert", objectId: alert.id, tenantId }, actor);
        publishObservabilityEvent(db, { eventType: observabilityEventCode("ALERT_CREATED"), payload: { alert_ref: alert.alert_ref, metric_code: metric.code, severity, value }, objectType: "observability_alert", objectId: alert.id, tenantId }, actor);
        recordHistory(db, { tenantId, action: "ALERT_CREATED", entityType: "alert", entityId: alert.id, entityRef: alert.alert_ref, actor, summary: `Alert ${alert.alert_ref} raised (${metric.code})` });
        if (config.autoIncidents && SEVERITY_RANK[severity] >= SEVERITY_RANK[config.incidentMinSeverity]) {
          try {
            const incident = createIncident(
              db,
              tenantId,
              {
                title: rule.incident_severity ? `${rule.name}` : `[${severity}] ${rule.name}`,
                description: alert.message,
                severity: rule.incident_severity || severity,
                service_code: rule.service_code,
                module_code: metric.provider_code,
                metric_code: metric.code,
                alert_id: alert.id,
              },
              actor
            );
            run(db, "UPDATE observability_alerts SET incident_id = ?, updated_at = ? WHERE id = ?", [incident.id, nowIso(), alert.id]);
            recordAlertEvent(db, alert, "INCIDENT_LINKED", { actor, message: `Linked incident ${incident.incident_ref}`, detail: { incident_ref: incident.incident_ref } });
            summary.incidents_created += 1;
            alert = reload(db, alert.id);
          } catch {
            /* incident creation is best-effort */
          }
        }
        notifyRule(db, rule, alert, metric);
        summary.alerts.push(publicAlert(alert));
      }
    } else if (open && rule.auto_resolve) {
      const resolved = resolveAlert(db, tenantId, open.alert_ref, actor, { resolution: `Auto-resolved: ${metric.code} back within threshold`, auto: true });
      summary.resolved += 1;
      summary.alerts.push(resolved);
    }
  }
  return summary;
}

// Unsuppresses alerts whose suppression window has elapsed. Invoked during
// collection so suppression is eventually consistent without a scheduler.
export function refreshSuppressions(db, tenantId) {
  const result = run(
    db,
    "UPDATE observability_alerts SET status = CASE WHEN acknowledged_at IS NOT NULL THEN 'ACKNOWLEDGED' ELSE 'OPEN' END, suppressed_until = NULL, updated_at = ? WHERE tenant_id = ? AND status = 'SUPPRESSED' AND suppressed_until IS NOT NULL AND suppressed_until <= ?",
    [nowIso(), Number(tenantId), nowIso()]
  );
  return Number(result.changes || 0);
}

export function alertTrend(db, tenantId, query = {}) {
  const hours = Math.max(1, Math.min(720, Number(query.hours) || 24));
  const rows = queryAll(
    db,
    "SELECT strftime('%Y-%m-%dT%H:00:00Z', created_at) AS bucket, severity, COUNT(*) AS c FROM observability_alerts WHERE tenant_id = ? AND created_at >= datetime('now', ?) GROUP BY bucket, severity ORDER BY bucket ASC",
    [Number(tenantId), `-${hours} hours`]
  );
  const buckets = {};
  for (const row of rows) {
    buckets[row.bucket] = buckets[row.bucket] || { bucket: row.bucket, INFO: 0, WARNING: 0, HIGH: 0, CRITICAL: 0, total: 0 };
    buckets[row.bucket][row.severity] = Number(row.c);
    buckets[row.bucket].total += Number(row.c);
  }
  return { hours, points: Object.values(buckets) };
}

export { SEVERITIES, ALERT_STATUSES, ALERT_EVENT_TYPES };
