// Core execution engine: claiming, running, finalising, recovery, timeouts and
// cancellation.
//
// Design notes:
//  - Durable queue: jobs live in the `jobs` table; claims use a guarded UPDATE
//    with lease fields so two workers can never run the same job.
//  - Cooperative execution: handlers are never force-killed. Timeouts and
//    cancellation signal the handler and finalise the durable record; a handler
//    that keeps running after a timeout discovers the terminal state on its
//    next `checkCancelled()`/progress call.
//  - At-least-once: handlers must be idempotent. Idempotency keys on jobs and
//    schedule runs prevent duplicate submissions.

import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import {
  isTerminalStatus,
  statusLabel,
  truncate,
  clampProgress,
} from "../jobs/validation.js";
import { getJobRow, publicJob, evaluateDependents, dependencyState, cancelJob, retryJob } from "../jobs/jobs.js";
import { recordHistory } from "../jobs/history.js";
import { addArtifact, setJobResult } from "../jobs/artifacts.js";
import { classifyError, JobCancelledError, JobTimeoutError, categoryLabel } from "./errors.js";
import { requestSignal, clearSignal } from "./signals.js";
import { invokeHandlerForJob, createJobContext, listHandlers } from "./handlers.js";
import { resolveQueuePolicy, orderQueuesForClaim } from "./queues.js";
import { canonicalQueue, queueAliasCodes } from "./validation.js";
import { heartbeatWorker, recordWorkerOutcome } from "./worker-registry.js";
import { decideRetry } from "./retry.js";
import { recordDeadLetter } from "./deadletter.js";
import { sqlTime, sqlTimeAfterSeconds, parseSqlTime } from "./timezone.js";

export const DEFAULT_LEASE_SECONDS = 120;
const CLAIMABLE_STATUSES = ["queued", "scheduled", "retrying"];

// ── Query helpers ──────────────────────────────────────────────────────────

function inClause(values) {
  return values.map(() => "?").join(", ");
}

function countRunning(db, aliases) {
  const row = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM jobs WHERE status IN ('running', 'cancel_requested') AND queue IN (${inClause(aliases)})`,
    aliases
  );
  return row?.c || 0;
}

function activeLeaseOwners(db, aliases) {
  return queryAll(
    db,
    `SELECT DISTINCT lease_owner FROM jobs
      WHERE status IN ('running', 'cancel_requested') AND lease_owner <> '' AND queue IN (${inClause(aliases)})`,
    aliases
  ).map((row) => row.lease_owner);
}

function executionsLastMinute(db, aliases) {
  const row = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM job_executions WHERE queue IN (${inClause(aliases)}) AND started_at >= datetime('now', '-60 seconds')`,
    aliases
  );
  return row?.c || 0;
}

function selectCandidate(db, aliases, now) {
  return queryOne(
    db,
    `SELECT * FROM jobs
      WHERE queue IN (${inClause(aliases)})
        AND status IN (${inClause(CLAIMABLE_STATUSES)})
        AND (scheduled_at IS NULL OR scheduled_at <= ?)
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END ASC,
        COALESCE(scheduled_at, created_at) ASC,
        id ASC
      LIMIT 1`,
    [...aliases, ...CLAIMABLE_STATUSES, now]
  );
}

export function resolveEffectiveTimeout(job, policy) {
  const jobTimeout = Number(job?.timeout_seconds) || 0;
  if (jobTimeout > 0) return jobTimeout;
  return Math.max(0, Number(policy?.timeout_seconds) || 0);
}

// ── Claiming ───────────────────────────────────────────────────────────────

