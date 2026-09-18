// Cross-cutting hooks for the Event & Messaging Framework. Audit and structured
// logging are best-effort: an observability outage must never fail (or roll
// back) an event write or a consumer's business operation.
import { writeAudit } from "../audit.js";

export function correlationId(req) {
  return (
    req?.headers?.["x-correlation-id"] ||
    req?.headers?.["x-request-id"] ||
    req?.correlationId ||
    null
  );
}

export function requestIp(req) {
  return req?.headers?.["x-forwarded-for"]?.toString().split(",")[0].trim() || req?.ip || null;
}

export function scopeFromRequest(req) {
  return {
    tenantId: req?.tenantId ?? null,
    organizationId: req?.query?.organizationId ? Number(req.query.organizationId) : req?.body?.organization_id || null,
    plantId: req?.query?.plantId ? Number(req.query.plantId) : req?.body?.plant_id || null,
    siteId: req?.query?.siteId ? Number(req.query.siteId) : req?.body?.site_id || null,
  };
}

export function auditEvent(db, input = {}) {
  const {
    actor = null,
    action,
    resourceType,
    resourceId,
    details = {},
    reason = null,
    ip = null,
    status = "success",
    errorMessage = null,
    correlation = null,
    category = "administration",
    eventType = null,
  } = input;
  try {
    return writeAudit(db, {
      actor,
      action,
      resourceType,
      resourceId: resourceId === undefined || resourceId === null ? null : String(resourceId),
      details: { ...details, correlationId: correlation || details.correlationId || undefined },
      reason,
      ip,
      status,
      errorMessage,
      source: "events",
      category,
      eventType,
    });
  } catch {
    return null;
  }
}

export function log(level, event, fields = {}) {
  try {
    const line = JSON.stringify({ level, scope: "events", event, ts: new Date().toISOString(), ...fields });
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  } catch {
    /* logging must never throw */
  }
}

// Normalises any thrown error into the platform error taxonomy so retry and
// dead-letter handling can reason about it without knowing the handler.
export function classifyError(error) {
  if (!error) return { category: "technical", code: "internal_error", message: "Unknown error" };
  if (error.category && error.code) {
    return { category: error.category, code: error.code, message: error.message || String(error) };
  }
  const message = error.message || String(error);
  const status = Number(error.status || error.statusCode || 0);
  if (status === 400 || status === 422) return { category: "business_validation", code: "validation_failed", message };
  if (status === 401) return { category: "authentication", code: "authentication_failed", message };
  if (status === 403) return { category: "authorization", code: "forbidden", message };
  if (status === 404) return { category: "not_found", code: "event_not_found", message };
  if (status === 409) return { category: "duplicate", code: "duplicate_message", message };
  if (status === 429) return { category: "rate_limit", code: "rate_limited", message };
  if (status >= 500) return { category: "external_system", code: "remote_error", message };
  if (/timeout|timed out|ETIMEDOUT/i.test(message)) return { category: "timeout", code: "request_timeout", message };
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|socket hang up/i.test(message)) {
    return { category: "network", code: "network_unreachable", message };
  }
  if (/schema|payload/i.test(message)) return { category: "schema", code: "schema_mismatch", message };
  if (/validat|required|invalid/i.test(message)) return { category: "business_validation", code: "validation_failed", message };
  if (/mapping|transform/i.test(message)) return { category: "mapping", code: "mapping_failed", message };
  if (/config/i.test(message)) return { category: "configuration", code: "invalid_configuration", message };
  if (/poison|deseriali/i.test(message)) return { category: "poison", code: "deserialization_failed", message };
  return { category: "technical", code: "internal_error", message };
}
