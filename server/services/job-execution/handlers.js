// Handler registry and execution context for the engine.
//
// The engine owns *execution* only: it looks up the handler registered for a
// job type and invokes it. Handlers are contributed by the module that owns the
// business capability (or by the Job Management module), keeping business logic
// out of the engine. Handlers receive a rich, cancellation-aware context.

import { queryOne } from "../../db.js";
import { truncate } from "../jobs/validation.js";
import { updateProgress, getJobRow } from "../jobs/jobs.js";
import { getJobTypeRow } from "../jobs/types.js";
import { JobCancelledError, JobError } from "./errors.js";
import { getSignal } from "./signals.js";
import { acquireLock, releaseLock, renewLock } from "./locks.js";
import { parseSqlTime } from "./timezone.js";

const registry = new Map();

export function registerHandler(code, handler, options = {}) {
  const key = String(code || "").trim().toUpperCase();
  if (!key) throw new JobError("Handler code is required", { category: "business_validation" });
  if (typeof handler !== "function") {
    throw new JobError(`Handler for ${key} must be a function`, { category: "business_validation" });
  }
  registry.set(key, {
    code: key,
    handler,
    description: String(options.description || ""),
    timeoutSeconds: Number(options.timeoutSeconds) || 0,
    steps: Array.isArray(options.steps) ? options.steps : [],
  });
  return registry.get(key);
}

export function unregisterHandler(code) {
  return registry.delete(String(code || "").trim().toUpperCase());
}

export function getHandler(code) {
  return registry.get(String(code || "").trim().toUpperCase()) || null;
}

export function hasHandler(code) {
  return registry.has(String(code || "").trim().toUpperCase());
}

export function listHandlers() {
  return [...registry.values()].map((entry) => ({
    code: entry.code,
    description: entry.description,
    timeout_seconds: entry.timeoutSeconds,
    steps: entry.steps,
  }));
}

export function clearHandlers() {
  registry.clear();
}

export async function invokeHandler(code, context) {
  const entry = getHandler(code);
  if (!entry) {
    throw new JobError(`No handler registered for job type ${String(code || "").toUpperCase()}`, {
      category: "business_validation",
      code: "handler_not_registered",
    });
  }
  return entry.handler(context);
}

// Resolves the registered handler for a job: the job type's `handler`
// identifier takes precedence, falling back to the job type code.
export function handlerKeyForJob(db, job) {
  const type = getJobTypeRow(db, job?.job_type_code);
  const primary = String(type?.handler || "").trim().toUpperCase();
  if (primary && registry.has(primary)) return primary;
  const code = String(job?.job_type_code || "").trim().toUpperCase();
  if (registry.has(code)) return code;
  return primary || code;
}

export async function invokeHandlerForJob(db, job, context) {
  return invokeHandler(handlerKeyForJob(db, job), context);
}

function structuredLog(level, job, message, detail) {
  const line = {
    ts: new Date().toISOString(),
    level,
    component: "job-engine",
    job_id: job?.id,
    job_ref: job?.job_ref,
    job_type: job?.job_type_code,
    correlation_id: job?.correlation_id || undefined,
    message,
    ...(detail && Object.keys(detail).length ? { detail } : {}),
  };
  const serialized = JSON.stringify(line);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.log(serialized);
}

