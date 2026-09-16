// Job Scheduling & Execution Engine (public facade).
//
// Centralized execution infrastructure for jobs submitted through the
// Background Job Management module: logical queues, worker pool, scheduling
// and recurrence, retries/backoff, timeouts, cancellation, concurrency,
// distributed locking, dead-letter handling, metrics and health.
//
// Scope note: the engine owns execution only. Business processing lives in
// handlers registered by the owning modules (`registerHandler`). The engine
// resolves a job's job type to its handler and invokes it with a
// cancellation-aware context.

export {
  LOGICAL_QUEUES,
  DEFAULT_QUEUES,
  RETRY_STRATEGIES,
  SCHEDULE_STATUSES,
  FAILURE_POLICIES,
  CONCURRENCY_POLICIES,
  CATCHUP_POLICIES,
  SCHEDULE_TYPES,
  WORKER_STATUSES,
  DEAD_LETTER_STATUSES,
  PRIORITIES,
  canonicalQueue,
  queueAliasCodes,
  normalizeQueueInput,
  normalizeScheduleInput,
} from "./job-execution/validation.js";

export {
  ERROR_CATEGORIES,
  categoryLabel,
  isRetryableCategory,
  isPermanentCategory,
  classifyError,
  JobError,
  JobTimeoutError,
  JobCancelledError,
} from "./job-execution/errors.js";

export {
  ensureDefaultQueues,
  listQueues,
  getQueue,
  getQueueRow,
  createQueue,
  updateQueue,
  setQueueEnabled,
  setQueuePaused,
  queueHealth,
  queueLoad,
  orderQueuesForClaim,
  resolveQueuePolicy,
  publicQueue,
} from "./job-execution/queues.js";

export {
  publicSchedule,
  listSchedules,
  getSchedule,
  getScheduleRow,
  createSchedule,
  updateSchedule,
  setScheduleStatus,
  setScheduleEnabled,
  runScheduleNow,
  listScheduleRuns,
  sweepSchedules,
  reconcileScheduleRuns,
} from "./job-execution/schedules.js";

export {
  publicDeadLetter,
  getDeadLetterRow,
  listDeadLetters,
  requeueDeadLetter,
  discardDeadLetter,
} from "./job-execution/deadletter.js";

export {
  publicWorker,
  generateWorkerId,
  registerWorker,
  heartbeatWorker,
  listWorkers,
  reapStaleWorkers,
} from "./job-execution/worker-registry.js";

export {
  registerHandler,
  unregisterHandler,
  getHandler,
  hasHandler,
  listHandlers,
  clearHandlers,
  handlerKeyForJob,
} from "./job-execution/handlers.js";

export {
  DEFAULT_LEASE_SECONDS,
  claimJob,
  claimSpecificJob,
  executeClaimedJob,
  processOnce,
  runJobNow,
  promoteReadyJobs,
  recoverStaleJobs,
  reapTimedOutJobs,
  requestCancellation,
  requestManualRetry,
  engineMaintenance,
  engineStatus,
  tick,
  resolveEffectiveTimeout,
} from "./job-execution/engine.js";

export { createWorker, EngineWorker } from "./job-execution/worker.js";

export { executionMetrics, jobStatusCounts } from "./job-execution/metrics.js";

export { effectiveMaxRetries, computeRetryDelay, decideRetry } from "./job-execution/retry.js";

export { computeNextRun, nextRunAt, describeSchedule } from "./job-execution/recurrence.js";

export { acquireLock, releaseLock, renewLock, getLock, withLock, purgeExpiredLocks } from "./job-execution/locks.js";

export { requestSignal, clearSignal, getSignal, isCancelled } from "./job-execution/signals.js";

export { registerDemoHandlers } from "./job-execution/demo-handlers.js";

export { recordEngineAudit, listEngineAudit } from "./job-execution/audit.js";
