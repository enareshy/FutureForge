// DTO mappers and shared query helpers for the Event & Messaging Framework.
//
// Nothing here returns restricted payloads or internal lease/lock columns to an
// API caller unless the caller explicitly asks for them through a service that
// has already checked authorization.
import { randomBytes, randomUUID } from "node:crypto";
import { normalizeRetryPolicy, normalizeDeadLetterPolicy, safeParse, maskForClassification } from "./validation.js";

export function ref(prefix) {
  return `${prefix}-${randomBytes(8).toString("hex").toUpperCase()}`;
}

export function eventUuid() {
  return globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : randomUUID();
}

// Builds a tenant / organization / plant / site filter fragment. An undefined
// tenant means "all tenants" (platform admins only).
export function applyScope(clauses, params, scope = {}, alias = "") {
  const col = (name) => (alias ? `${alias}.${name}` : name);
  if (scope.tenantId !== undefined && scope.tenantId !== null) {
    clauses.push(`${col("tenant_id")} = ?`);
    params.push(Number(scope.tenantId));
  }
  if (scope.organizationId) {
    clauses.push(`${col("organization_id")} = ?`);
    params.push(Number(scope.organizationId));
  }
  if (scope.plantId) {
    clauses.push(`${col("plant_id")} = ?`);
    params.push(Number(scope.plantId));
  }
  if (scope.siteId) {
    clauses.push(`${col("site_id")} = ?`);
    params.push(Number(scope.siteId));
  }
  return { clauses, params };
}

export function textSearch(clauses, params, columns, q) {
  const term = String(q || "").trim();
  if (!term) return;
  const like = `%${term.toLowerCase()}%`;
  clauses.push(`(${columns.map((c) => `LOWER(${c}) LIKE ?`).join(" OR ")})`);
  for (let i = 0; i < columns.length; i += 1) params.push(like);
}

export function sortClause(sort, allowed, fallback = "created_at") {
  const map = allowed instanceof Set ? allowed : new Set(allowed);
  const [rawColumn, rawDir] = String(sort || "").split(":");
  const column = map.has(rawColumn) ? rawColumn : fallback;
  const dir = String(rawDir || "").toLowerCase() === "asc" ? "ASC" : "DESC";
  return { column, dir, sql: `${column} ${dir}` };
}

export function windowSince(hours, from = Date.now()) {
  return new Date(from - Number(hours || 24) * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19);
}