// Builds the context handed to a handler. `onStep` lets the engine persist the
// current step for observability / retry-from-step.
export function createJobContext({ db, job, queue, workerId, attempt, onStep = null, progressIntervalMs = 800, deadline = null }) {
  const jobId = Number(job.id);
  let lastWriteAt = 0;
  let lastProgress = Number(job.progress) || 0;
  let lastStage = job.stage || "";

  const context = {
    db,
    worker_id: workerId,
    job_id: jobId,
    job_ref: job.job_ref,
    job_type_code: job.job_type_code,
    tenant_id: job.tenant_id ?? null,
    organization_id: job.organization_id ?? null,
    correlation_id: job.correlation_id || "",
    queue: queue?.code || job.queue,
    attempt,
    input: {},
    signal: {
      get cancelled() {
        return Boolean(getSignal(jobId)) || context._dbCancelled;
      },
      get reason() {
        return getSignal(jobId)?.reason || context._cancelReason || "";
      },
    },
    _dbCancelled: false,
    _cancelReason: "",
  };

  try {
    context.input = job.input_json ? JSON.parse(job.input_json) : {};
  } catch {
    context.input = {};
  }

  context.checkCancelled = () => {
    const signal = getSignal(jobId);
    const row = queryOne(db, "SELECT status, cancel_reason FROM jobs WHERE id = ?", [jobId]);
    if (row && (row.status === "cancel_requested" || row.status === "cancelled")) {
      context._dbCancelled = true;
      context._cancelReason = row.cancel_reason || "";
    }
    if (deadline && Date.now() > deadline) {
      throw new JobError("Job exceeded its configured timeout", { category: "timeout", code: "job_timeout" });
    }
    if (signal?.cancelled || context._dbCancelled) {
      throw new JobCancelledError(signal?.reason || context._cancelReason || "Job cancelled");
    }
    return false;
  };

  context.reportProgress = (update = {}, { force = false } = {}) => {
    const now = Date.now();
    const progress = update.progress === undefined ? lastProgress : Number(update.progress);
    const stage = update.stage === undefined ? lastStage : String(update.stage || "");
    const significant =
      force ||
      progress !== lastProgress ||
      stage !== lastStage ||
      now - lastWriteAt >= progressIntervalMs ||
      progress >= 100;
    if (!significant) return null;
    lastWriteAt = now;
    lastProgress = progress;
    lastStage = stage;
    try {
      updateProgress(
        db,
        jobId,
        {
          progress,
          stage,
          message: update.message,
          detail: {
            processed: update.processed,
            total: update.total,
            failed: update.failed,
            skipped: update.skipped,
            eta_seconds: update.eta_seconds,
            ...(update.detail || {}),
          },
          worker_id: workerId,
          source: "engine",
        },
        { actor: null }
      );
    } catch (error) {
      structuredLog("warn", job, "Progress update rejected", { error: error.message });
      return null;
    }
    return { progress, stage };
  };

  context.step = (name, update = {}) => {
    if (onStep) {
      try {
        onStep(String(name || ""), update);
      } catch {
        /* step bookkeeping is best effort */
      }
    }
    return context.reportProgress({ stage: String(name || ""), ...update }, { force: true });
  };

  context.log = (level, message, detail) => structuredLog(level || "info", job, message, detail);

  context.getJob = () => getJobRow(db, jobId);

  context.elapsedMs = () => Date.now() - (context._startedAt || Date.now());
  context._startedAt = Date.now();

  context.lock = async (name, ttlSeconds, fn) => {
    const lockName = `job:${jobId}:${name}`;
    const owner = `${workerId}:${jobId}`;
    if (!acquireLock(db, lockName, owner, { ttlSeconds: ttlSeconds || 60, purpose: `job:${job.job_ref}` })) {
      return { locked: false, skipped: true };
    }
    try {
      const result = await fn({ renew: (seconds) => renewLock(db, lockName, owner, { ttlSeconds: seconds || ttlSeconds || 60 }) });
      return { locked: true, result };
    } finally {
      releaseLock(db, lockName, owner);
    }
  };

  return context;
}

// Convenience helper for handlers that only need to read the job payload.
export function jobInput(row) {
  try {
    return row?.input_json ? JSON.parse(row.input_json) : {};
  } catch {
    return {};
  }
}

export function truncateText(value, max = 2000) {
  return truncate(value, max);
}

export function isExpired(value) {
  const date = parseSqlTime(value);
  return Boolean(date && date.getTime() <= Date.now());
}
