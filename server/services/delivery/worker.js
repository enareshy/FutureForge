import { queryAll, queryOne, run, nowIso, randomUuid } from "../../db.js";
import { providerConfig, providerSecrets, getProviderRow } from "../notifications/providers.js";
import { resolveProviderChain, recordProviderFailure } from "./providers.js";
import { resolveTransport, outcome } from "./transports.js";
import { recordRateEvent, rateLimitStatus } from "./ratelimit.js";
import { createAlert } from "./alerts.js";
import {
  classifyFailure,
  nextBackoff,
  addSeconds,
  truncate,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BACKOFF_SECONDS,
} from "./validation.js";

// Delivery worker. Pull-based like the rest of the platform: `processDue` is
// invoked by a scheduler/operator endpoint or by the optional long-running
// worker loop. It claims due requests, resolves a provider (with failover),
// dispatches through the transport registry, classifies failures and applies
// exponential backoff, dead-lettering and operational alerts.

const PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };

function toProviderContext(row) {
  if (!row) return { row: null, code: "store", type: "store" };
  return { row, code: row.code, type: row.type };
}

function buildChain(db, request) {
  const rows = resolveProviderChain(db, { channel: request.channel, tenantId: request.tenant_id });
  let ordered = [...rows];
  if (request.provider_code) {
    const preferred = getProviderRow(db, request.provider_code);
    if (preferred) {
      ordered = [preferred, ...ordered.filter((row) => row.id !== preferred.id)];
    }
  }
  if (!ordered.length) return [toProviderContext(null)];
  return ordered.map(toProviderContext);
}

function providerBackoff(provider, request) {
  const row = provider?.row;
  const value = row?.backoff_seconds ?? providerConfig(row || {})?.backoff_seconds;
  void request;
  return Number(value) > 0 ? Number(value) : DEFAULT_BACKOFF_SECONDS;
}

// Attempts delivery through the provider chain, recording failures and
// honoring per-provider rate limits. Returns the outcome and the provider used.
function performDispatch(db, request, { attempt }) {
  const chain = buildChain(db, request);
  let last = null;
  for (const provider of chain) {
    const limit = Number(provider.row?.rate_limit_per_minute || 0);
    const rate = rateLimitStatus(db, {
      tenantId: request.tenant_id,
      providerId: provider.row?.id ?? null,
      action: "send",
      limit,
    });
    if (!rate.allowed) {
      last = {
        provider,
        outcome: outcome(false, { error: `provider rate limit reached (${rate.limit}/${rate.window_seconds}s)`, errorCode: "rate_limited", retryable: true }),
      };
      continue;
    }
    const { handler } = resolveTransport(provider, request.channel);
    let result;
    try {
      result = handler({ db, request, provider, attempt, config: provider.row ? providerConfig(provider.row) : {}, secrets: provider.row ? providerSecrets(provider.row) : {} });
    } catch (err) {
      result = outcome(false, { error: err.message, errorCode: "transport_error", retryable: true });
    }
    recordRateEvent(db, { tenantId: request.tenant_id, providerId: provider.row?.id ?? null, action: "send" });
    if (result.ok) return { provider, outcome: result };
    recordProviderFailure(db, {
      provider: provider.row,
      requestId: request.id,
      tenantId: request.tenant_id,
      channel: request.channel,
      errorCode: result.error_code || "delivery_failed",
      errorMessage: result.error,
      permanent: classifyFailure(result.error_code, result) === "permanent",
    });
    last = { provider, outcome: result };
  }
  return last || { provider: toProviderContext(null), outcome: outcome(false, { error: "no provider available", errorCode: "provider_not_configured", permanent: true }) };
}

