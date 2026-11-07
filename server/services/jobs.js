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
  getJobTypeAsync,
  getJobTypeRow,
  getJobTypeRowAsync,
  listJobTypes,
  listJobTypesAsync,
  createJobType,
  createJobTypeAsync,
  updateJobType,
  updateJobTypeAsync,
  setJobTypeStatus,
  setJobTypeStatusAsync,
  ensureDefaultJobTypes,
  ensureDefaultJobTypesAsync,
} from "./jobs/types.js";

export {
  publicJob,
  submitJob,
  submitJobAsync,
  submit,
  getJob,
  getJobAsync,
  getJobRow,
  getJobRowAsync,
  getStatus,
  getStatusAsync,
  listJobs,
  listJobsAsync,
  transitionJob,
  transitionJobAsync,
  updateProgress,
  updateProgressAsync,
  cancelJob,
  cancelJobAsync,
  retryJob,
  retryJobAsync,
  pauseJob,
  pauseJobAsync,
  resumeJob,
  resumeJobAsync,
  dependencyState,
  dependencyStateAsync,
  addDependencies,
  addDependenciesAsync,
  removeDependency,
  removeDependencyAsync,
  listDependencies,
  listDependenciesAsync,
  listChildren,
  listChildrenAsync,
  evaluateDependents,
  evaluateDependentsAsync,
} from "./jobs/jobs.js";

export {
  JOB_EVENT_TYPES,
  publicHistory,
  recordHistory,
  recordHistoryAsync,
  listHistory,
  listHistoryAsync,
  jobTimeline,
} from "./jobs/history.js";

export {
  publicArtifact,
  addArtifact,
  addArtifactAsync,
  listArtifacts,
  listArtifactsAsync,
  getArtifact,
  resultPayload,
  resultPayloadAsync,
  setJobResult,
  setJobResultAsync,
} from "./jobs/artifacts.js";

export {
  jobStatusCounts,
  jobStatusCountsAsync,
  jobMetrics,
  jobMetricsAsync,
  jobTimeseries,
  jobTimeseriesAsync,
} from "./jobs/metrics.js";
