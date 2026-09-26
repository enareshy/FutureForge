// Error taxonomy for the Job Scheduling & Execution Engine.
//
// Handlers classify failures so the engine can apply the correct retry policy.
// Business-validation and authorization failures are permanent by definition
// and are never retried automatically.

import { HttpError } from "../../validation.js";

export { HttpError };

export const ERROR_CATEGORIES = [
  "temporary",
  "infrastructure",
  "external_provider",
  "timeout",
  "business_validation",
  "authorization",
  "cancelled",
  "unknown",
];

// Categories that may be retried automatically.
const RETRYABLE = new Set(["temporary", "infrastructure", "external_provider", "timeout", "unknown"]);

// Categories that are always permanent.
const PERMANENT = new Set(["business_validation", "authorization", "cancelled"]);

const CATEGORY_LABELS = {
  temporary: "Temporary failure",
  infrastructure: "Infrastructure failure",
  external_provider: "External provider failure",
  timeout: "Timeout",
  business_validation: "Business validation failure",
  authorization: "Authorization failure",
  cancelled: "Cancelled",
  unknown: "Unclassified failure",
};

export function normalizeCategory(value) {
  const category = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return ERROR_CATEGORIES.includes(category) ? category : "unknown";
}

export function categoryLabel(value) {
  return CATEGORY_LABELS[normalizeCategory(value)] || CATEGORY_LABELS.unknown;
}

export function isRetryableCategory(value) {
  const category = normalizeCategory(value);
  if (PERMANENT.has(category)) return false;
  return RETRYABLE.has(category);
}

export function isPermanentCategory(value) {
  return PERMANENT.has(normalizeCategory(value));
}

export class JobError extends Error {
  constructor(message, options = {}) {
    super(message || "Job execution failed");
    this.name = "JobError";
    this.category = normalizeCategory(options.category);
    this.code = options.code || "";
    this.step = options.step || "";
    this.retryable = options.retryable === undefined ? undefined : Boolean(options.retryable);
  }

  get isRetryable() {
    if (this.retryable !== undefined) return this.retryable && !isPermanentCategory(this.category);
    return isRetryableCategory(this.category);
  }
}

export class JobCancelledError extends JobError {
  constructor(message = "Job cancelled", options = {}) {
    super(message, { ...options, category: "cancelled" });
    this.name = "JobCancelledError";
    this.retryable = false;
  }
}

export class JobTimeoutError extends JobError {
  constructor(message = "Job exceeded its timeout", options = {}) {
    super(message, { ...options, category: "timeout" });
    this.name = "JobTimeoutError";
  }
}

// Classifies an arbitrary thrown value into the engine error taxonomy.
export function classifyError(error) {
  if (!error) return { category: "unknown", code: "", message: "Unknown error", step: "" };
  if (error instanceof JobError) {
    return {
      category: normalizeCategory(error.category),
      code: error.code || "",
      message: error.message || categoryLabel(error.category),
      step: error.step || "",
      retryable: error.isRetryable,
    };
  }
  const rawCategory = error.category || error.code || error.name;
  const category = normalizeCategory(rawCategory);
  const resolved = category === "unknown" && error.name === "TimeoutError" ? "timeout" : category;
  return {
    category: resolved,
    code: String(error.code || ""),
    message: String(error.message || error),
    step: String(error.step || ""),
    retryable: isRetryableCategory(resolved),
  };
}

// Best-effort mapping of HTTP status codes raised by handlers into categories.
export function classifyHttpStatus(status) {
  if (status === 401 || status === 403) return "authorization";
  if (status === 400 || status === 404 || status === 409 || status === 422) return "business_validation";
  if (status === 408 || status === 504) return "timeout";
  if (status === 429) return "external_provider";
  if (status >= 500) return "infrastructure";
  return "unknown";
}
