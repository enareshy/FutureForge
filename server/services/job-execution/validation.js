// Validation + vocabulary for the Job Scheduling & Execution Engine.

import { HttpError } from "../../validation.js";
import {
  PRIORITIES,
  assertPriority,
  assertQueue,
  assertJobTypeCode,
  safeParse,
  truncate,
} from "../jobs/validation.js";
import { isValidTimeZone } from "./timezone.js";
import { parseCron } from "./cron.js";

export { PRIORITIES, assertPriority };

// The nine logical queues required of the execution engine. Queues own
// capacity/retry/timeout policy; job types map onto them through aliases.
export const LOGICAL_QUEUES = [
  "DEFAULT",
  "HIGH_PRIORITY",
  "IMPORT",
  "CAD_PROCESSING",
  "REPORTING",
  "INTEGRATION",
  "SEARCH_INDEXING",
  "WORKFLOW",
  "MAINTENANCE",
];

export const DEFAULT_QUEUES = [
  {
    code: "DEFAULT",
    name: "Default Queue",
    description: "General purpose background work with balanced throughput.",
    priority: 50,
    max_concurrency: 6,
    rate_limit_per_minute: 600,
    retry_max_attempts: 3,
    retry_strategy: "exponential",
    retry_delay_seconds: 30,
    retry_max_delay_seconds: 3600,
    timeout_seconds: 600,
  },
  {
    code: "HIGH_PRIORITY",
    name: "High Priority",
    description: "Interactive and user-blocking work that must pre-empt bulk queues.",
    priority: 100,
    max_concurrency: 4,
    rate_limit_per_minute: 300,
    retry_max_attempts: 3,
    retry_strategy: "exponential",
    retry_delay_seconds: 10,
    retry_max_delay_seconds: 600,
    timeout_seconds: 300,
  },
  {
    code: "IMPORT",
    name: "Import",
    description: "Bulk data import and ingestion workloads.",
    priority: 60,
    max_concurrency: 2,
    rate_limit_per_minute: 60,
    retry_max_attempts: 2,
    retry_strategy: "exponential",
    retry_delay_seconds: 60,
    retry_max_delay_seconds: 1800,
    timeout_seconds: 3600,
  },
  {
    code: "CAD_PROCESSING",
    name: "CAD Processing",
    description: "Compute intensive CAD conversion and geometry processing.",
    priority: 70,
    max_concurrency: 2,
    rate_limit_per_minute: 30,
    retry_max_attempts: 2,
    retry_strategy: "fixed",
    retry_delay_seconds: 120,
    retry_max_delay_seconds: 1200,
    timeout_seconds: 5400,
  },
  {
    code: "REPORTING",
    name: "Reporting",
    description: "Report and document generation.",
    priority: 40,
    max_concurrency: 3,
    rate_limit_per_minute: 60,
    retry_max_attempts: 3,
    retry_strategy: "exponential",
    retry_delay_seconds: 60,
    retry_max_delay_seconds: 1800,
    timeout_seconds: 1800,
  },
  {
    code: "INTEGRATION",
    name: "Integration",
    description: "Outbound/inbound integration and provider synchronisation.",
    priority: 45,
    max_concurrency: 3,
    rate_limit_per_minute: 120,
    retry_max_attempts: 5,
    retry_strategy: "exponential",
    retry_delay_seconds: 30,
    retry_max_delay_seconds: 3600,
    timeout_seconds: 900,
  },
  {
    code: "SEARCH_INDEXING",
    name: "Search Indexing",
    description: "Search index rebuild and incremental indexing.",
    priority: 30,
    max_concurrency: 2,
    rate_limit_per_minute: 60,
    retry_max_attempts: 3,
    retry_strategy: "exponential",
    retry_delay_seconds: 30,
    retry_max_delay_seconds: 900,
    timeout_seconds: 1800,
  },
  {
    code: "WORKFLOW",
    name: "Workflow",
    description: "Workflow task orchestration and step execution.",
    priority: 55,
    max_concurrency: 4,
    rate_limit_per_minute: 120,
    retry_max_attempts: 3,
    retry_strategy: "exponential",
    retry_delay_seconds: 30,
    retry_max_delay_seconds: 1200,
    timeout_seconds: 1800,
  },
  {
    code: "MAINTENANCE",
    name: "Maintenance",
    description: "Low priority housekeeping, cleanup and reconciliation.",
    priority: 20,
    max_concurrency: 1,
    rate_limit_per_minute: 12,
    retry_max_attempts: 1,
    retry_strategy: "fixed",
    retry_delay_seconds: 300,
    retry_max_delay_seconds: 600,
    timeout_seconds: 1800,
  },
];