function recordAttempt(db, { request, provider, attempt, status, result, startedAt, finishedAt, durationMs }) {
  run(
    db,
    `INSERT INTO delivery_attempts
      (request_id, attempt, provider_id, provider_code, channel, status, error_code, error_message, response_json, duration_ms, started_at, finished_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      request.id,
      attempt,
      provider?.row?.id ?? null,
      provider?.code || "store",
      request.channel,
      status,
      result?.error_code || "",
      truncate(result?.error || "", 1000),
      JSON.stringify(result?.response || {}),
      durationMs,
      startedAt,
      finishedAt,
      finishedAt,
    ]
  );
}

function resultRow(request, status, attempt, maxAttempts, provider, result, extra = {}) {
  return {
    id: request.id,
    request_ref: request.request_ref,
    notification_id: request.notification_id ?? null,
    status,
    attempt,
    max_attempts: maxAttempts,
    provider_id: provider?.row?.id ?? null,
    provider_code: provider?.code || "store",
    channel: request.channel,
    response: result?.response || {},
    error_code: result?.error_code || "",
    error_message: result?.error || "",
    dead_letter: status === "failed" || status === "dead_lettered",
    scheduled_at: extra.scheduled_at ?? request.scheduled_at,
    sent_at: extra.sent_at ?? null,
    delivered_at: extra.delivered_at ?? null,
    processed_at: extra.processed_at ?? null,
  };
}

function processOne(db, request, { now, maxAttemptsFor }) {
  const claim = run(
    db,
    "UPDATE delivery_requests SET status = 'processing', processing_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'retrying')",
    [now, now, request.id]
  );
  if (claim.changes === 0) return null;

  const attempt = Number(request.attempt) + 1;
  const configuredMax = maxAttemptsFor ? maxAttemptsFor(request) : request.max_attempts;
  const maxAttempts = Math.max(1, Number(configuredMax) || Number(request.max_attempts) || DEFAULT_MAX_ATTEMPTS);
  const startedAt = nowIso();
  const started = Date.now();
  const { provider, outcome: result } = performDispatch(db, request, { attempt });
  const finishedAt = nowIso();
  const durationMs = Date.now() - started;

  if (result.ok) {
    const delivered = Boolean(result.delivered);
    const status = delivered ? "delivered" : "sent";
    run(
      db,
      `UPDATE delivery_requests
          SET status = ?, attempt = ?, provider_id = ?, provider_code = ?, sent_at = ?, delivered_at = ?,
              processed_at = ?, error_code = '', error_message = '', provider_response_json = ?, dead_letter = 0, updated_at = ?
        WHERE id = ?`,
      [
        status,
        attempt,
        provider?.row?.id ?? null,
        provider?.code || "store",
        finishedAt,
        delivered ? finishedAt : null,
        finishedAt,
        JSON.stringify(result.response || {}),
        finishedAt,
        request.id,
      ]
    );
    recordAttempt(db, { request, provider, attempt, status, result, startedAt, finishedAt, durationMs });
    return resultRow(request, status, attempt, maxAttempts, provider, result, {
      scheduled_at: request.scheduled_at,
      sent_at: finishedAt,
      delivered_at: delivered ? finishedAt : null,
      processed_at: finishedAt,
    });
  }

  const permanent = classifyFailure(result.error_code, result) === "permanent";
  const exhausted = attempt >= maxAttempts;
  const deadLettered = permanent || exhausted;
  const status = deadLettered ? (permanent ? "failed" : "dead_lettered") : "retrying";
  const backoff = nextBackoff(attempt, providerBackoff(provider, request));
  const scheduledAt = deadLettered ? request.scheduled_at : addSeconds(finishedAt, backoff);
  run(
    db,
    `UPDATE delivery_requests
        SET status = ?, attempt = ?, provider_id = ?, provider_code = ?, scheduled_at = ?, error_code = ?,
            error_message = ?, provider_response_json = ?, dead_letter = ?, processed_at = ?, last_retry_at = ?, updated_at = ?
      WHERE id = ?`,
    [
      status,
      attempt,
      provider?.row?.id ?? null,
      provider?.code || "store",
      scheduledAt,
      result.error_code || "delivery_failed",
      truncate(result.error || "delivery failed", 1000),
      JSON.stringify(result.response || {}),
      deadLettered ? 1 : 0,
      deadLettered ? finishedAt : null,
      finishedAt,
      finishedAt,
      request.id,
    ]
  );
  recordAttempt(db, { request, provider, attempt, status, result, startedAt, finishedAt, durationMs });
  if (deadLettered) {
    createAlert(db, {
      type: permanent ? "delivery_failed" : "delivery_dead_lettered",
      severity: "critical",
      tenantId: request.tenant_id,
      providerId: provider?.row?.id ?? null,
      providerCode: provider?.code || "",
      requestId: request.id,
      channel: request.channel,
      message: `Delivery for ${request.channel} to ${request.recipient_address || request.recipient_name || "recipient"} ${permanent ? "failed permanently" : `exhausted ${attempt} attempts`}: ${truncate(result.error || "unknown error", 200)}`,
    });
  }
  return resultRow(request, status, attempt, maxAttempts, provider, result, { scheduled_at: scheduledAt });
}

// Processes up to `limit` due delivery requests. Safe to call repeatedly.
export function processDue(db, { limit = 50, now = null, tenantId = null, maxAttemptsFor = null } = {}) {
  const stamp = now || nowIso();
  const params = [stamp];
  let clause = "";
  if (tenantId) {
    clause = "AND COALESCE(tenant_id, 0) = ?";
    params.push(Number(tenantId));
  }
  params.push(limit);
  const due = queryAll(
    db,
    `SELECT * FROM delivery_requests
      WHERE status IN ('queued', 'retrying') AND dead_letter = 0 AND scheduled_at <= ? ${clause}
      ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        scheduled_at, id
      LIMIT ?`,
    params
  );
  const summary = { processed: 0, sent: 0, delivered: 0, failed: 0, retried: 0, dead_letter: 0, cancelled: 0, errors: 0, results: [] };
  for (const request of due) {
    try {
      const result = processOne(db, request, { now: stamp, maxAttemptsFor });
      if (!result) continue;
      summary.processed += 1;
      summary.results.push(result);
      if (result.status === "sent") summary.sent += 1;
      else if (result.status === "delivered") {
        summary.delivered += 1;
        summary.sent += 1;
      } else if (result.status === "retrying") summary.retried += 1;
      else if (result.status === "failed" || result.status === "dead_lettered") {
        summary.failed += 1;
        summary.dead_letter += 1;
      }
    } catch (err) {
      summary.errors += 1;
      try {
        console.log(JSON.stringify({ level: "error", scope: "delivery", message: "processOne failed", request_id: request.id, error: err.message }));
      } catch {
        /* logging must never throw */
      }
    }
  }
  return summary;
}

export async function processDueAsync(db, options = {}) {
  return processDue(db, options);
}

export function pendingCount(db, tenantId = null) {
  const params = [];
  const clause = tenantId ? "AND COALESCE(tenant_id, 0) = ?" : "";
  if (tenantId) params.push(Number(tenantId));
  const row = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM delivery_requests
      WHERE status IN ('created', 'queued', 'processing', 'retrying') AND dead_letter = 0 ${clause}`,
    params
  );
  return row?.c || 0;
}

