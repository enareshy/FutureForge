import { queryAll, queryOne, run, nowIso } from "../../db.js";
import {
  normalizeAction,
  normalizeSource,
  normalizeStatus,
  normalizeEventType,
  isSensitiveKey,
  maskValue,
  valueTypeOf,
} from "./validation.js";
import { resolvePolicy } from "./policies.js";

// Core audit event capture. Invariants:
//  * capture never throws into the business transaction it observes; failures
//    are logged and swallowed so auditing can never break a write.
//  * before/after values are filtered against the effective policy, sensitive
//    attribute names are always masked, and only changed attributes are stored.
//  * audit rows are append-only; the database triggers reject UPDATE/DELETE.

export function structuredLog(event, fields = {}) {
  try {
    console.log(JSON.stringify({ level: "error", scope: "audit", event, ...fields }));
  } catch {
    /* logging must never throw */
  }
}

function numberOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function safeParse(raw) {
  if (raw === null || raw === undefined || raw === "") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function stable(value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stable);
  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = stable(value[key]);
      return acc;
    }, {});
}

function isEqual(a, b) {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

// Recursively masks values whose attribute name looks sensitive (passwords,
// tokens, secrets, keys) regardless of policy, plus any attribute explicitly
// listed by the active policy.
export function maskObject(value, extraKeys = new Set()) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => maskObject(entry, extraKeys));
  if (typeof value !== "object") return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveKey(key) || extraKeys.has(key)) {
      out[key] = maskValue();
    } else if (entry !== null && typeof entry === "object") {
      out[key] = maskObject(entry, extraKeys);
    } else {
      out[key] = entry;
    }
  }
  return out;
}

