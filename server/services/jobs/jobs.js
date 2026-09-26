import { queryAll, queryOne, run, nowIso, randomUuid } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { writeAudit } from "../audit.js";
import { homeTenantId } from "../tenants.js";
import {
  JOB_STATUSES,
  TERMINAL_STATUSES,
  ARTIFACT_KINDS,
  clampProgress,
  normalizeMaxRetries,
  assertJobStatus,
  assertPriority,
  assertQueue,
  assertSubmittedAs,
  assertTransition,
  canTransition,
  isTerminalStatus,
  statusLabel,
  safeParse,
  truncate,
  addSeconds,
} from "./validation.js";
import { getJobTypeRow } from "./types.js";
import { recordHistory } from "./history.js";

// Canonical background job record and lifecycle management.
//
// Business modules submit work here and immediately receive a Job ID; they
// never execute long-running work inside an HTTP request. The Job Scheduling &
// Execution Engine performs the actual work and reports progress/outcomes back
// through `updateProgress` / `transition` / `recordResult`. This service owns
// the durable record, status machine, history, dependencies, results and the
// control operations (cancel/retry/pause/resume).

const FAILURE_STATUSES = ["failed", "cancelled", "timed_out", "skipped"];
const SORTABLE = new Set(["created_at", "updated_at", "status", "priority", "progress", "job_ref", "scheduled_at", "started_at", "completed_at"]);

