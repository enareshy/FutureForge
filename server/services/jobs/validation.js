import { HttpError } from "../../validation.js";
import { PRIORITIES, assertPriority } from "../notifications/validation.js";

// Vocabulary for the Background Job Management module. The module manages job
// definitions, submission, monitoring and control only; execution is owned by
// the separate Job Scheduling & Execution Engine. Statuses are stored
// lower-case and exposed upper-case to match the enterprise vocabulary
// (CREATED, QUEUED, ...).

export { PRIORITIES, assertPriority };

export const JOB_STATUSES = [
  "created",
  "queued",
  "waiting_for_dependency",
  "scheduled",
  "running",
  "paused",
  "completed",
  "failed",
  "retrying",
  "cancel_requested",
  "cancelled",
  "timed_out",
  "skipped",
];

export const JOB_STATUS_LABELS = {
  created: "CREATED",
  queued: "QUEUED",
  waiting_for_dependency: "WAITING_FOR_DEPENDENCY",
  scheduled: "SCHEDULED",
  running: "RUNNING",
  paused: "PAUSED",
  completed: "COMPLETED",
  failed: "FAILED",
  retrying: "RETRYING",
  cancel_requested: "CANCEL_REQUESTED",
  cancelled: "CANCELLED",
  timed_out: "TIMED_OUT",
  skipped: "SKIPPED",
};

export const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "timed_out", "skipped"];
export const ACTIVE_STATUSES = [
  "created",
  "queued",
  "waiting_for_dependency",
  "scheduled",
  "running",
  "paused",
  "retrying",
  "cancel_requested",
];
export const SUCCESS_STATUSES = ["completed"];

// Management-side state machine. The execution engine is expected to move jobs
// along these edges; the module rejects illegal transitions to keep history
// consistent. "retry" and "resume" deliberately re-open terminal states.
export const JOB_TRANSITIONS = {
  created: ["queued", "scheduled", "waiting_for_dependency", "cancelled", "skipped"],
  waiting_for_dependency: ["queued", "cancelled", "skipped", "failed"],
  scheduled: ["queued", "running", "cancelled", "skipped", "failed"],
  queued: ["running", "paused", "cancelled", "cancel_requested", "skipped", "failed", "timed_out", "queued"],
  running: ["paused", "completed", "failed", "retrying", "cancel_requested", "cancelled", "timed_out"],
  paused: ["queued", "running", "cancelled", "cancel_requested"],
  retrying: ["queued", "running", "failed", "cancelled", "timed_out", "completed"],
  cancel_requested: ["cancelled", "failed", "completed", "cancel_requested"],
  failed: ["retrying", "queued", "cancelled", "skipped"],
  completed: ["retrying", "queued"],
  cancelled: ["retrying", "queued"],
  timed_out: ["retrying", "queued"],
  skipped: ["queued", "retrying"],
};

export const SUBMITTED_AS = ["user", "system", "schedule", "event", "workflow", "integration"];

export const ARTIFACT_KINDS = [
  "output",
  "report",
  "error",
  "import",
  "cad",
  "validation",
  "log",
  "export",
  "other",
];

export const DEFAULT_QUEUE = "default";
export const DEFAULT_JOB_NAME = "Background job";

const STATUS_SET = new Set(JOB_STATUSES);
const TERMINAL_SET = new Set(TERMINAL_STATUSES);
const ARTIFACT_SET = new Set(ARTIFACT_KINDS);
const SUBMITTED_AS_SET = new Set(SUBMITTED_AS);

const TYPE_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function assertJobStatus(status, label = "status") {
  if (!STATUS_SET.has(status)) {
    throw new HttpError(400, `${label} must be one of: ${JOB_STATUSES.join(", ")}`);
  }
}

export function assertJobTypeCode(code, label = "job_type_code") {
  if (!TYPE_CODE.test(String(code || ""))) {
    throw new HttpError(400, `${label} must start with a letter and contain only A-Z, 0-9 and _ (2-64 chars)`);
  }
}

export function assertArtifactKind(kind, label = "kind") {
  if (!ARTIFACT_SET.has(kind)) {
    throw new HttpError(400, `${label} must be one of: ${ARTIFACT_KINDS.join(", ")}`);
  }
}

export function assertSubmittedAs(value, label = "submitted_as") {
  if (!SUBMITTED_AS_SET.has(value)) {
    throw new HttpError(400, `${label} must be one of: ${SUBMITTED_AS.join(", ")}`);
  }
}

export function assertQueue(queue, label = "queue") {
  const value = String(queue ?? "").trim();
  if (!value || value.length > 64 || !/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new HttpError(400, `${label} must be a short code (letters, digits, dot, dash, underscore)`);
  }
  return value;
}

export function statusLabel(status) {
  return JOB_STATUS_LABELS[status] || String(status || "").toUpperCase();
}

export function isTerminalStatus(status) {
  return TERMINAL_SET.has(status);
}

export function canTransition(from, to, { allowSame = false } = {}) {
  if (!STATUS_SET.has(to)) return false;
  if (from === to) return allowSame;
  const allowed = JOB_TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new HttpError(409, `Invalid job status transition: ${String(from).toUpperCase()} -> ${String(to).toUpperCase()}`);
  }
}

export function clampProgress(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function normalizeMaxRetries(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(0, Number(fallback) || 0);
  return Math.max(0, Math.min(50, Math.round(n)));
}

export function truncate(value, max = 2000) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

export function safeParse(json, fallback = {}) {
  if (json === null || json === undefined || json === "") return fallback;
  if (typeof json === "object") return json;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

export function addSeconds(base, seconds) {
  const date = base ? new Date(String(base).replace(" ", "T") + "Z") : new Date();
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  safe.setSeconds(safe.getSeconds() + Number(seconds || 0));
  return safe.toISOString().replace("T", " ").slice(0, 19);
}
