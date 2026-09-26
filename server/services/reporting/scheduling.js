// Scheduled report runs and distribution (§23, §24).
//
// A schedule binds a report, dashboard or KPI to a cadence and a distribution
// list. Scheduling reuses the same execution engine as ad-hoc runs so a
// scheduled result is authorized, cached and audited identically. The platform
// worker drives due schedules; this service only computes cadence and executes.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { writeAudit } from "../audit.js";
import { SCHEDULE_FREQUENCIES, SCHEDULE_STATUSES, EXPORT_FORMATS, NATIVE_EXPORT_FORMATS } from "./constants.js";
import { scheduleNotFound, invalidSchedule } from "./errors.js";
import { scheduleRef as makeScheduleRef } from "./identifiers.js";
import { publicSchedule, stringifyJson, paged } from "./repository.js";
import { getReport, executeReport, runReport } from "./reports.js";
import { getDashboard, refreshDashboard } from "./dashboards.js";
import { getKpi, getKpiValue } from "./kpis.js";
import { executeExport } from "./exports.js";
import { publishReportingEvent } from "./events.js";
import { recordHistory } from "./history.js";

function parseRecipients(input) {
  if (!input) return [];
  const list = Array.isArray(input) ? input : String(input).split(",").map((entry) => entry.trim());
  return list.filter(Boolean).map((entry) => (typeof entry === "string" ? { type: "USER", value: entry } : entry));
}

function validateSchedule(db, tenantId, input = {}) {
  const targetType = String(input.target_type || input.targetType || "REPORT").toUpperCase();
  if (!["REPORT", "DASHBOARD", "KPI"].includes(targetType)) throw invalidSchedule(`Unsupported schedule target: ${targetType}`);
  const frequency = String(input.frequency || "DAILY").toUpperCase();
  if (!SCHEDULE_FREQUENCIES.includes(frequency)) throw invalidSchedule(`Unsupported schedule frequency: ${frequency}`);
  if (input.cron && !isValidCron(input.cron)) throw invalidSchedule(`Invalid cron expression: ${input.cron}`);
  const format = input.format ? String(input.format).toUpperCase() : "CSV";
  if (!EXPORT_FORMATS.includes(format)) throw invalidSchedule(`Unsupported schedule format: ${format}`);
  if (targetType === "REPORT" && !input.report_id && !input.report_code) throw invalidSchedule("A report target is required");
  if (targetType === "DASHBOARD" && !input.dashboard_id && !input.dashboard_code) throw invalidSchedule("A dashboard target is required");
  if (targetType === "KPI" && !input.kpi_id && !input.kpi_code) throw invalidSchedule("A KPI target is required");
  return {
    name: input.name ? String(input.name).trim() : `${targetType} schedule`,
    target_type: targetType,
    report_id: input.report_id ?? null,
    dashboard_id: input.dashboard_id ?? null,
    kpi_id: input.kpi_id ?? null,
    report_code: input.report_code ? String(input.report_code).toUpperCase() : "",
    frequency,
    cron: input.cron ? String(input.cron) : "",
    timezone: input.timezone ? String(input.timezone) : "UTC",
    format: format,
    recipients: parseRecipients(input.recipients),
    parameters: input.parameters || {},
    distribution: input.distribution || {},
    status: input.status ? String(input.status).toUpperCase() : "ACTIVE",
  };
}

