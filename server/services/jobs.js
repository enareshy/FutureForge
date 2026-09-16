// Background Job Management module (public facade).
//
// Centralized registry, submission, monitoring, control and tracking for
// asynchronous jobs across the enterprise platform. Business modules submit
// work here and receive a Job ID immediately; they do not build their own job
// management, tracking or history.
//
// Scope note: the actual execution infrastructure (queues, workers, scheduling
// algorithms, retry execution) is provided by the separate Job Scheduling &
// Execution Engine. This module owns the durable job record, the status model,
// history, dependencies, results and management operations. It never executes
// long-running work inside a request.

export {
  JOB_STATUSES,
  JOB_STATUS_LABELS,
  TERMINAL_STATUSES,
  ACTIVE_STATUSES,
  SUCCESS_STATUSES,
  JOB_TRANSITIONS,
  SUBMITTED_AS,
  ARTIFACT_KINDS,
  DEFAULT_QUEUE,
  PRIORITIES,
  assertJobStatus,
  assertJobTypeCode,
  assertArtifactKind,
  assertSubmittedAs,
  assertPriority,
  assertQueue,
  assertTransition,
  canTransition,
  isTerminalStatus,
  statusLabel,
  clampProgress,
  normalizeMaxRetries,
  safeParse,
  addSeconds,
  truncate,
} from "./jobs/validation.js";

export {
  DEFAULT_TYPES,
  publicJobType,
  getJobType,
  getJobTypeRow,
  listJobTypes,
  createJobType,
  updateJobType,
  setJobTypeStatus,
  ensureDefaultJobTypes,
} from "./jobs/types.js";

export {
  publicJob,
  submitJob,
  submit,
  getJob,
  getJobRow,
  getStatus,
  listJobs,
  transitionJob,
  updateProgress,
  cancelJob,
  retryJob,
  pauseJob,
  resumeJob,
  dependencyState,
  addDependencies,
  removeDependency,
  listDependencies,
  listChildren,
  evaluateDependents,
} from "./jobs/jobs.js";

export {
  JOB_EVENT_TYPES,
  publicHistory,
  recordHistory,
  listHistory,
  jobTimeline,
} from "./jobs/history.js";

export {
  publicArtifact,
  addArtifact,
  listArtifacts,
  getArtifact,
  resultPayload,
  setJobResult,
} from "./jobs/artifacts.js";

export {
  jobStatusCounts,
  jobMetrics,
  jobTimeseries,
} from "./jobs/metrics.js";
