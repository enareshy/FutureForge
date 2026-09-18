// Event Replay Manager.
//
// Replay is a controlled, audited operation: it never silently re-fires events.
// A replay is created with an explicit scope/criteria and a target subscription
// set, optionally as a dry run, then executed at a bounded rate. Replayed
// deliveries carry a replay reference distinct from the original so idempotency
// (and the delivery uniqueness guarantee) does not suppress them.
import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError } from "../../validation.js";
import {
  normalizeReplayScope,
  normalizeReplayStatus,
  clampInt,
  toJson,
  safeParse,
  REPLAY_SCOPES,
} from "./validation.js";
import { publicReplay, ref } from "./repository.js";
import { matchSubscriptions } from "./router.js";
import { getSubscriptionRow } from "./subscriptions.js";
import { getEventTypeRow } from "./registry.js";
import { auditEvent, log } from "./hooks.js";

// Builds the SQL that selects the events a replay applies to. Every clause is
// parameterised; the tenant clause is always applied when provided.
function criteriaQuery(db, criteria = {}) {
  const clauses = [];
  const params = [];
  const tenantId = criteria.tenant_id ?? null;
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (criteria.event_type_code) {
    clauses.push("event_type_code = ?");
    params.push(criteria.event_type_code);
  }
  if (criteria.event_version) {
    clauses.push("event_version = ?");
    params.push(Number(criteria.event_version));
  }
  if (criteria.event_ref) {
    clauses.push("event_ref = ?");
    params.push(criteria.event_ref);
  }
  if (criteria.event_refs && Array.isArray(criteria.event_refs) && criteria.event_refs.length) {
    clauses.push(`event_ref IN (${criteria.event_refs.map(() => "?").join(",")})`);
    params.push(...criteria.event_refs);
  }
  if (criteria.source_module) {
    clauses.push("source_module = ?");
    params.push(criteria.source_module);
  }
  if (criteria.source_object_id) {
    clauses.push("source_object_id = ?");
    params.push(String(criteria.source_object_id));
  }
  if (criteria.from) {
    clauses.push("created_at >= ?");
    params.push(criteria.from);
  }
  if (criteria.to) {
    clauses.push("created_at <= ?");
    params.push(criteria.to);
  }
  if (criteria.until_event_ref) {
    clauses.push("id <= (SELECT id FROM event_records WHERE event_ref = ?)");
    params.push(criteria.until_event_ref);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return { where, params };
}

export function previewReplay(db, criteria = {}) {
  const { where, params } = criteriaQuery(db, criteria);
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM event_records ${where}`, params).c;
  const sample = queryAll(db, `SELECT * FROM event_records ${where} ORDER BY created_at DESC, id DESC LIMIT 20`, params);
  const byType = queryAll(
    db,
    `SELECT event_type_code, COUNT(*) AS count FROM event_records ${where} GROUP BY event_type_code ORDER BY count DESC LIMIT 10`,
    params
  );
  const targets = resolveTargets(db, criteria);
  return {
    scope_type: normalizeReplayScope(criteria.scope_type),
    criteria,
    matched_events: total,
    by_event_type: byType,
    target_subscriptions: targets.map((s) => ({ id: s.id, code: s.code, subscriber: s.subscriber, handler: s.handler || "" })),
    sample: sample.map((r) => ({ id: r.id, event_ref: r.event_ref, event_type_code: r.event_type_code, created_at: r.created_at })),
  };
}

// Resolves the subscriptions a replay targets. Explicit ids/codes win; otherwise
// the active subscriptions that match the first candidate event are used.
export function resolveTargets(db, criteria = {}) {
  const explicit = criteria.target_subscriptions || criteria.subscription_ids || criteria.subscriptions;
  if (Array.isArray(explicit) && explicit.length) {
    return explicit.map((value) => getSubscriptionRow(db, value)).filter(Boolean);
  }
  const { where, params } = criteriaQuery(db, criteria);
  const first = queryOne(db, `SELECT * FROM event_records ${where} ORDER BY id LIMIT 1`, params);
  if (!first) return [];
  return matchSubscriptions(db, first);
}

// Creates a replay request. Dry runs stop at validation/preview; live replays
// are marked `validated` for runReplay() to execute (so the request returns
// immediately and the worker does the heavy lifting).
export function createReplay(db, input = {}, actor = null, tenantId = null) {
  const scope = normalizeReplayScope(input.scope_type || input.scope);
  if (!REPLAY_SCOPES.includes(scope)) throw new HttpError(400, `Unsupported replay scope ${scope}`);
  const criteria = {
    ...(input.criteria || {}),
    event_type_code: input.event_type_code ?? input.criteria?.event_type_code,
    event_ref: input.event_ref ?? input.criteria?.event_ref,
    source_module: input.source_module ?? input.criteria?.source_module,
    source_object_id: input.source_object_id ?? input.criteria?.source_object_id,
    from: input.from ?? input.criteria?.from,
    to: input.to ?? input.criteria?.to,
    tenant_id: tenantId ?? input.tenant_id ?? null,
  };
  // Scope-derived defaults keep the API ergonomic without losing precision.
  if (scope === "event" && !criteria.event_ref && !criteria.event_refs) throw new HttpError(400, "scope_type 'event' requires event_ref");
  if (scope === "type" && !criteria.event_type_code) throw new HttpError(400, "scope_type 'type' requires event_type_code");
  if (scope === "module" && !criteria.source_module) throw new HttpError(400, "scope_type 'module' requires source_module");
  if (scope === "aggregate" && !criteria.source_object_id) throw new HttpError(400, "scope_type 'aggregate' requires source_object_id");
  if (scope === "tenant" && criteria.tenant_id === null) throw new HttpError(400, "scope_type 'tenant' requires tenant_id");
  if (criteria.event_type_code) assertReplayAllowed(db, criteria.event_type_code);

  const dryRun = Boolean(input.dry_run);
  const preview = previewReplay(db, criteria);
  const targets = (input.target_subscriptions && Array.isArray(input.target_subscriptions)
    ? input.target_subscriptions.map((v) => getSubscriptionRow(db, v)).filter(Boolean)
    : resolveTargets(db, criteria));
  const ts = nowIso();
  const replayRef = ref("RPL");
  const status = dryRun ? "validated" : "validated";
  const result = run(
    db,
    `INSERT INTO event_replays
      (replay_ref, scope_type, criteria_json, target_subscriptions_json, dry_run, status, requested_by, requested_at,
       total_events, matched_events, replayed_events, failed_events, skipped_events, rate_limit_per_second, tenant_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)`,
    [
      replayRef,
      scope,
      toJson(criteria, {}),
      toJson(targets.map((s) => s.id), []),
      dryRun ? 1 : 0,
      status,
      actor?.id ?? null,
      ts,
      preview.matched_events,
      preview.matched_events,
      clampInt(input.rate_limit_per_second ?? input.rateLimitPerSecond, 1, 10000, 25),
      tenantId ?? input.tenant_id ?? null,
      ts,
      ts,
    ]
  );
  const replayId = Number(result.lastInsertRowid);
  auditEvent(db, {
    actor,
    action: dryRun ? "event.replay.preview" : "event.replay.create",
    resourceType: "event_replay",
    resourceId: replayId,
    details: { replay_ref: replayRef, scope, matched: preview.matched_events, targets: targets.length, dry_run: dryRun },
  });
  return { ...publicReplay(queryOne(db, "SELECT * FROM event_replays WHERE id = ?", [replayId])), preview };
}

function insertReplayDelivery(db, event, subscription, replayRef) {
  const ts = nowIso();
  const retry = safeParse(subscription.retry_policy_json, {});
  const maxAttempts = clampInt(retry.max_attempts, 1, 50, 5);
  const result = run(
    db,
    `INSERT INTO event_deliveries
      (event_id, event_ref, subscription_id, event_type_code, event_version, subscriber, handler, topic_code, queue_code,
       consumer_group, partition_key, sequence_number, priority, status, attempts, max_attempts, available_at,
       payload_json, correlation_id, causation_id, trace_id, idempotency_key, security_classification,
       tenant_id, organization_id, plant_id, site_id, replay_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      event.id,
      event.event_ref,
      subscription.id,
      event.event_type_code,
      event.event_version,
      subscription.subscriber,
      subscription.handler || "",
      subscription.topic_code || "",
      subscription.queue_code || "",
      subscription.consumer_group || "",
      event.partition_key || null,
      event.sequence_number ?? null,
      event.priority || "normal",
      maxAttempts,
      ts,
      event.payload_json,
      event.correlation_id || null,
      event.causation_id || null,
      event.trace_id || null,
      `${event.event_ref}:${subscription.id}:replay:${replayRef}`,
      event.security_classification || "internal",
      event.tenant_id ?? null,
      event.organization_id ?? null,
      event.plant_id ?? null,
      event.site_id ?? null,
      replayRef,
      ts,
      ts,
    ]
  );
  return Number(result.lastInsertRowid);
}