export function createSchedule(db, tenantId, input = {}, actor = null, ip = null) {
  const normalized = validateSchedule(db, tenantId, input);
  if (normalized.target_type === "REPORT") {
    const report = getReport(db, tenantId, normalized.report_id || normalized.report_code);
    normalized.report_id = report.id;
    normalized.report_code = report.code;
  }
  if (normalized.target_type === "DASHBOARD") {
    const dashboard = getDashboard(db, tenantId, normalized.dashboard_id || input.dashboard_code);
    normalized.dashboard_id = dashboard.id;
  }
  if (normalized.target_type === "KPI") {
    const kpi = getKpi(db, tenantId, normalized.kpi_id || input.kpi_code);
    normalized.kpi_id = kpi.id;
  }
  if (!SCHEDULE_STATUSES.includes(normalized.status)) throw invalidSchedule(`Unsupported schedule status: ${normalized.status}`);
  const ts = nowIso();
  const nextRun = normalized.frequency === "ONCE" ? input.run_at || ts : computeNextRun(normalized);
  const result = run(
    db,
    `INSERT INTO reporting_schedules (schedule_ref, tenant_id, name, target_type, report_id, dashboard_id, kpi_id, frequency, cron, timezone, format, recipients_json, parameters_json, distribution_json, status, next_run_at, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      makeScheduleRef(),
      Number(tenantId),
      normalized.name,
      normalized.target_type,
      normalized.report_id,
      normalized.dashboard_id,
      normalized.kpi_id,
      normalized.frequency,
      normalized.cron,
      normalized.timezone,
      normalized.format,
      stringifyJson(normalized.recipients, "[]"),
      stringifyJson(normalized.parameters),
      stringifyJson(normalized.distribution),
      normalized.status,
      nextRun,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  writeAudit(db, { actor, action: "reporting.schedule.create", resourceType: "reporting_schedule", resourceId: String(result.lastInsertRowid), details: { target_type: normalized.target_type, frequency: normalized.frequency }, sourceModule: "reporting", ip });
  publishReportingEvent(db, { eventType: "ReportUpdated", payload: { action: "schedule_created", target_type: normalized.target_type }, objectType: "reporting_schedule", tenantId }, actor);
  return getScheduleById(db, Number(tenantId), Number(result.lastInsertRowid));
}

export function getScheduleById(db, tenantId, id) {
  return publicSchedule(queryOne(db, "SELECT * FROM reporting_schedules WHERE id = ? AND tenant_id = ?", [Number(id), Number(tenantId)]));
}

export function getSchedule(db, tenantId, ref) {
  const raw = String(ref ?? "");
  const row = /^\d+$/.test(raw)
    ? queryOne(db, "SELECT * FROM reporting_schedules WHERE id = ? AND tenant_id = ?", [Number(raw), Number(tenantId)])
    : queryOne(db, "SELECT * FROM reporting_schedules WHERE tenant_id = ? AND schedule_ref = ?", [Number(tenantId), raw]);
  if (!row) throw scheduleNotFound(ref);
  return publicSchedule(row);
}

export function listSchedules(db, tenantId, query = {}) {
  const where = ["tenant_id = ?"];
  const params = [Number(tenantId)];
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status).toUpperCase());
  }
  if (query.target_type || query.targetType) {
    where.push("target_type = ?");
    params.push(String(query.target_type || query.targetType).toUpperCase());
  }
  return paged(db, "reporting_schedules", { where, params, page: query.page, pageSize: query.page_size || query.pageSize, map: publicSchedule });
}

export function updateSchedule(db, tenantId, ref, input = {}, actor = null) {
  const existing = getSchedule(db, tenantId, ref);
  const normalized = validateSchedule(db, tenantId, { ...existing, ...input, report_id: existing.report_id, dashboard_id: existing.dashboard_id, kpi_id: existing.kpi_id });
  run(
    db,
    `UPDATE reporting_schedules SET name = ?, frequency = ?, cron = ?, timezone = ?, format = ?, recipients_json = ?, parameters_json = ?, distribution_json = ?, status = ?, next_run_at = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?`,
    [
      normalized.name,
      normalized.frequency,
      normalized.cron,
      normalized.timezone,
      normalized.format,
      stringifyJson(normalized.recipients, "[]"),
      stringifyJson(normalized.parameters),
      stringifyJson(normalized.distribution),
      normalized.status,
      computeNextRun({ ...normalized, status: normalized.status }),
      nowIso(),
      existing.id,
      Number(tenantId),
    ]
  );
  writeAudit(db, { actor, action: "reporting.schedule.update", resourceType: "reporting_schedule", resourceId: existing.schedule_ref, sourceModule: "reporting" });
  return getScheduleById(db, Number(tenantId), existing.id);
}

export function setScheduleStatus(db, tenantId, ref, status, actor = null) {
  const existing = getSchedule(db, tenantId, ref);
  const next = String(status || "").toUpperCase();
  if (!SCHEDULE_STATUSES.includes(next)) throw invalidSchedule(`Unsupported schedule status: ${status}`);
  const nextRun = next === "ACTIVE" ? computeNextRun({ ...existing, status: existing.status }) : existing.next_run_at;
  run(db, "UPDATE reporting_schedules SET status = ?, next_run_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?", [next, nextRun, nowIso(), existing.id, Number(tenantId)]);
  writeAudit(db, { actor, action: "reporting.schedule.status", resourceType: "reporting_schedule", resourceId: existing.schedule_ref, details: { status: next }, sourceModule: "reporting" });
  return getScheduleById(db, Number(tenantId), existing.id);
}

export function deleteSchedule(db, tenantId, ref) {
  const existing = getSchedule(db, tenantId, ref);
  run(db, "DELETE FROM reporting_schedules WHERE id = ? AND tenant_id = ?", [existing.id, Number(tenantId)]);
  return { deleted: true, schedule_ref: existing.schedule_ref };
}

export function dueSchedules(db, tenantId, asOf = nowIso()) {
  return queryAll(db, "SELECT * FROM reporting_schedules WHERE tenant_id = ? AND status = 'ACTIVE' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC", [Number(tenantId), asOf]).map(publicSchedule);
}

// Executes a schedule once: runs its target and records the run. Distribution
// is recorded as a delivery summary (transport is owned by Notifications).
export function runSchedule(db, tenantId, ref, actor = null, ip = null) {
  const schedule = getSchedule(db, tenantId, ref);
  const context = { parameters: schedule.parameters, mode: "SCHEDULED", enableCache: false };
  let outcome;
  if (schedule.target_type === "REPORT") {
    const report = getReport(db, tenantId, schedule.report_id);
    const result = executeReport(db, tenantId, report.code, context, actor, ip);
    outcome = { target_type: "REPORT", report: report.code, rows: result.total, execution_ref: result.execution_ref };
    if (schedule.format && NATIVE_EXPORT_FORMATS.includes(schedule.format)) {
      outcome.export = executeExport(db, tenantId, ensureExportRow(db, tenantId, report, schedule, actor).export_ref, { parameters: schedule.parameters }, actor, ip);
    }
  } else if (schedule.target_type === "DASHBOARD") {
    const dashboard = refreshDashboard(db, tenantId, schedule.dashboard_id, context, actor, ip);
    outcome = { target_type: "DASHBOARD", dashboard: dashboard.code, widgets: dashboard.widgets.length };
  } else {
    const kpi = getKpiValue(db, tenantId, schedule.kpi_id, context);
    outcome = { target_type: "KPI", kpi: kpi.kpi, value: kpi.value, status: kpi.status };
  }
  const delivered = schedule.recipients.length;
  const nextRun = computeNextRun(schedule);
  run(db, "UPDATE reporting_schedules SET last_run_at = ?, next_run_at = ?, status = CASE WHEN frequency = 'ONCE' THEN 'COMPLETED' ELSE status END, updated_at = ? WHERE id = ? AND tenant_id = ?", [
    nowIso(),
    schedule.frequency === "ONCE" ? null : nextRun,
    nowIso(),
    schedule.id,
    Number(tenantId),
  ]);
  publishReportingEvent(db, { eventType: "ReportExecuted", payload: { schedule: schedule.schedule_ref, target_type: schedule.target_type, delivered }, objectType: "reporting_schedule", tenantId }, actor);
  recordHistory(db, { tenantId, action: "SCHEDULE_RUN", entity_type: "schedule", entity_id: schedule.id, entity_ref: schedule.schedule_ref, actor_id: actor?.id, summary: `Ran schedule ${schedule.schedule_ref}`, detail: { ...outcome, delivered } });
  return { schedule_ref: schedule.schedule_ref, ...outcome, delivered, next_run_at: nextRun };
}

function ensureExportRow(db, tenantId, report, schedule, actor) {
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO reporting_exports (export_ref, tenant_id, report_id, format, status, parameters_json, created_by, created_at)
     VALUES (?, ?, ?, ?, 'QUEUED', ?, ?, ?)`,
    [`EXP-${schedule.schedule_ref}`, Number(tenantId), report.id, schedule.format, stringifyJson(schedule.parameters), actor?.id ?? null, ts]
  );
  return { id: Number(result.lastInsertRowid), export_ref: `EXP-${schedule.schedule_ref}` };
}

