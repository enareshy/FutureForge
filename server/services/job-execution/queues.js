// Logical queue administration + load accounting for the execution engine.
//
// Queues are administrative configuration: each owns concurrency, rate limits,
// retry policy and timeout policy. Job types reference queues by code; legacy
// business codes are normalised through `canonicalQueue` so a job's stored
// queue keeps working without a data migration.

import { queryAll, queryOne, run, nowIso } from "../../db.js";
import { HttpError, pagination } from "../../validation.js";
import { truncate } from "../jobs/validation.js";
import { DEFAULT_QUEUES, LOGICAL_QUEUES, canonicalQueue, queueAliasCodes, normalizeQueueInput } from "./validation.js";
import { recordEngineAudit } from "./audit.js";

const SORTABLE = new Set(["code", "name", "priority", "max_concurrency", "created_at", "updated_at"]);

export function ensureDefaultQueues(db, actor = null) {
  let created = 0;
  for (const queue of DEFAULT_QUEUES) {
    const existing = queryOne(db, "SELECT id FROM job_queues WHERE code = ?", [queue.code]);
    if (existing) continue;
    run(
      db,
      `INSERT INTO job_queues
         (code, name, description, priority, max_concurrency, worker_allocation, rate_limit_per_minute,
          retry_max_attempts, retry_strategy, retry_delay_seconds, retry_max_delay_seconds, timeout_seconds,
          enabled, paused, is_system, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 1, 0, 1, ?, ?, ?, ?)`,
      [
        queue.code,
        queue.name,
        queue.description,
        queue.priority,
        queue.max_concurrency,
        queue.rate_limit_per_minute,
        queue.retry_max_attempts,
        queue.retry_strategy,
        queue.retry_delay_seconds,
        queue.retry_max_delay_seconds,
        queue.timeout_seconds,
        actor?.id ?? null,
        actor?.id ?? null,
        nowIso(),
        nowIso(),
      ]
    );
    created += 1;
  }
  return created;
}

function parseConfig(json, fallback = {}) {
  if (!json) return fallback;
  if (typeof json === "object") return json;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}