// Resolves a replay by numeric id or public replay_ref, so both the job engine
// (which uses ids) and the REST API (which uses refs) address the same row.
function getReplayRow(db, refValue) {
  const numeric = Number(refValue);
  return queryOne(db, "SELECT * FROM event_replays WHERE id = ? OR replay_ref = ?", [
    Number.isFinite(numeric) ? numeric : -1,
    String(refValue),
  ]);
}

// Executes a replay. Processes events oldest-first so the replayed history is
// applied in original order, sleeping between batches when a rate limit is set.
export async function runReplay(db, id, actor = null, { maxEvents = 100000 } = {}) {
  const replay = getReplayRow(db, id);
  if (!replay) throw new HttpError(404, "Replay not found");
  if (replay.status === "completed" || replay.status === "running") return publicReplay(replay);
  const criteria = safeParse(replay.criteria_json, {});
  const targetIds = safeParse(replay.target_subscriptions_json, []);
  const targets = targetIds.map((value) => getSubscriptionRow(db, value)).filter(Boolean);
  const ts = nowIso();
  run(db, "UPDATE event_replays SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?", [ts, ts, replay.id]);

  if (replay.dry_run) {
    run(db, "UPDATE event_replays SET status = 'completed', finished_at = ?, updated_at = ? WHERE id = ?", [ts, ts, replay.id]);
    return publicReplay(queryOne(db, "SELECT * FROM event_replays WHERE id = ?", [replay.id]));
  }
  if (!targets.length) {
    run(db, "UPDATE event_replays SET status = 'failed', error_message = ?, finished_at = ?, updated_at = ? WHERE id = ?", [
      "No target subscriptions resolved for replay",
      ts,
      ts,
      replay.id,
    ]);
    return publicReplay(queryOne(db, "SELECT * FROM event_replays WHERE id = ?", [replay.id]));
  }

  const { where, params } = criteriaQuery(db, { ...criteria, tenant_id: replay.tenant_id ?? criteria.tenant_id });
  const events = queryAll(db, `SELECT * FROM event_records ${where} ORDER BY id ASC LIMIT ?`, [...params, clampInt(maxEvents, 1, 1000000, 100000)]);
  const rate = clampInt(replay.rate_limit_per_second, 1, 10000, 25);
  let replayed = 0;
  let failed = 0;
  let skipped = 0;
  for (const event of events) {
    for (const subscription of targets) {
      try {
        insertReplayDelivery(db, event, subscription, replay.replay_ref);
        replayed += 1;
      } catch (error) {
        failed += 1;
        log("warn", "event.replay.delivery_failed", { replay_ref: replay.replay_ref, event_ref: event.event_ref, error: error.message });
      }
    }
    // Bound the burst so a replay cannot saturate the consumer queue.
    if (rate > 0 && replayed > 0 && replayed % rate === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const finished = nowIso();
  const status = failed === 0 ? "completed" : replayed > 0 ? "partial" : "failed";
  run(
    db,
    `UPDATE event_replays SET status = ?, replayed_events = ?, failed_events = ?, skipped_events = ?, finished_at = ?, updated_at = ? WHERE id = ?`,
    [normalizeReplayStatus(status), replayed, failed, skipped, finished, finished, replay.id]
  );
  auditEvent(db, {
    actor,
    action: "event.replay.run",
    resourceType: "event_replay",
    resourceId: replay.id,
    details: { replay_ref: replay.replay_ref, replayed, failed, status },
  });
  log("info", "event.replay.completed", { replay_ref: replay.replay_ref, replayed, failed, status });
  return publicReplay(queryOne(db, "SELECT * FROM event_replays WHERE id = ?", [replay.id]));
}

export function cancelReplay(db, id, actor = null) {
  const replay = getReplayRow(db, id);
  if (!replay) throw new HttpError(404, "Replay not found");
  if (replay.status === "completed") throw new HttpError(409, "Replay already completed");
  run(db, "UPDATE event_replays SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE id = ?", [nowIso(), nowIso(), replay.id]);
  auditEvent(db, { actor, action: "event.replay.cancel", resourceType: "event_replay", resourceId: replay.id, details: { replay_ref: replay.replay_ref } });
  return publicReplay(queryOne(db, "SELECT * FROM event_replays WHERE id = ?", [replay.id]));
}

export function listReplays(db, { tenantId, status, scopeType, q, page = 1, pageSize = 50 } = {}) {
  const clauses = [];
  const params = [];
  if (tenantId !== undefined && tenantId !== null) {
    clauses.push("tenant_id = ?");
    params.push(Number(tenantId));
  }
  if (status) {
    clauses.push("status = ?");
    params.push(status);
  }
  if (scopeType) {
    clauses.push("scope_type = ?");
    params.push(scopeType);
  }
  if (q) {
    clauses.push("(LOWER(replay_ref) LIKE ? OR LOWER(scope_type) LIKE ?)");
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM event_replays ${where}`, params).c;
  const rows = queryAll(db, `SELECT * FROM event_replays ${where} ORDER BY requested_at DESC, id DESC LIMIT ? OFFSET ?`, [
    ...params,
    Number(pageSize),
    (Number(page) - 1) * Number(pageSize),
  ]);
  return { items: rows.map(publicReplay), total, page: Number(page), page_size: Number(pageSize) };
}

export function getReplay(db, refValue) {
  const id = Number(refValue);
  const row = queryOne(db, "SELECT * FROM event_replays WHERE id = ? OR replay_ref = ?", [Number.isFinite(id) ? id : -1, String(refValue)]);
  if (!row) throw new HttpError(404, "Replay not found");
  return {
    ...publicReplay(row),
    preview: previewReplay(db, { ...safeParse(row.criteria_json, {}), tenant_id: row.tenant_id }),
    replay_deliveries: queryOne(db, "SELECT COUNT(*) AS c FROM event_deliveries WHERE replay_ref = ?", [row.replay_ref]).c,
  };
}

export function replayStats(db, { tenantId = null } = {}) {
  const clause = tenantId !== undefined && tenantId !== null ? "WHERE tenant_id = ?" : "";
  const params = tenantId !== undefined && tenantId !== null ? [Number(tenantId)] : [];
  const rows = queryAll(db, `SELECT status, COUNT(*) AS count FROM event_replays ${clause} GROUP BY status`, params);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));
  const totals = queryOne(
    db,
    `SELECT COALESCE(SUM(replayed_events),0) AS replayed, COALESCE(SUM(failed_events),0) AS failed, COUNT(*) AS total FROM event_replays ${clause}`,
    params
  );
  return { total: totals?.total || 0, replayed: totals?.replayed || 0, failed: totals?.failed || 0, by_status: byStatus };
}

// Validates that an event type allows replay before a request is accepted.
export function assertReplayAllowed(db, eventTypeCode) {
  const type = getEventTypeRow(db, eventTypeCode);
  if (type && type.replay_policy === "denied") {
    throw new HttpError(403, `Replay is denied for event type ${eventTypeCode}`);
  }
  return true;
}
