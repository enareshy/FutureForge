// Shared vocabulary, envelope normalisation, schema validation and the retry /
// ordering / masking primitives for the Event & Messaging Framework.
//
// Everything the services, REST layer, tests and frontend need to agree on
// lives here so stable codes and error semantics stay in one place. The module
// is intentionally provider-independent: no broker or transport concept leaks
// into the vocabulary.
import { HttpError } from "../../validation.js";

// Logical actor that caused an event. This is part of the envelope, not the
// payload, so consumers can reason about provenance uniformly.
export const ACTOR_TYPES = ["USER", "SYSTEM", "INTEGRATION", "JOB", "WORKFLOW"];

export const EVENT_CATEGORIES = [
  "object",
  "product",
  "bom",
  "document",
  "change",
  "workflow",
  "lifecycle",
  "user",
  "security",
  "manufacturing",
  "quality",
  "project",
  "integration",
  "analytics",
  "system",
  "domain",
];

export const EVENT_STATUSES = ["draft", "active", "inactive", "deprecated", "retired"];
export const VERSION_STATUSES = ["active", "deprecated", "retired"];
export const COMPATIBILITY_LEVELS = ["none", "backward", "forward", "full"];

// Security classification drives payload masking and replay restrictions.
export const SECURITY_CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"];

// Replay policy is enforced by the Replay Manager before anything is replayed.
export const REPLAY_POLICIES = ["allowed", "controlled", "denied"];

export const ORDERING_SCOPES = ["none", "aggregate", "object", "partition", "global"];
export const PRIORITIES = ["low", "normal", "high", "critical"];

export const SUBSCRIPTION_STATUSES = ["draft", "active", "inactive", "suspended"];
export const DELIVERY_STATUSES = [
  "pending",
  "processing",
  "delivered",
  "retry",
  "failed",
  "dead_letter",
  "skipped",
  "duplicate",
  "out_of_order",
  "cancelled",
  "ignored",
];
export const DELIVERY_TERMINAL = ["delivered", "dead_letter", "skipped", "duplicate", "cancelled", "ignored"];

export const TOPIC_STATUSES = ["active", "inactive"];
export const QUEUE_STATUSES = ["active", "inactive", "paused"];
export const CONSUMER_GROUP_STATUSES = ["active", "inactive"];

export const OUTBOX_STATUSES = ["pending", "publishing", "published", "failed", "dead_letter"];
export const DEAD_LETTER_STATUSES = ["open", "retrying", "resolved", "ignored"];
export const RETENTION_ACTIONS = ["delete", "archive", "delete_after_archive"];

export const REPLAY_SCOPES = ["event", "range", "type", "time", "module", "aggregate", "tenant", "failed", "dead_letter"];
export const REPLAY_STATUSES = ["pending", "validating", "validated", "running", "completed", "partial", "failed", "cancelled"];

export const RETRY_STRATEGIES = ["fixed", "linear", "exponential"];
export const TRIGGER_TYPES = ["api", "internal", "job", "schedule", "replay", "retry"];

// Provider-independent broker vocabulary. Only `database` and `memory` ship in
// the box; adapters for Kafka, RabbitMQ, Azure Service Bus and cloud messaging
// register themselves through bus.js without touching the rest of the service.
export const BUS_PROVIDERS = ["database", "memory", "kafka", "rabbitmq", "azure_service_bus", "aws", "custom"];

// Error taxonomy shared by retry, dead-letter and monitoring. Categories are
// provider-independent; codes are stable identifiers clients can switch on.
export const ERROR_CATEGORIES = [
  "technical",
  "business_validation",
  "schema",
  "mapping",
  "authentication",
  "authorization",
  "network",
  "timeout",
  "external_system",
  "duplicate",
  "configuration",
  "rate_limit",
  "not_found",
  "poison",
  "ordering",
];