// ── Cadence ──────────────────────────────────────────────────────────────────

const CRON_FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
];

export function isValidCron(expression) {
  const fields = String(expression).trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => matchesCronField(field, CRON_FIELDS[index]));
}

function matchesCronField(field, bounds) {
  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!stepMatch) return false;
    const step = stepMatch[2] ? Number(stepMatch[2]) : 1;
    if (step < 1) return false;
    if (stepMatch[1] === "*") continue;
    const [start, end] = stepMatch[1].includes("-") ? stepMatch[1].split("-").map(Number) : [Number(stepMatch[1]), Number(stepMatch[1])];
    if (start < bounds.min || end > bounds.max || start > end) return false;
  }
  return true;
}

function cronFieldMatches(field, value) {
  return field.split(",").some((part) => {
    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
    if (!stepMatch) return false;
    const step = stepMatch[2] ? Number(stepMatch[2]) : 1;
    if (stepMatch[1] === "*") return value % step === 0;
    const [start, end] = stepMatch[1].includes("-") ? stepMatch[1].split("-").map(Number) : [Number(stepMatch[1]), Number(stepMatch[1])];
    return value >= start && value <= end && (value - start) % step === 0;
  });
}

export function computeNextRun(schedule, from = new Date()) {
  const status = String(schedule.status || "ACTIVE").toUpperCase();
  if (status !== "ACTIVE" && status !== "PAUSED") return schedule.next_run_at || null;
  const base = from instanceof Date ? new Date(from.getTime()) : new Date(from);
  if (schedule.cron) {
    const candidate = new Date(base.getTime());
    candidate.setSeconds(0, 0);
    candidate.setMinutes(candidate.getMinutes() + 1);
    for (let i = 0; i < 60 * 24 * 366; i += 1) {
      const fields = schedule.cron.trim().split(/\s+/);
      if (
        cronFieldMatches(fields[0], candidate.getMinutes()) &&
        cronFieldMatches(fields[1], candidate.getHours()) &&
        cronFieldMatches(fields[2], candidate.getDate()) &&
        cronFieldMatches(fields[3], candidate.getMonth() + 1) &&
        cronFieldMatches(fields[4], candidate.getDay())
      ) {
        return candidate.toISOString();
      }
      candidate.setMinutes(candidate.getMinutes() + 1);
    }
    return null;
  }
  const frequency = String(schedule.frequency || "DAILY").toUpperCase();
  const next = new Date(base.getTime());
  next.setSeconds(0, 0);
  if (frequency === "HOURLY") {
    next.setHours(next.getHours() + 1, 0, 0, 0);
  } else if (frequency === "DAILY") {
    next.setDate(next.getDate() + 1);
    next.setHours(2, 0, 0, 0);
  } else if (frequency === "WEEKLY") {
    next.setDate(next.getDate() + ((8 - next.getDay()) % 7 || 7));
    next.setHours(2, 0, 0, 0);
  } else if (frequency === "MONTHLY") {
    next.setMonth(next.getMonth() + 1, 1);
    next.setHours(2, 0, 0, 0);
  } else if (frequency === "ONCE") {
    return schedule.next_run_at || base.toISOString();
  }
  return next.toISOString();
}