// Historical / business queue codes normalise onto the logical queues so job
// types declared before the engine existed keep working unchanged.
const QUEUE_ALIASES = {
  default: "DEFAULT",
  general: "DEFAULT",
  standard: "DEFAULT",
  math: "DEFAULT",
  email: "DEFAULT",
  notifications: "DEFAULT",
  tests: "DEFAULT",
  high: "HIGH_PRIORITY",
  high_priority: "HIGH_PRIORITY",
  priority: "HIGH_PRIORITY",
  critical: "HIGH_PRIORITY",
  urgent: "HIGH_PRIORITY",
  import: "IMPORT",
  imports: "IMPORT",
  ingestion: "IMPORT",
  bulk: "IMPORT",
  cad: "CAD_PROCESSING",
  cad_processing: "CAD_PROCESSING",
  geometry: "CAD_PROCESSING",
  report: "REPORTING",
  reports: "REPORTING",
  reporting: "REPORTING",
  integration: "INTEGRATION",
  integrations: "INTEGRATION",
  sync: "INTEGRATION",
  search: "SEARCH_INDEXING",
  indexing: "SEARCH_INDEXING",
  search_indexing: "SEARCH_INDEXING",
  workflow: "WORKFLOW",
  workflows: "WORKFLOW",
  maintenance: "MAINTENANCE",
  housekeeping: "MAINTENANCE",
  cleanup: "MAINTENANCE",
};

export function canonicalQueue(code) {
  const raw = String(code ?? "").trim();
  if (!raw) return "DEFAULT";
  const upper = raw.toUpperCase();
  if (LOGICAL_QUEUES.includes(upper)) return upper;
  return QUEUE_ALIASES[raw.toLowerCase()] || "DEFAULT";
}

export function queueAliasCodes(code) {
  const canonical = canonicalQueue(code);
  const codes = new Set([canonical]);
  for (const [alias, target] of Object.entries(QUEUE_ALIASES)) {
    if (target === canonical) codes.add(alias);
  }
  return [...codes];
}

export const RETRY_STRATEGIES = ["none", "fixed", "exponential"];
export const SCHEDULE_STATUSES = ["active", "paused", "disabled", "completed", "expired"];
export const FAILURE_POLICIES = ["continue", "pause", "disable"];
export const CONCURRENCY_POLICIES = ["allow", "skip", "queue", "cancel_previous"];
export const CATCHUP_POLICIES = ["skip", "run_once", "run_all"];
export const SCHEDULE_TYPES = ["once", "interval", "daily", "weekly", "monthly", "cron"];
export const WORKER_STATUSES = ["starting", "idle", "busy", "draining", "stopped", "offline"];
export const DEAD_LETTER_STATUSES = ["open", "requeued", "discarded"];

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function clampInt(value, { min = 0, max = 1000000, fallback = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export function assertScheduleType(type) {
  if (!SCHEDULE_TYPES.includes(type)) {
    throw new HttpError(400, `schedule_type must be one of: ${SCHEDULE_TYPES.join(", ")}`);
  }
}

export function assertScheduleStatus(status) {
  if (!SCHEDULE_STATUSES.includes(status)) {
    throw new HttpError(400, `status must be one of: ${SCHEDULE_STATUSES.join(", ")}`);
  }
}

export function assertRetryStrategy(strategy) {
  if (!RETRY_STRATEGIES.includes(strategy)) {
    throw new HttpError(400, `retry_strategy must be one of: ${RETRY_STRATEGIES.join(", ")}`);
  }
}

export function assertFailurePolicy(policy) {
  if (!FAILURE_POLICIES.includes(policy)) {
    throw new HttpError(400, `failure_policy must be one of: ${FAILURE_POLICIES.join(", ")}`);
  }
}

export function assertConcurrencyPolicy(policy) {
  if (!CONCURRENCY_POLICIES.includes(policy)) {
    throw new HttpError(400, `concurrency_policy must be one of: ${CONCURRENCY_POLICIES.join(", ")}`);
  }
}

export function assertCatchupPolicy(policy) {
  if (!CATCHUP_POLICIES.includes(policy)) {
    throw new HttpError(400, `catchup_policy must be one of: ${CATCHUP_POLICIES.join(", ")}`);
  }
}

export function assertTimezone(timeZone) {
  if (!isValidTimeZone(timeZone)) {
    throw new HttpError(400, `timezone "${timeZone}" is not a recognised IANA time zone`);
  }
}

export function assertClock(value, label = "daily_time") {
  if (!CLOCK.test(String(value || ""))) {
    throw new HttpError(400, `${label} must use 24-hour HH:MM format`);
  }
}

export function normalizeWeekdays(value) {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  const days = [...new Set(list.map((item) => Number(item)).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))];
  if (!days.length) throw new HttpError(400, "weekdays must contain at least one day between 0 (Sunday) and 6 (Saturday)");
  return days.sort((a, b) => a - b);
}

function assertTimestamp(value, label) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?(Z|[+-]\d{2}:?\d{2})?$/.test(text)) {
    throw new HttpError(400, `${label} must be an ISO-8601 date or date-time`);
  }
  return text;
}