export function publicQueue(row, load = null) {
  if (!row) return null;
  const depth = load?.depth ?? 0;
  const running = load?.running ?? 0;
  const capacity = Math.max(0, Number(row.max_concurrency) || 0);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description || "",
    tenant_id: row.tenant_id ?? null,
    priority: row.priority,
    max_concurrency: row.max_concurrency,
    worker_allocation: row.worker_allocation,
    rate_limit_per_minute: row.rate_limit_per_minute,
    retry_max_attempts: row.retry_max_attempts,
    retry_strategy: row.retry_strategy,
    retry_delay_seconds: row.retry_delay_seconds,
    retry_max_delay_seconds: row.retry_max_delay_seconds,
    timeout_seconds: row.timeout_seconds,
    enabled: row.enabled === 1,
    paused: row.paused === 1,
    is_system: row.is_system === 1,
    last_claimed_at: row.last_claimed_at || null,
    aliases: row.is_system === 1 ? [] : queueAliasCodes(row.code).filter((code) => code !== row.code),
    config: parseConfig(row.config_json),
    depth,
    running,
    available_slots: Math.max(0, capacity - running),
    utilization: capacity > 0 ? Math.round((running / capacity) * 100) : 0,
    oldest_job_age_seconds: load?.oldest_age_seconds ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Load snapshot keyed by canonical queue code.
export function queueLoad(db) {
  const rows = queryAll(
    db,
    `SELECT queue, status, COUNT(*) AS c, MIN(created_at) AS oldest
       FROM jobs
      WHERE status IN ('queued', 'scheduled', 'retrying', 'running', 'cancel_requested', 'created', 'waiting_for_dependency')
      GROUP BY queue, status`
  );
  const map = new Map();
  const now = Date.now();
  for (const row of rows) {
    const code = canonicalQueue(row.queue);
    if (!map.has(code)) map.set(code, { depth: 0, running: 0, waiting: 0, oldest: null });
    const entry = map.get(code);
    if (row.status === "running" || row.status === "cancel_requested") {
      entry.running += row.c;
    } else if (row.status === "waiting_for_dependency") {
      entry.waiting += row.c;
    } else {
      entry.depth += row.c;
    }
    if (row.oldest && (entry.oldest === null || row.oldest < entry.oldest)) entry.oldest = row.oldest;
  }
  for (const entry of map.values()) {
    const oldest = entry.oldest ? new Date(entry.oldest.replace(" ", "T") + "Z").getTime() : null;
    entry.oldest_age_seconds = oldest ? Math.max(0, Math.floor((now - oldest) / 1000)) : 0;
  }
  return map;
}

function loadFor(load, code) {
  const entry = load.get(canonicalQueue(code));
  return entry || { depth: 0, running: 0, waiting: 0, oldest_age_seconds: 0 };
}

export function getQueueRow(db, ref) {
  const row = queryOne(
    db,
    "SELECT * FROM job_queues WHERE id = ? OR code = ? OR code = ?",
    [Number(ref) || -1, String(ref || ""), String(ref || "").toUpperCase()]
  );
  if (!row) throw new HttpError(404, "Job queue not found");
  return row;
}

export function getQueue(db, ref) {
  const row = getQueueRow(db, ref);
  return publicQueue(row, loadFor(queueLoad(db), row.code));
}

export function resolveQueuePolicy(db, code) {
  const canonical = canonicalQueue(code);
  const row = queryOne(db, "SELECT * FROM job_queues WHERE code = ?", [canonical]);
  if (row) return row;
  const fallback = DEFAULT_QUEUES.find((queue) => queue.code === canonical) || DEFAULT_QUEUES[0];
  return {
    id: null,
    code: fallback.code,
    ...fallback,
    enabled: 1,
    paused: 0,
    is_system: 1,
    config_json: "{}",
  };
}

export function listQueues(db, query = {}, tenantId = null) {
  const { page, pageSize, offset } = pagination(query);
  const where = [];
  const params = [];
  const scoped = tenantId ?? (query.tenantId !== undefined && query.tenantId !== "" ? Number(query.tenantId) : null);
  if (scoped !== null && scoped !== undefined) {
    where.push("(tenant_id IS NULL OR tenant_id = ?)");
    params.push(Number(scoped));
  }
  if (query.enabled === "true" || query.enabled === true) where.push("enabled = 1");
  if (query.enabled === "false" || query.enabled === false) where.push("enabled = 0");
  if (query.paused === "true" || query.paused === true) where.push("paused = 1");
  if (query.q) {
    const like = `%${query.q}%`;
    where.push("(code LIKE ? OR name LIKE ? OR description LIKE ?)");
    params.push(like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = queryOne(db, `SELECT COUNT(*) AS c FROM job_queues ${clause}`, params).c;
  const sort = SORTABLE.has(String(query.sort || "")) ? String(query.sort) : "priority";
  const dir = String(query.order || "").toLowerCase() === "asc" ? "ASC" : "DESC";
  const load = queueLoad(db);
  const items = queryAll(
    db,
    `SELECT * FROM job_queues ${clause} ORDER BY ${sort} ${dir}, id ASC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  ).map((row) => publicQueue(row, loadFor(load, row.code)));
  return { items, total, page, pageSize };
}

export function createQueue(db, input = {}, actor = null, ip = null) {
  const fields = normalizeQueueInput(input);
  if (queryOne(db, "SELECT id FROM job_queues WHERE code = ?", [fields.code])) {
    throw new HttpError(409, `Queue ${fields.code} already exists`);
  }
  const ts = nowIso();
  const result = run(
    db,
    `INSERT INTO job_queues
       (code, name, description, tenant_id, priority, max_concurrency, worker_allocation, rate_limit_per_minute,
        retry_max_attempts, retry_strategy, retry_delay_seconds, retry_max_delay_seconds, timeout_seconds,
        enabled, paused, is_system, config_json, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [
      fields.code,
      fields.name,
      fields.description,
      fields.tenant_id,
      fields.priority,
      fields.max_concurrency,
      fields.worker_allocation,
      fields.rate_limit_per_minute,
      fields.retry_max_attempts,
      fields.retry_strategy,
      fields.retry_delay_seconds,
      fields.retry_max_delay_seconds,
      fields.timeout_seconds,
      fields.enabled,
      fields.paused,
      fields.config_json,
      actor?.id ?? null,
      actor?.id ?? null,
      ts,
      ts,
    ]
  );
  const row = queryOne(db, "SELECT * FROM job_queues WHERE id = ?", [Number(result.lastInsertRowid)]);
  recordEngineAudit(db, {
    tenantId: row.tenant_id,
    entityType: "queue",
    entityId: row.id,
    entityCode: row.code,
    action: "create",
    actor,
    detail: { priority: row.priority, max_concurrency: row.max_concurrency, timeout_seconds: row.timeout_seconds },
    ip,
  });
  return publicQueue(row, loadFor(queueLoad(db), row.code));
}

export function updateQueue(db, ref, input = {}, actor = null, ip = null) {
  const row = getQueueRow(db, ref);
  const merged = normalizeQueueInput({
    code: row.code,
    name: input.name ?? row.name,
    description: input.description ?? row.description,
    tenant_id: input.tenant_id !== undefined ? input.tenant_id : row.tenant_id,
    priority: input.priority ?? row.priority,
    max_concurrency: input.max_concurrency ?? input.maxConcurrency ?? row.max_concurrency,
    worker_allocation: input.worker_allocation ?? input.workerAllocation ?? row.worker_allocation,
    rate_limit_per_minute: input.rate_limit_per_minute ?? input.rateLimitPerMinute ?? row.rate_limit_per_minute,
    retry_max_attempts: input.retry_max_attempts ?? input.retryMaxAttempts ?? row.retry_max_attempts,
    retry_strategy: input.retry_strategy ?? input.retryStrategy ?? row.retry_strategy,
    retry_delay_seconds: input.retry_delay_seconds ?? input.retryDelaySeconds ?? row.retry_delay_seconds,
    retry_max_delay_seconds: input.retry_max_delay_seconds ?? input.retryMaxDelaySeconds ?? row.retry_max_delay_seconds,
    timeout_seconds: input.timeout_seconds ?? input.timeoutSeconds ?? row.timeout_seconds,
    enabled: input.enabled === undefined ? row.enabled : input.enabled,
    paused: input.paused === undefined ? row.paused : input.paused,
    config: input.config !== undefined ? input.config : parseConfig(row.config_json),
  });
  const ts = nowIso();
  run(
    db,
    `UPDATE job_queues SET
       name = ?, description = ?, tenant_id = ?, priority = ?, max_concurrency = ?, worker_allocation = ?,
       rate_limit_per_minute = ?, retry_max_attempts = ?, retry_strategy = ?, retry_delay_seconds = ?,
       retry_max_delay_seconds = ?, timeout_seconds = ?, enabled = ?, paused = ?, config_json = ?,
       updated_by = ?, updated_at = ?
     WHERE id = ?`,
    [
      merged.name,
      merged.description,
      merged.tenant_id,
      merged.priority,
      merged.max_concurrency,
      merged.worker_allocation,
      merged.rate_limit_per_minute,
      merged.retry_max_attempts,
      merged.retry_strategy,
      merged.retry_delay_seconds,
      merged.retry_max_delay_seconds,
      merged.timeout_seconds,
      merged.enabled,
      merged.paused,
      merged.config_json,
      actor?.id ?? null,
      ts,
      row.id,
    ]
  );
  const updated = queryOne(db, "SELECT * FROM job_queues WHERE id = ?", [row.id]);
  recordEngineAudit(db, {
    tenantId: updated.tenant_id,
    entityType: "queue",
    entityId: updated.id,
    entityCode: updated.code,
    action: "update",
    actor,
    detail: {
      before: {
        priority: row.priority,
        max_concurrency: row.max_concurrency,
        timeout_seconds: row.timeout_seconds,
        retry_max_attempts: row.retry_max_attempts,
        enabled: row.enabled,
        paused: row.paused,
      },
      after: {
        priority: updated.priority,
        max_concurrency: updated.max_concurrency,
        timeout_seconds: updated.timeout_seconds,
        retry_max_attempts: updated.retry_max_attempts,
        enabled: updated.enabled,
        paused: updated.paused,
      },
    },
    ip,
  });
  return publicQueue(updated, loadFor(queueLoad(db), updated.code));
}

export function setQueueEnabled(db, ref, enabled, actor = null, ip = null) {
  const row = getQueueRow(db, ref);
  run(db, "UPDATE job_queues SET enabled = ?, updated_by = ?, updated_at = ? WHERE id = ?", [enabled ? 1 : 0, actor?.id ?? null, nowIso(), row.id]);
  recordEngineAudit(db, {
    tenantId: row.tenant_id,
    entityType: "queue",
    entityId: row.id,
    entityCode: row.code,
    action: enabled ? "enable" : "disable",
    actor,
    detail: {},
    ip,
  });
  return getQueue(db, row.id);
}

export function setQueuePaused(db, ref, paused, actor = null, ip = null) {
  const row = getQueueRow(db, ref);
  run(db, "UPDATE job_queues SET paused = ?, updated_by = ?, updated_at = ? WHERE id = ?", [paused ? 1 : 0, actor?.id ?? null, nowIso(), row.id]);
  recordEngineAudit(db, {
    tenantId: row.tenant_id,
    entityType: "queue",
    entityId: row.id,
    entityCode: row.code,
    action: paused ? "pause" : "resume",
    actor,
    detail: {},
    ip,
  });
  return getQueue(db, row.id);
}

function executionsLastMinute(db, canonical) {
  const aliases = queueAliasCodes(canonical);
  const placeholders = aliases.map(() => "?").join(", ");
  const row = queryOne(
    db,
    `SELECT COUNT(*) AS c FROM job_executions
      WHERE queue IN (${placeholders})
        AND started_at >= datetime('now', '-60 seconds')`,
    aliases
  );
  return row?.c || 0;
}

export function queueHealth(db, ref) {
  const row = getQueueRow(db, ref);
  const load = queueLoad(db);
  const entry = loadFor(load, row.code);
  const capacity = Math.max(0, Number(row.max_concurrency) || 0);
  const utilization = capacity > 0 ? entry.running / capacity : 0;
  const rateWindow = executionsLastMinute(db, row.code);
  const rateLimit = Number(row.rate_limit_per_minute) || 0;
  const rateUsage = rateLimit > 0 ? rateWindow / rateLimit : 0;

  let status = "healthy";
  if (row.enabled !== 1) status = "disabled";
  else if (row.paused === 1) status = "paused";
  else if (capacity > 0 && entry.running >= capacity) status = "saturated";
  else if (rateLimit > 0 && rateUsage >= 1) status = "rate_limited";
  else if (entry.depth > 0 && entry.oldest_age_seconds > 900) status = "degraded";

  const workerRow = queryOne(
    db,
    `SELECT COUNT(DISTINCT lease_owner) AS c FROM jobs
      WHERE status IN ('running', 'cancel_requested') AND lease_owner <> '' AND queue IN (${queueAliasCodes(row.code).map(() => "?").join(", ")})`,
    queueAliasCodes(row.code)
  );

  return {
    queue: publicQueue(row, entry),
    status,
    capacity,
    depth: entry.depth,
    running: entry.running,
    available_slots: Math.max(0, capacity - entry.running),
    utilization: Math.round(utilization * 100),
    oldest_job_age_seconds: entry.oldest_age_seconds,
    rate_limit_per_minute: rateLimit,
    executions_last_minute: rateWindow,
    rate_utilization: Math.round(rateUsage * 100),
    active_workers: workerRow?.c || 0,
    worker_allocation: row.worker_allocation,
    checked_at: nowIso(),
  };
}

// Claim ordering with anti-starvation aging.
//
// Queues are visited in descending effective priority. A queue that has been
// idle accumulates a bounded aging bonus so a saturated high-priority queue
// cannot indefinitely starve lower-priority work.
export function orderQueuesForClaim(db, codes = null) {
  const load = queueLoad(db);
  const restrict = Array.isArray(codes) && codes.length > 0;
  let policies;
  if (restrict) {
    const wanted = [...new Set(codes.map((code) => canonicalQueue(code)))];
    policies = queryAll(
      db,
      `SELECT * FROM job_queues WHERE code IN (${wanted.map(() => "?").join(", ")})`,
      wanted
    );
    const known = new Set(policies.map((row) => row.code));
    for (const code of wanted) {
      if (!known.has(code)) policies.push(resolveQueuePolicy(db, code));
    }
  } else {
    policies = queryAll(db, "SELECT * FROM job_queues WHERE is_system = 1 OR id IS NOT NULL");
    const known = new Set(policies.map((row) => row.code));
    for (const code of LOGICAL_QUEUES) {
      if (!known.has(code)) policies.push(resolveQueuePolicy(db, code));
    }
  }
  const now = Date.now();
  const scored = policies
    .filter((row) => row.enabled === 1 && row.paused !== 1)
    .map((row) => {
      const entry = loadFor(load, row.code);
      const idleSeconds = row.last_claimed_at
        ? Math.max(0, (now - new Date(row.last_claimed_at.replace(" ", "T") + "Z").getTime()) / 1000)
        : entry.oldest_age_seconds || 0;
      const aging = Math.min(60, Math.floor(idleSeconds / 10));
      return {
        policy: row,
        canonical: canonicalQueue(row.code),
        effective_priority: (Number(row.priority) || 0) + aging,
        aging_bonus: aging,
        load: entry,
      };
    })
    .sort((a, b) => b.effective_priority - a.effective_priority || b.policy.priority - a.policy.priority || a.canonical.localeCompare(b.canonical));
  return { scored, load };
}

export function truncateQueueName(value) {
  return truncate(value, 200);
}
