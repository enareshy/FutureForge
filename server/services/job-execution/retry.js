// Retry policy evaluation.
//
// The queue owns the retry strategy; the job/type owns the maximum attempt
// count (a job-level `max_retries` of 0 means "inherit the queue policy").
// Permanent categories (business validation, authorization, cancellation) are
// never retried automatically.

import { isRetryableCategory, normalizeCategory, categoryLabel } from "./errors.js";

export function effectiveMaxRetries(job, queue) {
  const jobMax = Math.max(0, Number(job?.max_retries) || 0);
  if (jobMax > 0) return jobMax;
  return Math.max(0, Number(queue?.retry_max_attempts) || 0);
}

export function computeRetryDelay(queue, attemptNumber) {
  const strategy = queue?.retry_strategy || "exponential";
  if (strategy === "none") return null;
  const base = Math.max(0, Number(queue?.retry_delay_seconds) || 0);
  if (strategy === "fixed") return base;
  const maxDelay = Math.max(base, Number(queue?.retry_max_delay_seconds) || 0);
  const exponential = base * 2 ** Math.max(0, attemptNumber - 1);
  return Math.min(exponential, maxDelay);
}

export function decideRetry({ job, queue, classification, retryAfterSeconds = null }) {
  const category = normalizeCategory(classification?.category);
  const maxRetries = effectiveMaxRetries(job, queue);
  const used = Math.max(0, Number(job?.retry_count) || 0);
  const retryable = classification?.retryable === undefined ? isRetryableCategory(category) : Boolean(classification.retryable);

  if (!retryable) {
    return {
      retry: false,
      reason: "permanent_failure",
      category,
      category_label: categoryLabel(category),
      attempt: used,
      max_retries: maxRetries,
    };
  }
  if (used >= maxRetries) {
    return {
      retry: false,
      reason: "retries_exhausted",
      category,
      category_label: categoryLabel(category),
      attempt: used,
      max_retries: maxRetries,
    };
  }
  let delaySeconds = computeRetryDelay(queue, used + 1);
  if (delaySeconds === null) {
    return {
      retry: false,
      reason: "retry_disabled",
      category,
      category_label: categoryLabel(category),
      attempt: used,
      max_retries: maxRetries,
    };
  }
  const providerDelay = Number(retryAfterSeconds) || 0;
  if (providerDelay > 0) delaySeconds = Math.max(delaySeconds, providerDelay);
  return {
    retry: true,
    reason: "retryable",
    category,
    category_label: categoryLabel(category),
    attempt: used + 1,
    next_retry_count: used + 1,
    max_retries: maxRetries,
    delay_seconds: delaySeconds,
    strategy: queue?.retry_strategy || "exponential",
  };
}