export const ERROR_CODES = {
  technical: ["internal_error", "unexpected_error", "handler_error"],
  business_validation: ["validation_failed", "required_field_missing", "invalid_value"],
  schema: ["schema_mismatch", "unsupported_version", "payload_too_large", "invalid_payload"],
  mapping: ["mapping_failed", "type_conversion_failed", "unknown_field"],
  authentication: ["authentication_failed", "signature_invalid"],
  authorization: ["forbidden", "insufficient_scope"],
  network: ["connection_refused", "dns_failure", "tls_error", "network_unreachable"],
  timeout: ["request_timeout", "connect_timeout", "processing_timeout"],
  external_system: ["remote_error", "remote_unavailable", "remote_rejected"],
  duplicate: ["duplicate_message", "idempotent_replay"],
  configuration: ["missing_configuration", "invalid_configuration", "handler_not_registered"],
  rate_limit: ["rate_limited", "quota_exceeded", "backpressure"],
  not_found: ["event_not_found", "subscription_not_found", "handler_not_found"],
  poison: ["poison_message", "deserialization_failed"],
  ordering: ["out_of_order", "sequence_gap", "ordering_timeout"],
};

// Categories safe to retry. Everything else is treated as a permanent failure
// and moves straight to the dead-letter store (poison/validation/schema are
// never retried because a retry cannot change the outcome).
const NON_RETRYABLE_CATEGORIES = new Set([
  "business_validation",
  "schema",
  "mapping",
  "authorization",
  "configuration",
  "duplicate",
  "not_found",
  "poison",
]);

export function isRetryableCategory(category) {
  return !NON_RETRYABLE_CATEGORIES.has(String(category || ""));
}

function oneOf(value, allowed) {
  return value !== undefined && value !== null && value !== "" && allowed.includes(value);
}

