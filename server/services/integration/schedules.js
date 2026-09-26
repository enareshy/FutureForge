// Scheduled integrations. Integration-specific metadata lives here while the
// actual cadence is delegated to the shared Background Job scheduler so the
// platform keeps a single scheduling engine, lock and run history.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import * as jobExecution from "../job-execution.js";
import { publicSchedule } from "./repository.js";
import { OVERLAP_POLICIES, SCHEDULE_TYPES, assertEnum, safeParse, toJson } from "./validation.js";
import { auditIntegration, log } from "./hooks.js";

const ENGINE_JOB_TYPE = "INTEGRATION_SYNC";
const ENGINE_QUEUE = "INTEGRATION";

function whereFrom({ tenantId, integrationId, status, q } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (integrationId) {
    clauses.push("integration_id = ?");
    params.push(Number(integrationId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (q) {
    clauses.push("(LOWER(code) LIKE ? OR LOWER(name) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listSchedules(db, options = {}) {
  const { page = 1, pageSize = 50 } = options;
  const { where, params } = whereFrom(options);
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM integration_schedules ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM integration_schedules ${where} ORDER BY next_run_at IS NULL, next_run_at, code LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map((r) => publicSchedule(r)), total, page: Number(page), page_size: Number(pageSize) };
}

export function getScheduleRow(db, ref) {
  const id = Number(ref);
  return queryOne(db, "SELECT * FROM integration_schedules WHERE id = ? OR code = ?", [Number.isFinite(id) ? id : -1, String(ref)]);
}

export function getSchedule(db, ref, scope = {}) {
  const row = getScheduleRow(db, ref);
  if (!row) throw new HttpError(404, "Integration schedule not found");
  if (scope.tenantId !== undefined && scope.tenantId !== null && row.tenant_id && Number(row.tenant_id) !== Number(scope.tenantId)) {
    throw new HttpError(404, "Integration schedule not found");
  }
  return publicSchedule(row);
}

function validate(input, { partial = false } = {}) {
  if (!partial || input.schedule_type !== undefined) assertEnum(input.schedule_type ?? "interval", SCHEDULE_TYPES, "schedule_type");
  if (!partial || input.overlap_policy !== undefined) assertEnum(input.overlap_policy ?? "skip", OVERLAP_POLICIES, "overlap_policy");
  if ((input.schedule_type === "cron") && !input.cron_expression) throw new HttpError(400, "cron_expression is required for cron schedules");
  if ((input.schedule_type === "interval") && !(Number(input.interval_seconds) > 0)) {
    throw new HttpError(400, "interval_seconds must be greater than zero for interval schedules");
  }
}

// Creates (or reconciles) the underlying engine schedule. Failures are logged
// and surfaced as a warning instead of blocking the integration schedule.
function materializeEngineSchedule(db, row, actor) {
  try {
    const payload = {
      code: `intg_${String(row.code).toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+/, "")}`,
      name: row.name,
      description: row.description,
      job_type_code: ENGINE_JOB_TYPE,
      queue: ENGINE_QUEUE,
      priority: "normal",
      schedule_type: row.schedule_type,
      cron_expression: row.cron_expression,
      interval_seconds: row.interval_seconds,
      daily_time: row.daily_time,
      weekdays: safeParse(row.weekdays_json, []),
      day_of_month: row.day_of_month,
      timezone: row.timezone,
      start_at: row.start_at,
      end_at: row.end_at,
      concurrency_policy: row.overlap_policy,
      catchup_policy: row.catchup_policy,
      timeout_seconds: row.max_duration_seconds,
      payload_json: { integration_id: row.integration_id, integration_code: row.code, trigger_type: "schedule" },
      tenant_id: row.tenant_id,
    };
    const existing = queryOne(db, "SELECT * FROM job_schedules WHERE code = ?", [payload.code]);
    const engine = existing
      ? jobExecution.updateSchedule(db, existing.id, payload, actor, "integration")
      : jobExecution.createSchedule(db, payload, actor, "integration");
    run(db, "UPDATE integration_schedules SET job_schedule_code = ?, next_run_at = ?, updated_at = ? WHERE id = ?", [
      engine.code,
      engine.next_run_at || null,
      nowIso(),
      row.id,
    ]);
    return engine;
  } catch (error) {
    log("warn", "integration.schedule.materialize_failed", { code: row.code, error: error.message });
    return null;
  }
}

export function createSchedule(db, input = {}, actor = null, tenantId = null) {
  if (!input.code) throw new HttpError(400, "code is required");
  validate(input);
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO integration_schedules
      (code, name, description, integration_id, schedule_type, cron_expression, interval_seconds, daily_time,
       weekdays_json, day_of_month, timezone, start_at, end_at, overlap_policy, catchup_policy, max_duration_seconds,
       status, config_json, tenant_id, organization_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      String(input.code).toLowerCase(),
      input.name || input.code,
      input.description || "",
      input.integration_id ?? null,
      input.schedule_type || "interval",
      input.cron_expression || "",
      Number(input.interval_seconds) || 0,
      input.daily_time || "",
      toJson(input.weekdays, []),
      Number(input.day_of_month) || 0,
      input.timezone || "UTC",
      input.start_at || null,
      input.end_at || null,
      input.overlap_policy || "skip",
      input.catchup_policy || "skip",
      Number(input.max_duration_seconds) || 0,
      input.status || "active",
      toJson(input.config, {}),
      tenantId ?? input.tenant_id ?? null,
      input.organization_id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  let row = queryOne(db, "SELECT * FROM integration_schedules WHERE id = ?", [Number(result.lastInsertRowid)]);
  materializeEngineSchedule(db, row, actor);
  row = queryOne(db, "SELECT * FROM integration_schedules WHERE id = ?", [row.id]);
  auditIntegration(db, { actor, action: "integration.schedule.create", resourceType: "integration_schedule", resourceId: row.id, details: { code: row.code, schedule_type: row.schedule_type } });
  return publicSchedule(row);
}

export function updateSchedule(db, ref, input = {}, actor = null) {
  const row = getScheduleRow(db, ref);
  if (!row) throw new HttpError(404, "Integration schedule not found");
  validate(input, { partial: true });
  run(
    db,
    `UPDATE integration_schedules SET name=?, description=?, integration_id=?, schedule_type=?, cron_expression=?,
       interval_seconds=?, daily_time=?, weekdays_json=?, day_of_month=?, timezone=?, start_at=?, end_at=?,
       overlap_policy=?, catchup_policy=?, max_duration_seconds=?, status=?, config_json=?, updated_at=? WHERE id=?`,
    [
      input.name ?? row.name,
      input.description ?? row.description,
      input.integration_id !== undefined ? input.integration_id : row.integration_id,
      input.schedule_type ?? row.schedule_type,
      input.cron_expression !== undefined ? input.cron_expression : row.cron_expression,
      input.interval_seconds !== undefined ? Number(input.interval_seconds) : row.interval_seconds,
      input.daily_time !== undefined ? input.daily_time : row.daily_time,
      input.weekdays !== undefined ? toJson(input.weekdays, []) : row.weekdays_json,
      input.day_of_month !== undefined ? Number(input.day_of_month) : row.day_of_month,
      input.timezone ?? row.timezone,
      input.start_at !== undefined ? input.start_at : row.start_at,
      input.end_at !== undefined ? input.end_at : row.end_at,
      input.overlap_policy ?? row.overlap_policy,
      input.catchup_policy ?? row.catchup_policy,
      input.max_duration_seconds !== undefined ? Number(input.max_duration_seconds) : row.max_duration_seconds,
      input.status ?? row.status,
      input.config !== undefined ? toJson(input.config, {}) : row.config_json,
      nowIso(),
      row.id,
    ]
  );
  let updated = queryOne(db, "SELECT * FROM integration_schedules WHERE id = ?", [row.id]);
  materializeEngineSchedule(db, updated, actor);
  updated = queryOne(db, "SELECT * FROM integration_schedules WHERE id = ?", [row.id]);
  auditIntegration(db, { actor, action: "integration.schedule.update", resourceType: "integration_schedule", resourceId: row.id, details: { code: row.code } });
  return publicSchedule(updated);
}

export function setScheduleStatus(db, ref, status, actor = null) {
  assertEnum(status, ["active", "paused", "inactive"], "status");
  const row = getScheduleRow(db, ref);
  if (!row) throw new HttpError(404, "Integration schedule not found");
  run(db, "UPDATE integration_schedules SET status = ?, updated_at = ? WHERE id = ?", [status, nowIso(), row.id]);
  try {
    if (row.job_schedule_code) jobExecution.setScheduleStatus(db, row.job_schedule_code, status === "inactive" ? "disabled" : status, actor, "integration");
  } catch (error) {
    log("warn", "integration.schedule.status_failed", { code: row.code, error: error.message });
  }
  auditIntegration(db, { actor, action: "integration.schedule.status", resourceType: "integration_schedule", resourceId: row.id, details: { code: row.code, status } });
  return publicSchedule(queryOne(db, "SELECT * FROM integration_schedules WHERE id = ?", [row.id]));
}

export function runScheduleNow(db, ref, actor = null) {
  const row = getScheduleRow(db, ref);
  if (!row) throw new HttpError(404, "Integration schedule not found");
  try {
    if (row.job_schedule_code) {
      const result = jobExecution.runScheduleNow(db, row.job_schedule_code, { actor });
      run(db, "UPDATE integration_schedules SET last_run_at = ?, last_status = 'queued', updated_at = ? WHERE id = ?", [nowIso(), nowIso(), row.id]);
      auditIntegration(db, { actor, action: "integration.schedule.run", resourceType: "integration_schedule", resourceId: row.id, details: { code: row.code, job: result?.job_ref || null } });
      return { ran: true, job: result };
    }
    return { ran: false, reason: "No engine schedule is attached", schedule: publicSchedule(row) };
  } catch (error) {
    log("warn", "integration.schedule.run_failed", { code: row.code, error: error.message });
    return { ran: false, reason: error.message, schedule: publicSchedule(row) };
  }
}

export function deleteSchedule(db, ref, actor = null) {
  const row = getScheduleRow(db, ref);
  if (!row) throw new HttpError(404, "Integration schedule not found");
  run(db, "DELETE FROM integration_schedules WHERE id = ?", [row.id]);
  auditIntegration(db, { actor, action: "integration.schedule.delete", resourceType: "integration_schedule", resourceId: row.id, details: { code: row.code } });
  return { deleted: true, id: row.id };
}