function jobRef() {
  return `JOB-${randomUuid().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
}

export function publicJob(row) {
  if (!row) return null;
  const terminal = isTerminalStatus(row.status);
  return {
    id: row.id,
    job_ref: row.job_ref,
    job_type_code: row.job_type_code,
    name: row.name || "",
    description: row.description || "",
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    site_id: row.site_id ?? null,
    department_id: row.department_id ?? null,
    source_module: row.source_module || "platform",
    submitted_by: row.submitted_by ?? null,
    submitted_as: row.submitted_as || "user",
    queue: row.queue,
    priority: row.priority,
    status: row.status,
    status_label: statusLabel(row.status),
    progress: row.progress,
    stage: row.stage || "",
    message: row.message || "",
    input: safeParse(row.input_json, {}),
    input_ref: row.input_ref || "",
    related_object_type: row.related_object_type || "",
    related_object_id: row.related_object_id || "",
    related_object_name: row.related_object_name || "",
    parent_job_id: row.parent_job_id ?? null,
    correlation_id: row.correlation_id || "",
    idempotency_key: row.idempotency_key || null,
    retry_count: row.retry_count,
    max_retries: row.max_retries,
    timeout_seconds: row.timeout_seconds,
    scheduled_at: row.scheduled_at || null,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
    worker_id: row.worker_id || "",
    error_code: row.error_code || "",
    error_message: row.error_message || "",
    error: safeParse(row.error_json, {}),
    result_ref: row.result_ref || "",
    result: safeParse(row.result_json, {}),
    cancel_reason: row.cancel_reason || "",
    cancel_requested_at: row.cancel_requested_at || null,
    cancel_requested_by: row.cancel_requested_by ?? null,
    cancelled_at: row.cancelled_at || null,
    is_terminal: terminal,
    is_active: !terminal,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function resolveTenant(db, input, actor) {
  const value = input?.tenant_id ?? input?.tenantId ?? actor?.tenant_id ?? homeTenantId(db, actor) ?? null;
  return value === null || value === undefined ? null : Number(value) || null;
}

function resolveJobRow(db, id, tenantId = null) {
  const row = queryOne(
    db,
    "SELECT * FROM jobs WHERE id = ? OR job_ref = ?",
    [Number(id) || -1, String(id || "")]
  );
  if (!row) throw new HttpError(404, "Job not found");
  if (tenantId !== null && tenantId !== undefined && Number(row.tenant_id) !== Number(tenantId)) {
    throw new HttpError(404, "Job not found");
  }
  return row;
}

function normalizeSubmit(db, input = {}, actor = null) {
  const code = String(input.job_type_code || input.jobType || input.jobTypeCode || input.type || "").trim().toUpperCase();
  if (!code) throw new HttpError(400, "job_type_code is required");
  const type = getJobTypeRow(db, code);
  if (!type) throw new HttpError(400, `Unknown job type: ${code}`);
  if (type.active !== 1) throw new HttpError(409, `Job type ${code} is not active`);

  const priority = input.priority || type.default_priority || "normal";
  assertPriority(priority);
  const queues = safeParse(type.queues_json, ["default"]);
  const queue = assertQueue(input.queue || queues[0] || "default");
  const submittedAs = input.submitted_as || input.submittedAs || (actor?.id ? "user" : "system");
  assertSubmittedAs(submittedAs);

  const tenantId = resolveTenant(db, input, actor);
  const organizationId = Number(input.organization_id ?? input.organizationId ?? actor?.organization_id ?? 0) || null;

  return {
    job_type_code: type.code,
    name: truncate(input.name || type.name || "Background job", 255),
    description: truncate(input.description || "", 2000),
    tenant_id: tenantId,
    organization_id: organizationId,
    plant_id: input.plant_id ?? input.plantId ?? null,
    site_id: input.site_id ?? input.siteId ?? null,
    department_id: input.department_id ?? input.departmentId ?? null,
    source_module: input.source_module || input.sourceModule || type.source_module || "platform",
    submitted_by: actor?.id ?? input.submitted_by ?? input.submittedBy ?? null,
    submitted_as: submittedAs,
    queue,
    priority,
    input_json: input.input ? JSON.stringify(input.input) : (input.input_json ?? input.inputJson ?? "{}"),
    input_ref: truncate(input.input_ref || input.inputRef || "", 500),
    related_object_type: truncate(input.related_object_type || input.object_type || input.objectType || "", 100),
    related_object_id: truncate(input.related_object_id || input.object_id || input.objectId || "", 100),
    related_object_name: truncate(input.related_object_name || input.object_name || input.objectName || "", 255),
    parent_job_id: input.parent_job_id ?? input.parentJobId ?? null,
    correlation_id: truncate(input.correlation_id || input.correlationId || "", 100),
    idempotency_key: truncate(input.idempotency_key || input.idempotencyKey || "", 255) || null,
    max_retries: normalizeMaxRetries(input.max_retries ?? input.maxRetries, type.max_retries),
    timeout_seconds: Math.max(0, Number(input.timeout_seconds ?? input.timeoutSeconds ?? type.timeout_seconds) || 0),
    scheduled_at: input.scheduled_at || input.scheduledAt || null,
    delay_seconds: Number(input.delay_seconds ?? input.delaySeconds ?? 0) || 0,
    dependencies: normalizeDependencyIds(input.dependencies || input.depends_on || input.dependsOn),
  };
}

function normalizeDependencyIds(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  return [...new Set(list.map((item) => String(item || "").trim()).filter(Boolean))].slice(0, 50);
}

function insertJob(db, fields) {
  const columns = Object.keys(fields);
  const placeholders = columns.map(() => "?").join(", ");
  const result = run(
    db,
    `INSERT INTO jobs (${columns.join(", ")}) VALUES (${placeholders})`,
    columns.map((column) => fields[column])
  );
  return Number(result.lastInsertRowid);
}

function resolveInitialStatus(normalized) {
  if (normalized.dependencies.length) return "waiting_for_dependency";
  const scheduled = normalized.scheduled_at
    || (normalized.delay_seconds > 0 ? addSeconds(nowIso(), normalized.delay_seconds) : null);
  if (scheduled && scheduled > nowIso()) return "scheduled";
  return "queued";
}

// Submits a job and returns immediately with the Job ID. Idempotent on
// idempotency_key: resubmitting the same key returns the existing job marked
// `duplicate` instead of creating a second one.
export function submitJob(db, input = {}, { actor = null, ip = null } = {}) {
  const normalized = normalizeSubmit(db, input, actor);

  if (normalized.idempotency_key) {
    const existing = queryOne(db, "SELECT * FROM jobs WHERE idempotency_key = ?", [normalized.idempotency_key]);
    if (existing) return { ...publicJob(existing), duplicate: true };
  }
  if (normalized.parent_job_id) {
    const parent = queryOne(db, "SELECT * FROM jobs WHERE id = ? OR job_ref = ?", [Number(normalized.parent_job_id) || -1, String(normalized.parent_job_id)]);
    if (!parent) throw new HttpError(400, "parent_job_id does not reference an existing job");
    if (normalized.tenant_id && parent.tenant_id && Number(parent.tenant_id) !== Number(normalized.tenant_id)) {
      throw new HttpError(400, "parent job belongs to a different tenant");
    }
    normalized.parent_job_id = parent.id;
  }

  const ts = nowIso();
  const status = resolveInitialStatus(normalized);
  const scheduledAt = normalized.scheduled_at
    || (normalized.delay_seconds > 0 ? addSeconds(ts, normalized.delay_seconds) : (status === "scheduled" ? ts : null));

  const id = insertJob(db, {
    job_ref: jobRef(),
    job_type_code: normalized.job_type_code,
    name: normalized.name,
    description: normalized.description,
    tenant_id: normalized.tenant_id,
    organization_id: normalized.organization_id,
    plant_id: normalized.plant_id,
    site_id: normalized.site_id,
    department_id: normalized.department_id,
    source_module: normalized.source_module,
    submitted_by: normalized.submitted_by,
    submitted_as: normalized.submitted_as,
    queue: normalized.queue,
    priority: normalized.priority,
    status,
    progress: 0,
    input_json: normalized.input_json,
    input_ref: normalized.input_ref,
    related_object_type: normalized.related_object_type,
    related_object_id: normalized.related_object_id,
    related_object_name: normalized.related_object_name,
    parent_job_id: normalized.parent_job_id,
    correlation_id: normalized.correlation_id,
    idempotency_key: normalized.idempotency_key,
    retry_count: 0,
    max_retries: normalized.max_retries,
    timeout_seconds: normalized.timeout_seconds,
    scheduled_at: scheduledAt,
    created_at: ts,
    updated_at: ts,
  });

  recordHistory(db, id, {
    event_type: "created",
    to_status: status,
    message: "Job submitted",
    detail: { job_type_code: normalized.job_type_code, queue: normalized.queue, priority: normalized.priority },
    actor_id: actor?.id ?? null,
    actor_type: normalized.submitted_as,
    source: normalized.source_module,
  });

  let dependencies = [];
  if (normalized.dependencies.length) {
    dependencies = addDependencies(db, id, normalized.dependencies, { actor, ip, silent: true });
  }

  writeAudit(db, {
    actor,
    action: "jobs.submit",
    resourceType: "job",
    resourceId: id,
    details: {
      job_ref: queryOne(db, "SELECT job_ref FROM jobs WHERE id = ?", [id]).job_ref,
      job_type_code: normalized.job_type_code,
      queue: normalized.queue,
      priority: normalized.priority,
      dependency_count: dependencies.length,
    },
    ip,
  });

  return publicJob(queryOne(db, "SELECT * FROM jobs WHERE id = ?", [id]));
}

export const submit = submitJob;

export function getJob(db, id, tenantId = null) {
  return publicJob(resolveJobRow(db, id, tenantId));
}

export function getJobRow(db, id, tenantId = null) {
  return resolveJobRow(db, id, tenantId);
}

// Job status snapshot used by the JobService interface.
export function getStatus(db, id, tenantId = null) {
  const job = getJob(db, id, tenantId);
  return {
    id: job.id,
    job_ref: job.job_ref,
    status: job.status,
    status_label: job.status_label,
    progress: job.progress,
    stage: job.stage,
    message: job.message,
    retry_count: job.retry_count,
    is_terminal: job.is_terminal,
    started_at: job.started_at,
    completed_at: job.completed_at,
    updated_at: job.updated_at,
  };
}

export function listJobs(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  const scopedTenant = tenantId ?? (query.tenantId !== undefined && query.tenantId !== "" ? Number(query.tenantId) : null);
  if (scopedTenant !== null && scopedTenant !== undefined) {
    where.push("COALESCE(tenant_id, 0) = ?");
    params.push(Number(scopedTenant));
  }
  const statusFilter = query.status || query.statuses;
  if (statusFilter) {
    const list = (Array.isArray(statusFilter) ? statusFilter : String(statusFilter).split(","))
      .map((item) => String(item).trim().toLowerCase())
      .filter((item) => JOB_STATUSES.includes(item));
    if (list.length) {
      where.push(`status IN (${list.map(() => "?").join(", ")})`);
      params.push(...list);
    }
  }
  if (query.active === "true" || query.active === true) {
    where.push(`status NOT IN (${TERMINAL_STATUSES.map(() => "?").join(", ")})`);
    params.push(...TERMINAL_STATUSES);
  }
  if (query.terminal === "true" || query.terminal === true) {
    where.push(`status IN (${TERMINAL_STATUSES.map(() => "?").join(", ")})`);
    params.push(...TERMINAL_STATUSES);
  }
  if (query.type || query.job_type_code || query.jobType) {
    where.push("job_type_code = ?");
    params.push(String(query.type || query.job_type_code || query.jobType).toUpperCase());
  }
  if (query.queue) {
    where.push("queue = ?");
    params.push(query.queue);
  }
  if (query.priority) {
    where.push("priority = ?");
    params.push(query.priority);
  }
  if (query.module || query.source_module || query.sourceModule) {
    where.push("source_module = ?");
    params.push(query.module || query.source_module || query.sourceModule);
  }
  if (query.submittedBy || query.submitted_by) {
    where.push("submitted_by = ?");
    params.push(Number(query.submittedBy || query.submitted_by));
  }
  if (query.parentJobId || query.parent_job_id) {
    where.push("parent_job_id = ?");
    params.push(Number(query.parentJobId || query.parent_job_id));
  }
  if (query.correlationId || query.correlation_id) {
    where.push("correlation_id = ?");
    params.push(query.correlationId || query.correlation_id);
  }
  if (query.objectType || query.related_object_type) {
    where.push("related_object_type = ?");
    params.push(query.objectType || query.related_object_type);
  }
  if (query.objectId || query.related_object_id) {
    where.push("related_object_id = ?");
    params.push(String(query.objectId || query.related_object_id));
  }
  if (query.from || query.dateFrom) {
    where.push("created_at >= ?");
    params.push(String(query.from || query.dateFrom));
  }
  if (query.to || query.dateTo) {
    where.push("created_at <= ?");
    params.push(String(query.to || query.dateTo));
  }
  if (query.q) {
    const like = `%${query.q}%`;
    where.push("(name LIKE ? OR description LIKE ? OR job_ref LIKE ? OR related_object_name LIKE ? OR message LIKE ? OR error_message LIKE ?)");
    params.push(like, like, like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM jobs ${clause}`, params).c;
  const sort = SORTABLE.has(String(query.sort || "")) ? String(query.sort) : "created_at";
  const dir = String(query.order || "").toLowerCase() === "asc" ? "ASC" : "DESC";
  const items = queryAll(
    db,
    `SELECT * FROM jobs ${clause} ORDER BY ${sort} ${dir}, id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map(publicJob);
  return { items, total, page, pageSize };
}

function applyStatusChange(db, jobRow, toStatus, options = {}) {
  const fromStatus = jobRow.status;
  const ts = nowIso();
  const fields = ["status = ?", "updated_at = ?"];
  const params = [toStatus, ts];

  if (toStatus === "running" && !jobRow.started_at) {
    fields.push("started_at = ?");
    params.push(ts);
  }
  if (options.progress !== undefined && options.progress !== null) {
    fields.push("progress = ?");
    params.push(clampProgress(options.progress));
  }
  if (options.stage !== undefined) {
    fields.push("stage = ?");
    params.push(truncate(options.stage, 200));
  }
  if (options.message !== undefined) {
    fields.push("message = ?");
    params.push(truncate(options.message, 2000));
  }
  if (options.workerId !== undefined || options.worker_id !== undefined) {
    fields.push("worker_id = ?");
    params.push(truncate(options.workerId ?? options.worker_id, 200));
  }
  if (toStatus === "failed" || toStatus === "timed_out") {
    fields.push("error_code = ?", "error_message = ?", "error_json = ?", "completed_at = ?");
    params.push(
      truncate(options.errorCode || options.error_code || "", 100),
      truncate(options.errorMessage || options.error_message || "", 2000),
      JSON.stringify(options.error || {}),
      ts
    );
  }
  if (isTerminalStatus(toStatus)) {
    fields.push("completed_at = ?");
    params.push(ts);
    if (toStatus === "cancelled") {
      fields.push("cancelled_at = ?");
      params.push(ts);
    }
  }
  params.push(jobRow.id);
  run(db, `UPDATE jobs SET ${fields.join(", ")} WHERE id = ?`, params);

  recordHistory(db, jobRow.id, {
    event_type: "status",
    from_status: fromStatus,
    to_status: toStatus,
    progress: options.progress,
    stage: options.stage,
    message: options.message || `Status changed to ${statusLabel(toStatus)}`,
    detail: options.detail || {},
    actor_id: options.actorId ?? null,
    actor_type: options.actorType || (options.actorId ? "user" : "engine"),
    source: options.source || "engine",
  });

  return publicJob(queryOne(db, "SELECT * FROM jobs WHERE id = ?", [jobRow.id]));
}

// Generic status transition used by the execution engine and by control
// operations. Rejects illegal transitions so the stored lifecycle stays
// consistent with JOB_TRANSITIONS.
export function transitionJob(db, id, toStatus, options = {}) {
  assertJobStatus(toStatus);
  const jobRow = resolveJobRow(db, id, options.tenantId ?? null);
  if (!canTransition(jobRow.status, toStatus)) {
    throw new HttpError(409, `Invalid job status transition: ${statusLabel(jobRow.status)} -> ${statusLabel(toStatus)}`);
  }
  const job = applyStatusChange(db, jobRow, toStatus, options);
  if (isTerminalStatus(toStatus)) evaluateDependents(db, jobRow.id, options);
  return job;
}

// Engine-facing progress update. Optionally carries a status change; progress
// is clamped to 0-100 and every update is captured on the timeline.
export function updateProgress(db, id, input = {}, options = {}) {
  const jobRow = resolveJobRow(db, id, options.tenantId ?? null);
  if (isTerminalStatus(jobRow.status)) {
    throw new HttpError(409, `Cannot update a ${statusLabel(jobRow.status)} job`);
  }
  if (input.status && input.status !== jobRow.status) {
    assertJobStatus(input.status);
    assertTransition(jobRow.status, input.status);
    const updated = applyStatusChange(db, jobRow, input.status, {
      progress: input.progress,
      stage: input.stage,
      message: input.message,
      workerId: input.worker_id ?? input.workerId,
      actorId: options.actor?.id ?? null,
      actorType: options.actor ? "user" : "engine",
      source: input.source || "engine",
    });
    if (isTerminalStatus(input.status)) evaluateDependents(db, jobRow.id, options);
    return updated;
  }
  const ts = nowIso();
  run(
    db,
    `UPDATE jobs SET progress = ?, stage = ?, message = ?, updated_at = ?
       ${input.worker_id || input.workerId ? ", worker_id = ?" : ""}
     WHERE id = ?`,
    [
      clampProgress(input.progress ?? jobRow.progress),
      truncate(input.stage ?? jobRow.stage, 200),
      truncate(input.message ?? jobRow.message, 2000),
      ts,
      ...(input.worker_id || input.workerId ? [truncate(input.worker_id ?? input.workerId, 200)] : []),
      jobRow.id,
    ]
  );
  recordHistory(db, jobRow.id, {
    event_type: "progress",
    progress: clampProgress(input.progress ?? jobRow.progress),
    stage: input.stage,
    message: input.message || "Progress updated",
    detail: input.detail || {},
    actor_id: options.actor?.id ?? null,
    actor_type: options.actor ? "user" : "engine",
    source: input.source || "engine",
  });
  return publicJob(queryOne(db, "SELECT * FROM jobs WHERE id = ?", [jobRow.id]));
}

// Cancels a job. Jobs that have not started are cancelled immediately; running
// jobs move to CANCEL_REQUESTED so the execution engine can stop cooperatively.
export function cancelJob(db, id, { tenantId = null, reason = "", actor = null, ip = null } = {}) {
  const jobRow = resolveJobRow(db, id, tenantId);
  if (isTerminalStatus(jobRow.status)) {
    return { cancelled: false, reason: "already_terminal", job: publicJob(jobRow) };
  }
  const ts = nowIso();
  const immediate = ["created", "queued", "scheduled", "waiting_for_dependency", "paused", "retrying"].includes(jobRow.status);
  if (immediate) {
    const job = applyStatusChange(db, jobRow, "cancelled", {
      message: reason || "Job cancelled",
      actorId: actor?.id ?? null,
      source: "platform",
      detail: { reason },
    });
    run(
      db,
      "UPDATE jobs SET cancel_reason = ?, cancel_requested_at = ?, cancel_requested_by = ?, cancelled_at = ? WHERE id = ?",
      [truncate(reason, 500), ts, actor?.id ?? null, ts, jobRow.id]
    );
    writeAudit(db, { actor, action: "jobs.cancel", resourceType: "job", resourceId: jobRow.id, details: { job_ref: jobRow.job_ref, reason }, ip });
    return { cancelled: true, requested: false, job: publicJob(queryOne(db, "SELECT * FROM jobs WHERE id = ?", [jobRow.id])) };
  }
  if (jobRow.status !== "cancel_requested") {
    applyStatusChange(db, jobRow, "cancel_requested", {
      message: reason || "Cancellation requested",
      actorId: actor?.id ?? null,
      source: "platform",
      detail: { reason },
    });
  }
  run(
    db,
    "UPDATE jobs SET cancel_reason = ?, cancel_requested_at = ?, cancel_requested_by = ? WHERE id = ?",
    [truncate(reason, 500), ts, actor?.id ?? null, jobRow.id]
  );
  writeAudit(db, { actor, action: "jobs.cancel.request", resourceType: "job", resourceId: jobRow.id, details: { job_ref: jobRow.job_ref, reason }, ip });
  return { cancelled: true, requested: true, job: publicJob(queryOne(db, "SELECT * FROM jobs WHERE id = ?", [jobRow.id])) };
}

// Manual retry of a failed/timed-out/cancelled job by an authorized operator.
export function retryJob(db, id, { tenantId = null, actor = null, ip = null } = {}) {
  const jobRow = resolveJobRow(db, id, tenantId);
  if (!FAILURE_STATUSES.includes(jobRow.status)) {
    return { retried: false, reason: "not_retryable", job: publicJob(jobRow) };
  }
  const ts = nowIso();
  run(
    db,
    `UPDATE jobs
        SET status = 'queued', retry_count = retry_count + 1, progress = 0, stage = '', message = 'Retry requested',
            error_code = '', error_message = '', error_json = '{}', started_at = NULL, completed_at = NULL,
            worker_id = '', cancel_reason = '', cancel_requested_at = NULL, cancel_requested_by = NULL,
            cancelled_at = NULL, scheduled_at = ?, updated_at = ?
      WHERE id = ?`,
    [ts, ts, jobRow.id]
  );
  recordHistory(db, jobRow.id, {
    event_type: "retry",
    from_status: jobRow.status,
    to_status: "queued",
    message: "Job retried",
    detail: { retry_count: jobRow.retry_count + 1 },
    actor_id: actor?.id ?? null,
    actor_type: actor ? "user" : "engine",
    source: "platform",
  });
  writeAudit(db, { actor, action: "jobs.retry", resourceType: "job", resourceId: jobRow.id, details: { job_ref: jobRow.job_ref, retry_count: jobRow.retry_count + 1 }, ip });
  return { retried: true, job: publicJob(queryOne(db, "SELECT * FROM jobs WHERE id = ?", [jobRow.id])) };
}

export function pauseJob(db, id, { tenantId = null, reason = "", actor = null, ip = null } = {}) {
  const jobRow = resolveJobRow(db, id, tenantId);
  if (!["queued", "running", "retrying", "scheduled"].includes(jobRow.status)) {
    return { paused: false, reason: "not_pausable", job: publicJob(jobRow) };
  }
  const job = applyStatusChange(db, jobRow, "paused", {
    message: reason || "Job paused",
    actorId: actor?.id ?? null,
    source: "platform",
    detail: { reason },
  });
  writeAudit(db, { actor, action: "jobs.pause", resourceType: "job", resourceId: jobRow.id, details: { job_ref: jobRow.job_ref }, ip });
  return { paused: true, job };
}

export function resumeJob(db, id, { tenantId = null, actor = null, ip = null } = {}) {
  const jobRow = resolveJobRow(db, id, tenantId);
  if (jobRow.status !== "paused") {
    return { resumed: false, reason: "not_paused", job: publicJob(jobRow) };
  }
  const job = applyStatusChange(db, jobRow, "queued", {
    message: "Job resumed",
    actorId: actor?.id ?? null,
    source: "platform",
  });
  writeAudit(db, { actor, action: "jobs.resume", resourceType: "job", resourceId: jobRow.id, details: { job_ref: jobRow.job_ref }, ip });
  return { resumed: true, job };
}

// ── Dependencies ──────────────────────────────────────────────────────────

function resolveDependencyRows(db, jobId, tenantId = null) {
  return queryAll(
    db,
    `SELECT j.*, d.required FROM job_dependencies d JOIN jobs j ON j.id = d.depends_on_job_id
      WHERE d.job_id = ? ORDER BY d.depends_on_job_id`,
    [Number(jobId)]
  ).filter((row) => (tenantId === null || tenantId === undefined ? true : Number(row.tenant_id) === Number(tenantId)));
}

export function dependencyState(db, jobId, tenantId = null) {
  const deps = resolveDependencyRows(db, jobId, tenantId);
  const required = deps.filter((row) => row.required === 1);
  return {
    total: deps.length,
    completed: deps.filter((row) => row.status === "completed").length,
    failed: deps.filter((row) => FAILURE_STATUSES.includes(row.status)).length,
    pending: deps.filter((row) => !isTerminalStatus(row.status)).length,
    satisfied: required.every((row) => row.status === "completed"),
    blocked: required.some((row) => FAILURE_STATUSES.includes(row.status)),
  };
}

export function addDependencies(db, jobId, dependencies, { actor = null, ip = null, silent = false } = {}) {
  const jobRow = queryOne(db, "SELECT * FROM jobs WHERE id = ?", [Number(jobId)]);
  if (!jobRow) throw new HttpError(404, "Job not found");
  const added = [];
  for (const ref of dependencies) {
    const dep = resolveJobRow(db, ref, null);
    if (dep.id === jobRow.id) throw new HttpError(400, "A job cannot depend on itself");
    if (jobRow.tenant_id && dep.tenant_id && Number(dep.tenant_id) !== Number(jobRow.tenant_id)) {
      throw new HttpError(400, "Dependency belongs to a different tenant");
    }
    const existing = queryOne(db, "SELECT 1 AS x FROM job_dependencies WHERE job_id = ? AND depends_on_job_id = ?", [jobRow.id, dep.id]);
    if (existing) continue;
    run(db, "INSERT INTO job_dependencies (job_id, depends_on_job_id, required, created_at) VALUES (?, ?, 1, ?)", [jobRow.id, dep.id, nowIso()]);
    added.push(publicJob(dep));
    if (!silent) {
      recordHistory(db, jobRow.id, {
        event_type: "dependency",
        message: `Dependency added: ${dep.job_ref}`,
        detail: { depends_on_job_id: dep.id },
        actor_id: actor?.id ?? null,
        source: "platform",
      });
    }
  }
  // Move to waiting when dependencies exist and become unsatisfied.
  if (jobRow.status === "created" || jobRow.status === "queued" || jobRow.status === "scheduled") {
    const state = dependencyState(db, jobRow.id);
    if (!state.satisfied) {
      applyStatusChange(db, jobRow, "waiting_for_dependency", { message: "Waiting for dependencies", source: "platform", actorId: actor?.id ?? null });
    }
  }
  if (!silent && added.length) {
    writeAudit(db, { actor, action: "jobs.dependency.add", resourceType: "job", resourceId: jobRow.id, details: { job_ref: jobRow.job_ref, count: added.length }, ip });
  }
  return added;
}

export function removeDependency(db, jobId, dependsOnId, { actor = null, ip = null } = {}) {
  const jobRow = resolveJobRow(db, jobId, null);
  const depRow = resolveJobRow(db, dependsOnId, null);
  const result = run(db, "DELETE FROM job_dependencies WHERE job_id = ? AND depends_on_job_id = ?", [jobRow.id, depRow.id]);
  if (!result.changes) throw new HttpError(404, "Dependency not found");
  recordHistory(db, jobRow.id, {
    event_type: "dependency",
    message: `Dependency removed: ${depRow.job_ref}`,
    detail: { depends_on_job_id: depRow.id },
    actor_id: actor?.id ?? null,
    source: "platform",
  });
  const state = dependencyState(db, jobRow.id);
  if (jobRow.status === "waiting_for_dependency" && state.satisfied) {
    applyStatusChange(db, jobRow, "queued", { message: "Dependencies satisfied", source: "platform", actorId: actor?.id ?? null });
  }
  writeAudit(db, { actor, action: "jobs.dependency.remove", resourceType: "job", resourceId: jobRow.id, details: { job_ref: jobRow.job_ref, depends_on_ref: depRow.job_ref }, ip });
  return { removed: true };
}

export function listDependencies(db, jobId, tenantId = null) {
  const jobRow = resolveJobRow(db, jobId, tenantId);
  const dependsOn = resolveDependencyRows(db, jobRow.id, tenantId).map((row) => ({
    id: row.id,
    job_ref: row.job_ref,
    name: row.name,
    job_type_code: row.job_type_code,
    status: row.status,
    status_label: statusLabel(row.status),
    required: row.required === 1,
  }));
  const dependents = queryAll(
    db,
    `SELECT j.id, j.job_ref, j.name, j.job_type_code, j.status, d.required
       FROM job_dependencies d JOIN jobs j ON j.id = d.job_id
      WHERE d.depends_on_job_id = ? ORDER BY j.id`,
    [jobRow.id]
  ).map((row) => ({
    id: row.id,
    job_ref: row.job_ref,
    name: row.name,
    job_type_code: row.job_type_code,
    status: row.status,
    status_label: statusLabel(row.status),
    required: row.required === 1,
  }));
  return { job_id: jobRow.id, depends_on: dependsOn, dependents, state: dependencyState(db, jobRow.id, tenantId) };
}

export function listChildren(db, parentId, tenantId = null) {
  const parent = resolveJobRow(db, parentId, tenantId);
  return queryAll(db, "SELECT * FROM jobs WHERE parent_job_id = ? ORDER BY id", [parent.id]).map(publicJob);
}

// Promotes or fails jobs waiting on the given job. Called whenever a job
// reaches a terminal state; keeps dependency bookkeeping accurate without
// implementing any scheduling policy.
export function evaluateDependents(db, jobId, options = {}) {
  const dependents = queryAll(
    db,
    `SELECT j.* FROM job_dependencies d JOIN jobs j ON j.id = d.job_id
      WHERE d.depends_on_job_id = ? AND j.status = 'waiting_for_dependency'`,
    [Number(jobId)]
  );
  const released = [];
  for (const dependent of dependents) {
    const state = dependencyState(db, dependent.id);
    if (state.blocked) {
      applyStatusChange(db, dependent, "failed", {
        message: "A required dependency failed",
        errorCode: "dependency_failed",
        errorMessage: "A required dependency failed, timed out or was cancelled",
        source: "platform",
        detail: { depends_on_job_id: Number(jobId) },
      });
    } else if (state.satisfied) {
      const scheduledAt = dependent.scheduled_at || "";
      const target = scheduledAt && scheduledAt > nowIso() ? "scheduled" : "queued";
      applyStatusChange(db, dependent, target, {
        message: "Dependencies satisfied",
        source: "platform",
        detail: { depends_on_job_id: Number(jobId) },
      });
      released.push(dependent.id);
    }
  }
  return { released };
}

export { ARTIFACT_KINDS };