export function assertEnum(value, allowed, label) {
  if (!oneOf(value, allowed)) {
    throw new HttpError(400, `${label} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

export function normalizeEnum(value, allowed, fallback) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return allowed.includes(normalized) ? normalized : fallback;
}

export const normalizeCategory = (v) => normalizeEnum(v, EVENT_CATEGORIES, "domain");
export const normalizeEventStatus = (v) => normalizeEnum(v, EVENT_STATUSES, "active");
export const normalizeVersionStatus = (v) => normalizeEnum(v, VERSION_STATUSES, "active");
export const normalizeCompatibility = (v) => normalizeEnum(v, COMPATIBILITY_LEVELS, "backward");
export const normalizeClassification = (v) => normalizeEnum(v, SECURITY_CLASSIFICATIONS, "internal");
export const normalizeReplayPolicy = (v) => normalizeEnum(v, REPLAY_POLICIES, "controlled");
export const normalizeOrderingScope = (v) => normalizeEnum(v, ORDERING_SCOPES, "none");
export const normalizePriority = (v) => normalizeEnum(v, PRIORITIES, "normal");
export const normalizeSubscriptionStatus = (v) => normalizeEnum(v, SUBSCRIPTION_STATUSES, "draft");
export const normalizeDeliveryStatus = (v) => normalizeEnum(v, DELIVERY_STATUSES, "pending");
export const normalizeTopicStatus = (v) => normalizeEnum(v, TOPIC_STATUSES, "active");
export const normalizeQueueStatus = (v) => normalizeEnum(v, QUEUE_STATUSES, "active");
export const normalizeOutboxStatus = (v) => normalizeEnum(v, OUTBOX_STATUSES, "pending");
export const normalizeDeadLetterStatus = (v) => normalizeEnum(v, DEAD_LETTER_STATUSES, "open");
export const normalizeReplayScope = (v) => normalizeEnum(v, REPLAY_SCOPES, "event");
export const normalizeReplayStatus = (v) => normalizeEnum(v, REPLAY_STATUSES, "pending");
export const normalizeActorType = (v) => (ACTOR_TYPES.includes(String(v || "").toUpperCase()) ? String(v).toUpperCase() : "SYSTEM");
export const normalizeErrorCategory = (v) => normalizeEnum(v, ERROR_CATEGORIES, "technical");

const PRIORITY_RANK = { low: 0, normal: 1, high: 2, critical: 3 };
export function priorityRank(value) {
  return PRIORITY_RANK[normalizePriority(value)];
}

// ── Envelope ────────────────────────────────────────────────────────────────
// Event type codes are PascalCase (ProductReleased.v2 is expressed as code +
// version, never baked into the code string).
const EVENT_TYPE_RE = /^[A-Z][A-Za-z0-9]{1,63}$/;
// Subscription / topic / queue / consumer-group codes are lowercase slugs.
const CODE_RE = /^[a-z][a-z0-9._-]{1,63}$/;

export function assertEventTypeCode(code) {
  if (!EVENT_TYPE_RE.test(String(code || ""))) {
    throw new HttpError(400, "Event type code must start with an uppercase letter and be 2-64 alphanumeric characters (e.g. ProductReleased)");
  }
}

export function assertCode(code, label = "Code") {
  if (!CODE_RE.test(String(code || ""))) {
    throw new HttpError(400, `${label} must be lowercase, start with a letter, 2-64 characters (letters, digits, . _ -)`);
  }
}

export function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function safeParse(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function toJson(value, fallback = {}) {
  if (value === undefined || value === null) return JSON.stringify(fallback);
  if (typeof value === "string") {
    safeParse(value, undefined);
    return value;
  }
  return JSON.stringify(value);
}

export function nowSql(date = new Date()) {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

export function addSecondsIso(seconds, from = new Date()) {
  return nowSql(new Date(from.getTime() + Number(seconds || 0) * 1000));
}

export function getPath(obj, path) {
  const parts = String(path || "").replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return undefined;
    current = current[part];
  }
  return current;
}

export function setPath(obj, path, value) {
  const parts = String(path || "").split(".").filter(Boolean);
  let current = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (typeof current[key] !== "object" || current[key] === null) current[key] = {};
    current = current[key];
  }
  if (parts.length) current[parts[parts.length - 1]] = value;
  return obj;
}

// Validates and normalises an event envelope. The envelope intentionally keeps
// only cross-cutting fields; business attributes belong in `payload`.
export function buildEnvelope(input = {}, { actor = null, tenantId = null, eventType = null } = {}) {
  const source = input && typeof input === "object" ? input : {};
  const occurredAt = source.occurred_at || source.timestamp || nowSql();
  const actorId = source.actor_id ?? source.actorId ?? actor?.id ?? null;
  const actorType = normalizeActorType(source.actor_type || source.actorType || (actor?.id ? "USER" : "SYSTEM"));
  const eventTypeCode = source.event_type_code || source.eventTypeCode || source.event_type || source.eventType || eventType?.code;
  const version = clampInt(source.version ?? source.event_version ?? eventType?.version, 1, 100000, eventType?.version || 1);
  return {
    event_ref: source.event_ref || source.eventRef || null,
    event_type_code: eventTypeCode || null,
    event_version: version,
    source_module: String(source.source_module ?? source.sourceModule ?? eventType?.source_module ?? "unknown").trim() || "unknown",
    source_system: String(source.source_system ?? source.sourceSystem ?? "platform").trim() || "platform",
    source_object_type: source.source_object_type ?? source.sourceObjectType ?? source.object_type ?? null,
    source_object_id: source.source_object_id ?? source.sourceObjectId ?? source.object_id ?? null,
    source_object_revision: source.source_object_revision ?? source.sourceObjectRevision ?? source.revision ?? null,
    actor_id: actorId,
    actor_type: actorType,
    correlation_id: source.correlation_id ?? source.correlationId ?? null,
    causation_id: source.causation_id ?? source.causationId ?? null,
    trace_id: source.trace_id ?? source.traceId ?? null,
    parent_event_id: source.parent_event_id ?? source.parentEventId ?? null,
    partition_key: source.partition_key ?? source.partitionKey ?? null,
    ordering_scope: normalizeOrderingScope(source.ordering_scope ?? source.orderingScope ?? eventType?.ordering_scope ?? "none"),
    priority: normalizePriority(source.priority ?? eventType?.default_priority ?? "normal"),
    payload: source.payload && typeof source.payload === "object" ? source.payload : {},
    payload_schema_version: clampInt(source.payload_schema_version ?? source.schema_version, 1, 100000, version),
    metadata: source.metadata && typeof source.metadata === "object" ? source.metadata : {},
    security_classification:
      source.security_classification || eventType?.security_classification || "internal",
    idempotency_key: source.idempotency_key ?? source.idempotencyKey ?? null,
    occurred_at: occurredAt,
  };
}

export function validateEnvelope(envelope, eventTypeRow = null) {
  const errors = [];
  if (!envelope.event_type_code) errors.push("event_type_code is required");
  if (errors.length) throw new HttpError(400, `Invalid event: ${errors.join("; ")}`);
  return true;
}

// ── Payload schema validation ───────────────────────────────────────────────
// A deliberately small JSON-Schema subset (type/required/properties/items/enum/
// additionalProperties). It is enough to catch breaking payload changes without
// pulling a schema engine into the platform, and it stays provider-independent.
export function validatePayloadAgainstSchema(payload, schema, { path = "$", errors = [] } = {}) {
  const spec = schema && typeof schema === "object" ? schema : null;
  if (!spec || (!spec.type && !spec.properties && !spec.required && !spec.enum)) return errors;
  if (spec.enum && !spec.enum.some((value) => deepEqual(value, payload))) {
    errors.push(`${path} must be one of ${spec.enum.map((v) => JSON.stringify(v)).join(", ")}`);
    return errors;
  }
  if (spec.type) {
    const types = Array.isArray(spec.type) ? spec.type : [spec.type];
    if (!types.some((type) => matchesJsonType(payload, type))) {
      errors.push(`${path} must be of type ${types.join("|")}`);
      return errors;
    }
  }
  if (spec.type === "object" || spec.properties) {
    const required = Array.isArray(spec.required) ? spec.required : [];
    for (const key of required) {
      if (payload === null || payload === undefined || payload[key] === undefined) {
        errors.push(`${path}.${key} is required`);
      }
    }
    const props = spec.properties && typeof spec.properties === "object" ? spec.properties : {};
    for (const [key, child] of Object.entries(props)) {
      if (payload && payload[key] !== undefined) {
        validatePayloadAgainstSchema(payload[key], child, { path: `${path}.${key}`, errors });
      }
    }
    if (spec.additionalProperties === false) {
      for (const key of Object.keys(payload || {})) {
        if (!Object.prototype.hasOwnProperty.call(props, key)) errors.push(`${path}.${key} is not allowed`);
      }
    }
  }
  if (spec.type === "array" && Array.isArray(payload) && spec.items) {
    const max = clampInt(spec.maxItems, 0, 100000, 0);
    if (max > 0 && payload.length > max) errors.push(`${path} must contain at most ${max} items`);
    payload.forEach((item, index) => validatePayloadAgainstSchema(item, spec.items, { path: `${path}[${index}]`, errors }));
  }
  return errors;
}

function matchesJsonType(value, type) {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function deepEqual(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return a === b;
  }
}

// Compares two schema versions and returns a compatibility verdict. Breaking
// changes (new required fields, removed properties, type changes) are surfaced
// so the caller can insist on a new event version.
export function compareSchemas(previous, next) {
  const changes = [];
  const prevProps = previous?.properties || {};
  const nextProps = next?.properties || {};
  const nextRequired = new Set(next?.required || []);
  const prevRequired = new Set(previous?.required || []);
  for (const key of Object.keys(prevProps)) {
    if (!Object.prototype.hasOwnProperty.call(nextProps, key)) changes.push({ change: "removed_property", field: key, breaking: true });
  }
  for (const key of Object.keys(nextProps)) {
    if (!Object.prototype.hasOwnProperty.call(prevProps, key)) {
      changes.push({ change: "added_property", field: key, breaking: nextRequired.has(key) });
    } else if (JSON.stringify(prevProps[key]?.type) !== JSON.stringify(nextProps[key]?.type)) {
      changes.push({ change: "type_changed", field: key, breaking: true });
    }
  }
  for (const key of nextRequired) {
    if (!prevRequired.has(key) && !Object.prototype.hasOwnProperty.call(prevProps, key)) {
      changes.push({ change: "added_required", field: key, breaking: true });
    }
  }
  const breaking = changes.some((c) => c.breaking);
  return { compatible: !breaking, compatibility: breaking ? "none" : "backward", changes };
}

// ── Subscription filters ────────────────────────────────────────────────────
// Filters are evaluated against the envelope plus the payload. Envelope keys
// are matched directly; `payload.<path>` targets business attributes.
export function matchesSubscriptionFilter(filter, context = {}) {
  const spec = filter && typeof filter === "object" ? filter : {};
  const { event, payload } = context;
  for (const [key, expected] of Object.entries(spec)) {
    if (key === "tenant_id") continue;
    const actual = key.startsWith("payload.")
      ? getPath(payload, key.slice("payload.".length))
      : key.startsWith("metadata.")
        ? getPath(event?.metadata, key.slice("metadata.".length))
        : event?.[key];
    if (!matchValue(actual, expected)) return false;
  }
  return true;
}

function matchValue(actual, expected) {
  if (Array.isArray(expected)) return expected.some((value) => matchValue(actual, value));
  if (expected !== null && typeof expected === "object") {
    if (expected.equals !== undefined) return deepEqual(actual, expected.equals);
    if (expected.not_equals !== undefined) return !deepEqual(actual, expected.not_equals);
    if (expected.exists === true) return actual !== undefined && actual !== null;
    if (expected.exists === false) return actual === undefined || actual === null;
    if (Array.isArray(expected.in)) return expected.in.some((value) => deepEqual(actual, value));
    if (expected.prefix !== undefined) return String(actual ?? "").startsWith(String(expected.prefix));
    return false;
  }
  return actual === expected;
}

// ── Retry / dead-letter policies ────────────────────────────────────────────
export function normalizeRetryPolicy(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const strategy = normalizeEnum(source.strategy || source.retry_strategy, RETRY_STRATEGIES, "exponential");
  return {
    strategy,
    max_attempts: clampInt(source.max_attempts ?? source.maxAttempts, 1, 50, 5),
    delay_seconds: clampInt(source.delay_seconds ?? source.delaySeconds ?? source.delay_ms, 0, 86400, 5),
    max_delay_seconds: clampInt(source.max_delay_seconds ?? source.maxDelaySeconds, 0, 86400, 3600),
    multiplier: Math.min(10, Math.max(1, Number(source.multiplier) || 2)),
    jitter: Boolean(source.jitter ?? false),
    retryable_categories: Array.isArray(source.retryable_categories)
      ? source.retryable_categories.filter((c) => ERROR_CATEGORIES.includes(c))
      : [],
    non_retryable_categories: Array.isArray(source.non_retryable_categories)
      ? source.non_retryable_categories.filter((c) => ERROR_CATEGORIES.includes(c))
      : [],
    timeout_seconds: clampInt(source.timeout_seconds ?? source.timeoutSeconds, 0, 86400, 0),
  };
}

export function normalizeDeadLetterPolicy(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  return {
    enabled: source.enabled === undefined ? true : Boolean(source.enabled),
    retention_days: clampInt(source.retention_days ?? source.retentionDays, 1, 3650, 30),
    alert: Boolean(source.alert ?? false),
    notify: Array.isArray(source.notify) ? source.notify.map(String) : [],
  };
}

export function computeBackoffSeconds(policy, attempt, { random = Math.random } = {}) {
  const p = normalizeRetryPolicy(policy);
  const n = Math.max(1, Number(attempt) || 1);
  let delay = p.delay_seconds;
  if (p.strategy === "exponential") delay = p.delay_seconds * Math.pow(p.multiplier, n - 1);
  else if (p.strategy === "linear") delay = p.delay_seconds * n;
  if (p.max_delay_seconds > 0) delay = Math.min(delay, p.max_delay_seconds);
  if (p.jitter) delay = delay * (0.5 + random() * 0.5);
  return Math.max(0, Math.round(delay));
}

export function shouldRetry(policy, attempt, category) {
  const p = normalizeRetryPolicy(policy);
  if (Number(attempt) >= p.max_attempts) return false;
  if (p.non_retryable_categories.includes(category)) return false;
  if (p.retryable_categories.length) return p.retryable_categories.includes(category);
  return isRetryableCategory(category);
}

// ── Ordering ────────────────────────────────────────────────────────────────
// Ordering is scoped to a partition (aggregate/object) so consumers never have
// to wait on a global lock. The consumer uses these helpers to decide whether a
// delivery can run now or must be buffered.
export function orderingPartitionKey(envelope, eventTypeRow = null) {
  const scope = envelope.ordering_scope || eventTypeRow?.ordering_scope || "none";
  if (scope === "none") return null;
  if (envelope.partition_key) return String(envelope.partition_key);
  if (scope === "global") return "__global__";
  if (scope === "object" || scope === "aggregate") {
    const tail = envelope.source_object_id ?? envelope.event_type_code;
    return `${envelope.source_module || "module"}:${tail}`;
  }
  return null;
}

export function isSequenceInOrder(previousSequence, currentSequence) {
  if (previousSequence === null || previousSequence === undefined) return true;
  return Number(currentSequence) >= Number(previousSequence);
}

// ── Security / masking ──────────────────────────────────────────────────────
const SECRET_KEY_RE = /(secret|password|token|api[_-]?key|private[_-]?key|client[_-]?secret|authorization|credential|signature)/i;

export function isSensitiveKey(key) {
  return SECRET_KEY_RE.test(String(key || ""));
}

export function maskPayload(value, { depth = 0 } = {}) {
  if (depth > 8 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => maskPayload(item, { depth: depth + 1 }));
  if (typeof value === "object") {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = isSensitiveKey(key) ? "***" : maskPayload(val, { depth: depth + 1 });
    }
    return out;
  }
  return value;
}

// Confidential/restricted payloads are masked for callers without full payload
// access. Public/internal payloads pass through untouched.
export function maskForClassification(value, classification) {
  if (classification === "confidential" || classification === "restricted") return maskPayload(value);
  return value;
}

// ── Misc ────────────────────────────────────────────────────────────────────
export function paginate(query = {}) {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(query.pageSize, 10) || parseInt(query.page_size, 10) || 25));
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

export function humanizeCode(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

// Machine-readable vocabulary exposed through /api/events/meta so the frontend
// and external clients never hard-code enum values.
export function vocabulary() {
  return {
    actor_types: ACTOR_TYPES,
    categories: EVENT_CATEGORIES,
    event_statuses: EVENT_STATUSES,
    version_statuses: VERSION_STATUSES,
    compatibility_levels: COMPATIBILITY_LEVELS,
    security_classifications: SECURITY_CLASSIFICATIONS,
    replay_policies: REPLAY_POLICIES,
    ordering_scopes: ORDERING_SCOPES,
    priorities: PRIORITIES,
    subscription_statuses: SUBSCRIPTION_STATUSES,
    delivery_statuses: DELIVERY_STATUSES,
    topic_statuses: TOPIC_STATUSES,
    queue_statuses: QUEUE_STATUSES,
    consumer_group_statuses: CONSUMER_GROUP_STATUSES,
    outbox_statuses: OUTBOX_STATUSES,
    dead_letter_statuses: DEAD_LETTER_STATUSES,
    retention_actions: RETENTION_ACTIONS,
    replay_scopes: REPLAY_SCOPES,
    replay_statuses: REPLAY_STATUSES,
    retry_strategies: RETRY_STRATEGIES,
    trigger_types: TRIGGER_TYPES,
    bus_providers: BUS_PROVIDERS,
    error_categories: ERROR_CATEGORIES,
    error_codes: ERROR_CODES,
  };
}