export function normalizeQueueInput(input = {}) {
  const code = String(input.code || "").trim().toUpperCase();
  if (!code || !/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
    throw new HttpError(400, "code must start with a letter and contain only A-Z, 0-9 and _ (2-64 chars)");
  }
  const strategy = String(input.retry_strategy || input.retryStrategy || "exponential").toLowerCase();
  assertRetryStrategy(strategy);
  return {
    code,
    name: truncate(input.name || code, 200),
    description: truncate(input.description || "", 2000),
    tenant_id: input.tenant_id === undefined || input.tenant_id === null || input.tenant_id === "" ? null : Number(input.tenant_id) || null,
    priority: clampInt(input.priority, { min: 0, max: 1000, fallback: 50 }),
    max_concurrency: clampInt(input.max_concurrency ?? input.maxConcurrency, { min: 1, max: 512, fallback: 4 }),
    worker_allocation: clampInt(input.worker_allocation ?? input.workerAllocation, { min: 0, max: 512, fallback: 0 }),
    rate_limit_per_minute: clampInt(input.rate_limit_per_minute ?? input.rateLimitPerMinute, { min: 0, max: 1000000, fallback: 0 }),
    retry_max_attempts: clampInt(input.retry_max_attempts ?? input.retryMaxAttempts, { min: 0, max: 50, fallback: 3 }),
    retry_strategy: strategy,
    retry_delay_seconds: clampInt(input.retry_delay_seconds ?? input.retryDelaySeconds, { min: 0, max: 604800, fallback: 30 }),
    retry_max_delay_seconds: clampInt(input.retry_max_delay_seconds ?? input.retryMaxDelaySeconds, { min: 0, max: 604800, fallback: 3600 }),
    timeout_seconds: clampInt(input.timeout_seconds ?? input.timeoutSeconds, { min: 0, max: 604800, fallback: 600 }),
    enabled: input.enabled === undefined ? 1 : input.enabled ? 1 : 0,
    paused: input.paused ? 1 : 0,
    config_json: JSON.stringify(input.config && typeof input.config === "object" ? input.config : safeParse(input.config_json, {})),
  };
}