// Computes the attribute-level delta between two snapshots. `track` narrows
// the comparison to specific attributes; `ignore` drops attributes entirely.
export function diffValues(before, after, { track = [], ignore = [] } = {}) {
  const trackSet = track.length ? new Set(track) : null;
  const ignoreSet = new Set(ignore);
  const beforeObj = before && typeof before === "object" && !Array.isArray(before) ? before : {};
  const afterObj = after && typeof after === "object" && !Array.isArray(after) ? after : {};
  const keys = new Set([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
  const changedFields = [];
  const beforeChanged = {};
  const afterChanged = {};
  for (const key of keys) {
    if (ignoreSet.has(key)) continue;
    if (trackSet && !trackSet.has(key)) continue;
    const oldValue = beforeObj[key];
    const newValue = afterObj[key];
    const existed = Object.prototype.hasOwnProperty.call(beforeObj, key);
    const exists = Object.prototype.hasOwnProperty.call(afterObj, key);
    if (existed && exists && isEqual(oldValue, newValue)) continue;
    changedFields.push(key);
    beforeChanged[key] = existed ? oldValue : null;
    afterChanged[key] = exists ? newValue : null;
  }
  changedFields.sort();
  return { changedFields, beforeChanged, afterChanged };
}

function jsonOrNull(value) {
  if (value === null || value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

export function publicChange(row) {
  if (!row) return null;
  return {
    id: row.id,
    attribute: row.attribute,
    old_value: safeParse(row.old_value) ?? row.old_value,
    new_value: safeParse(row.new_value) ?? row.new_value,
    value_type: row.value_type,
    masked: !!row.masked,
  };
}

export function publicEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id ?? null,
    organization_id: row.organization_id ?? null,
    plant_id: row.plant_id ?? null,
    site_id: row.site_id ?? null,
    department_id: row.department_id ?? null,
    actor_id: row.actor_id ?? null,
    actor_username: row.actor_username ?? "system",
    user_display_name: row.user_display_name ?? null,
    action: row.action,
    event_type: row.event_type || null,
    source: row.source || "api",
    object_type: row.resource_type,
    object_id: row.resource_id,
    object_name: row.object_name ?? null,
    details: safeParse(row.details),
    changed_fields: safeParse(row.changed_fields) || [],
    before_values: safeParse(row.before_values),
    after_values: safeParse(row.after_values),
    related: safeParse(row.related_json),
    status: row.status || "success",
    error_message: row.error_message ?? null,
    reason: row.reason ?? null,
    correlation_id: row.correlation_id ?? null,
    request_id: row.request_id ?? null,
    parent_event_id: row.parent_event_id ?? null,
    ip: row.ip ?? null,
    device: row.device ?? null,
    duration_ms: row.duration_ms ?? null,
    occurred_at: row.created_at,
    created_at: row.created_at,
  };
}

export function captureChanges(db, eventId, tenantId, beforeChanged, afterChanged, changedFields) {
  for (const attribute of changedFields) {
    const sensitive = isSensitiveKey(attribute);
    run(
      db,
      `INSERT INTO audit_event_changes
        (event_id, attribute, old_value, new_value, value_type, masked, tenant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        eventId,
        attribute,
        jsonOrNull(beforeChanged[attribute]),
        jsonOrNull(afterChanged[attribute]),
        valueTypeOf(afterChanged[attribute] ?? beforeChanged[attribute]),
        sensitive ? 1 : 0,
        tenantId,
      ]
    );
  }
}

// Records an audit event. Accepts the rich event model and legacy field names
// (resource_type/resource_id) so existing modules keep working unchanged.
export function capture(db, input = {}) {
  try {
    const actor = input.actor || null;
    const tenantId = numberOrNull(input.tenant_id ?? input.tenantId ?? actor?.tenant_id);
    const objectType = stringOrNull(
      input.resource_type ?? input.resourceType ?? input.object_type ?? input.objectType
    ) || "system";
    const objectId = stringOrNull(
      input.resource_id ?? input.resourceId ?? input.object_id ?? input.objectId
    );
    const action = normalizeAction(input.action);
    const status = normalizeStatus(input.status);
    const source = normalizeSource(input.source);
    const eventType = normalizeEventType(input.event_type ?? input.eventType, action);

    const { policy, scope } = resolvePolicy(db, tenantId, objectType);
    if (!policy.enabled) return null;
    if (status === "failure" && !policy.record_failure) return null;
    if (status === "success" && !policy.record_success) return null;
    if (eventType === "VIEW" && !policy.capture_views && !policy.capture_reads) return null;
    if (eventType === "DOWNLOAD" && !policy.capture_downloads) return null;
    if (Array.isArray(policy.actions) && policy.actions.length) {
      const allowed = policy.actions.some(
        (entry) => entry === action || String(entry).toUpperCase() === eventType
      );
      if (!allowed) return null;
    }

    const maskedKeys = new Set(policy.masked_attributes || []);
    const rawBefore = input.before !== undefined && input.before !== null ? input.before : null;
    const rawAfter = input.after !== undefined && input.after !== null ? input.after : null;
    // Diff the raw snapshots so a changed secret still registers as a change,
    // then mask before persisting so no sensitive value is ever stored.
    const { changedFields, beforeChanged, afterChanged } = diffValues(rawBefore, rawAfter, {
      track: policy.track_attributes || [],
      ignore: policy.ignored_attributes || [],
    });
    const storedBefore = maskObject(beforeChanged, maskedKeys);
    const storedAfter = maskObject(afterChanged, maskedKeys);

    const result = run(
      db,
      `INSERT INTO audit_logs
        (tenant_id, organization_id, plant_id, site_id, department_id, actor_id, actor_username,
         user_display_name, action, event_type, source, resource_type, resource_id, object_name,
         details, changed_fields, before_values, after_values, related_json, status, error_message,
         reason, correlation_id, request_id, parent_event_id, ip, device, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        numberOrNull(input.organization_id ?? input.organizationId ?? actor?.organization_id),
        numberOrNull(input.plant_id ?? input.plantId),
        numberOrNull(input.site_id ?? input.siteId),
        numberOrNull(input.department_id ?? input.departmentId),
        numberOrNull(actor?.id ?? input.actor_id ?? input.actorId),
        actor?.username || input.actor_username || input.actorUsername || "system",
        actor?.display_name || actor?.displayName || input.user_display_name || input.userDisplayName || null,
        action,
        eventType,
        source,
        objectType,
        objectId,
        stringOrNull(input.object_name ?? input.objectName),
        jsonOrNull(input.details),
        changedFields.length ? JSON.stringify(changedFields) : null,
        changedFields.length ? jsonOrNull(storedBefore) : null,
        changedFields.length ? jsonOrNull(storedAfter) : null,
        jsonOrNull(input.related),
        status,
        stringOrNull(input.error_message ?? input.errorMessage),
        stringOrNull(input.reason),
        stringOrNull(input.correlation_id ?? input.correlationId),
        stringOrNull(input.request_id ?? input.requestId),
        numberOrNull(input.parent_event_id ?? input.parentEventId),
        stringOrNull(input.ip),
        stringOrNull(input.device ?? input.user_agent ?? input.userAgent),
        numberOrNull(input.duration_ms ?? input.durationMs),
        nowIso(),
      ]
    );
    const eventId = Number(result.lastInsertRowid);
    if (changedFields.length) captureChanges(db, eventId, tenantId, storedBefore, storedAfter, changedFields);
    return { id: eventId, event_type: eventType, scope };
  } catch (err) {
    structuredLog("audit.capture.failed", { message: err?.message, action: input?.action });
    return null;
  }
}

// Backwards-compatible writer used by all pre-existing modules. Keeps the
// original call signature and maps details/ip onto the rich event model.
export function writeAudit(db, { actor, action, resourceType, resourceId, details, ip } = {}) {
  return capture(db, {
    actor,
    action,
    resource_type: resourceType,
    resource_id: resourceId == null ? null : String(resourceId),
    details,
    ip,
    source: "api",
  });
}

// Convenience wrapper for domain services that already hold before/after
// snapshots. Returns the event result (or null) and never throws.
export function recordObjectChange(db, {
  actor,
  tenantId,
  organizationId,
  action,
  objectType,
  objectId,
  objectName,
  before,
  after,
  reason,
  source = "api",
  ip,
  status,
  details,
  correlationId,
  requestId,
  related,
}) {
  return capture(db, {
    actor,
    tenant_id: tenantId,
    organization_id: organizationId,
    action,
    object_type: objectType,
    object_id: objectId,
    object_name: objectName,
    before,
    after,
    reason,
    source,
    ip,
    status,
    details,
    correlation_id: correlationId,
    request_id: requestId,
    related,
  });
}

export function listChangesForEvent(db, eventId) {
  return queryAll(
    db,
    "SELECT * FROM audit_event_changes WHERE event_id = ? ORDER BY attribute ASC",
    [eventId]
  ).map(publicChange);
}

export function getEventRow(db, id) {
  return queryOne(db, "SELECT * FROM audit_logs WHERE id = ?", [id]);
}
