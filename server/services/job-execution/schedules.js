// Recurring schedule administration + dispatch.
//
// A schedule is a rule, not a job: when it is due the engine materialises a
// concrete job (with tenant/security context), enqueues it, records a
// `job_schedule_runs` row and computes the next occurrence. Duplicate
// execution is prevented by the unique (schedule_id, scheduled_for) key plus
// the engine-level scheduler lock.

import { queryAll, queryOne, run, nowIso, randomUuid } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { truncate, TERMINAL_STATUSES, safeParse } from "../jobs/validation.js";
import { submitJob, cancelJob } from "../jobs/jobs.js";
import { recordHistory } from "../jobs/history.js";
import { getJobTypeRow } from "../jobs/types.js";
import { nextRunAt, describeSchedule } from "./recurrence.js";
import { canonicalQueue, normalizeScheduleInput, assertScheduleStatus } from "./validation.js";
import { acquireLock, releaseLock } from "./locks.js";
import { recordEngineAudit } from "./audit.js";
import { requestSignal } from "./signals.js";
import { parseSqlTime, parseInstant } from "./timezone.js";

const SCHEDULER_LOCK = "engine:scheduler";
const SORTABLE = new Set(["code", "name", "next_run_at", "last_run_at", "created_at", "updated_at", "execution_count", "failure_count"]);