export function normalizeScheduleInput(db, input = {}, { partial = false } = {}) {
  const fields = {};

  const assign = (key, value) => {
    fields[key] = value;
  };

  if (input.code !== undefined || !partial) {
    const code = String(input.code || "").trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(code)) {
      throw new HttpError(400, "code must start with a letter and contain only A-Z, 0-9 and _ (2-64 chars)");
    }
    assign("code", code);
  }
  if (input.name !== undefined || !partial) assign("name", truncate(input.name || "", 200));
  if (input.description !== undefined) assign("description", truncate(input.description, 2000));
  if (input.job_type_code !== undefined || input.jobTypeCode !== undefined || !partial) {
    const code = String(input.job_type_code || input.jobTypeCode || "").trim().toUpperCase();
    assertJobTypeCode(code);
    assign("job_type_code", code);
  }
  if (input.queue !== undefined || !partial) assign("queue", assertQueue(input.queue || "DEFAULT"));
  if (input.priority !== undefined || !partial) {
    const priority = input.priority || "normal";
    assertPriority(priority);
    assign("priority", priority);
  }

  const type = String(input.schedule_type || input.scheduleType || (partial ? "" : "once")).toLowerCase();
  if (type) {
    assertScheduleType(type);
    assign("schedule_type", type);
  }

  if (input.timezone !== undefined || !partial) {
    const timeZone = String(input.timezone || "UTC");
    assertTimezone(timeZone);
    assign("timezone", timeZone);
  }

  if (input.cron_expression !== undefined || input.cronExpression !== undefined) {
    const expression = String(input.cron_expression ?? input.cronExpression ?? "").trim();
    if (expression) parseCron(expression);
    assign("cron_expression", expression);
  }
  if (input.interval_seconds !== undefined || input.intervalSeconds !== undefined) {
    assign("interval_seconds", clampInt(input.interval_seconds ?? input.intervalSeconds, { min: 0, max: 315360000, fallback: 0 }));
  }
  if (input.daily_time !== undefined || input.dailyTime !== undefined) {
    const value = String(input.daily_time ?? input.dailyTime ?? "00:00");
    assertClock(value);
    assign("daily_time", value);
  }
  if (input.weekdays !== undefined || input.weekdays_json !== undefined) {
    const raw = input.weekdays !== undefined ? input.weekdays : input.weekdays_json;
    assign("weekdays_json", JSON.stringify(normalizeWeekdays(raw)));
  }
  if (input.day_of_month !== undefined || input.dayOfMonth !== undefined) {
    assign("day_of_month", clampInt(input.day_of_month ?? input.dayOfMonth, { min: 1, max: 31, fallback: 1 }));
  }
  if (input.start_at !== undefined || input.startAt !== undefined) {
    assign("start_at", assertTimestamp(input.start_at ?? input.startAt, "start_at"));
  }
  if (input.end_at !== undefined || input.endAt !== undefined) {
    assign("end_at", assertTimestamp(input.end_at ?? input.endAt, "end_at"));
  }
  if (input.max_executions !== undefined || input.maxExecutions !== undefined) {
    assign("max_executions", clampInt(input.max_executions ?? input.maxExecutions, { min: 0, max: 1000000, fallback: 0 }));
  }
  if (input.max_retries !== undefined || input.maxRetries !== undefined) {
    assign("max_retries", clampInt(input.max_retries ?? input.maxRetries, { min: 0, max: 50, fallback: 0 }));
  }
  if (input.timeout_seconds !== undefined || input.timeoutSeconds !== undefined) {
    assign("timeout_seconds", clampInt(input.timeout_seconds ?? input.timeoutSeconds, { min: 0, max: 604800, fallback: 0 }));
  }
  if (input.retry_strategy !== undefined || input.retryStrategy !== undefined) {
    const strategy = String(input.retry_strategy ?? input.retryStrategy ?? "exponential").toLowerCase();
    assertRetryStrategy(strategy);
    assign("retry_strategy", strategy);
  }
  if (input.retry_delay_seconds !== undefined || input.retryDelaySeconds !== undefined) {
    assign("retry_delay_seconds", clampInt(input.retry_delay_seconds ?? input.retryDelaySeconds, { min: 0, max: 604800, fallback: 30 }));
  }
  if (input.failure_policy !== undefined || input.failurePolicy !== undefined) {
    const policy = String(input.failure_policy ?? input.failurePolicy ?? "continue").toLowerCase();
    assertFailurePolicy(policy);
    assign("failure_policy", policy);
  }
  if (input.concurrency_policy !== undefined || input.concurrencyPolicy !== undefined) {
    const policy = String(input.concurrency_policy ?? input.concurrencyPolicy ?? "allow").toLowerCase();
    assertConcurrencyPolicy(policy);
    assign("concurrency_policy", policy);
  }
  if (input.catchup_policy !== undefined || input.catchupPolicy !== undefined) {
    const policy = String(input.catchup_policy ?? input.catchupPolicy ?? "skip").toLowerCase();
    assertCatchupPolicy(policy);
    assign("catchup_policy", policy);
  }
  if (input.payload !== undefined || input.payload_json !== undefined) {
    const payload = input.payload !== undefined ? input.payload : safeParse(input.payload_json, {});
    assign("payload_json", JSON.stringify(payload && typeof payload === "object" ? payload : {}));
  }
  if (input.enabled !== undefined) assign("enabled", input.enabled ? 1 : 0);
  if (input.status !== undefined) {
    assertScheduleStatus(String(input.status));
    assign("status", String(input.status));
  }

  // Cadence-specific requirements.
  const resolvedType = fields.schedule_type;
  if (resolvedType === "interval") {
    const seconds = fields.interval_seconds !== undefined ? fields.interval_seconds : partial ? undefined : 0;
    if (seconds !== undefined && seconds <= 0) {
      throw new HttpError(400, "interval_seconds must be greater than zero for interval schedules");
    }
  }
  if (resolvedType === "cron") {
    const expression = fields.cron_expression !== undefined ? fields.cron_expression : partial ? undefined : "";
    if (expression !== undefined && !expression) {
      throw new HttpError(400, "cron_expression is required for cron schedules");
    }
  }
  if (resolvedType === "weekly") {
    const days = fields.weekdays_json !== undefined ? safeParse(fields.weekdays_json, []) : partial ? null : [];
    if (days !== null && !days.length) {
      throw new HttpError(400, "weekdays is required for weekly schedules");
    }
  }

  return fields;
}