function attemptClaim(db, candidate, policy, workerId, leaseSeconds) {
  const now = nowIso();
  const timeoutSeconds = resolveEffectiveTimeout(candidate, policy);
  const leaseWindow = Math.max(leaseSeconds, timeoutSeconds > 0 ? timeoutSeconds + 60 : 0);
  const leaseExpires = sqlTimeAfterSeconds(now, leaseWindow);
  const result = run(
    db,
    `UPDATE jobs SET
        status = 'running',
        worker_id = ?,
        lease_owner = ?,
        lease_expires_at = ?,
        heartbeat_at = ?,
        started_at = ?,
        attempts = attempts + 1,
        timeout_seconds = ?,
        next_retry_at = NULL,
        error_code = '',
        error_message = '',
        error_json = '{}',
        updated_at = ?
      WHERE id = ?
        AND status = ?
        AND (lease_owner = '' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    [workerId, workerId, leaseExpires, now, now, timeoutSeconds, now, candidate.id, candidate.status, now]
  );
  if (result.changes !== 1) return null;

  recordHistory(db, candidate.id, {
    event_type: "status",
    from_status: candidate.status,
    to_status: "running",
    message: "Execution started",
    detail: {
      worker_id: workerId,
      attempt: Number(candidate.attempts) + 1,
      queue: policy.code,
      lease_seconds: leaseWindow,
      timeout_seconds: timeoutSeconds,
    },
    actor_type: "engine",
    source: "engine",
  });
  if (policy.id) {
    run(db, "UPDATE job_queues SET last_claimed_at = ?, updated_at = ? WHERE id = ?", [now, now, policy.id]);
  }
  const job = queryOne(db, "SELECT * FROM jobs WHERE id = ?", [candidate.id]);
  return {
    job,
    policy,
    attempt: Number(job.attempts) || 1,
    lease_seconds: leaseWindow,
    timeout_seconds: timeoutSeconds,
  };
}

// Claims the next eligible job, honouring queue priority (with aging), queue
// concurrency, worker allocation and rate limits. Returns null when nothing is
// runnable.
export function claimJob(db, { workerId = "engine", queueCodes = null } = {}) {
  const { scored } = orderQueuesForClaim(db, queueCodes);
  const now = nowIso();
  for (const entry of scored) {
    const policy = entry.policy;
    const aliases = queueAliasCodes(policy.code);

    const concurrency = Number(policy.max_concurrency) || 0;
    if (concurrency > 0 && countRunning(db, aliases) >= concurrency) continue;

    const allocation = Number(policy.worker_allocation) || 0;
    if (allocation > 0) {
      const owners = activeLeaseOwners(db, aliases);
      if (!owners.includes(workerId) && owners.length >= allocation) continue;
    }

    const rateLimit = Number(policy.rate_limit_per_minute) || 0;
    if (rateLimit > 0 && executionsLastMinute(db, aliases) >= rateLimit) continue;

    const candidate = selectCandidate(db, aliases, now);
    if (!candidate) continue;

    const claim = attemptClaim(db, candidate, policy, workerId, DEFAULT_LEASE_SECONDS);
    if (claim) return claim;
  }
  return null;
}

// Claims a specific job (used by "execute now" style operations).
export function claimSpecificJob(db, jobId, { workerId = "engine" } = {}) {
  const job = getJobRow(db, jobId);
  if (!CLAIMABLE_STATUSES.includes(job.status)) {
    throw new HttpError(409, `Job ${job.job_ref} is ${statusLabel(job.status)} and cannot be claimed`);
  }
  const policy = resolveQueuePolicy(db, job.queue);
  const claim = attemptClaim(db, job, policy, workerId, DEFAULT_LEASE_SECONDS);
  if (!claim) throw new HttpError(409, `Job ${job.job_ref} was claimed by another worker`);
  return claim;
}

// ── Execution bookkeeping ──────────────────────────────────────────────────

function createExecutionRow(db, job, attempt, workerId, queue) {
  const result = run(
    db,
    `INSERT INTO job_executions (job_id, attempt, worker_id, queue, status, started_at, created_at)
     VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    [job.id, attempt, workerId, queue, nowIso(), nowIso()]
  );
  return Number(result.lastInsertRowid);
}