// ── Event registry ──────────────────────────────────────────────────────────
export function publicSchemaVersion(row) {
  if (!row) return null;
  return {
    id: row.id,
    event_type_id: row.event_type_id,
    version: row.version,
    status: row.status,
    compatibility: row.compatibility,
    schema: safeParse(row.schema_json, {}),
    example: safeParse(row.example_json, {}),
    notes: row.notes || "",
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicEventType(row, { versions = null, subscriberCount = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || row.code,
    description: row.description || "",
    category: row.category,
    source_module: row.source_module || "",
    version: row.version,
    security_classification: row.security_classification,
    retention_days: row.retention_days,
    replay_policy: row.replay_policy,
    ordering_required: Boolean(row.ordering_required),
    ordering_scope: row.ordering_scope,
    default_priority: row.default_priority,
    status: row.status,
    enabled: Boolean(row.enabled),
    system: Boolean(row.system),
    schema: safeParse(row.schema_json, {}),
    example: safeParse(row.example_json, {}),
    tenant_id: row.tenant_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(versions ? { versions } : {}),
    ...(subscriberCount !== null ? { subscriber_count: subscriberCount } : {}),
  };
}

// ── Events ──────────────────────────────────────────────────────────────────
export function publicEvent(row, { includePayload = false, mask = true } = {}) {
  if (!row) return null;
  const classification = row.security_classification || "internal";
  const payload = safeParse(row.payload_json, {});
  const base = {
    id: row.id,
    event_id: row.event_id,
    event_ref: row.event_ref,
    event_type_code: row.event_type_code,
    event_type: row.event_type_code,
    event_version: row.event_version,
    version: row.event_version,
    source_module: row.source_module,
    source_system: row.source_system || "",
    source_object_type: row.source_object_type || null,
    source_object_id: row.source_object_id || null,
    source_object_revision: row.source_object_revision || null,
    actor_id: row.actor_id ?? null,
    actor_type: row.actor_type,
    correlation_id: row.correlation_id || null,
    causation_id: row.causation_id || null,
    trace_id: row.trace_id || null,
    parent_event_id: row.parent_event_id ?? null,
    sequence_number: row.sequence_number ?? null,
    partition_key: row.partition_key || null,
    priority: row.priority,
    payload_schema_version: row.payload_schema_version ?? null,
    metadata: safeParse(row.metadata_json, {}),
    security_classification: classification,
    status: row.status,
    subscriber_count: row.subscriber_count,
    delivered_count: row.delivered_count,
    failed_count: row.failed_count,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    site_id: row.site_id ?? null,
    occurred_at: row.occurred_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (includePayload) base.payload = mask ? maskForClassification(payload, classification) : payload;
  return base;
}

export function publicOutbox(row) {
  if (!row) return null;
  return {
    id: row.id,
    event_ref: row.event_ref,
    event_type_code: row.event_type_code,
    event_version: row.event_version,
    aggregate_type: row.aggregate_type || null,
    aggregate_id: row.aggregate_id || null,
    correlation_id: row.correlation_id || null,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    next_retry_at: row.next_retry_at || null,
    locked_by: row.locked_by || "",
    locked_at: row.locked_at || null,
    published_at: row.published_at || null,
    last_error: row.last_error || "",
    error_category: row.error_category || "",
    tenant_id: row.tenant_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ── Topology ────────────────────────────────────────────────────────────────
export function publicTopic(row, { stats = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || row.code,
    description: row.description || "",
    event_type_code: row.event_type_code || null,
    partitions: row.partitions,
    retention_hours: row.retention_hours,
    max_message_bytes: row.max_message_bytes,
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(stats ? { stats } : {}),
  };
}

export function publicQueue(row, { stats = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || row.code,
    description: row.description || "",
    consumer_group: row.consumer_group || "",
    max_concurrency: row.max_concurrency,
    visibility_timeout_seconds: row.visibility_timeout_seconds,
    max_attempts: row.max_attempts,
    retention_days: row.retention_days,
    dead_letter_enabled: Boolean(row.dead_letter_enabled),
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(stats ? { stats } : {}),
  };
}

export function publicConsumerGroup(row, { stats = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || row.code,
    topic_code: row.topic_code || "",
    queue_code: row.queue_code || "",
    partition_strategy: row.partition_strategy,
    max_concurrency: row.max_concurrency,
    ordering_required: Boolean(row.ordering_required),
    members: row.members,
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(stats ? { stats } : {}),
  };
}

// ── Subscriptions & deliveries ──────────────────────────────────────────────
export function publicSubscription(row, { stats = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || row.code,
    description: row.description || "",
    subscriber: row.subscriber || row.code,
    event_type_code: row.event_type_code,
    event_version: row.event_version ?? null,
    topic_code: row.topic_code || "",
    queue_code: row.queue_code || "",
    consumer_group: row.consumer_group || "",
    handler: row.handler || "",
    filter: safeParse(row.filter_json, {}),
    ordering_required: Boolean(row.ordering_required),
    ordering_scope: row.ordering_scope,
    ordering_timeout_seconds: row.ordering_timeout_seconds,
    retry_policy: normalizeRetryPolicy(safeParse(row.retry_policy_json, {})),
    dead_letter_policy: normalizeDeadLetterPolicy(safeParse(row.dead_letter_policy_json, {})),
    status: row.status,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    site_id: row.site_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(stats ? { stats } : {}),
  };
}

export function publicDelivery(row, { includePayload = false, mask = true } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    event_id: row.event_id,
    event_ref: row.event_ref,
    subscription_id: row.subscription_id ?? null,
    event_type_code: row.event_type_code,
    event_version: row.event_version,
    subscriber: row.subscriber || "",
    handler: row.handler || "",
    queue_code: row.queue_code || "",
    consumer_group: row.consumer_group || "",
    partition_key: row.partition_key || null,
    sequence_number: row.sequence_number ?? null,
    priority: row.priority,
    status: row.status,
    attempts: row.attempts,
    max_attempts: row.max_attempts,
    available_at: row.available_at || null,
    next_retry_at: row.next_retry_at || null,
    locked_by: row.locked_by || "",
    locked_at: row.locked_at || null,
    visibility_expires_at: row.visibility_expires_at || null,
    correlation_id: row.correlation_id || null,
    causation_id: row.causation_id || null,
    trace_id: row.trace_id || null,
    idempotency_key: row.idempotency_key || null,
    last_error: row.last_error || "",
    error_code: row.error_code || "",
    error_category: row.error_category || "",
    last_processing_step: row.last_processing_step || "",
    delivered_at: row.delivered_at || null,
    duration_ms: row.duration_ms ?? null,
    tenant_id: row.tenant_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (includePayload) {
    const classification = row.security_classification || "internal";
    const payload = safeParse(row.payload_json, {});
    base.payload = mask ? maskForClassification(payload, classification) : payload;
  }
  return base;
}

export function publicAttempt(row) {
  if (!row) return null;
  return {
    id: row.id,
    delivery_id: row.delivery_id,
    event_id: row.event_id,
    attempt: row.attempt,
    status: row.status,
    step: row.step || "",
    duration_ms: row.duration_ms ?? null,
    error_code: row.error_code || "",
    error_category: row.error_category || "",
    error_message: row.error_message || "",
    started_at: row.started_at,
    finished_at: row.finished_at || null,
  };
}

// ── Dead letters / replay / retention ───────────────────────────────────────
export function publicDeadLetter(row, { includePayload = false, mask = true } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    event_id: row.event_id ?? null,
    delivery_id: row.delivery_id ?? null,
    event_ref: row.event_ref || "",
    event_type_code: row.event_type_code,
    event_version: row.event_version,
    subscriber: row.subscriber || "",
    handler: row.handler || "",
    subscription_id: row.subscription_id ?? null,
    topic_code: row.topic_code || "",
    queue_code: row.queue_code || "",
    correlation_id: row.correlation_id || null,
    causation_id: row.causation_id || null,
    trace_id: row.trace_id || null,
    attempts: row.attempts,
    error_code: row.error_code || "",
    error_category: row.error_category || "",
    error_message: row.error_message || "",
    last_processing_step: row.last_processing_step || "",
    failure_at: row.failure_at,
    status: row.status,
    resolved_by: row.resolved_by ?? null,
    resolved_at: row.resolved_at || null,
    resolution_reason: row.resolution_reason || "",
    tenant_id: row.tenant_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
  if (includePayload) base.payload = mask ? maskPayloadForClassification(row) : safeParse(row.payload_json, {});
  return base;
}

function maskPayloadForClassification(row) {
  const payload = safeParse(row.payload_json, {});
  return maskForClassification(payload, row.security_classification || "internal");
}

export function publicReplay(row) {
  if (!row) return null;
  return {
    id: row.id,
    replay_ref: row.replay_ref,
    scope_type: row.scope_type,
    criteria: safeParse(row.criteria_json, {}),
    target_subscriptions: safeParse(row.target_subscriptions_json, []),
    dry_run: Boolean(row.dry_run),
    status: row.status,
    requested_by: row.requested_by ?? null,
    requested_at: row.requested_at,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    total_events: row.total_events,
    matched_events: row.matched_events,
    replayed_events: row.replayed_events,
    failed_events: row.failed_events,
    skipped_events: row.skipped_events,
    rate_limit_per_second: row.rate_limit_per_second,
    error_message: row.error_message || "",
    tenant_id: row.tenant_id ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function publicRetentionPolicy(row, { stats = null } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    name: row.name || row.code,
    event_type_code: row.event_type_code || null,
    retention_days: row.retention_days,
    action: row.action,
    archive_target: row.archive_target || "",
    status: row.status,
    last_run_at: row.last_run_at || null,
    last_run_deleted: row.last_run_deleted,
    last_run_archived: row.last_run_archived,
    tenant_id: row.tenant_id ?? null,
    created_by: row.created_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(stats ? { stats } : {}),
  };
}
