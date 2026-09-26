import { queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";

// Sliding-window rate limiting for bulk submission and test-send operations.
// Buckets are scoped per tenant/provider/action so one tenant cannot exhaust a
// shared provider's quota for everyone.

export const DEFAULT_WINDOW_SECONDS = 60;

function windowStart(windowSeconds) {
  const date = new Date(Date.now() - Number(windowSeconds) * 1000);
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function bucketKey({ tenantId = null, providerId = null, action = "send" }) {
  return `tenant:${tenantId ?? 0}|provider:${providerId ?? "-"}|action:${action}`;
}

export function rateLimitStatus(db, { tenantId = null, providerId = null, action = "send", limit = 0, windowSeconds = DEFAULT_WINDOW_SECONDS } = {}) {
  if (!limit || Number(limit) <= 0) return { allowed: true, count: 0, limit: Number(limit) || 0, window_seconds: Number(windowSeconds) };
  const key = bucketKey({ tenantId, providerId, action });
  const row = queryOne(
    db,
    "SELECT COUNT(*) AS count FROM delivery_rate_events WHERE bucket = ? AND created_at >= ?",
    [key, windowStart(windowSeconds)]
  );
  const count = row?.count || 0;
  return { allowed: count < Number(limit), count, limit: Number(limit), window_seconds: Number(windowSeconds) };
}

export function recordRateEvent(db, { tenantId = null, providerId = null, action = "send" } = {}) {
  const key = bucketKey({ tenantId, providerId, action });
  run(
    db,
    "INSERT INTO delivery_rate_events (bucket, tenant_id, provider_id, action, created_at) VALUES (?, ?, ?, ?, ?)",
    [key, tenantId ?? null, providerId ?? null, action, nowIso()]
  );
}

// Throws 429 when the bucket is exhausted; otherwise records the event.
export function assertDeliveryRateLimit(db, options = {}) {
  const status = rateLimitStatus(db, options);
  if (!status.allowed) {
    throw new HttpError(429, "Delivery rate limit exceeded", {
      scope: options.action || "send",
      limit: status.limit,
      window_seconds: status.window_seconds,
      count: status.count,
    });
  }
  recordRateEvent(db, options);
  return status;
}

export function pruneRateEvents(db, { olderThanSeconds = 3600 } = {}) {
  const result = run(db, "DELETE FROM delivery_rate_events WHERE created_at < ?", [windowStart(olderThanSeconds)]);
  return { pruned: result.changes };
}