function recordStep(db, executionId, name, update = {}) {
  const row = queryOne(db, "SELECT steps_json FROM job_executions WHERE id = ?", [executionId]);
  let steps = [];
  try {
    steps = JSON.parse(row?.steps_json || "[]");
  } catch {
    steps = [];
  }
  steps.push({ name: String(name || ""), at: nowIso(), note: update.message ? String(update.message) : "" });
  if (steps.length > 50) steps = steps.slice(steps.length - 50);
  run(db, "UPDATE job_executions SET last_step = ?, steps_json = ? WHERE id = ?", [
    String(name || ""),
    JSON.stringify(steps),
    executionId,
  ]);
}

function finishExecution(db, executionId, { status, durationMs, error = null, result = null, lastStep = "" }) {
  run(
    db,
    `UPDATE job_executions SET status = ?, finished_at = ?, duration_ms = ?, error_category = ?, error_code = ?,
       error_message = ?, result_json = ?, last_step = COALESCE(NULLIF(?, ''), last_step) WHERE id = ?`,
    [
      status,
      nowIso(),
      Math.max(0, Math.round(durationMs || 0)),
      error?.category || "",
      truncate(error?.code || "", 100),
      truncate(error?.message || "", 2000),
      JSON.stringify(result ?? {}),
      lastStep,
      executionId,
    ]
  );
}