function scheduleRef() {
  return `SCH-${randomUuid().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

function withDefaults(fields = {}) {
  return {
    schedule_type: "once",
    cron_expression: "",
    interval_seconds: 0,
    daily_time: "00:00",
    weekdays_json: "[]",
    day_of_month: 1,
    timezone: "UTC",
    start_at: null,
    end_at: null,
    max_executions: 0,
    ...fields,
  };
}

export function publicSchedule(row) {
  if (!row) return null;
  let weekdays = [];
  try {
    weekdays = JSON.parse(row.weekdays_json || "[]");
  } catch {
    weekdays = [];
  }
  return {
    id: row.id,
    schedule_ref: row.schedule_ref,
    code: row.code,
    name: row.name,
    description: row.description || "",
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    job_type_code: row.job_type_code,
    queue: row.queue,
    canonical_queue: canonicalQueue(row.queue),
    priority: row.priority,
    schedule_type: row.schedule_type,
    schedule_text: describeSchedule(row),
    cron_expression: row.cron_expression || "",
    interval_seconds: row.interval_seconds,
    daily_time: row.daily_time,
    weekdays,
    day_of_month: row.day_of_month,
    timezone: row.timezone,
    start_at: row.start_at || null,
    end_at: row.end_at || null,
    max_executions: row.max_executions,
    max_retries: row.max_retries,
    timeout_seconds: row.timeout_seconds,
    retry_strategy: row.retry_strategy,
    retry_delay_seconds: row.retry_delay_seconds,
    failure_policy: row.failure_policy,
    concurrency_policy: row.concurrency_policy,
    catchup_policy: row.catchup_policy,
    payload: safeParse(row.payload_json, {}),
    status: row.status,
    enabled: row.enabled === 1,
    submitted_as: row.submitted_as,
    execution_count: row.execution_count,
    failure_count: row.failure_count,
    consecutive_failures: row.consecutive_failures,
    last_run_at: row.last_run_at || null,
    last_status: row.last_status || "",
    last_job_id: row.last_job_id ?? null,
    last_error: row.last_error || "",
    next_run_at: row.next_run_at || null,
    config: safeParse(row.config_json, {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function getScheduleRow(db, ref) {
  const row = queryOne(
    db,
    "SELECT * FROM job_schedules WHERE id = ? OR schedule_ref = ? OR code = ? OR code = ?",
    [Number(ref) || -1, String(ref || ""), String(ref || ""), String(ref || "").toUpperCase()]
  );
  if (!row) throw new HttpError(404, "Schedule not found");
  return row;
}

export function getSchedule(db, ref, tenantId = null) {
  const row = getScheduleRow(db, ref);
  if (tenantId !== null && tenantId !== undefined && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Schedule not found");
  }
  return publicSchedule(row);
}

export function listSchedules(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  const scoped = tenantId ?? (query.tenantId !== undefined && query.tenantId !== "" ? Number(query.tenantId) : null);
  if (scoped !== null && scoped !== undefined) {
    where.push("COALESCE(tenant_id, 0) = ?");
    params.push(Number(scoped));
  }
  if (query.status) {
    where.push("status = ?");
    params.push(String(query.status));
  }
  if (query.enabled === "true" || query.enabled === true) where.push("enabled = 1");
  if (query.enabled === "false" || query.enabled === false) where.push("enabled = 0");
  if (query.schedule_type || query.type) {
    where.push("schedule_type = ?");
    params.push(String(query.schedule_type || query.type));
  }
  if (query.job_type_code) {
    where.push("job_type_code = ?");
    params.push(String(query.job_type_code).toUpperCase());
  }
  if (query.queue) {
    where.push("queue = ?");
    params.push(String(query.queue));
  }
  if (query.q) {
    const like = `%${query.q}%`;
    where.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM job_schedules ${clause}`, params).c;
  const sort = SORTABLE.has(String(query.sort || "")) ? String(query.sort) : "next_run_at";
  const dir = String(query.order || "").toLowerCase() === "desc" ? "DESC" : "ASC";
  const items = queryAll(
    db,
    `SELECT * FROM job_schedules ${clause} ORDER BY ${sort} ${dir}, id ASC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicSchedule);

  const summary = queryOne(
    db,
    `SELECT
        SUM(CASE WHEN enabled = 1 AND status = 'active' THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END) AS paused,
        SUM(CASE WHEN status = 'disabled' THEN 1 ELSE 0 END) AS disabled,
        SUM(CASE WHEN status IN ('completed', 'expired') THEN 1 ELSE 0 END) AS finished
       FROM job_schedules ${scoped !== null && scoped !== undefined ? "WHERE COALESCE(tenant_id, 0) = ?" : ""}`,
    scoped !== null && scoped !== undefined ? [Number(scoped)] : []
  );
  return {
    items,
    total,
    page,
    pageSize,
    summary: {
      active: summary?.active || 0,
      paused: summary?.paused || 0,
      disabled: summary?.disabled || 0,
      finished: summary?.finished || 0,
    },
  };
}

function assertJobType(db, code) {
  const type = getJobTypeRow(db, code);
  if (!type) throw new HttpError(400, `Unknown job type: ${code}`);
  return type;
}

// Catch-up policy: when a schedule start is already in the past and the policy
// allows catching up, the missed occurrence becomes due immediately.
function applyCatchup(schedule, nextAt) {
  const policy = schedule.catchup_policy || "skip";
  if (policy === "skip") return nextAt;
  const start = parseInstant(schedule.start_at, schedule.timezone || "UTC");
  if (!start || start.getTime() > Date.now()) return nextAt;
  const end = parseInstant(schedule.end_at, schedule.timezone || "UTC");
  if (end && end.getTime() <= Date.now()) return nextAt;
  return nowIso();
}

export function createSchedule(db, input = {}, actor = null, ip = null) {
  const fields = normalizeScheduleInput(db, input, { partial: false });
  const type = assertJobType(db, fields.job_type_code);
  if (fields.queue === undefined || !fields.queue) fields.queue = safeParse(type.queues_json, ["DEFAULT"])[0];

  const resolved = withDefaults(fields);
  const nextAt = applyCatchup(withDefaults(resolved), nextRunAt(resolved, new Date()));
  const status = fields.status || "active";
  const enabled = fields.enabled === undefined ? (status === "active" ? 1 : 0) : fields.enabled;
  const ts = nowIso();
  const tenantId = fields.tenant_id !== undefined && fields.tenant_id !== null ? Number(fields.tenant_id) : actor?.tenant_id ?? null;
  const organizationId = input.organization_id !== undefined ? Number(input.organization_id) || null : actor?.organization_id ?? null;

  const result = run(
    db,
    `INSERT INTO job_schedules
      (schedule_ref, code, name, description, tenant_id, organization_id, job_type_code, queue, priority,
       schedule_type, cron_expression, interval_seconds, daily_time, weekdays_json, day_of_month, timezone,
       start_at, end_at, max_executions, max_retries, timeout_seconds, retry_strategy, retry_delay_seconds,
       failure_policy, concurrency_policy, catchup_policy, payload_json, status, enabled, submitted_as,
       execution_count, failure_count, consecutive_failures, next_run_at, config_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'schedule',
             0, 0, 0, ?, ?, ?, ?, ?, ?)`,
    [
      scheduleRef(),
      fields.code,
      fields.name || fields.code,
      fields.description || "",
      tenantId,
      organizationId,
      fields.job_type_code,
      fields.queue,
      fields.priority || "normal",
      resolved.schedule_type,
      resolved.cron_expression,
      resolved.interval_seconds,
      resolved.daily_time,
      resolved.weekdays_json,
      resolved.day_of_month,
      resolved.timezone,
      resolved.start_at,
      resolved.end_at,
      resolved.max_executions,
      fields.max_retries || 0,
      fields.timeout_seconds || 0,
      fields.retry_strategy || "exponential",
      fields.retry_delay_seconds === undefined ? 30 : fields.retry_delay_seconds,
      fields.failure_policy || "continue",
      fields.concurrency_policy || "allow",
      fields.catchup_policy || "skip",
      JSON.stringify(safeParse(fields.payload_json, {})),
      status,
      enabled,
      nextAt,
      JSON.stringify(safeParse(fields.config_json, {})),
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM job_schedules WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordEngineAudit(db, {
    tenantId: row.tenant_id,
    entityType: "schedule",
    entityId: row.id,
    entityCode: row.code,
    action: "create",
    actor,
    detail: { job_type_code: row.job_type_code, schedule_type: row.schedule_type, next_run_at: row.next_run_at },
    ip,
  });
  return publicSchedule(row);
}

export function updateSchedule(db, ref, input = {}, actor = null, ip = null) {
  const row = getScheduleRow(db, ref);
  if (input.job_type_code || input.jobTypeCode) assertJobType(db, String(input.job_type_code || input.jobTypeCode).toUpperCase());
  const fields = normalizeScheduleInput(db, input, { partial: true });
  const merged = withDefaults({ ...row, ...fields });
  // Recompute cadence when the timing definition or state changes.
  const timingChanged =
    input.schedule_type ||
    input.scheduleType ||
    input.cron_expression !== undefined ||
    input.cronExpression !== undefined ||
    input.interval_seconds !== undefined ||
    input.intervalSeconds !== undefined ||
    input.daily_time !== undefined ||
    input.dailyTime !== undefined ||
    input.weekdays !== undefined ||
    input.weekdays_json !== undefined ||
    input.day_of_month !== undefined ||
    input.dayOfMonth !== undefined ||
    input.timezone !== undefined ||
    input.start_at !== undefined ||
    input.startAt !== undefined ||
    input.end_at !== undefined ||
    input.endAt !== undefined;
  const status = input.status !== undefined ? String(input.status) : row.status;
  assertScheduleStatus(status);
  const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : row.enabled;

  let nextRun = row.next_run_at;
  if (status !== "active" || enabled !== 1) nextRun = row.next_run_at;
  else if (timingChanged || !row.next_run_at) nextRun = applyCatchup(withDefaults({ ...row, ...fields }), nextRunAt(merged, new Date()));

  const ts = nowIso();
  run(
    db,
    `UPDATE job_schedules SET
       name = ?, description = ?, job_type_code = ?, queue = ?, priority = ?, schedule_type = ?,
       cron_expression = ?, interval_seconds = ?, daily_time = ?, weekdays_json = ?, day_of_month = ?,
       timezone = ?, start_at = ?, end_at = ?, max_executions = ?, max_retries = ?, timeout_seconds = ?,
       retry_strategy = ?, retry_delay_seconds = ?, failure_policy = ?, concurrency_policy = ?, catchup_policy = ?,
       payload_json = ?, status = ?, enabled = ?, next_run_at = ?, config_json = ?, updated_by = ?, updated_at = ?
     WHERE id = ?`,
    [
      fields.name ?? row.name,
      fields.description ?? row.description,
      fields.job_type_code ?? row.job_type_code,
      fields.queue ?? row.queue,
      fields.priority ?? row.priority,
      merged.schedule_type,
      merged.cron_expression,
      merged.interval_seconds,
      merged.daily_time,
      merged.weekdays_json,
      merged.day_of_month,
      merged.timezone,
      merged.start_at,
      merged.end_at,
      merged.max_executions,
      fields.max_retries ?? row.max_retries,
      fields.timeout_seconds ?? row.timeout_seconds,
      fields.retry_strategy ?? row.retry_strategy,
      fields.retry_delay_seconds ?? row.retry_delay_seconds,
      fields.failure_policy ?? row.failure_policy,
      fields.concurrency_policy ?? row.concurrency_policy,
      fields.catchup_policy ?? row.catchup_policy,
      fields.payload_json ?? row.payload_json,
      status,
      enabled,
      nextRun,
      fields.config_json ?? row.config_json,
      actor?.id ?? null,
      ts,
      row.id,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM job_schedules WHERE id = ?", [row.id]);
  recordEngineAudit(db, {
    tenantId: updated.tenant_id,
    entityType: "schedule",
    entityId: updated.id,
    entityCode: updated.code,
    action: "update",
    actor,
    detail: {
      before: { status: row.status, next_run_at: row.next_run_at, schedule_type: row.schedule_type },
      after: { status: updated.status, next_run_at: updated.next_run_at, schedule_type: updated.schedule_type },
    },
    ip,
  });
  return publicSchedule(updated);
}

export function setScheduleStatus(db, ref, status, actor = null, ip = null) {
  assertScheduleStatus(status);
  const row = getScheduleRow(db, ref);
  const merged = withDefaults({ ...row });
  let nextRun = row.next_run_at;
  if (status === "active") {
    nextRun = nextRunAt(merged, new Date());
    if (row.status === "completed" || row.status === "expired") nextRun = nextRunAt(merged, new Date());
  }
  const enabled = status === "active" ? 1 : status === "paused" ? row.enabled : 0;
  run(
    db,
    "UPDATE job_schedules SET status = ?, enabled = ?, next_run_at = ?, updated_by = ?, updated_at = ? WHERE id = ?",
    [status, enabled, nextRun, actor?.id ?? null, nowIso(), row.id]
  );
  recordEngineAudit(db, {
    tenantId: row.tenant_id,
    entityType: "schedule",
    entityId: row.id,
    entityCode: row.code,
    action: status,
    actor,
    detail: { previous_status: row.status },
    ip,
  });
  return publicSchedule(queryOne(db, "SELECT * FROM job_schedules WHERE id = ?", [row.id]));
}

export function setScheduleEnabled(db, ref, enabled, actor = null, ip = null) {
  const row = getScheduleRow(db, ref);
  return setScheduleStatus(db, row.id, enabled ? "active" : "disabled", actor, ip);
}

function submitScheduleJob(db, schedule, scheduledFor) {
  const idempotencyKey = `schedule:${schedule.id}:${scheduledFor}`;
  const job = submitJob(
    db,
    {
      job_type_code: schedule.job_type_code,
      name: schedule.name,
      description: schedule.description,
      queue: schedule.queue,
      priority: schedule.priority,
      submitted_as: "schedule",
      tenant_id: schedule.tenant_id,
      organization_id: schedule.organization_id,
      input: safeParse(schedule.payload_json, {}),
      timeout_seconds: schedule.timeout_seconds,
      max_retries: schedule.max_retries,
      idempotency_key: idempotencyKey,
      correlation_id: `schedule-${schedule.code}`,
      source_module: "scheduler",
    },
    { actor: schedule.created_by ? { id: schedule.created_by, tenant_id: schedule.tenant_id, organization_id: schedule.organization_id } : null }
  );
  if (!job.duplicate) {
    run(db, "UPDATE jobs SET schedule_id = ?, execution_group = ?, updated_at = ? WHERE id = ?", [
      schedule.id,
      schedule.schedule_ref || schedule.code,
      nowIso(),
      job.id,
    ]);
  }
  return job;
}

function advanceNextRun(db, schedule, scheduledFor) {
  const count = Number(schedule.execution_count) || 0;
  const from = parseSqlTime(scheduledFor) || new Date();
  let next = nextRunAt(withDefaults(schedule), from);
  const now = nowIso();
  if (next && next <= now && (schedule.catchup_policy || "skip") !== "run_all") {
    // Skip missed occurrences after downtime.
    let guard = 0;
    while (next && next <= now && guard < 1000) {
      next = nextRunAt(withDefaults(schedule), parseSqlTime(next) || from);
      guard += 1;
    }
  }
  const maxExecutions = Number(schedule.max_executions) || 0;
  const endAt = schedule.end_at || null;
  let status = schedule.status;
  let enabled = schedule.enabled;
  if (maxExecutions > 0 && count >= maxExecutions) {
    next = null;
    status = "completed";
    enabled = 0;
  } else if (!next) {
    status = endAt && endAt <= now ? "expired" : "completed";
    enabled = 0;
  } else if (endAt && next > endAt) {
    next = null;
    status = "expired";
    enabled = 0;
  }
  run(
    db,
    "UPDATE job_schedules SET next_run_at = ?, status = ?, enabled = ?, execution_count = ?, last_run_at = ?, last_job_id = ?, last_status = ?, last_error = '', updated_at = ? WHERE id = ?",
    [next, status, enabled, count, scheduledFor, schedule.last_job_id ?? null, schedule.last_status || "enqueued", now, schedule.id]
  );
  return next;
}

// Materialises due schedules. Guarded by a distributed lock so multiple
// scheduler replicas cannot double-dispatch.
export function sweepSchedules(db, { limit = 50 } = {}) {
  const owner = `scheduler-${randomUuid().replace(/-/g, "").slice(0, 8)}`;
  const acquired = acquireLock(db, SCHEDULER_LOCK, owner, { ttlSeconds: 30, purpose: "schedule sweep" });
  if (!acquired) return { locked: false, due: 0, enqueued: 0, skipped: 0, reconciled: 0 };

  const summary = { locked: true, due: 0, enqueued: 0, skipped: 0, reconciled: 0 };
  try {
    const now = nowIso();
    const due = queryAll(
      db,
      `SELECT * FROM job_schedules
        WHERE enabled = 1 AND status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
        ORDER BY next_run_at ASC LIMIT ?`,
      [now, Math.max(1, Math.min(500, Number(limit) || 50))]
    );
    summary.due = due.length;

    for (const schedule of due) {
      const scheduledFor = schedule.next_run_at;
      try {
        const activeJobs = queryAll(
          db,
          `SELECT id, status, job_ref FROM jobs WHERE schedule_id = ? AND status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(", ")})`,
          [schedule.id, ...TERMINAL_STATUSES]
        );
        if (activeJobs.length && schedule.concurrency_policy === "skip") {
          run(
            db,
            `INSERT OR IGNORE INTO job_schedule_runs (schedule_id, job_id, scheduled_for, status, detail_json, created_at, updated_at)
             VALUES (?, NULL, ?, 'skipped', ?, ?, ?)`,
            [schedule.id, scheduledFor, JSON.stringify({ reason: "previous_run_active", active_job_ids: activeJobs.map((job) => job.id) }), nowIso(), nowIso()]
          );
          advanceNextRun(db, schedule, scheduledFor);
          summary.skipped += 1;
          continue;
        }
        if (activeJobs.length && schedule.concurrency_policy === "cancel_previous") {
          for (const active of activeJobs) {
            cancelJob(db, active.id, { reason: "Superseded by newer schedule run" });
            requestSignal(active.id, "Superseded by newer schedule run");
          }
        }

        const insert = run(
          db,
          `INSERT OR IGNORE INTO job_schedule_runs (schedule_id, job_id, scheduled_for, status, detail_json, created_at, updated_at)
           VALUES (?, NULL, ?, 'pending', '{}', ?, ?)`,
          [schedule.id, scheduledFor, nowIso(), nowIso()]
        );
        if (insert.changes !== 1) {
          // Already materialised by a previous sweep; just advance.
          advanceNextRun(db, schedule, scheduledFor);
          continue;
        }
        const runId = Number(insert.lastInsertRowid);
        const job = submitScheduleJob(db, schedule, scheduledFor);
        run(
          db,
          "UPDATE job_schedule_runs SET job_id = ?, status = 'enqueued', updated_at = ? WHERE id = ?",
          [job.id, nowIso(), runId]
        );
        const fresh = queryOne(db, "SELECT * FROM job_schedules WHERE id = ?", [schedule.id]);
        run(db, "UPDATE job_schedules SET execution_count = ?, last_job_id = ?, updated_at = ? WHERE id = ?", [
          (Number(fresh.execution_count) || 0) + 1,
          job.id,
          nowIso(),
          schedule.id,
        ]);
        advanceNextRun(db, { ...fresh, execution_count: (Number(fresh.execution_count) || 0) + 1, last_job_id: job.id, last_status: "enqueued" }, scheduledFor);
        summary.enqueued += 1;
      } catch (error) {
        run(
          db,
          `UPDATE job_schedule_runs SET status = 'failed', detail_json = ?, updated_at = ?
             WHERE schedule_id = ? AND scheduled_for = ?`,
          [JSON.stringify({ error: error.message }), nowIso(), schedule.id, scheduledFor]
        );
        run(db, "UPDATE job_schedules SET last_status = 'failed', last_error = ?, failure_count = failure_count + 1, consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE id = ?", [
          truncate(error.message, 2000),
          nowIso(),
          schedule.id,
        ]);
        advanceNextRun(db, schedule, scheduledFor);
      }
    }

    summary.reconciled = reconcileScheduleRuns(db, due.map((schedule) => schedule.id));
  } finally {
    releaseLock(db, SCHEDULER_LOCK, owner);
  }
  return summary;
}

// Maps terminal job outcomes back onto schedule runs and applies the schedule
// failure policy. Failures never auto-disable a schedule unless the policy says
// so.
export function reconcileScheduleRuns(db, scheduleIds = null) {
  const params = [];
  let clause = "";
  if (scheduleIds && scheduleIds.length) {
    clause = `AND r.schedule_id IN (${scheduleIds.map(() => "?").join(", ")})`;
    params.push(...scheduleIds);
  }
  const runs = queryAll(
    db,
    `SELECT r.*, j.status AS job_status, j.error_message AS job_error, j.job_ref AS job_ref
       FROM job_schedule_runs r JOIN jobs j ON j.id = r.job_id
      WHERE r.status IN ('pending', 'enqueued', 'running')
        AND j.status IN (${TERMINAL_STATUSES.map(() => "?").join(", ")})
        ${clause}`,
    [...TERMINAL_STATUSES, ...params]
  );
  let reconciled = 0;
  for (const entry of runs) {
    const mapped = entry.job_status === "completed" ? "completed" : entry.job_status;
    run(
      db,
      "UPDATE job_schedule_runs SET status = ?, detail_json = ?, updated_at = ? WHERE id = ?",
      [mapped, JSON.stringify({ job_status: entry.job_status, error: entry.job_error || "" }), nowIso(), entry.id]
    );
    const schedule = queryOne(db, "SELECT * FROM job_schedules WHERE id = ?", [entry.schedule_id]);
    if (!schedule) continue;
    if (mapped === "completed") {
      run(
        db,
        "UPDATE job_schedules SET last_status = 'completed', last_error = '', consecutive_failures = 0, updated_at = ? WHERE id = ?",
        [nowIso(), schedule.id]
      );
    } else {
      run(
        db,
        "UPDATE job_schedules SET last_status = ?, last_error = ?, failure_count = failure_count + 1, consecutive_failures = consecutive_failures + 1, updated_at = ? WHERE id = ?",
        [mapped, truncate(entry.job_error || "", 2000), nowIso(), schedule.id]
      );
      if (schedule.failure_policy === "disable") {
        run(db, "UPDATE job_schedules SET status = 'disabled', enabled = 0, updated_at = ? WHERE id = ?", [nowIso(), schedule.id]);
      } else if (schedule.failure_policy === "pause") {
        run(db, "UPDATE job_schedules SET status = 'paused', updated_at = ? WHERE id = ?", [nowIso(), schedule.id]);
      }
    }
    reconciled += 1;
  }
  return reconciled;
}

// Manual "run now": dispatches immediately without disturbing the cadence.
export function runScheduleNow(db, ref, { actor = null, ip = null } = {}) {
  const row = getScheduleRow(db, ref);
  if (row.status === "disabled") throw new HttpError(409, "Schedule is disabled");
  const now = nowIso();
  const insert = run(
    db,
    `INSERT OR IGNORE INTO job_schedule_runs (schedule_id, job_id, scheduled_for, status, detail_json, created_at, updated_at)
     VALUES (?, NULL, ?, 'pending', ?, ?, ?)`,
    [row.id, now, JSON.stringify({ manual: true, actor_id: actor?.id ?? null }), now, now]
  );
  const runId = insert.changes === 1 ? Number(insert.lastInsertRowid) : queryOne(db, "SELECT id FROM job_schedule_runs WHERE schedule_id = ? AND scheduled_for = ?", [row.id, now])?.id;
  const job = submitScheduleJob(db, row, `manual:${now}`);
  run(db, "UPDATE job_schedule_runs SET job_id = ?, status = 'enqueued', updated_at = ? WHERE id = ?", [job.id, nowIso(), runId]);
  run(
    db,
    "UPDATE job_schedules SET execution_count = execution_count + 1, last_run_at = ?, last_job_id = ?, last_status = 'enqueued', updated_at = ? WHERE id = ?",
    [now, job.id, nowIso(), row.id]
  );
  recordHistory(db, job.id, {
    event_type: "status",
    to_status: job.status,
    message: "Dispatched by schedule run-now",
    detail: { schedule_id: row.id, schedule_code: row.code, manual: true },
    actor_id: actor?.id ?? null,
    actor_type: actor ? "user" : "engine",
    source: "scheduler",
  });
  recordEngineAudit(db, {
    tenantId: row.tenant_id,
    entityType: "schedule",
    entityId: row.id,
    entityCode: row.code,
    action: "run_now",
    actor,
    detail: { job_id: job.id, job_ref: job.job_ref },
    ip,
  });
  return { schedule: publicSchedule(queryOne(db, "SELECT * FROM job_schedules WHERE id = ?", [row.id])), job };
}

export function listScheduleRuns(db, ref, query = {}) {
  const { page, pageSize, offset } = pagination(query);
  const row = getScheduleRow(db, ref);
  const where = ["r.schedule_id = ?"];
  const params = [row.id];
  if (query.status) {
    where.push("r.status = ?");
    params.push(String(query.status));
  }
  const clause = `WHERE ${where.join(" AND ")}`;
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM job_schedule_runs r ${clause}`, params).c;
  const items = queryAll(
    db,
    `SELECT r.*, j.job_ref, j.status AS job_status, j.progress AS job_progress
       FROM job_schedule_runs r LEFT JOIN jobs j ON j.id = r.job_id
       ${clause} ORDER BY r.scheduled_for DESC, r.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map((item) => ({
    id: item.id,
    schedule_id: item.schedule_id,
    job_id: item.job_id ?? null,
    job_ref: item.job_ref || "",
    job_status: item.job_status || "",
    job_progress: item.job_progress ?? null,
    scheduled_for: item.scheduled_for,
    status: item.status,
    attempt: item.attempt,
    detail: safeParse(item.detail_json, {}),
    created_at: item.created_at,
    updated_at: item.updated_at,
  }));
  return { schedule: publicSchedule(row), items, total, page, pageSize };
}
