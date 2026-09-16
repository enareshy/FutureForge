import { HttpError } from "../../validation.js";
import {
  CHANNELS,
  PRIORITIES,
  PROVIDER_TYPES,
  assertChannel,
  assertProviderType,
  safeParse,
} from "../notifications/validation.js";

// Vocabulary for the Communication & Delivery Services module. Channel and
// provider vocabularies are re-used from the Notification Management module so
// the two services never drift apart; the delivery-specific lifecycle adds the
// DEAD_LETTERED terminal state and retry/dead-letter tuning.

export { CHANNELS, PRIORITIES, PROVIDER_TYPES, assertChannel, assertProviderType, safeParse };

// Canonical lifecycle. Stored lower-case, exposed upper-case to match the
// enterprise status vocabulary (CREATED, QUEUED, ...).
export const DELIVERY_STATUSES = [
  "created",
  "queued",
  "processing",
  "sent",
  "delivered",
  "failed",
  "retrying",
  "cancelled",
  "dead_lettered",
];

export const DELIVERY_STATUS_LABELS = {
  created: "CREATED",
  queued: "QUEUED",
  processing: "PROCESSING",
  sent: "SENT",
  delivered: "DELIVERED",
  failed: "FAILED",
  retrying: "RETRYING",
  cancelled: "CANCELLED",
  dead_lettered: "DEAD_LETTERED",
};

export const OPEN_STATUSES = ["created", "queued", "processing", "retrying"];
export const TERMINAL_STATUSES = ["delivered", "cancelled", "dead_lettered"];
export const SUCCESS_STATUSES = ["sent", "delivered"];

export const REMINDER_STATUSES = ["pending", "fired", "cancelled", "completed", "skipped"];
export const REMINDER_KINDS = ["due", "overdue", "repeat"];
export const ESCALATION_STATUSES = ["pending", "fired", "cancelled", "completed"];
export const ALERT_SEVERITIES = ["info", "warning", "critical"];
export const ESCALATION_RECIPIENT_TYPES = [
  "user",
  "manager",
  "supervisor",
  "role",
  "group",
  "organization",
  "business_unit",
  "plant",
  "site",
  "department",
];

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BACKOFF_SECONDS = 30;
export const MAX_BACKOFF_SECONDS = 3600;
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 0;

// Errors that will never succeed on retry. Everything else is treated as a
// transient failure and retried with exponential backoff.
export const PERMANENT_ERROR_CODES = [
  "invalid_recipient",
  "provider_not_configured",
  "auth_failed",
  "unsubscribed",
  "bounced",
  "blocked",
  "invalid_content",
];

// Alias the notification provider-type guard for local readability.
export const assertDeliveryProviderType = assertProviderType;

const STATUS_SET = new Set(DELIVERY_STATUSES);
const REMINDER_SET = new Set(REMINDER_STATUSES);
const REMINDER_KIND_SET = new Set(REMINDER_KINDS);
const ESCALATION_SET = new Set(ESCALATION_STATUSES);
const SEVERITY_SET = new Set(ALERT_SEVERITIES);

export function assertDeliveryStatus(status, label = "status") {
  if (!STATUS_SET.has(status)) {
    throw new HttpError(400, `${label} must be one of: ${DELIVERY_STATUSES.join(", ")}`);
  }
}

export function assertReminderStatus(status, label = "status") {
  if (!REMINDER_SET.has(status)) {
    throw new HttpError(400, `${label} must be one of: ${REMINDER_STATUSES.join(", ")}`);
  }
}

export function assertReminderKind(kind) {
  if (!REMINDER_KIND_SET.has(kind)) {
    throw new HttpError(400, `kind must be one of: ${REMINDER_KINDS.join(", ")}`);
  }
}

export function assertEscalationStatus(status, label = "status") {
  if (!ESCALATION_SET.has(status)) {
    throw new HttpError(400, `${label} must be one of: ${ESCALATION_STATUSES.join(", ")}`);
  }
}

export function assertAlertSeverity(severity, label = "severity") {
  if (!SEVERITY_SET.has(severity)) {
    throw new HttpError(400, `${label} must be one of: ${ALERT_SEVERITIES.join(", ")}`);
  }
}

export function assertPriority(priority) {
  if (!PRIORITIES.includes(priority)) {
    throw new HttpError(400, `priority must be one of: ${PRIORITIES.join(", ")}`);
  }
}

export function normalizePriority(value, fallback = "normal") {
  const priority = value || fallback;
  assertPriority(priority);
  return priority;
}

export function statusLabel(status) {
  return DELIVERY_STATUS_LABELS[status] || String(status || "").toUpperCase();
}

// Classifies a failure as permanent or transient. `providerError` may carry an
// explicit `permanent` flag; otherwise a known permanent error code wins.
export function classifyFailure(errorCode, providerError = {}) {
  if (providerError?.permanent === true) return "permanent";
  if (providerError?.retryable === true) return "transient";
  return PERMANENT_ERROR_CODES.includes(String(errorCode || "")) ? "permanent" : "transient";
}

// Exponential backoff in seconds: base * 2^(attempt-1), capped.
export function nextBackoff(attempt, baseSeconds = DEFAULT_BACKOFF_SECONDS) {
  const base = Number(baseSeconds) > 0 ? Number(baseSeconds) : DEFAULT_BACKOFF_SECONDS;
  const factor = Math.pow(2, Math.max(0, Number(attempt) - 1));
  return Math.min(MAX_BACKOFF_SECONDS, Math.max(1, Math.round(base * factor)));
}

export function normalizeRetryConfig(input = {}) {
  const maxAttempts = Math.max(1, Math.min(50, Number(input.max_attempts ?? input.maxAttempts) || DEFAULT_MAX_ATTEMPTS));
  const backoffSeconds = Math.max(1, Math.min(MAX_BACKOFF_SECONDS, Number(input.backoff_seconds ?? input.backoffSeconds) || DEFAULT_BACKOFF_SECONDS));
  return { max_attempts: maxAttempts, backoff_seconds: backoffSeconds };
}

export function addSeconds(base, seconds) {
  const date = base ? new Date(String(base).replace(" ", "T") + "Z") : new Date();
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  safe.setSeconds(safe.getSeconds() + Number(seconds || 0));
  return safe.toISOString().replace("T", " ").slice(0, 19);
}

export function addMinutes(base, minutes) {
  const date = base ? new Date(String(base).replace(" ", "T") + "Z") : new Date();
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  safe.setMinutes(safe.getMinutes() + Number(minutes || 0));
  return safe.toISOString().replace("T", " ").slice(0, 19);
}

export function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ""));
}

export function truncate(value, max = 500) {
  const text = String(value ?? "");
  return text.length > max ? `${text.slice(0, max)}...` : text;
}