function startLeaseHeartbeat(db, jobId, workerId, leaseSeconds) {
  const intervalMs = Math.max(5000, Math.floor((leaseSeconds * 1000) / 3));
  const timer = setInterval(() => {
    const now = nowIso();
    try {
      run(db, "UPDATE jobs SET heartbeat_at = ?, lease_expires_at = ?, updated_at = updated_at WHERE id = ? AND status IN ('running', 'cancel_requested')", [
        now,
        sqlTimeAfterSeconds(now, leaseSeconds),
        jobId,
      ]);
      heartbeatWorker(db, workerId, { status: "busy" });
    } catch {
      /* heartbeat is best effort */
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

// ── Finalisation ───────────────────────────────────────────────────────────

function finalizeCancelled(db, jobId, executionId, { reason, durationMs }) {
  const ts = nowIso();
  const result = run(
    db,
    `UPDATE jobs SET status = 'cancelled', message = ?, cancel_reason = COALESCE(NULLIF(?, ''), cancel_reason),
       completed_at = ?, cancelled_at = ?, lease_owner = '', lease_expires_at = NULL, heartbeat_at = NULL,
       next_retry_at = NULL, updated_at = ?
     WHERE id = ? AND status IN ('running', 'cancel_requested')`,
    [truncate(reason || "Job cancelled", 2000), truncate(reason || "", 500), ts, ts, ts, jobId]
  );
  if (result.changes !== 1) return null;
  recordHistory(db, jobId, {
    event_type: "status",
    from_status: "running",
    to_status: "cancelled",
    message: reason || "Job cancelled during execution",
    detail: { duration_ms: Math.round(durationMs || 0) },
    actor_type: "engine",
    source: "engine",
  });
  finishExecution(db, executionId, { status: "cancelled", durationMs, error: { category: "cancelled", message: reason } });
  evaluateDependents(db, jobId);
  return "cancelled";
}

function finalizeSuccess(db, jobRow, executionId, outcome, durationMs) {
  const ts = nowIso();
  const result = run(
    db,
    `UPDATE jobs SET status = 'completed', progress = 100, stage = 'completed', message = ?,
       result_ref = ?, result_json = ?, completed_at = ?, lease_owner = '', lease_expires_at = NULL,
       heartbeat_at = NULL, next_retry_at = NULL, updated_at = ?
     WHERE id = ? AND status = 'running'`,
    [
      truncate(outcome.message || "Job completed", 2000),
      truncate(outcome.resultRef || "", 500),
      JSON.stringify(outcome.result ?? {}),
      ts,
      ts,
      jobRow.id,
    ]
  );
  if (result.changes !== 1) return null;

  recordHistory(db, jobRow.id, {
    event_type: "completed",
    from_status: "running",
    to_status: "completed",
    progress: 100,
    message: outcome.message || "Job completed",
    detail: { duration_ms: Math.round(durationMs || 0), attempt: Number(jobRow.attempts) || 1, steps: outcome.steps || [] },
    actor_type: "engine",
    source: "engine",
  });

  for (const artifact of outcome.artifacts || []) {
    try {
      addArtifact(db, jobRow.id, artifact, null, null);
    } catch (error) {
      recordHistory(db, jobRow.id, {
        event_type: "result",
        message: `Artifact rejected: ${error.message}`,
        detail: { artifact: artifact?.name || "" },
        actor_type: "engine",
        source: "engine",
      });
    }
  }

  finishExecution(db, executionId, { status: "completed", durationMs, result: outcome.result ?? {}, lastStep: outcome.lastStep || "" });
  evaluateDependents(db, jobRow.id);
  return "completed";
}

function finalizeFailure(db, jobRow, executionId, classified, { timedOut, policy, retryAfterSeconds, durationMs }) {
  const decision = decideRetry({ job: jobRow, queue: policy, classification: classified, retryAfterSeconds });

  if (decision.retry) {
    const retryAt = sqlTimeAfterSeconds(nowIso(), decision.delay_seconds);
    const statusResult = run(
      db,
      `UPDATE jobs SET status = 'retrying', retry_count = retry_count + 1, scheduled_at = ?, next_retry_at = ?,
         error_code = ?, error_message = ?, error_json = ?, started_at = NULL,
         lease_owner = '', lease_expires_at = NULL, heartbeat_at = NULL, message = ?, updated_at = ?
       WHERE id = ? AND status IN ('running', 'cancel_requested')`,
      [
        retryAt,
        retryAt,
        truncate(classified.code || "", 100),
        truncate(classified.message || "", 2000),
        JSON.stringify({ category: classified.category, retry_at: retryAt }),
        truncate(`Retry ${decision.attempt} scheduled`, 2000),
        nowIso(),
        jobRow.id,
      ]
    );
    if (statusResult.changes !== 1) return null;
    if (timedOut) {
      recordHistory(db, jobRow.id, {
        event_type: "timeout",
        from_status: "running",
        to_status: "retrying",
        message: "Job exceeded its timeout; retry scheduled",
        detail: { category: classified.category, delay_seconds: decision.delay_seconds },
        actor_type: "engine",
        source: "engine",
      });
    }
    recordHistory(db, jobRow.id, {
      event_type: "retry",
      from_status: "running",
      to_status: "retrying",
      message: `Retry ${decision.attempt} of ${decision.max_retries} scheduled in ${decision.delay_seconds}s`,
      detail: {
        category: classified.category,
        category_label: categoryLabel(classified.category),
        error_code: classified.code,
        delay_seconds: decision.delay_seconds,
        strategy: decision.strategy,
        attempt: decision.attempt,
        max_retries: decision.max_retries,
      },
      actor_type: "engine",
      source: "engine",
    });
    finishExecution(db, executionId, {
      status: timedOut ? "timed_out" : "failed",
      durationMs,
      error: classified,
    });
    return "retrying";
  }

  const finalStatus = timedOut ? "timed_out" : "failed";
  const statusResult = run(
    db,
    `UPDATE jobs SET status = ?, error_code = ?, error_message = ?, error_json = ?, completed_at = ?,
       lease_owner = '', lease_expires_at = NULL, heartbeat_at = NULL, next_retry_at = NULL, updated_at = ?
     WHERE id = ? AND status IN ('running', 'cancel_requested')`,
    [
      finalStatus,
      truncate(classified.code || "", 100),
      truncate(classified.message || "", 2000),
      JSON.stringify({ category: classified.category, decision: decision.reason }),
      nowIso(),
      nowIso(),
      jobRow.id,
    ]
  );
  if (statusResult.changes !== 1) return null;

  recordDeadLetter(db, {
    job: jobRow,
    queue: policy?.code || jobRow.queue,
    category: classified.category,
    reason: decision.reason === "retries_exhausted" ? "Retries exhausted" : categoryLabel(classified.category),
    errorCode: classified.code,
    errorMessage: classified.message,
  });
  recordHistory(db, jobRow.id, {
    event_type: timedOut ? "timeout" : "failed",
    from_status: "running",
    to_status: finalStatus,
    message: classified.message || categoryLabel(classified.category),
    detail: {
      category: classified.category,
      error_code: classified.code,
      decision: decision.reason,
      attempts: Number(jobRow.attempts) || 1,
      max_retries: decision.max_retries,
      duration_ms: Math.round(durationMs || 0),
    },
    actor_type: "engine",
    source: "engine",
  });
  finishExecution(db, executionId, { status: finalStatus, durationMs, error: classified });
  evaluateDependents(db, jobRow.id);
  return finalStatus;
}

// ── Execution wrapper ──────────────────────────────────────────────────────

function stopHeartbeatRef(holder) {
  if (holder.stop) {
    holder.stop();
    holder.stop = null;
  }
}

export async function executeClaimedJob(db, claim, { hooks = {} } = {}) {
  const { job, policy, attempt, timeout_seconds: timeoutSeconds, lease_seconds: leaseSeconds } = claim;
  const workerId = job.lease_owner || job.worker_id || "engine";
  const startedAt = Date.now();
  const executionId = createExecutionRow(db, job, attempt, workerId, policy.code || job.queue);
  const heartbeat = { stop: startLeaseHeartbeat(db, job.id, workerId, leaseSeconds) };
  const deadline = timeoutSeconds > 0 ? startedAt + timeoutSeconds * 1000 : null;
  const context = createJobContext({
    db,
    job,
    queue: policy,
    workerId,
    attempt,
    deadline,
    onStep: (name, update) => recordStep(db, executionId, name, update),
  });

  let outcome;
  try {
    if (hooks.beforeExecute) await hooks.beforeExecute({ job, policy, attempt });
    const result = await runWithTimeout(
      () => invokeHandlerForJob(db, job, context),
      timeoutSeconds > 0 ? timeoutSeconds * 1000 : null
    );
    outcome = normalizeSuccess(result);
  } catch (error) {
    outcome = { kind: "failure", error };
  } finally {
    stopHeartbeatRef(heartbeat);
  }

  const durationMs = Date.now() - startedAt;
  const fresh = queryOne(db, "SELECT * FROM jobs WHERE id = ?", [job.id]);
  let finalStatus = fresh?.status || "unknown";

  if (!fresh || !["running", "cancel_requested"].includes(fresh.status)) {
    finishExecution(db, executionId, {
      status: "failed",
      durationMs,
      error: { category: "cancelled", message: `Job was ${fresh ? statusLabel(fresh.status) : "removed"} before completion` },
    });
    return { status: fresh?.status || "missing", job: fresh ? publicJob(fresh) : null, skipped: true };
  }

  if (outcome.kind === "success") {
    if (fresh.status === "cancel_requested") {
      finalStatus = finalizeCancelled(db, job.id, executionId, { reason: fresh.cancel_reason || "Cancelled during execution", durationMs }) || "cancelled";
    } else {
      finalStatus = finalizeSuccess(db, fresh, executionId, outcome, durationMs) || fresh.status;
    }
  } else {
    const classified = classifyError(outcome.error);
    if (classified.category === "cancelled") {
      finalStatus = finalizeCancelled(db, job.id, executionId, { reason: classified.message, durationMs }) || "cancelled";
    } else {
      finalStatus = finalizeFailure(db, fresh, executionId, classified, {
        timedOut: outcome.error instanceof JobTimeoutError,
        policy,
        retryAfterSeconds: classified.retryAfterSeconds,
        durationMs,
      }) || fresh.status;
    }
  }

  recordWorkerOutcome(db, workerId, { success: finalStatus === "completed" });
  clearSignal(job.id);
  if (hooks.afterExecute) await hooks.afterExecute({ job, finalStatus });
  return { status: finalStatus, job: publicJob(queryOne(db, "SELECT * FROM jobs WHERE id = ?", [job.id])) };
}

function normalizeSuccess(result) {
  if (result === undefined || result === null) return { kind: "success", result: {}, artifacts: [], message: "Job completed" };
  if (typeof result === "object") {
    return {
      kind: "success",
      result: result.result ?? result.output ?? {},
      resultRef: result.result_ref || result.resultRef || "",
      artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
      message: result.message || "Job completed",
      steps: Array.isArray(result.steps) ? result.steps.slice(0, 50) : [],
      lastStep: result.last_step || result.lastStep || "",
    };
  }
  return { kind: "success", result: { value: result }, artifacts: [], message: "Job completed" };
}

// Races the handler against a timeout. On timeout the handler keeps running
// (cooperative cancellation) but the engine finalises the attempt.
function runWithTimeout(factory, timeoutMs) {
  const handlerPromise = Promise.resolve().then(factory);
  if (!timeoutMs || timeoutMs <= 0) return handlerPromise;
  let timer;
  const timeoutPromise = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new JobTimeoutError(`Job exceeded its ${Math.round(timeoutMs / 1000)}s timeout`)), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([handlerPromise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// ── Batch processing ───────────────────────────────────────────────────────

export async function processOnce(db, { workerId = "engine-tick", limit = 10, queueCodes = null, hooks = {} } = {}) {
  const claims = [];
  for (let i = 0; i < Math.max(0, limit); i += 1) {
    const claim = claimJob(db, { workerId, queueCodes });
    if (!claim) break;
    claims.push(claim);
  }
  const summary = { claimed: claims.length, completed: 0, failed: 0, retried: 0, cancelled: 0, jobs: [] };
  const outcomes = await Promise.all(
    claims.map(async (claim) => {
      try {
        return await executeClaimedJob(db, claim, { hooks });
      } catch (error) {
        return { status: "error", error: error.message, job: publicJob(claim.job) };
      }
    })
  );
  for (const outcome of outcomes) {
    summary.jobs.push({ id: outcome.job?.id ?? null, job_ref: outcome.job?.job_ref ?? "", status: outcome.status });
    if (outcome.status === "completed") summary.completed += 1;
    else if (outcome.status === "retrying") summary.retried += 1;
    else if (outcome.status === "cancelled") summary.cancelled += 1;
    else if (outcome.status === "failed" || outcome.status === "timed_out" || outcome.status === "error") summary.failed += 1;
  }
  return summary;
}

// Executes a single already-known job immediately (API "run now" / tests).
export async function runJobNow(db, jobId, { workerId = "engine-run-now", hooks = {} } = {}) {
  const claim = claimSpecificJob(db, jobId, { workerId });
  return executeClaimedJob(db, claim, { hooks });
}

// ── Maintenance ────────────────────────────────────────────────────────────

// Releases jobs waiting on satisfied dependencies and fails those blocked by a
// failed prerequisite. Safety net for dependency edges not covered by the
// reactive evaluator.
export function promoteReadyJobs(db) {
  const summary = { promoted: 0, blocked: 0 };
  const created = queryAll(db, "SELECT * FROM jobs WHERE status = 'created'");
  for (const job of created) {
    const state = dependencyState(db, job.id);
    if (state.total === 0) {
      const result = run(db, "UPDATE jobs SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'created'", [nowIso(), job.id]);
      if (result.changes === 1) {
        recordHistory(db, job.id, { event_type: "status", from_status: "created", to_status: "queued", message: "Job queued", actor_type: "engine", source: "engine" });
        summary.promoted += 1;
      }
    } else if (!state.satisfied) {
      run(db, "UPDATE jobs SET status = 'waiting_for_dependency', updated_at = ? WHERE id = ? AND status = 'created'", [nowIso(), job.id]);
      recordHistory(db, job.id, { event_type: "status", from_status: "created", to_status: "waiting_for_dependency", message: "Waiting for dependencies", actor_type: "engine", source: "engine" });
    }
  }
  const waiting = queryAll(db, "SELECT * FROM jobs WHERE status = 'waiting_for_dependency'");
  for (const job of waiting) {
    const state = dependencyState(db, job.id);
    if (state.blocked) {
      const result = run(
        db,
        "UPDATE jobs SET status = 'failed', error_code = 'dependency_failed', error_message = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'waiting_for_dependency'",
        ["A required dependency failed", nowIso(), nowIso(), job.id]
      );
      if (result.changes === 1) {
        recordHistory(db, job.id, { event_type: "status", from_status: "waiting_for_dependency", to_status: "failed", message: "A required dependency failed", actor_type: "engine", source: "engine" });
        evaluateDependents(db, job.id);
        summary.blocked += 1;
      }
    } else if (state.satisfied) {
      const target = job.scheduled_at && job.scheduled_at > nowIso() ? "scheduled" : "queued";
      const result = run(db, "UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status = 'waiting_for_dependency'", [target, nowIso(), job.id]);
      if (result.changes === 1) {
        recordHistory(db, job.id, { event_type: "status", from_status: "waiting_for_dependency", to_status: target, message: "Dependencies satisfied", actor_type: "engine", source: "engine" });
        summary.promoted += 1;
      }
    }
  }
  return summary;
}

// Recovers jobs whose lease expired (worker crash/restart).
export function recoverStaleJobs(db) {
  const now = nowIso();
  const stale = queryAll(
    db,
    `SELECT * FROM jobs
      WHERE status IN ('running', 'cancel_requested')
        AND (lease_owner = '' OR lease_expires_at IS NULL OR lease_expires_at <= ?)
        AND (heartbeat_at IS NULL OR heartbeat_at <= datetime(?, '-30 seconds'))`,
    [now, now]
  );
  const summary = { recovered: 0, failed: 0, cancelled: 0 };
  for (const job of stale) {
    const policy = resolveQueuePolicy(db, job.queue);
    if (job.status === "cancel_requested") {
      const ts = nowIso();
      const result = run(
        db,
        `UPDATE jobs SET status = 'cancelled', completed_at = ?, cancelled_at = ?, lease_owner = '', lease_expires_at = NULL,
           heartbeat_at = NULL, updated_at = ? WHERE id = ? AND status = 'cancel_requested'`,
        [ts, ts, ts, job.id]
      );
      if (result.changes === 1) {
        recordHistory(db, job.id, { event_type: "status", from_status: "cancel_requested", to_status: "cancelled", message: "Cancelled after worker recovery", actor_type: "engine", source: "engine" });
        evaluateDependents(db, job.id);
        summary.cancelled += 1;
      }
      continue;
    }
    const fresh = queryOne(db, "SELECT * FROM jobs WHERE id = ?", [job.id]);
    const executionId = createExecutionRow(db, fresh, Number(fresh.attempts) || 1, "recovery", fresh.queue);
    const finalStatus = finalizeFailure(
      db,
      fresh,
      executionId,
      { category: "infrastructure", code: "worker_lost", message: "Worker lease expired before completion", retryable: true },
      { timedOut: false, policy, durationMs: 0 }
    );
    if (finalStatus === "retrying") summary.recovered += 1;
    else summary.failed += 1;
  }
  if (stale.length) {
    run(
      db,
      `UPDATE job_workers SET active_jobs = 0, status = 'offline', updated_at = ?
        WHERE status NOT IN ('offline', 'stopped') AND (last_heartbeat IS NULL OR last_heartbeat <= datetime(?, '-90 seconds'))`,
      [now, now]
    );
  }
  return summary;
}

// Detects and finalises jobs that exceeded their timeout.
export function reapTimedOutJobs(db) {
  const now = nowIso();
  const rows = queryAll(
    db,
    `SELECT * FROM jobs
      WHERE status IN ('running', 'cancel_requested')
        AND timeout_seconds > 0
        AND started_at IS NOT NULL
        AND datetime(started_at, '+' || timeout_seconds || ' seconds') <= datetime(?)`,
    [now]
  );
  const summary = { timed_out: 0, retried: 0 };
  for (const job of rows) {
    requestSignal(job.id, "Job exceeded its timeout");
    const policy = resolveQueuePolicy(db, job.queue);
    const fresh = queryOne(db, "SELECT * FROM jobs WHERE id = ?", [job.id]);
    if (fresh.status === "cancel_requested") {
      const executionId = createExecutionRow(db, fresh, Number(fresh.attempts) || 1, "timeout-reaper", fresh.queue);
      finalizeCancelled(db, fresh.id, executionId, { reason: fresh.cancel_reason || "Cancelled", durationMs: 0 });
      summary.timed_out += 1;
      continue;
    }
    const executionId = createExecutionRow(db, fresh, Number(fresh.attempts) || 1, "timeout-reaper", fresh.queue);
    const finalStatus = finalizeFailure(
      db,
      fresh,
      executionId,
      { category: "timeout", code: "job_timeout", message: `Job exceeded its ${fresh.timeout_seconds}s timeout`, retryable: true },
      { timedOut: true, policy, durationMs: 0 }
    );
    if (finalStatus === "retrying") summary.retried += 1;
    else summary.timed_out += 1;
  }
  return summary;
}

// ── Cancellation ───────────────────────────────────────────────────────────

export function requestCancellation(db, jobId, { reason = "", actor = null, ip = null, propagate = true } = {}) {
  const result = cancelJob(db, jobId, { reason, actor, ip });
  const job = result.job;
  if (!job) return result;
  if (!["cancelled", "completed", "failed", "timed_out", "skipped"].includes(job.status)) {
    requestSignal(job.id, reason);
  }
  const propagated = propagate ? propagateCancellation(db, job.id, { reason, actor, ip }) : [];
  return { ...result, propagated };
}

function propagateCancellation(db, parentId, { reason, actor, ip }) {
  const children = queryAll(db, "SELECT id FROM jobs WHERE parent_job_id = ?", [parentId]);
  const propagated = [];
  for (const child of children) {
    const row = queryOne(db, "SELECT * FROM jobs WHERE id = ?", [child.id]);
    if (!row || ["cancelled", "completed", "failed", "timed_out", "skipped"].includes(row.status)) continue;
    cancelJob(db, row.id, { reason: reason || `Parent job ${parentId} cancelled`, actor, ip });
    requestSignal(row.id, reason || "Parent job cancelled");
    propagated.push(row.id);
    propagated.push(...propagateCancellation(db, row.id, { reason, actor, ip }));
  }
  return propagated;
}

export function requestManualRetry(db, jobId, { actor = null, ip = null } = {}) {
  return retryJob(db, jobId, { actor, ip });
}

// ── Orchestration ──────────────────────────────────────────────────────────

export function engineMaintenance(db) {
  return {
    promoted: promoteReadyJobs(db),
    recovered: recoverStaleJobs(db),
    timed_out: reapTimedOutJobs(db),
  };
}

export async function tick(db, { workerId = "engine-tick", run = false, limit = 10, queueCodes = null } = {}) {
  const maintenance = engineMaintenance(db);
  const processed = run ? await processOnce(db, { workerId, limit, queueCodes }) : null;
  return { maintenance, processed };
}

export function engineStatus(db) {
  const queues = queryAll(db, "SELECT code FROM job_queues ORDER BY priority DESC");
  const running = queryOne(db, "SELECT COUNT(*) AS c FROM jobs WHERE status IN ('running', 'cancel_requested')").c;
  const queued = queryOne(db, "SELECT COUNT(*) AS c FROM jobs WHERE status IN ('queued', 'scheduled', 'retrying')").c;
  const deadLetters = queryOne(db, "SELECT COUNT(*) AS c FROM job_dead_letters WHERE status = 'open'").c;
  const workers = queryOne(db, `SELECT COUNT(*) AS c FROM job_workers WHERE status NOT IN ('offline', 'stopped')`).c;
  return {
    queues: queues.map((row) => row.code),
    running_jobs: running,
    queued_jobs: queued,
    open_dead_letters: deadLetters,
    online_workers: workers,
    handlers: listHandlers().map((handler) => handler.code),
    checked_at: nowIso(),
  };
}

export { clampProgress, parseSqlTime, canonicalQueue, publicJob, getJobRow };