// Optional long-running worker loop. The platform keeps no hidden timers by
// default; callers (a dedicated process or operator endpoint) start this
// explicitly and can stop it gracefully.
export function createWorker(db, { intervalMs = 15000, batchSize = 50, tenantId = null, workerId = randomUuid(), onTick = null, logger = console } = {}) {
  let timer = null;
  let inflight = null;
  const state = {
    worker_id: workerId,
    started: false,
    stopping: false,
    started_at: null,
    last_tick_at: null,
    ticks: 0,
    last_result: null,
  };

  function runTick() {
    state.last_tick_at = nowIso();
    try {
      const result = processDue(db, { limit: batchSize, tenantId });
      state.ticks += 1;
      state.last_result = result;
      if (typeof onTick === "function") onTick(result);
      return result;
    } catch (err) {
      logger?.error?.(JSON.stringify({ level: "error", scope: "delivery.worker", worker_id: workerId, error: err.message }));
      return null;
    }
  }

  return {
    id: workerId,
    start() {
      if (state.started) return state;
      state.started = true;
      state.stopping = false;
      state.started_at = nowIso();
      runTick();
      timer = setInterval(runTick, Math.max(1000, Number(intervalMs) || 15000));
      if (typeof timer.unref === "function") timer.unref();
      return state;
    },
    // Graceful shutdown: stop scheduling and wait for the in-flight tick.
    async stop() {
      state.stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      state.started = false;
      if (inflight) await inflight;
      return state;
    },
    tick() {
      inflight = Promise.resolve(runTick());
      return inflight;
    },
    status() {
      return { ...state };
    },
  };
}
